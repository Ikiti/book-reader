// Minimal ZIP reader (no dependencies): central directory + raw deflate via DecompressionStream.
// Enough for EPUB files (no ZIP64, no encryption). Works in browsers and Node 18+.

/**
 * @param {Uint8Array} u8
 * @returns {{names: string[], has(name): boolean, read(name): Promise<Uint8Array>, text(name): Promise<string>}}
 */
export function openZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // End of central directory: search backwards (a comment may follow it).
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP/EPUB file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged ZIP directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    entries.set(name, { method, csize, usize, off });
    p += 46 + nlen + elen + clen;
  }
  const lower = new Map([...entries.keys()].map((k) => [k.toLowerCase(), k]));
  const find = (name) => entries.get(name) || entries.get(lower.get(String(name).toLowerCase()));

  async function read(name) {
    const e = find(name);
    if (!e) throw new Error(`Missing in EPUB: ${name}`);
    const lh = e.off;
    const start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
    const raw = u8.subarray(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error(`Unsupported compression in ${name}`);
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function text(name) {
    const b = await read(name);
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
    return new TextDecoder('utf-8').decode(b);
  }

  return { names: [...entries.keys()], has: (n) => !!find(n), read, text };
}
