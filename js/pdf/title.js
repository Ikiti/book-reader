// Pick a good book title: PDF metadata unless it is junk, else the first big heading, else the file name.
export function cleanTitle(meta, fileName, model) {
  const bad = /^(untitled|document\d*|microsoft (word|powerpoint)|slide ?\d*|.*\.(docx?|pdf|tex|indd|pptx?))\b/i;
  if (meta && meta.length > 2 && !bad.test(meta)) return meta;
  // File name, minus upload/hash prefixes: "c0e95e0e-Dissecting_the_Dark_Web.pdf" -> "Dissecting the Dark Web"
  let file = fileName.replace(/\.pdf$/i, '').replace(/^[0-9a-f]{6,}[-_ ]+/i, '').replace(/_+/g, ' ');
  if (!/\s/.test(file)) file = file.replace(/-+/g, ' ');
  file = file.replace(/\s+/g, ' ').trim();
  if (file.split(' ').length >= 2 && /\p{L}{3}/u.test(file)) return file;
  // Otherwise the biggest heading on the first pages (the title page).
  const heads = model.blocks.filter((b) => b.t === 'h' && b.pg < 8 && b.runs);
  const top = heads.sort((a, b) => (b.fs || 0) - (a.fs || 0) || a.pg - b.pg)[0];
  const ht = top?.runs.map((r) => r.s).join('').trim();
  if (ht && ht.length < 120) return ht;
  return file || 'Untitled';
}

/** File-system safe name (Windows rules are the strictest). */
export function safeFileName(s) {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'book';
}
