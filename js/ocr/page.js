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
  // The running text's size (by amount of text): lines within ±14% of it are running text too
  // (headings are bigger than that, footnotes and captions smaller).
  const weighted = lines.map(({ words }, li) => [rawFs[li], words.reduce((n, w) => n + w.text.length, 0)]).filter(([, n]) => n >= 20).sort((x, y) => x[0] - y[0]);
  let acc = 0;
  const half = weighted.reduce((n, [, c]) => n + c, 0) / 2;
  const bodyRaw = weighted.find(([, c]) => (acc += c) >= half)?.[0];
  const groupOf = (v) => { const g = sizes.find((x) => v >= x.min && v <= x.min * 1.1); return g ? g.list[g.list.length >> 1] : v; };
  const bodyFs = bodyRaw ? groupOf(bodyRaw) : 0;
  const snap = (v) => (bodyFs && Math.abs(v - bodyFs) <= 0.14 * bodyFs ? bodyFs : groupOf(v));

  // Stroke thickness per word, relative to the (snapped) text size → bold. Thickness doesn't depend
  // on which letters a word has, unlike ink density (capitals, short words).
  const dens = [];
  lines.forEach(({ words }, li) => {
    const px = snap(rawFs[li]) * scale;
    for (const w of words) { w._ink = raster.stroke(w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1) / px; dens.push(w._ink); }
  });
  dens.sort((a, b) => a - b);
  const medInk = dens[dens.length >> 1] || 0.1;

  // Figures with text in them (screenshots, diagrams, maps): one picture, not OCR'd scraps.
  const allWordBoxes = lines.flatMap((l) => l.words.map((w) => w.bbox));
  const pics = raster.pictures(allWordBoxes, 50 * scale, 35 * scale);
  const figs = findFigures(lines.map(({ line, words }, li) => {
    const chars = words.reduce((n, w) => n + w.text.length, 0);
    let gap = 0; // widest space between words, in text heights (labels of a diagram sit far apart)
    for (let k = 1; k < words.length; k++) gap = Math.max(gap, (words[k].bbox.x0 - words[k - 1].bbox.x1) / (snap(rawFs[li]) * scale));
    return {
      ...line.bbox, fs: snap(rawFs[li]), chars, gap, text: words.map((w) => w.text).join(' '),
      conf: words.reduce((n, w) => n + w.confidence * w.text.length, 0) / Math.max(1, chars),
      boxed: !!inBox(line.bbox),
    };
  }), pics, raster, scale);
  const inFig = (b) => { const cx = (b.x0 + b.x1) / 2; const cy = (b.y0 + b.y1) / 2; return figs.some((f) => cx >= f.x0 && cx <= f.x1 && cy >= f.y0 && cy <= f.y1); };
  if (globalThis.process?.env?.DBG_LINES) {
    for (const [li, { line, words }] of lines.entries()) {
      const conf = words.reduce((n, w) => n + w.confidence, 0) / words.length;
      console.log(`${inFig(line.bbox) ? 'F' : ' '} ${pt(line.bbox.x0).toFixed(0).padStart(4)} ${pt(line.bbox.y0).toFixed(0).padStart(4)} ${pt(line.bbox.x1).toFixed(0).padStart(4)} ${pt(line.bbox.y1).toFixed(0).padStart(4)} fs ${snap(rawFs[li]).toFixed(1).padStart(4)} conf ${conf.toFixed(0).padStart(3)} | ${words.map((w) => w.text).join(' ').slice(0, 70)}`);
    }
    console.log('figures', figs.map((f) => [pt(f.x0), pt(f.y0), pt(f.x1), pt(f.y1)].map(Math.round)));
  }

  const items = [];
  for (const [li, { line, words }] of lines.entries()) {
    if (inFig(line.bbox)) continue;
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
    if (!mono && text.length >= 3 && !/^[\d\s|.-]+$/.test(text) && !BULLET_LIKE.test(words[0].text.trim()) && dot > 0.12 && dot < 0.6
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
    ...raster.hRules.filter((r) => !onBoxEdge(r, true) && !inFig({ x0: r.x0, x1: r.x1, y0: r.y, y1: r.y })).map((r) => ({ kind: 'h', x0: pt(r.x0), x1: pt(r.x1), y: pt(r.y) })),
    ...raster.vRules.filter((r) => !onBoxEdge(r, false) && !inFig({ x0: r.x, x1: r.x, y0: r.y0, y1: r.y1 })).map((r) => ({ kind: 'v', y0: pt(r.y0), y1: pt(r.y1), x: pt(r.x) })),
  ];
  const tables = ocrTables(frags, raster, scale).filter((t) => !inFig({ x0: t.x0 * scale, x1: t.x1 * scale, y0: t.y0 * scale, y1: t.y1 * scale }));
  // Rules that belong to a detected table are used up.
  const inTable = (sg) => tables.some((t) => (sg.kind === 'h' ? sg.y : (sg.y0 + sg.y1) / 2) >= t.y0 - 2 && (sg.kind === 'h' ? sg.y : (sg.y0 + sg.y1) / 2) <= t.y1 + 2
    && (sg.kind === 'v' ? sg.x : (sg.x0 + sg.x1) / 2) >= t.x0 - 2 && (sg.kind === 'v' ? sg.x : (sg.x0 + sg.x1) / 2) <= t.x1 + 2);
  const images = [...figs, ...pics.filter((r) => !inFig(r))].map((r) => ({ x0: pt(r.x0), y0: pt(r.y0), x1: pt(r.x1), y1: pt(r.y1) }));
  return { w: pageW, h: pageH, frags, gutter: frags.gutter, gutterInfo: frags.gutterInfo, segments: segments.filter((sg) => !inTable(sg)), shapes: [], images, tables, ocr: true };
}

// "Figure 1.1: …", "Fig. 3", "איור 2" — not "Table" (tables are rebuilt as text) or "Listing" (code).
const FIG_CAPTION = /^(fig(ure)?|chart|diagram|illustration|image|exhibit|plate|איור)\.?\s*[\dIVX]+([.\-–:]\d+)*\s*([:.\-—–]|$|\s)/i;

/**
 * Areas that are pictures even though OCR found "text" in them: screenshots, diagrams, maps,
 * charts. Two signs: a "Figure N" caption (everything between it and the running text above —
 * or below — is the figure), and pictures with small or unreadable (low-confidence) text around
 * them. Returns boxes in pixels; text inside them is dropped.
 * @param L     lines: {x0, y0, x1, y1 (px), fs (pt), conf, chars, gap, text, boxed}
 * @param pics  picture boxes found in the raster (px)
 */
function findFigures(L, pics, raster, scale) {
  const prose = L.filter((l) => l.conf >= 80 && l.chars >= 20);
  if (prose.length < 2) return [];
  // The running text: its size, margins and width.
  const bySize = prose.map((l) => [l.fs, l.chars]).sort((a, b) => a[0] - b[0]);
  let acc = 0;
  const half = bySize.reduce((n, [, c]) => n + c, 0) / 2;
  const bodyFs = bySize.find(([, c]) => (acc += c) >= half)[0];
  const sameSize = (l) => Math.abs(l.fs - bodyFs) <= 0.2 * bodyFs;
  const body = prose.filter(sameSize);
  if (!body.length) return [];
  const lefts = body.map((l) => l.x0).sort((a, b) => a - b);
  const rights = body.map((l) => l.x1).sort((a, b) => a - b);
  const bodyLeft = lefts[lefts.length >> 1];
  const bodyRight = rights[Math.floor(rights.length * 0.9)];
  const colW = Math.max(1, bodyRight - bodyLeft);
  const fsPx = bodyFs * scale;
  const atMargin = (l) => Math.abs(l.x0 - bodyLeft) < 2.5 * fsPx;
  const isCaption = (l) => l.conf >= 60 && FIG_CAPTION.test(l.text.trim());
  const sorted = [...L].sort((a, b) => a.y0 - b.y0);
  for (const l of sorted) l.body = l.conf >= 75 && sameSize(l) && atMargin(l) && l.gap < 2.5 && (l.x1 - l.x0 >= 0.6 * colW || l.chars >= 40);
  // The short last line of a paragraph is running text too.
  for (const l of sorted) {
    if (!l.body && l.conf >= 75 && sameSize(l) && atMargin(l) && l.gap < 2.5) l.body = sorted.some((p) => p.body && p !== l && l.y0 - p.y1 > -0.4 * fsPx && l.y0 - p.y1 < 0.9 * fsPx);
  }
  for (const l of sorted) {
    l.heading = !l.body && l.conf >= 80 && l.fs >= 1.15 * bodyFs && atMargin(l);
    l.code = l.boxed && l.conf >= 80 && l.fs >= 0.75 * bodyFs; // a code box is text, not a figure (small labels on a shaded map are)
  }
  for (const l of sorted) {
    // Lines starting at the same place as others of their size: a list or code (paths and code
    // are hard to OCR, so low confidence alone doesn't make them part of a picture).
    const aligned = sorted.filter((o) => o !== l && Math.abs(o.x0 - l.x0) < 0.6 * fsPx && Math.abs(o.fs - l.fs) <= 0.15 * l.fs).length >= 2;
    // Text that is probably part of a picture: much smaller than the running text, or unreadable.
    l.loose = !l.body && !l.heading && !l.boxed && !isCaption(l)
      && (l.fs < 0.85 * bodyFs || (l.conf < 75 && !aligned) || l.conf < 30);
  }
  const H = raster.H;
  const margin = 0.06 * H; // running header / footer zone
  const xa = Math.max(0, bodyLeft - 3 * fsPx);
  const xb = Math.min(raster.W, bodyRight + 3 * fsPx);
  const figs = [];
  const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const overlap = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

  // 1. A "Figure N" caption: the figure is between it and the running text (above it, else below).
  for (const c of sorted.filter(isCaption)) {
    const stops = (e) => e.body || e.heading || e.code || isCaption(e);
    const band = (up) => {
      const els = up ? sorted.filter((l) => l !== c && l.y1 <= c.y0 + 0.3 * fsPx).reverse() : sorted.filter((l) => l !== c && l.y0 >= c.y1 - 0.3 * fsPx);
      const stop = els.find(stops);
      const y0 = up ? (stop ? stop.y1 + 0.15 * fsPx : margin) : c.y1 + 0.15 * fsPx;
      const y1 = up ? c.y0 - 0.15 * fsPx : (stop ? stop.y0 - 0.15 * fsPx : H - margin);
      if (y1 - y0 < 2.5 * fsPx) return null;
      return raster.inkBox(xa, y0, xb, y1);
    };
    const box = band(true) || band(false);
    if (box && box.y1 - box.y0 >= 2 * fsPx && box.x1 - box.x0 >= 0.15 * colW) figs.push(box);
  }

  // 2. Pictures pull in the small / unreadable text around them (and nearby pictures). Text with
  // no picture near it stays text, however badly it was read.
  const d = 1.5 * fsPx;
  const near = (a, b) => a.x0 - d < b.x1 && b.x0 - d < a.x1 && a.y0 - d < b.y1 && b.y0 - d < a.y1;
  const loose = sorted.filter((l) => l.loose);
  for (const seed of pics.map((p) => ({ ...p, text: 0 }))) {
    const r = { ...seed };
    for (let grew = true; grew;) {
      grew = false;
      for (const l of loose) {
        if (l.used || !near(r, l)) continue;
        l.used = true; r.text++; grew = true;
        r.x0 = Math.min(r.x0, l.x0); r.y0 = Math.min(r.y0, l.y0); r.x1 = Math.max(r.x1, l.x1); r.y1 = Math.max(r.y1, l.y1);
      }
      for (const p of pics) {
        if (p === seed || (p.x0 >= r.x0 && p.x1 <= r.x1 && p.y0 >= r.y0 && p.y1 <= r.y1) || !near(r, p)) continue;
        r.x0 = Math.min(r.x0, p.x0); r.y0 = Math.min(r.y0, p.y0); r.x1 = Math.max(r.x1, p.x1); r.y1 = Math.max(r.y1, p.y1); grew = true;
      }
    }
    if (r.text >= 2) figs.push(raster.inkBox(r.x0 - 0.5 * fsPx, r.y0 - 0.5 * fsPx, r.x1 + 0.5 * fsPx, r.y1 + 0.5 * fsPx) || r);
  }

  // Overlapping boxes become one figure.
  const out = [];
  for (const f of figs.sort((a, b) => area(b) - area(a))) {
    const m = out.find((o) => overlap(o, f) > 0.1 * Math.min(area(o), area(f)));
    if (m) { m.x0 = Math.min(m.x0, f.x0); m.y0 = Math.min(m.y0, f.y0); m.x1 = Math.max(m.x1, f.x1); m.y1 = Math.max(m.y1, f.y1); } else out.push({ x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 });
  }
  // Running text never ends up inside a figure: trim a figure that reached into it.
  return out.filter((f) => !sorted.some((l) => (l.body || l.heading) && overlap(l, f) > 0.5 * area(l)));
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
