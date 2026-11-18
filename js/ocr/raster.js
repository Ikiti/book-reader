// Pixel analysis of a page picture, used together with OCR on scanned/image-only pages:
//   - shaded boxes (code listings, call-outs)   - thin rules (table lines)
//   - pictures (areas with ink that OCR did not read as text)   - ink density per word (bold)
// Pure JS over RGBA pixels, so it runs in browsers and Node.

const WHITE = 250; // luminance at/above which a pixel counts as paper

/**
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img  RGBA pixels
 */
export function analyzeRaster(img) {
  const { data, width: W, height: H } = img;
  const lum = new Uint8Array(W * H);
  const chroma = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    lum[i] = (r * 299 + g * 587 + b * 114) / 1000;
    chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }

  // Integral image of "dark" pixels for fast ink-density queries.
  const ii = new Uint32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += lum[y * W + x] < 128 ? 1 : 0;
      ii[(y + 1) * (W + 1) + x + 1] = ii[y * (W + 1) + x + 1] + row;
    }
  }
  const inkIn = (x0, y0, x1, y1) => {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) return 0;
    const s = ii[y1 * (W + 1) + x1] - ii[y0 * (W + 1) + x1] - ii[y1 * (W + 1) + x0] + ii[y0 * (W + 1) + x0];
    return s / ((x1 - x0) * (y1 - y0));
  };

  // ---- cell grid ----
  const C = Math.max(4, Math.round(W / 250));
  const GW = Math.ceil(W / C);
  const GH = Math.ceil(H / C);
  const gray = new Float32Array(GW * GH);
  const white = new Float32Array(GW * GH);
  const ink = new Float32Array(GW * GH);
  const color = new Float32Array(GW * GH);
  const mean = new Float32Array(GW * GH);
  let darkCells = 0;
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      let n = 0; let g = 0; let w = 0; let k = 0; let c = 0; let sum = 0;
      for (let y = gy * C; y < Math.min(H, gy * C + C); y++) {
        for (let x = gx * C; x < Math.min(W, gx * C + C); x++) {
          const i = y * W + x;
          const l = lum[i];
          n++; sum += l;
          if (l >= WHITE) w++;
          else if (l >= 226 && chroma[i] < 16) g++;
          if (l < 170) k++;
          if (chroma[i] >= 40 && l < 240) c++;
        }
      }
      const j = gy * GW + gx;
      gray[j] = g / n; white[j] = w / n; ink[j] = k / n; color[j] = c / n; mean[j] = sum / n;
      if (sum / n < 200) darkCells++;
    }
  }
  // Anything visibly drawn on the paper (light grey lines, tints), relative to the paper's own
  // shade (scans are rarely pure white): for the outline of figures.
  const paper = [...mean].sort((a, b) => a - b)[Math.floor(mean.length * 0.6)];
  const mark = new Float32Array(GW * GH);
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      let n = 0; let m = 0;
      for (let y = gy * C; y < Math.min(H, gy * C + C); y++) {
        for (let x = gx * C; x < Math.min(W, gx * C + C); x++) { n++; if (lum[y * W + x] < paper - 18) m++; }
      }
      mark[gy * GW + gx] = m / n;
    }
  }

  // ---- shaded boxes: grey cells, closed over the text inside them ----
  let fill = new Uint8Array(GW * GH);
  for (let j = 0; j < fill.length; j++) fill[j] = gray[j] >= 0.4 && white[j] < 0.25 ? 1 : 0;
  const closed = new Uint8Array(fill);
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const j = gy * GW + gx;
      if (fill[j] || white[j] >= 0.3) continue;
      const near = (dx, dy, n) => { for (let k = 1; k <= n; k++) { const x = gx + dx * k; const y = gy + dy * k; if (x < 0 || y < 0 || x >= GW || y >= GH) return false; if (fill[y * GW + x]) return true; if (white[y * GW + x] >= 0.5) return false; } return false; };
      if ((near(-1, 0, 8) && near(1, 0, 8)) || (near(0, -1, 4) && near(0, 1, 4))) closed[j] = 1;
    }
  }
  fill = closed;
  const boxes = components(fill, GW, GH, 4)
    .filter((b) => b.w >= 12 && b.h >= 2 && b.n / (b.w * b.h) >= 0.7)
    .map((b) => ({ x0: b.x * C, y0: b.y * C, x1: Math.min(W, (b.x + b.w) * C), y1: Math.min(H, (b.y + b.h) * C) }));

  // ---- thin rules ----
  // A rule pixel is clearly darker than the paper (or fill) on both sides of it, across or along
  // the line (along: where two rules cross). Solid areas — a dark header bar, a light shading,
  // a figure background — are not lines, and lines drawn on them are still found.
  const D = Math.max(3, Math.round(W / 400));
  const darker = (i, j, k) => lum[i] + 15 < lum[j] && lum[i] + 15 < lum[k];
  const isLine = (x, y) => {
    const i = y * W + x;
    if (lum[i] >= 235) return false;
    return (y >= D && y < H - D && darker(i, i - D * W, i + D * W)) || (x >= D && x < W - D && darker(i, i - D, i + D));
  };
  const hLine = isLine;
  const vLine = isLine;
  const minH = Math.max(80, W * 0.05);
  const hRuns = [];
  for (let y = 0; y < H; y++) {
    let start = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && hLine(x, y);
      if (on && start < 0) start = x;
      else if (!on && start >= 0) { if (x - start >= minH) hRuns.push({ y, x0: start, x1: x }); start = -1; }
    }
  }
  const hRules = stackRuns(hRuns, 'y', 'x0', 'x1').filter((r) => r.t <= 5).map((r) => ({ x0: r.a, x1: r.b, y: r.pos, t: r.t }));
  const minV = Math.max(40, H * 0.025);
  const vRuns = [];
  // Column lines get broken where row lines cross them (and by JPEG noise at row shading):
  // bridge short gaps, as long as the run stays nearly solid (stems of letters that line up in a
  // code listing are mostly gaps). Not for horizontal runs, where it would chain serifs together.
  const GAP = 2 * D + 2;
  for (let x = 0; x < W; x++) {
    let start = -1;
    let lastOn = -1;
    let n = 0;
    for (let y = 0; y <= H; y++) {
      const on = y < H && vLine(x, y);
      if (on) { if (start < 0) { start = y; n = 0; } lastOn = y; n++; continue; }
      if (start >= 0 && (y === H || y - lastOn > GAP)) {
        const len = lastOn + 1 - start;
        if (len >= minV && n >= 0.85 * len) vRuns.push({ x, y0: start, y1: lastOn + 1 });
        start = -1;
      }
    }
  }
  const vRules = stackRuns(vRuns, 'x', 'y0', 'y1').filter((r) => r.t <= 5).map((r) => ({ y0: r.a, y1: r.b, x: r.pos, t: r.t }));

  return {
    W, H, C, GW, GH, ink, color, boxes, hRules, vRules,
    darkRatio: darkCells / (GW * GH),
    inkIn,
    /**
     * Typical stroke thickness in an area, in pixels: 2 × dark area / dark outline. Unlike ink
     * density it doesn't depend on the letters (capitals, short words), so it tells bold apart.
     */
    stroke(x0, y0, x1, y1) {
      x0 = Math.max(1, Math.floor(x0)); y0 = Math.max(1, Math.floor(y0)); x1 = Math.min(W - 1, Math.ceil(x1)); y1 = Math.min(H - 1, Math.ceil(y1));
      let area = 0; let edge = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * W + x;
          if (lum[i] >= 128) continue;
          area++;
          if (lum[i - 1] >= 128 || lum[i + 1] >= 128 || lum[i - W] >= 128 || lum[i + W] >= 128) edge++;
        }
      }
      return edge ? (2 * area) / edge : 0;
    },
    /** Mean darkness (0 = white, 1 = black) of an area: dark header rows of tables. */
    darkness(x0, y0, x1, y1) {
      x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
      let sum = 0; let n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { sum += lum[y * W + x]; n++; }
      return n ? 1 - sum / n / 255 : 0;
    },
    /**
     * Ink that OCR did not read: text-shaped strips (a heading the first pass dropped) and
     * picture-sized areas. Returns {lines, pictures} in pixels.
     */
    uncovered(wordBoxes) {
      const comps = this.pictures(wordBoxes, 0, 0, true);
      const lines = comps.filter((b) => { const h = b.y1 - b.y0; const w = b.x1 - b.x0; return h >= 12 && h <= H * 0.08 && w >= 1.5 * h && b.n / b.cells >= 0.12; });
      return { lines };
    },
    /** Bounding box (pixels) of everything drawn inside an area, or null if it's blank. */
    inkBox(x0, y0, x1, y1) {
      let bx0 = Infinity; let by0 = Infinity; let bx1 = -1; let by1 = -1;
      for (let gy = Math.max(0, Math.floor(y0 / C)); gy < Math.min(GH, Math.ceil(y1 / C)); gy++) {
        for (let gx = Math.max(0, Math.floor(x0 / C)); gx < Math.min(GW, Math.ceil(x1 / C)); gx++) {
          const j = gy * GW + gx;
          if (ink[j] < 0.02 && color[j] < 0.05 && mark[j] < 0.08) continue;
          if (gx < bx0) bx0 = gx; if (gx > bx1) bx1 = gx; if (gy < by0) by0 = gy; if (gy > by1) by1 = gy;
        }
      }
      return bx1 < 0 ? null : { x0: bx0 * C, y0: by0 * C, x1: (bx1 + 1) * C, y1: (by1 + 1) * C };
    },
    /** Pictures: inked cells not explained by text, boxes or rules (call after OCR). */
    pictures(wordBoxes, minW, minH2, all = false) {
      const used = new Uint8Array(GW * GH);
      const mark = (x0, y0, x1, y1, pad) => {
        for (let gy = Math.max(0, Math.floor(y0 / C) - pad); gy <= Math.min(GH - 1, Math.floor(y1 / C) + pad); gy++)
          for (let gx = Math.max(0, Math.floor(x0 / C) - pad); gx <= Math.min(GW - 1, Math.floor(x1 / C) + pad); gx++) used[gy * GW + gx] = 1;
      };
      const cellsOf = (b, fn) => {
        for (let gy = Math.floor(b.y0 / C); gy < Math.min(GH, Math.ceil(b.y1 / C)); gy++)
          for (let gx = Math.floor(b.x0 / C); gx < Math.min(GW, Math.ceil(b.x1 / C)); gx++) fn(gy * GW + gx);
      };
      wordBoxes.forEach((b) => mark(b.x0, b.y0, b.x1, b.y1, 1));
      // A shaded box is a text box (code, note) unless it holds drawing that isn't text: then it's
      // a figure on a tinted background, kept whole as one picture.
      const figures = [];
      boxes.forEach((b) => {
        let n = 0; let k = 0;
        cellsOf(b, (j) => { n++; if (!used[j] && (ink[j] >= 0.06 || color[j] >= 0.12)) k++; });
        if (n && k / n >= 0.08) figures.push(b); else mark(b.x0, b.y0, b.x1, b.y1, 0);
      });
      hRules.forEach((r) => mark(r.x0, r.y - 2, r.x1, r.y + 2, 0));
      vRules.forEach((r) => mark(r.x - 2, r.y0, r.x + 2, r.y1, 0));
      const pic = new Uint8Array(GW * GH);
      for (let j = 0; j < pic.length; j++) pic[j] = !used[j] && (ink[j] >= 0.06 || color[j] >= 0.12) ? 1 : 0;
      figures.forEach((b) => cellsOf(b, (j) => { pic[j] = 1; }));
      return components(pic, GW, GH, 8, 2)
        .map((b) => ({ x0: b.x * C, y0: b.y * C, x1: Math.min(W, (b.x + b.w) * C), y1: Math.min(H, (b.y + b.h) * C), n: b.n, cells: b.w * b.h }))
        .filter((b) => all || (b.x1 - b.x0 >= minW && b.y1 - b.y0 >= minH2 && b.n / b.cells >= 0.15));
    },
  };
}

/** Connected components on a grid (4- or 8-neighbourhood, optional gap bridging). */
function components(grid, GW, GH, conn = 4, gap = 0) {
  const seen = new Uint8Array(grid.length);
  const out = [];
  const stack = [];
  for (let j = 0; j < grid.length; j++) {
    if (!grid[j] || seen[j]) continue;
    let minx = GW; let miny = GH; let maxx = 0; let maxy = 0; let n = 0;
    stack.push(j); seen[j] = 1;
    while (stack.length) {
      const k = stack.pop();
      const x = k % GW;
      const y = (k - x) / GW;
      n++;
      if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y;
      const r = 1 + gap;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (!dx && !dy) continue;
          if (conn === 4 && gap === 0 && dx && dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
          const q = ny * GW + nx;
          if (grid[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
    }
    out.push({ x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1, n });
  }
  return out;
}

/** Merge runs on consecutive rows/columns that overlap into lines with a thickness `t`. */
function stackRuns(runs, posKey, aKey, bKey) {
  const lines = [];
  const open = [];
  for (const r of runs) {
    let hit = null;
    for (const l of open) {
      if (r[posKey] - l.last <= 1 && r[aKey] < l.b && r[bKey] > l.a) { hit = l; break; }
    }
    if (hit) { hit.last = r[posKey]; hit.t++; hit.a = Math.min(hit.a, r[aKey]); hit.b = Math.max(hit.b, r[bKey]); hit.sum += r[posKey]; }
    else { const l = { first: r[posKey], last: r[posKey], t: 1, a: r[aKey], b: r[bKey], sum: r[posKey] }; open.push(l); lines.push(l); }
    // drop lines that ended more than one step ago
    for (let k = open.length - 1; k >= 0; k--) if (r[posKey] - open[k].last > 1) open.splice(k, 1);
  }
  return lines.map((l) => ({ ...l, pos: l.sum / l.t }));
}
