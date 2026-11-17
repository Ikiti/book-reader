// Book model (see pdf/extract.js) -> EPUB 3 file (with EPUB 2 NCX for older readers / Kindle).
// Pure function: no DOM, no storage. Used by the app (Export EPUB) and by tools/pdf2epub.mjs.
//
// Layout of the generated book:
//   mimetype, META-INF/container.xml
//   OEBPS/content.opf  nav.xhtml  toc.ncx  style.css  cover.xhtml
//   OEBPS/text/ch001.xhtml …      one file per top-level chapter (big chapters are split)
//   OEBPS/images/cover.jpg, img<k>.jpg
// Original PDF page numbers are kept as page-break markers + a page list, so readers can show
// "page N" and citations stay valid.

import { makeZip } from './zip.js';

const MAX_CHARS_PER_FILE = 120000; // readers get slow with very large XHTML files

// Characters that are not allowed in XML 1.0 (PDF text sometimes contains them).
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const esc = (s) => String(s ?? '').replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textOf = (b) => (b.runs ? b.runs.map((r) => r.s).join('') : '');
const RTL_LANGS = new Set(['he', 'ar', 'fa', 'ur', 'yi']);

/** Guess the main language from the script of the text (enough for reader hyphenation/direction). */
export function detectLanguage(model) {
  let he = 0; let ar = 0; let cy = 0; let el = 0; let latin = 0;
  let seen = 0;
  for (const b of model.blocks) {
    for (const ch of textOf(b)) {
      if (/[֐-׿]/.test(ch)) he++;
      else if (/[؀-ۿ]/.test(ch)) ar++;
      else if (/[Ѐ-ӿ]/.test(ch)) cy++;
      else if (/[Ͱ-Ͽ]/.test(ch)) el++;
      else if (/[A-Za-zÀ-ɏ]/.test(ch)) latin++;
    }
    if (++seen > 400) break;
  }
  const best = Object.entries({ he, ar, ru: cy, el, en: latin }).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'en';
}

function uuidFrom(id) {
  const hex = (String(id).replace(/[^0-9a-f]/gi, '') + '0'.repeat(32)).slice(0, 32).toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Split blocks into files: at top-level TOC entries, then by size. */
function splitFiles(model) {
  const n = model.blocks.length;
  const starts = new Set([0]);
  if (model.toc.length) {
    // Split at the shallowest level that has several entries (a lone book title doesn't count).
    const levels = [...new Set(model.toc.map((t) => t.level))].sort((a, b) => a - b);
    const lvl = levels.find((l) => model.toc.filter((t) => t.level === l).length >= 2) ?? levels[0];
    model.toc.filter((t) => t.level <= lvl).forEach((t) => starts.add(t.b));
  }
  const cuts = [...starts].filter((b) => b >= 0 && b < n).sort((a, b) => a - b);
  const files = [];
  cuts.forEach((s, i) => {
    const e = i + 1 < cuts.length ? cuts[i + 1] : n;
    let from = s;
    let chars = 0;
    for (let b = s; b < e; b++) {
      chars += textOf(model.blocks[b]).length || 300;
      // Split oversized chapters, preferably right before a heading.
      if (chars > MAX_CHARS_PER_FILE && b + 1 < e && (model.blocks[b + 1].t === 'h' || chars > MAX_CHARS_PER_FILE * 1.3)) {
        files.push([from, b + 1]);
        from = b + 1;
        chars = 0;
      }
    }
    if (from < e) files.push([from, e]);
  });
  if (!files.length) files.push([0, 0]);
  return files;
}

function runsXhtml(runs) {
  return (runs || []).map((r) => {
    let t = esc(r.s);
    if (r.m) t = `<code>${t}</code>`;
    if (r.i) t = `<i>${t}</i>`;
    if (r.b) t = `<b>${t}</b>`;
    return t;
  }).join('');
}

/** Printed page label of a page index (falls back to the PDF page number). */
const labelOf = (model, pg) => {
  const l = model.labels?.[pg];
  return l && !String(l).startsWith('#') ? String(l) : String(pg + 1);
};

// "Figure 3.", "Fig. 2:", "Table IV", "איור 1" … (a keyword followed by a number, not "Figures carry…").
const CAPTION = /^(fig(ure)?\.?|image|illustration|photo|chart|diagram|map|plate|table|tab\.|listing|exhibit|scheme|example|איור|תמונה|טבלה|תרשים|לוח)\s*([0-9ivxlc]+|[A-Z])\b[-.:)\s\d]*/i;

/** The paragraph right after a picture/table, if it is its caption. */
function captionAfter(model, i, end) {
  const next = i + 1 < end ? model.blocks[i + 1] : null;
  if (!next || next.t !== 'p') return null;
  const t = textOf(next).trim();
  return t.length < 500 && CAPTION.test(t) ? next : null;
}

function blockXhtml(b, i, model, ctx) {
  const id = ctx.ids.has(i) ? ` id="b${i}"` : '';
  const dir = b.rtl && !ctx.rtl ? ' dir="rtl"' : !b.rtl && ctx.rtl && b.runs ? ' dir="auto"' : '';
  switch (b.t) {
    case 'h': {
      const t = runsXhtml(b.runs);
      if (!textOf(b).trim()) return '';
      const lvl = Math.min(6, Math.max(1, b.l));
      return `<h${lvl}${id}${dir}>${t}</h${lvl}>`;
    }
    case 'p': {
      if (!textOf(b).trim()) return '';
      if (b.note) return `<div${id} class="note"><p${dir}><b class="label">${esc(b.note)}</b> ${runsXhtml(b.runs)}</p></div>`;
      const body = runsXhtml(b.runs).replace(/\n/g, '<br/>');
      if (b.quote) return `<blockquote${id}><p${dir}>${body}</p></blockquote>`;
      return `<p${id}${b.li ? ' class="li"' : ''}${dir}>${body}</p>`;
    }
    case 'code': {
      if (!b.text.trim()) return '';
      const cap = captionAfter(model, i, ctx.end);
      if (cap) ctx.skip.add(i + 1);
      // Wide listings get a smaller font so their columns survive on a phone screen.
      const width = Math.max(...b.text.split('\n').map((l) => l.length));
      const size = width <= 60 ? '' : width <= 75 ? ' class="w1"' : width <= 90 ? ' class="w2"' : ' class="w3"';
      const pre = `<pre${size}><code>${esc(b.text)}</code></pre>`;
      return cap ? `<figure${id} class="listing">${pre}<figcaption>${runsXhtml(cap.runs)}</figcaption></figure>` : `<div${id} class="listing">${pre}</div>`;
    }
    case 'tl': {
      const t = runsXhtml(b.runs);
      const href = b.to != null && ctx.fileOf.has(b.to) ? ctx.link(b.to) : null;
      return `<p${id} class="toc-line l${b.lvl || 0}"${dir}>${href ? `<a href="${href}">${t}</a>` : t}${b.num ? ` <span class="pn">${esc(b.num)}</span>` : ''}</p>`;
    }
    case 'il':
      return `<p${id} class="index-line l${b.lvl || 0}"${dir}>${runsXhtml(b.runs)}</p>`;
    case 'img':
    case 'scan': {
      const img = ctx.images.get(b.k);
      if (!img) return id ? `<div${id}></div>` : '';
      const cap = b.t === 'img' ? captionAfter(model, i, ctx.end) : null;
      if (cap) ctx.skip.add(i + 1);
      const alt = b.t === 'scan' ? `Scanned page ${b.pg + 1}` : cap ? textOf(cap).trim().slice(0, 200) : 'Figure';
      ctx.used.add(b.k);
      return `<figure${id} class="${b.t === 'scan' ? 'scan' : 'fig'}"><img src="../images/img${b.k}.${img.ext}" alt="${esc(alt)}"/>${cap ? `<figcaption>${runsXhtml(cap.runs)}</figcaption>` : ''}</figure>`;
    }
    case 'table': {
      const rows = b.rows.map((row, ri) => {
        const head = ri === 0 && row.length && row.every((c) => c.b);
        const cells = row.map((c) => {
          const tag = head ? 'th' : 'td';
          const span = `${c.cs > 1 ? ` colspan="${c.cs}"` : ''}${c.rs > 1 ? ` rowspan="${c.rs}"` : ''}`;
          return `<${tag}${span}>${esc(c.s)}</${tag}>`;
        }).join('');
        return `<tr>${cells}</tr>`;
      }).join('\n');
      const before = ctx.capBefore.get(i);
      const cap = before ? null : captionAfter(model, i, ctx.end);
      if (cap) ctx.skip.add(i + 1);
      return `<figure${id} class="table">${before ? `<figcaption>${runsXhtml(before.runs)}</figcaption>` : ''}<table>\n${rows}\n</table>${cap ? `<figcaption>${runsXhtml(cap.runs)}</figcaption>` : ''}</figure>`;
    }
    default:
      return '';
  }
}

const xhtmlDoc = ({ title, lang, rtl, css, body, bodyClass = '' }) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}"${rtl ? ' dir="rtl"' : ''}>
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="${css}"/>
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${body}
</body>
</html>
`;

export const EPUB_CSS = `/* Kept minimal on purpose: the reading app controls font, size and margins. */
p { margin: 0 0 0.8em; text-indent: 0; }
p.li { padding-left: 1.3em; text-indent: -1.1em; margin-bottom: 0.3em; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.6em; page-break-after: avoid; break-after: avoid; }
figure { margin: 1em 0; text-align: center; page-break-inside: avoid; break-inside: avoid; }
figure img { max-width: 100%; height: auto; }
figure.scan img { border: 1px solid #ccc; }
figure.table { overflow-x: auto; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: monospace; font-size: 0.8em; line-height: 1.35; margin: 0.8em 0; padding: 0.5em 0.6em; background: #f3f3f1; border-left: 3px solid #bbb; }
code { font-family: monospace; font-size: 0.92em; }
pre code { font-size: 1em; }
pre.w1 { font-size: 0.68em; }
pre.w2 { font-size: 0.58em; }
pre.w3 { font-size: 0.5em; }
figure.listing { text-align: start; }
div.note { margin: 1em 0; padding: 0.4em 0.8em; border-left: 3px solid #888; }
div.note p { margin: 0.3em 0; }
div.note .label { font-size: 0.75em; letter-spacing: 0.08em; }
p.toc-line { margin: 0.25em 0; text-indent: 0; overflow: hidden; }
p.toc-line.l1 { margin-left: 1.5em; }
p.toc-line.l2 { margin-left: 3em; }
p.toc-line .pn { float: right; padding-left: 1em; color: #777; }
p.toc-line a { text-decoration: none; }
p.index-line { margin: 0; padding-left: 1.5em; text-indent: -1.5em; font-size: 0.92em; }
p.index-line.l1 { margin-left: 1.2em; }
p.index-line.l2 { margin-left: 2.4em; }
figcaption { font-size: 0.85em; font-style: italic; margin-top: 0.4em; }
table { border-collapse: collapse; margin: 0 auto; font-size: 0.9em; }
th, td { border: 1px solid #888; padding: 0.25em 0.5em; text-align: start; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
th { font-weight: bold; }
body.cover { margin: 0; padding: 0; text-align: center; }
body.cover img { max-width: 100%; max-height: 100vh; }
nav ol { list-style: none; padding-left: 1em; }
`;

/**
 * @param {object} o
 * @param {string} o.id        stable book id (used for the EPUB identifier)
 * @param {string} o.title
 * @param {string} [o.author]
 * @param {object} o.model     extracted book model
 * @param {Map<number,{data:Uint8Array, mime:string, ext:string}>} o.images  pictures by model image index
 * @param {{data:Uint8Array, mime:string, ext:string}} [o.cover]
 * @param {string} [o.lang]    BCP 47; detected from the text when omitted
 * @returns {Promise<Uint8Array>}
 */
export async function buildEpub({ id, title, author = '', model, images = new Map(), cover = null, lang, modified = new Date() }) {
  lang = lang || detectLanguage(model);
  const rtl = RTL_LANGS.has(lang);
  const uid = `urn:uuid:${uuidFrom(id)}`;
  const files = splitFiles(model);
  const fileOf = new Map(); // block index -> file name
  files.forEach(([s, e], fi) => { for (let b = s; b < e; b++) fileOf.set(b, `text/ch${String(fi + 1).padStart(3, '0')}.xhtml`); });

  const ids = new Set(model.toc.map((t) => t.b));
  model.blocks.forEach((b) => { if (b.t === 'tl' && b.to != null) ids.add(b.to); });
  const ctx = {
    ids, images, used: new Set(), skip: new Set(), capBefore: new Map(), rtl, end: 0, fileOf,
    link: (to) => `../${fileOf.get(to)}#b${to}`,
  };
  const pageTargets = []; // [pageNumber, href]
  const chapterDocs = [];
  let lastPg = -1;

  files.forEach(([s, e], fi) => {
    const name = `text/ch${String(fi + 1).padStart(3, '0')}.xhtml`;
    const parts = [];
    ctx.end = e;
    for (let b = s; b < e; b++) {
      const blk = model.blocks[b];
      while (lastPg < blk.pg) {
        lastPg++;
        const n = lastPg + 1;
        const label = labelOf(model, lastPg);
        parts.push(`<span epub:type="pagebreak" role="doc-pagebreak" id="pg${n}" aria-label="${esc(label)}"></span>`);
        pageTargets.push([label, `${name}#pg${n}`]);
      }
      if (ctx.skip.has(b)) { if (ids.has(b)) parts.push(`<div id="b${b}"></div>`); continue; } // already emitted as a caption
      if (cover && blk.t === 'scan' && blk.pg === 0) { if (ids.has(b)) parts.push(`<div id="b${b}"></div>`); continue; } // the cover page
      // "Table 1-1: …" printed above its table: move it into the table's figure.
      const nextBlk = model.blocks[b + 1];
      if (blk.t === 'p' && nextBlk?.t === 'table' && b + 1 < e && !ids.has(b) && /^(table|tab\.|טבלה)\s*[\dIVX]/i.test(textOf(blk).trim()) && textOf(blk).length < 300) {
        ctx.capBefore.set(b + 1, blk);
        continue;
      }
      const x = blockXhtml(blk, b, model, ctx);
      if (x) parts.push(x);
      else if (ids.has(b)) parts.push(`<div id="b${b}"></div>`); // keep TOC links valid
    }
    const first = model.blocks[s];
    const chTitle = model.toc.find((t) => t.b === s)?.title || (first?.t === 'h' ? textOf(first) : '') || title;
    chapterDocs.push({ name, xml: xhtmlDoc({ title: chTitle, lang, rtl, css: '../style.css', body: `<section epub:type="chapter" role="doc-chapter">\n${parts.join('\n')}\n</section>` }) });
  });

  // Table of contents (nested by level).
  const tocEntries = model.toc.filter((t) => fileOf.has(t.b)).map((t) => ({ ...t, href: `${fileOf.get(t.b)}#b${t.b}`, title: (t.title || '').trim() || 'Section' }));
  if (!tocEntries.length) tocEntries.push({ level: 1, title: title || 'Start', href: chapterDocs[0].name });
  const tree = nestToc(tocEntries);
  const navOl = (nodes) => `<ol>\n${nodes.map((nd) => `<li><a href="${nd.href}">${esc(nd.title)}</a>${nd.kids.length ? navOl(nd.kids) : ''}</li>`).join('\n')}\n</ol>`;
  // NCX: entries pointing at the same place must share a playOrder.
  let order = 0;
  let npId = 0;
  const playOf = new Map();
  const ncxPoints = (nodes) => nodes.map((nd) => {
    if (!playOf.has(nd.href)) playOf.set(nd.href, ++order);
    npId++;
    return `<navPoint id="np${npId}" playOrder="${playOf.get(nd.href)}"><navLabel><text>${esc(nd.title)}</text></navLabel><content src="${nd.href}"/>${ncxPoints(nd.kids)}</navPoint>`;
  }).join('\n');
  const depth = (nodes) => (nodes.length ? 1 + Math.max(...nodes.map((nd) => depth(nd.kids))) : 0);

  const nav = xhtmlDoc({
    title: 'Contents', lang, rtl, css: 'style.css',
    body: `<nav epub:type="toc" role="doc-toc" id="toc"><h1>Contents</h1>
${navOl(tree)}
</nav>
<nav epub:type="page-list" id="page-list" hidden=""><h2>Pages</h2>
<ol>
${pageTargets.map(([label, href]) => `<li><a href="${href}">${esc(label)}</a></li>`).join('\n')}
</ol>
</nav>
<nav epub:type="landmarks" id="landmarks" hidden=""><h2>Landmarks</h2>
<ol>
${cover ? '<li><a epub:type="cover" href="cover.xhtml">Cover</a></li>\n' : ''}<li><a epub:type="bodymatter" href="${chapterDocs[0].name}">Start</a></li>
</ol>
</nav>`,
  });

  const ncxBody = ncxPoints(tree);
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${lang}">
<head>
<meta name="dtb:uid" content="${uid}"/>
<meta name="dtb:depth" content="${Math.max(1, depth(tree))}"/>
<meta name="dtb:totalPageCount" content="${model.pageCount}"/>
<meta name="dtb:maxPageNumber" content="${Math.max(0, ...(model.labels || []).map((l) => (/^\d+$/.test(l) ? +l : 0)), model.labels ? 0 : model.pageCount)}"/>
</head>
<docTitle><text>${esc(title)}</text></docTitle>
<navMap>
${ncxBody}
</navMap>
</ncx>
`;

  const coverDoc = cover ? xhtmlDoc({ title: 'Cover', lang, rtl, css: 'style.css', bodyClass: 'cover', body: `<section epub:type="cover"><img src="images/cover.${cover.ext}" alt="${esc(title)}"/></section>` }) : null;

  const usedImages = [...ctx.used].sort((a, b) => a - b);
  const stamp = modified.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}"${rtl ? ' dir="rtl"' : ''}>
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uid}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
<dc:language>${lang}</dc:language>
${author ? `<dc:creator>${esc(author)}</dc:creator>\n` : ''}<meta property="dcterms:modified">${stamp}</meta>
<dc:source>Converted from PDF (${model.pageCount} pages) by Book Reader</dc:source>
${cover ? '<meta name="cover" content="cover-image"/>\n' : ''}</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
${cover ? `<item id="cover-image" href="images/cover.${cover.ext}" media-type="${cover.mime}" properties="cover-image"/>\n<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n` : ''}${chapterDocs.map((d, i) => `<item id="ch${i + 1}" href="${d.name}" media-type="application/xhtml+xml"/>`).join('\n')}
${usedImages.map((k) => `<item id="img${k}" href="images/img${k}.${images.get(k).ext}" media-type="${images.get(k).mime}"/>`).join('\n')}
</manifest>
<spine toc="ncx"${rtl ? ' page-progression-direction="rtl"' : ''}>
${cover ? '<itemref idref="cover" linear="yes"/>\n' : ''}${chapterDocs.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('\n')}
</spine>
</package>
`;

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`;

  const entries = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: container },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/toc.ncx', data: ncx },
    { name: 'OEBPS/style.css', data: EPUB_CSS },
  ];
  if (cover) {
    entries.push({ name: 'OEBPS/cover.xhtml', data: coverDoc });
    entries.push({ name: `OEBPS/images/cover.${cover.ext}`, data: cover.data, store: true });
  }
  chapterDocs.forEach((d) => entries.push({ name: `OEBPS/${d.name}`, data: d.xml }));
  usedImages.forEach((k) => { const im = images.get(k); entries.push({ name: `OEBPS/images/img${k}.${im.ext}`, data: im.data, store: true }); });
  return makeZip(entries, modified);
}

/** Flat [{level,...}] -> tree [{..., kids}] (level jumps are clamped so the nesting stays valid). */
function nestToc(entries) {
  const root = { kids: [], level: 0 };
  const stack = [root];
  for (const e of entries) {
    const node = { ...e, kids: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= e.level) stack.pop();
    stack[stack.length - 1].kids.push(node);
    stack.push(node);
  }
  return root.kids;
}

/** Recognise image bytes: returns {mime, ext} or null. */
export function sniffImage(u8) {
  if (u8[0] === 0xff && u8[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return { mime: 'image/gif', ext: 'gif' };
  return null;
}
