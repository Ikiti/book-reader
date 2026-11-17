#!/usr/bin/env node
// PDF -> EPUB on the command line (Windows, Linux, macOS). Same engine as the app.
//
//   npm install
//   node tools/pdf2epub.mjs book.pdf                 -> book.epub next to it
//   node tools/pdf2epub.mjs "C:\Books" -o "C:\EPUB"  -> converts every PDF in the folder
//   options: -o <dir>  output folder   --lang <code>  force language (e.g. he, en)   --no-cover
//
// Runs fully offline; no tokens, no cloud.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { extractBook } from '../js/pdf/extract.js';
import { buildEpub } from '../js/epub/epub.js';
import { cleanTitle, safeFileName } from '../js/pdf/title.js';

const require = createRequire(import.meta.url);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
let createCanvas;
try {
  ({ createCanvas } = await import('@napi-rs/canvas'));
} catch {
  console.error('Missing @napi-rs/canvas (needed to cut out pictures). Run: npm install');
  process.exit(1);
}
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
const dirUrl = (d) => path.join(PDFJS_DIR, d) + path.sep;

function parseArgs(argv) {
  const o = { inputs: [], out: null, lang: null, cover: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') o.out = argv[++i];
    else if (a === '--lang') o.lang = argv[++i];
    else if (a === '--no-cover') o.cover = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else o.inputs.push(a);
  }
  return o;
}

async function render(page, scale) {
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
  return canvas;
}

const jpeg = async (canvas, q = 90) => new Uint8Array(await canvas.encode('jpeg', q));

async function convert(file, opts) {
  const t0 = Date.now();
  const data = new Uint8Array(await fs.readFile(file));
  // Hash first: pdf.js takes ownership of (detaches) the buffer.
  const id = Buffer.from(await crypto.subtle.digest('SHA-256', data)).toString('hex');
  const task = pdfjs.getDocument({
    data,
    verbosity: 0,
    cMapUrl: dirUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: dirUrl('standard_fonts'),
    wasmUrl: dirUrl('wasm'),
    iccUrl: dirUrl('iccs'),
  });
  const pdf = await task.promise;
  try {
    const cropper = async (pageNumber, rects) => {
      const page = await pdf.getPage(pageNumber);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, 2800 / Math.max(vp1.width, vp1.height));
      const canvas = await render(page, scale);
      const out = [];
      for (const r of rects) {
        const x = Math.max(0, Math.floor(r.x0 * scale));
        const y = Math.max(0, Math.floor(r.y0 * scale));
        const w = Math.min(canvas.width - x, Math.ceil((r.x1 - r.x0) * scale));
        const h = Math.min(canvas.height - y, Math.ceil((r.y1 - r.y0) * scale));
        if (w < 2 || h < 2) { out.push(null); continue; }
        const c = createCanvas(w, h);
        const cx = c.getContext('2d');
      cx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      cx.fillStyle = '#fff';
      for (const m of r.masks || []) cx.fillRect(m.x0 * scale - x, m.y0 * scale - y, (m.x1 - m.x0) * scale, (m.y1 - m.y0) * scale);
        out.push(await jpeg(c));
      }
      page.cleanup();
      return out;
    };
    let lastPct = -1;
    const { model, images } = await extractBook(pdfjs, pdf, {
      cropper,
      onProgress: (done, total, phase) => {
        const pct = Math.floor((phase === 'analyze' ? done / total * 85 : 85 + done / total * 15));
        if (pct !== lastPct && process.stdout.isTTY) { process.stdout.write(`\r  ${pct}% `); lastPct = pct; }
      },
    });
    const meta = await pdf.getMetadata().catch(() => null);
    const title = cleanTitle(meta?.info?.Title?.trim(), path.basename(file), model);
    const author = meta?.info?.Author?.trim() || '';
    let cover = null;
    if (opts.cover) {
      const p1 = await pdf.getPage(1);
      const vp = p1.getViewport({ scale: 1 });
      cover = { data: await jpeg(await render(p1, 1000 / vp.width), 85), mime: 'image/jpeg', ext: 'jpg' };
    }
    const imgMap = new Map();
    images.forEach((bytes, k) => { if (bytes) imgMap.set(k, { data: bytes, mime: 'image/jpeg', ext: 'jpg' }); });
    const epub = await buildEpub({ id, title, author, model, images: imgMap, cover, lang: opts.lang || undefined });

    const outDir = opts.out || path.dirname(file);
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, `${safeFileName(path.basename(file, path.extname(file)))}.epub`);
    await fs.writeFile(outFile, epub);
    if (process.stdout.isTTY) process.stdout.write('\r');
    const notes = [];
    if (model.scannedPages) notes.push(`${model.scannedPages} scanned page(s) kept as pictures — see README › OCR`);
    console.log(`✔ ${path.basename(file)} → ${outFile}  (${model.pageCount} pages, ${model.toc.length} TOC entries, ${model.blocks.filter((b) => b.t === 'img' || b.t === 'scan').length} pictures, ${model.blocks.filter((b) => b.t === 'table').length} tables, ${(epub.length / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)} s)${notes.length ? '\n  ⚠ ' + notes.join('; ') : ''}`);
    return outFile;
  } finally {
    await task.destroy();
  }
}

async function collect(inputs) {
  const files = [];
  for (const inp of inputs) {
    const st = await fs.stat(inp).catch(() => null);
    if (!st) { console.error(`Not found: ${inp}`); continue; }
    if (st.isDirectory()) {
      for (const f of await fs.readdir(inp)) if (/\.pdf$/i.test(f)) files.push(path.join(inp, f));
    } else files.push(inp);
  }
  return files;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.inputs.length) {
  console.log('Usage: node tools/pdf2epub.mjs <file.pdf | folder> [...] [-o outDir] [--lang he] [--no-cover]');
  process.exit(opts.help ? 0 : 1);
}
let failed = 0;
for (const f of await collect(opts.inputs)) {
  try { await convert(f, opts); } catch (e) { failed++; console.error(`✘ ${f}: ${e.message || e}`); }
}
process.exit(failed ? 1 : 0);
