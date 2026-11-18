// Tesseract OCR for Node (command line and tests). Same provider as the app; the worker and the
// language data load only when the first picture-only page shows up.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOcr } from '../js/ocr/provider.js';

const LANG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'tesseract', 'lang');

/**
 * @param pdf     pdf.js document
 * @param langs   'auto' | 'eng' | 'heb' | 'eng+heb'
 * @param render  async (page, scale, rotate) => @napi-rs/canvas Canvas (rotate: degrees to straighten)
 */
export function nodeOcr(pdf, langs, render) {
  let inner = null;
  const init = async () => {
    const { createWorker } = (await import('tesseract.js')).default;
    return makeOcr({
      createWorker,
      langs,
      workerOptions: { langPath: LANG_DIR, cacheMethod: 'none', gzip: true },
      render: async (pageNumber, rotate = 0) => {
        const page = await pdf.getPage(pageNumber);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = Math.min(3.5, 2000 / vp1.width); // ~240 dpi for A4: good for small print and code
        const canvas = await render(page, scale, rotate);
        const ctx = canvas.getContext('2d');
        const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height);
        page.cleanup();
        const erase = async (rects) => {
          ctx.fillStyle = '#fff';
          for (const q of rects) ctx.fillRect(q.x0, q.y0, q.x1 - q.x0, q.y1 - q.y0);
          return canvas.encode('png');
        };
        return { image: await canvas.encode('png'), rgba, scale, erase };
      },
    });
  };
  return {
    async page(n, w, h) { if (!inner) inner = await init(); return inner.page(n, w, h); },
    async close() { await inner?.close(); inner = null; },
  };
}
