// PDF -> EPUB test: runs the CLI on the samples, then checks the EPUB structure.
// Set EPUBCHECK=/path/to/epubcheck.jar to also run the official validator.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-'));
execFileSync(process.execPath, [path.join(root, 'tools/pdf2epub.mjs'), path.join(root, 'samples'), '-o', out], { stdio: 'inherit' });

/** Tiny ZIP reader (central directory + raw deflate). */
async function unzip(file) {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const data = method === 8
      ? Buffer.from(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
      : raw;
    entries.push({ name, method, extra: lelen, data });
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failed++; };

const book = await unzip(path.join(out, 'sample-book.epub'));
const txt = (n) => book.find((e) => e.name === n)?.data.toString('utf8') || '';
check('mimetype first, stored, no extra field', book[0].name === 'mimetype' && book[0].method === 0 && book[0].extra === 0 && txt('mimetype') === 'application/epub+zip');
check('container points to OPF', txt('META-INF/container.xml').includes('OEBPS/content.opf'));
const opf = txt('OEBPS/content.opf');
check('title + language', opf.includes('<dc:title>The Pocket Guide to Reading Software</dc:title>') && opf.includes('<dc:language>en</dc:language>'));
check('cover image declared', opf.includes('properties="cover-image"'));
const nav = txt('OEBPS/nav.xhtml');
check('nav lists 4 chapters', (nav.match(/Chapter \d/g) || []).length === 4);
check('page list has 4 pages', (nav.match(/#pg\d+"/g) || []).length === 4);
const chapters = book.filter((e) => /^OEBPS\/text\/ch\d+\.xhtml$/.test(e.name)).map((e) => e.data.toString('utf8'));
check('one file per chapter (+ title page)', chapters.length === 5);
const all = chapters.join('\n');
check('figure with caption', /<figure[^>]*class="fig"><img src="\.\.\/images\/img\d+\.jpg" alt="Figure 1\. [^"]+"\/><figcaption>/.test(all));
check('image file present', book.some((e) => /^OEBPS\/images\/img\d+\.jpg$/.test(e.name) && e.data[0] === 0xff));
check('table with header row', all.includes('<th>Format</th>') && all.includes('<td>Old books</td>'));
check('page numbers kept', all.includes('epub:type="pagebreak"'));
check('running header/page numbers dropped', !/<p>(The Pocket Guide to Reading Software|\d+)<\/p>/.test(all));
check('two-column order', all.indexOf('The left column ends here') < all.indexOf('The right column starts here'));

const he = await unzip(path.join(out, 'hebrew-sample.epub'));
const heOpf = he.find((e) => e.name === 'OEBPS/content.opf').data.toString('utf8');
const heText = he.filter((e) => e.name.startsWith('OEBPS/text/')).map((e) => e.data.toString('utf8')).join('');
check('Hebrew: language + RTL', heOpf.includes('<dc:language>he</dc:language>') && heOpf.includes('page-progression-direction="rtl"'));
check('Hebrew: numbers and Latin in place', heText.includes('גם מספרים כמו 2026 ומילים באנגלית כמו EPUB צריכים'));
check('Hebrew: table columns right-to-left', /<th>פורמט<\/th><th>זרימה<\/th>/.test(heText));

if (process.env.EPUBCHECK) {
  for (const f of fs.readdirSync(out).filter((n) => n.endsWith('.epub'))) {
    let ok = true;
    try { execFileSync('java', ['-jar', process.env.EPUBCHECK, path.join(out, f)], { stdio: 'pipe' }); } catch (e) { ok = false; console.log(e.stdout?.toString()); }
    check(`epubcheck ${f}`, ok);
  }
}
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
