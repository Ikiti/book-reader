// Copy the browser libraries from node_modules into vendor/ (run after changing their versions):
//   npm install && npm run vendor
//   vendor/pdfjs     pdf.js + fonts, CJK maps, image decoders; files.json = what the service worker precaches
//   vendor/tesseract OCR: tesseract.js, its WebAssembly cores (LSTM only) and English/Hebrew models
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const src = path.dirname(require.resolve('pdfjs-dist/package.json'));
const dst = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'pdfjs');
await fs.rm(dst, { recursive: true, force: true });
await fs.mkdir(dst, { recursive: true });
for (const f of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE']) await fs.copyFile(path.join(src, f), path.join(dst, path.basename(f)));
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await fs.cp(path.join(src, d), path.join(dst, d), { recursive: true });
// Precache everything except the (large, CJK-only) cmaps; those are cached on first use.
const list = [];
for (const d of ['standard_fonts', 'wasm', 'iccs']) for (const f of await fs.readdir(path.join(dst, d))) if (!/^LICENSE/.test(f)) list.push(`./vendor/pdfjs/${d}/${f}`);
await fs.writeFile(path.join(dst, 'files.json'), JSON.stringify(list, null, 1));
const { version } = JSON.parse(await fs.readFile(path.join(src, 'package.json'), 'utf8'));
console.log(`pdf.js ${version} vendored (${list.length} precached data files)`);

// ---- Tesseract (OCR) ----
const tdir = path.join(dst, '..', 'tesseract');
await fs.rm(tdir, { recursive: true, force: true });
await fs.mkdir(path.join(tdir, 'core'), { recursive: true });
await fs.mkdir(path.join(tdir, 'lang'), { recursive: true });
const tjs = path.dirname(require.resolve('tesseract.js/package.json'));
const core = path.dirname(require.resolve('tesseract.js-core/package.json'));
for (const f of ['tesseract.esm.min.js', 'worker.min.js']) await fs.copyFile(path.join(tjs, 'dist', f), path.join(tdir, f));
await fs.copyFile(path.join(tjs, 'LICENSE.md'), path.join(tdir, 'LICENSE.md')).catch(() => fs.copyFile(path.join(tjs, 'LICENSE'), path.join(tdir, 'LICENSE')));
// LSTM-only engines: plain, SIMD and relaxed-SIMD (tesseract.js picks one per device).
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) await fs.copyFile(path.join(core, f), path.join(tdir, 'core', f));
await fs.copyFile(path.join(core, 'LICENSE'), path.join(tdir, 'core', 'LICENSE'));
for (const lang of ['eng', 'heb']) {
  const d = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
  await fs.copyFile(path.join(d, '4.0.0_best_int', `${lang}.traineddata.gz`), path.join(tdir, 'lang', `${lang}.traineddata.gz`));
}
const tv = JSON.parse(await fs.readFile(path.join(tjs, 'package.json'), 'utf8')).version;
console.log(`tesseract.js ${tv} vendored (OCR: eng, heb)`);
