// Reading order (columns) and block reconstruction: paragraphs, headings, lists, code listings,
// note boxes, and "line list" pages (tables of contents and indexes).

import { center, containsPoint, median } from './geometry.js';
import { fragBox } from './regions.js';

const BULLET = /^([•●○◦▪■►‣⁃–—*-]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])(\s|$)/;
const TERMINAL = /[.!?:;]["'”’»)\]]?$/;
/** A printed page reference: 12, xvii, 110–113 */
export const PAGE_REF = /^(\d{1,4}|[ivxlcdm]{1,8})(\s*[–-]\s*\d{1,4})?$/i;
/** An index line ends with page references: "botnets, 63, 70–71" */
const INDEX_LINE = /(^|[\s,])(\d{1,4}([–-]\d{1,4})?|[ivxlc]{1,7})(,\s*(\d{1,4}([–-]\d{1,4})?|[ivxlc]{1,7}))*\.?$/i;
/** Labels printed in the margin next to a note box. */
const LABEL = /^(note|notes|warning|tip|tips|caution|important|hint|danger|info|remember|example)$/i;
const despace = (s) => s.replace(/\s+/g, '');

/** Group fragments into visual lines (same baseline), top to bottom, each sorted left to right. */
function linesOf(frags) {
  const sorted = [...frags].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines = [];
  for (const f of sorted) {
    const ln = lines[lines.length - 1];
    if (ln && Math.abs(f.y - ln.y) < 0.35 * Math.max(f.fs, ln.fs)) { ln.frags.push(f); ln.fs = Math.max(ln.fs, f.fs); }
    else lines.push({ y: f.y, fs: f.fs, frags: [f] });
  }
  lines.forEach((l) => l.frags.sort((a, b) => a.x0 - b.x0));
  return lines;
}

/** Contents line: title … right-aligned page number in its own fragment. */
function isRefLine(line) {
  const n = line.frags.length;
  if (n < 2) return false;
  const last = line.frags[n - 1];
  return PAGE_REF.test(last.text) && last.x0 - line.frags[n - 2].x1 > 1.5 * line.fs;
}

/** 'toc' (contents), 'index', or 'text'. */
function classifyPage(frags) {
  const lines = linesOf(frags);
  if (lines.length < 4) return 'text';
  const ref = lines.filter(isRefLine).length;
  if (ref >= 4 && ref >= 0.35 * lines.length) return 'toc';
  const idx = lines.filter((l) => l.frags.some((f) => f.text.length > 2 && INDEX_LINE.test(f.text))).length;
  if (lines.length >= 8 && idx >= 0.45 * lines.length) return 'index';
  return 'text';
}

/**
 * Order a page's text fragments and regions for reading.
 * @returns {object[]} elements, each {type:'frag'|'region', col, ...}; the array also gets `.kind`.
 */
export function orderPage(page, frags, regions) {
  // Regions claim the text inside them (table cells, labels drawn on pictures).
  const claimed = new Set();
  for (const r of regions) {
    const own = r.claims || frags.filter((f) => containsPoint(r, ...center(fragBox(f)), 1));
    own.forEach((f) => claimed.add(f));
  }
  const free = frags.filter((f) => !claimed.has(f));
  const kind = classifyPage(free);
  const els = [
    ...free.map((f) => ({ type: 'frag', ...f, x0: f.x0, x1: f.x1, top: f.top, bottom: f.bottom, f })),
    ...regions.map((r) => ({ type: 'region', r, x0: r.x0, x1: r.x1, top: r.y0, bottom: r.y1, y: r.y0 })),
  ].sort((a, b) => a.top - b.top || a.x0 - b.x0);

  // Contents pages: the page-number column is not a text column.
  const gutter = kind !== 'toc' && page.gutter != null ? checkGutter(free, page.gutter, page.h) : null;
  if (gutter == null) {
    els.forEach((e) => { e.col = 0; });
    els.kind = kind;
    return els;
  }
  const rtlPage = free.filter((f) => f.rtl).length > free.length / 2;
  const out = [];
  let left = [];
  let right = [];
  const flush = () => {
    const [a, b] = rtlPage ? [right, left] : [left, right];
    out.push(...a, ...b);
    left = [];
    right = [];
  };
  // Centred titles that cover the middle of the gutter span both columns too.
  const info = page.gutterInfo;
  const mid = info ? (info.band.a + info.band.b) / 2 : gutter;
  const centred = (e) => info && Math.abs((e.x0 + e.x1) / 2 - mid) < 0.08 * info.cw && e.x0 < mid && e.x1 > mid;
  for (const e of els) {
    if ((e.x0 < gutter - 2 && e.x1 > gutter + 2) || centred(e)) { flush(); e.col = 0; out.push(e); }
    else if (e.x1 <= gutter + 2) { e.col = 1; left.push(e); }
    else { e.col = 2; right.push(e); }
  }
  flush();
  out.kind = kind;
  return out;
}

/** Validate the gutter found during analysis against the free text fragments. */
function checkGutter(frags, g, h) {
  const L = frags.filter((f) => f.x1 <= g + 2);
  const R = frags.filter((f) => f.x0 >= g - 2);
  if (L.length < 4 || R.length < 4) return null;
  // Columns must sit side by side for a meaningful height.
  const top = Math.max(Math.min(...L.map((f) => f.top)), Math.min(...R.map((f) => f.top)));
  const bot = Math.min(Math.max(...L.map((f) => f.bottom)), Math.max(...R.map((f) => f.bottom)));
  if (bot - top < 0.12 * h) return null;
  const cw = Math.max(...frags.map((f) => f.x1)) - Math.min(...frags.map((f) => f.x0));
  const narrow = (arr) => median(arr.map((f) => f.x1 - f.x0)) < 0.62 * cw;
  if (!narrow(L) || !narrow(R)) return null;
  // Real columns hold running text, not just numbers (page numbers, prices).
  const texty = (arr) => median(arr.map((f) => f.text.length)) >= 6 && arr.filter((f) => PAGE_REF.test(f.text)).length < arr.length / 2;
  if (!texty(L) || !texty(R)) return null;
  return g;
}

/** Typical baseline-to-baseline distance per font size, measured over the whole book. */
export function measureLeading(orderedPages) {
  const by = new Map();
  for (const els of orderedPages) {
    let prev = null;
    for (const e of els) {
      if (e.type !== 'frag') { prev = null; continue; }
      if (prev && prev.col === e.col && Math.abs(prev.fs - e.fs) < 0.5) {
        const dy = e.y - prev.y;
        if (dy > 0.9 * e.fs && dy < 2.6 * e.fs) {
          const k = Math.round(e.fs);
          if (!by.has(k)) by.set(k, []);
          by.get(k).push(dy);
        }
      }
      prev = e;
    }
  }
  const out = new Map();
  for (const [k, arr] of by) out.set(k, median(arr));
  return (fs) => out.get(Math.round(fs)) || fs * 1.25;
}

/** Margin labels ("NOTE" beside a note box): attach to the text line they sit next to. */
function attachLabels(els) {
  const frags = els.filter((e) => e.type === 'frag');
  for (const lab of frags) {
    const word = despace(lab.text);
    if (word.length > 12 || !LABEL.test(word)) continue;
    const near = frags.filter((f) => f !== lab && f.x0 > lab.x1 + 2 && Math.abs(f.top - lab.top) < 2.5 * Math.max(f.fs, lab.fs));
    if (!near.length) continue;
    // The note starts on the line nearest the label (usually the same line or the one just above).
    const target = near.reduce((a, b) => (Math.abs(b.top - lab.top) < Math.abs(a.top - lab.top) || (Math.abs(b.top - lab.top) === Math.abs(a.top - lab.top) && b.top < a.top) ? b : a));
    // Prefer the first line of that paragraph: walk up while lines are tight and aligned.
    let first = target;
    for (;;) {
      const above = near.concat(frags).find((f) => f !== first && Math.abs(f.x0 - first.x0) < 2 && first.y - f.y > 0.5 * f.fs && first.y - f.y < 1.6 * f.fs && f.top >= lab.top - 2.5 * f.fs);
      if (!above) break;
      first = above;
    }
    first.noteLabel = word.toUpperCase();
    lab.skip = true;
  }
}

/**
 * Build blocks for the whole book from ordered page elements.
 * @param {object[][]} orderedPages  output of orderPage per page
 * @param {number} bodySize
 */
export function buildBlocks(orderedPages, pagesInfo, bodySize) {
  const leading = measureLeading(orderedPages);
  const blocks = [];
  let para = null;
  let code = null;
  let prevCtx = null; // {pg, col, l, r}

  const bounds = orderedPages.map((els) => {
    const m = new Map();
    for (const e of els) {
      if (e.type !== 'frag') continue;
      const body = Math.abs(e.fs - bodySize) <= 0.15 * bodySize && !e.mono;
      const b = m.get(e.col) || { l: Infinity, r: -Infinity, lb: Infinity, rb: -Infinity };
      b.l = Math.min(b.l, e.x0); b.r = Math.max(b.r, e.x1);
      if (body) { b.lb = Math.min(b.lb, e.x0); b.rb = Math.max(b.rb, e.x1); }
      m.set(e.col, b);
    }
    for (const b of m.values()) { if (b.lb === Infinity) { b.lb = b.l; b.rb = b.r; } }
    return m;
  });

  const flushPara = () => { if (para) blocks.push(finishPara(para)); para = null; };
  const flushCode = () => { if (code) blocks.push(finishCode(code, leading)); code = null; };
  const flush = () => { flushPara(); flushCode(); };

  orderedPages.forEach((els, pg) => {
    attachLabels(els);
    flushCode(); // listings don't run across pages as one block
    if (els.kind === 'toc') {
      flush();
      blocks.push(...tocBlocks(els, pg));
      prevCtx = null;
      return;
    }
    let lastIl = null;
    for (const e of els) {
      if (e.skip) continue;
      if (e.type === 'region') {
        flush();
        blocks.push(regionBlock(e.r, pg));
        prevCtx = null;
        lastIl = null;
        continue;
      }
      const b = bounds[pg].get(e.col);
      const ctx = { pg, col: e.col, l: b.lb, r: b.rb };

      if (els.kind === 'index' && e.fs < bodySize * 1.18) {
        flushPara();
        // Wrapped entry: deeper indent and continues a list of page numbers.
        const deeper = lastIl && lastIl.col === e.col && e.x0 > lastIl.x0 + 0.6 * e.fs && e.y - lastIl.y < 2 * leading(e.fs);
        // Turnover: the previous line ran to the column edge without its page numbers.
        const full = lastIl && lastIl.x1 >= b.r - 4 * e.fs && !INDEX_LINE.test(lastIl.text);
        if (deeper && (/^[\d,–-]/.test(e.text) || /[,–-]$/.test(lastIl.text) || full)) {
          lastIl.lines.push(e);
          lastIl.y = e.y;
          lastIl.x1 = e.x1;
          lastIl.text = e.text;
          continue;
        }
        lastIl = { lines: [e], x0: e.x0, x1: e.x1, y: e.y, col: e.col, text: e.text, off: e.x0 - b.l, fs: e.fs, lvl: 0, pg };
        blocks.push(lastIl);
        prevCtx = ctx;
        continue;
      }

      // Code listing: lines in a monospace font (unless it is one code word inside a sentence).
      const inline = para && Math.abs(e.fs - para.fs) < 0.05 * para.fs && e.y - para.lines[para.lines.length - 1].y <= leading(e.fs) * 1.1;
      if (e.mono && !inline) {
        flushPara();
        const last = code?.frags[code.frags.length - 1];
        if (code && code.col === e.col && e.y >= last.y - 0.3 * e.fs && e.y - last.y <= 3.2 * leading(e.fs)) code.frags.push(e);
        else { flushCode(); code = { frags: [e], pg, col: e.col, y: e.top, fs: e.fs }; }
        prevCtx = ctx;
        continue;
      }
      flushCode();

      if (para && !e.noteLabel && continues(para, e, ctx, prevCtx, leading)) {
        para.lines.push(e);
      } else {
        flushPara();
        para = { lines: [e], pg, y: e.top, fs: e.fs, li: BULLET.test(e.text), textX0: textStart(e), note: e.noteLabel };
      }
      prevCtx = ctx;
    }
  });
  flush();
  indexLevels(blocks);
  const out = blocks.map((b) => (b.lines && b.lvl != null ? finishIndexLine(b) : b));
  return markHeadings(out, bodySize);
}

/** Contents page: one block per entry, page number kept separately (for linking). */
function tocBlocks(els, pg) {
  const out = [];
  const frags = els.filter((e) => e.type === 'frag' && !e.skip);
  const lines = linesOf(frags);
  const refX0 = lines.filter(isRefLine).map((l) => l.frags[0].x0);
  const minX = refX0.length ? Math.min(...refX0) : 0;
  let pending = [];
  const emitPending = () => {
    for (const l of pending) out.push(finishPara({ lines: l.frags, pg, y: l.frags[0].top, fs: l.fs }));
    pending = [];
  };
  lines.forEach((line, i) => {
    if (isRefLine(line)) {
      const num = line.frags[line.frags.length - 1];
      const titleFrags = [...pending.flatMap((l) => l.frags), ...line.frags.slice(0, -1)];
      const first = (pending[0] || line).frags[0];
      out.push({
        t: 'tl', pg, y: Math.round(first.top), num: num.text.replace(/\s+/g, ''),
        lvl: Math.max(0, Math.min(2, Math.round((line.frags[0].x0 - minX) / (2 * line.fs)))),
        runs: joinRuns(titleFrags),
      });
      pending = [];
      return;
    }
    const next = lines[i + 1];
    const bareNumber = line.frags.length === 1 && /^[\dIVXLC]{1,4}$/.test(line.frags[0].text);
    const leadsIntoEntry = next && isRefLine(next) && next.y - line.y < 2 * line.fs && Math.abs(next.frags[0].x0 - line.frags[0].x0) < 3 * line.fs;
    if (bareNumber || leadsIntoEntry) pending.push(line);
    else { emitPending(); out.push(finishPara({ lines: line.frags, pg, y: line.frags[0].top, fs: line.fs })); }
  });
  emitPending();
  // Regions on a contents page (rare): keep them in place by position.
  for (const e of els) if (e.type === 'region') out.push(regionBlock(e.r, pg));
  return out.sort((a, b) => a.y - b.y);
}

/** Index entry levels from their indents on each page: main entry, sub-entry, sub-sub-entry. */
function indexLevels(blocks) {
  const byPage = new Map();
  for (const b of blocks) if (b.lines && b.off != null) { if (!byPage.has(b.pg)) byPage.set(b.pg, []); byPage.get(b.pg).push(b); }
  for (const list of byPage.values()) {
    const fs = median(list.map((b) => b.fs));
    const steps = [];
    for (const v of list.map((b) => b.off).sort((a, b) => a - b)) if (!steps.length || v - steps[steps.length - 1] > 0.5 * fs) steps.push(v);
    for (const b of list) {
      let lvl = 0;
      steps.forEach((v, i) => { if (b.off >= v - 0.5 * fs) lvl = i; });
      b.lvl = Math.min(2, lvl);
    }
  }
}

function finishIndexLine(il) {
  return { t: 'il', pg: il.pg, y: Math.round(il.lines[0].top), lvl: il.lvl, runs: joinRuns(il.lines) };
}

/** Monospace lines → preformatted text, keeping indentation and blank lines. */
function finishCode(c, leading) {
  const lines = linesOf(c.frags);
  const cw = median(c.frags.filter((f) => f.text.length >= 4).map((f) => (f.x1 - f.x0) / f.text.length)) || c.fs * 0.6;
  const minX = Math.min(...c.frags.map((f) => f.x0));
  const steps = lines.slice(1).map((l, i) => l.y - lines[i].y).filter((d) => d > 0);
  const step = Math.min(median(steps) || leading(c.fs), leading(c.fs) * 1.2);
  const out = [];
  lines.forEach((l, i) => {
    if (i > 0) {
      const blanks = Math.min(2, Math.max(0, Math.round((l.y - lines[i - 1].y) / step) - 1));
      for (let k = 0; k < blanks; k++) out.push('');
    }
    let s = '';
    for (const f of l.frags) {
      const col = Math.max(s.length ? s.length + 1 : 0, Math.round((f.x0 - minX) / cw));
      s = s.padEnd(col) + f.text;
    }
    out.push(s.replace(/\s+$/, ''));
  });
  // Remove indentation shared by every line.
  const indent = Math.min(...out.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  const text = out.map((l) => l.slice(indent)).join('\n');
  return { t: 'code', pg: c.pg, y: Math.round(c.y), fs: Math.round(c.fs * 10) / 10, text };
}

function textStart(e) {
  // x where the text after a bullet begins (for hanging indents). Approximation: bullet ~ 1em.
  return BULLET.test(e.text) ? e.x0 + e.fs * 0.9 : e.x0;
}

// Distance of a line's start/end from the column edges, mirrored for right-to-left text.
const startGap = (f, c) => (f.rtl ? c.r - f.x1 : f.x0 - c.l);
const endGap = (f, c) => (f.rtl ? f.x0 - c.l : c.r - f.x1);

function continues(para, cur, ctx, prevCtx, leading) {
  const prev = para.lines[para.lines.length - 1];
  if (!prevCtx) return false;
  if (Math.abs(cur.fs - prev.fs) > 0.12 * prev.fs) return false;
  const fs = prev.fs;
  const sameLine = Math.abs(cur.y - prev.y) < 0.3 * fs && (cur.rtl ? cur.x1 <= prev.x0 + 1 : cur.x0 >= prev.x1 - 1);
  // Same line, split by a wide gap (bullet + text, run-in bold term + definition).
  if (sameLine && prevCtx.pg === ctx.pg && prevCtx.col === ctx.col) return true;
  if (cur.bold !== prev.bold && (cur.bold || prev.bold) && !(cur.text.length < 3 || prev.text.length < 3)) return false;
  if (BULLET.test(cur.text)) return false;
  const sameFlow = prevCtx.pg === ctx.pg && prevCtx.col === ctx.col;
  if (!sameFlow) {
    // Paragraph running from the bottom of a column/page to the top of the next one.
    const full = endGap(prev, prevCtx) <= 2 * fs;
    const indented = startGap(cur, ctx) > 0.5 * fs;
    return full && !indented && !TERMINAL.test(prev.text) && !para.note;
  }
  const dy = cur.y - prev.y;
  if (dy < 0.3 * fs) return false; // not below the previous line
  if (dy > leading(fs) * 1.25) return false;
  if (para.li && startGap(cur, ctx) > 0.5 * fs) return true; // hanging indent of a list item
  const firstLineIndent = startGap(cur, ctx) > 0.8 * fs && startGap(cur, ctx) < 8 * fs && startGap(prev, ctx) <= 0.5 * fs;
  if (firstLineIndent) return false;
  // Leaving an indented block (note box, quotation): the next line starts further out.
  // (Text wrapped around a picture has changing indents and is not a block.)
  const lines = para.lines;
  if (lines.length >= 2 && Math.abs(lines[lines.length - 1].x0 - lines[lines.length - 2].x0) < 1.5 && startGap(cur, ctx) < startGap(prev, ctx) - 1.5 * fs) return false;
  const short = endGap(prev, ctx) > 3 * fs;
  if (short && TERMINAL.test(prev.text)) return false;
  return true;
}

export function joinRuns(lines) {
  const runs = [];
  let text = '';
  for (const ln of lines) {
    let first = true;
    for (const r0 of ln.runs) {
      const r = { ...r0 };
      if (first && runs.length) {
        first = false;
        if (/\p{L}[-­]$/u.test(text) && /^\p{Ll}/u.test(r.s)) {
          const last = runs[runs.length - 1];
          last.s = last.s.slice(0, -1);
          text = text.slice(0, -1);
        } else if (!/[—–/]$/.test(text) && !/^\s/.test(r.s)) {
          r.s = ' ' + r.s;
        }
      }
      first = false;
      text += r.s;
      const last = runs[runs.length - 1];
      if (last && !!last.b === !!r.b && !!last.i === !!r.i && !!last.m === !!r.m) last.s += r.s;
      else runs.push(r);
    }
  }
  return runs.map((r) => {
    const o = { s: r.s.replace(/­/g, '') };
    if (r.b) o.b = 1;
    if (r.i) o.i = 1;
    if (r.m) o.m = 1;
    return o;
  }).filter((r) => r.s);
}

function finishPara(p) {
  const runs = joinRuns(p.lines);
  const text = runs.map((r) => r.s).join('');
  const blk = {
    t: 'p', pg: p.pg, y: Math.round(p.y), fs: Math.round(p.fs * 10) / 10,
    runs,
    _bold: p.lines.every((l) => l.bold),
    _lines: p.lines.length,
    _text: text,
  };
  if (p.li) blk.li = 1;
  if (p.note) blk.note = p.note;
  if (p.lines.some((l) => l.rtl)) blk.rtl = 1;
  return blk;
}

function regionBlock(r, pg) {
  const rect = { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
  if (r.kind === 'table') return { t: 'table', pg, y: Math.round(r.y0), rows: r.table, rect };
  if (r.kind === 'scan') return { t: 'scan', pg, y: Math.round(r.y0), rect };
  return { t: 'img', pg, y: Math.round(r.y0), rect };
}

function markHeadings(blocks, body) {
  const paras = blocks.filter((b) => b.t === 'p');
  const big = paras.filter((b) => b.fs >= body * 1.18 && b._text.length <= 200 && b._lines <= 3 && !b.note);
  const sizes = [...new Set(big.map((b) => Math.round(b.fs)))].sort((a, b) => b - a);
  for (const b of big) {
    b.t = 'h';
    b.l = Math.min(3, sizes.indexOf(Math.round(b.fs)) + 1);
  }
  for (const b of paras) {
    if (b.t === 'p' && b._bold && !b.li && !b.note && b._lines <= 2 && b._text.length <= 90 && !/[.,;]$/.test(b._text) && b.fs >= body * 0.95) {
      b.t = 'h';
      b.l = Math.min(4, sizes.length + 1);
    }
  }
  // A chapter number set apart ("1", "IV") belongs to the chapter title that follows.
  for (let i = blocks.length - 2; i >= 0; i--) {
    const a = blocks[i];
    const b = blocks[i + 1];
    if (a.t === 'h' && b.t === 'h' && a.pg === b.pg && /^(\d{1,3}|[IVXLC]{1,6}|[A-Z])$/.test(a._text.trim())) {
      b.runs = [{ s: `${a._text.trim()} ` }, ...b.runs];
      b.l = Math.min(a.l, b.l);
      b.y = a.y;
      blocks.splice(i, 1);
    }
  }
  // A title set on two lines with extra spacing ("DISSECTING THE" / "DARK WEB") is one heading.
  for (let i = blocks.length - 2; i >= 0; i--) {
    const a = blocks[i];
    const b = blocks[i + 1];
    if (a.t === 'h' && b.t === 'h' && a.pg === b.pg && a.l === b.l && Math.abs(a.fs - b.fs) < 0.5 && b.y - a.y < 2.2 * a.fs && a._lines + b._lines <= 3) {
      a.runs = [...a.runs, { ...b.runs[0], s: ` ${b.runs[0].s}` }, ...b.runs.slice(1)];
      a._lines += b._lines;
      blocks.splice(i + 1, 1);
    }
  }
  for (const b of blocks) { delete b._bold; delete b._lines; delete b._text; }
  return blocks;
}
