let capturedImage = null;
let videoStream = null;
let currentFacingMode = 'environment';
let lastResult = null;
let torchEnabled = false;
let pendingAction = null;
let selectedStudent = null;
let isTeacher = false;
let isGuest = true;

// ---------- AMA SANTIAGO CAMPUS COORDINATES ----------//
const SCHOOL_LAT = 16.688356;
const SCHOOL_LNG = 121.550856;

// ---------- ENSURE MAPBOX IS LOADED ----------
function ensureMapboxLoaded(callback) {
    if (typeof mapboxgl !== 'undefined') {
        callback();
        return;
    }
    console.log('🔄 Loading Mapbox GL JS...');
    const script = document.createElement('script');
    script.src = 'https://api.mapbox.com/mapbox-gl-js/v3.10.0/mapbox-gl.js';
    script.onload = () => {
        console.log('✅ Mapbox GL JS loaded');
        callback();
    };
    script.onerror = () => {
        console.error('❌ Failed to load Mapbox GL JS');
        alert('Could not load the map. Please check your internet connection and try again.');
    };
    document.head.appendChild(script);
}

// ---------- MAPBOX TOKEN ----------
const MAPBOX_TOKEN = 'pk.eyJ1IjoiYWFyb25wb2dpMDYiLCJhIjoiY21xcThtcmN3MGczODJ3c2J3Y2Viem1pNSJ9.Sscnjo8gxhVt2C2Gbitxgg';

// ---------- STATIC HOSPITAL LIST ----------
const SANTIAGO_HOSPITALS = [
    { name: 'Southern Isabela Medical Center (SIMC)', address: 'Rosario, Santiago City', lat: 16.6802574, lon: 121.5460643 },
    { name: 'Santiago Medical City', address: 'Rizal, Santiago City', lat: 16.7282523, lon: 121.5493394 },
    { name: 'Callang General Hospital and Medical Center', address: 'Centro East, Santiago City', lat: 16.6925894, lon: 121.5504356 },
    { name: 'Adventist Hospital Santiago City, Inc.', address: 'Mabini, Santiago City', lat: 16.6972695, lon: 121.5643473 },
    { name: 'De Vera Medical Center, Inc.', address: 'Calao East, Santiago City', lat: 16.6788763, lon: 121.5540857 },
    { name: 'Flores Memorial Medical Center', address: 'Villasis, Santiago City', lat: 16.6902891, lon: 121.5487915 },
    { name: 'Renmar Specialists Hospital', address: 'Plaridel, Santiago City', lat: 16.6872677, lon: 121.540592 },
    { name: 'Corado Medical Clinic & Hospital', address: 'Victory Norte, Santiago City', lat: 16.6863428, lon: 121.5477267 },
    { name: 'Cagayan Valley Sanitarium & Hospital', address: 'Santiago City', lat: 16.6972695, lon: 121.5647587 },
    { name: 'Dr. Adolfo O. Flores Memorial Hospital', address: 'Santiago City', lat: 16.6901371, lon: 121.5510837 },
    { name: 'Clinica Caritas Santiago', address: 'Santiago City', lat: 16.6890425, lon: 121.5509493 },
    { name: 'Intellicare - Maharlika Highway', address: 'Santiago City', lat: 16.687584, lon: 121.542402 }
];

// ---------- FALLBACK CONDITIONS ----------
const conditions = [
    { name: 'Bug bite', severity: 'Green', advice: 'Minor – can go back to class. Monitor for swelling.', firstAid: 'Wash with soap and water. Apply cold compress. Use anti-itch cream if needed.' },
    { name: 'Rash', severity: 'Yellow', advice: 'Observe. Notify parents after school. If spreads, see doctor.', firstAid: 'Avoid scratching. Apply calamine lotion. Keep area dry.' },
    { name: 'Chickenpox', severity: 'Red', advice: 'Serious – call parents immediately. Isolate child.', firstAid: 'Keep clean, avoid scratching, use calamine lotion, consult doctor immediately.' },
    { name: 'Sunburn', severity: 'Green', advice: 'Apply aloe vera. Return to class, avoid sun.', firstAid: 'Cool compresses, aloe vera, drink water.' },
    { name: 'Lice', severity: 'Yellow', advice: 'Notify parents. Child should be picked up.', firstAid: 'Use over-the-counter lice treatment, wash bedding.' },
    { name: 'Eczema', severity: 'Yellow', advice: 'Moisturize, avoid scratching. Avoid known triggers. See doctor if severe.', firstAid: 'Apply gentle moisturizer. Use cool compress. Avoid harsh soaps.' },
    { name: 'Ringworm', severity: 'Yellow', advice: 'Antifungal cream needed. Keep area clean and dry. See doctor if persists.', firstAid: 'Apply over-the-counter antifungal cream. Wash hands thoroughly.' },
    { name: 'Hives', severity: 'Yellow', advice: 'Possible allergic reaction. Monitor for swelling. Give antihistamine if available. See doctor if breathing difficulty.', firstAid: 'Apply cool compress. Avoid scratching. Seek medical help if swelling occurs.' },
    { name: 'Impetigo', severity: 'Red', advice: 'Highly contagious. Isolate child, see doctor immediately for antibiotics.', firstAid: 'Cover area loosely. Wash hands frequently. Do not touch sores.' },
    { name: 'Cold sore', severity: 'Yellow', advice: 'Avoid touching, sharing utensils. Use cold sore cream. See doctor if recurrent.', firstAid: 'Apply ice. Use lip balm. Avoid picking.' },
    { name: 'Scabies', severity: 'Red', advice: 'Intense itching, highly contagious. See doctor for prescription cream. Notify school.', firstAid: 'Avoid scratching. Wash clothing and bedding in hot water. Isolate until treated.' },
    { name: 'Molluscum', severity: 'Green', advice: 'Harmless, usually clears on its own. Avoid sharing towels.', firstAid: 'Keep area clean. Do not pick. Consult doctor if spreads.' },
    { name: 'Warts', severity: 'Green', advice: 'Over‑the‑counter treatments available. Avoid picking.', firstAid: 'Cover with bandage. Use wart remover as directed. Wash hands after touching.' },
    { name: 'Heat rash', severity: 'Green', advice: 'Cool down, keep skin dry. Wear loose clothing.', firstAid: 'Move to cool area. Apply cool cloth. Avoid creams that block pores.' }
];

const allowedConditions = [
    'Bug bite', 'Bugbites', 'Bugbite',
    'Rash', 'Chickenpox', 'Sunburn', 'Lice',
    'Eczema', 'Ringworm', 'Hives', 'Impetigo', 'Cold sore',
    'Scabies', 'Molluscum', 'Warts', 'Heat rash', 'No issue detected'
];

// ---------- VALIDATORS ----------
function isValidNamePart(part) {
    if (!part || part.trim().length < 2) return false;
    const cleaned = part.trim();
    if (!/^[A-Za-z\s\-\.']+$/.test(cleaned)) return false;
    if (!/[aeiouAEIOU]/.test(cleaned)) return false;
    return true;
}

function isValidPhone(phone) {
    if (!phone) return true;
    return /^[\d+]+$/.test(phone);
}

// ---------- MASK FUNCTIONS ----------
function maskName(name) {
    if (!name) return '';
    if (isTeacher) return name;
    const trimmed = name.trim();
    if (trimmed.length <= 2) return trimmed.charAt(0) + '*';
    return trimmed.charAt(0) + '*'.repeat(trimmed.length - 2) + trimmed.charAt(trimmed.length - 1);
}

function maskPhone(phone) {
    if (!phone) return 'No phone';
    if (isTeacher) return phone;
    let cleaned = phone.replace(/[^\d+]/g, '');
    let prefix = '';
    let number = cleaned;
    if (cleaned.startsWith('+')) {
        prefix = '+';
        number = cleaned.substring(1);
    }
    if (number.length > 4) {
        let last4 = number.slice(-4);
        let masked = '*'.repeat(number.length - 4) + last4;
        return prefix + masked;
    }
    return prefix + number;
}

// ---------- SCREEN MANAGEMENT ----------
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function showLoading() {
    document.getElementById('loading-overlay').style.display = 'flex';
}
function hideLoading() {
    document.getElementById('loading-overlay').style.display = 'none';
}

// ---------- PHONE NUMBER FORMATTING ----------
function formatPhoneNumber(rawNumber) {
    let cleaned = rawNumber.trim().replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+63')) return cleaned;
    if (cleaned.startsWith('63')) return '+' + cleaned;
    if (cleaned.startsWith('0')) return '+63' + cleaned.substring(1);
    if (cleaned.startsWith('9') && cleaned.length === 10) return '+63' + cleaned;
    if (/^\d{10}$/.test(cleaned)) return '+63' + cleaned;
    if (/^\d{12}$/.test(cleaned) && cleaned.startsWith('63')) return '+' + cleaned;
    return cleaned;
}

// ---------- LOGIN / GUEST ----------
async function checkLoginStatus() {
    try {
        const res = await fetch('/api/me');
        if (res.ok) {
            const data = await res.json();
            if (data.role === 'teacher') {
                isTeacher = true;
                isGuest = false;
                document.getElementById('login-status').textContent = `👤 Logged in as ${data.username} (${data.role})`;
                document.getElementById('login-status').style.display = 'inline-block';
                document.getElementById('login-form').style.display = 'none';
                document.getElementById('guest-btn').style.display = 'none';
                document.getElementById('login-btn').style.display = 'none';
                document.getElementById('login-overlay').classList.add('hidden');
                document.getElementById('app').style.display = 'block';
                document.getElementById('logout-btn').style.display = 'flex';
                return;
            }
        }
        document.getElementById('login-overlay').classList.remove('hidden');
        document.getElementById('app').style.display = 'none';
        document.getElementById('logout-btn').style.display = 'none';
    } catch (e) {
        document.getElementById('login-overlay').classList.remove('hidden');
        document.getElementById('app').style.display = 'none';
        document.getElementById('logout-btn').style.display = 'none';
    }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value.trim();
    const errorEl = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');
    if (!username || !password) {
        errorEl.textContent = 'Please enter username and password.';
        return;
    }
    errorEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'LOGGING IN...';
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            if (data.role === 'teacher') {
                isTeacher = true;
                isGuest = false;
                document.getElementById('login-status').textContent = `👤 Logged in as ${username} (${data.role})`;
                document.getElementById('login-status').style.display = 'inline-block';
                document.getElementById('login-form').style.display = 'none';
                document.getElementById('guest-btn').style.display = 'none';
                document.getElementById('login-btn').style.display = 'none';
                document.getElementById('login-overlay').classList.add('hidden');
                document.getElementById('app').style.display = 'block';
                document.getElementById('logout-btn').style.display = 'flex';
                if (document.getElementById('student-list-container')) {
                    loadStudents();
                }
            } else {
                errorEl.textContent = 'Only teachers can log in here.';
                btn.disabled = false;
                btn.textContent = 'LOGIN AS TEACHER';
            }
        } else {
            errorEl.textContent = data.error || 'Invalid credentials.';
            btn.disabled = false;
            btn.textContent = 'LOGIN AS TEACHER';
            document.getElementById('login-password').value = '';
        }
    } catch (err) {
        errorEl.textContent = 'Network error. Please try again.';
        btn.disabled = false;
        btn.textContent = 'LOGIN AS TEACHER';
    }
});

document.getElementById('guest-btn').addEventListener('click', async function() {
    try {
        const response = await fetch('/api/guest-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) throw new Error('Guest login failed');
        const data = await response.json();
        if (data.success) {
            isTeacher = false;
            isGuest = true;
            document.getElementById('login-overlay').classList.add('hidden');
            document.getElementById('app').style.display = 'block';
            document.getElementById('logout-btn').style.display = 'flex';
            loadStudents();
        }
    } catch (error) {
        console.error('Guest login error:', error);
        alert('Could not start guest session. Please try again.');
    }
});

document.getElementById('logout-btn').addEventListener('click', async function() {
    if (isTeacher) {
        try {
            await fetch('/logout');
        } catch (e) {}
    }
    window.location.href = '/';
});

// ---------- STUDENT SELECTION HELPERS ----------
async function loadStudents(searchTerm = '') {
    try {
        const response = await fetch('/api/students');
        if (!response.ok) throw new Error('Failed to load students');
        let students = await response.json();
        if (searchTerm) {
            students = students.filter(s => s.name.toLowerCase().includes(searchTerm.toLowerCase()));
        }
        const container = document.getElementById('student-list-container');
        if (students.length === 0) {
            container.innerHTML = '<p>No students found. Tap "Add New Student".</p>';
            return;
        }
        let html = '';
        students.forEach(s => {
            const displayName = maskName(s.name);
            const displayPhone = maskPhone(s.phone);
            html += `
                <div class="student-card" data-id="${s.id}" style="background:#f8fafd; border-radius:16px; padding:12px; margin-bottom:10px; cursor:pointer;">
                    <strong>${escapeHtml(displayName)}</strong><br>
                    <span style="font-size:12px; color:#6b7f99;">${escapeHtml(displayPhone)}</span>
                </div>
            `;
        });
        container.innerHTML = html;
        document.querySelectorAll('.student-card').forEach(card => {
            card.addEventListener('click', () => {
                const id = parseInt(card.dataset.id);
                const student = students.find(s => s.id === id);
                if (student) selectStudent(student);
            });
        });
    } catch (error) {
        console.error('Load students error:', error);
        document.getElementById('student-list-container').innerHTML = '<p>Error loading students.</p>';
    }
}

function selectStudent(student) {
    selectedStudent = student;
    if (pendingAction === 'notify') {
        showNotifyOptions(student);
        return;
    }
    showScreen('results-screen');
    if (pendingAction === 'save') performSave();
    else if (pendingAction === 'notify') performNotifyWithChannels(['sms', 'email']);
    pendingAction = null;
}

function showNotifyOptions(student) {
    document.getElementById('notify-student-name').textContent = student.name;
    const smsCheck = document.getElementById('notify-channel-sms');
    const emailCheck = document.getElementById('notify-channel-email');
    smsCheck.checked = !!(student.phone && student.phone.trim() !== '');
    emailCheck.checked = !!(student.email && student.email.trim() !== '');
    smsCheck.disabled = !smsCheck.checked;
    emailCheck.disabled = !emailCheck.checked;
    if (!smsCheck.checked) smsCheck.parentElement.style.opacity = '0.5';
    else smsCheck.parentElement.style.opacity = '1';
    if (!emailCheck.checked) emailCheck.parentElement.style.opacity = '0.5';
    else emailCheck.parentElement.style.opacity = '1';
    showScreen('notify-options-screen');
}

// ---------- PERFORM SAVE ----------
async function performSave() {
    if (!selectedStudent) {
        alert('No student selected.');
        return;
    }
    if (!lastResult || !lastResult.scanToken) {
        alert('No valid scan result to save. Please scan again.');
        return;
    }

    try {
        const payload = {
            name: selectedStudent.name,
            phone: selectedStudent.phone || null,
            scanToken: lastResult.scanToken,
            image: capturedImage
        };
        console.log('📤 Sending save request with payload:', { name: payload.name, phone: payload.phone, scanToken: payload.scanToken ? payload.scanToken.substring(0, 10) + '…' : null, imageSize: payload.image ? payload.image.length : 0 });

        const response = await fetch('/api/save-scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        console.log('📥 Response status:', response.status, response.statusText);
        const responseText = await response.text();
        console.log('📥 Response body:', responseText);

        let data;
        try {
            data = JSON.parse(responseText);
        } catch (e) {
            throw new Error(`Server returned invalid JSON: ${responseText.substring(0, 100)}`);
        }

        if (!response.ok) {
            throw new Error(data.error || `Server error (${response.status})`);
        }

        alert(`✅ Scan saved for ${selectedStudent.name}!`);
        selectedStudent = null;
        pendingAction = null;
        showScreen('camera-screen');
    } catch (error) {
        console.error('❌ Save error:', error);
        alert('❌ Error saving scan: ' + error.message);
    }
}

// ---------- PERFORM NOTIFY WITH CHANNELS ----------
async function performNotifyWithChannels(channels) {
    if (!selectedStudent) {
        alert('No student selected.');
        return;
    }
    const hasPhone = selectedStudent.phone && selectedStudent.phone.trim() !== '';
    const hasEmail = selectedStudent.email && selectedStudent.email.trim() !== '';
    if (channels.includes('sms') && !hasPhone) {
        alert('SMS requested but student has no phone number.');
        return;
    }
    if (channels.includes('email') && !hasEmail) {
        alert('Email requested but student has no email address.');
        return;
    }

    const btn = document.getElementById('send-notification-btn');
    const originalText = btn.textContent;
    btn.textContent = 'Sending...';
    btn.disabled = true;

    try {
        const response = await fetch('/api/send-sms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                studentId: selectedStudent.id,
                condition: lastResult.condition || lastResult.name,
                advice: lastResult.advice,
                severity: lastResult.severity,
                channels: channels
            })
        });
        const data = await response.json();

        if (response.ok && data.pending) {
            // Only guests get this
            alert(`📨 Sent to admin for approval. ${selectedStudent.name}'s parent will be notified via ${channels.join(' and ')} once approved.`);
            pollSmsRequestStatus(data.requestId, selectedStudent.name);
        } else if (response.ok) {
            // Teachers/admins – immediate success
            alert(`✅ Notification sent via ${channels.join(' and ')} to ${selectedStudent.name}'s parent!`);
        } else {
            alert(`❌ Failed: ${data.error}`);
        }
    } catch (error) {
        console.error('Notification error:', error);
        alert('Error sending notification.');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
        selectedStudent = null;
        pendingAction = null;
        showScreen('results-screen');
    }
}

// ---------- POLL SMS APPROVAL STATUS ----------
function pollSmsRequestStatus(requestId, studentName) {
    const maxAttempts = 40;
    let attempts = 0;

    async function check() {
        attempts++;
        try {
            const res = await fetch(`/api/sms-requests/${requestId}/status`);
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'approved') {
                    alert(`✅ Admin approved it — notification sent to ${studentName}'s parent.`);
                    return;
                }
                if (data.status === 'rejected') {
                    alert(`❌ An admin rejected the request for ${studentName}.`);
                    return;
                }
                if (data.status === 'failed') {
                    alert(`⚠️ Admin approved, but sending failed for ${studentName}.`);
                    return;
                }
            }
        } catch (e) {
            console.warn('Status check failed:', e);
        }

        if (attempts >= maxAttempts) {
            console.warn(`Gave up polling request #${requestId} after ${attempts} attempts.`);
            return;
        }
        setTimeout(check, 7500);
    }

    check();
}

// ---------- AUTO-SAVE SCAN ----------
async function autoSaveScan(result) {
    if (!result.scanToken) {
        console.warn('Skipping auto-save: no scanToken (offline/demo fallback result).');
        return;
    }
    const payload = {
        name: selectedStudent ? selectedStudent.name : 'Auto-saved (Unknown)',
        phone: selectedStudent ? selectedStudent.phone : null,
        scanToken: result.scanToken,
        image: capturedImage
    };
    try {
        const response = await fetch('/api/save-scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (response.ok) {
            console.log('✅ Auto-saved scan');
            const notify = document.createElement('div');
            notify.textContent = 'Scan auto-saved to records.';
            notify.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#4ADE80;color:#000;padding:10px 20px;border-radius:8px;font-family:sans-serif;z-index:9999;font-weight:bold;';
            document.body.appendChild(notify);
            setTimeout(() => notify.remove(), 3000);
        } else {
            const text = await response.text();
            console.warn('Auto-save failed:', response.status, text);
        }
    } catch (e) {
        console.warn('Auto-save error:', e);
    }
}

// ---------- ADD STUDENT ----------
document.getElementById('add-new-student-btn').addEventListener('click', () => {
    document.getElementById('new-student-firstname').value = '';
    document.getElementById('new-student-lastname').value = '';
    document.getElementById('new-student-phone').value = '';
    document.getElementById('new-student-email').value = '';
    showScreen('add-student-screen');
});

document.getElementById('confirm-add-student-btn').addEventListener('click', async () => {
    const firstName = document.getElementById('new-student-firstname').value.trim();
    const lastName = document.getElementById('new-student-lastname').value.trim();
    const phone = document.getElementById('new-student-phone').value.trim();
    const email = document.getElementById('new-student-email').value.trim();

    if (!firstName || !lastName) {
        alert('Please enter both first name and last name.');
        return;
    }

    if (!isValidNamePart(firstName)) {
        alert('First name can only contain letters, spaces, hyphens, apostrophes, and dots. Must be at least 2 characters and contain a vowel. No numbers or gibberish.');
        return;
    }

    if (!isValidNamePart(lastName)) {
        alert('Last name can only contain letters, spaces, hyphens, apostrophes, and dots. Must be at least 2 characters and contain a vowel. No numbers or gibberish.');
        return;
    }

    if (phone && !isValidPhone(phone)) {
        alert('Phone number can only contain digits and the plus sign (+). No letters or special characters allowed.');
        return;
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        alert('Please enter a valid email address.');
        return;
    }

    const fullName = firstName + ' ' + lastName;

    try {
        const response = await fetch('/api/students', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: fullName, phone: phone || null, email: email || null })
        });
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Failed to add student');
        }
        const newStudent = await response.json();
        alert(`Student ${fullName} added!`);
        selectStudent(newStudent);
    } catch (error) {
        console.error('Add student error:', error);
        alert('Error adding student: ' + error.message);
    }
});

document.getElementById('cancel-add-student-btn').addEventListener('click', () => {
    showScreen('student-select-screen');
});

document.getElementById('cancel-student-select-btn').addEventListener('click', () => {
    pendingAction = null;
    selectedStudent = null;
    showScreen('results-screen');
});

document.getElementById('student-search').addEventListener('input', (e) => {
    loadStudents(e.target.value);
});

// ---------- NOTIFICATION OPTIONS EVENTS ----------
document.getElementById('send-notification-btn').addEventListener('click', () => {
    const smsChecked = document.getElementById('notify-channel-sms').checked;
    const emailChecked = document.getElementById('notify-channel-email').checked;
    const channels = [];
    if (smsChecked) channels.push('sms');
    if (emailChecked) channels.push('email');
    if (channels.length === 0) {
        alert('Please select at least one notification channel.');
        return;
    }
    if (channels.includes('sms') && (!selectedStudent.phone || selectedStudent.phone.trim() === '')) {
        alert('SMS selected but no phone number is available for this student.');
        return;
    }
    if (channels.includes('email') && (!selectedStudent.email || selectedStudent.email.trim() === '')) {
        alert('Email selected but no email address is available for this student.');
        return;
    }
    performNotifyWithChannels(channels);
});

document.getElementById('cancel-notify-btn').addEventListener('click', () => {
    pendingAction = null;
    selectedStudent = null;
    showScreen('results-screen');
});

// ---------- CAMERA ----------
async function startCamera(facingMode = 'environment') {
    if (videoStream) videoStream.getTracks().forEach(track => track.stop());
    try {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facingMode } } });
        const video = document.getElementById('video');
        video.srcObject = videoStream;
        video.classList.add('active');
        document.getElementById('canvas').classList.remove('active');
        document.getElementById('camera-placeholder').style.display = 'none';
        currentFacingMode = facingMode;
        if (torchEnabled) {
            setTimeout(async () => {
                const [track] = videoStream.getVideoTracks();
                if (track) {
                    try {
                        await track.applyConstraints({ advanced: [{ torch: true }] });
                    } catch (e) {
                        console.warn('Torch re-enable failed');
                        torchEnabled = false;
                        document.getElementById('flash-btn').textContent = '🔦 Flash';
                    }
                }
            }, 500);
        }
    } catch (err) {
        console.warn('Camera error:', err);
        alert('Camera access denied. Use upload button.');
    }
}

document.getElementById('switch-camera-btn').addEventListener('click', async () => {
    const newMode = currentFacingMode === 'environment' ? 'user' : 'environment';
    await startCamera(newMode);
});

document.getElementById('flash-btn').addEventListener('click', async () => {
    if (!videoStream) return alert('Camera not started.');
    const [track] = videoStream.getVideoTracks();
    if (!track) return;
    try {
        const capabilities = track.getCapabilities?.();
        if (!capabilities || !capabilities.torch) {
            alert('Flashlight not supported on this device.');
            return;
        }
        torchEnabled = !torchEnabled;
        await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
        document.getElementById('flash-btn').textContent = torchEnabled ? '🔦 Flash ON' : '🔦 Flash';
    } catch (err) {
        console.error('Torch error:', err);
        alert('Could not toggle flashlight.');
        torchEnabled = false;
        document.getElementById('flash-btn').textContent = '🔦 Flash';
    }
});

document.getElementById('capture-btn').addEventListener('click', () => {
    const video = document.getElementById('video');
    const canvas = document.getElementById('canvas');
    if (!video.srcObject) return alert('Camera not started.');
    if (video.videoWidth === 0 || video.videoHeight === 0) {
        alert('Camera not ready yet. Please wait a moment.');
        return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.classList.add('active');
    video.classList.remove('active');
    capturedImage = canvas.toDataURL('image/jpeg', 0.9);
    console.log('Captured image length:', capturedImage.length);
    analyzeImage();
});

document.getElementById('upload-btn').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                capturedImage = event.target.result;
                analyzeImage();
            };
            reader.readAsDataURL(file);
        }
    };
    input.click();
});

// ---------- DRAW BOUNDING BOXES ----------
function drawBoundingBoxes(img, bboxes, imgSize) {
    let canvas = document.getElementById('bbox-canvas');
    if (canvas) canvas.remove();

    if (!bboxes || bboxes.length === 0) return;

    canvas = document.createElement('canvas');
    canvas.id = 'bbox-canvas';
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.pointerEvents = 'none';
    const container = img.parentElement;
    container.style.position = 'relative';
    container.appendChild(canvas);

    canvas.width = img.width;
    canvas.height = img.height;
    canvas.style.width = `${img.width}px`;
    canvas.style.height = `${img.height}px`;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'red';
    ctx.lineWidth = 3;

    const scaleX = img.width / imgSize.width;
    const scaleY = img.height / imgSize.height;

    for (const box of bboxes) {
        const topLeftX = box.x - (box.width / 2);
        const topLeftY = box.y - (box.height / 2);
        const x = topLeftX * scaleX;
        const y = topLeftY * scaleY;
        const w = box.width * scaleX;
        const h = box.height * scaleY;
        ctx.strokeRect(x, y, w, h);
    }
}

// ---------- RESIZE IMAGE ----------
function resizeImage(dataUrl, maxWidth, maxHeight) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let width = img.width, height = img.height;
            if (width > height) {
                if (width > maxWidth) {
                    height *= maxWidth / width;
                    width = maxWidth;
                }
            } else {
                if (height > maxHeight) {
                    width *= maxHeight / height;
                    height = maxHeight;
                }
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.9));
        };
        img.src = dataUrl;
    });
}

// ---------- AI ANALYSIS ----------
async function analyzeImage() {
    if (!capturedImage) return;
    showLoading();
    try {
        const resizedImage = await resizeImage(capturedImage, 800, 800);
        const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: resizedImage })
        });
        if (!response.ok) throw new Error('Backend error');
        const data = await response.json();
        const aiText = data.choices[0].message.content;
        console.log('Raw AI response:', aiText);

        let cleanedText = aiText.trim();
        if (cleanedText.startsWith('```json')) {
            cleanedText = cleanedText.replace(/```json\n?/, '').replace(/\n?```$/, '');
        } else if (cleanedText.startsWith('```')) {
            cleanedText = cleanedText.replace(/```\n?/, '').replace(/\n?```$/, '');
        }
        const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
        if (jsonMatch) cleanedText = jsonMatch[0];

        let aiResult;
        try {
            aiResult = JSON.parse(cleanedText);
        } catch (e) {
            console.warn('Invalid JSON, fallback');
            hideLoading();
            useFallback();
            return;
        }
        if (!allowedConditions.some(c => c.toLowerCase() === aiResult.condition.toLowerCase())) {
            console.warn('Invalid condition, fallback');
            hideLoading();
            useFallback();
            return;
        }
        hideLoading();
        displayResults(aiResult);
    } catch (error) {
        console.error('AI failed:', error);
        hideLoading();
        alert('AI service unavailable. Using fallback.');
        useFallback();
    }
}

function useFallback() {
    const randomIndex = Math.floor(Math.random() * conditions.length);
    displayResults(conditions[randomIndex]);
}

// ---------- DISPLAY RESULTS (with auto-save only for guests) ----------
function displayResults(result) {
    lastResult = result;
    const img = document.getElementById('result-image');
    img.src = capturedImage;
    const oldCanvas = document.getElementById('bbox-canvas');
    if (oldCanvas) oldCanvas.remove();

    img.onload = () => {
        if (result.bboxes && result.bboxes.length > 0 && result.imageSize && result.imageSize.width) {
            drawBoundingBoxes(img, result.bboxes, result.imageSize);
        }
    };

    const conditionElem = document.getElementById('condition-name');
    if (conditionElem) conditionElem.textContent = result.condition || result.name || 'Unknown';

    const badge = document.getElementById('severity-badge');
    if (result.condition === 'No issue detected') {
        badge.className = 'badge green';
        badge.textContent = '✅ No skin issue detected';
    } else {
        badge.className = `badge ${result.severity.toLowerCase()}`;
        badge.textContent = result.severity === 'Green' ? '✅ GREEN – Minor' :
                            result.severity === 'Yellow' ? '⚠️ YELLOW – Observe' : '🔴 RED – Serious';
    }

    document.getElementById('advice-box').textContent = result.advice;
    document.getElementById('firstaid-text').textContent = result.firstAid;

    const confidenceElem = document.getElementById('confidence-text');
    if (confidenceElem) {
        if (result.confidence !== undefined && result.confidence !== null) {
            confidenceElem.textContent = `🤖 AI Confidence: ${(result.confidence * 100).toFixed(0)}%`;
        } else {
            confidenceElem.textContent = '';
        }
    }

    if (result.audioUrl) {
        const oldAudio = document.getElementById('skinguard-audio');
        if (oldAudio) oldAudio.remove();
        const audio = new Audio(result.audioUrl);
        audio.id = 'skinguard-audio';
        audio.play().catch(e => console.log('Audio play failed:', e));
    }

    // ─── AUTO‑SAVE ONLY FOR GUESTS ───
    if (result.condition && result.condition !== 'No issue detected' && isGuest) {
        autoSaveScan(result);
    }

    showScreen('results-screen');
}

// ---------- SAVE & NOTIFY ----------
document.getElementById('save-history-btn').addEventListener('click', () => {
    if (!lastResult) return alert('No result to save.');
    pendingAction = 'save';
    showScreen('student-select-screen');
    loadStudents();
});

document.getElementById('notify-parent-btn').addEventListener('click', () => {
    if (!lastResult) {
        alert('No analysis result to notify about.');
        return;
    }
    pendingAction = 'notify';
    showScreen('student-select-screen');
    loadStudents();
});

document.getElementById('scan-again-btn').addEventListener('click', async () => {
    const audio = document.getElementById('skinguard-audio');
    if (audio) {
        audio.pause();
        audio.currentTime = 0;
    }
    capturedImage = null;
    lastResult = null;
    await startCamera(currentFacingMode);
    showScreen('camera-screen');
});

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

window.addEventListener('load', async () => {
    await checkLoginStatus();
    if (!isGuest && !isTeacher) {
        // login overlay is shown
    } else {
        startCamera('environment');
    }
});

window.addEventListener('beforeunload', () => {
    if (videoStream) videoStream.getTracks().forEach(track => track.stop());
});

// ---------- HOSPITAL FINDER ----------
let hospitalMap;
let hospitalMarkers = [];

function initHospitalMap() {
    ensureMapboxLoaded(() => {
        mapboxgl.accessToken = MAPBOX_TOKEN;
        hospitalMap = new mapboxgl.Map({
            container: 'hospital-map',
            style: 'mapbox://styles/mapbox/streets-v12',
            center: [SCHOOL_LNG, SCHOOL_LAT],
            zoom: 14
        });
        hospitalMap.addControl(new mapboxgl.NavigationControl());
    });
}

function displayHospitalsOnMap(hospitals, userLat, userLng) {
    const listContainer = document.getElementById('hospital-list');
    console.log(`📋 Displaying ${hospitals.length} hospitals on map`);

    hospitalMarkers.forEach(marker => marker.remove());
    hospitalMarkers = [];

    if (!hospitals || hospitals.length === 0) {
        listContainer.innerHTML = '<p>🏥 No hospitals found.</p>';
        return;
    }

    if (userLat && userLng) {
        try {
            const userMarker = new mapboxgl.Marker({ color: '#4285F4' })
                .setLngLat([userLng, userLat])
                .setPopup(new mapboxgl.Popup().setHTML('<strong>📍 Your location</strong>'))
                .addTo(hospitalMap);
            hospitalMarkers.push(userMarker);
        } catch (e) { console.warn('User marker error:', e); }
    }

    let listHtml = '';
    hospitals.forEach((h) => {
        const hospitalName = h.name || 'Medical Facility';
        const hospitalAddress = h.address || 'Address not available';

        const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lon}`;

        try {
            const popupHTML = `
                <strong>${escapeHtml(hospitalName)}</strong><br>
                ${escapeHtml(hospitalAddress)}<br>
                <a href="${directionsUrl}" target="_blank">📍 Get Directions</a>
            `;
            const marker = new mapboxgl.Marker({ color: '#FF0000' })
                .setLngLat([h.lon, h.lat])
                .setPopup(new mapboxgl.Popup().setHTML(popupHTML))
                .addTo(hospitalMap);
            hospitalMarkers.push(marker);
        } catch (e) { console.warn('Marker error:', hospitalName, e); }

        listHtml += `
            <div class="hospital-item" onclick="window.open('${directionsUrl}', '_blank')" style="background:#f8fafd; border-radius:16px; padding:12px; margin-bottom:10px; cursor:pointer; border-left:4px solid #C41230;">
                <strong>${escapeHtml(hospitalName)}</strong><br>
                <span style="font-size:12px; color:#6b7f99;">${escapeHtml(hospitalAddress)}</span><br>
                <span style="font-size:11px; color:#C41230;">📱 Tap for directions</span>
            </div>
        `;
    });

    listContainer.innerHTML = listHtml;
    listContainer.style.display = 'block';
    console.log(`✅ List updated with ${hospitals.length} hospitals`);

    try {
        const bounds = new mapboxgl.LngLatBounds();
        if (userLat && userLng) bounds.extend([userLng, userLat]);
        hospitals.forEach(h => bounds.extend([h.lon, h.lat]));
        hospitalMap.fitBounds(bounds, { padding: 50, maxZoom: 16 });
    } catch (e) { console.warn('Fit bounds error:', e); }
}

document.getElementById('find-hospital-btn').addEventListener('click', () => {
    showScreen('hospital-screen');
    if (!hospitalMap) initHospitalMap();

    const hospitals = SANTIAGO_HOSPITALS;
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                displayHospitalsOnMap(hospitals, position.coords.latitude, position.coords.longitude);
            },
            (error) => {
                console.warn('Geolocation error, using school location for user:', error);
                displayHospitalsOnMap(hospitals, SCHOOL_LAT, SCHOOL_LNG);
            }
        );
    } else {
        displayHospitalsOnMap(hospitals, SCHOOL_LAT, SCHOOL_LNG);
    }
});

document.getElementById('refresh-hospitals-btn').addEventListener('click', () => {
    const hospitals = SANTIAGO_HOSPITALS;
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                displayHospitalsOnMap(hospitals, position.coords.latitude, position.coords.longitude);
            },
            () => {
                displayHospitalsOnMap(hospitals, SCHOOL_LAT, SCHOOL_LNG);
            }
        );
    } else {
        displayHospitalsOnMap(hospitals, SCHOOL_LAT, SCHOOL_LNG);
    }
});

document.getElementById('back-from-hospital-btn').addEventListener('click', () => {
    showScreen('results-screen');
});