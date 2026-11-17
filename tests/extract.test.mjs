// Node test for the extraction pipeline (no rendering; image crops are stubbed).
// Usage: node tests/extract.test.mjs [file.pdf] [--dump]
// Needs pdfjs-dist installed (npm i pdfjs-dist) or PDFJS env var pointing at legacy/build/pdf.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBook } from '../js/pdf/extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pdfjsPath = process.env.PDFJS || 'pdfjs-dist/legacy/build/pdf.mjs';
const pdfjs = await import(pdfjsPath);

const file = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(here, '../samples/sample-book.pdf');
const dump = process.argv.includes('--dump');
const data = new Uint8Array(fs.readFileSync(file));
const pdf = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
const fakeBlob = { fake: true };
const { model, images } = await extractBook(pdfjs, pdf, { cropper: async (_p, rects) => rects.map(() => fakeBlob) });

const text = (b) => (b.runs || []).map((r) => r.s).join('');
if (dump || process.argv[2]) {
  for (const b of model.blocks) {
    const tag = b.t === 'h' ? `h${b.l}` : b.t;
    const body = b.t === 'table' ? JSON.stringify(b.rows.map((r) => r.map((c) => c.s))) : b.t === 'img' || b.t === 'scan' ? `${b.w}x${b.h} k=${b.k}` : text(b);
    console.log(`[p${b.pg + 1}] ${tag.padEnd(5)} ${body.slice(0, 140)}`);
  }
  console.log('TOC', model.toc);
}

if (process.argv[2] && !file.endsWith('sample-book.pdf')) process.exit(0);

// Assertions for samples/sample-book.pdf
let failed = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failed++; };
const all = model.blocks.map(text).join('\n');
const heads = model.blocks.filter((b) => b.t === 'h').map(text);
check('4 pages', model.pageCount === 4);
check('title is one heading', heads.includes('The Pocket Guide to Reading Software'));
check('4 chapter headings', ['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4'].every((c) => heads.some((h) => h.startsWith(c))));
check('running header removed', !model.blocks.some((b) => b.t === 'p' && text(b) === 'The Pocket Guide to Reading Software'));
check('page numbers removed', !model.blocks.some((b) => /^\d+$/.test(text(b).trim())));
check('one image', model.blocks.filter((b) => b.t === 'img').length === 1 && images.length >= 2);
const tbl = model.blocks.find((b) => b.t === 'table');
check('table 5x4', tbl && tbl.rows.length === 5 && tbl.rows.every((r) => r.length === 4));
check('table cells', tbl && tbl.rows[0][0].s === 'Format' && tbl.rows[4][3].s === 'Old books' && tbl.rows[0][0].b);
check('table text not duplicated in flow', !model.blocks.some((b) => b.t === 'p' && text(b).includes('Needs work')));
check('caption after image', (() => { const i = model.blocks.findIndex((b) => b.t === 'img'); return text(model.blocks[i + 1]).startsWith('Figure 1.'); })());
check('bullets are list items', model.blocks.filter((b) => b.li).length === 3);
const paraWrap = model.blocks.find((b) => text(b).startsWith('Reading on a phone'));
check('wrapped lines joined into one paragraph', paraWrap && text(paraWrap).endsWith('main job of this reader.'));
const iLeft = all.indexOf('The left column ends here');
const iRight = all.indexOf('The right column starts here');
const iLast = all.indexOf('This is the last paragraph');
check('two-column order', iLeft > 0 && iRight > iLeft && iLast > iRight);
check('toc from outline', model.toc.length === 4 && model.toc.every((t, i) => text(model.blocks[t.b]).startsWith(`Chapter ${i + 1}`)));
// ---- samples/tech-sample.pdf: book-style layouts (contents, page labels, code, notes, index) ----
{
  const tdata = new Uint8Array(fs.readFileSync(path.join(here, '../samples/tech-sample.pdf')));
  const tpdf = await pdfjs.getDocument({ data: tdata, verbosity: 0 }).promise;
  const { model: m } = await extractBook(pdfjs, tpdf, { cropper: async (_p, rects) => rects.map(() => fakeBlob) });
  const B = m.blocks;
  const T = (b) => (b ? (b.text != null ? b.text : text(b)) : '');
  check('tech: printed page labels', m.labels.join(',') === 'v,1,2,3,4,5,6');
  check('tech: letter-spaced titles repaired', B.some((b) => b.t === 'h' && T(b) === 'CONTENTS') && B.some((b) => b.t === 'h' && T(b) === '1 GETTING STARTED'));
  const tl = B.filter((b) => b.t === 'tl');
  check('tech: contents lines keep page numbers', tl.map((b) => b.num).join(',') === '1,2,4,6');
  check('tech: contents lines link to their headings', tl.every((b) => b.to != null && B[b.to].t === 'h' && T(B[b.to]).toLowerCase().includes(T(b).toLowerCase())));
  check('tech: contents sub-entries indented', tl[1].lvl === 1 && tl[0].lvl === 0);
  check('tech: bullets with a separate bullet glyph', B.filter((b) => b.li).length === 3);
  const code = B.find((b) => b.t === 'code');
  check('tech: code keeps lines and indentation', code && code.text === 'sudo apt install -y \\\n    python3-pip binutils\npip install pefile   # parse PE files');
  check('tech: listing caption follows code', T(B[B.indexOf(code) + 1]).startsWith('Listing 1-1'));
  const note = B.find((b) => b.note);
  check('tech: NOTE box from margin label', note && note.note === 'NOTE' && T(note).startsWith('If the installation fails'));
  check('tech: running footers removed', !B.some((b) => /Chapter 1$|Getting Started \d$|^\d+ Index$/.test(T(b))));
  const il = B.filter((b) => b.t === 'il');
  check('tech: index lines', il.length === 15 && il.some((b) => b.lvl === 1 && T(b) === 'virtual machine, 1'));
  check('tech: wrapped index entry joined', il.some((b) => T(b) === 'command line tools for executable files, 2, 4'));
  check('tech: index title is a heading, first on its page', B.find((b) => b.pg === 6).t === 'h');
}

console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
