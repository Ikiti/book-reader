// Copy pdf.js from node_modules into vendor/pdfjs (run after changing the pdfjs-dist version):
//   npm install && npm run vendor
// Also writes vendor/pdfjs/files.json, which the service worker precaches for offline use.
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
