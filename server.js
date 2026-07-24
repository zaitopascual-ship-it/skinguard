const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
const { Readable } = require('stream');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// ---------- ENV CHECKS ----------
const requiredEnvVars = ['ADMIN_PASSWORD_HASH', 'TEACHER_PASSWORD_HASH', 'SESSION_SECRET'];
const missing = requiredEnvVars.filter(v => !process.env[v]);
if (missing.length > 0) {
    if (process.env.NODE_ENV === 'production') {
        console.error(`FATAL: missing required env vars in production: ${missing.join(', ')}`);
        process.exit(1);
    } else {
        console.warn(`WARNING: using insecure default values for: ${missing.join(', ')} (dev only)`);
    }
}

console.log('OpenAI API Key:', process.env.OPENAI_API_KEY ? 'Loaded' : 'Not found');
console.log('Roboflow API Key:', process.env.ROBOFLOW_API_KEY ? 'Loaded' : 'Not found');
console.log('ElevenLabs API Key:', process.env.ELEVENLABS_API_KEY ? 'Loaded' : 'Not found');

// ---------- EMAIL TRANSPORT ----------
let emailTransporter = null;
if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    emailTransporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT || '587'),
        secure: process.env.EMAIL_PORT === '465',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
        debug: true,
        logger: true,
    });
    console.log('📧 Email transport configured');
} else {
    console.warn('⚠️ Email not configured – skipping email notifications');
}

function escapeHtmlForEmail(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function sendEmailViaProvider(toEmail, studentName, condition, advice) {
    if (!emailTransporter) {
        console.warn('📧 Email transport not available – skipping');
        return { ok: false, error: 'Email not configured' };
    }
    const safeName = escapeHtmlForEmail(studentName);
    const safeCondition = escapeHtmlForEmail(condition);
    const safeAdvice = escapeHtmlForEmail(advice);
    const subject = `SkinGuard Alert for ${studentName}`;
    const text = `Dear parent/guardian of ${studentName},\n\nYour child was assessed with: ${condition}.\n${advice}\n\nPlease take appropriate action.\n\n— AMA Santiago Campus Clinic`;
    const html = `<p><strong>SkinGuard Alert</strong></p>
    <p>Dear parent/guardian of <strong>${safeName}</strong>,</p>
    <p>Your child was assessed with: <strong>${safeCondition}</strong>.</p>
    <p>${safeAdvice}</p>
    <p>Please take appropriate action.</p>
    <p>— AMA Santiago Campus Clinic</p>`;
    try {
        const info = await emailTransporter.sendMail({
            from: process.env.EMAIL_FROM || 'SkinGuard <noreply@skinguard.site>',
            to: toEmail,
            subject,
            text,
            html,
        });
        console.log(`📧 Email sent to ${toEmail} (${info.messageId})`);
        return { ok: true, messageId: info.messageId };
    } catch (err) {
        console.error('❌ Email sending failed:', err.message);
        return { ok: false, error: err.message };
    }
}

// ---------- EMAIL REPLY POLLING (IMAP, Gmail only) ----------
// Reuses the same Gmail app-password credentials used for sending (EMAIL_USER / EMAIL_PASS).
// Looks at recent inbox messages that are replies (via In-Reply-To / References headers)
// to a Message-ID we previously stored on a sms_requests row, and saves the reply text.
// NOTE: this deliberately does NOT filter by "unseen" — a reply the parent's device already
// marked as read (e.g. opened on a phone) would otherwise be invisible forever. Instead we
// dedupe using the reply email's own Message-ID (unique index on email_replies.sourceMessageId)
// so re-scanning the same window on every poll is safe and idempotent. We also never touch
// \Seen flags, so this can't accidentally mark unrelated inbox mail as read.
const IMAP_HOST = process.env.EMAIL_IMAP_HOST || 'imap.gmail.com';
const IMAP_PORT = parseInt(process.env.EMAIL_IMAP_PORT || '993', 10);
const IMAP_LOOKBACK_DAYS = parseInt(process.env.EMAIL_IMAP_LOOKBACK_DAYS || '14', 10);
let imapPollInFlight = false;

async function pollEmailReplies(db) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.warn('📩 Skipping reply poll — EMAIL_USER/EMAIL_PASS not configured');
        return { ok: false, error: 'not configured' };
    }
    if (imapPollInFlight) {
        console.log('📩 Skipping reply poll — previous poll still running');
        return { ok: false, error: 'already running' };
    }
    imapPollInFlight = true;

    const client = new ImapFlow({
        host: IMAP_HOST,
        port: IMAP_PORT,
        secure: true,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
        logger: false,
    });

    const stats = { scanned: 0, withReplyHeaders: 0, matched: 0, saved: 0, duplicates: 0 };

    try {
        await client.connect();
        console.log(`📩 IMAP connected as ${process.env.EMAIL_USER}`);
        const lock = await client.getMailboxLock('INBOX');
        try {
            const since = new Date(Date.now() - IMAP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
            const uids = await client.search({ since }, { uid: true });

            if (!uids || uids.length === 0) {
                console.log(`📩 No messages found in the last ${IMAP_LOOKBACK_DAYS} day(s)`);
            } else {
                console.log(`📩 Scanning ${uids.length} message(s) from the last ${IMAP_LOOKBACK_DAYS} day(s)...`);
            }

            for await (const message of client.fetch(uids, { envelope: true, source: true }, { uid: true })) {
                stats.scanned++;
                let parsed;
                try {
                    parsed = await simpleParser(message.source);
                } catch (parseErr) {
                    console.error('📩 Failed to parse inbox message:', parseErr.message);
                    continue;
                }

                const sourceMessageId = (parsed.messageId || '').trim();
                const inReplyTo = (parsed.inReplyTo || '').trim();
                const references = parsed.references
                    ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
                    : [];
                const candidateIds = [...new Set([inReplyTo, ...references].filter(Boolean))];

                if (candidateIds.length === 0) continue; // not a reply to anything
                stats.withReplyHeaders++;

                const matchedRow = await new Promise((resolve) => {
                    const placeholders = candidateIds.map(() => '?').join(',');
                    db.get(
                        `SELECT id, studentName FROM sms_requests WHERE email_message_id IN (${placeholders}) LIMIT 1`,
                        candidateIds,
                        (err, row) => {
                            if (err) { console.error('📩 Reply match query failed:', err.message); return resolve(null); }
                            resolve(row || null);
                        }
                    );
                });

                if (!matchedRow) continue; // reply to some other email, not one of ours
                stats.matched++;

                const fromAddress = (parsed.from && parsed.from.text) || 'unknown';
                const subject = parsed.subject || '(no subject)';
                const body = (parsed.text || parsed.html || '').toString().trim().slice(0, 5000);

                await new Promise((resolve) => {
                    db.run(
                        `INSERT OR IGNORE INTO email_replies (sms_request_id, fromAddress, subject, body, sourceMessageId) VALUES (?, ?, ?, ?, ?)`,
                        [matchedRow.id, fromAddress, subject, body, sourceMessageId || null],
                        function (insertErr) {
                            if (insertErr) {
                                console.error('📩 Failed to save email reply:', insertErr.message);
                            } else if (this.changes === 0) {
                                stats.duplicates++;
                            } else {
                                stats.saved++;
                                console.log(`📩 Parent reply captured for request #${matchedRow.id} (${matchedRow.studentName})`);
                            }
                            resolve();
                        }
                    );
                });
            }
        } finally {
            lock.release();
        }
        await client.logout();
        console.log(`📩 Reply poll done — scanned ${stats.scanned}, had reply headers ${stats.withReplyHeaders}, matched ours ${stats.matched}, newly saved ${stats.saved}, already known ${stats.duplicates}`);
        return { ok: true, stats };
    } catch (err) {
        console.error('📩 IMAP reply poll failed:', err.message);
        return { ok: false, error: err.message };
    } finally {
        imapPollInFlight = false;
    }
}



// ---------- APP SETUP ----------
const app = express();
const PORT = process.env.PORT || 3000;

// ---------- DEVELOPMENT SSL REDIRECT ----------
if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
        if (req.secure) {
            return res.redirect(`http://${req.headers.host}${req.url}`);
        }
        next();
    });
}

// ---------- SECURITY HEADERS ----------
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://api.mapbox.com"],
            "script-src-attr": ["'unsafe-inline'"],
            "worker-src": ["'self'", "blob:", "https://api.mapbox.com"],
            "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://api.mapbox.com"],
            "connect-src": [
                "'self'",
                "https://api.mapbox.com",
                "https://events.mapbox.com",
                "https://detect.roboflow.com",
                "https://api.openai.com",
                "https://unismsapi.com",
                "https://overpass-api.de",
                "https://overpass.kumi.systems",
                "https://cdn.jsdelivr.net"
            ],
            "font-src": ["'self'", "https://fonts.gstatic.com"],
            "img-src": ["'self'", "data:", "https://api.mapbox.com"]
        }
    })
);
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? ['https://skinguard.site']
        : true,
    credentials: true
}));

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

// ---------- RATE LIMITERS ----------
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many login attempts, please try again later.' },
});
const analyzeLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 10,
    message: { error: 'Too many analysis requests, please try again later.' },
});
const smsLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: { error: 'Too many SMS requests, please try again later.' },
});
const hospitalLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    message: { error: 'Too many hospital search requests, please try again later.' },
});
const saveScanLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    message: { error: 'Too many scan saves, please try again later.' },
});
const studentPostLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    message: { error: 'Too many student registration attempts, please try again later.' },
});
const guestLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many guest session requests, please try again later.' },
});
const smsStatusLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 100,
    message: { error: 'Too many status checks, please slow down.' },
});
const smsQueueLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 50,
    message: { error: 'Too many SMS queue actions, please try again later.' },
});

// ---------- SESSION SETUP ----------
app.use(session({
    secret: process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? undefined : 'dev-secret-change-me'),
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use(cookieParser());

// ---------- CSRF PROTECTION (double-submit cookie) ----------
function ensureCsrfCookie(req, res, next) {
    if (!req.cookies || !req.cookies['XSRF-TOKEN']) {
        const token = crypto.randomBytes(32).toString('hex');
        res.cookie('XSRF-TOKEN', token, {
            httpOnly: false,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000
        });
        req.csrfToken = token;
    } else {
        req.csrfToken = req.cookies['XSRF-TOKEN'];
    }
    next();
}

function verifyCsrf(req, res, next) {
    const cookieToken = req.cookies && req.cookies['XSRF-TOKEN'];
    const headerToken = req.headers['x-csrf-token'];
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        return res.status(403).json({ error: 'CSRF validation failed. Please refresh the page and try again.' });
    }
    next();
}

app.use(ensureCsrfCookie);
app.use((req, res, next) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && req.path.startsWith('/api/')) {
        return verifyCsrf(req, res, next);
    }
    next();
});

// ---------- AUTH MIDDLEWARES ----------
function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    res.redirect('/login');
}

function requireTeacherOrAdmin(req, res, next) {
    if (req.session && (req.session.isAdmin || req.session.isTeacher)) {
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Teacher or admin access required' });
    }
    res.redirect('/login');
}

function requireSession(req, res, next) {
    if (req.session && (req.session.role === 'teacher' || req.session.role === 'admin' || req.session.role === 'guest')) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}

// ---------- PHONE SANITIZER ----------
function sanitizePhone(phone) {
    if (!phone) return null;
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (/^09\d{9}$/.test(cleaned)) return '+63' + cleaned.slice(1);
    if (/^639\d{9}$/.test(cleaned)) return '+' + cleaned;
    if (/^\+639\d{9}$/.test(cleaned)) return cleaned;
    return false;
}

// ---------- MASKING HELPERS ----------
function maskName(name) {
    if (!name) return '';
    const trimmed = name.trim();
    if (trimmed.length <= 2) return trimmed.charAt(0) + '*';
    return trimmed.charAt(0) + '*'.repeat(trimmed.length - 2) + trimmed.charAt(trimmed.length - 1);
}

function maskPhone(phone) {
    if (!phone) return 'No phone';
    const cleaned = phone.replace(/[^\d+]/g, '');
    let prefix = '';
    let number = cleaned;
    if (cleaned.startsWith('+')) {
        prefix = '+';
        number = cleaned.substring(1);
    }
    if (number.length > 4) {
        const last4 = number.slice(-4);
        const masked = '*'.repeat(number.length - 4) + last4;
        return prefix + masked;
    }
    return prefix + number;
}

function maskStudentForRole(student, role) {
    const masked = { ...student };
    if (role !== 'teacher' && role !== 'admin') {
        masked.name = maskName(student.name);
        masked.phone = maskPhone(student.phone);
    }
    return masked;
}

// ---------- SEVERITY WHITELIST ----------
const ALLOWED_SEVERITIES = ['Green', 'Yellow', 'Red'];
function normalizeSeverity(raw) {
    if (!raw) return null;
    const s = String(raw).trim().toLowerCase();
    if (s === 'green') return 'Green';
    if (s === 'yellow') return 'Yellow';
    if (s === 'red') return 'Red';
    return null;
}

// ---------- SCAN TOKENS ----------
const pendingScans = new Map();
const SCAN_TOKEN_TTL_MS = 15 * 60 * 1000;

function createScanToken(data) {
    const token = crypto.randomBytes(24).toString('hex');
    pendingScans.set(token, { ...data, createdAt: Date.now() });
    return token;
}

function consumeScanToken(token) {
    if (!token || typeof token !== 'string') return null;
    const entry = pendingScans.get(token);
    if (!entry) return null;
    pendingScans.delete(token);
    if (Date.now() - entry.createdAt > SCAN_TOKEN_TTL_MS) return null;
    return entry;
}

setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of pendingScans.entries()) {
        if (now - entry.createdAt > SCAN_TOKEN_TTL_MS) pendingScans.delete(token);
    }
}, 5 * 60 * 1000).unref();

// ---------- GUEST LOGIN ----------
app.post('/api/guest-login', guestLoginLimiter, (req, res) => {
    req.session.role = 'guest';
    req.session.isGuest = true;
    req.session.cookie.maxAge = 2 * 60 * 60 * 1000;
    console.log('👤 Guest session created');
    res.json({ success: true, role: 'guest' });
});

// ---------- LOGIN PAGE ----------
app.get('/login', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.redirect('/admin');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ---------- LOGIN API ----------
app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminHash = process.env.ADMIN_PASSWORD_HASH;
    const teacherUser = process.env.TEACHER_USER || 'teacher';
    const teacherHash = process.env.TEACHER_PASSWORD_HASH;

    const isAdminMatch = username === adminUser && adminHash && bcrypt.compareSync(password, adminHash);
    const isTeacherMatch = username === teacherUser && teacherHash && bcrypt.compareSync(password, teacherHash);

    if (isAdminMatch) {
        req.session.isAdmin = true;
        req.session.role = 'admin';
        req.session.username = username;
        console.log(`✅ Admin logged in:`, username);
        return res.json({ success: true, role: 'admin' });
    }

    if (isTeacherMatch) {
        req.session.isTeacher = true;
        req.session.role = 'teacher';
        req.session.username = username;
        console.log(`✅ Teacher logged in:`, username);
        return res.json({ success: true, role: 'teacher' });
    }

    console.log('❌ Failed login attempt:', username);
    res.status(401).json({ error: 'Invalid username or password' });
});

// ---------- GET CURRENT USER ----------
app.get('/api/me', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.json({ role: 'admin', username: req.session.username });
    }
    if (req.session && req.session.isTeacher) {
        return res.json({ role: 'teacher', username: req.session.username });
    }
    if (req.session && req.session.role === 'guest') {
        return res.json({ role: 'guest' });
    }
    res.status(401).json({ error: 'Not logged in' });
});

// ---------- LOGOUT ----------
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// ---------- LANDING & ADMIN ----------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/admin', requireTeacherOrAdmin, (req, res) => {
    console.log('👤 Admin page accessed by:', req.session.username, 'role:', req.session.role);
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin.html', requireTeacherOrAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---------- ELEVENLABS ----------
let elevenLabs = null;
if (process.env.ELEVENLABS_API_KEY) {
    elevenLabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
}

// ---------- DATABASE ----------
const dbPath = path.join(__dirname, 'scans.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            condition TEXT NOT NULL,
            severity TEXT NOT NULL,
            advice TEXT,
            firstAid TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run("ALTER TABLE scans ADD COLUMN image TEXT", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn('Could not add image column:', err.message);
        }
    });

    db.run("ALTER TABLE scans ADD COLUMN submittedRole TEXT", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn('Could not add submittedRole column:', err.message);
        }
    });

    db.run("ALTER TABLE scans ADD COLUMN email TEXT", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn('Could not add email to scans:', err.message);
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            phone TEXT,
            email TEXT
        )
    `);

    db.run("ALTER TABLE students ADD COLUMN addedByRole TEXT", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn('Could not add addedByRole column:', err.message);
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS sms_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            studentName TEXT NOT NULL,
            phone TEXT NOT NULL,
            email TEXT,
            condition TEXT NOT NULL,
            advice TEXT,
            severity TEXT,
            requestedByRole TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            resolvedBy TEXT,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            resolvedAt DATETIME,
            channels TEXT,
            sms_status TEXT DEFAULT 'pending',
            email_status TEXT DEFAULT 'pending'
        )
    `);

    db.run("ALTER TABLE sms_requests ADD COLUMN channels TEXT", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn('Could not add channels to sms_requests:', err.message);
        }
    });

    db.run("ALTER TABLE sms_requests ADD COLUMN sms_status TEXT DEFAULT 'pending'", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn('Could not add sms_status:', err.message);
        }
    });

    db.run("ALTER TABLE sms_requests ADD COLUMN email_status TEXT DEFAULT 'pending'", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn('Could not add email_status:', err.message);
        }
    });

    db.run("ALTER TABLE sms_requests ADD COLUMN email_message_id TEXT", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn('Could not add email_message_id to sms_requests:', err.message);
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS email_replies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sms_request_id INTEGER NOT NULL,
            fromAddress TEXT,
            subject TEXT,
            body TEXT,
            sourceMessageId TEXT,
            receivedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sms_request_id) REFERENCES sms_requests(id)
        )
    `);

    db.run("ALTER TABLE email_replies ADD COLUMN sourceMessageId TEXT", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn('Could not add sourceMessageId to email_replies:', err.message);
        }
    });

    db.run(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_email_replies_source ON email_replies(sourceMessageId) WHERE sourceMessageId IS NOT NULL",
        (err) => {
            if (err) console.warn('Could not create unique index on email_replies.sourceMessageId:', err.message);
        }
    );
});

// ---------- START EMAIL REPLY POLLING ----------
if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    setInterval(() => pollEmailReplies(db), 60 * 1000); // check inbox every 60s
    pollEmailReplies(db); // run once at startup
    console.log(`📩 Email reply polling enabled (${IMAP_HOST}, every 60s)`);
} else {
    console.warn('⚠️ Email reply polling disabled — EMAIL_HOST/EMAIL_USER/EMAIL_PASS not fully configured');
}

// ---------- ROUTES (ALL AFTER DB INIT) ----------

// ---- STUDENTS ----
// GET /api/students – any logged‑in user (guests, teachers, admins)
app.get('/api/students', requireSession, (req, res) => {
    db.all('SELECT id, name, phone, email FROM students ORDER BY name', (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        const role = req.session.role || 'guest';
        const maskedRows = rows.map(row => maskStudentForRole(row, role));
        res.json(maskedRows);
    });
});

// POST /api/students – only teachers and admins
app.post('/api/students', requireTeacherOrAdmin, studentPostLimiter, (req, res) => {
    const { name, phone, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }
    const sanitizedPhone = sanitizePhone(phone);
    if (sanitizedPhone === false) {
        return res.status(400).json({ error: 'Invalid phone number format. Use a PH mobile number, e.g. 09XXXXXXXXX or +639XXXXXXXXX.' });
    }

    db.get('SELECT id, name, phone, email FROM students WHERE name = ?', [name], (err, row) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (row) {
            // Existing student: allow updates only if role is teacher or admin (already enforced by middleware)
            const role = req.session.role || 'guest';
            if (role !== 'teacher' && role !== 'admin') {
                return res.status(403).json({ error: 'Only teachers or admins can update existing student records.' });
            }
            const updates = [];
            const params = [];
            if (sanitizedPhone && sanitizedPhone !== row.phone) {
                updates.push('phone = ?');
                params.push(sanitizedPhone);
            }
            if (email && email !== row.email) {
                updates.push('email = ?');
                params.push(email);
            }
            if (updates.length === 0) {
                const masked = maskStudentForRole(row, role);
                return res.json(masked);
            }
            params.push(row.id);
            db.run(`UPDATE students SET ${updates.join(', ')} WHERE id = ?`, params, (updateErr) => {
                if (updateErr) {
                    console.error(updateErr);
                    return res.status(500).json({ error: 'Failed to update student' });
                }
                db.get('SELECT id, name, phone, email FROM students WHERE id = ?', [row.id], (err2, updatedRow) => {
                    if (err2) {
                        console.error(err2);
                        return res.status(500).json({ error: 'Database error' });
                    }
                    const masked = maskStudentForRole(updatedRow, role);
                    res.json(masked);
                });
            });
        } else {
            // New student: only teachers/admins can add (already enforced)
            const role = req.session.role || 'guest';
            if (role !== 'teacher' && role !== 'admin') {
                return res.status(403).json({ error: 'Only teachers or admins can add new students.' });
            }
            const stmt = db.prepare('INSERT INTO students (name, phone, email, addedByRole) VALUES (?, ?, ?, ?)');
            stmt.run(name, sanitizedPhone, email || null, role, function(insertErr) {
                if (insertErr) {
                    console.error(insertErr);
                    return res.status(500).json({ error: 'Database error' });
                }
                const newStudent = { id: this.lastID, name, phone: sanitizedPhone, email: email || null, addedByRole: role };
                const masked = maskStudentForRole(newStudent, role);
                res.json(masked);
            });
            stmt.finalize();
        }
    });
});

// DELETE /api/students/by-phone/:phone – admin only
app.delete('/api/students/by-phone/:phone', requireAdmin, (req, res) => {
    const phone = req.params.phone;
    db.get('SELECT id FROM students WHERE phone = ?', [phone], (err, row) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) {
            return res.status(404).json({ error: 'Student not found' });
        }
        db.run('DELETE FROM students WHERE id = ?', [row.id], function(deleteErr) {
            if (deleteErr) {
                console.error(deleteErr);
                return res.status(500).json({ error: 'Failed to delete student' });
            }
            res.json({ message: 'Student deleted successfully' });
        });
    });
});

// ---- SCANS ----
app.get('/api/get-scans', requireTeacherOrAdmin, (req, res) => {
    db.all('SELECT * FROM scans ORDER BY timestamp DESC', (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        console.log(`📋 Retrieved ${rows.length} scans`);
        res.json(rows);
    });
});

app.post('/api/add-scan', requireAdmin, (req, res) => {
    const { name, phone, condition, severity, advice, firstAid, image, email } = req.body;
    if (!name || !condition || !severity) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const normalizedSeverity = normalizeSeverity(severity);
    if (!normalizedSeverity) {
        return res.status(400).json({ error: `Severity must be one of: ${ALLOWED_SEVERITIES.join(', ')}` });
    }
    const sanitizedPhone = sanitizePhone(phone);
    if (sanitizedPhone === false) {
        return res.status(400).json({ error: 'Invalid phone number format. Use a PH mobile number, e.g. 09XXXXXXXXX or +639XXXXXXXXX.' });
    }
    const sanitizedEmail = email && email.trim() ? email.trim() : null;
    const submittedRole = req.session.role || 'admin';
    const stmt = db.prepare('INSERT INTO scans (name, phone, condition, severity, advice, firstAid, image, submittedRole, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    stmt.run(name, sanitizedPhone, condition, normalizedSeverity, advice, firstAid, image || null, submittedRole, sanitizedEmail, function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ id: this.lastID, message: 'Scan added' });
    });
    stmt.finalize();
});

app.put('/api/update-scan/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { name, phone, condition, severity, advice, firstAid, email } = req.body;
    if (!name || !condition || !severity) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const normalizedSeverity = normalizeSeverity(severity);
    if (!normalizedSeverity) {
        return res.status(400).json({ error: `Severity must be one of: ${ALLOWED_SEVERITIES.join(', ')}` });
    }
    const sanitizedPhone = sanitizePhone(phone);
    if (sanitizedPhone === false) {
        return res.status(400).json({ error: 'Invalid phone number format. Use a PH mobile number, e.g. 09XXXXXXXXX or +639XXXXXXXXX.' });
    }
    const sanitizedEmail = email && email.trim() ? email.trim() : null;
    const stmt = db.prepare('UPDATE scans SET name = ?, phone = ?, condition = ?, severity = ?, advice = ?, firstAid = ?, email = ? WHERE id = ?');
    stmt.run(name, sanitizedPhone, condition, normalizedSeverity, advice, firstAid, sanitizedEmail, id, function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Scan not found' });
        }
        res.json({ message: 'Scan updated' });
    });
    stmt.finalize();
});

app.delete('/api/delete-scan/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const stmt = db.prepare('DELETE FROM scans WHERE id = ?');
    stmt.run(id, function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Scan not found' });
        }
        res.json({ message: 'Scan deleted' });
    });
    stmt.finalize();
});

app.post('/api/save-scan', requireSession, saveScanLimiter, (req, res) => {
    const { name, phone, scanToken, image } = req.body;
    console.log('📥 Saving scan:', { name, phone, scanToken: scanToken ? scanToken.slice(0, 8) + '…' : null });

    if (!name || !scanToken) {
        return res.status(400).json({ error: 'Missing required fields (name, scanToken)' });
    }

    const pending = consumeScanToken(scanToken);
    if (!pending) {
        return res.status(400).json({ error: 'Scan session expired or invalid — please re-scan before saving.' });
    }
    const { condition, severity, advice, firstAid } = pending;

    if (image && typeof image === 'string' && image.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image too large (max 5MB)' });
    }
    const sanitizedPhone = sanitizePhone(phone);
    if (sanitizedPhone === false) {
        return res.status(400).json({ error: 'Invalid phone number format. Use a PH mobile number, e.g. 09XXXXXXXXX or +639XXXXXXXXX.' });
    }
    const submittedRole = req.session.role || 'guest';
    const stmt = db.prepare('INSERT INTO scans (name, phone, condition, severity, advice, firstAid, image, submittedRole) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    stmt.run(name, sanitizedPhone, condition, severity, advice, firstAid, image || null, submittedRole, function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        console.log('✅ Scan saved with ID:', this.lastID);
        res.json({ id: this.lastID, message: 'Scan saved' });
    });
    stmt.finalize();
});

// ---- SMS & EMAIL ----
async function sendSmsViaProvider(validatedPhone, studentName, condition, advice) {
    const apiSecretKey = process.env.UNISMS_API_SECRET;
    if (!apiSecretKey) {
        console.error('❌ UNISMS_API_SECRET not set in .env – cannot send SMS');
        return {
            ok: false,
            statusCode: 500,
            body: { success: false, error: 'SMS is not configured on the server. Add UNISMS_API_SECRET to .env' }
        };
    }

    let messageText = `AMA SKINGUARD ALERT\nPARENT NOTIFICATION\nDear parent/guardian of ${studentName}, your child was assessed with ${condition}. ${advice}. Please take appropriate action.`;
    messageText = messageText.replace(/[^\x00-\x7F]/g, '');

    let senderId = process.env.UNISMS_SENDER_ID;
    const useSenderId = senderId && senderId.trim().length > 0;

    console.log(`📤 Sending SMS to ${validatedPhone} via UniSMS...`);
    console.log(`📝 Message: ${messageText}`);
    if (useSenderId) console.log(`📤 Sender ID: ${senderId}`);
    else console.log('📤 No sender ID provided – will omit field');

    try {
        const requestBody = { recipient: validatedPhone, content: messageText };
        if (useSenderId) requestBody.sender_id = senderId;

        const auth = Buffer.from(`${apiSecretKey}:`).toString('base64');

        const response = await fetch('https://unismsapi.com/api/sms', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const responseText = await response.text();
        console.log(`📦 Response status: ${response.status}`);
        console.log(`📦 Response body: ${responseText}`);

        let data;
        try { data = JSON.parse(responseText); } catch (e) {
            console.error('❌ Failed to parse JSON:', e.message);
            if (response.status >= 200 && response.status < 300) {
                console.log('✅ SMS sent successfully (response status 2xx)');
                return { ok: true, statusCode: 200, body: { success: true, message: 'SMS sent successfully', referenceId: null } };
            }
            return {
                ok: false,
                statusCode: 502,
                body: { success: false, error: 'SMS provider returned an unparsable response', rawResponse: responseText }
            };
        }

        if (response.status >= 200 && response.status < 300) {
            console.log('✅ SMS sent successfully');
            return {
                ok: true,
                statusCode: 200,
                body: { success: true, message: 'SMS sent successfully', referenceId: data.message?.reference_id || data.reference_id || null }
            };
        }

        if (response.status === 401) {
            console.error('❌ Authentication failed – check your API Secret key');
        }

        if (response.status === 422) {
            console.error('❌ Validation error – check recipient, content, or sender_id');
            if (data.errors) {
                console.error('  Details:', JSON.stringify(data.errors, null, 2));
                if (data.errors.sender_id) {
                    console.warn('💡 Sender ID is invalid. Please set a valid sender ID in .env (UNISMS_SENDER_ID) or get one from the UniSMS dashboard.');
                }
                if (data.errors.content && data.errors.content[0]?.includes('Emojis')) {
                    console.warn('💡 Emojis removed automatically. Message should now be plain text.');
                }
            }
        }

        console.error('❌ SMS sending failed');
        return {
            ok: false,
            statusCode: response.status && response.status >= 400 ? response.status : 502,
            body: { success: false, error: data.message || data.error || 'Unknown error from SMS provider', details: data.errors || null }
        };
    } catch (error) {
        console.error('❌ SMS sending error:', error.message);
        return { ok: false, statusCode: 502, body: { success: false, error: 'Network error while sending SMS: ' + error.message } };
    }
}

app.post('/api/send-sms', requireSession, smsLimiter, async (req, res) => {
    const { studentId, condition, advice, severity, channels } = req.body;

    if (!studentId || !condition) {
        return res.status(400).json({ error: 'Missing required fields: studentId, condition' });
    }
    const id = parseInt(studentId, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid studentId' });
    }

    let channelsArray = channels;
    if (!channelsArray || !Array.isArray(channelsArray) || channelsArray.length === 0) {
        channelsArray = ['sms', 'email'];
    }
    const validChannels = ['sms', 'email'];
    const filteredChannels = channelsArray.filter(ch => validChannels.includes(ch));
    if (filteredChannels.length === 0) {
        return res.status(400).json({ error: 'No valid channels selected. Choose sms and/or email.' });
    }

    db.get('SELECT id, name, phone, email FROM students WHERE id = ?', [id], async (err, student) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!student) return res.status(404).json({ error: 'Student not found' });

        const validatedPhone = sanitizePhone(student.phone);
        if (filteredChannels.includes('sms') && (validatedPhone === false || !validatedPhone)) {
            return res.status(400).json({ error: 'SMS requested but no valid phone number on file for this student.' });
        }
        const studentName = student.name;
        const email = student.email || null;
        if (filteredChannels.includes('email') && !email) {
            return res.status(400).json({ error: 'Email requested but no email address on file for this student.' });
        }

        const role = req.session.role;

        // ─── GUEST: queue for admin approval ───
        if (role === 'guest') {
            const smsStatus = filteredChannels.includes('sms') ? 'pending' : 'none';
            const emailStatus = filteredChannels.includes('email') ? 'pending' : 'none';
            const stmt = db.prepare(`
                INSERT INTO sms_requests (studentName, phone, email, condition, advice, severity, requestedByRole, status, channels, sms_status, email_status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
            `);
            stmt.run(studentName, validatedPhone, email, condition, advice || '', normalizeSeverity(severity) || null, role, filteredChannels.join(','), smsStatus, emailStatus, function(insertErr) {
                if (insertErr) {
                    console.error(insertErr);
                    return res.status(500).json({ error: 'Database error while creating SMS request' });
                }
                console.log(`📝 SMS request #${this.lastID} queued for admin approval (guest, ${studentName})`);
                res.json({
                    success: true,
                    pending: true,
                    requestId: this.lastID,
                    message: `Request sent to an admin for approval. The parent will be notified via ${filteredChannels.join(' and ')} once approved.`
                });
            });
            stmt.finalize();
            return;
        }

        // ─── TEACHER / ADMIN: send immediately ───
        let smsResult = { ok: false, error: 'SMS not requested' };
        let emailResult = { ok: false, error: 'Email not requested' };
        if (filteredChannels.includes('sms') && validatedPhone) {
            smsResult = await sendSmsViaProvider(validatedPhone, studentName, condition, advice);
        }
        if (filteredChannels.includes('email') && email) {
            emailResult = await sendEmailViaProvider(email, studentName, condition, advice);
        }
        const allOk = (filteredChannels.includes('sms') ? smsResult.ok : true) &&
                      (filteredChannels.includes('email') ? emailResult.ok : true);
        res.json({
            success: allOk,
            sms: smsResult,
            email: emailResult,
            channels: filteredChannels
        });
    });
});

// ---- SMS APPROVAL QUEUE (admin only) ----
app.get('/api/sms-requests', requireTeacherOrAdmin, (req, res) => {
    db.all(`
        SELECT sr.*,
            (SELECT COUNT(*) FROM email_replies er WHERE er.sms_request_id = sr.id) AS replyCount
        FROM sms_requests sr
        ORDER BY sr.createdAt DESC LIMIT 200
    `, (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(rows);
    });
});

// ---- PARENT EMAIL REPLIES FOR A REQUEST (admin/teacher) ----
app.get('/api/sms-requests/:id/replies', requireTeacherOrAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid request id' });
    db.all(
        'SELECT id, fromAddress, subject, body, receivedAt FROM email_replies WHERE sms_request_id = ? ORDER BY receivedAt ASC',
        [id],
        (err, rows) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.json(rows);
        }
    );
});

// ---- MANUALLY TRIGGER A REPLY CHECK (admin only, for debugging/on-demand refresh) ----
app.post('/api/sms-requests/poll-replies', requireAdmin, async (req, res) => {
    const result = await pollEmailReplies(db);
    res.json(result);
});

app.post('/api/sms-requests/:id/approve-sms', requireAdmin, smsQueueLimiter, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid request id' });

    db.get('SELECT * FROM sms_requests WHERE id = ?', [id], async (err, row) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) return res.status(404).json({ error: 'Request not found' });
        if (row.sms_status !== 'pending') {
            return res.status(409).json({ error: `SMS already ${row.sms_status}` });
        }

        let smsResult = { ok: false, error: 'SMS not requested' };
        if (row.phone) {
            smsResult = await sendSmsViaProvider(row.phone, row.studentName, row.condition, row.advice);
        }

        const newStatus = smsResult.ok ? 'approved' : 'failed';
        db.run(
            'UPDATE sms_requests SET sms_status = ?, resolvedBy = ?, resolvedAt = CURRENT_TIMESTAMP WHERE id = ?',
            [newStatus, req.session.username || 'admin', id],
            (updateErr) => {
                if (updateErr) console.error('Failed to update sms_status:', updateErr);
            }
        );
        console.log(`${newStatus === 'approved' ? '✅' : '❌'} SMS #${id} ${newStatus} by ${req.session.username}`);
        res.json({ success: newStatus === 'approved', status: newStatus, sms: smsResult });
    });
});

app.post('/api/sms-requests/:id/reject-sms', requireAdmin, smsQueueLimiter, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid request id' });

    db.get('SELECT * FROM sms_requests WHERE id = ?', [id], async (err, row) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) return res.status(404).json({ error: 'Request not found' });
        if (row.sms_status !== 'pending') {
            return res.status(409).json({ error: `SMS already ${row.sms_status}` });
        }
        db.run(
            'UPDATE sms_requests SET sms_status = ?, resolvedBy = ?, resolvedAt = CURRENT_TIMESTAMP WHERE id = ?',
            ['rejected', req.session.username || 'admin', id],
            (updateErr) => {
                if (updateErr) console.error('Failed to update sms_status:', updateErr);
            }
        );
        console.log(`🚫 SMS #${id} rejected by ${req.session.username}`);
        res.json({ success: true, status: 'rejected' });
    });
});

app.post('/api/sms-requests/:id/approve-email', requireAdmin, smsQueueLimiter, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid request id' });

    db.get('SELECT * FROM sms_requests WHERE id = ?', [id], async (err, row) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) return res.status(404).json({ error: 'Request not found' });
        if (row.email_status !== 'pending') {
            return res.status(409).json({ error: `Email already ${row.email_status}` });
        }

        let emailResult = { ok: false, error: 'Email not requested' };
        if (row.email) {
            emailResult = await sendEmailViaProvider(row.email, row.studentName, row.condition, row.advice);
        }

        const newStatus = emailResult.ok ? 'approved' : 'failed';
        db.run(
            'UPDATE sms_requests SET email_status = ?, resolvedBy = ?, resolvedAt = CURRENT_TIMESTAMP, email_message_id = ? WHERE id = ?',
            [newStatus, req.session.username || 'admin', emailResult.messageId || null, id],
            (updateErr) => {
                if (updateErr) console.error('Failed to update email_status:', updateErr);
            }
        );
        console.log(`${newStatus === 'approved' ? '✅' : '❌'} Email #${id} ${newStatus} by ${req.session.username}`);
        res.json({ success: newStatus === 'approved', status: newStatus, email: emailResult });
    });
});

app.post('/api/sms-requests/:id/reject-email', requireAdmin, smsQueueLimiter, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid request id' });

    db.get('SELECT * FROM sms_requests WHERE id = ?', [id], async (err, row) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) return res.status(404).json({ error: 'Request not found' });
        if (row.email_status !== 'pending') {
            return res.status(409).json({ error: `Email already ${row.email_status}` });
        }
        db.run(
            'UPDATE sms_requests SET email_status = ?, resolvedBy = ?, resolvedAt = CURRENT_TIMESTAMP WHERE id = ?',
            ['rejected', req.session.username || 'admin', id],
            (updateErr) => {
                if (updateErr) console.error('Failed to update email_status:', updateErr);
            }
        );
        console.log(`🚫 Email #${id} rejected by ${req.session.username}`);
        res.json({ success: true, status: 'rejected' });
    });
});

app.delete('/api/sms-requests/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid request id' });
    db.run('DELETE FROM sms_requests WHERE id = ?', [id], function(err) {
        if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
        if (this.changes === 0) return res.status(404).json({ error: 'Request not found' });
        res.json({ message: 'Request deleted' });
    });
});

// ---- STATUS ENDPOINT FOR GUEST POLLING ----
app.get('/api/sms-requests/:id/status', requireSession, smsStatusLimiter, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid request id' });
    }

    db.get('SELECT id, status, sms_status, email_status, studentName FROM sms_requests WHERE id = ?', [id], (err, row) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) {
            return res.status(404).json({ error: 'Request not found' });
        }
        // Determine overall status if both are resolved
        let overallStatus = row.status;
        if (overallStatus === 'pending' && row.sms_status !== 'pending' && row.email_status !== 'pending') {
            overallStatus = (row.sms_status === 'approved' || row.email_status === 'approved') ? 'approved' : 'rejected';
        }
        res.json({
            id: row.id,
            status: overallStatus,
            sms_status: row.sms_status,
            email_status: row.email_status,
            studentName: row.studentName
        });
    });
});

// ---- HOSPITAL SEARCH ----
app.post('/api/hospitals', requireSession, hospitalLimiter, async (req, res) => {
    const { lat, lng, radius = 30000 } = req.body;

    if (typeof lat !== 'number' || isNaN(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ error: 'Invalid latitude' });
    }
    if (typeof lng !== 'number' || isNaN(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ error: 'Invalid longitude' });
    }
    const radiusNum = Number(radius);
    if (isNaN(radiusNum) || radiusNum < 100 || radiusNum > 50000) {
        return res.status(400).json({ error: 'Radius must be between 100 and 50000 meters' });
    }

    const query = `
        [out:json];
        (
            node["amenity"="hospital"](around:${radiusNum},${lat},${lng});
            node["amenity"="clinic"](around:${radiusNum},${lat},${lng});
            node["amenity"="doctors"](around:${radiusNum},${lat},${lng});
            node["healthcare"="hospital"](around:${radiusNum},${lat},${lng});
            node["healthcare"="clinic"](around:${radiusNum},${lat},${lng});
            way["amenity"="hospital"](around:${radiusNum},${lat},${lng});
            way["amenity"="clinic"](around:${radiusNum},${lat},${lng});
            way["healthcare"="hospital"](around:${radiusNum},${lat},${lng});
        );
        out;
    `;

    const endpoints = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter'
    ];

    let hospitals = [];
    let anySuccess = false;

    for (const endpoint of endpoints) {
        const url = `${endpoint}?data=${encodeURIComponent(query)}`;
        console.log(`🌐 Trying: ${endpoint}`);
        try {
            const response = await fetch(url, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'SkinGuard/1.0' }
            });
            if (!response.ok) {
                console.warn(`  ⚠️ ${endpoint} returned ${response.status}`);
                continue;
            }
            anySuccess = true;
            const data = await response.json();
            const elements = data.elements || [];
            console.log(`  ✅ ${endpoint} returned ${elements.length} elements`);

            if (elements.length > 0) {
                console.log('  Sample element:', JSON.stringify(elements[0]).slice(0, 200));
            }

            const extracted = elements
                .map(el => {
                    const lat = el.lat || (el.center && el.center.lat) || 0;
                    const lon = el.lon || (el.center && el.center.lon) || 0;
                    return {
                        name: el.tags?.name || 'Medical Facility',
                        address: el.tags?.['addr:street'] || el.tags?.['addr:full'] || '',
                        lat: lat,
                        lon: lon
                    };
                })
                .filter(h => h.lat && h.lon);

            if (extracted.length > 0) {
                hospitals = extracted;
                console.log(`  📍 Extracted ${hospitals.length} hospitals from ${endpoint}`);
                break;
            }
        } catch (e) {
            console.warn(`  ❌ ${endpoint} failed:`, e.message);
        }
    }

    if (hospitals.length === 0 && anySuccess) {
        console.log('⚠️ No hospitals found in successful response, returning empty array');
        return res.json({ hospitals: [] });
    }

    if (hospitals.length === 0 && !anySuccess) {
        console.error('❌ All Overpass endpoints failed or returned no data');
        return res.status(500).json({ error: 'Failed to fetch hospitals from OpenStreetMap' });
    }

    const seen = new Set();
    const unique = hospitals.filter(h => {
        const key = `${h.lat.toFixed(5)},${h.lon.toFixed(5)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`✅ Returning ${unique.length} unique hospitals/clinics`);
    res.json({ hospitals: unique });
});

// ---- ANALYSIS (AI) ----
const staticConditionData = {
    'bugbites': { severity: 'Green', advice: 'Minor – can go back to class. Monitor for swelling.', firstAid: 'Wash with soap and water. Apply cold compress. Use anti-itch cream if needed.' },
    'chickenpox': { severity: 'Red', advice: 'Serious – call parents immediately. Isolate child.', firstAid: 'Keep clean, avoid scratching, use calamine lotion, consult doctor immediately.' },
    'cold sore': { severity: 'Yellow', advice: 'Avoid touching, sharing utensils. Use cold sore cream. See doctor if recurrent.', firstAid: 'Apply ice. Use lip balm. Avoid picking.' },
    'eczema': { severity: 'Yellow', advice: 'Moisturize, avoid scratching. Avoid known triggers. See doctor if severe.', firstAid: 'Apply gentle moisturizer. Use cool compress. Avoid harsh soaps.' },
    'heatrash': { severity: 'Green', advice: 'Cool down, keep skin dry. Wear loose clothing.', firstAid: 'Move to cool area. Apply cool cloth. Avoid creams that block pores.' },
    'hives': { severity: 'Yellow', advice: 'Possible allergic reaction. Monitor for swelling. Give antihistamine if available. See doctor if breathing difficulty.', firstAid: 'Apply cool compress. Avoid scratching. Seek medical help if swelling occurs.' },
    'impetigo': { severity: 'Red', advice: 'Highly contagious. Isolate child, see doctor immediately for antibiotics.', firstAid: 'Cover area loosely. Wash hands frequently. Do not touch sores.' },
    'molluscum': { severity: 'Green', advice: 'Harmless, usually clears on its own. Avoid sharing towels.', firstAid: 'Keep area clean. Do not pick. Consult doctor if spreads.' },
    'rash': { severity: 'Yellow', advice: 'Observe. Notify parents after school. If spreads, see doctor.', firstAid: 'Avoid scratching. Apply calamine lotion. Keep area dry.' },
    'ringworm': { severity: 'Yellow', advice: 'Antifungal cream needed. Keep area clean and dry. See doctor if persists.', firstAid: 'Apply over-the-counter antifungal cream. Wash hands thoroughly.' },
    'scabies': { severity: 'Red', advice: 'Intense itching, highly contagious. See doctor for prescription cream. Notify school.', firstAid: 'Avoid scratching. Wash clothing and bedding in hot water. Isolate until treated.' },
    'sunburn': { severity: 'Green', advice: 'Apply aloe vera. Return to class, avoid sun.', firstAid: 'Cool compresses, aloe vera, drink water.' },
    'warts': { severity: 'Green', advice: 'Over‑the‑counter treatments available. Avoid picking.', firstAid: 'Cover with bandage. Use wart remover as directed. Wash hands after touching.' }
};

async function getAdviceFromOpenAI(condition) {
    console.log(`  → Calling OpenAI for advice on "${condition}"...`);
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are a helpful assistant for school staff. Given a skin condition, return short advice and first-aid steps. Use JSON format: {"advice": "...", "firstAid": "..."}. Only return JSON, no extra text.'
                },
                {
                    role: 'user',
                    content: `A student has been identified with ${condition}. What should the teacher do and what first aid can be given?`
                }
            ],
            max_tokens: 150,
            temperature: 0.3
        }, {
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
        });
        const content = response.data.choices[0].message.content;
        console.log('  ✅ OpenAI response received');
        return JSON.parse(content);
    } catch (error) {
        console.error('  ❌ OpenAI advice generation failed:', error.message);
        return null;
    }
}

async function generateAndSaveAudio(text, fileName = 'analysis_audio.mp3') {
    if (!elevenLabs) return null;
    console.log(`  → Generating TTS audio...`);
    try {
        const voiceId = '21m00Tcm4TlvDq8ikWAM';
        const audioStream = await elevenLabs.textToSpeech.convert(voiceId, {
            text: text,
            model_id: 'eleven_monolingual_v1',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        });
        const audioPath = path.join(__dirname, 'public', fileName);
        if (fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath);
            console.log('  🗑️ Old audio file removed');
        }
        const nodeStream = Readable.fromWeb(audioStream);
        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(audioPath);
            nodeStream.pipe(writer);
            writer.on('finish', () => {
                console.log('  ✅ TTS audio saved:', fileName);
                resolve(fileName);
            });
            writer.on('error', reject);
        });
    } catch (error) {
        console.error('  ❌ ElevenLabs TTS error:', error.message);
        return null;
    }
}

app.post('/api/analyze', requireSession, analyzeLimiter, async (req, res) => {
    const startTime = Date.now();
    console.log('\n📥 [SCAN] Received image from frontend');

    const { image } = req.body;
    if (!image || typeof image !== 'string') {
        console.log('❌ No image provided');
        return res.status(400).json({ error: 'No image provided' });
    }

    try {
        let base64Image = image.split(',')[1];
        if (!base64Image) throw new Error('Invalid image format');
        base64Image = base64Image.replace(/\s/g, '');
        console.log(`  ✅ Base64 length: ${base64Image.length} characters`);

        console.log('🔄 Calling Roboflow API...');
        const roboStart = Date.now();
        const response = await axios({
            method: 'POST',
            url: `https://detect.roboflow.com/aaron-doronio-s-workspace/skinguard_datasetsv1-2-5-rfdetr-large-t1?api_key=${process.env.ROBOFLOW_API_KEY}`,
            data: base64Image,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        console.log(`  ✅ Roboflow responded in ${Date.now() - roboStart}ms`);

        const predictions = response.data.predictions || [];
        const imageSize = response.data.image || { width: 0, height: 0 };
        console.log(`  📊 Predictions found: ${predictions.length}`);

        if (predictions.length === 0) {
            console.log('ℹ️ No detections, returning "No issue detected"');
            const noIssueResult = {
                condition: 'No issue detected',
                confidence: 0,
                severity: 'Green',
                advice: 'No action needed.',
                firstAid: 'None',
                bboxes: [],
                imageSize: imageSize
            };
            noIssueResult.scanToken = createScanToken({
                condition: noIssueResult.condition,
                severity: noIssueResult.severity,
                advice: noIssueResult.advice,
                firstAid: noIssueResult.firstAid
            });
            console.log(`⏱️ Total time: ${Date.now() - startTime}ms\n`);
            return res.json({ choices: [{ message: { content: JSON.stringify(noIssueResult) } }] });
        }

        const threshold = 0.3;
        const valid = predictions.filter(p => p.confidence >= threshold);
        const best = valid.reduce((prev, curr) => (curr.confidence > prev.confidence ? curr : prev), valid[0]);
        const rawClass = best.class;
        const confidence = best.confidence;
        const displayCondition = rawClass.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        console.log(`  🏷️ Top detection: "${displayCondition}" with confidence ${(confidence * 100).toFixed(1)}%`);

        const staticInfo = staticConditionData[rawClass];
        if (!staticInfo) {
            console.log(`⚠️ Unknown class "${rawClass}", using fallback`);
            const fallbackResult = {
                condition: displayCondition,
                confidence,
                severity: 'Yellow',
                advice: 'Consult a healthcare professional.',
                firstAid: 'Monitor the area and keep it clean.',
                bboxes: valid.map(p => ({ class: p.class, confidence: p.confidence, x: p.x, y: p.y, width: p.width, height: p.height })),
                imageSize: imageSize
            };
            fallbackResult.scanToken = createScanToken({
                condition: fallbackResult.condition,
                severity: fallbackResult.severity,
                advice: fallbackResult.advice,
                firstAid: fallbackResult.firstAid
            });
            console.log(`⏱️ Total time: ${Date.now() - startTime}ms\n`);
            return res.json({ choices: [{ message: { content: JSON.stringify(fallbackResult) } }] });
        }
        const severity = staticInfo.severity;
        console.log(`  🎨 Severity: ${severity}`);

        let advice, firstAid;
        const openAiResult = await getAdviceFromOpenAI(displayCondition);
        if (openAiResult) {
            advice = openAiResult.advice;
            firstAid = openAiResult.firstAid;
            console.log(`  💬 Advice: "${advice}"`);
            console.log(`  🩹 First aid: "${firstAid}"`);
        } else {
            console.log('  ⚠️ Falling back to static advice');
            advice = staticInfo.advice;
            firstAid = staticInfo.firstAid;
        }

        const allBoxes = valid.map(p => ({
            class: p.class,
            confidence: p.confidence,
            x: p.x, y: p.y, width: p.width, height: p.height
        }));

        const result = {
            condition: displayCondition,
            confidence,
            severity,
            advice,
            firstAid,
            bboxes: allBoxes,
            imageSize: imageSize
        };
        result.scanToken = createScanToken({
            condition: result.condition,
            severity: result.severity,
            advice: result.advice,
            firstAid: result.firstAid
        });

        if (elevenLabs) {
            const textForAudio = `Result: ${displayCondition}. ${advice} ${firstAid}`;
            const audioFile = await generateAndSaveAudio(textForAudio, 'analysis_audio.mp3');
            if (audioFile) {
                result.audioUrl = `/${audioFile}?t=${Date.now()}`;
                console.log(`  🔊 Audio URL: ${result.audioUrl}`);
            }
        }

        console.log(`✅ Scan complete in ${Date.now() - startTime}ms\n`);
        res.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
    } catch (error) {
        console.error('❌ Analysis error:', error.message);
        if (error.response) {
            console.error('  Response data:', error.response.data);
        }
        console.log(`⏱️ Total time: ${Date.now() - startTime}ms (failed)\n`);
        const fallbackResult = {
            condition: 'No issue detected',
            confidence: 0,
            severity: 'Green',
            advice: 'No action needed.',
            firstAid: 'None',
            bboxes: [],
            imageSize: { width: 0, height: 0 }
        };
        fallbackResult.scanToken = createScanToken({
            condition: fallbackResult.condition,
            severity: fallbackResult.severity,
            advice: fallbackResult.advice,
            firstAid: fallbackResult.firstAid
        });
        res.json({ choices: [{ message: { content: JSON.stringify(fallbackResult) } }] });
    }
});

// ---------- SERVE STATIC FILES ----------
app.use(express.static('public'));

// ---------- START SERVER ----------
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Admin panel at http://localhost:${PORT}/admin`);
});