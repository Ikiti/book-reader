// Reading-progress model (js/progress.js): ranges, chapters, attention credit, re-process remap.
import {
  addRange, removeRange, isRead, firstUnread, readSize, prefix, blockSizes, chapterRanges, rangeStats,
  creditVisible, updateSpeed, loadReading, remapReading, timeFor, CREDIT_RATE, READ_SHARE,
} from '../js/progress.js';

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} progress: ${name}`); if (!cond) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ranges
let r = [];
r = addRange(r, 5, 8);
r = addRange(r, 1, 3);
r = addRange(r, 3, 5); // touching ranges merge
check('ranges merge', eq(r, [[1, 8]]));
r = addRange(r, 10, 12);
check('separate ranges kept apart', eq(r, [[1, 8], [10, 12]]));
check('insert between ranges', eq(addRange([[1, 2], [10, 12], [20, 22]], 5, 6), [[1, 2], [5, 6], [10, 12], [20, 22]]));
check('bridge several ranges', eq(addRange([[1, 2], [4, 5], [7, 9], [20, 22]], 2, 7), [[1, 9], [20, 22]]));
check('isRead', isRead(r, 1) && isRead(r, 7) && !isRead(r, 8) && isRead(r, 11) && !isRead(r, 0));
check('firstUnread skips read runs', firstUnread(r, 1, 20) === 8 && firstUnread(r, 10, 12) === -1 && firstUnread(r, 0, 5) === 0);
check('removeRange splits', eq(removeRange(r, 3, 11), [[1, 3], [11, 12]]));

// a small book: 3 chapters (one with a section), 12 blocks of 100 chars
const blocks = Array.from({ length: 12 }, (_, i) => ({ t: 'p', pg: Math.floor(i / 3), runs: [{ s: 'x'.repeat(100) }] }));
const toc = [{ title: 'One', b: 0, level: 1 }, { title: 'One.A', b: 2, level: 2 }, { title: 'Two', b: 4, level: 1 }, { title: 'Three', b: 8, level: 1 }];
const sizes = blockSizes(blocks);
const pre = prefix(sizes);
const ch = chapterRanges(toc, blocks.length);
check('chapter ranges (section inside chapter)', eq(ch.map((c) => [c.from, c.to]), [[0, 4], [2, 4], [4, 8], [8, 12]]));

// reading just a couple of paragraphs in the middle of chapter Two
const reading = loadReading({}, blocks.length);
const credit = new Map();
const perBlock = (100 * READ_SHARE) / CREDIT_RATE; // seconds a 100-char block needs
creditVisible(reading, credit, sizes, [5, 6, 7], perBlock * 2 + 0.01);
check('dwell marks only what was on screen long enough', eq(reading.read, [[5, 7]]) && credit.get(7) > 0);
const two = rangeStats(reading, pre, ch[2].from, ch[2].to);
check(`chapter Two: started, 50%, continue at block 4 (${two.state} ${two.pct} ${two.next})`, two.state === 'started' && two.pct === 0.5 && two.next === 4);
check('chapter One untouched', rangeStats(reading, pre, ch[0].from, ch[0].to).state === 'new');

// scrolling fast past text marks nothing
const r2 = loadReading({}, blocks.length);
creditVisible(r2, new Map(), sizes, [0, 1, 2, 3], 0.5);
check('a quick scroll marks nothing', r2.read.length === 0);

// finishing a chapter / book share
reading.read = addRange(reading.read, 4, 8);
check('chapter Two done', rangeStats(reading, pre, 4, 8).state === 'done');
check('book share', readSize(reading.read, pre) / pre[pre.length - 1] === 4 / 12);

// old books: everything before the saved position counts as read
const old = loadReading({ progress: { b: 6 } }, 12);
check('upgrade from position-only books', eq(old.read, [[0, 6]]));

check('speed: needs a minute of data', updateSpeed(15, 300, 30) === 15);
check('speed: moves toward the sample', updateSpeed(15, 1800, 60) === 19.5);
check('time format', timeFor(15 * 60 * 5, 15) === '5 min' && timeFor(15 * 60 * 80, 15) === '1 h 20 min');

// re-process: block numbers change (each page now has 2 blocks instead of 3)
const newModel = { blocks: Array.from({ length: 8 }, (_, i) => ({ t: 'p', pg: Math.floor(i / 2), runs: [{ s: i === 5 ? 'The quote is here.' : 'y'.repeat(150) }] })) };
const book = { progress: { b: 7, pgi: 2 }, reading: { read: [[0, 6]], bookmarks: [{ id: 'm', b: 9, pgi: 3 }] } };
const notes = [{ id: 'n', block: 4, quote: 'The quote is here.' }];
const moved = remapReading({ blocks }, newModel, book, notes);
check('remap: read pages stay read', eq(moved.reading.read, [[0, 4]]));
check('remap: position keeps its page', moved.progress.b === 4);
check('remap: bookmark keeps its page', moved.reading.bookmarks[0].b === 6);
check('remap: note finds its quote', moved.notes[0].block === 5);

console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
