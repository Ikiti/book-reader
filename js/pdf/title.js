// Pick a good book title: PDF metadata unless it is junk, else the first big heading, else the file name.
export function cleanTitle(meta, fileName, model) {
  const bad = /^(untitled|document\d*|microsoft (word|powerpoint)|slide ?\d*|.*\.(docx?|pdf|tex|indd|pptx?))\b/i;
  if (meta && meta.length > 2 && !bad.test(meta)) return meta;
  const firstHeading = model.blocks.find((b) => b.t === 'h' && b.pg === 0 && b.l === 1);
  const ht = firstHeading?.runs.map((r) => r.s).join('').trim();
  if (ht && ht.length < 120) return ht;
  return fileName.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
}

/** File-system safe name (Windows rules are the strictest). */
export function safeFileName(s) {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'book';
}
