// Dark mode and pictures: a white diagram glares on a dark page, so line art (diagrams, charts,
// text pages, tables) is shown inverted — dark background, light lines, colours kept — while
// photos (and screenshots with photos in them) are only dimmed; inverting them would make negatives.

/**
 * 'line' for line art: mostly paper-white, with sharp marks or flat colour areas (diagrams,
 * charts, tables, text pages). 'photo' when it has many textured in-between tones (photos, and
 * screenshots with photos in them).
 * @param {Uint8ClampedArray} data  RGBA pixels
 * @param {number} width  pixels per row
 */
export function classifyPixels(data, width) {
  let light = 0;
  let mid = 0;
  let textured = 0;
  const n = data.length / 4;
  if (!n) return 'photo';
  const lum = (i) => (data[i + 3] < 16 ? 255 : data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114); // transparent = background
  for (let i = 0, x = 0; i < data.length; i += 4, x = (x + 1) % width) {
    const l = lum(i);
    if (l >= 215) light++;
    else if (l >= 100) {
      mid++;
      // A flat colour (a chart bar) has equal neighbours; a photo's tones change pixel to pixel.
      if (x < width - 1 && Math.abs(lum(i + 4) - l) > 6) textured++;
    }
  }
  if (light / n >= 0.85 && mid / n <= 0.1) return 'line';
  return light / n >= 0.6 && textured / n <= 0.05 ? 'line' : 'photo';
}

/** Classify a loaded <img> or a <canvas> (sampled at up to ~400 px). */
export function classifyElement(el) {
  const w = el.naturalWidth || el.width;
  const h = el.naturalHeight || el.height;
  if (!w || !h) return 'photo';
  const k = Math.min(1, 400 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(el, 0, 0, c.width, c.height);
  return classifyPixels(ctx.getImageData(0, 0, c.width, c.height).data, c.width);
}
