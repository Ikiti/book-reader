// Browser side of "Export EPUB": gathers the stored book, builds the EPUB, offers Download / Share.
import { get } from '../db.js';
import { safeFileName } from '../pdf/title.js';
import { download, h, sheet, toast } from '../ui.js';
import { buildEpub, sniffImage } from './epub.js';

async function imageBytes(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const t = sniffImage(u8);
  if (t) return { data: u8, ...t };
  // Formats EPUB readers may not support (e.g. WebP): re-encode as JPEG.
  const bmp = await createImageBitmap(blob);
  const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  const jpg = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  return { data: new Uint8Array(await jpg.arrayBuffer()), mime: 'image/jpeg', ext: 'jpg' };
}

async function renderCover(bookId) {
  const { openPdf, renderPage } = await import('../pdf/pdfjs.js');
  const f = await get('files', bookId);
  const pdf = await openPdf(new Uint8Array(await f.blob.arrayBuffer()));
  try {
    const p1 = await pdf.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    const canvas = await renderPage(p1, 1000 / vp.width);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return { data: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg', ext: 'jpg' };
  } finally {
    pdf.close();
  }
}

/** Build the EPUB for a book in the library. */
export async function makeEpubFile(bookId) {
  const book = await get('books', bookId);
  const { model } = await get('content', bookId);
  const images = new Map();
  for (const b of model.blocks) {
    if ((b.t === 'img' || b.t === 'scan') && b.k != null && !images.has(b.k)) {
      const row = await get('images', `${bookId}/${b.k}`);
      if (row) images.set(b.k, await imageBytes(row.blob));
    }
  }
  let cover = null;
  try { cover = await renderCover(bookId); } catch { if (book.cover) cover = await imageBytes(book.cover); }
  const bytes = await buildEpub({ id: book.id, title: book.title, author: book.author, model, images, cover, lang: book.lang });
  return new File([bytes], `${safeFileName(book.title)}.epub`, { type: 'application/epub+zip' });
}

/** Build and offer the EPUB. `direct` skips the dialog and downloads straight away (batch). */
export async function exportEpub(bookId, { direct = false } = {}) {
  toast('Creating EPUB…', 20000);
  let file;
  try {
    file = await makeEpubFile(bookId);
  } catch (e) {
    console.error(e);
    toast(`EPUB failed: ${e.message || e}`, 6000);
    return null;
  }
  toast(`EPUB ready: ${file.name}`);
  if (direct) { download(file.name, file); return file; }
  const canShare = !!navigator.canShare?.({ files: [file] });
  const s = sheet('EPUB ready', h('div.form',
    h('p', h('b', file.name), ` · ${(file.size / 1024).toFixed(0)} KB`),
    h('p.muted', 'Open it in any e-book app: Google Play Books, ReadEra, Moon+ Reader, Lithium, Kindle (Send to Kindle), Calibre, Thorium…'),
    h('div.actions',
      canShare ? h('button', {
        onclick: async () => {
          try { await navigator.share({ files: [file], title: file.name }); s.close(); } catch { /* cancelled */ }
        },
      }, 'Share / open in app…') : null,
      h('button.primary#epub-download', { onclick: () => { download(file.name, file); s.close(); } }, 'Download EPUB'))));
  return file;
}
