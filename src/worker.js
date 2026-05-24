/**
 * Post-processing worker. No model inference here.
 * Receives a grayscale mask PNG from the rembg server (om=true)
 * plus the original image blob, applies threshold / feather / morph,
 * composites according to outputMode, and returns the final PNG.
 */

// ---------------------------------------------------------------------------
// Morphological ops (separable max/min filter)
// ---------------------------------------------------------------------------

function morphOp(mask, width, height, morphSize) {
  if (morphSize === 0) return mask;
  const r = Math.abs(morphSize);
  const dilate = morphSize > 0;
  const combine = dilate ? Math.max : Math.min;
  const identity = dilate ? 0.0 : 1.0;

  const tmp = new Float32Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = identity;
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < width) v = combine(v, mask[y * width + nx]);
      }
      tmp[y * width + x] = v;
    }
  }

  const out = new Float32Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = identity;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny >= 0 && ny < height) v = combine(v, tmp[ny * width + x]);
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Separable box blur (sliding window, O(W·H) per pass)
// ---------------------------------------------------------------------------

function boxBlur(data, width, height, radius) {
  if (radius <= 0) return data;
  const r = Math.max(1, Math.round(radius));

  function pass(src, w, h, horiz) {
    const dst = new Float32Array(src.length);
    if (horiz) {
      for (let y = 0; y < h; y++) {
        let sum = 0, cnt = 0;
        for (let dx = 0; dx <= r && dx < w; dx++) { sum += src[y * w + dx]; cnt++; }
        for (let x = 0; x < w; x++) {
          dst[y * w + x] = sum / cnt;
          if (x - r >= 0) { sum -= src[y * w + (x - r)]; cnt--; }
          if (x + r + 1 < w) { sum += src[y * w + (x + r + 1)]; cnt++; }
        }
      }
    } else {
      for (let x = 0; x < w; x++) {
        let sum = 0, cnt = 0;
        for (let dy = 0; dy <= r && dy < h; dy++) { sum += src[dy * w + x]; cnt++; }
        for (let y = 0; y < h; y++) {
          dst[y * w + x] = sum / cnt;
          if (y - r >= 0) { sum -= src[(y - r) * w + x]; cnt--; }
          if (y + r + 1 < h) { sum += src[(y + r + 1) * w + x]; cnt++; }
        }
      }
    }
    return dst;
  }

  // Three passes ≈ Gaussian blur
  let res = data;
  for (let p = 0; p < 3; p++) {
    res = pass(res, width, height, true);
    res = pass(res, width, height, false);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Decode rembg mask blob → Float32Array (0-1 per pixel)
// rembg with om=true returns a grayscale PNG (R=G=B=mask, A=255)
// ---------------------------------------------------------------------------

async function decodeMask(maskBlob, targetW, targetH) {
  const bitmap = await createImageBitmap(maskBlob);
  const canvas = new OffscreenCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d');
  // Draw mask scaled to original image dimensions (handles any mismatch)
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, targetW, targetH);
  const mask = new Float32Array(targetW * targetH);
  for (let i = 0; i < mask.length; i++) mask[i] = data[4 * i] / 255; // R channel
  return mask;
}

// ---------------------------------------------------------------------------
// Full post-processing pipeline
// ---------------------------------------------------------------------------

async function applyPostProcess(maskFloat, imageBlob, width, height, settings) {
  const { threshold = 0.5, feather = 0, morphSize = 0, outputMode = 'transparent', bgColor = '#ffffff' } = settings;

  let mask = new Float32Array(maskFloat); // copy

  if (morphSize !== 0) mask = morphOp(mask, width, height, morphSize);
  for (let i = 0; i < mask.length; i++) { if (mask[i] < threshold) mask[i] = 0; }
  if (feather > 0) mask = boxBlur(mask, width, height, feather);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const srcBitmap = await createImageBitmap(imageBlob);

  if (outputMode === 'color') {
    const hex = (bgColor || '#ffffff').replace('#', '');
    const fill = ctx.createImageData(width, height);
    const rv = parseInt(hex.slice(0, 2), 16);
    const gv = parseInt(hex.slice(2, 4), 16);
    const bv = parseInt(hex.slice(4, 6), 16);
    for (let i = 0; i < width * height; i++) {
      fill.data[4 * i] = rv; fill.data[4 * i + 1] = gv;
      fill.data[4 * i + 2] = bv; fill.data[4 * i + 3] = 255;
    }
    ctx.putImageData(fill, 0, 0);
  } else if (outputMode === 'blur') {
    const pad = 28;
    ctx.filter = `blur(${pad}px)`;
    ctx.drawImage(srcBitmap, -pad, -pad, width + pad * 2, height + pad * 2);
    ctx.filter = 'none';
  }

  const fg = new OffscreenCanvas(width, height);
  const fgCtx = fg.getContext('2d');
  fgCtx.drawImage(srcBitmap, 0, 0);
  const pixels = fgCtx.getImageData(0, 0, width, height);
  for (let i = 0; i < mask.length; i++) pixels.data[4 * i + 3] = Math.round(mask[i] * 255);
  fgCtx.putImageData(pixels, 0, 0);
  ctx.drawImage(fg, 0, 0);

  srcBitmap.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (event) => {
  const { type, payload } = event.data;

  try {
    if (type === 'process') {
      // Initial processing: decode mask, apply post-process, store maskFloat
      const { id, maskBlob, imageBlob, width, height, settings } = payload;
      const maskFloat = await decodeMask(maskBlob, width, height);
      const resultBlob = await applyPostProcess(maskFloat, imageBlob, width, height, settings);
      self.postMessage({ stage: 'process-done', id, maskFloat, resultBlob });
    }

    if (type === 'reprocess') {
      // Slider change: re-apply post-process to already-decoded masks
      const { items, settings } = payload;
      for (const { id, maskFloat, imageBlob, width, height } of items) {
        const resultBlob = await applyPostProcess(maskFloat, imageBlob, width, height, settings);
        self.postMessage({ stage: 'reprocess-done', id, resultBlob });
      }
      self.postMessage({ stage: 'reprocess-batch-done' });
    }
  } catch (err) {
    self.postMessage({ stage: 'error', id: payload?.id, error: err?.message ?? String(err) });
  }
};
