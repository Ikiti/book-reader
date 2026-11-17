// PDF -> reflowable book model.
//
// Model (stored in IndexedDB, rendered by reader.js):
// {
//   v: EXTRACT_VERSION, pageCount, pages: [{w, h}], bodySize, needsOcr,
//   blocks: [ {t:'h', l, runs, pg, y} | {t:'p', runs, pg, y, li?, rtl?}
//           | {t:'img', k, w, h, pg, y} | {t:'table', rows, k, pg, y} | {t:'scan', k, pg, y} ],
//   toc: [{title, level, b /* block index */, pg}]
// }
// runs: [{s, b?, i?}]; images are returned separately as Blobs and referenced by index `k`.

import { analyzePage } from './analyze.js';
import { findRegions } from './regions.js';
import { buildBlocks, orderPage } from './layout.js';
import { weightedMode } from './geometry.js';

export const EXTRACT_VERSION = 1;

const PAGE_NUM = /^(page\s*)?#(\s*(of|\/)\s*#)?$|^[-–—]\s*#\s*[-–—]$|^[ivxlcdm]+$/i;

/**
 * @param {object} pdfjs  pdf.js module
 * @param {object} pdf    PDFDocumentProxy
 * @param {object} opts
 *   cropper(pageNumber, rects, scale) -> Promise<Blob[]>   renders a page and crops rects (browser only)
 *   onProgress(done, total, phase)
 */
export async function extractBook(pdfjs, pdf, { cropper, onProgress } = {}) {
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
    raw.push(pa);
    onProgress?.(p, n, 'analyze');
  }

  removeRunningHeaders(raw);
  const bodySize = weightedMode(raw.flatMap((pa) => pa.frags.map((f) => [f.fs, f.chars])), 0.5) || 11;
  const ordered = raw.map((pa) => orderPage(pa, pa.frags, pa.regions));
  const blocks = buildBlocks(ordered, raw, bodySize);

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
    const rects = list.map((b) => ({ x0: b.rect.x0 - pad, y0: b.rect.y0 - pad, x1: b.rect.x1 + pad, y1: b.rect.y1 + pad }));
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

  const toc = await buildToc(pdf, blocks, raw);
  const scannedPages = raw.filter((pa) => pa.scanned).length;
  return {
    model: {
      v: EXTRACT_VERSION,
      pageCount: n,
      pages: raw.map((pa) => ({ w: Math.round(pa.w), h: Math.round(pa.h) })),
      bodySize,
      needsOcr: scannedPages > 0,
      scannedPages,
      blocks,
      toc,
    },
    images,
  };
}

/** Drop page numbers and lines repeated in the top/bottom margin of many pages. */
function removeRunningHeaders(raw) {
  const zone = (pa, f) => f.top < pa.h * 0.1 || f.bottom > pa.h * 0.9;
  const wideZone = (pa, f) => f.top < pa.h * 0.13 || f.bottom > pa.h * 0.87;
  // A page number stands alone on its line.
  const alone = (pa, f) => !pa.frags.some((o) => o !== f && o.bottom > f.top && o.top < f.bottom);
  const key = (f) => f.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const counts = new Map();
  raw.forEach((pa) => {
    const seen = new Set();
    pa.frags.filter((f) => zone(pa, f)).forEach((f) => seen.add(key(f)));
    seen.forEach((k) => counts.set(k, (counts.get(k) || 0) + 1));
  });
  const minRepeat = Math.max(2, Math.ceil(raw.length * 0.4));
  raw.forEach((pa) => {
    // The first/last line of a page, if it is only a number, is a page number wherever it sits.
    const ends = pa.frags.length ? [
      pa.frags.reduce((a, b) => (b.top < a.top ? b : a)),
      pa.frags.reduce((a, b) => (b.bottom > a.bottom ? b : a)),
    ] : [];
    pa.frags = pa.frags.filter((f) => {
      const k = key(f);
      if (PAGE_NUM.test(k) && (wideZone(pa, f) || ends.includes(f)) && alone(pa, f)) return false;
      if (!zone(pa, f)) return true;
      return (counts.get(k) || 0) < minRepeat;
    });
  });
}

async function buildToc(pdf, blocks, raw) {
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const textOf = (b) => (b.runs ? b.runs.map((r) => r.s).join('') : '');
  const firstBlockAt = (pg, y, title) => {
    // Prefer a heading on that page (or the next) whose text matches the outline title.
    const t = norm(title || '');
    if (t) {
      const hit = blocks.findIndex((b) => b.t === 'h' && b.pg >= pg && b.pg <= pg + 1 && b.y >= y - 6 && (norm(textOf(b)).startsWith(t) || t.startsWith(norm(textOf(b)) || '\u0000')));
      if (hit >= 0) return hit;
    }
    let idx = blocks.findIndex((b) => b.pg === pg && b.y >= y - 6);
    if (idx < 0) idx = blocks.findIndex((b) => b.pg >= pg);
    return idx;
  };
  const toc = [];
  let outline = null;
  try { outline = await pdf.getOutline(); } catch { /* none */ }
  if (outline?.length) {
    const walk = async (items, level) => {
      for (const it of items) {
        const pos = await resolveDest(pdf, it.dest, raw);
        if (pos) {
          const b = firstBlockAt(pos.pg, pos.y, it.title);
          if (b >= 0) toc.push({ title: (it.title || '').trim(), level, b, pg: pos.pg });
        }
        if (it.items?.length && level < 4) await walk(it.items, level + 1);
      }
    };
    await walk(outline, 1);
  }
  if (!toc.length) {
    blocks.forEach((b, i) => {
      if (b.t === 'h' && b.l <= 3) toc.push({ title: b.runs.map((r) => r.s).join('').trim(), level: b.l, b: i, pg: b.pg });
    });
  }
  return toc.sort((a, b) => a.b - b.b);
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
