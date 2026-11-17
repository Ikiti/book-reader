// Small geometry helpers. All rects are {x0, y0, x1, y1} in page viewport units
// (scale 1, origin top-left, y grows downward).

export const area = (r) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
export const width = (r) => r.x1 - r.x0;
export const height = (r) => r.y1 - r.y0;

export function union(a, b) {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export function overlaps(a, b, pad = 0) {
  return a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;
}

export function containsPoint(r, x, y, pad = 0) {
  return x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad;
}

export function center(r) {
  return [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
}

/** Repeatedly merge rects that overlap (within pad) until stable. Keeps a `members` count. */
export function mergeRects(rects, pad = 0) {
  let list = rects.map((r) => ({ ...r, members: r.members ?? 1 }));
  let changed = true;
  while (changed) {
    changed = false;
    const out = [];
    for (const r of list) {
      const hit = out.find((o) => overlaps(o, r, pad));
      if (hit) {
        Object.assign(hit, union(hit, r), {
          members: hit.members + r.members,
          curves: hit.curves || r.curves,
        });
        changed = true;
      } else {
        out.push({ ...r });
      }
    }
    list = out;
  }
  return list;
}

/** Cluster 1-D values: returns sorted cluster centers (values closer than tol are merged). */
export function clusterValues(values, tol) {
  const v = [...values].sort((a, b) => a - b);
  const out = [];
  let group = [];
  for (const x of v) {
    if (group.length && x - group[group.length - 1] > tol) {
      out.push(group.reduce((s, n) => s + n, 0) / group.length);
      group = [];
    }
    group.push(x);
  }
  if (group.length) out.push(group.reduce((s, n) => s + n, 0) / group.length);
  return out;
}

export function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Weighted mode of numbers rounded to `step`. */
export function weightedMode(pairs, step = 0.5) {
  const m = new Map();
  for (const [v, w] of pairs) {
    const k = Math.round(v / step) * step;
    m.set(k, (m.get(k) || 0) + w);
  }
  let best = 0;
  let bestW = -1;
  for (const [k, w] of m) if (w > bestW) { best = k; bestW = w; }
  return best;
}
