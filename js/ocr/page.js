// OCR result (Tesseract blocks → paragraphs → lines → words, in pixels) + pixel analysis
// → the same page description analyzePage() builds from a real PDF text layer. From there the
// normal pipeline (columns, paragraphs, headings, code, tables, headers/footers) takes over.

import { buildFragments } from '../pdf/analyze.js';

const NOISE = /^[^\p{L}\p{N}]{1,2}$/u;
// What OCR makes of a bullet dot.
const BULLET_LIKE = /^[•·●○◦▪■+*«»©°¢®e]$/;
const HEB = /[֐-׿؀-ۿ]/;

/**
 * @param {object} data    Tesseract result data (with `blocks`)
 * @param {object} raster  analyzeRaster() output for the same picture
 * @param {number} scale   picture pixels per PDF point
 * @param {number} pageW   page size in points
 * @param {number} pageH
 */
export function ocrPage(data, raster, scale, pageW, pageH) {
  const pt = (v) => v / scale;
  const lines = [];
  for (const block of data.blocks || []) {
    for (const par of block.paragraphs || []) {
      for (const line of par.lines || []) {
        const words = (line.words || []).filter((w) => w.text && w.text.trim() && !(w.confidence < 25 && NOISE.test(w.text.trim())));
        if (words.length) lines.push({ line, words });
      }
    }
  }

  // A designed page (cover, poster) is mostly ink: keep it as a picture.
  if (raster.darkRatio > 0.4) {
    return { w: pageW, h: pageH, frags: [], segments: [], shapes: [], images: [{ x0: 0, y0: 0, x1: pageW, y1: pageH }], poster: true, ocrText: lines.map((l) => l.words.map((w) => w.text).join(' ')).join('\n') };
  }

  const inBox = (b) => raster.boxes.find((x) => (b.x0 + b.x1) / 2 >= x.x0 && (b.x0 + b.x1) / 2 <= x.x1 && (b.y0 + b.y1) / 2 >= x.y0 && (b.y0 + b.y1) / 2 <= x.y1);
  const spread = (words) => {
    const per = words.filter((w) => w.text.length >= 3).map((w) => (w.bbox.x1 - w.bbox.x0) / w.text.length);
    if (per.length < 2) return null;
    const m = per.reduce((s, v) => s + v, 0) / per.length;
    return Math.sqrt(per.reduce((s, v) => s + (v - m) ** 2, 0) / per.length) / m;
  };

  // Per-character width spread per line → monospace (see spread). OCR's size estimate wobbles from line to line: snap sizes to the page's common sizes.
  const rawFs = lines.map(({ line }) => pt(line.rowAttributes?.rowHeight || (line.bbox.y1 - line.bbox.y0)));
  const sizes = [];
  for (const v of [...rawFs].sort((a, b) => a - b)) {
    const g = sizes[sizes.length - 1];
    if (g && v <= g.min * 1.1) { g.list.push(v); } else sizes.push({ min: v, list: [v] });
  }
  const snap = (v) => { const g = sizes.find((x) => v >= x.min && v <= x.min * 1.1); return g ? g.list[g.list.length >> 1] : v; };

  // Stroke thickness per word, relative to the (snapped) text size → bold. Thickness doesn't depend
  // on which letters a word has, unlike ink density (capitals, short words).
  const dens = [];
  lines.forEach(({ words }, li) => {
    const px = snap(rawFs[li]) * scale;
    for (const w of words) { w._ink = raster.stroke(w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1) / px; dens.push(w._ink); }
  });
  dens.sort((a, b) => a - b);
  const medInk = dens[dens.length >> 1] || 0.1;

  const items = [];
  for (const [li, { line, words }] of lines.entries()) {
    const fs = snap(rawFs[li]);
    const bl = line.baseline || { x0: line.bbox.x0, y0: line.bbox.y1, x1: line.bbox.x1, y1: line.bbox.y1 };
    const baseAt = (x) => (bl.x1 === bl.x0 ? bl.y0 : bl.y0 + ((bl.y1 - bl.y0) * (x - bl.x0)) / (bl.x1 - bl.x0));
    const box = inBox(line.bbox);
    const cv = spread(words);
    const text = words.map((w) => w.text).join(' ');
    // Code: text on a shaded box with even letter widths (call-outs like "NOTE: …" are not code).
    const mono = !!box && !/^(note|warning|tip|important|caution)\b/i.test(text) && (cv == null || cv < 0.25);
    // A small dot just left of the line that OCR didn't read is a bullet.
    const h = line.bbox.y1 - line.bbox.y0;
    const ym = (line.bbox.y0 + line.bbox.y1) / 2;
    const x0 = words[0].bbox.x0;
    // (A dot, then white paper before the text — not a dark bar or a table border.)
    let dot = 0; // densest small window in the gutter (bullets sit 0.4–2 line heights before the text)
    for (let a = 0.35; a <= 1.75; a += 0.1) dot = Math.max(dot, raster.inkIn(x0 - (a + 0.45) * h, ym - 0.3 * h, x0 - a * h, ym + 0.3 * h));
    if (!mono && !BULLET_LIKE.test(words[0].text.trim()) && dot > 0.12 && dot < 0.6
      && raster.inkIn(x0 - 0.3 * h, ym - 0.45 * h, x0 - 0.05 * h, ym + 0.45 * h) < 0.03
      && raster.inkIn(x0 - 2.2 * h, ym - 1.3 * h, x0 - 0.35 * h, ym - 0.6 * h) < 0.03 // not a bar running down the side
      && raster.inkIn(x0 - 2.2 * h, ym + 0.6 * h, x0 - 0.35 * h, ym + 1.3 * h) < 0.03
      && raster.inkIn(x0 - 4 * h, ym - 0.3 * h, x0 - 2.3 * h, ym + 0.3 * h) < 0.02) {
      words.unshift({ text: '•', confidence: 90, bbox: { x0: x0 - 1.2 * h, x1: x0 - 0.6 * h, y0: ym - 0.2 * h, y1: ym + 0.2 * h }, _ink: medInk });
    }
    // "+ C:\Windows\Temp" / "e Run winPEAS": a lone mark before the text is a bullet.
    if (!mono && words.length > 1 && BULLET_LIKE.test(words[0].text.trim()) && (words[0].text.trim() !== 'e' || words[0].confidence < 80)
      && words[1].bbox.x0 - words[0].bbox.x1 > 0.4 * (words[0].bbox.y1 - words[0].bbox.y0)) words[0].text = '•';
    for (const w of words) {
      const cx = (w.bbox.x0 + w.bbox.x1) / 2;
      const y = pt(baseAt(cx));
      const s = w.text.trim();
      // OCR boxes hug the ink; monospace words get their full advance so code columns line up.
      const x1 = mono && s.length >= 2 ? w.bbox.x0 + (w.bbox.x1 - w.bbox.x0) * (s.length / (s.length - 0.4)) : w.bbox.x1;
      items.push({
        s, x0: pt(w.bbox.x0), x1: pt(x1), y, fs,
        top: y - fs * 0.85, bottom: y + fs * 0.2,
        // Bold = clearly more ink than typical text (per word, so "NOTE:" doesn't make the line bold).
        b: !mono && w._ink > medInk * 1.3, i: false, m: mono, font: mono ? 'ocr-mono' : 'ocr', dir: HEB.test(s) ? 'rtl' : 'ltr', space: false, word: true,
      });
    }
  }
  const frags = buildFragments(items);

  // Lines on the edge of a shaded box are its frame, not table rules.
  const onBoxEdge = (r, horizontal) => raster.boxes.some((b) => (horizontal
    ? (Math.abs(r.y - b.y0) < 6 || Math.abs(r.y - b.y1) < 6) && r.x0 >= b.x0 - 8 && r.x1 <= b.x1 + 8
    : (Math.abs(r.x - b.x0) < 6 || Math.abs(r.x - b.x1) < 6) && r.y0 >= b.y0 - 8 && r.y1 <= b.y1 + 8));
  const segments = [
    ...raster.hRules.filter((r) => !onBoxEdge(r, true)).map((r) => ({ kind: 'h', x0: pt(r.x0), x1: pt(r.x1), y: pt(r.y) })),
    ...raster.vRules.filter((r) => !onBoxEdge(r, false)).map((r) => ({ kind: 'v', y0: pt(r.y0), y1: pt(r.y1), x: pt(r.x) })),
  ];
  const tables = ocrTables(frags, raster, scale);
  // Rules that belong to a detected table are used up.
  const inTable = (sg) => tables.some((t) => (sg.kind === 'h' ? sg.y : (sg.y0 + sg.y1) / 2) >= t.y0 - 2 && (sg.kind === 'h' ? sg.y : (sg.y0 + sg.y1) / 2) <= t.y1 + 2
    && (sg.kind === 'v' ? sg.x : (sg.x0 + sg.x1) / 2) >= t.x0 - 2 && (sg.kind === 'v' ? sg.x : (sg.x0 + sg.x1) / 2) <= t.x1 + 2);
  const wordBoxes = lines.flatMap((l) => l.words.map((w) => w.bbox));
  const images = raster.pictures(wordBoxes, 50 * scale, 35 * scale).map((r) => ({ x0: pt(r.x0), y0: pt(r.y0), x1: pt(r.x1), y1: pt(r.y1) }));
  return { w: pageW, h: pageH, frags, gutter: frags.gutter, gutterInfo: frags.gutterInfo, segments: segments.filter((sg) => !inTable(sg)), shapes: [], images, tables, ocr: true };
}

/**
 * Tables in a page picture: vertical column lines that run through the same rows (rows themselves
 * are often only zebra stripes, so they come from the text baselines).
 */
function ocrTables(frags, raster, scale) {
  const pt = (v) => v / scale;
  // Column lines: same x (pieces broken by stripes are joined), then grouped by the rows they span.
  const cols = [];
  for (const v of [...raster.vRules].sort((a, b) => a.x - b.x || a.y0 - b.y0)) {
    const c = cols.find((k) => Math.abs(k.x - v.x) < 4 && v.y0 - k.y1 < 25 && k.y0 - v.y1 < 25);
    if (c) { c.y0 = Math.min(c.y0, v.y0); c.y1 = Math.max(c.y1, v.y1); } else cols.push({ x: v.x, y0: v.y0, y1: v.y1 });
  }
  const groups = [];
  for (const c of cols.filter((k) => k.y1 - k.y0 > 30)) {
    const g = groups.find((G) => Math.min(G.y1, c.y1) - Math.max(G.y0, c.y0) > 0.6 * Math.min(G.y1 - G.y0, c.y1 - c.y0));
    if (g) { g.xs.push(c.x); g.y0 = Math.min(g.y0, c.y0); g.y1 = Math.max(g.y1, c.y1); } else groups.push({ xs: [c.x], y0: c.y0, y1: c.y1 });
  }
  const out = [];
  for (const g of groups) {
    let y0 = pt(g.y0);
    const y1 = pt(g.y1);
    const xs = [...new Set(g.xs.map((x) => Math.round(pt(x))))].sort((a, b) => a - b);
    // A dark header bar (white text, no lines drawn through it) sits right on top of the lines.
    let above = frags.filter((f) => f.bottom <= y0 + 2 && f.bottom > y0 - 2.2 * f.fs && f.x0 >= xs[0] - 40 && f.x1 <= xs[xs.length - 1] + 40);
    const lastBottom = Math.max(...above.map((f) => f.bottom));
    above = above.filter((f) => f.bottom > lastBottom - 0.5 * f.fs); // only the one row right above
    if (above.length >= 2) {
      const top = Math.min(...above.map((f) => f.top)) - 2;
      if (raster.darkness(xs[0] * scale, (top + 1) * scale, xs[xs.length - 1] * scale, (y0 - 1) * scale) > 0.45) y0 = top;
    }
    const inside = frags.filter((f) => (f.top + f.bottom) / 2 > y0 && (f.top + f.bottom) / 2 < y1 && f.x0 >= xs[0] - 40 && f.x1 <= xs[xs.length - 1] + 40);
    if (inside.length < 4) continue;
    // Column edges: the lines, plus the text's own left/right edge when the outer border is missing.
    const bounds = [...xs];
    const minX = Math.min(...inside.map((f) => f.x0));
    const maxX = Math.max(...inside.map((f) => f.x1));
    const em = inside[0].fs;
    if (minX < bounds[0] - 0.5 * em) bounds.unshift(minX - 1);
    if (maxX > bounds[bounds.length - 1] + 0.5 * em) bounds.push(maxX + 1);
    if (bounds.length < 3) continue; // need at least two columns
    const colOf = (f) => { const cx = (f.x0 + f.x1) / 2; for (let k = 0; k + 1 < bounds.length; k++) if (cx >= bounds[k] && cx <= bounds[k + 1]) return k; return -1; };
    // Rows from baselines; a line with an empty first cell continues the row above.
    const sorted = [...inside].sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const rows = [];
    for (const f of sorted) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(f.y - last.y) < 0.5 * f.fs) last.frags.push(f);
      else rows.push({ y: f.y, top: f.top, bottom: f.bottom, frags: [f] });
    }
    const ncol = bounds.length - 1;
    const table = [];
    for (const r of rows) {
      const cells = Array.from({ length: ncol }, () => []);
      r.frags.forEach((f) => { const c = colOf(f); if (c >= 0) cells[c].push(f); });
      const prev = table[table.length - 1];
      // Wrapped cell text: a tight line (no row spacing) with an empty first cell.
      if (prev && !cells[0].length && cells.some((c) => c.length) && r.y - prev.y < 1.35 * r.frags[0].fs) { cells.forEach((c, k) => prev.cells[k].push(...c)); prev.y = r.y; }
      else table.push({ cells, top: r.top, bottom: r.bottom, y: r.y });
    }
    // Columns that never hold text are not columns.
    const used = Array.from({ length: ncol }, (_, k) => table.some((r) => r.cells[k].length));
    table.forEach((r) => { r.cells = r.cells.filter((_, k) => used[k]); });
    if (table.length < 2 || table.filter((r) => r.cells.filter((c) => c.length).length >= 2).length < 2) continue;
    const txt = (c) => c.sort((a, b) => a.y - b.y || a.x0 - b.x0).map((f) => f.text).join(' ').replace(/\s+/g, ' ').trim();
    // A dark first row (white text on black) is the header.
    const h0 = table[0];
    const headDark = raster.darkness(bounds[0] * scale, h0.top * scale, bounds[bounds.length - 1] * scale, h0.bottom * scale) > 0.45;
    const rowsOut = table.map((r, i) => r.cells.map((c) => { const o = { s: txt(c) }; if ((i === 0 && headDark) || (c.length && c.every((f) => f.bold))) o.b = true; return o; }));
    out.push({ x0: bounds[0], y0, x1: bounds[bounds.length - 1], y1, rows: rowsOut, claims: inside });
  }
  return out;
}
