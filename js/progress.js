// Reading progress: what you have actually read, not only where you are.
//
// Kept per book (books.reading):
//   read       [[from, to), …]  block ranges you've read (sorted, merged)
//   bookmarks  [{id, b, off, pgi, page, chapter, text, at}]
//   speed      your reading speed in this book, characters per second (measured)
//   ms         active reading time
//   pct        share of the book read (0..1), for the library card
//   finishedAt when the whole book was read (or marked finished)
//
// A block counts as read after it has been on screen for about as long as a fast reader needs
// for it (CREDIT_RATE). Scrolling or jumping past text doesn't mark it; reading a couple of
// paragraphs in the middle of a chapter marks just those paragraphs.
// Pure functions: the same code runs in the reader and in Node tests.

export const CREDIT_RATE = 30; // chars/s a block can be credited with while visible (~350 words/min)
export const READ_SHARE = 0.8; // credited share of a block's text that makes it "read"
export const DEFAULT_SPEED = 15; // chars/s until we've measured you (~180 words/min, technical text)
export const DONE_SHARE = 0.9; // a chapter counts as finished at 90% read
export const FINISHED_SHARE = 0.98;

/** Reading "size" of each block, in characters of text (pictures/tables count as a short read). */
export function blockSizes(blocks) {
  return blocks.map((b) => {
    if (b.runs) return Math.max(1, b.runs.reduce((n, r) => n + r.s.length, 0));
    if (b.t === 'code') return Math.max(40, Math.round((b.text || '').length * 0.5)); // code is scanned, not read word by word
    if (b.t === 'table') return Math.min(1200, 120 + Math.round(b.rows.flat().reduce((n, c) => n + (c.s || '').length, 0) * 0.5));
    if (b.t === 'img' || b.t === 'scan') return 150;
    return 20;
  });
}

/** prefix[i] = total size of blocks before i. */
export function prefix(sizes) {
  const p = new Float64Array(sizes.length + 1);
  for (let i = 0; i < sizes.length; i++) p[i + 1] = p[i] + sizes[i];
  return p;
}

// ---------- block ranges ----------

export function addRange(ranges, a, b) {
  if (b <= a) return ranges;
  const out = [];
  let s = a;
  let e = b;
  let placed = false;
  for (const r of ranges) {
    if (r[1] < s) out.push(r);
    else if (r[0] > e) { if (!placed) { out.push([s, e]); placed = true; } out.push(r); }
    else { s = Math.min(s, r[0]); e = Math.max(e, r[1]); }
  }
  if (!placed) out.push([s, e]);
  return out;
}

export function removeRange(ranges, a, b) {
  const out = [];
  for (const [s, e] of ranges) {
    if (e <= a || s >= b) { out.push([s, e]); continue; }
    if (s < a) out.push([s, a]);
    if (e > b) out.push([b, e]);
  }
  return out;
}

export function isRead(ranges, i) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (i < ranges[m][0]) hi = m - 1;
    else if (i >= ranges[m][1]) lo = m + 1;
    else return true;
  }
  return false;
}

/** Size of the read blocks within [from, to). */
export function readSize(ranges, pre, from = 0, to = pre.length - 1) {
  let n = 0;
  for (const [s, e] of ranges) {
    const a = Math.max(s, from);
    const b = Math.min(e, to);
    if (b > a) n += pre[b] - pre[a];
  }
  return n;
}

/** First block in [from, to) that isn't read, or -1. */
export function firstUnread(ranges, from, to) {
  let i = from;
  for (const [s, e] of ranges) {
    if (e <= i) continue;
    if (s > i) break;
    i = e;
  }
  return i < to ? i : -1;
}

// ---------- chapters ----------

/** Block range of every contents entry: up to the next entry of the same or a higher level. */
export function chapterRanges(toc, nBlocks) {
  return toc.map((t, i) => {
    let end = nBlocks;
    for (let j = i + 1; j < toc.length; j++) if (toc[j].level <= t.level) { end = toc[j].b; break; }
    return { ...t, from: t.b, to: Math.max(t.b + 1, end) };
  });
}

/** Read share of a block range, where to continue in it, and its state. */
export function rangeStats(reading, pre, from, to) {
  const total = pre[to] - pre[from];
  const read = readSize(reading.read || [], pre, from, to);
  const pct = total ? read / total : 0;
  const next = firstUnread(reading.read || [], from, to);
  return { pct, total, read, next, state: pct >= DONE_SHARE || next < 0 ? 'done' : read > 0 ? 'started' : 'new' };
}

/** "6 min", "1 h 20 min" for a number of characters at a reading speed. */
export function timeFor(chars, speed = DEFAULT_SPEED) {
  const min = Math.max(1, Math.round(chars / Math.max(1, speed) / 60));
  if (min < 60) return `${min} min`;
  const hrs = Math.floor(min / 60);
  return `${hrs} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

// ---------- attention → read ----------

/**
 * One tick of reading: `seconds` of attention spread over the blocks on screen, top first.
 * credit: Map(block → credited chars). Returns the blocks that became read.
 */
export function creditVisible(reading, credit, sizes, visible, seconds) {
  let budget = CREDIT_RATE * seconds;
  const done = [];
  for (const b of visible) {
    if (budget <= 0) break;
    if (isRead(reading.read, b)) continue;
    const need = sizes[b] * READ_SHARE - (credit.get(b) || 0);
    const take = Math.min(need, budget);
    budget -= take;
    if (take >= need - 1e-6) {
      credit.delete(b);
      reading.read = addRange(reading.read, b, b + 1);
      done.push(b);
    } else credit.set(b, (credit.get(b) || 0) + take);
  }
  return done;
}

/** Update the measured reading speed with a sample (chars actually advanced over active seconds). */
export function updateSpeed(speed, chars, seconds) {
  if (seconds < 60 || chars < 400) return speed;
  const sample = Math.min(60, Math.max(4, chars / seconds));
  return Math.round((0.7 * (speed || DEFAULT_SPEED) + 0.3 * sample) * 10) / 10;
}

export function emptyReading() {
  return { read: [], bookmarks: [], speed: DEFAULT_SPEED, ms: 0, pct: 0, finishedAt: 0 };
}

/**
 * Reading state for a book, upgrading books saved before reading was tracked: back then only the
 * position was kept, so everything before it is taken as read.
 */
export function loadReading(book, nBlocks) {
  const r = { ...emptyReading(), ...(book.reading || {}) };
  if (!book.reading && book.progress?.b > 0) r.read = [[0, Math.min(nBlocks, book.progress.b)]];
  r.read = (r.read || []).filter(([s, e]) => e > s && s < nBlocks).map(([s, e]) => [s, Math.min(e, nBlocks)]);
  return r;
}

/**
 * After a book is converted again (app update), block numbers change. Carry reading state over by
 * page: pages that were read stay read, the position/bookmarks keep their page, notes find their
 * quote again.
 */
export function remapReading(oldModel, newModel, book, notes = []) {
  const oldSizes = blockSizes(oldModel.blocks);
  const reading = loadReading(book, oldModel.blocks.length);
  const pages = new Map(); // pg → [read, total]
  oldModel.blocks.forEach((b, i) => {
    const e = pages.get(b.pg) || [0, 0];
    e[1] += oldSizes[i];
    if (isRead(reading.read, i)) e[0] += oldSizes[i];
    pages.set(b.pg, e);
  });
  const firstOnPage = (pg) => { const i = newModel.blocks.findIndex((b) => b.pg >= pg); return i < 0 ? Math.max(0, newModel.blocks.length - 1) : i; };
  let read = [];
  newModel.blocks.forEach((b, i) => { const e = pages.get(b.pg); if (e && e[1] && e[0] / e[1] >= DONE_SHARE) read = addRange(read, i, i + 1); });
  const pgOf = (b) => oldModel.blocks[b]?.pg ?? 0;
  const newPre = prefix(blockSizes(newModel.blocks));
  const out = { ...reading, read, pct: readSize(read, newPre) / Math.max(1, newPre[newPre.length - 1]) };
  out.bookmarks = (reading.bookmarks || []).map((m) => ({ ...m, b: firstOnPage(m.pgi ?? pgOf(m.b)), off: 0 }));
  const progress = book.progress ? { ...book.progress, b: firstOnPage(book.progress.pgi ?? pgOf(book.progress.b)), off: 0 } : null;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const texts = newModel.blocks.map((b) => norm(b.runs ? b.runs.map((r) => r.s).join('') : b.text || ''));
  const movedNotes = notes.map((n) => {
    const pg = pgOf(n.block);
    const probe = norm(n.quote).slice(0, 40);
    let best = -1;
    texts.forEach((t, i) => { if (probe && t.includes(probe) && (best < 0 || Math.abs(newModel.blocks[i].pg - pg) < Math.abs(newModel.blocks[best].pg - pg))) best = i; });
    return { ...n, block: best >= 0 ? best : firstOnPage(pg) };
  });
  return { reading: out, progress, notes: movedNotes };
}
