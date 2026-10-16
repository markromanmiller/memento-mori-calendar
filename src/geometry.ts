/**
 * Calendar geometry on a Hilbert curve.
 *
 * Hierarchy (each level is one more order of the same Hilbert curve):
 *   order 7  — 128×128 squares, laid out with the configurable skew; two days each
 *   order 8  — half-squares; a day is two consecutive ones (a 1:2 rectangle)
 *   order 9  — 3-hour squares (8 per day)
 *   order 10 — 45-minute squares (32 per day), each split 3×3; the path runs
 *              entry-middle → center → exit-middle, one 15-minute block per cell
 *
 * Positions inside an order-7 square come from the unskewed curve, rotated and
 * scaled to wherever that square sits in the skewed layout.
 */

export type Cell = { points: [number, number][] };
type P = [number, number];

export const DAY_ORDER = 7;
export const QUARTERS_PER_DAY = 96;
const N7 = 2 ** DAY_ORDER;

// World-space gaps between days: 0.4 normally, half that where the curve
// passes from one day into the next.
const GAP_INSET = 0.2;
const THIN_INSET = 0.1;

// ---------------------------------------------------------------------------
// Hilbert index → grid position. Matches the L-system curve below at every order.
// ---------------------------------------------------------------------------

export function hilbertPoint(order: number, d: number): P {
  const n = 2 ** order;
  let x = 0, y = 0;
  for (let s = 1, t = d; s < n; s *= 2) {
    const rx = 1 & (t >> 1), ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      const tmp = x; x = y; y = tmp;
    }
    x += s * rx; y += s * ry;
    t >>= 2;
  }
  return [x, y];
}

// ---------------------------------------------------------------------------
// Skewed order-7 layout (L-system with a turn angle slightly off 90°)
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

/** Points and the heading (degrees) leaving each point. */
function tracePoints(lsystem: string, turnAngle: number): { pts: P[]; heading: number[] } {
  let x = 0, y = 0, angle = 0;
  const pts: P[] = [[x, y]];
  const heading: number[] = [];
  for (const ch of lsystem) {
    if (ch === 'F') {
      heading.push(angle);
      x += Math.cos((angle * Math.PI) / 180);
      y += Math.sin((angle * Math.PI) / 180);
      pts.push([x, y]);
    } else if (ch === '+') angle -= turnAngle;
    else if (ch === '-') angle += turnAngle;
  }
  heading.push(angle);
  return { pts, heading };
}

function normalize(pts: P[], targetSize: number): P[] {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const scale = targetSize / Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
  return pts.map(([x, y]) => [(x - minX) * scale, (y - minY) * scale]);
}

// ---------------------------------------------------------------------------
// Axis-aligned rectangle with a separate inset per boundary segment
// ---------------------------------------------------------------------------

/**
 * Inset an axis-aligned rectangle [x0,x1]×[y0,y1] whose boundary is split into
 * segments of length `step`. `insetFor(mid, outward)` gives each segment's inset.
 * Collinear segments with different insets produce a small jog.
 */
function insetRect(
  x0: number, x1: number, y0: number, y1: number, step: number,
  insetFor: (mid: P, outward: P) => number,
): P[] {
  type E = { end: P; n: P; d: number };   // n = inward normal
  const edges: E[] = [];
  const eps = step * 1e-3;
  for (let x = x0; x < x1 - eps; x += step) edges.push({ end: [x + step, y0], n: [0, 1], d: insetFor([x + step / 2, y0], [0, -1]) });
  for (let y = y0; y < y1 - eps; y += step) edges.push({ end: [x1, y + step], n: [-1, 0], d: insetFor([x1, y + step / 2], [1, 0]) });
  for (let x = x1; x > x0 + eps; x -= step) edges.push({ end: [x - step, y1], n: [0, -1], d: insetFor([x - step / 2, y1], [0, 1]) });
  for (let y = y1; y > y0 + eps; y -= step) edges.push({ end: [x0, y - step], n: [1, 0], d: insetFor([x0, y - step / 2], [-1, 0]) });
  const out: P[] = [];
  edges.forEach((e1, i) => {
    const e2 = edges[(i + 1) % edges.length];
    const [vx, vy] = e1.end;
    if (e1.n[0] === e2.n[0] && e1.n[1] === e2.n[1]) {
      if (e1.d !== e2.d) {
        out.push([vx + e1.n[0] * e1.d, vy + e1.n[1] * e1.d], [vx + e2.n[0] * e2.d, vy + e2.n[1] * e2.d]);
      }
    } else {
      out.push([vx + e1.n[0] * e1.d + e2.n[0] * e2.d, vy + e1.n[1] * e1.d + e2.n[1] * e2.d]);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Public geometry
// ---------------------------------------------------------------------------

export class CalendarGeometry {
  /** One polygon per day, in world coordinates. */
  readonly days: Cell[];
  private readonly skewPts: P[];
  private readonly rot: { cos: number; sin: number }[];
  /** World length of one order-7 step in the skewed layout. */
  private readonly unit: number;
  private quarterCache = new Map<number, Cell[]>();

  constructor(turnAngle = 89, worldSize = 600) {
    const skew = tracePoints(generateLSystem(DAY_ORDER), turnAngle);
    const flat = tracePoints(generateLSystem(DAY_ORDER), 90);
    this.skewPts = normalize(skew.pts, worldSize);
    this.unit = Math.hypot(this.skewPts[1][0] - this.skewPts[0][0], this.skewPts[1][1] - this.skewPts[0][1]);
    // Each square is rotated by how far the skewed curve's heading has drifted
    this.rot = skew.heading.map((h, i) => {
      const t = ((h - flat.heading[i]) * Math.PI) / 180;
      return { cos: Math.cos(t), sin: Math.sin(t) };
    });
    this.days = [];
    for (let d = 0; d < N7 * N7 * 2; d++) this.days.push(this.buildDay(d));
  }

  get dayCount(): number { return this.days.length; }

  /**
   * Map a point given in order-7 grid units (square centers at integers) to
   * world space, using the transform of order-7 square `cell`.
   */
  private toWorld(cell: number, [gx, gy]: P): P {
    const [cx, cy] = hilbertPoint(DAY_ORDER, cell);
    const dx = (gx - cx) * this.unit, dy = (gy - cy) * this.unit;
    const { cos, sin } = this.rot[cell];
    const [sx, sy] = this.skewPts[cell];
    return [sx + dx * cos - dy * sin, sy + dx * sin + dy * cos];
  }

  /** Center of an order-m point, in order-7 grid units. */
  private static center(order: number, d: number): P {
    const f = 2 ** (order - DAY_ORDER);
    const [x, y] = hilbertPoint(order, d);
    return [(x + 0.5) / f - 0.5, (y + 0.5) / f - 0.5];
  }

  private buildDay(day: number): Cell {
    const total = N7 * N7 * 2;
    const a = CalendarGeometry.center(8, 2 * day), b = CalendarGeometry.center(8, 2 * day + 1);
    const h = 0.25;   // half a half-square, in order-7 units
    const x0 = Math.min(a[0], b[0]) - h, x1 = Math.max(a[0], b[0]) + h;
    const y0 = Math.min(a[1], b[1]) - h, y1 = Math.max(a[1], b[1]) + h;
    // Thin only where the curve crosses: into the first half, out of the second
    const toward = (from: P, to: P): P => [Math.round((to[0] - from[0]) * 2), Math.round((to[1] - from[1]) * 2)];
    const crossings: { half: P; out: P }[] = [];
    if (day > 0) crossings.push({ half: a, out: toward(a, CalendarGeometry.center(8, 2 * day - 1)) });
    if (day < total - 1) crossings.push({ half: b, out: toward(b, CalendarGeometry.center(8, 2 * day + 2)) });
    const thin = THIN_INSET / this.unit, gap = GAP_INSET / this.unit;
    const insetFor = (mid: P, outward: P) => crossings.some(c =>
      c.out[0] === outward[0] && c.out[1] === outward[1] &&
      Math.abs(mid[0] - c.half[0]) <= h && Math.abs(mid[1] - c.half[1]) <= h) ? thin : gap;
    const cell = day >> 1;
    return { points: insetRect(x0, x1, y0, y1, 0.5, insetFor).map(p => this.toWorld(cell, p)) };
  }

  /**
   * The 96 fifteen-minute blocks of a day, in time order. Each 45-minute square
   * (order 10) contributes three: the cell on its entry side, its center, and
   * the cell on its exit side.
   */
  quarters(day: number): Cell[] {
    const cached = this.quarterCache.get(day);
    if (cached) return cached;
    const per = QUARTERS_PER_DAY / 3;            // 32 order-10 points per day
    const last = this.dayCount * per - 1;
    const step = 1 / 8;                          // order-10 square, in order-7 units
    const block = step / 3;
    // Same proportion as the day gaps: a block is inset like a day of its size
    const inset = block * (GAP_INSET / (this.unit / 2));
    const cell = day >> 1;
    const out: Cell[] = [];
    for (let s = 0; s < per; s++) {
      const i = day * per + s;
      const c = CalendarGeometry.center(10, i);
      const dir = (j: number): P => {
        const o = CalendarGeometry.center(10, j);
        return [Math.round((o[0] - c[0]) / step), Math.round((o[1] - c[1]) / step)];
      };
      const toNext: P = i < last ? dir(i + 1) : [-dir(i - 1)[0], -dir(i - 1)[1]];
      const toPrev: P = i > 0 ? dir(i - 1) : [-toNext[0], -toNext[1]];
      for (const [ox, oy] of [toPrev, [0, 0], toNext] as P[]) {
        const bx = c[0] + ox * block, by = c[1] + oy * block;
        const r = block / 2 - inset;
        const corners: P[] = [[bx - r, by - r], [bx + r, by - r], [bx + r, by + r], [bx - r, by + r]];
        out.push({ points: corners.map(p => this.toWorld(cell, p)) });
      }
    }
    if (this.quarterCache.size > 512) this.quarterCache.clear();
    this.quarterCache.set(day, out);
    return out;
  }
}

export function buildGeometry(turnAngle = 89, worldSize = 600): CalendarGeometry {
  return new CalendarGeometry(turnAngle, worldSize);
}
