import { describe, expect, it } from 'vitest';
import { buildGeometry, hilbertPoint, QUARTERS_PER_DAY, Cell } from '../src/geometry';
import { cellCentroid } from '../src/viewport';

const flat = buildGeometry(90);
const skewed = buildGeometry(89);
const UNIT = 600 / 127;              // order-7 step at 90°
const BLOCK = UNIT / 24;             // one 15-minute block

/** L-system Hilbert curve as plain integer points (reference for hilbertPoint). */
function lsystemPoints(order: number): [number, number][] {
  const rules: Record<string, string> = { A: '-BF+AFA+FB-', B: '+AF-BFB-FA+' };
  let s = 'A';
  for (let i = 0; i < order; i++) { let n = ''; for (const c of s) n += rules[c] ?? c; s = n; }
  let x = 0, y = 0, a = 0;
  const pts: [number, number][] = [[0, 0]];
  for (const c of s) {
    if (c === 'F') { x += Math.round(Math.cos(a * Math.PI / 180)); y += Math.round(Math.sin(a * Math.PI / 180)); pts.push([x, y]); }
    else if (c === '+') a -= 90; else if (c === '-') a += 90;
  }
  const mx = Math.min(...pts.map(p => p[0])), my = Math.min(...pts.map(p => p[1]));
  return pts.map(([px, py]) => [px - mx, py - my]);
}

const area = (c: Cell) => Math.abs(c.points.reduce((s, p, i) => {
  const q = c.points[(i + 1) % c.points.length];
  return s + p[0] * q[1] - q[0] * p[1];
}, 0)) / 2;
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('hilbertPoint', () => {
  it('matches the L-system curve the layout is traced from', () => {
    const ref = lsystemPoints(7);
    ref.forEach((p, i) => expect(hilbertPoint(7, i)).toEqual(p));
  });

  it.each([8, 9, 10])('order %i coarsens to order 7', (order) => {
    const f = 2 ** (order - 7), per = f * f;
    for (let i = 0; i < 4 ** order; i += 97) {
      const [x, y] = hilbertPoint(order, i);
      expect([Math.floor(x / f), Math.floor(y / f)]).toEqual(hilbertPoint(7, Math.floor(i / per)));
    }
  });
});

describe('days', () => {
  it('has two days per order-7 square', () => {
    expect(flat.days.length).toBe(32768);
  });

  it('are 1:2 rectangles', () => {
    for (let d = 0; d < flat.days.length; d += 101) {
      const xs = flat.days[d].points.map(p => p[0]), ys = flat.days[d].points.map(p => p[1]);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      const [long, short] = w > h ? [w, h] : [h, w];
      expect(long).toBeCloseTo(UNIT - 0.4, 0);
      expect(short).toBeGreaterThan(UNIT / 2 - 0.45);
      expect(short).toBeLessThan(UNIT / 2 - 0.15);
    }
  });

  it('are thinned on exactly the two edges the curve crosses', () => {
    // Each thin half-square edge adds 0.1 × (UNIT/2) of area over the all-gap rectangle
    const base = (UNIT - 0.4) * (UNIT / 2 - 0.4);
    for (let d = 1; d < flat.days.length - 1; d += 7) {
      expect(Math.round((area(flat.days[d]) - base) / (0.1 * UNIT / 2))).toBe(2);
    }
  });

  it('keep consecutive days next to each other with skew', () => {
    for (let d = 1; d < skewed.days.length; d++) {
      expect(dist(cellCentroid(skewed.days[d]), cellCentroid(skewed.days[d - 1]))).toBeLessThan(UNIT * 0.9);
    }
  });
});

describe('quarters', () => {
  it('splits a day into 96 blocks', () => {
    expect(flat.quarters(11446).length).toBe(QUARTERS_PER_DAY);
  });

  it('forms one continuous path, including across days', () => {
    const blocks = [11445, 11446, 11447].flatMap(d => flat.quarters(d)).map(cellCentroid);
    for (let i = 1; i < blocks.length; i++) expect(dist(blocks[i], blocks[i - 1])).toBeCloseTo(BLOCK, 6);
  });

  it('stays continuous with skew', () => {
    const blocks = [100, 101, 102, 103].flatMap(d => skewed.quarters(d)).map(cellCentroid);
    for (let i = 1; i < blocks.length; i++) {
      const step = dist(blocks[i], blocks[i - 1]);
      expect(step).toBeGreaterThan(BLOCK * 0.8);
      expect(step).toBeLessThan(BLOCK * 1.2);
    }
  });

  it('never repeats a block', () => {
    const keys = flat.quarters(11446).map(c => cellCentroid(c).map(v => v.toFixed(4)).join());
    expect(new Set(keys).size).toBe(QUARTERS_PER_DAY);
  });

  it('lies inside its day', () => {
    const day = flat.days[11446];
    const xs = day.points.map(p => p[0]), ys = day.points.map(p => p[1]);
    for (const [x, y] of flat.quarters(11446).map(cellCentroid)) {
      expect(x).toBeGreaterThan(Math.min(...xs) - 0.2);
      expect(x).toBeLessThan(Math.max(...xs) + 0.2);
      expect(y).toBeGreaterThan(Math.min(...ys) - 0.2);
      expect(y).toBeLessThan(Math.max(...ys) + 0.2);
    }
  });
});
