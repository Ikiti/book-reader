// OCR provider shared by the app and the command line: owns the Tesseract worker, picks the
// language automatically (English / Hebrew / both) and turns each page into a page description.
import { analyzeRaster } from './raster.js';
import { ocrPage } from './page.js';

/**
 * Tesseract's page layout step sometimes drops a block (often a large heading). Read any ink that
 * looks like a line of text but produced no words, one line at a time, and add it to the result.
 */
async function secondPass(worker, image, data, raster) {
  const words = (data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => (p.lines || []).flatMap((l) => l.words || [])));
  const missed = raster.uncovered(words.map((w) => w.bbox)).lines.slice(0, 12);
  if (!missed.length) return;
  await worker.setParameters({ tessedit_pageseg_mode: '7' }); // single text line
  try {
    for (const m of missed) {
      const pad = 6;
      const rectangle = { left: Math.max(0, m.x0 - pad), top: Math.max(0, m.y0 - pad), width: m.x1 - m.x0 + 2 * pad, height: m.y1 - m.y0 + 2 * pad };
      const { data: d } = await worker.recognize(image, { rectangle }, { blocks: true, text: true });
      const text = (d.text || '').trim();
      if (d.confidence < 60 || !/\p{L}{2}/u.test(text)) continue;
      // Keep only words the first pass did not already read (a dark bar behind text looks "unread").
      const overlaps = (a) => words.some((b) => Math.min(a.x1, b.bbox.x1) - Math.max(a.x0, b.bbox.x0) > 0.3 * (a.x1 - a.x0)
        && Math.min(a.y1, b.bbox.y1) - Math.max(a.y0, b.bbox.y0) > 0.3 * (a.y1 - a.y0));
      for (const blk of d.blocks || []) {
        for (const par of blk.paragraphs || []) for (const ln of par.lines || []) ln.words = (ln.words || []).filter((w) => !overlaps(w.bbox));
        if (blk.paragraphs?.some((par) => par.lines?.some((ln) => ln.words.length))) data.blocks.push(blk);
      }
    }
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '3' }); // back to automatic layout
  }
}

export const OCR_LANGS = { auto: 'Automatic (English / Hebrew)', eng: 'English', heb: 'Hebrew', 'eng+heb': 'English + Hebrew' };

/**
 * @param {object} o
 * @param {Function} o.createWorker   Tesseract.createWorker
 * @param {object}   o.workerOptions  {langPath, corePath, workerPath, …}
 * @param {Function} o.render         async (pageNumber) => {image, rgba: {data,width,height}, scale}
 * @param {string}   [o.langs='auto'] 'auto' | 'eng' | 'heb' | 'eng+heb'
 */
export function makeOcr({ createWorker, workerOptions, render, langs = 'auto' }) {
  let worker = null;
  let current = langs === 'auto' ? 'eng+heb' : langs;
  let decided = langs !== 'auto';

  return {
    get langs() { return current; },
    /** OCR one page; returns a page description for the layout engine. */
    async page(pageNumber, pageW, pageH) {
      const r = await render(pageNumber);
      // A designed page (cover, poster: mostly ink) stays a picture; no need to read it.
      const raster = analyzeRaster(r.rgba);
      if (raster.darkRatio > 0.4) return { w: pageW, h: pageH, frags: [], poster: true };
      if (!worker) worker = await createWorker(current.split('+'), 1, workerOptions);
      // Tell Tesseract the resolution (it otherwise guesses, and prints about it, for small areas).
      await worker.setParameters({ user_defined_dpi: String(Math.round(r.scale * 72)) });
      const { data } = await worker.recognize(r.image, {}, { blocks: true, text: true });
      if (!decided) {
        // The first page with real text decides: drop the language that isn't there (faster, more accurate).
        const text = data.text || '';
        const heb = (text.match(/[֐-׿]/g) || []).length;
        const lat = (text.match(/[A-Za-z]/g) || []).length;
        if (heb + lat > 200) {
          decided = true;
          const next = heb < 0.05 * (heb + lat) ? 'eng' : lat < 0.05 * (heb + lat) ? 'heb' : 'eng+heb';
          if (next !== current) {
            current = next;
            await worker.reinitialize(current.split('+'), 1);
            return this.page(pageNumber, pageW, pageH); // read this page again with the right language
          }
        }
      }
      await secondPass(worker, r.image, data, raster);
      return ocrPage(data, raster, r.scale, pageW, pageH);
    },
    async close() { if (worker) await worker.terminate(); worker = null; },
  };
}
