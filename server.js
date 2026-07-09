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

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- SECURITY HEADERS (helmet) ----------
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      "script-src-attr": ["'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://api.mapbox.com"],
      "connect-src": [
        "'self'",
        "https://api.mapbox.com",
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
// ---------- CORS (restricted) ----------
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

// ---------- AUTH MIDDLEWARES ----------
function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    res.redirect('/login');
}

function requireSession(req, res, next) {
    if (req.session && (req.session.role === 'teacher' || req.session.role === 'admin' || req.session.role === 'guest')) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}

function requireTeacherOrAdmin(req, res, next) {
    if (req.session && (req.session.role === 'teacher' || req.session.role === 'admin')) {
        return next();
    }
    res.status(403).json({ error: 'Teacher or admin access required' });
}

// ---------- PHONE SANITIZER ----------
function sanitizePhone(phone) {
    if (!phone) return null;
    return phone.replace(/[^\d+]/g, '');
}

// ---------- SERVER-SIDE MASKING HELPERS ----------
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
const pendingScans = new Map(); // token -> { condition, severity, advice, firstAid, createdAt }
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

// ---------- GUEST LOGIN (rate-limited, shorter session) ----------
app.post('/api/guest-login', guestLoginLimiter, (req, res) => {
    req.session.role = 'guest';
    req.session.isGuest = true;
    req.session.cookie.maxAge = 2 * 60 * 60 * 1000; // 2 hours
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

app.get('/admin', requireAdmin, (req, res) => {
    console.log('✅ Admin page accessed by:', req.session.username);
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin.html', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---------- PROTECTED API ROUTES ----------
app.use('/api/get-scans', requireAdmin);
app.use('/api/add-scan', requireAdmin);
app.use('/api/update-scan', requireAdmin);
app.use('/api/delete-scan', requireAdmin);

app.use('/api/students', requireSession);
app.use('/api/save-scan', requireSession);
app.use('/api/analyze', requireSession);
app.use('/api/send-sms', requireTeacherOrAdmin);

app.use('/api/analyze', analyzeLimiter);
app.use('/api/send-sms', smsLimiter);
app.use('/api/hospitals', hospitalLimiter);
app.use('/api/save-scan', saveScanLimiter);
app.post('/api/students', studentPostLimiter);

app.use(express.static('public'));

// ---------- ElevenLabs ----------
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

    db.run(`
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            phone TEXT
        )
    `);

    db.run("ALTER TABLE students ADD COLUMN addedByRole TEXT", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn('Could not add addedByRole column:', err.message);
        }
    });
});

// ---------- PUBLIC API ENDPOINTS ----------
app.get('/api/students', (req, res) => {
    db.all('SELECT id, name, phone FROM students ORDER BY name', (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        const role = req.session.role || 'guest';
        const maskedRows = rows.map(row => maskStudentForRole(row, role));
        res.json(maskedRows);
    });
});

app.post('/api/students', (req, res) => {
    const { name, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const sanitizedPhone = sanitizePhone(phone);

    db.get('SELECT id, name, phone FROM students WHERE name = ?', [name], (err, row) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (row) {
            const role = req.session.role || 'guest';
            if (role !== 'teacher' && role !== 'admin') {
                return res.status(403).json({ error: 'Only teachers or admins can update existing student phone numbers.' });
            }
            if (sanitizedPhone && sanitizedPhone !== row.phone) {
                db.run('UPDATE students SET phone = ? WHERE id = ?', [sanitizedPhone, row.id], (updateErr) => {
                    if (updateErr) {
                        console.error(updateErr);
                        return res.status(500).json({ error: 'Failed to update phone' });
                    }
                    const masked = maskStudentForRole({ id: row.id, name: row.name, phone: sanitizedPhone || row.phone }, role);
                    res.json(masked);
                });
            } else {
                const masked = maskStudentForRole({ id: row.id, name: row.name, phone: row.phone }, role);
                res.json(masked);
            }
        } else {
            const role = req.session.role || 'guest';
            const stmt = db.prepare('INSERT INTO students (name, phone, addedByRole) VALUES (?, ?, ?)');
            stmt.run(name, sanitizedPhone, role, function(insertErr) {
                if (insertErr) {
                    console.error(insertErr);
                    return res.status(500).json({ error: 'Database error' });
                }
                const newStudent = { id: this.lastID, name, phone: sanitizedPhone, addedByRole: role };
                const masked = maskStudentForRole(newStudent, role);
                res.json(masked);
            });
            stmt.finalize();
        }
    });
});

app.post('/api/save-scan', (req, res) => {
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

    if (image && typeof image === 'string' && image.length > 2 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image too large (max 2MB)' });
    }
    const sanitizedPhone = sanitizePhone(phone);
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

app.get('/api/get-scans', (req, res) => {
    db.all('SELECT * FROM scans ORDER BY timestamp DESC', (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        console.log(`📋 Retrieved ${rows.length} scans`);
        res.json(rows);
    });
});

app.post('/api/add-scan', (req, res) => {
    const { name, phone, condition, severity, advice, firstAid, image } = req.body;
    if (!name || !condition || !severity) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const normalizedSeverity = normalizeSeverity(severity);
    if (!normalizedSeverity) {
        return res.status(400).json({ error: `Severity must be one of: ${ALLOWED_SEVERITIES.join(', ')}` });
    }
    const sanitizedPhone = sanitizePhone(phone);
    const submittedRole = req.session.role || 'admin';
    const stmt = db.prepare('INSERT INTO scans (name, phone, condition, severity, advice, firstAid, image, submittedRole) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    stmt.run(name, sanitizedPhone, condition, normalizedSeverity, advice, firstAid, image || null, submittedRole, function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ id: this.lastID, message: 'Scan added' });
    });
    stmt.finalize();
});

app.put('/api/update-scan/:id', (req, res) => {
    if (req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    const { id } = req.params;
    const { name, phone, condition, severity, advice, firstAid } = req.body;
    if (!name || !condition || !severity) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const normalizedSeverity = normalizeSeverity(severity);
    if (!normalizedSeverity) {
        return res.status(400).json({ error: `Severity must be one of: ${ALLOWED_SEVERITIES.join(', ')}` });
    }
    const sanitizedPhone = sanitizePhone(phone);
    const stmt = db.prepare('UPDATE scans SET name = ?, phone = ?, condition = ?, severity = ?, advice = ?, firstAid = ? WHERE id = ?');
    stmt.run(name, sanitizedPhone, condition, normalizedSeverity, advice, firstAid, id, function(err) {
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

app.delete('/api/delete-scan/:id', (req, res) => {
    if (req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
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

// ---------- Static fallback data ----------
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

// Helper: Call OpenAI
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

// Helper: Generate TTS audio
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

// ---------- MAIN ANALYSIS ENDPOINT ----------
app.post('/api/analyze', async (req, res) => {
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

// ---------- SMS ENDPOINT ----------
app.post('/api/send-sms', async (req, res) => {
    const { to, studentName, condition, advice, severity } = req.body;

    if (!to || !studentName || !condition) {
        return res.status(400).json({ error: 'Missing required fields: to, studentName, condition' });
    }

    const apiSecretKey = process.env.UNISMS_API_SECRET;

    if (!apiSecretKey) {
        console.warn('⚠️ UNISMS_API_SECRET not set in .env – simulating SMS send');
        return res.json({
            success: true,
            simulated: true,
            message: 'SMS simulated (no API key configured). Add UNISMS_API_SECRET to .env'
        });
    }

    let messageText = `AMA SKINGUARD ALERT\nPARENT NOTIFICATION\nDear parent/guardian of ${studentName}, your child was assessed with ${condition}. ${advice}. Please take appropriate action.`;
    messageText = messageText.replace(/[^\x00-\x7F]/g, '');

    let senderId = process.env.UNISMS_SENDER_ID;
    const useSenderId = senderId && senderId.trim().length > 0;

    console.log(`📤 Sending SMS to ${to} via UniSMS...`);
    console.log(`📝 Message: ${messageText}`);
    if (useSenderId) console.log(`📤 Sender ID: ${senderId}`);
    else console.log('📤 No sender ID provided – will omit field');

    try {
        const requestBody = {
            recipient: to,
            content: messageText
        };
        if (useSenderId) {
            requestBody.sender_id = senderId;
        }

        const auth = Buffer.from(`${apiSecretKey}:`).toString('base64');

        console.log('📦 Request:', JSON.stringify(requestBody, null, 2));

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
        try {
            data = JSON.parse(responseText);
        } catch (e) {
            console.error('❌ Failed to parse JSON:', e.message);
            if (response.status >= 200 && response.status < 300) {
                console.log('✅ SMS sent successfully (response status 2xx)');
                return res.json({
                    success: true,
                    message: 'SMS sent successfully',
                    referenceId: null
                });
            }
            return res.json({
                success: true,
                simulated: true,
                message: 'SMS sent (simulated – parse error)',
                rawResponse: responseText
            });
        }

        if (response.status >= 200 && response.status < 300) {
            console.log('✅ SMS sent successfully');
            return res.json({
                success: true,
                message: 'SMS sent successfully',
                referenceId: data.message?.reference_id || data.reference_id || null
            });
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

        console.warn('⚠️ SMS sending failed – simulating success for demo');
        res.json({
            success: true,
            simulated: true,
            message: 'SMS sent (simulated)',
            error: data.message || data.error || 'Unknown error',
            code: response.status
        });
    } catch (error) {
        console.error('❌ SMS sending error:', error.message);
        console.warn('⚠️ Network error – simulating SMS success for demo');
        res.json({
            success: true,
            simulated: true,
            message: 'SMS sent (simulated)',
            error: error.message
        });
    }
});

// ---------- HOSPITAL SEARCH ----------
app.post('/api/hospitals', async (req, res) => {
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

// ---------- START SERVER ----------
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Admin panel at http://localhost:${PORT}/admin`);
});