// Per-page raw analysis: text fragments, raster image boxes, vector line segments and shapes.
// Pure geometry, no DOM, so it also runs under Node for tests.

// Own matrix helpers (pdf.js's Util API changes between versions).
const mul = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];
const apply = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

export const WORD_BREAK = '\uE000'; // private-use char: known word break inside letter-spaced text
const SPACE_GAP = 0.12; // gap (in em) that implies a space between two text items
const SPLIT_GAP = 1.0; // gap (in em) that splits a line into separate fragments (columns, table cells)

/**
 * @param {object} pdfjs   the pdf.js module (needs OPS)
 * @param {object} page    a PDFPageProxy
 */
export async function analyzePage(pdfjs, page) {
  const vp = page.getViewport({ scale: 1 });
  // Operator list first: it makes the worker send the font objects we read below.
  const opList = await page.getOperatorList();
  const tc = await page.getTextContent();
  const items = toItems(pdfjs, tc, vp, page);
  const frags = buildFragments(items);
  const gfx = walkOperators(pdfjs, opList, vp);
  return { w: vp.width, h: vp.height, frags, gutter: frags.gutter, gutterInfo: frags.gutterInfo, ...gfx };
}

function fontInfo(page, fontName) {
  let name = '';
  let bold = false;
  let italic = false;
  let mono = false;
  try {
    if (page.commonObjs.has(fontName)) {
      const f = page.commonObjs.get(fontName);
      name = f?.name || '';
      bold = !!(f?.bold || f?.black);
      italic = !!f?.italic;
      mono = !!f?.isMonospace;
    }
  } catch { /* font not loaded: fall back to name-less */ }
  name = name.replace(/^[A-Z]{6}\+/, ''); // drop the subset prefix (ABCDEF+FontName)
  if (/bold|black|heavy|semibold|demi/i.test(name)) bold = true;
  if (/italic|oblique/i.test(name)) italic = true;
  if (/mono|courier|consol|menlo|monaco|inconsolata|sourcecode|code|typewriter|fixed|cascadia|lucidaconsole|\btt\b|cmtt|letter ?gothic/i.test(name)) mono = true;
  return { name, bold, italic, mono };
}

function toItems(pdfjs, tc, vp, page) {
  const out = [];
  const fonts = new Map();
  for (const it of tc.items) {
    if (!('str' in it) || !it.str) continue;
    const tx = mul(vp.transform, it.transform);
    const fs = Math.hypot(tx[2], tx[3]);
    if (fs < 1) continue;
    // Skip rotated text (margin watermarks, vertical labels).
    if (Math.abs(tx[1]) > 0.1 * fs || Math.abs(tx[2]) > 0.1 * fs) continue;
    const x = tx[4];
    const y = tx[5];
    const w = it.width * vp.scale;
    let f = fonts.get(it.fontName);
    if (!f) { f = fontInfo(page, it.fontName); fonts.set(it.fontName, f); }
    const space = it.str.trim() === '';
    out.push({
      s: it.str, x0: x, x1: x + w, y, fs,
      top: y - fs * 0.85, bottom: y + fs * 0.2,
      b: f.bold, i: f.italic, m: f.mono, font: f.name, dir: it.dir, space,
    });
  }
  return out;
}

/** Group items into visual lines, find a column gutter, then split lines into fragments. */
export function buildFragments(items) {
  const solid = items.filter((i) => !i.space).sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const spaces = items.filter((i) => i.space);
  const lines = [];
  for (const it of solid) {
    const line = lines.length ? lines[lines.length - 1] : null;
    if (line) {
      const ov = Math.min(line.bottom, it.bottom) - Math.max(line.top, it.top);
      const minH = Math.min(line.bottom - line.top, it.bottom - it.top);
      if (ov > 0.5 * minH) {
        line.items.push(it);
        if (it.fs > line.fs) Object.assign(line, { fs: it.fs, top: it.top, bottom: it.bottom, y: it.y });
        continue;
      }
    }
    lines.push({ items: [it], fs: it.fs, top: it.top, bottom: it.bottom, y: it.y });
  }
  lines.forEach((l) => l.items.sort((a, b) => a.x0 - b.x0));
  const gutter = findGutter(lines);

  const frags = [];
  for (const line of lines) {
    const its = line.items;
    let cur = [its[0]];
    for (let k = 1; k < its.length; k++) {
      const prev = cur[cur.length - 1];
      const gap = its[k].x0 - prev.x1;
      const fs = Math.max(prev.fs, its[k].fs);
      const atGutter = gutter && gap > 0.25 * fs && prev.x1 <= gutter.x + 1 && its[k].x0 >= gutter.x - 1;
      if (gap > SPLIT_GAP * fs || atGutter) {
        frags.push(makeFragment(cur, line, spaces));
        cur = [];
      }
      cur.push(its[k]);
    }
    frags.push(makeFragment(cur, line, spaces));
  }
  frags.gutter = gutter?.x ?? null;
  frags.gutterInfo = gutter;
  return frags;
}

/**
 * Find a vertical gutter between two text columns: an x band in the middle of the page that
 * (almost) no text item crosses, while many lines have text on both sides of it.
 */
function findGutter(lines) {
  if (lines.length < 8) return null;
  const all = lines.flatMap((l) => l.items);
  const minX = Math.min(...all.map((i) => i.x0));
  const maxX = Math.max(...all.map((i) => i.x1));
  const cw = maxX - minX;
  if (cw < 200) return null;
  const covered = (x) => lines.reduce((n, l) => n + (l.items.some((i) => i.x0 < x - 0.5 && i.x1 > x + 0.5) ? 1 : 0), 0);
  const xs = [];
  for (let x = minX + 0.3 * cw; x <= minX + 0.7 * cw; x += 1) xs.push([x, covered(x)]);
  const min = Math.min(...xs.map((p) => p[1]));
  if (min > 0.25 * lines.length) return null;
  // "Low" allows a few crossers (a centred title or page number) inside the gutter band.
  const low = min + Math.max(1, Math.round(0.05 * lines.length));
  let run = null;
  let best = null;
  for (const [x, c] of xs) {
    if (c <= low) {
      if (run && x - run.b <= 1.01) run.b = x; else run = { a: x, b: x };
      if (!best || run.b - run.a > best.b - best.a) best = { ...run };
    } else run = null;
  }
  if (!best || best.b - best.a < 4) return null; // a river between words, not a gutter
  // Centre of the band, nudged to the x with the fewest crossers inside it.
  let x = (best.a + best.b) / 2;
  const inBand = xs.filter(([px]) => px >= best.a && px <= best.b);
  const fewest = Math.min(...inBand.map((p) => p[1]));
  const cand = inBand.filter((p) => p[1] === fewest).map((p) => p[0]);
  x = cand.reduce((p, q) => (Math.abs(q - x) < Math.abs(p - x) ? q : p), cand[0]);
  const band = { a: best.a, b: best.b };
  // Left/right baselines may not line up, so count each side separately.
  const left = lines.filter((l) => l.items.some((i) => i.x1 <= x)).length;
  const right = lines.filter((l) => l.items.some((i) => i.x0 >= x)).length;
  if (Math.min(left, right) < Math.max(4, 2 * min)) return null;
  return { x, band, cw, minX };
}

function makeFragment(its, _line, spaces) {
  const rtlChars = its.filter((i) => i.dir === 'rtl').reduce((s, i) => s + i.s.length, 0);
  const total = its.reduce((s, i) => s + i.s.length, 0);
  const rtl = rtlChars > total / 2;
  const ordered = rtl ? [...its].reverse() : its;
  if (its.every((i) => i.m)) return monoFragment(its);
  const runs = [];
  let text = '';
  for (let k = 0; k < ordered.length; k++) {
    const it = ordered[k];
    let s = it.s;
    if (k > 0) {
      const prev = ordered[k - 1];
      const gap = rtl ? prev.x0 - it.x1 : it.x0 - prev.x1;
      const between = spaces.some((sp) => sp.y === it.y && sp.x0 >= Math.min(prev.x1, it.x1) - 1 && sp.x0 <= Math.max(prev.x0, it.x0) + 1);
      const needSpace = (gap > SPACE_GAP * it.fs || between) && !/\s$/.test(text) && !/^\s/.test(s);
      // Between two letter-spaced pieces ("G E T T I N G" "S T A R T E D") the gap is a real word break:
      // mark it so the repair step (extract.js) can tell it from the spaces between letters.
      const tracked = (t) => /^(\S ){2,}\S$/.test(t.trim());
      if (needSpace) s = (tracked(prev.s) && tracked(it.s) ? WORD_BREAK : ' ') + s;
    }
    text += s;
    const last = runs[runs.length - 1];
    if (last && last.b === it.b && last.i === it.i && last.m === it.m) last.s += s;
    else runs.push({ s, b: it.b, i: it.i, m: it.m });
  }
  const x0 = Math.min(...its.map((i) => i.x0));
  const x1 = Math.max(...its.map((i) => i.x1));
  // Size/baseline from this fragment's own items (a line may also hold a bigger heading in the other column).
  const main = its.reduce((a, b) => (b.fs > a.fs ? b : a));
  const bodyItems = its.filter((i) => Math.abs(i.fs - main.fs) < 0.5);
  // Code (monospace) keeps its internal spacing; normal text gets single spaces.
  const mono = its.every((i) => i.m);
  return {
    x0, x1,
    y: main.y, top: main.top, bottom: main.bottom, fs: main.fs,
    text: mono ? text.replace(/\s+$/, '') : text.replace(/\s+/g, ' ').trim(),
    runs: runs.map((r) => ({ ...r, s: mono ? r.s : r.s.replace(/\s+/g, ' ') })),
    bold: bodyItems.every((i) => i.b),
    italic: bodyItems.every((i) => i.i),
    mono,
    font: main.font,
    rtl,
    chars: total,
  };
}

/** Monospace text: place each piece at its character column (exact spacing for code). */
function monoFragment(its) {
  const sized = its.filter((i) => i.s.trim().length >= 2);
  const cws = (sized.length ? sized : its).map((i) => (i.x1 - i.x0) / Math.max(1, i.s.trim().length)).sort((a, b) => a - b);
  const cw = cws[cws.length >> 1] || its[0].fs * 0.6;
  const x0 = Math.min(...its.map((i) => i.x0));
  let text = '';
  for (const it of its) {
    // pdf.js sometimes prefixes a "fake" space that has no width; the position is what counts.
    let str = it.s;
    const trimmed = str.replace(/^\s+/, '');
    if (trimmed !== str && Math.abs((it.x1 - it.x0) - trimmed.length * cw) < 0.5 * cw) str = trimmed;
    const col = Math.round((it.x0 - x0) / cw);
    if (col > text.length) text = text.padEnd(col);
    else if (it.word && text && !/\s$/.test(text)) text += ' '; // OCR words are always separate words
    text += str;
  }
  text = text.replace(/\s+$/, '');
  const main = its.reduce((a, b) => (b.fs > a.fs ? b : a));
  return {
    x0, x1: Math.max(...its.map((i) => i.x1)),
    y: main.y, top: main.top, bottom: main.bottom, fs: main.fs,
    text, runs: [{ s: text, b: false, i: false, m: true }],
    bold: false, italic: false, mono: true, font: main.font, rtl: false, chars: text.length,
  };
}

/**
 * Walk the operator list tracking the current transform. Collects:
 *  - images: boxes of painted raster images
 *  - segments: axis-aligned line segments (stroked lines, rect edges, hairline fills) -> table grids
 *  - shapes: boxes of other drawings (fills, curves, diagonals) -> vector figures
 */
export function walkOperators(pdfjs, opList, vp) {
  const { OPS } = pdfjs;
  const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectRepeat]);

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const images = [];
  const segments = [];
  const shapes = [];
  const toPage = (x, y) => { const p = apply(ctm, x, y); return apply(vp.transform, p[0], p[1]); };

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push(ctm); break;
      case OPS.restore: ctm = stack.pop() || ctm; break;
      case OPS.transform: ctm = mul(ctm, args); break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (args?.[0]) ctm = mul(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd: ctm = stack.pop() || ctm; break;
      case OPS.constructPath: {
        const [op, data] = args;
        const stroked = strokeOps.has(op);
        const filled = fillOps.has(op);
        if (!stroked && !filled) break; // endPath (clipping) etc.
        const path = data?.[0];
        if (!path || !path.length) break;
        collectPath(path, stroked, filled);
        break;
      }
      default:
        if (imageOps.has(fn)) {
          const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => toPage(x, y));
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          images.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), mask: fn === OPS.paintImageMaskXObject });
        }
    }
  }
  return { images, segments, shapes };

  function collectPath(path, stroked, filled) {
    const subpaths = [];
    let sp = null;
    let curves = false;
    for (let k = 0; k < path.length;) {
      const c = path[k++];
      if (c === DRAW.moveTo) { sp = { pts: [toPage(path[k++], path[k++])], closed: false }; subpaths.push(sp); }
      else if (c === DRAW.lineTo) { sp?.pts.push(toPage(path[k++], path[k++])); }
      else if (c === DRAW.curveTo) { curves = true; k += 4; sp?.pts.push(toPage(path[k++], path[k++])); }
      else if (c === DRAW.quadraticCurveTo) { curves = true; k += 2; sp?.pts.push(toPage(path[k++], path[k++])); }
      else if (c === DRAW.closePath) { if (sp) sp.closed = true; }
      else break; // unknown opcode: stop parsing this path
    }
    for (const s of subpaths) {
      const xs = s.pts.map((p) => p[0]);
      const ys = s.pts.map((p) => p[1]);
      const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      const isRect = !curves && s.pts.length >= 4 && s.pts.length <= 5 && isAxisRect(s.pts);
      if (isRect && filled && h < 2.5 && w > 3) { segments.push({ kind: 'h', x0: box.x0, x1: box.x1, y: (box.y0 + box.y1) / 2 }); continue; }
      if (isRect && filled && w < 2.5 && h > 3) { segments.push({ kind: 'v', y0: box.y0, y1: box.y1, x: (box.x0 + box.x1) / 2 }); continue; }
      let diagonal = false;
      if (stroked && !curves) {
        const pts = s.closed ? [...s.pts, s.pts[0]] : s.pts;
        for (let k = 1; k < pts.length; k++) {
          const [ax, ay] = pts[k - 1];
          const [bx, by] = pts[k];
          if (Math.abs(ay - by) < 1 && Math.abs(ax - bx) > 3) segments.push({ kind: 'h', x0: Math.min(ax, bx), x1: Math.max(ax, bx), y: (ay + by) / 2 });
          else if (Math.abs(ax - bx) < 1 && Math.abs(ay - by) > 3) segments.push({ kind: 'v', y0: Math.min(ay, by), y1: Math.max(ay, by), x: (ax + bx) / 2 });
          else if (Math.hypot(ax - bx, ay - by) > 3) diagonal = true;
        }
        if (!diagonal && !filled) continue; // pure axis-aligned strokes are fully described by segments
      }
      if (w < 1 && h < 1) continue;
      const poly = filled && !isRect && s.pts.length >= 3; // e.g. arrow heads
      shapes.push({ ...box, curves: curves || diagonal || poly, filled, members: 1 });
    }
  }
}

function isAxisRect(pts) {
  const p = pts.length === 5 ? pts.slice(0, 4) : pts;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = p[k];
    const [bx, by] = p[(k + 1) % 4];
    if (Math.abs(ax - bx) > 0.5 && Math.abs(ay - by) > 0.5) return false;
  }
  return true;
}
