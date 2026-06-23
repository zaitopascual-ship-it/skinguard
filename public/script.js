let capturedImage = null;
let videoStream = null;
let currentFacingMode = 'environment';
let lastResult = null;
let torchEnabled = false;
let pendingAction = null;          // 'save' or 'notify'
let selectedStudent = null;        // current selected student object

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
    'Bug bite', 'Rash', 'Chickenpox', 'Sunburn', 'Lice',
    'Eczema', 'Ringworm', 'Hives', 'Impetigo', 'Cold sore',
    'Scabies', 'Molluscum', 'Warts', 'Heat rash', 'No issue detected'
];

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
            html += `
                <div class="student-card" data-id="${s.id}" style="background:#f8fafd; border-radius:16px; padding:12px; margin-bottom:10px; cursor:pointer;">
                    <strong>${escapeHtml(s.name)}</strong><br>
                    <span style="font-size:12px; color:#6b7f99;">${s.phone || 'No phone'}</span>
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
    showScreen('results-screen');
    if (pendingAction) {
        if (pendingAction === 'save') performSave();
        else if (pendingAction === 'notify') performNotify();
        pendingAction = null;
    }
}

// ---------- PERFORM SAVE ----------
async function performSave() {
    if (!selectedStudent) {
        alert('No student selected.');
        return;
    }
    const payload = {
        name: selectedStudent.name,
        phone: selectedStudent.phone || null,
        condition: lastResult.condition || lastResult.name,
        severity: lastResult.severity,
        advice: lastResult.advice,
        firstAid: lastResult.firstAid,
        image: capturedImage
    };
    console.log('performSave: sending image, length:', capturedImage ? capturedImage.length : 0);
    try {
        const response = await fetch('/api/save-scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error('Failed to save');
        alert(`Scan saved for ${selectedStudent.name}!`);
        selectedStudent = null;
        showScreen('camera-screen');
    } catch (error) {
        console.error('Save error:', error);
        alert('Error saving scan.');
    }
}

// ---------- PERFORM NOTIFY ----------
async function performNotify() {
    if (!selectedStudent) {
        alert('No student selected.');
        return;
    }
    const parentPhone = selectedStudent.phone;
    if (!parentPhone) {
        alert('No phone number saved for this student. Please add a phone number.');
        return;
    }
    const formattedPhone = formatPhoneNumber(parentPhone);
    if (!formattedPhone) {
        alert('Invalid phone number format.');
        return;
    }

    const btn = document.getElementById('notify-parent-btn');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = 'SENDING…';
    btn.disabled = true;

    try {
        const response = await fetch('/api/send-sms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to: formattedPhone,
                studentName: selectedStudent.name,
                condition: lastResult.condition || lastResult.name,
                advice: lastResult.advice,
                severity: lastResult.severity
            })
        });
        const data = await response.json();
        if (response.ok) {
            alert(`✅ SMS sent to ${selectedStudent.name}'s parent!`);
        } else {
            alert(`❌ Failed: ${data.error}`);
        }
    } catch (error) {
        console.error('SMS error:', error);
        alert('Error sending SMS.');
    } finally {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        selectedStudent = null;
        showScreen('results-screen');
    }
}

// ---------- ADD STUDENT ----------
document.getElementById('add-new-student-btn').addEventListener('click', () => {
    document.getElementById('new-student-name').value = '';
    document.getElementById('new-student-phone').value = '';
    showScreen('add-student-screen');
});

document.getElementById('confirm-add-student-btn').addEventListener('click', async () => {
    const name = document.getElementById('new-student-name').value.trim();
    const phone = document.getElementById('new-student-phone').value.trim();
    if (!name) {
        alert('Please enter a name.');
        return;
    }
    try {
        const response = await fetch('/api/students', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, phone: phone || null })
        });
        if (!response.ok) throw new Error('Failed to add student');
        const newStudent = await response.json();
        alert(`Student ${name} added!`);
        selectStudent(newStudent);
    } catch (error) {
        console.error('Add student error:', error);
        alert('Error adding student.');
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
                        document.getElementById('flash-btn').classList.remove('flash-on');
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
        document.getElementById('flash-btn').classList.toggle('flash-on', torchEnabled);
    } catch (err) {
        console.error('Torch error:', err);
        alert('Could not toggle flashlight.');
        torchEnabled = false;
        document.getElementById('flash-btn').classList.remove('flash-on');
    }
});

// Capture photo – with video dimension check
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

// ---------- DRAW MULTIPLE BOUNDING BOXES ----------
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

// ---------- RESIZE IMAGE HELPER ----------
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
        // Resize to avoid 400 errors from Roboflow
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
            console.log('AI generated advice:', aiResult.advice);
            console.log('AI generated first aid:', aiResult.firstAid);
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

function displayResults(result) {
    lastResult = result;
    const img = document.getElementById('result-image');
    img.src = capturedImage;
    // Remove old bounding box canvas
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

    // ---------- AUDIO PLAYBACK (with unique filename and cleanup) ----------
    if (result.audioUrl) {
        // Remove any previous audio element to force fresh load
        const oldAudio = document.getElementById('skinguard-audio');
        if (oldAudio) oldAudio.remove();
        const audio = new Audio(result.audioUrl);
        audio.id = 'skinguard-audio';
        audio.play().catch(e => console.log('Audio play failed:', e));
    }

    showScreen('results-screen');
}

// ---------- SAVE & NOTIFY (using student selection) ----------
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

// ---------- SCAN AGAIN ----------
document.getElementById('scan-again-btn').addEventListener('click', async () => {
    // Stop any playing audio
    const audio = document.getElementById('skinguard-audio');
    if (audio) {
        audio.pause();
        audio.currentTime = 0;
        console.log('🔇 Audio stopped');
    }
    
    capturedImage = null;
    lastResult = null;
    await startCamera(currentFacingMode);
    showScreen('camera-screen');
});
// ---------- UTILITIES ----------
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// ---------- INIT ----------
window.addEventListener('load', () => startCamera('environment'));
window.addEventListener('beforeunload', () => {
    if (videoStream) videoStream.getTracks().forEach(track => track.stop());
});

// ---------- HOSPITAL FINDER ----------
let hospitalMap;
let hospitalMarkers = [];
let userLocationMarker;

async function findNearbyHospitals(lat, lng) {
    const loadingElement = document.getElementById('hospital-list');
    loadingElement.innerHTML = '<p>Searching for nearby hospitals...</p>';
    
    try {
        const response = await fetch('/api/hospitals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng, radius: 5000 })
        });
        
        if (!response.ok) throw new Error('Backend error');
        
        const data = await response.json();
        const hospitals = data.hospitals;
        
        displayHospitalsOnMap(hospitals, lat, lng);
        
    } catch (error) {
        console.error('Hospital search error:', error);
        loadingElement.innerHTML = '<p>Error finding hospitals. Please try again.</p>';
    }
}

function displayHospitalsOnMap(hospitals, userLat, userLng) {
    const listContainer = document.getElementById('hospital-list');
    
    if (hospitals.length === 0) {
        listContainer.innerHTML = '<p>No hospitals found within 5km.</p>';
        return;
    }
    
    hospitalMarkers.forEach(marker => hospitalMap.removeLayer(marker));
    hospitalMarkers = [];
    
    hospitals.forEach(hospital => {
        const marker = L.marker([hospital.lat, hospital.lon]).addTo(hospitalMap);
        marker.bindPopup(`
            <strong>${escapeHtml(hospital.name)}</strong><br>
            ${escapeHtml(hospital.address) || 'Address not available'}<br>
            <a href="https://www.openstreetmap.org/directions?engine=graphhopper_foot&route=${userLat},${userLng}/${hospital.lat},${hospital.lon}" target="_blank">📍 Get Directions</a>
        `);
        hospitalMarkers.push(marker);
    });
    
    let listHtml = '';
    hospitals.forEach(hospital => {
        listHtml += `
            <div class="hospital-item" style="background:#f8fafd; border-radius:16px; padding:12px; margin-bottom:10px; cursor:pointer;" onclick="window.open('https://www.openstreetmap.org/directions?engine=graphhopper_foot&route=${userLat},${userLng}/${hospital.lat},${hospital.lon}', '_blank')">
                <strong>${escapeHtml(hospital.name)}</strong><br>
                <span style="font-size:12px; color:#6b7f99;">${escapeHtml(hospital.address) || 'Address not available'}</span><br>
                <a href="https://www.openstreetmap.org/directions?engine=graphhopper_foot&route=${userLat},${userLng}/${hospital.lat},${hospital.lon}" target="_blank" style="font-size:12px;">📱 Get Directions</a>
            </div>
        `;
    });
    listContainer.innerHTML = listHtml;
    
    const bounds = L.latLngBounds(hospitals.map(h => [h.lat, h.lon]));
    bounds.extend([userLat, userLng]);
    hospitalMap.fitBounds(bounds, { padding: [50, 50] });
}

function initHospitalMap() {
    const defaultLat = 14.5995;
    const defaultLng = 120.9842;
    
    hospitalMap = L.map('hospital-map').setView([defaultLat, defaultLng], 13);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(hospitalMap);
}

document.getElementById('find-hospital-btn').addEventListener('click', () => {
    showScreen('hospital-screen');
    
    if (!hospitalMap) {
        initHospitalMap();
    }
    
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const userLat = position.coords.latitude;
                const userLng = position.coords.longitude;
                
                hospitalMap.setView([userLat, userLng], 14);
                
                if (userLocationMarker) {
                    hospitalMap.removeLayer(userLocationMarker);
                }
                userLocationMarker = L.marker([userLat, userLng], {
                    icon: L.divIcon({
                        className: 'user-location-marker',
                        html: '📍',
                        iconSize: [20, 20]
                    })
                }).addTo(hospitalMap);
                userLocationMarker.bindPopup('Your location').openPopup();
                
                findNearbyHospitals(userLat, userLng);
            },
            (error) => {
                console.error('Geolocation error:', error);
                document.getElementById('hospital-list').innerHTML = '<p>Unable to get your location. Please enable location access.</p>';
                findNearbyHospitals(14.5995, 120.9842);
            }
        );
    } else {
        document.getElementById('hospital-list').innerHTML = '<p>Geolocation not supported by your browser.</p>';
        findNearbyHospitals(14.5995, 120.9842);
    }
});

document.getElementById('refresh-hospitals-btn').addEventListener('click', () => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                findNearbyHospitals(position.coords.latitude, position.coords.longitude);
            },
            () => {
                findNearbyHospitals(14.5995, 120.9842);
            }
        );
    } else {
        findNearbyHospitals(14.5995, 120.9842);
    }
});

document.getElementById('back-from-hospital-btn').addEventListener('click', () => {
    showScreen('results-screen');
});

// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => {
                console.log('Service Worker registered successfully');
            })
            .catch(err => {
                console.log('Service Worker registration failed:', err);
            });
    });
}