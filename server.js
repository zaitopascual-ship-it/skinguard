const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
const { Readable } = require('stream');
require('dotenv').config();

console.log('OpenAI API Key:', process.env.OPENAI_API_KEY ? 'Loaded' : 'Not found');
console.log('Roboflow API Key:', process.env.ROBOFLOW_API_KEY ? 'Loaded' : 'Not found');
console.log('ElevenLabs API Key:', process.env.ELEVENLABS_API_KEY ? 'Loaded' : 'Not found');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ---------- ElevenLabs Client ----------
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

    db.run(`
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            phone TEXT
        )
    `);
});

// ---------- API ENDPOINTS ----------
app.get('/api/students', (req, res) => {
    db.all('SELECT id, name, phone FROM students ORDER BY name', (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(rows);
    });
});

app.post('/api/students', (req, res) => {
    const { name, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const stmt = db.prepare('INSERT INTO students (name, phone) VALUES (?, ?)');
    stmt.run(name, phone, function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ id: this.lastID, name, phone });
    });
    stmt.finalize();
});

app.post('/api/save-scan', (req, res) => {
    const { name, phone, condition, severity, advice, firstAid, image } = req.body;
    if (!name || !condition || !severity) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const stmt = db.prepare('INSERT INTO scans (name, phone, condition, severity, advice, firstAid, image) VALUES (?, ?, ?, ?, ?, ?, ?)');
    stmt.run(name, phone, condition, severity, advice, firstAid, image || null, function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
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
        res.json(rows);
    });
});

app.post('/api/add-scan', (req, res) => {
    const { name, phone, condition, severity, advice, firstAid, image } = req.body;
    if (!name || !condition || !severity) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const stmt = db.prepare('INSERT INTO scans (name, phone, condition, severity, advice, firstAid, image) VALUES (?, ?, ?, ?, ?, ?, ?)');
    stmt.run(name, phone, condition, severity, advice, firstAid, image || null, function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ id: this.lastID, message: 'Scan added' });
    });
    stmt.finalize();
});

app.put('/api/update-scan/:id', (req, res) => {
    const { id } = req.params;
    const { name, phone, condition, severity, advice, firstAid } = req.body;
    if (!name || !condition || !severity) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const stmt = db.prepare('UPDATE scans SET name = ?, phone = ?, condition = ?, severity = ?, advice = ?, firstAid = ? WHERE id = ?');
    stmt.run(name, phone, condition, severity, advice, firstAid, id, function(err) {
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

// ---------- Static fallback data (used only if OpenAI fails) ----------
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

// Helper: Call OpenAI to generate advice and first aid for a condition
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

// Helper: Generate TTS audio (if ElevenLabs configured)
// Helper: Generate TTS audio (always overwrites the same file)
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
        // Delete old file if exists (optional, overwrite is enough)
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

// ---------- MAIN ANALYSIS ENDPOINT with full logging ----------
app.post('/api/analyze', async (req, res) => {
    const startTime = Date.now();
    console.log('\n📥 [SCAN] Received image from frontend');
    
    const { image } = req.body;
    if (!image || typeof image !== 'string') {
        console.log('❌ No image provided');
        return res.status(400).json({ error: 'No image provided' });
    }

    try {
        // 1. Extract base64
        console.log('🔄 Extracting base64...');
        let base64Image = image.split(',')[1];
        if (!base64Image) throw new Error('Invalid image format');
        base64Image = base64Image.replace(/\s/g, '');
        console.log(`  ✅ Base64 length: ${base64Image.length} characters`);

        // 2. Call Roboflow
        console.log('🔄 Calling Roboflow API...');
        const roboStart = Date.now();
        const response = await axios({
            method: 'POST',
            url: `https://detect.roboflow.com/skinguard_datasetsv1-2/3?api_key=${process.env.ROBOFLOW_API_KEY}`,
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
            console.log(`⏱️ Total time: ${Date.now() - startTime}ms\n`);
            return res.json({ choices: [{ message: { content: JSON.stringify(noIssueResult) } }] });
        }

        // Filter by confidence threshold
        const threshold = 0.3;
        const valid = predictions.filter(p => p.confidence >= threshold);
        const best = valid.reduce((prev, curr) => (curr.confidence > prev.confidence ? curr : prev), valid[0]);
        const rawClass = best.class;
        const confidence = best.confidence;
        const displayCondition = rawClass.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        console.log(`  🏷️ Top detection: "${displayCondition}" with confidence ${(confidence * 100).toFixed(1)}%`);

        // 3. Get severity from static map
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
            console.log(`⏱️ Total time: ${Date.now() - startTime}ms\n`);
            return res.json({ choices: [{ message: { content: JSON.stringify(fallbackResult) } }] });
        }
        const severity = staticInfo.severity;
        console.log(`  🎨 Severity: ${severity}`);

        // 4. Get advice and first aid from OpenAI
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

        // 5. Build response
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

        // 6. Generate TTS audio (if ElevenLabs configured)
       // Inside the /api/analyze endpoint, replace the TTS call with:
    if (elevenLabs) {
        const textForAudio = `Result: ${displayCondition}. ${advice} ${firstAid}`;
        const audioFile = await generateAndSaveAudio(textForAudio, 'analysis_audio.mp3');
    if (audioFile) {
        result.audioUrl = `/${audioFile}?t=${Date.now()}`; // Add cache-busting query
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
        // Ultimate fallback
        const fallbackResult = {
            condition: 'No issue detected',
            confidence: 0,
            severity: 'Green',
            advice: 'No action needed.',
            firstAid: 'None',
            bboxes: [],
            imageSize: { width: 0, height: 0 }
        };
        res.json({ choices: [{ message: { content: JSON.stringify(fallbackResult) } }] });
    }
});

        const start = Date.now();
        // After Roboflow
        console.log(`Roboflow: ${Date.now() - start}ms`);
        // After OpenAI
        console.log(`OpenAI: ${Date.now() - start}ms`);
        // After TTS
        console.log(`TTS: ${Date.now() - start}ms`);
        // Total
        console.log(`Total: ${Date.now() - start}ms`);

// ---------- SMS, ADMIN, HOSPITAL endpoints (unchanged) ----------
app.post('/api/send-sms', async (req, res) => {
    // ... your existing SMS code ...
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/api/hospitals', async (req, res) => {
    // ... your existing hospital code ...
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Admin panel at http://localhost:${PORT}/admin`);
});