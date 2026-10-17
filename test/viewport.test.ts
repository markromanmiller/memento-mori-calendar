import { describe, expect, it } from 'vitest';
import { buildGeometry } from '../src/geometry';
import {
  DEFAULT_ZOOM, blockPoint, blockUV, cellAt, cellCentroid, fitScale, laneShape, fitView, todayView, visibleCells,
} from '../src/viewport';

const cells = buildGeometry(89).days;

// Representative viewports: phone portrait, tablet, desktop pane
const SIZES: [string, number, number][] = [
  ['phone', 390, 760],
  ['tablet', 820, 1100],
  ['desktop', 1200, 800],
];

describe('geometry', () => {
  it('has one cell per day for ~89 years', () => {
    expect(cells.length).toBe(32768);
  });
});

describe('fitView', () => {
  it.each(SIZES)('shows every cell on %s', (_, w, h) => {
    expect(visibleCells(cells, fitView(w, h), w, h).length).toBe(cells.length);
  });
});

describe('todayView', () => {
  const today = 11446;

  it.each(SIZES)('opens at %s zoom 64× relative to fit', (_, w, h) => {
    const v = todayView(cells, today, w, h);
    expect(v.k / fitScale(w, h)).toBeCloseTo(DEFAULT_ZOOM);
  });

  it.each(SIZES)('keeps today near the center on %s', (_, w, h) => {
    const v = todayView(cells, today, w, h);
    const [wx, wy] = cellCentroid(cells[today]);
    const sx = wx * v.k + v.x, sy = wy * v.k + v.y;
    // Within a quarter of the short side of center
    const tol = Math.min(w, h) / 4;
    expect(Math.abs(sx - w / 2)).toBeLessThan(tol);
    expect(Math.abs(sy - h / 2)).toBeLessThan(tol);
  });

  it.each(SIZES)('shows roughly a week on %s', (_, w, h) => {
    const visible = visibleCells(cells, todayView(cells, today, w, h), w, h);
    expect(visible).toContain(today);
    expect(visible.length).toBeGreaterThanOrEqual(4);
    expect(visible.length).toBeLessThanOrEqual(30);
  });

  it.each([-1, NaN, cells.length])('falls back to fit view for todayIndex=%s', (idx) => {
    expect(todayView(cells, idx, 390, 760)).toEqual(fitView(390, 760));
  });

  it('handles today at the very start of the curve', () => {
    const v = todayView(cells, 0, 390, 760);
    expect(visibleCells(cells, v, 390, 760)).toContain(0);
  });
});

describe('cellAt', () => {
  const centroids = cells.map(cellCentroid);
  it.each([0, 1, 11446, 32767])('finds day %i at its centroid', (i) => {
    const [x, y] = centroids[i];
    expect(cellAt(cells, centroids, x, y, 5)).toBe(i);
  });
  it('finds nothing far outside the curve', () => {
    expect(cellAt(cells, centroids, -100, -100, 5)).toBe(-1);
  });
});

describe('block frame', () => {
  const geom = buildGeometry(85);   // strongly skewed, so the frame is rotated
  it.each([[0.5, 0.5], [0, 0], [1.5, -1], [-2.25, 3.1]])('round-trips (%f, %f)', (u, v) => {
    for (const [d, q] of [[0, 0], [11446, 57], [32767, 95]]) {
      const block = geom.quarters(d)[q];
      const [x, y] = blockPoint(block, u, v);
      const [u2, v2] = blockUV(block, x, y);
      expect(u2).toBeCloseTo(u, 9);
      expect(v2).toBeCloseTo(v, 9);
    }
  });
  it('puts (0.5, 0.5) at the block center', () => {
    const block = geom.quarters(11446)[10];
    const [x, y] = blockPoint(block, 0.5, 0.5);
    const [cx, cy] = cellCentroid(block);
    expect(x).toBeCloseTo(cx, 9);
    expect(y).toBeCloseTo(cy, 9);
  });
});

describe('laneShape', () => {
  const sq = (x: number, y: number) => ({ points: [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]] as [number, number][] });
  // A row going right, then a turn down: (0,0) → (2,0) → (2,2)
  const blocks = [sq(0, 0), sq(2, 0), sq(2, 2)];
  const area = (p: [number, number][]) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
  it('splits a block into lanes that cover it exactly', () => {
    for (const q of [0, 1, 2]) {
      expect(area(laneShape(blocks, q, 0, 1).poly)).toBeCloseTo(1);
      expect(area(laneShape(blocks, q, 0, 2).poly) + area(laneShape(blocks, q, 1, 2).poly)).toBeCloseTo(1);
    }
  });
  it('keeps each lane on the same side from one block to the next', () => {
    for (const lane of [0, 1]) {
      const a = laneShape(blocks, 0, lane, 2).exit, b = laneShape(blocks, 1, lane, 2).entry;
      expect(a[0][1]).toBeCloseTo(b[0][1]);   // same y band across the horizontal gap
      expect(a[1][1]).toBeCloseTo(b[1][1]);
      const c = laneShape(blocks, 1, lane, 2).exit, d = laneShape(blocks, 2, lane, 2).entry;
      expect(c[0][0]).toBeCloseTo(d[0][0]);   // same x band across the vertical gap after the turn
      expect(c[1][0]).toBeCloseTo(d[1][0]);
    }
  });
});
