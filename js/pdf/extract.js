// PDF -> reflowable book model.
//
// Model (stored in IndexedDB, rendered by reader.js, exported by epub/epub.js):
// {
//   v: EXTRACT_VERSION, pageCount, pages: [{w, h}], labels: ['Cover','i',…,'1',…] (printed page numbers),
//   bodySize, needsOcr, scannedPages,
//   blocks: [ {t:'h', l, runs, pg, y}                 heading (l = 1…4)
//           | {t:'p', runs, pg, y, li?, rtl?, note?}  paragraph / list item / note box ('NOTE', 'WARNING'…)
//           | {t:'code', text, pg, y}                 code listing (keeps line breaks and indentation)
//           | {t:'tl', runs, num, lvl, to?, pg, y}    contents line; `to` = block index of the target
//           | {t:'il', runs, lvl, pg, y}              index line
//           | {t:'img', k, w, h, pg, y} | {t:'table', rows, k, pg, y} | {t:'scan', k, pg, y} ],
//   toc: [{title, level, b /* block index */, pg}]
// }
// runs: [{s, b?, i?, m? (monospace)}]; images are returned separately and referenced by index `k`.

import { analyzePage, WORD_BREAK } from './analyze.js';
import { findRegions } from './regions.js';
import { buildBlocks, orderPage, PAGE_REF } from './layout.js';
import { weightedMode } from './geometry.js';

export const EXTRACT_VERSION = 3; // 3: OCR for picture-only pages

const PAGE_NUM = /^(page\s*)?#(\s*(of|\/)\s*#)?$|^[-–—]\s*#\s*[-–—]$|^[ivxlcdm]+$/i;
const textOf = (b) => (b.runs ? b.runs.map((r) => r.s).join('') : '');

/**
 * @param {object} pdfjs  pdf.js module
 * @param {object} pdf    PDFDocumentProxy
 * @param {object} opts
 *   cropper(pageNumber, rects) -> Promise<(Blob|Uint8Array)[]>   renders a page and crops rects
 *   ocr      {page(pageNumber, w, h) -> page description}  for pages that are only a picture (optional)
 *   onProgress(done, total, phase)   phase: 'analyze' | 'ocr' | 'images'
 */
export async function extractBook(pdfjs, pdf, { cropper, ocr, onProgress } = {}) {
  const n = pdf.numPages;
  const raw = [];
  for (let p = 1; p <= n; p++) {
    const page = await pdf.getPage(p);
    let pa;
    try {
      pa = await analyzePage(pdfjs, page);
      Object.assign(pa, findRegions(pa));
    } catch (err) {
      console.warn('page analysis failed, keeping page as picture', p, err);
      const vp = page.getViewport({ scale: 1 });
      pa = { w: vp.width, h: vp.height, frags: [], regions: [{ kind: 'scan', x0: 0, y0: 0, x1: vp.width, y1: vp.height }], scanned: true };
    }
    page.cleanup();
    // A page that is only a picture: read it with OCR, then lay it out like any other page.
    if (pa.scanned && ocr) {
      onProgress?.(p, n, 'ocr');
      try {
        const o = await ocr.page(p, pa.w, pa.h);
        if (o.poster) pa.poster = true; // cover / designed page: stays a picture
        else if (o.frags.length) { pa = o; Object.assign(pa, findRegions(pa)); }
      } catch (err) {
        console.warn('OCR failed on page', p, err);
      }
    }
    raw.push(pa);
    onProgress?.(p, n, 'analyze');
  }
  await ocr?.close?.();

  // Body text size: the most common size of running text (code listings don't count — a code-heavy
  // book would otherwise make every normal paragraph look like a heading).
  const sizeOf = () => weightedMode(raw.flatMap((pa) => pa.frags.filter((f) => !f.mono).map((f) => [f.fs, f.chars])), 0.5)
    || weightedMode(raw.flatMap((pa) => pa.frags.map((f) => [f.fs, f.chars])), 0.5);
  let bodySize = sizeOf() || 11;
  let pdfLabels = null;
  try { pdfLabels = await pdf.getPageLabels(); } catch { /* none */ }
  removeRunningHeaders(raw, bodySize, pdfLabels);
  bodySize = sizeOf() || bodySize;
  const labels = await pageLabels(pdf, raw);
  const outline = await readOutline(pdf, raw);
  const ordered = raw.map((pa) => orderPage(pa, pa.frags, pa.regions));
  const blocks = buildBlocks(ordered, raw, bodySize);
  repairLetterSpacing(blocks, outline, await pdf.getMetadata().catch(() => null));

  // Render pictures/tables/scanned pages to images.
  const images = [];
  const byPage = new Map();
  blocks.forEach((b) => {
    if (b.rect) {
      if (!byPage.has(b.pg)) byPage.set(b.pg, []);
      byPage.get(b.pg).push(b);
    }
  });
  let done = 0;
  for (const [pg, list] of byPage) {
    const pad = 2;
    const rects = list.map((b) => {
      const r = { x0: b.rect.x0 - pad, y0: b.rect.y0 - pad, x1: b.rect.x1 + pad, y1: b.rect.y1 + pad };
      // Running text that only touches the picture's box (text wrapped around it) is painted over.
      const inside = (f) => { const cx = (f.x0 + f.x1) / 2; const cy = (f.top + f.bottom) / 2; return cx >= b.rect.x0 && cx <= b.rect.x1 && cy >= b.rect.y0 && cy <= b.rect.y1; };
      r.masks = b.t === 'scan' ? [] : raw[pg].frags
        .filter((f) => !inside(f) && f.x1 > r.x0 && f.x0 < r.x1 && f.bottom > r.y0 && f.top < r.y1)
        .map((f) => ({ x0: f.x0 - 1, y0: f.top - 1, x1: f.x1 + 1, y1: f.bottom + 1 }));
      return r;
    });
    let blobs = [];
    if (cropper) {
      try { blobs = await cropper(pg + 1, rects); } catch (err) { console.warn('crop failed', pg, err); }
    }
    list.forEach((b, i) => {
      b.w = Math.round(b.rect.x1 - b.rect.x0);
      b.h = Math.round(b.rect.y1 - b.rect.y0);
      if (blobs[i]) { b.k = images.length; images.push(blobs[i]); }
      delete b.rect;
    });
    onProgress?.(++done, byPage.size, 'images');
  }

  const toc = buildToc(blocks, outline);
  linkContentsLines(blocks, labels);
  // Front/back covers are pictures by nature; don't count them as pages needing OCR.
  const scannedPages = raw.filter((pa, i) => pa.scanned && !pa.poster && !(n > 4 && (i === 0 || i === n - 1))).length;
  const ocrPages = raw.filter((pa) => pa.ocr).length;
  return {
    model: {
      v: EXTRACT_VERSION,
      pageCount: n,
      pages: raw.map((pa) => ({ w: Math.round(pa.w), h: Math.round(pa.h) })),
      labels,
      bodySize,
      needsOcr: scannedPages > 0,
      scannedPages,
      ocrPages,
      blocks,
      toc,
    },
    images,
  };
}

/**
 * Drop running headers/footers and page numbers. A margin line is dropped when it stands apart from
 * the text block and either looks like a page number or repeats on several pages ("Chapter 1",
 * "A Visit to the Dark Web 3"). Printed page numbers are remembered for page labels.
 */
function removeRunningHeaders(raw, body, pdfLabels) {
  const zone = (pa, f) => f.top < pa.h * 0.1 || f.bottom > pa.h * 0.9;
  const wideZone = (pa, f) => f.top < pa.h * 0.13 || f.bottom > pa.h * 0.87;
  const key = (f) => f.text.toLowerCase().replace(/\d+/g, '#').replace(/\b[ivxlcdm]+\b/g, '#').replace(/\s+/g, ' ').trim();
  const sameLine = (a, b) => b.bottom > a.top && b.top < a.bottom;
  // Nothing else within ~1.5 lines above/below (headers/footers sit apart from the text block).
  const apart = (pa, f) => !pa.frags.some((o) => o !== f && !sameLine(f, o) && o.top < f.bottom + 1.5 * f.fs && o.bottom > f.top - 1.5 * f.fs);
  const alone = (pa, f) => !pa.frags.some((o) => o !== f && sameLine(f, o));
  const small = (f) => f.fs <= body * 1.3 && !f.mono;

  const counts = new Map();
  raw.forEach((pa) => {
    const seen = new Set();
    pa.frags.filter((f) => zone(pa, f) && small(f)).forEach((f) => seen.add(key(f)));
    seen.forEach((k) => counts.set(k, (counts.get(k) || 0) + 1));
  });
  const minRepeat = raw.length < 8 ? 2 : 3;
  raw.forEach((pa) => {
    // The first/last line of a page, if it is only a small number, is a page number wherever it sits.
    const ends = pa.frags.length ? [
      pa.frags.reduce((a, b) => (b.top < a.top ? b : a)),
      pa.frags.reduce((a, b) => (b.bottom > a.bottom ? b : a)),
    ] : [];
    pa.frags = pa.frags.filter((f) => {
      if (!small(f)) return true;
      const k = key(f);
      const isNum = PAGE_NUM.test(k);
      if (isNum && ((wideZone(pa, f) && (alone(pa, f) || apart(pa, f))) || (ends.includes(f) && alone(pa, f)))) {
        if (PAGE_REF.test(f.text.trim())) pa.printed = f.text.trim();
        return false;
      }
      if (!zone(pa, f) || !apart(pa, f)) return true;
      // "6   Index" / "Getting Started   5": a margin line carrying this page's own printed number.
      const own = pdfLabels?.[raw.indexOf(pa)];
      if (own && f.text.length < 80) {
        const esc = own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`^${esc}\\s|\\s${esc}$`, 'i').test(f.text.trim())) { pa.printed = own; return false; }
      }
      if ((counts.get(k) || 0) >= minRepeat) {
        // "A Visit to the Dark Web 3": a running title with the page number inside it.
        const m = f.text.match(/(?:^|\s)(\d{1,4}|[ivxlcdm]{1,7})$|^(\d{1,4}|[ivxlcdm]{1,7})(?:\s|$)/i);
        if (m && !pa.printed) pa.printed = m[1] || m[2];
        return false;
      }
      return true;
    });
  });
}

/** Printed page numbers: the PDF's own page labels, else the numbers found in headers/footers. */
async function pageLabels(pdf, raw) {
  let labels = null;
  try { labels = await pdf.getPageLabels(); } catch { /* none */ }
  if (labels?.length === raw.length && labels.some((l, i) => l && l !== String(i + 1))) return labels.map((l, i) => l || String(i + 1));
  const out = raw.map((pa) => pa.printed || null);
  // Fill gaps between pages whose numbers agree (page 7 … page 9 ⇒ 8).
  const num = (s) => (/^\d+$/.test(s || '') ? +s : null);
  let last = -1;
  for (let i = 0; i < out.length; i++) {
    if (num(out[i]) == null) continue;
    if (last >= 0 && num(out[i]) - num(out[last]) === i - last) for (let k = last + 1; k < i; k++) out[k] = String(num(out[last]) + k - last);
    last = i;
  }
  const found = out.filter(Boolean).length;
  return found >= Math.min(3, raw.length) ? out.map((l, i) => l || `#${i + 1}`) : raw.map((_, i) => String(i + 1));
}

async function readOutline(pdf, raw) {
  const out = [];
  let outline = null;
  try { outline = await pdf.getOutline(); } catch { /* none */ }
  const walk = async (items, level) => {
    for (const it of items || []) {
      const pos = await resolveDest(pdf, it.dest, raw);
      out.push({ title: (it.title || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim(), level, pos });
      if (it.items?.length && level < 4) await walk(it.items, level + 1);
    }
  };
  await walk(outline, 1);
  return out;
}

/**
 * Letter-spaced titles ("A V I S I T  T O …") lose their word gaps in text extraction.
 * Recover them, in order of preference:
 *   1. the same letters elsewhere in the book (bookmarks, running titles, body text): copy its word breaks;
 *   2. split into words that occur in the book (dictionary built from the book itself);
 *   3. word breaks seen in the layout (gaps between pieces), else treat it as one word.
 * Letter case always comes from the title itself.
 */
function repairLetterSpacing(blocks, outline, meta) {
  const clean = (t) => t.replaceAll(WORD_BREAK, ' ');
  const spaced = (t) => {
    const tok = t.trim().split(/[\s\uE000]+/);
    return tok.length >= 4 && tok.filter((w) => w.length === 1).length >= 0.6 * tok.length && tok.every((w) => w.length <= 3);
  };
  const targets = blocks.filter((b) => b.runs && spaced(textOf(b)));
  const corpus = targets.length ? [
    ...outline.map((o) => o.title), meta?.info?.Title || '', meta?.info?.Subject || '',
    ...blocks.filter((b) => b.runs && !spaced(textOf(b))).map((b) => clean(textOf(b))),
    ...blocks.filter((b) => b.t === 'code').map((b) => b.text),
  ].join('\n') : '';
  // Flat index: alphanumerics only, lower-case, with a map back to positions in `corpus`.
  const isAN = (c) => /[\p{L}\p{N}]/u.test(c);
  const flat = [];
  const pos = [];
  for (let i = 0; i < corpus.length; i++) if (isAN(corpus[i])) { flat.push(corpus[i].toLowerCase()); pos.push(i); }
  const flatStr = flat.join('');
  const vocab = new Set(corpus.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));

  for (const b of targets) {
    const raw = textOf(b);
    const letters = [...raw].filter(isAN);
    const needle = letters.join('').toLowerCase();
    // Known breaks from the layout: letter index after which a word ends.
    const known = new Set();
    let n = 0;
    for (const ch of raw) { if (isAN(ch)) n++; else if (ch === WORD_BREAK && n) known.add(n - 1); }
    let breaks = null; // Map: letter index -> text to put after it
    const at = needle.length >= 4 ? flatStr.indexOf(needle) : -1;
    if (at >= 0) {
      breaks = new Map();
      for (let k = 0; k + 1 < letters.length; k++) {
        const gap = corpus.slice(pos[at + k] + 1, pos[at + k + 1]);
        if (gap) breaks.set(k, /\s/.test(gap) || gap.length > 1 ? (gap.trim() ? gap.replace(/\s+/g, ' ') : ' ') : gap);
      }
    } else {
      const words = segment(needle, vocab, known);
      if (words) {
        breaks = new Map();
        let k = -1;
        words.slice(0, -1).forEach((w) => { k += w.length; breaks.set(k, ' '); });
      } else {
        breaks = new Map([...known].map((k) => [k, ' ']));
      }
    }
    let out = '';
    letters.forEach((ch, k) => { out += ch + (breaks.get(k) || ''); });
    const style = b.runs[b.runs.length - 1];
    b.runs = [{ s: out, ...(style.b ? { b: 1 } : {}), ...(style.i ? { i: 1 } : {}) }];
  }
  // Remove any remaining markers.
  for (const b of blocks) if (b.runs) b.runs.forEach((r) => { r.s = clean(r.s); });
}

/** Split `s` into words from `vocab` (fewest words), honouring known breaks. null if impossible. */
function segment(s, vocab, known) {
  if (s.length > 120 || !vocab.size) return null;
  const best = new Array(s.length + 1).fill(null);
  best[0] = [];
  for (let i = 0; i < s.length; i++) {
    if (!best[i]) continue;
    for (let j = i + 1; j <= s.length && j - i <= 24; j++) {
      // A known break inside the candidate word rules it out.
      let crosses = false;
      for (let k = i; k < j - 1; k++) if (known.has(k)) { crosses = true; break; }
      if (crosses) break;
      const w = s.slice(i, j);
      if (!vocab.has(w) || (w.length === 1 && !/[ai0-9]/.test(w))) continue;
      if (!best[j] || best[j].length > best[i].length + 1) best[j] = [...best[i], w];
    }
  }
  return best[s.length];
}

function buildToc(blocks, outline) {
  const norm = (s) => s.toLowerCase().replace(/^(chapter\s+)?(\d+|[ivxlc]+)[.:)]?\s+/i, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const findBlock = (pg, y, title) => {
    const t = norm(title || '');
    if (t) {
      const hit = blocks.findIndex((b) => b.t === 'h' && b.pg >= pg && b.pg <= pg + 1 && b.y >= y - 6 && (norm(textOf(b)).endsWith(t) || norm(textOf(b)).startsWith(t) || t.startsWith(norm(textOf(b)) || '\u0000')));
      if (hit >= 0) return hit;
    }
    let idx = blocks.findIndex((b) => b.pg === pg && b.y >= y - 6);
    if (idx < 0) idx = blocks.findIndex((b) => b.pg >= pg);
    return idx;
  };
  const toc = [];
  for (const o of outline) {
    if (!o.pos) continue;
    const b = findBlock(o.pos.pg, o.pos.y, o.title);
    if (b >= 0) toc.push({ title: o.title, level: o.level, b, pg: o.pos.pg });
  }
  if (toc.length) {
    // Headings that are bookmarks take the bookmark's level; other headings fit in by size.
    const sizeLevel = new Map();
    for (const t of toc) {
      const h = blocks[t.b];
      if (h.t !== 'h') continue;
      h.l = t.level;
      const k = Math.round(h.fs || 0);
      if (!sizeLevel.has(k)) sizeLevel.set(k, t.level);
    }
    const marked = new Set(toc.map((t) => t.b));
    blocks.forEach((h, i) => {
      if (h.t !== 'h' || marked.has(i)) return;
      const k = Math.round(h.fs || 0);
      const bigger = [...sizeLevel].filter(([s]) => s > k).map(([, l]) => l);
      h.l = sizeLevel.get(k) ?? Math.min(4, bigger.length ? Math.max(...bigger) + 1 : 1);
    });
  } else {
    blocks.forEach((b, i) => {
      if (b.t === 'h' && b.l <= 3) toc.push({ title: textOf(b).trim(), level: b.l, b: i, pg: b.pg });
    });
  }
  return toc.sort((a, b) => a.b - b.b);
}

/** Contents lines → the block they point to (heading on the printed page, else the page start). */
function linkContentsLines(blocks, labels) {
  const byLabel = new Map();
  labels.forEach((l, i) => { if (l) byLabel.set(String(l).toLowerCase(), i); });
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  blocks.forEach((b) => {
    if (b.t !== 'tl') return;
    const pg = byLabel.get(String(b.num).toLowerCase().split(/[–-]/)[0]);
    if (pg == null) return;
    const title = norm(textOf(b)).replace(/^(chapter )?\d+ /, '');
    let to = blocks.findIndex((x) => x.t === 'h' && x.pg === pg && title && (norm(textOf(x)).includes(title) || title.includes(norm(textOf(x)))));
    if (to < 0) to = blocks.findIndex((x) => x.pg === pg && x.t !== 'tl');
    if (to < 0) to = blocks.findIndex((x) => x.pg > pg);
    if (to >= 0) b.to = to;
  });
}

async function resolveDest(pdf, dest, raw) {
  try {
    let d = dest;
    if (typeof d === 'string') d = await pdf.getDestination(d);
    if (!Array.isArray(d) || !d.length) return null;
    const ref = d[0];
    const pg = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
    const mode = d[1]?.name;
    let top = null;
    if (mode === 'XYZ') top = d[3];
    else if (mode === 'FitH' || mode === 'FitBH') top = d[2];
    else if (mode === 'FitR') top = d[5];
    const h = raw[pg]?.h ?? 0;
    const y = typeof top === 'number' ? Math.max(0, h - top) : 0;
    return { pg, y };
  } catch {
    return null;
  }
}
