/**
 * Pure viewport math (no DOM, no d3) so it can be unit-tested.
 *
 * "Zoom" in user-facing terms is always relative to the fit scale: 1× shows the
 * whole curve, 64× shows roughly a week.
 */
import type { Cell } from './geometry';

export const WORLD_SIZE = 600;
const FIT_PADDING = 24;

/** Relative zoom the view opens at and the Today button returns to (~7 days). */
export const DEFAULT_ZOOM = 64;
/** Days on each side of today averaged to find the default view's center. */
export const DEFAULT_WINDOW_RADIUS = 3;
/** Relative zoom limits for pinch/scroll. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 1024;
/** At this relative zoom and above, days are drawn as 15-minute blocks. */
export const QUARTER_VIEW_ZOOM = 64;

/** True when the view should show 15-minute blocks (tolerates float error at exactly 64×). */
export const isQuarterView = (relativeZoom: number) => relativeZoom >= QUARTER_VIEW_ZOOM * (1 - 1e-9);

export type View = { k: number; x: number; y: number };

/** Absolute scale at which the whole world square fits the viewport. */
export function fitScale(canvasW: number, canvasH: number): number {
  return Math.max(1e-6, (Math.min(canvasW, canvasH) - FIT_PADDING * 2) / WORLD_SIZE);
}

export function fitView(canvasW: number, canvasH: number): View {
  const k = fitScale(canvasW, canvasH);
  return { k, x: (canvasW - WORLD_SIZE * k) / 2, y: (canvasH - WORLD_SIZE * k) / 2 };
}

/** View with world point (wx, wy) at the canvas center at absolute scale k. */
export function centeredView(canvasW: number, canvasH: number, wx: number, wy: number, k: number): View {
  return { k, x: canvasW / 2 - wx * k, y: canvasH / 2 - wy * k };
}

export function cellCentroid(cell: Cell): [number, number] {
  const pts = cell.points;
  const n = pts.length;
  return [
    pts.reduce((s, p) => s + p[0], 0) / n,
    pts.reduce((s, p) => s + p[1], 0) / n,
  ];
}

/** Mean centroid of cells [center - radius, center + radius], clamped to the curve. */
export function windowCentroid(cells: Cell[], center: number, radius: number): [number, number] | null {
  const start = Math.max(0, center - radius);
  const end = Math.min(cells.length - 1, center + radius);
  if (start > end) return null;
  let sx = 0, sy = 0;
  for (let i = start; i <= end; i++) {
    const [cx, cy] = cellCentroid(cells[i]);
    sx += cx; sy += cy;
  }
  const n = end - start + 1;
  return [sx / n, sy / n];
}

/**
 * The view the calendar opens at: DEFAULT_ZOOM centered on the week around today.
 * Falls back to the fit view when today is off the curve (e.g. invalid birth date).
 */
export function todayView(cells: Cell[], todayIndex: number, canvasW: number, canvasH: number): View {
  if (!Number.isFinite(todayIndex) || todayIndex < 0 || todayIndex >= cells.length) {
    return fitView(canvasW, canvasH);
  }
  const c = windowCentroid(cells, todayIndex, DEFAULT_WINDOW_RADIUS);
  if (!c) return fitView(canvasW, canvasH);
  return centeredView(canvasW, canvasH, c[0], c[1], fitScale(canvasW, canvasH) * DEFAULT_ZOOM);
}

/** Indices of cells whose centroid falls inside the canvas under view v. */
export function visibleCells(cells: Cell[], v: View, canvasW: number, canvasH: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    const [wx, wy] = cellCentroid(cells[i]);
    const sx = wx * v.k + v.x, sy = wy * v.k + v.y;
    if (sx >= 0 && sx <= canvasW && sy >= 0 && sy <= canvasH) out.push(i);
  }
  return out;
}

export function pointInPolygon(px: number, py: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Index of the cell containing world point (wx, wy); a point in a gap goes to the nearest centroid
 * within maxDist. -1 when there is none. `centroids` are the cells' centroids, precomputed.
 */
export function cellAt(cells: Cell[], centroids: [number, number][], wx: number, wy: number, maxDist: number): number {
  let best = -1, bestD = maxDist * maxDist;
  for (let i = 0; i < cells.length; i++) {
    const dx = centroids[i][0] - wx, dy = centroids[i][1] - wy;
    const d = dx * dx + dy * dy;
    if (d > 4 * maxDist * maxDist) continue;
    if (pointInPolygon(wx, wy, cells[i].points)) return i;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * A point in a block's own frame: (0,0) is its first corner, (1,0) the second, (0,1) the fourth. Values outside
 * 0–1 reach the free space around the block. The frame turns with the curve skew, so anchors stay put.
 */
export function blockPoint(cell: Cell, u: number, v: number): [number, number] {
  const [p0, p1, , p3] = cell.points;
  return [p0[0] + u * (p1[0] - p0[0]) + v * (p3[0] - p0[0]), p0[1] + u * (p1[1] - p0[1]) + v * (p3[1] - p0[1])];
}

/** Inverse of blockPoint. */
export function blockUV(cell: Cell, x: number, y: number): [number, number] {
  const [p0, p1, , p3] = cell.points;
  const ax = p1[0] - p0[0], ay = p1[1] - p0[1], bx = p3[0] - p0[0], by = p3[1] - p0[1];
  const det = ax * by - ay * bx;
  const dx = x - p0[0], dy = y - p0[1];
  return [(dx * by - dy * bx) / det, (ax * dy - ay * dx) / det];
}

type Pt = [number, number];
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * Lane `lane` of `lanes` through block q of a day's blocks: the parallel strip an entry keeps when it
 * overlaps others. Lanes are counted from the left of the direction of travel (previous block to next),
 * so a lane continues from block to block; in a block where the path turns, a lane is an L around the
 * inner corner. `entry` and `exit` are the lane's stretch of the block's entry and exit edges, left end
 * first, for filling the gap to the next block. One lane is the whole block.
 */
export function laneShape(blocks: Cell[], q: number, lane: number, lanes: number): { poly: Pt[]; entry: [Pt, Pt]; exit: [Pt, Pt] } {
  const pts = blocks[q].points as Pt[];
  const c = cellCentroid(blocks[q]);
  const prev = q > 0 ? cellCentroid(blocks[q - 1]) : null;
  const next = q < blocks.length - 1 ? cellCentroid(blocks[q + 1]) : null;
  const nearestEdge = (t: Pt) => {
    let best = 0, bestD = Infinity;
    for (let j = 0; j < 4; j++) {
      const [mx, my] = lerp(pts[j], pts[(j + 1) % 4], 0.5);
      const d = Math.hypot(mx - t[0], my - t[1]);
      if (d < bestD) { bestD = d; best = j; }
    }
    return best;
  };
  let inE = prev ? nearestEdge(prev) : -1, outE = next ? nearestEdge(next) : -1;
  if (inE < 0) inE = (outE + 2) % 4;
  if (outE < 0) outE = (inE + 2) % 4;
  const tIn: Pt = prev ? [c[0] - prev[0], c[1] - prev[1]] : [next![0] - c[0], next![1] - c[1]];
  const tOut: Pt = next ? [next[0] - c[0], next[1] - c[1]] : tIn;
  const isLeft = (t: Pt, p: Pt) => t[0] * (p[1] - c[1]) - t[1] * (p[0] - c[0]) < 0;
  // An edge's two ends, left first
  const ends = (e: number, t: Pt): [Pt, Pt] => {
    const a = pts[e], b = pts[(e + 1) % 4];
    return isLeft(t, a) ? [a, b] : [b, a];
  };
  const [inL, inR] = ends(inE, tIn);
  if ((inE + 2) % 4 === outE) {
    const [outL, outR] = ends(outE, tOut);
    const k0 = lane / lanes, k1 = (lane + 1) / lanes;
    const eL = lerp(inL, inR, k0), eR = lerp(inL, inR, k1), oL = lerp(outL, outR, k0), oR = lerp(outL, outR, k1);
    return { poly: [eL, eR, oR, oL], entry: [eL, eR], exit: [oL, oR] };
  }
  // A turn: lanes are L-shapes nested around the corner X the entry and exit edges share
  const x = outE === (inE + 1) % 4 ? (inE + 1) % 4 : inE;
  const X = pts[x];
  const A = pts[x === inE ? (inE + 1) % 4 : inE];             // the entry edge's other end
  const B = pts[x === outE ? (outE + 1) % 4 : outE];          // the exit edge's other end
  const xLeft = inL === X;                                    // a left turn: the inner corner is on the left
  const i = xLeft ? lane : lanes - 1 - lane;
  const a = i / lanes, b = (i + 1) / lanes;
  const P = (s: number, t: number): Pt => [X[0] + s * (A[0] - X[0]) + t * (B[0] - X[0]), X[1] + s * (A[1] - X[1]) + t * (B[1] - X[1])];
  const entry: [Pt, Pt] = xLeft ? [P(a, 0), P(b, 0)] : [P(b, 0), P(a, 0)];
  const exit: [Pt, Pt] = xLeft ? [P(0, a), P(0, b)] : [P(0, b), P(0, a)];
  return { poly: [P(a, 0), P(b, 0), P(b, b), P(0, b), P(0, a), P(a, a)], entry, exit };
}
