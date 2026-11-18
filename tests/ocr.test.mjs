// OCR tests. samples/scanned-sample.pdf is samples/sample-book.pdf printed to pictures (200 dpi JPEG,
// no text layer): the OCR'd book should look like the original (headings, paragraphs, list, table).
// samples/scanned-figures.pdf is a tilted scan with a screenshot and a diagram (must stay pictures).
// Usage: node tests/ocr.test.mjs [file.pdf] [--dump]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { extractBook } from '../js/pdf/extract.js';
import { nodeOcr } from '../tools/node-ocr.mjs';
import { rotationTransform } from '../js/ocr/skew.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const file = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(here, '../samples/scanned-sample.pdf');

async function render(page, scale, rotate = 0) {
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const transform = rotate ? rotationTransform(canvas.width, canvas.height, rotate) : undefined;
  await page.render({ canvasContext: ctx, viewport: vp, canvas, transform }).promise;
  return canvas;
}

const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
const t0 = Date.now();
const { model } = await extractBook(pdfjs, pdf, { cropper: async (_p, rects) => rects.map(() => ({ fake: true })), ocr: nodeOcr(pdf, 'auto', render) });
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const text = (b) => (b.runs || []).map((r) => r.s).join('');
if (process.argv.includes('--dump') || process.argv[2]) {
  for (const b of model.blocks) {
    const tag = b.t === 'h' ? `h${b.l}` : b.t;
    const body = b.t === 'table' ? JSON.stringify(b.rows.map((r) => r.map((c) => c.s))) : b.t === 'img' || b.t === 'scan' ? `${b.w}x${b.h}` : text(b);
    console.log(`[p${b.pg + 1}] ${tag.padEnd(5)}${b.li ? '•' : ' '} ${body.slice(0, process.env.FULL ? 9999 : 120)}`);
  }
}
if (process.argv[2] && !process.argv[2].startsWith('--')) process.exit(0);

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ocr: ${name}`); if (!cond) failed++; };
const heads = model.blocks.filter((b) => b.t === 'h').map(text);
const paras = model.blocks.filter((b) => b.t === 'p').map(text);
const all = model.blocks.map(text).join('\n');
check(`all 4 pages read with OCR (${secs} s)`, model.ocrPages === 4 && !model.needsOcr);
check('4 chapter headings', [1, 2, 3, 4].every((n) => heads.some((h) => h.startsWith(`Chapter ${n}`))));
check('running header and page numbers removed', !paras.some((p) => p === 'The Pocket Guide to Reading Software' || /^\d+$/.test(p.trim())));
const wrapped = paras.find((p) => p.startsWith('Reading on a phone'));
check('wrapped lines joined into one paragraph', wrapped && /main job of\s+this reader\.$/.test(wrapped));
check('3 bullet list items', model.blocks.filter((b) => b.li).length === 3);
check('figure kept as a picture', model.blocks.some((b) => b.t === 'img'));
check('caption is text', paras.some((p) => p.startsWith('Figure 1.')));
const tbl = model.blocks.find((b) => b.t === 'table');
check('table found with 4 columns', tbl && tbl.rows.length >= 4 && tbl.rows.every((r) => r.length === 4));
check('table header cell', tbl && /^Format$/.test(tbl.rows[0][0].s.trim()));
const iLeft = all.indexOf('left column ends here');
const iRight = all.indexOf('right column starts here');
check('two-column reading order', iLeft > 0 && iRight > iLeft);
// A tilted scan (0.6°) with a screenshot, a diagram, a list of paths and a ruled table.
{
  const pdf2 = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(here, '../samples/scanned-figures.pdf'))), verbosity: 0 }).promise;
  const t1 = Date.now();
  const { model: m } = await extractBook(pdfjs, pdf2, { cropper: async (_p, rects) => rects.map(() => ({ fake: true })), ocr: nodeOcr(pdf2, 'auto', render) });
  const ps = m.blocks.filter((b) => b.t === 'p').map(text);
  const kinds = m.blocks.map((b) => b.t);
  check(`figures: tilted page read (${((Date.now() - t1) / 1000).toFixed(1)} s)`, m.ocrPages === 1);
  check('figures: the opening paragraph is whole (tilt corrected)', ps[0]?.startsWith('A proximity service') && /narrow side bar\.$/.test(ps[0]));
  check('figures: screenshot and diagram are pictures', kinds.filter((k) => k === 'img').length === 2);
  check('figures: each picture is followed by its caption', m.blocks.every((b, i) => b.t !== 'img' || /^Figure \d:/.test(text(m.blocks[i + 1] || {}))));
  check('figures: no text from inside the figures', !ps.some((p) => /Noodles|Bird|Load balancer|Market St|Mobile user/.test(p)));
  check('figures: list of paths stays text', m.blocks.filter((b) => b.li).map(text).join('|').includes('System32\\spool\\drivers\\color'));
  const t = m.blocks.find((b) => b.t === 'table');
  check('figures: ruled table read row by row', t && t.rows.length === 3 && t.rows[0].map((c) => c.s.trim()).join('|') === 'Store|Reads|Writes' && t.rows[2][1].s.trim() === 'Medium');
}

console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
