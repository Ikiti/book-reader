// Reading order (columns) and paragraph/heading reconstruction.

import { center, containsPoint, median } from './geometry.js';
import { fragBox } from './regions.js';

const BULLET = /^([•●○◦▪■►‣⁃–—*-]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s/;
const TERMINAL = /[.!?:;]["'”’»)\]]?$/;

/**
 * Order a page's text fragments and regions for reading.
 * @returns {object[]} elements, each {type:'frag'|'region', col, ...}
 */
export function orderPage(page, frags, regions) {
  // Regions claim the text inside them (table cells, labels drawn on pictures).
  const claimed = new Set();
  for (const r of regions) {
    const own = r.claims || frags.filter((f) => containsPoint(r, ...center(fragBox(f)), 1));
    own.forEach((f) => claimed.add(f));
  }
  const free = frags.filter((f) => !claimed.has(f));
  const els = [
    ...free.map((f) => ({ type: 'frag', ...f, x0: f.x0, x1: f.x1, top: f.top, bottom: f.bottom, f })),
    ...regions.map((r) => ({ type: 'region', r, x0: r.x0, x1: r.x1, top: r.y0, bottom: r.y1, y: r.y0 })),
  ].sort((a, b) => a.top - b.top || a.x0 - b.x0);

  const gutter = page.gutter != null ? checkGutter(free, page.gutter, page.h) : null;
  if (gutter == null) {
    els.forEach((e) => { e.col = 0; });
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
  for (const e of els) {
    if (e.x0 < gutter - 2 && e.x1 > gutter + 2) { flush(); e.col = 0; out.push(e); }
    else if (e.x1 <= gutter + 2) { e.col = 1; left.push(e); }
    else { e.col = 2; right.push(e); }
  }
  flush();
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

/**
 * Build blocks for the whole book from ordered page elements.
 * @param {object[][]} orderedPages
 * @param {number} bodySize
 */
export function buildBlocks(orderedPages, pagesInfo, bodySize) {
  const leading = measureLeading(orderedPages);
  const blocks = [];
  let para = null;
  let prevCtx = null; // {pg, col, bounds}

  const bounds = orderedPages.map((els) => {
    const m = new Map();
    for (const e of els) {
      if (e.type !== 'frag') continue;
      const body = Math.abs(e.fs - bodySize) <= 0.15 * bodySize;
      const b = m.get(e.col) || { l: Infinity, r: -Infinity, lb: Infinity, rb: -Infinity };
      b.l = Math.min(b.l, e.x0); b.r = Math.max(b.r, e.x1);
      if (body) { b.lb = Math.min(b.lb, e.x0); b.rb = Math.max(b.rb, e.x1); }
      m.set(e.col, b);
    }
    for (const b of m.values()) { if (b.lb === Infinity) { b.lb = b.l; b.rb = b.r; } }
    return m;
  });

  const flush = () => {
    if (para) blocks.push(finishPara(para));
    para = null;
  };

  orderedPages.forEach((els, pg) => {
    for (const e of els) {
      if (e.type === 'region') {
        flush();
        blocks.push(regionBlock(e.r, pg));
        prevCtx = null;
        continue;
      }
      const b = bounds[pg].get(e.col);
      const ctx = { pg, col: e.col, l: b.lb, r: b.rb };
      if (para && continues(para, e, ctx, prevCtx, leading)) {
        para.lines.push(e);
      } else {
        flush();
        para = { lines: [e], pg, y: e.top, fs: e.fs, li: BULLET.test(e.text), textX0: textStart(e) };
      }
      prevCtx = ctx;
    }
  });
  flush();
  return markHeadings(blocks, bodySize);
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
  if (cur.bold !== prev.bold && (cur.bold || prev.bold)) return false;
  if (BULLET.test(cur.text)) return false;
  const fs = prev.fs;
  const sameFlow = prevCtx.pg === ctx.pg && prevCtx.col === ctx.col;
  if (!sameFlow) {
    // Paragraph running from the bottom of a column/page to the top of the next one.
    const full = endGap(prev, prevCtx) <= 2 * fs;
    const indented = startGap(cur, ctx) > 0.5 * fs;
    return full && !indented && !TERMINAL.test(prev.text);
  }
  const dy = cur.y - prev.y;
  if (Math.abs(dy) < 0.3 * fs && (cur.rtl ? cur.x1 <= prev.x0 + 1 : cur.x0 >= prev.x1 - 1)) return true; // same line, split by a wide gap
  if (dy < 0.3 * fs) return false; // not below the previous line
  if (dy > leading(fs) * 1.25) return false;
  if (para.li && startGap(cur, ctx) > 0.5 * fs) return true; // hanging indent of a list item
  const firstLineIndent = startGap(cur, ctx) > 0.8 * fs && startGap(cur, ctx) < 8 * fs && startGap(prev, ctx) <= 0.5 * fs;
  if (firstLineIndent) return false;
  const short = endGap(prev, ctx) > 3 * fs;
  if (short && TERMINAL.test(prev.text)) return false;
  return true;
}

function joinRuns(lines) {
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
        } else if (!/[—–/]$/.test(text)) {
          r.s = ' ' + r.s;
        }
      }
      first = false;
      text += r.s;
      const last = runs[runs.length - 1];
      if (last && !!last.b === !!r.b && !!last.i === !!r.i) last.s += r.s;
      else runs.push(r);
    }
  }
  return runs.map((r) => {
    const o = { s: r.s.replace(/­/g, '') };
    if (r.b) o.b = 1;
    if (r.i) o.i = 1;
    return o;
  });
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
  const big = paras.filter((b) => b.fs >= body * 1.18 && b._text.length <= 200);
  const sizes = [...new Set(big.map((b) => Math.round(b.fs)))].sort((a, b) => b - a);
  for (const b of big) {
    b.t = 'h';
    b.l = Math.min(3, sizes.indexOf(Math.round(b.fs)) + 1);
  }
  for (const b of paras) {
    if (b.t === 'p' && b._bold && !b.li && b._lines <= 2 && b._text.length <= 90 && !/[.,;]$/.test(b._text) && b.fs >= body * 0.95) {
      b.t = 'h';
      b.l = Math.min(4, sizes.length + 1);
    }
  }
  for (const b of blocks) { delete b._bold; delete b._lines; delete b._text; }
  return blocks;
}
