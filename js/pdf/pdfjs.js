// Browser-side pdf.js setup plus page rendering helpers (crops, cover, original-page view).
import * as pdfjsLib from '../../vendor/pdfjs/pdf.min.mjs';
import { extractBook } from './extract.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

export { pdfjsLib };

const VENDOR = new URL('../../vendor/pdfjs/', import.meta.url).href;

export async function openPdf(data) {
  const task = pdfjsLib.getDocument({
    data,
    // Everything is served locally (no CDN), so it works offline.
    cMapUrl: `${VENDOR}cmaps/`, // CJK and other non-Latin encodings
    cMapPacked: true,
    standardFontDataUrl: `${VENDOR}standard_fonts/`, // the 14 PDF base fonts when not embedded
    wasmUrl: `${VENDOR}wasm/`, // JPEG 2000 / JBIG2 decoders (common in scanned books)
    iccUrl: `${VENDOR}iccs/`,
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const pdf = await task.promise;
  pdf.close = () => task.destroy(); // pdf.js API for freeing the worker side changed across versions
  return pdf;
}

// JPEG: universally supported by EPUB readers (WebP is not), so crops can go into an EPUB as-is.
const canvasToBlob = (canvas, type = 'image/jpeg', q = 0.9) =>
  new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, q));

/** Render a page to a canvas at `scale` (CSS px per PDF pt). */
export async function renderPage(page, scale, canvas = document.createElement('canvas')) {
  const vp = page.getViewport({ scale });
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

/** Make a cropper for extractBook: renders the page once and cuts out each rect. */
function makeCropper(pdf) {
  return async (pageNumber, rects) => {
    const page = await pdf.getPage(pageNumber);
    const vp1 = page.getViewport({ scale: 1 });
    // ~2x for sharp figures, capped so huge pages don't blow up memory.
    const scale = Math.min(2.5, 2800 / Math.max(vp1.width, vp1.height));
    const canvas = await renderPage(page, scale);
    const out = [];
    for (const r of rects) {
      const x = Math.max(0, Math.floor(r.x0 * scale));
      const y = Math.max(0, Math.floor(r.y0 * scale));
      const w = Math.min(canvas.width - x, Math.ceil((r.x1 - r.x0) * scale));
      const h = Math.min(canvas.height - y, Math.ceil((r.y1 - r.y0) * scale));
      if (w < 2 || h < 2) { out.push(null); continue; }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const cx = c.getContext('2d');
      cx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      cx.fillStyle = '#fff';
      for (const m of r.masks || []) cx.fillRect(m.x0 * scale - x, m.y0 * scale - y, (m.x1 - m.x0) * scale, (m.y1 - m.y0) * scale);
      out.push(await canvasToBlob(c));
    }
    canvas.width = canvas.height = 0; // free memory early
    page.cleanup();
    return out;
  };
}

export async function makeCover(pdf) {
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const canvas = await renderPage(page, 360 / vp.width);
  return canvasToBlob(canvas, 'image/jpeg', 0.85);
}

const TESS = new URL('../../vendor/tesseract/', import.meta.url).href;

/**
 * OCR for picture-only pages (scans, PDFs made of page images). Tesseract (~4 MB engine + language
 * data) runs in its own worker and is only downloaded when the first such page shows up; after
 * that the service worker keeps it for offline use.
 */
function browserOcr(pdf, langs) {
  let inner = null;
  const init = async () => {
    const [{ default: Tesseract }, { makeOcr }] = await Promise.all([
      import('../../vendor/tesseract/tesseract.esm.min.js'),
      import('../ocr/provider.js'),
    ]);
    return makeOcr({
      createWorker: Tesseract.createWorker,
      langs,
      workerOptions: {
        workerPath: `${TESS}worker.min.js`,
        corePath: `${TESS}core`, // the worker picks the fastest build this device supports
        langPath: `${TESS}lang`,
        gzip: true,
        cacheMethod: 'none', // the service worker caches the files instead
        workerBlobURL: false,
      },
      render: async (pageNumber) => {
        const page = await pdf.getPage(pageNumber);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = Math.min(3.5, 2000 / vp1.width); // ~240 dpi for A4: enough for small print and code
        const canvas = await renderPage(page, scale);
        const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        page.cleanup();
        return { image: canvas, rgba, scale };
      },
    });
  };
  return {
    async page(n, w, h) { if (!inner) inner = await init(); return inner.page(n, w, h); },
    async close() { await inner?.close(); inner = null; },
  };
}

/**
 * Full import pipeline for one PDF file.
 * @param {object} [opts]  {ocr: 'auto' | 'eng' | 'heb' | 'eng+heb' | 'off'}
 */
export async function processPdf(arrayBuffer, onProgress, opts = {}) {
  const pdf = await openPdf(new Uint8Array(arrayBuffer));
  try {
    const meta = await pdf.getMetadata().catch(() => null);
    const ocr = opts.ocr === 'off' ? null : browserOcr(pdf, opts.ocr || 'auto');
    const { model, images } = await extractBook(pdfjsLib, pdf, { cropper: makeCropper(pdf), ocr, onProgress });
    const cover = await makeCover(pdf);
    return {
      model,
      images,
      cover,
      title: meta?.info?.Title?.trim() || '',
      author: meta?.info?.Author?.trim() || '',
    };
  } finally {
    pdf.close();
  }
}
