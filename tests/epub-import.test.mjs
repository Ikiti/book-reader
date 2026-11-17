// EPUB import test (Node; uses linkedom as the DOM parser the browser provides natively).
//  1. Round trip: PDF samples -> EPUB (tools/pdf2epub.mjs) -> importEpub -> the structure survives.
//  2. A hand-made EPUB 2 in a different style (NCX, sub-folders, lists, quotes, <pre>, SVG cover…).
//  3. DRM-protected EPUBs are refused with a clear message.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';
import { importEpub } from '../js/epub/import.js';
import { makeZip } from '../js/epub/zip.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const parse = (text, type) => new DOMParser().parseFromString(text, type === 'html' ? 'text/html' : 'text/xml');
const serialize = (el) => el.toString();
const load = (file) => importEpub(new Uint8Array(fs.readFileSync(file)), { parse, serialize });
const T = (b) => (b ? (b.text != null ? b.text : (b.runs || []).map((r) => r.s).join('')) : '');

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failed++; };

// ---- 1. round trip ----
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'epubin-'));
execFileSync(process.execPath, [path.join(root, 'tools/pdf2epub.mjs'), path.join(root, 'samples'), '-o', out], { stdio: 'ignore' });

{
  const { model: m, title, images, cover } = await load(path.join(out, 'sample-book.epub'));
  const B = m.blocks;
  check('sample: title', title === 'The Pocket Guide to Reading Software');
  check('sample: printed page labels', m.labels?.join(',') === '1,2,3,4' && !m.pageless);
  check('sample: 4 chapters in contents', m.toc.filter((t) => t.title.startsWith('Chapter')).length === 4 && m.toc.every((t) => B[t.b]));
  check('sample: contents point at chapter headings', m.toc.filter((t) => t.title.startsWith('Chapter')).every((t) => B[t.b].t === 'h' && T(B[t.b]).startsWith(t.title.slice(0, 9))));
  const img = B.findIndex((b, i) => i > 0 && b.t === 'img'); // block 0 is the cover page
  check('sample: figure picture + caption', img > 0 && T(B[img + 1]).startsWith('Figure 1.') && images[B[img].k].mime === 'image/jpeg');
  const tbl = B.find((b) => b.t === 'table');
  check('sample: table 5x4 with header', tbl && tbl.rows.length === 5 && tbl.rows[0][0].s === 'Format' && tbl.rows[0][0].b);
  check('sample: bullets', B.filter((b) => b.li).length === 3);
  check('sample: cover', !!cover);
  check('sample: chapter 2 on page 2', B.find((b) => T(b).startsWith('Chapter 2')).pg === 1);
}
{
  const { model: m } = await load(path.join(out, 'tech-sample.epub'));
  const B = m.blocks;
  check('tech: labels v,1…6', m.labels?.join(',') === 'v,1,2,3,4,5,6');
  const tl = B.filter((b) => b.t === 'tl');
  check('tech: contents lines with numbers and working links', tl.length === 4 && tl.map((b) => b.num).join(',') === '1,2,4,6' && tl.every((b) => b.to != null && B[b.to].t === 'h'));
  check('tech: code listing exact', B.find((b) => b.t === 'code')?.text === 'sudo apt install -y \\\n    python3-pip binutils\npip install pefile   # parse PE files');
  check('tech: note box', B.find((b) => b.note)?.note === 'NOTE' && T(B.find((b) => b.note)).startsWith('If the installation'));
  check('tech: index lines with levels', B.filter((b) => b.t === 'il').length === 15 && B.some((b) => b.t === 'il' && b.lvl === 1));
}
{
  const { model: m } = await load(path.join(out, 'hebrew-sample.epub'));
  check('hebrew: language and right-to-left', m.lang === 'he' && m.blocks.some((b) => b.rtl));
  check('hebrew: table', m.blocks.find((b) => b.t === 'table')?.rows[0][0].s === 'פורמט');
}

// ---- 2. a hand-made EPUB 2, written the way other tools do it ----
const png = new Uint8Array(fs.readFileSync(path.join(root, 'icons/icon-192.png')));
const cov = new Uint8Array(fs.readFileSync(path.join(root, 'icons/icon-512.png')));
const xhtml = (body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><head><title>x</title><style>p{}</style></head><body>${body}</body></html>`;
const foreign = await makeZip([
  { name: 'mimetype', data: 'application/epub+zip', store: true },
  { name: 'META-INF/container.xml', data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
  { name: 'OEBPS/content/book.opf', data: `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
<dc:title>A Foreign Book</dc:title><dc:creator opf:role="aut">Ada Writer</dc:creator><dc:language>en</dc:language>
<dc:identifier id="id">x-1</dc:identifier><meta name="cover" content="cover-img"/></metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="c1" href="text/chapter%20one.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/ch2.html" media-type="application/xhtml+xml"/>
<item id="pic" href="../img/pic.png" media-type="image/png"/>
<item id="cover-img" href="../img/cover.png" media-type="image/png"/>
</manifest>
<spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>` },
  { name: 'OEBPS/content/toc.ncx', data: `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
<navPoint id="a" playOrder="1"><navLabel><text>Chapter One</text></navLabel><content src="text/chapter%20one.xhtml"/>
  <navPoint id="b" playOrder="2"><navLabel><text>Section Two</text></navLabel><content src="text/chapter%20one.xhtml#sec2"/></navPoint></navPoint>
<navPoint id="c" playOrder="3"><navLabel><text>Chapter Two</text></navLabel><content src="text/ch2.html"/></navPoint></navMap></ncx>` },
  { name: 'OEBPS/content/text/chapter one.xhtml', data: xhtml(`
<div class="cover"><svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><image xlink:href="../../img/pic.png" width="192" height="192"/></svg></div>
<h1 class="chapter">Chapter <em>One</em></h1>
<p>Plain text with <em>emphasis</em>, <strong>bold</strong> and <code>code</code>.</p>
<ul><li>Apple</li><li>Pear <b>tree</b></li></ul>
<ol start="3"><li>Third</li><li>Fourth</li></ol>
<blockquote><p>A wise quote.</p></blockquote>
<pre>line 1<br/>  line 2</pre>
<div class="warning"><p>Careful with this.</p></div>
<p>Line one<br/>Line two</p>
<h2 id="sec2">Section Two</h2>
<table><tr><th>Name</th><th>Value</th></tr><tr><td colspan="2">Merged</td></tr></table>
<p>Ends here.</p>`) },
  { name: 'OEBPS/content/text/ch2.html', data: xhtml(`<h1>Chapter Two</h1><p><a href="chapter%20one.xhtml#sec2">Back to section two</a></p><p>See <a href="https://example.com">the site</a>.</p>`) },
  { name: 'OEBPS/img/pic.png', data: png, store: true },
  { name: 'OEBPS/img/cover.png', data: cov, store: true },
]);
{
  const { model: m, title, author, images, cover } = await importEpub(foreign, { parse, serialize });
  const B = m.blocks;
  const find = (s) => B.find((b) => T(b).startsWith(s));
  check('foreign: title and author', title === 'A Foreign Book' && author === 'Ada Writer');
  check('foreign: cover from <meta name="cover">', cover && cover.mime === 'image/png' && cover.data.length === cov.length);
  check('foreign: no page list -> percent only', m.pageless && m.labels === null);
  check('foreign: SVG-wrapped picture', B[0].t === 'img' && images[B[0].k].w === 192);
  check('foreign: heading with inline markup', B[1].t === 'h' && B[1].l === 1 && T(B[1]) === 'Chapter One' && B[1].runs.some((r) => r.i));
  check('foreign: inline bold/italic/code', ['b', 'i', 'm'].every((k) => find('Plain text').runs.some((r) => r[k])));
  check('foreign: bullet list', find('• Apple')?.li && find('• Pear tree')?.li);
  check('foreign: numbered list from start=3', find('3. Third')?.li && !!find('4. Fourth'));
  check('foreign: quotation', find('A wise quote')?.quote === 1);
  check('foreign: preformatted text with <br>', B.find((b) => b.t === 'code')?.text === 'line 1\n  line 2');
  check('foreign: warning box', find('Careful')?.note === 'WARNING');
  check('foreign: line break kept', T(find('Line one')) === 'Line one\nLine two' && find('Line one').nl === 1);
  check('foreign: table with merged cell', B.find((b) => b.t === 'table')?.rows[1][0].cs === 2);
  const sec2 = B.findIndex((b) => T(b) === 'Section Two');
  check('foreign: NCX contents with levels', m.toc.map((t) => `${t.level}:${t.title}`).join('|') === '1:Chapter One|2:Section Two|1:Chapter Two' && m.toc[1].b === sec2);
  check('foreign: internal link line jumps to its target', B.find((b) => b.t === 'tl')?.to === sec2);
  check('foreign: external links stay text', find('See the site')?.t === 'p');
}

// ---- 3. DRM ----
const drm = await makeZip([
  { name: 'mimetype', data: 'application/epub+zip', store: true },
  { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="a.opf"/></rootfiles></container>' },
  { name: 'META-INF/encryption.xml', data: '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></enc:EncryptedData></encryption>' },
]);
let drmMsg = '';
try { await importEpub(drm, { parse }); } catch (e) { drmMsg = e.message; }
check('DRM-protected EPUB refused clearly', /DRM/.test(drmMsg));

console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
