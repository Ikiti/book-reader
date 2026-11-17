// EPUB (2 or 3) -> the same book model the PDF import produces (see pdf/extract.js), so the reader,
// library, progress tracking and notes work unchanged.
//
// Pure module: the caller passes an XML/HTML parser, so it runs in browsers (DOMParser) and in Node
// tests (linkedom). Returns raw image bytes; the caller turns them into Blobs.

import { openZip } from './unzip.js';

export const EPUB_IMPORT_VERSION = 1;

const SKIP = new Set(['head', 'script', 'style', 'template', 'noscript', 'title', 'meta', 'link']);
const BLOCK = new Set(['p', 'div', 'hgroup', 'section', 'article', 'aside', 'header', 'footer', 'main', 'body', 'nav', 'center',
  'address', 'details', 'summary', 'figure', 'figcaption', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table',
  'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'form', 'fieldset', 'hgroup', 'caption']);
const NOTE_CLASS = /\b(note|warning|tip|caution|important|hint|sidebar|callout)\b/i;
const local = (el) => (el.localName || el.tagName || '').toLowerCase().split(':').pop();
const attr = (el, name) => (el.getAttribute ? el.getAttribute(name) : null);
const children = (el) => [...(el.childNodes || [])];
const allElements = (root) => [...root.querySelectorAll('*')];
const elementsByLocal = (root, name) => allElements(root).filter((e) => local(e) === name);
const parseFailed = (doc) => !doc || !doc.documentElement || !!doc.querySelector('parsererror');

/** Resolve `href` (relative to the file `base`) to a zip path; returns [path, fragment]. */
export function resolvePath(base, href) {
  const [rawPath, frag = ''] = String(href).split('#');
  const path = rawPath.split('?')[0];
  if (!path) return [base, frag];
  const parts = (path.startsWith('/') ? [] : base.split('/').slice(0, -1));
  for (const seg of path.replace(/^\//, '').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  let out = parts.join('/');
  try { out = decodeURIComponent(out); } catch { /* keep as is */ }
  return [out, frag];
}

/** Width/height from image bytes (PNG, JPEG, GIF, WebP, SVG). */
export function imageSize(u8, mime = '') {
  try {
    if (u8[0] === 0x89 && u8[1] === 0x50) return { w: (u8[16] << 24 | u8[17] << 16 | u8[18] << 8 | u8[19]) >>> 0, h: (u8[20] << 24 | u8[21] << 16 | u8[22] << 8 | u8[23]) >>> 0 };
    if (u8[0] === 0x47 && u8[1] === 0x49) return { w: u8[6] | u8[7] << 8, h: u8[8] | u8[9] << 8 };
    if (u8[0] === 0xff && u8[1] === 0xd8) {
      for (let i = 2; i + 9 < u8.length;) {
        if (u8[i] !== 0xff) { i++; continue; }
        const m = u8[i + 1];
        const len = u8[i + 2] << 8 | u8[i + 3];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: u8[i + 5] << 8 | u8[i + 6], w: u8[i + 7] << 8 | u8[i + 8] };
        i += 2 + len;
      }
    }
    if (u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) { // WEBP
      const kind = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
      if (kind === 'VP8X') return { w: 1 + (u8[24] | u8[25] << 8 | u8[26] << 16), h: 1 + (u8[27] | u8[28] << 8 | u8[29] << 16) };
      if (kind === 'VP8 ') return { w: (u8[26] | u8[27] << 8) & 0x3fff, h: (u8[28] | u8[29] << 8) & 0x3fff };
      if (kind === 'VP8L') { const b = u8[21] | u8[22] << 8 | u8[23] << 16 | u8[24] << 24; return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }; }
    }
    if (/svg/.test(mime) || u8[0] === 0x3c) {
      const head = new TextDecoder().decode(u8.subarray(0, 2000));
      const vb = head.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
      const w = head.match(/<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i);
      const h = head.match(/<svg[^>]*\sheight\s*=\s*["']([\d.]+)/i);
      if (w && h) return { w: +w[1], h: +h[1] };
      if (vb) return { w: +vb[1], h: +vb[2] };
    }
  } catch { /* fall through */ }
  return null;
}

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' };

/**
 * @param {Uint8Array} bytes   the .epub file
 * @param {object} o
 * @param {(text: string, type: 'xml'|'xhtml'|'html') => Document} o.parse
 * @param {(el: Element) => string} [o.serialize]  outerHTML/XMLSerializer, for inline SVG pictures
 * @param {(done: number, total: number, phase: string) => void} [o.onProgress]
 */
export async function importEpub(bytes, { parse, serialize, onProgress } = {}) {
  const zip = openZip(bytes);
  if (!zip.has('META-INF/container.xml')) throw new Error('Not an EPUB file (META-INF/container.xml is missing)');
  await checkDrm(zip, parse);

  const container = parse(await zip.text('META-INF/container.xml'), 'xml');
  const opfPath = attr(elementsByLocal(container, 'rootfile')[0] || {}, 'full-path');
  if (!opfPath) throw new Error('EPUB has no package file');
  const opf = parse(await zip.text(opfPath), 'xml');

  // Metadata
  const meta = (name) => elementsByLocal(opf, name).map((e) => (e.textContent || '').trim()).filter(Boolean);
  const title = meta('title')[0] || '';
  const author = meta('creator').join(', ');
  const lang = (meta('language')[0] || '').toLowerCase();

  // Manifest
  const items = new Map(); // id -> {href (zip path), type, props}
  const byPath = new Map();
  for (const it of elementsByLocal(opf, 'item')) {
    const [path] = resolvePath(opfPath, attr(it, 'href') || '');
    const rec = { id: attr(it, 'id'), path, type: (attr(it, 'media-type') || '').toLowerCase(), props: attr(it, 'properties') || '' };
    items.set(rec.id, rec);
    byPath.set(path, rec);
  }
  const spineEl = elementsByLocal(opf, 'spine')[0];
  const spine = elementsByLocal(opf, 'itemref').map((r) => items.get(attr(r, 'idref'))).filter(Boolean);
  const rtl = attr(spineEl || {}, 'page-progression-direction') === 'rtl' || /^(he|ar|fa|ur|yi)\b/.test(lang);

  // Cover image
  let coverItem = [...items.values()].find((i) => /\bcover-image\b/.test(i.props));
  if (!coverItem) {
    const m = elementsByLocal(opf, 'meta').find((e) => attr(e, 'name') === 'cover');
    if (m) coverItem = items.get(attr(m, 'content'));
  }
  const cover = coverItem && /^image\//.test(coverItem.type) && zip.has(coverItem.path)
    ? { data: await zip.read(coverItem.path), mime: coverItem.type } : null;

  // ---- content documents -> blocks ----
  const blocks = [];
  const images = []; // {data, mime}
  const imageIndex = new Map(); // zip path -> k
  const idMap = new Map(); // "path#id" -> block index
  const fileStart = new Map(); // path -> first block index
  const labels = [];
  let curPg = 0;
  let pendingPg = null;
  let sawBreak = false;
  let buf = null; // inline buffer: {runs, links, ...flags}

  const pageBreak = (label) => {
    if (!sawBreak) { labels[0] = label; sawBreak = true; return; }
    labels.push(label);
    if (buf && bufText().trim()) pendingPg = labels.length - 1; // mid-paragraph: applies after it
    else curPg = labels.length - 1;
  };
  let docNo = 0;
  const push = (b) => { b.pg = sawBreak ? curPg : 0; b._doc = docNo; blocks.push(b); };
  const kindOf = (st) => ({ ...(st.note ? { note: st.note } : {}), ...(st.quote ? { quote: 1 } : {}) });
  const bufText = () => (buf ? buf.runs.map((r) => r.s).join('') : '');
  const open = (extra = {}) => { if (!buf) buf = { runs: [], links: [], ...extra }; };
  const addText = (s, st) => {
    open({ kind: kindOf(st) });
    const t = s === '\n' ? '\n' : s.replace(/[\t\n\r\f ]+/g, ' ');
    if (!t) return;
    const last = buf.runs[buf.runs.length - 1];
    const style = { b: !!st.b, i: !!st.i, m: !!st.m };
    if (last && last.b === style.b && last.i === style.i && last.m === style.m) last.s += t;
    else buf.runs.push({ s: t, ...style });
  };
  const flush = (kind = {}) => {
    const b = buf;
    buf = null;
    if (b) {
      let runs = b.runs.map((r) => ({ ...r, s: r.s.replace(/ {2,}/g, ' ') }));
      if (runs.length) { runs[0].s = runs[0].s.replace(/^\s+/, ''); runs[runs.length - 1].s = runs[runs.length - 1].s.replace(/\s+$/, ''); }
      for (let k = 1; k < runs.length; k++) if (/\s$/.test(runs[k - 1].s) && /^\s/.test(runs[k].s)) runs[k].s = runs[k].s.replace(/^\s+/, '');
      runs = runs.filter((r) => r.s).map((r) => { const o = { s: r.s.replace(/ *\n */g, '\n') }; if (r.b) o.b = 1; if (r.i) o.i = 1; if (r.m) o.m = 1; return o; });
      const text = runs.map((r) => r.s).join('');
      if (text.trim()) {
        const blk = { ...b.kind, ...kind, runs };
        if (!blk.t) blk.t = 'p';
        // A line that is just one internal link (a contents page) becomes a clickable contents line.
        if (blk.t === 'p' && !blk.li && b.links.length === 1 && b.links[0].text.trim() === text.trim()) {
          blk.t = 'tl';
          blk.href = b.links[0].href;
          blk.lvl = 0;
        }
        if (/\n/.test(text)) blk.nl = 1;
        if (rtl && /[֐-ۿ]/.test(text)) blk.rtl = 1;
        push(blk);
      }
    }
    if (pendingPg != null) { curPg = pendingPg; pendingPg = null; }
  };

  const isPageBreak = (el) => /\bpagebreak\b/.test(attr(el, 'epub:type') || '') || attr(el, 'role') === 'doc-pagebreak';
  const breakLabel = (el) => (attr(el, 'aria-label') || attr(el, 'title') || (el.textContent || '').trim() || (attr(el, 'id') || '').replace(/^\D+/, '') || String(labels.length + 1)).trim();

  async function addImage(path, docPath, alt) {
    if (!zip.has(path)) return;
    let k = imageIndex.get(path);
    let size;
    if (k == null) {
      const data = await zip.read(path);
      const ext = path.split('.').pop().toLowerCase();
      const mime = byPath.get(path)?.type || MIME_BY_EXT[ext] || 'application/octet-stream';
      size = imageSize(data, mime) || { w: 600, h: 400 };
      if (size.w < 24 && size.h < 24) return; // icons, spacer gifs
      k = images.length;
      images.push({ data, mime, ...size });
      imageIndex.set(path, k);
    }
    const im = images[k];
    flush();
    push({ t: 'img', k, w: im.w, h: im.h, ...(alt ? { alt } : {}) });
  }

  async function addSvg(el, docPath) {
    // <svg><image href="cover.jpg"/></svg> (common for covers) → that picture; otherwise the SVG itself.
    const img = elementsByLocal(el, 'image')[0];
    if (img) {
      const href = attr(img, 'xlink:href') || attr(img, 'href');
      if (href) return addImage(resolvePath(docPath, href)[0], docPath);
    }
    if (!serialize) return;
    let svg = serialize(el);
    if (!/xmlns=/.test(svg)) svg = svg.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    const data = new TextEncoder().encode(svg);
    const size = imageSize(data, 'image/svg+xml') || { w: 600, h: 400 };
    const k = images.length;
    images.push({ data, mime: 'image/svg+xml', ...size });
    flush();
    push({ t: 'img', k, w: size.w, h: size.h });
  }

  function tableBlock(el) {
    const rows = [];
    for (const tr of allElements(el).filter((e) => local(e) === 'tr')) {
      const row = [];
      for (const td of children(tr).filter((c) => c.nodeType === 1 && /^t[dh]$/.test(local(c)))) {
        const c = { s: (td.textContent || '').replace(/\s+/g, ' ').trim() };
        const cs = +attr(td, 'colspan') || 1;
        const rs = +attr(td, 'rowspan') || 1;
        if (cs > 1) c.cs = cs;
        if (rs > 1) c.rs = rs;
        if (local(td) === 'th') c.b = true;
        row.push(c);
      }
      if (row.length) rows.push(row);
    }
    return rows.length ? { t: 'table', rows } : null;
  }

  function preText(el) {
    let s = '';
    const walkPre = (n) => {
      for (const c of children(n)) {
        if (c.nodeType === 3) s += c.data;
        else if (c.nodeType === 1) { if (local(c) === 'br') s += '\n'; else walkPre(c); }
      }
    };
    walkPre(el);
    return s.replace(/^\n/, '').replace(/\s+$/, '');
  }

  async function walk(el, st, docPath) {
    for (const n of children(el)) {
      if (n.nodeType === 3 || n.nodeType === 4) { if (buf || n.data.trim()) addText(n.data, st); continue; }
      if (n.nodeType !== 1) continue;
      const tag = local(n);
      if (SKIP.has(tag) || (n.hasAttribute && n.hasAttribute('hidden'))) continue;
      const id = attr(n, 'id');
      if (id) idMap.set(`${docPath}#${id}`, blocks.length);
      if (isPageBreak(n)) { pageBreak(breakLabel(n)); continue; }
      const cls = attr(n, 'class') || '';

      if (tag === 'hgroup') {
        // <hgroup><h2>I</h2><p>Down the Rabbit-Hole</p></hgroup> → one heading "I: Down the Rabbit-Hole"
        flush();
        const parts = children(n).filter((c) => c.nodeType === 1);
        parts.forEach((c) => { const cid = attr(c, 'id'); if (cid) idMap.set(`${docPath}#${cid}`, blocks.length); });
        const texts = parts.map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        const hEl = parts.find((c) => /^h[1-6]$/.test(local(c)));
        if (texts.length) push({ t: 'h', l: hEl ? Math.min(4, +local(hEl)[1]) : 2, runs: [{ s: texts.join(texts[0].length <= 6 ? ': ' : ' — ') }] });
        continue;
      }
      if (/^h[1-6]$/.test(tag)) { flush(); open({ kind: { t: 'h', l: Math.min(4, +tag[1]) } }); await walk(n, { ...st, b: false }, docPath); flush(); continue; }
      if (tag === 'pre') { flush(); const text = preText(n); if (text.trim()) push({ t: 'code', text }); continue; }
      if (tag === 'table') { flush(); const tb = tableBlock(n); if (tb) push(tb); continue; }
      if (tag === 'img') { const src = attr(n, 'src'); if (src) await addImage(resolvePath(docPath, src)[0], docPath, attr(n, 'alt')); continue; }
      if (tag === 'svg') { await addSvg(n, docPath); continue; }
      if (tag === 'image') { const href = attr(n, 'xlink:href') || attr(n, 'href'); if (href) await addImage(resolvePath(docPath, href)[0], docPath); continue; }
      if (tag === 'br') { if (buf) addText('\n', st); continue; }
      if (tag === 'hr') { flush(); continue; }

      // Lines exported by this app: contents and index lines keep their structure.
      if (/\btoc-line\b/.test(cls)) {
        flush();
        const a = elementsByLocal(n, 'a')[0];
        const pn = allElements(n).find((e) => /\bpn\b/.test(attr(e, 'class') || ''));
        open({ kind: { t: 'tl', lvl: +(cls.match(/\bl(\d)\b/) || [0, 0])[1], ...(pn ? { num: (pn.textContent || '').trim() } : {}), ...(a ? { href: resolvePath(docPath, attr(a, 'href') || '').join('#') } : {}) } });
        await walk(a || n, st, docPath);
        flush();
        continue;
      }
      if (/\bindex-line\b/.test(cls)) { flush(); open({ kind: { t: 'il', lvl: +(cls.match(/\bl(\d)\b/) || [0, 0])[1] } }); await walk(n, st, docPath); flush(); continue; }
      if (/\bpn\b/.test(cls) || (/\blabel\b/.test(cls) && st.note)) continue; // handled by the parent

      if (tag === 'ul' || tag === 'ol') {
        flush();
        let num = +attr(n, 'start') || 1;
        for (const li of children(n)) {
          if (li.nodeType !== 1) continue;
          if (local(li) !== 'li') { await walk({ childNodes: [li] }, st, docPath); continue; }
          const liId = attr(li, 'id');
          if (liId) idMap.set(`${docPath}#${liId}`, blocks.length);
          flush();
          open({ kind: { li: 1 } });
          addText(tag === 'ol' ? `${num++}. ` : '• ', {});
          await walk(li, st, docPath);
          flush();
        }
        continue;
      }
      if (tag === 'blockquote') { flush(); await walk(n, { ...st, quote: 1 }, docPath); flush(); continue; }
      if (NOTE_CLASS.test(cls) && (tag === 'div' || tag === 'aside' || tag === 'section')) {
        flush();
        const labelEl = allElements(n).find((e) => /\blabel\b/.test(attr(e, 'class') || ''));
        const word = (labelEl?.textContent || cls.match(NOTE_CLASS)[1]).trim().toUpperCase();
        await walk(n, { ...st, note: word }, docPath);
        flush();
        continue;
      }
      if (tag === 'dt') { flush(); open({ kind: kindOf(st) }); await walk(n, { ...st, b: true }, docPath); flush(); continue; }
      if (BLOCK.has(tag)) {
        flush();
        if (tag === 'p' || tag === 'figcaption' || tag === 'dd' || tag === 'li' || tag === 'div') {
          const kind = {};
          if (/\bli\b/.test(cls)) kind.li = 1;
          if (st.note) kind.note = st.note;
          if (st.quote) kind.quote = 1;
          open({ kind });
        }
        await walk(n, st, docPath);
        flush();
        continue;
      }
      // Inline element
      const ist = { ...st };
      if (tag === 'b' || tag === 'strong') ist.b = true;
      if (tag === 'i' || tag === 'em' || tag === 'cite' || tag === 'var' || tag === 'dfn') ist.i = true;
      if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') ist.m = true;
      if (tag === 'a') {
        const href = attr(n, 'href');
        if (href && !/^[a-z][\w+.-]*:/i.test(href)) {
          open({ kind: kindOf(st) });
          buf.links.push({ href: resolvePath(docPath, href).join('#'), text: (n.textContent || '').replace(/\s+/g, ' ') });
        }
      }
      if (!buf) open({ kind: kindOf(st) });
      await walk(n, ist, docPath);
    }
  }

  const docs = spine.filter((it) => /x?html|xml/.test(it.type) || /^image\//.test(it.type));
  for (let i = 0; i < docs.length; i++) {
    const it = docs[i];
    docNo = i;
    fileStart.set(it.path, blocks.length);
    try {
      if (/^image\//.test(it.type)) await addImage(it.path, it.path);
      else {
        const src = await zip.text(it.path);
        let doc = parse(src, 'xhtml');
        if (parseFailed(doc)) doc = parse(src, 'html');
        const body = elementsByLocal(doc, 'body')[0] || doc.documentElement;
        await walk(body, {}, it.path);
        flush();
      }
    } catch (err) {
      console.warn('EPUB chapter failed', it.path, err);
      push({ t: 'p', runs: [{ s: `[This part of the book could not be read: ${it.path}]`, i: 1 }] });
    }
    onProgress?.(i + 1, docs.length, 'chapters');
  }

  // Page numbering: from the EPUB's page markers if it has them, else none (reader shows %).
  // Without page markers, group by document instead (used for lazy rendering), and show % only.
  const paged = sawBreak;
  blocks.forEach((b) => { if (!paged) b.pg = b._doc; delete b._doc; });

  // Links → block indexes
  const target = (href) => {
    if (!href) return null;
    const [path, frag] = href.split('#');
    if (frag && idMap.has(`${path}#${frag}`)) return Math.min(idMap.get(`${path}#${frag}`), blocks.length - 1);
    return fileStart.has(path) ? Math.min(fileStart.get(path), blocks.length - 1) : null;
  };
  for (const b of blocks) {
    if (b.t !== 'tl') continue;
    const to = target(b.href);
    if (to != null && to >= 0) b.to = to;
    delete b.href;
  }

  const toc = await readToc(zip, parse, items, spineEl, opfPath, target, blocks);
  return {
    model: {
      v: EPUB_IMPORT_VERSION,
      kind: 'epub',
      pageCount: paged ? labels.length : docs.length,
      pages: [],
      labels: paged ? labels : null,
      pageless: !paged,
      lang,
      blocks,
      toc,
    },
    images,
    cover,
    title,
    author,
  };
}

/** Contents from the EPUB 3 nav document, else the EPUB 2 NCX, else the headings. */
async function readToc(zip, parse, items, spineEl, opfPath, target, blocks) {
  const toc = [];
  const add = (title, level, href) => {
    const b = target(href);
    if (b == null || b < 0) return;
    toc.push({ title: title.replace(/\s+/g, ' ').trim() || 'Section', level, b, pg: blocks[b]?.pg ?? 0 });
  };
  const nav = [...items.values()].find((i) => /\bnav\b/.test(i.props));
  if (nav && zip.has(nav.path)) {
    let doc = parse(await zip.text(nav.path), 'xhtml');
    if (parseFailed(doc)) doc = parse(await zip.text(nav.path), 'html');
    const navs = elementsByLocal(doc, 'nav');
    const tocNav = navs.find((n) => /\btoc\b/.test(attr(n, 'epub:type') || '') || attr(n, 'role') === 'doc-toc') || navs[0];
    const walkOl = (ol, level) => {
      for (const li of children(ol).filter((c) => c.nodeType === 1 && local(c) === 'li')) {
        const a = children(li).find((c) => c.nodeType === 1 && (local(c) === 'a' || local(c) === 'span'));
        if (a && local(a) === 'a') add(a.textContent || '', level, resolvePath(nav.path, attr(a, 'href') || '').join('#'));
        const sub = children(li).find((c) => c.nodeType === 1 && local(c) === 'ol');
        if (sub && level < 4) walkOl(sub, level + 1);
      }
    };
    const ol = tocNav && children(tocNav).find((c) => c.nodeType === 1 && local(c) === 'ol');
    if (ol) walkOl(ol, 1);
  }
  if (!toc.length) {
    const ncx = items.get(attr(spineEl || {}, 'toc')) || [...items.values()].find((i) => i.type === 'application/x-dtbncx+xml');
    if (ncx && zip.has(ncx.path)) {
      const doc = parse(await zip.text(ncx.path), 'xml');
      const walkNp = (el, level) => {
        for (const np of children(el).filter((c) => c.nodeType === 1 && local(c) === 'navPoint'.toLowerCase())) {
          const label = elementsByLocal(np, 'text')[0]?.textContent || '';
          const src = attr(elementsByLocal(np, 'content')[0] || {}, 'src');
          if (src) add(label, level, resolvePath(ncx.path, src).join('#'));
          if (level < 4) walkNp(np, level + 1);
        }
      };
      const navMap = elementsByLocal(doc, 'navmap')[0];
      if (navMap) walkNp(navMap, 1);
    }
  }
  if (!toc.length) {
    blocks.forEach((b, i) => { if (b.t === 'h' && b.l <= 3) toc.push({ title: b.runs.map((r) => r.s).join(''), level: b.l, b: i, pg: b.pg }); });
  }
  return toc.sort((a, b) => a.b - b.b);
}

/** Refuse DRM-protected books clearly (font obfuscation alone is fine). */
async function checkDrm(zip, parse) {
  if (!zip.has('META-INF/encryption.xml')) return;
  const doc = parse(await zip.text('META-INF/encryption.xml'), 'xml');
  const algs = elementsByLocal(doc, 'encryptionmethod').map((e) => attr(e, 'Algorithm') || '');
  const fontOnly = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];
  if (algs.some((a) => !fontOnly.includes(a))) throw new Error('This EPUB is protected by DRM (copy protection) and can only be opened in the app it was bought for.');
}
