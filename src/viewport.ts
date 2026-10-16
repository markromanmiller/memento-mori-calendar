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
export const MAX_ZOOM = 256;

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
