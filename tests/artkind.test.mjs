// Dark mode: which pictures are line art (shown inverted) and which are photos (dimmed).
import { classifyPixels } from '../js/artkind.js';

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} artkind: ${name}`); if (!cond) failed++; };
const W = 200;
const H = 120;
const make = (fn) => {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b, a = 255] = fn(x, y); d.set([r, g, b, a], (y * W + x) * 4); }
  return d;
};
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const diagram = make((x, y) => ((x % 50 < 2 || y % 40 < 2) ? [20, 20, 20] : [252, 252, 250])); // boxes and lines
check('diagram → line', classifyPixels(diagram, W) === 'line');
const chart = make((x, y) => (y > 30 && x % 50 > 10 && x % 50 < 35 ? [[220, 100, 90], [80, 140, 210], [90, 160, 90], [200, 130, 40]][Math.floor(x / 50)] : [250, 250, 248]));
check('bar chart with flat colours → line', classifyPixels(chart, W) === 'line');
const text = make((x, y) => (y % 12 < 7 && rnd() < 0.35 ? [30, 30, 30] : [245, 244, 240])); // a page of text
check('text page → line', classifyPixels(text, W) === 'line');
const photo = make(() => { const v = 60 + rnd() * 150; return [v, v * 0.9, v * 0.8]; });
check('photo → photo', classifyPixels(photo, W) === 'photo');
const shot = make((x, y) => (x > 40 && x < 100 && y > 10 && y < 70 ? (() => { const v = 60 + rnd() * 150; return [v, v, v]; })() : [252, 252, 252]));
check('screenshot with a photo in it → photo', classifyPixels(shot, W) === 'photo');
const clear = make(() => [0, 0, 0, 0]);
check('transparent background counts as paper', classifyPixels(clear, W) === 'line');

console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
