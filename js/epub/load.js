// Browser side of opening an EPUB: parse with the built-in DOMParser, turn pictures into Blobs,
// make a small cover thumbnail for the library.
import { importEpub } from './import.js';

const parser = new DOMParser();
const TYPES = { xml: 'application/xml', xhtml: 'application/xhtml+xml', html: 'text/html' };
const parse = (text, type) => parser.parseFromString(text, TYPES[type] || 'text/html');
const xml = new XMLSerializer();
const serialize = (el) => xml.serializeToString(el);

/** Decode any picture the browser can show, SVG included (createImageBitmap can't do SVG). */
async function decode(blob) {
  try { return await createImageBitmap(blob); } catch { /* try an <img> */ }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth) throw new Error('empty');
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function thumbnail(blob) {
  try {
    const bmp = await decode(blob);
    const scale = Math.min(1, 360 / bmp.width);
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  } catch {
    return null; // e.g. an SVG cover the browser can't rasterise: the library shows the title letter
  }
}

/** Same result shape as processPdf() in pdf/pdfjs.js. */
export async function processEpub(arrayBuffer, onProgress) {
  const res = await importEpub(new Uint8Array(arrayBuffer), { parse, serialize, onProgress });
  const images = res.images.map((im) => new Blob([im.data], { type: im.mime }));
  let cover = res.cover ? await thumbnail(new Blob([res.cover.data], { type: res.cover.mime })) : null;
  if (!cover) {
    // No declared cover: use the first picture of the book if it's big enough.
    const first = res.model.blocks.find((b) => b.t === 'img' && b.w >= 200 && b.h >= 200);
    if (first) cover = await thumbnail(images[first.k]);
  }
  return { model: res.model, images, cover, title: res.title, author: res.author };
}
