// Scans are often a little rotated. Even half a degree makes the end of one line sit at the height
// of the next one, so words get mixed between lines and table lines break into steps.
// estimateSkew finds the angle; the page is then rendered again turned straight (rotationTransform).

/**
 * Tilt of the text lines, in degrees (positive = lines go down to the right), or 0 if unsure.
 * Projection profile: at the right angle, dark pixels pile up into sharp rows (the text lines).
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img  RGBA
 */
export function estimateSkew(img) {
  const { data, width: W, height: H } = img;
  // Work on a ~700 px wide sample of dark pixels.
  const step = Math.max(1, Math.round(W / 700));
  const xs = [];
  const ys = [];
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const p = (y * W + x) * 4;
      if (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114 < 110) { xs.push(x / step); ys.push(y / step); }
    }
  }
  const n = xs.length;
  const w = W / step;
  const h = H / step;
  // Mostly-dark pages (covers, photos) have no lines to measure.
  if (n < 2000 || n > 0.25 * w * h) return 0;
  const bins = new Float64Array(Math.ceil(h + w * 0.06) + 4);
  const cx = w / 2;
  const score = (deg) => {
    const t = Math.tan((deg * Math.PI) / 180);
    bins.fill(0);
    const off = w * 0.03 + 2;
    for (let i = 0; i < n; i++) bins[Math.round(ys[i] - (xs[i] - cx) * t + off)]++;
    let s = 0;
    for (let i = 1; i < bins.length; i++) { const d = bins[i] - bins[i - 1]; s += d * d; }
    return s;
  };
  let best = 0;
  let bestS = score(0);
  const flat = bestS;
  for (let d = -3; d <= 3.001; d += 0.1) { const s = score(d); if (s > bestS) { bestS = s; best = d; } }
  for (let d = best - 0.09; d <= best + 0.09; d += 0.02) { const s = score(d); if (s > bestS) { bestS = s; best = d; } }
  // Only act on a clear, real tilt.
  if (Math.abs(best) < 0.15 || bestS < flat * 1.06) return 0;
  return Math.round(best * 100) / 100;
}

/**
 * pdf.js render transform that turns the page by -deg around its centre (straightens a tilt of deg).
 * Pass as page.render({ transform }); it applies before the viewport transform.
 */
export function rotationTransform(width, height, deg) {
  const a = (-deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const cx = width / 2;
  const cy = height / 2;
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}
