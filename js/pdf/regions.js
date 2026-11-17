// Turn raw page graphics into content regions: tables, raster images, vector figures.
// Each region claims the text fragments whose centre lies inside it.

import { area, center, clusterValues, containsPoint, mergeRects, overlaps, union } from './geometry.js';

const TOL = 2.5; // pt tolerance when matching line ends / borders

/**
 * @returns {{regions: object[], scanned: boolean}}
 *   region: {kind:'table'|'image'|'figure'|'scan', x0,y0,x1,y1, table?}
 */
export function findRegions(pa) {
  const pageArea = pa.w * pa.h;
  const regions = [];
  const textChars = pa.frags.reduce((s, f) => s + f.chars, 0);

  // 1. Tables from ruled lines.
  const used = new Set();
  for (const comp of groupRules(lineComponents(pa.segments))) {
    const t = buildTable(comp, pa.frags);
    if (t) {
      regions.push(t);
      comp.forEach((s) => used.add(s));
    }
  }

  // 2. Raster images.
  let imgs = pa.images.filter((r) => (r.x1 - r.x0) > 24 && (r.y1 - r.y0) > 24 && !(r.mask && area(r) < 2500));
  imgs = mergeRects(imgs, 2);
  let scanned = false;
  for (const r of imgs) {
    const clipped = clip(r, pa);
    if (area(clipped) > 0.7 * pageArea) {
      // Full-page picture: a scanned page (no text) or a background behind real/OCR'd text.
      if (textChars < 15) { scanned = true; regions.push({ kind: 'scan', ...clipped }); }
      continue;
    }
    if (regions.some((t) => t.kind === 'table' && overlaps(t, clipped))) continue;
    regions.push({ kind: 'image', ...clipped });
  }

  // 3. Vector figures: clusters of drawings that are not table rules and not mostly text.
  const loose = [
    ...pa.shapes.filter((s) => area(s) < 0.6 * pageArea),
    ...pa.segments.filter((s) => !used.has(s)).map(segBox),
  ].filter((s) => !regions.some((r) => overlaps(r, s, 1)));
  for (const c of mergeRects(loose, 6)) {
    const w = c.x1 - c.x0;
    const h = c.y1 - c.y0;
    if (w < 50 || h < 30) continue;
    if (c.members < 4 && !c.curves) continue;
    const textArea = pa.frags
      .filter((f) => containsPoint(c, ...center(fragBox(f))))
      .reduce((s, f) => s + area(fragBox(f)), 0);
    if (textArea / area(c) > 0.35) continue; // a box around text, or underlines: not a figure
    regions.push({ kind: 'figure', ...clip(c, pa) });
  }

  // Images and figures that touch each other are one illustration.
  const pics = mergeRects(regions.filter((r) => r.kind === 'image' || r.kind === 'figure').map((r) => ({ ...r })), 3)
    .map((r) => ({ ...r, kind: 'image' }));
  const out = [...regions.filter((r) => r.kind === 'table' || r.kind === 'scan'), ...pics];
  return { regions: out, scanned };
}

export function fragBox(f) {
  return { x0: f.x0, y0: f.top, x1: f.x1, y1: f.bottom };
}

function segBox(s) {
  return s.kind === 'h'
    ? { x0: s.x0, x1: s.x1, y0: s.y - 0.5, y1: s.y + 0.5, members: 1 }
    : { x0: s.x - 0.5, x1: s.x + 0.5, y0: s.y0, y1: s.y1, members: 1 };
}

function clip(r, pa) {
  return { x0: Math.max(0, r.x0), y0: Math.max(0, r.y0), x1: Math.min(pa.w, r.x1), y1: Math.min(pa.h, r.y1) };
}

/** Connected components of segments that touch or cross. */
function lineComponents(segments) {
  const n = segments.length;
  const parent = segments.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touch = (a, b) => {
    const A = segBox(a);
    const B = segBox(b);
    return overlaps(A, B, TOL);
  };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (touch(segments[i], segments[j])) parent[find(i)] = find(j);
  const groups = new Map();
  segments.forEach((s, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  });
  return [...groups.values()];
}

/**
 * Book/journal tables often have only horizontal rules (top, middle, bottom) that don't touch.
 * Merge rule-only components with the same horizontal extent that are stacked closely.
 */
function groupRules(comps) {
  const rulesOnly = comps.filter((c) => c.every((s) => s.kind === 'h'));
  const rest = comps.filter((c) => !rulesOnly.includes(c));
  const ext = (c) => ({ x0: Math.min(...c.map((s) => s.x0)), x1: Math.max(...c.map((s) => s.x1)), y0: Math.min(...c.map((s) => s.y)), y1: Math.max(...c.map((s) => s.y)) });
  const groups = [];
  for (const c of rulesOnly.sort((a, b) => ext(a).y0 - ext(b).y0)) {
    const e = ext(c);
    const g = groups.find((G) => {
      const E = ext(G);
      return Math.abs(E.x0 - e.x0) < 3 && Math.abs(E.x1 - e.x1) < 3 && e.y0 - E.y1 < 250;
    });
    if (g) g.push(...c); else groups.push([...c]);
  }
  return [...rest, ...groups];
}

function buildTable(segs, frags) {
  const hs = segs.filter((s) => s.kind === 'h');
  const vs = segs.filter((s) => s.kind === 'v');
  if (hs.length < 2) return null;
  const box = segs.map(segBox).reduce(union);
  if (box.x1 - box.x0 < 40) return null;
  const inside = frags.filter((f) => containsPoint(box, ...center(fragBox(f)), 1));
  if (inside.length < 2) return null;

  const ys = clusterValues(hs.map((s) => s.y), TOL);
  const xs = clusterValues(vs.map((s) => s.x), TOL);
  let table;
  if (xs.length >= 3 && ys.length >= 3) table = gridTable(xs, ys, hs, vs, inside);
  else if (vs.length === 0) {
    // Guard against page-wide header/footer rules: rule tables are short and hold short cells.
    const avgLen = inside.reduce((n, f) => n + f.text.length, 0) / inside.length;
    if (box.y1 - box.y0 > 400 || avgLen > 40) return null;
    table = rulesTable(box, inside);
  }
  if (!table) return null;
  // Right-to-left tables (Hebrew, Arabic): the first column is the rightmost one.
  if (inside.filter((f) => f.rtl).length > inside.length / 2) table.forEach((row) => row.reverse());
  const cells = table.flat().filter((c) => c.s).length;
  if (table.length < 2 || Math.max(...table.map((r) => r.length)) < 2 || cells < 3) return null;
  return { kind: 'table', ...box, table, claims: inside };
}

/** Fully ruled grid: rows/cols from line positions, merged cells where a border is missing. */
function gridTable(xs, ys, hs, vs, frags) {
  const R = ys.length - 1;
  const C = xs.length - 1;
  const covered = (lines, pos, a, b, posKey, aKey, bKey) => lines.some((l) =>
    Math.abs(l[posKey] - pos) < TOL && l[aKey] <= a + TOL + 0.15 * (b - a) && l[bKey] >= b - TOL - 0.15 * (b - a));
  const id = (r, c) => r * C + c;
  const parent = Array.from({ length: R * C }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (c + 1 < C && !covered(vs, xs[c + 1], ys[r], ys[r + 1], 'x', 'y0', 'y1')) parent[find(id(r, c + 1))] = find(id(r, c));
      if (r + 1 < R && !covered(hs, ys[r + 1], xs[c], xs[c + 1], 'y', 'x0', 'x1')) parent[find(id(r + 1, c))] = find(id(r, c));
    }
  }
  // Groups must be rectangles; otherwise fall back to unmerged cells.
  const groups = new Map();
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const g = find(id(r, c));
    if (!groups.has(g)) groups.set(g, { r0: r, c0: c, r1: r, c1: c, n: 0 });
    const G = groups.get(g);
    Object.assign(G, { r0: Math.min(G.r0, r), c0: Math.min(G.c0, c), r1: Math.max(G.r1, r), c1: Math.max(G.c1, c), n: G.n + 1 });
  }
  const rectangular = [...groups.values()].every((g) => (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1) === g.n);
  const groupOf = (r, c) => (rectangular ? find(id(r, c)) : id(r, c));

  const texts = new Map();
  for (const f of frags) {
    const [cx, cy] = center(fragBox(f));
    const c = xs.findIndex((x, k) => k < C && cx >= x && cx <= xs[k + 1]);
    const r = ys.findIndex((y, k) => k < R && cy >= y && cy <= ys[k + 1]);
    if (r < 0 || c < 0) continue;
    const g = groupOf(r, c);
    if (!texts.has(g)) texts.set(g, []);
    texts.get(g).push(f);
  }
  const rows = [];
  const emitted = new Set();
  for (let r = 0; r < R; r++) {
    const row = [];
    for (let c = 0; c < C; c++) {
      const g = groupOf(r, c);
      if (emitted.has(g)) continue;
      emitted.add(g);
      const G = rectangular ? groups.get(g) : { r0: r, c0: c, r1: r, c1: c };
      row.push(cell(texts.get(g) || [], G.c1 - G.c0 + 1, G.r1 - G.r0 + 1));
    }
    rows.push(row);
  }
  return rows;
}

/** Horizontal rules only (book/journal style): rows from baselines, columns from vertical gaps. */
function rulesTable(box, frags) {
  const fs = Math.min(...frags.map((f) => f.fs));
  // Column boundaries = x ranges not covered by any fragment.
  const iv = frags.map((f) => [f.x0, f.x1]).sort((a, b) => a[0] - b[0]);
  const cols = [];
  for (const [a, b] of iv) {
    const last = cols[cols.length - 1];
    if (last && a <= last[1] + 0.5 * fs) last[1] = Math.max(last[1], b);
    else cols.push([a, b]);
  }
  if (cols.length < 2) return null;
  const rowsY = clusterValues(frags.map((f) => f.y), 0.5 * fs);
  if (rowsY.length < 2) return null;
  return rowsY.map((y) => cols.map(([a, b]) => cell(frags.filter((f) => Math.abs(f.y - y) <= 0.5 * fs && f.x0 >= a - 1 && f.x1 <= b + 1), 1, 1)));
}

function cell(frags, cs, rs) {
  const sorted = [...frags].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  let s = '';
  for (const f of sorted) {
    if (!s) s = f.text;
    else if (/[A-Za-z]-$/.test(s) && /^[a-z]/.test(f.text)) s = s.slice(0, -1) + f.text;
    else s += ' ' + f.text;
  }
  const c = { s };
  if (cs > 1) c.cs = cs;
  if (rs > 1) c.rs = rs;
  if (sorted.length && sorted.every((f) => f.bold)) c.b = true;
  return c;
}
