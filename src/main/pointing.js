'use strict';

// Smarter pointing: the model's coordinates are often a little off (it
// guesses from a scaled screenshot). Snap toward the UI element under the
// guess - the edge mass of a button, icon or label nearby - so the smoke
// finger lands on the thing instead of next to it. Cheap: looks only at a
// small window around the point.

// img: { data (BGRA or RGBA bytes), width, height }. Returns { x, y }.
function refinePoint(img, x, y, { radius = 40, maxMove = 0.6 } = {}) {
  const { data, width: W, height: H } = img;
  const cx = Math.round(x);
  const cy = Math.round(y);
  if (!data || cx < 0 || cy < 0 || cx >= W || cy >= H) return { x, y };
  const x0 = Math.max(1, cx - radius);
  const x1 = Math.min(W - 2, cx + radius);
  const y0 = Math.max(1, cy - radius);
  const y1 = Math.min(H - 2, cy + radius);
  const lum = (px, py) => {
    const i = (py * W + px) * 4;
    return data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
  };
  const mags = [];
  let maxMag = 0;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const m = Math.abs(lum(px + 1, py) - lum(px - 1, py)) + Math.abs(lum(px, py + 1) - lum(px, py - 1));
      if (m > 8) { mags.push(px, py, m); if (m > maxMag) maxMag = m; }
    }
  }
  const thr = Math.max(24, maxMag * 0.35);
  const sigma = radius / 2;
  let sw = 0; let sx = 0; let sy = 0; let count = 0;
  for (let i = 0; i < mags.length; i += 3) {
    if (mags[i + 2] < thr) continue;
    const dx = mags[i] - cx;
    const dy = mags[i + 1] - cy;
    const w = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    sw += w; sx += w * mags[i]; sy += w * mags[i + 1]; count++;
  }
  if (count < 12 || sw <= 0) return { x, y }; // nothing there: trust the model
  let tx = sx / sw - x;
  let ty = sy / sw - y;
  const d = Math.hypot(tx, ty);
  const lim = radius * maxMove;
  if (d > lim) { tx *= lim / d; ty *= lim / d; }
  return { x: Math.round(x + tx), y: Math.round(y + ty) };
}

module.exports = { refinePoint };
