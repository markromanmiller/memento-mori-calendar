/**
 * Hilbert curve geometry generation — ported from hilbert_integrated.py.
 * Cells are precomputed as inset polygons in world space (no per-frame transforms needed).
 */

// Equivalent gap to the old stroke-width 0.4 (centered, so 0.2 per edge)
const INSET = 0.2;

export type Cell = { points: [number, number][] };

// ---------------------------------------------------------------------------
// L-system
// ---------------------------------------------------------------------------

function generateLSystem(order: number): string {
  const rules: Record<string, string> = { A: '-BF+AFA+FB-', B: '+AF-BFB-FA+' };
  let s = 'A';
  for (let i = 0; i < order; i++) {
    let next = '';
    for (const ch of s) next += rules[ch] ?? ch;
    s = next;
  }
  return s;
}

type RawPoint = { x: number; y: number; angleIn: number | null; angleOut: number | null };

function tracePoints(lsystem: string, turnAngle: number): RawPoint[] {
  let x = 0, y = 0, angle = 0;
  const positions: [number, number][] = [[x, y]];
  for (const ch of lsystem) {
    if (ch === 'F') {
      x += Math.cos((angle * Math.PI) / 180);
      y += Math.sin((angle * Math.PI) / 180);
      positions.push([x, y]);
    } else if (ch === '+') angle -= turnAngle;
    else if (ch === '-') angle += turnAngle;
  }
  const angleIn: (number | null)[] = new Array(positions.length).fill(null);
  const angleOut: (number | null)[] = new Array(positions.length).fill(null);
  let ptIdx = 0; angle = 0;
  for (const ch of lsystem) {
    if (ch === 'F') {
      angleOut[ptIdx] = angle; ptIdx++; angleIn[ptIdx] = angle;
    } else if (ch === '+') angle -= turnAngle;
    else if (ch === '-') angle += turnAngle;
  }
  return positions.map(([px, py], i) => ({
    x: px, y: py,
    angleIn: angleIn[i] ?? angleOut[i],
    angleOut: angleOut[i] ?? angleIn[i],
  }));
}

function normalizePoints(pts: RawPoint[], targetSize: number): { pts: RawPoint[]; cellSize: number } {
  const minX = Math.min(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y));
  const maxX = Math.max(...pts.map(p => p.x));
  const maxY = Math.max(...pts.map(p => p.y));
  const scale = targetSize / Math.max(maxX - minX, maxY - minY);
  return {
    pts: pts.map(p => ({ ...p, x: (p.x - minX) * scale, y: (p.y - minY) * scale })),
    cellSize: scale,
  };
}

// ---------------------------------------------------------------------------
// Polygon inset — works for any convex polygon, winding-agnostic
// ---------------------------------------------------------------------------

function insetPolygon(pts: [number, number][], d: number): [number, number][] {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p[0], 0) / n;
  const cy = pts.reduce((s, p) => s + p[1], 0) / n;

  return pts.map((b, i) => {
    const a = pts[(i - 1 + n) % n];
    const c = pts[(i + 1) % n];

    // Edge a→b: inward normal pointing toward centroid
    let dx1 = b[0] - a[0], dy1 = b[1] - a[1];
    const l1 = Math.hypot(dx1, dy1); dx1 /= l1; dy1 /= l1;
    let nx1 = dy1, ny1 = -dx1;
    if (nx1 * (cx - (a[0] + b[0]) / 2) + ny1 * (cy - (a[1] + b[1]) / 2) < 0) {
      nx1 = -nx1; ny1 = -ny1;
    }

    // Edge b→c: inward normal
    let dx2 = c[0] - b[0], dy2 = c[1] - b[1];
    const l2 = Math.hypot(dx2, dy2); dx2 /= l2; dy2 /= l2;
    let nx2 = dy2, ny2 = -dx2;
    if (nx2 * (cx - (b[0] + c[0]) / 2) + ny2 * (cy - (b[1] + c[1]) / 2) < 0) {
      nx2 = -nx2; ny2 = -ny2;
    }

    // Intersect the two inset lines to find the inset corner
    const p1x = b[0] + d * nx1, p1y = b[1] + d * ny1;
    const p2x = b[0] + d * nx2, p2y = b[1] + d * ny2;
    const denom = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(denom) < 1e-10) return [p1x, p1y] as [number, number];
    const t = ((p2x - p1x) * dy2 - (p2y - p1y) * dx2) / denom;
    return [p1x + t * dx1, p1y + t * dy1] as [number, number];
  });
}

// ---------------------------------------------------------------------------
// Cell shape construction (returns inset polygon points)
// ---------------------------------------------------------------------------

function makeRects(x: number, y: number, cellSize: number, angle: number): Cell[] {
  const short = cellSize / 2, long = cellSize, offset = cellSize / 4;
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const hw = short / 2, hh = long / 2;
  const localCorners: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];

  return ([-1, 1] as const).map(sign => {
    const cx = x + sign * offset * cos;
    const cy = y + sign * offset * sin;
    const pts: [number, number][] = localCorners.map(([lx, ly]) => [
      cx + lx * cos - ly * sin,
      cy + lx * sin + ly * cos,
    ]);
    return { points: insetPolygon(pts, INSET) };
  });
}

function makeTris(x: number, y: number, cellSize: number, angleIn: number, angleOut: number): Cell[] {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const vIn = [Math.cos(rad(angleIn)), Math.sin(rad(angleIn))];
  const vOut = [Math.cos(rad(angleOut)), Math.sin(rad(angleOut))];
  const bisector = [(vIn[0] + vOut[0]) / 2, (vIn[1] + vOut[1]) / 2];
  const bisAngle = Math.atan2(bisector[1], bisector[0]) * (180 / Math.PI);
  const diagAngle = bisAngle + 90;
  const halfDiag = (cellSize * Math.sqrt(2)) / 2;
  const dr = rad(diagAngle), pr = rad(diagAngle + 90);

  const c1: [number, number] = [x + halfDiag * Math.cos(dr), y + halfDiag * Math.sin(dr)];
  const c2: [number, number] = [x - halfDiag * Math.cos(dr), y - halfDiag * Math.sin(dr)];
  const c3: [number, number] = [x + halfDiag * Math.cos(pr), y + halfDiag * Math.sin(pr)];
  const c4: [number, number] = [x - halfDiag * Math.cos(pr), y - halfDiag * Math.sin(pr)];

  return [
    { points: insetPolygon([c1, c3, c2], INSET) },
    { points: insetPolygon([c1, c4, c2], INSET) },
  ];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function buildGeometry(order = 7, turnAngle = 89, worldSize = 600): Cell[] {
  const lsystem = generateLSystem(order);
  const raw = tracePoints(lsystem, turnAngle);
  const { pts, cellSize } = normalizePoints(raw, worldSize);
  const cells: Cell[] = [];

  for (const { x, y, angleIn, angleOut } of pts) {
    if (angleIn === null || angleOut === null) {
      cells.push(...makeRects(x, y, cellSize, angleIn ?? angleOut ?? 0));
      continue;
    }
    const diff = Math.abs(((angleOut - angleIn) % 360 + 360) % 360);
    const isTurn = diff > 5 && Math.abs(diff - 360) > 5;
    cells.push(...(isTurn
      ? makeTris(x, y, cellSize, angleIn, angleOut)
      : makeRects(x, y, cellSize, angleIn)));
  }

  return cells;
}
