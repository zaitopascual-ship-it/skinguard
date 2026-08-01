// ============================================================
//  EYE REDACTION (Roboflow eye-detection model, via server proxy)
//  ------------------------------------------------------------
//  This is intentionally separate from the skin-lesion detector
//  in script.js. It only knows how to find eyes in a photo and
//  black them out — it has no knowledge of skin conditions,
//  severity, or the /api/analyze pipeline.
//
//  Depends on csrfFetch() (defined in script.js), so load this
//  file AFTER script.js — see index.html.
// ============================================================

// Roboflow's raw detection box tends to be taller/wider than the eye itself
// (it often includes some brow/socket margin). Scale it down around the same
// center point so the black bar hugs the eye instead of covering a big block.
const EYE_BOX_WIDTH_SCALE = 0.7;
const EYE_BOX_HEIGHT_SCALE = 0.35;

async function redactEyesWithRoboflow(imageDataUrl) {
    try {
        // Call our server endpoint (which uses the API key securely)
        const response = await csrfFetch('/api/detect-eyes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imageDataUrl })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const rawPredictions = data.predictions || [];
        const imageSize = data.imageSize;

        // eye-fobsq/2 has 4 classes: Eye, Left_Eye, Rigth_Eye, and a stray "0"
        // class that isn't a real eye — drop it. Also drop low-confidence
        // detections so noise doesn't widen the merged box below.
        const MIN_CONFIDENCE = 0.4;
        const predictions = rawPredictions.filter(p =>
            p.class !== '0' && (p.confidence === undefined || p.confidence >= MIN_CONFIDENCE)
        );

        if (predictions.length === 0) {
            console.log('👀 No eyes detected – no redaction needed.');
            return imageDataUrl;
        }

        console.log(`👀 Detected ${predictions.length} eye box(es), redacting...`);

        // Load image onto canvas
        const img = new Image();
        img.src = imageDataUrl;
        await img.decode();

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // Roboflow's coordinates are relative to whatever size it reports back
        // in imageSize — not necessarily the exact pixel dimensions of the
        // image we uploaded. Scale into canvas space before drawing, or boxes
        // drift (especially on tall/portrait photos).
        const scaleX = imageSize && imageSize.width ? canvas.width / imageSize.width : 1;
        const scaleY = imageSize && imageSize.height ? canvas.height / imageSize.height : 1;

        // Compute each (shrunk) box's center + extent in canvas space
        const boxes = predictions.map(pred => {
            const w = pred.width * EYE_BOX_WIDTH_SCALE * scaleX;
            const h = pred.height * EYE_BOX_HEIGHT_SCALE * scaleY;
            const cx = pred.x * scaleX;
            const cy = pred.y * scaleY;
            return { cx, cy, x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
        });

        // The model can return more than one label for the same physical eye
        // (e.g. a generic "Eye" box overlapping a "Left_Eye" box). Collapse
        // boxes whose centers are close together into a single eye before
        // merging — otherwise one real eye could get treated as two and the
        // redaction would stretch further than what was actually detected.
        const eyes = [];
        for (const box of boxes) {
            const nearThreshold = Math.max(box.x2 - box.x1, box.y2 - box.y1);
            const match = eyes.find(e => Math.hypot(e.cx - box.cx, e.cy - box.cy) < nearThreshold);
            if (match) {
                match.x1 = Math.min(match.x1, box.x1);
                match.y1 = Math.min(match.y1, box.y1);
                match.x2 = Math.max(match.x2, box.x2);
                match.y2 = Math.max(match.y2, box.y2);
            } else {
                eyes.push({ ...box });
            }
        }

        console.log(`👁️ Resolved to ${eyes.length} distinct eye(s).`);

        // One eye detected → one box. Two eyes detected → merge into a single
        // bar spanning both, so it reads as one continuous redaction.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const eye of eyes) {
            minX = Math.min(minX, eye.x1);
            minY = Math.min(minY, eye.y1);
            maxX = Math.max(maxX, eye.x2);
            maxY = Math.max(maxY, eye.y2);
        }

        ctx.fillStyle = 'black';
        ctx.fillRect(minX, minY, maxX - minX, maxY - minY);

        const redacted = canvas.toDataURL('image/jpeg', 0.9);
        console.log('✅ Eye redaction complete.');
        return redacted;

    } catch (err) {
        console.warn('⚠️ Eye redaction failed, using original image:', err.message);
        return imageDataUrl;
    }
}
