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
const EYE_BOX_WIDTH_SCALE = 1.5;
const EYE_BOX_HEIGHT_SCALE = 0.75;

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
        const predictions = data.predictions || [];
        const imageSize = data.imageSize;

        if (predictions.length === 0) {
            console.log('👀 No eyes detected – no redaction needed.');
            return imageDataUrl;
        }

        console.log(`👀 Detected ${predictions.length} eye(s), redacting...`);

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

        // Compute each detected eye's (shrunk) box, then merge them into one
        // bounding box so the redaction is a single continuous bar across
        // both eyes rather than two separate patches.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pred of predictions) {
            const boxWidth = pred.width * EYE_BOX_WIDTH_SCALE * scaleX;
            const boxHeight = pred.height * EYE_BOX_HEIGHT_SCALE * scaleY;
            const x = (pred.x * scaleX) - boxWidth / 2;
            const y = (pred.y * scaleY) - boxHeight / 2;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + boxWidth);
            maxY = Math.max(maxY, y + boxHeight);
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
