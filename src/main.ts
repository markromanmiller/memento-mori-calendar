import { App, ItemView, Menu, Modal, Plugin, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import { zoom as d3zoom, ZoomBehavior, zoomIdentity, ZoomTransform } from 'd3-zoom';
import { select } from 'd3-selection';
import { buildGeometry, CalendarGeometry, Cell, QUARTERS_PER_DAY } from './geometry';
import {
  parseVaultData, getTodayIndex, getNowQuarter, entriesAt, formatAnchor, VaultData, LabelEntry, Annotation,
  Activity, ACTIVITIES,
  DEFAULT_PERSPECTIVE, BUILTIN_PERSPECTIVES,
} from './data';
import { blockPoint, blockUV, cellAt, gapQuad, cellCentroid, fitScale, todayView, View, MIN_ZOOM, MAX_ZOOM, isQuarterView } from './viewport';
import { MementoSettings, DEFAULT_SETTINGS, MementoSettingTab } from './settings';

const VIEW_TYPE = 'memento-mori';

/**
 * Wrap text so width/height ≤ maxRatio:1, using the most even split possible.
 *
 * stackH: estimated total height of the day's label stack (LINE_H × label count).
 * Allows individual labels to be wider when they share a tall stack.
 *
 * For each candidate line count N, binary-searches for the minimum max-line-width
 * that still allows greedy wrapping to fit in ≤ N lines (monotone property makes
 * binary search exact). Returns the first N that satisfies the ratio constraint.
 */
function wrapToRatio(
  ctx: CanvasRenderingContext2D, text: string, lineH: number,
  stackH = lineH, maxRatio = 5,
): string[] {
  const words = text.split(' ');
  const spW = ctx.measureText(' ').width;
  const ww = words.map(w => ctx.measureText(w).width);
  const minPossible = Math.max(...ww);

  const wrap = (budget: number): string[] => {
    const lines: string[] = [];
    let cur = 0, start = 0;
    for (let i = 0; i < words.length; i++) {
      const next = i === start ? ww[i] : cur + spW + ww[i];
      if (i > start && next > budget) { lines.push(words.slice(start, i).join(' ')); start = i; cur = ww[i]; }
      else cur = next;
    }
    lines.push(words.slice(start).join(' '));
    return lines;
  };

  for (let n = 1; n <= 8; n++) {
    // Width budget: ratio applies to the full stack height, not just this label's height
    const ratioLimit = maxRatio * Math.max(n * lineH, stackH);
    if (wrap(ratioLimit).length > n) continue;

    let lo = minPossible, hi = ratioLimit;
    for (let iter = 0; iter < 24; iter++) {
      const mid = (lo + hi) / 2;
      if (wrap(mid).length <= n) hi = mid; else lo = mid;
    }
    return wrap(hi);
  }
  return [text];
}

/** Approximate side length of a (roughly square) cell. */
function cellSize(cell: Cell): number {
  const xs = cell.points.map(p => p[0]), ys = cell.points.map(p => p[1]);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/** Hold this long on an annotation to pick it up; moving further than MOVE_TOLERANCE first cancels. */
const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;
/** While dragging, the annotation floats this far (px) above the finger so it stays visible. */
const DRAG_LIFT = 64;

type Selection = { path: string; title: string; minZoom?: number; maxZoom?: number; annotation: boolean };
type Box = { l: number; r: number; t: number; b: number };
const inBox = (b: Box, x: number, y: number) => x >= b.l && x <= b.r && y >= b.t && y <= b.b;
const fmtZoom = (z: number | undefined, none: string) =>
  z === undefined ? none : `${+z.toFixed(2)} · ${+Math.pow(2, z).toPrecision(3)}×`;

/** Asks for an annotation's text. */
class AnnotationModal extends Modal {
  constructor(app: App, private onSubmit: (text: string) => void) { super(app); }
  onOpen(): void {
    const { contentEl } = this;
    const heading = document.createElement('h3');
    heading.textContent = 'New annotation';
    contentEl.appendChild(heading);
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Text';
    input.style.width = '100%';
    contentEl.appendChild(input);
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px;';
    const ok = document.createElement('button');
    ok.textContent = 'Add';
    ok.addClass('mod-cta');
    row.appendChild(ok);
    contentEl.appendChild(row);
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      this.close();
      this.onSubmit(text);
    };
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    window.setTimeout(() => input.focus(), 0);
  }
  onClose(): void { this.contentEl.empty(); }
}

const toTransform = (v: View): ZoomTransform => zoomIdentity.translate(v.x, v.y).scale(v.k);

const GRAY = '#6b6b6b';
/** mm-minzoom steps by this much; at MINZOOM_FLOOR (the most zoomed-out view) the key is removed. */
const MINZOOM_STEP = 0.5;
const MINZOOM_FLOOR = Math.log2(MIN_ZOOM);
const MINZOOM_CEIL = Math.log2(MAX_ZOOM);
/** Plain colors (month hues, activities, gray placeholder) fade more in the future than entry colors. */
const isPlainColor = (c: string) => c.startsWith('hsl(') || c === GRAY || (ACTIVITIES as string[]).includes(c);

/** Default perspective: colors for sleep, work and home hours, per theme. */
/**
 * Opacity of a future cell or block: entries 0.5, plain colors 0.2; activities 0.45, since at 0.2 sleep
 * and home both wash out to near-white.
 */
const futureAlpha = (c: string) => (ACTIVITIES as string[]).includes(c) ? 0.45 : isPlainColor(c) ? 0.2 : 0.5;

/** Default perspective: work in Illinois Tech red, home gray-blue, sleep pale. */
const ACTIVITY_COLORS: Record<'light' | 'dark', Record<Activity, string>> = {
  light: { sleep: 'hsl(215, 15%, 90%)', home: 'hsl(212, 22%, 64%)', work: '#cc0000' },
  dark: { sleep: 'hsl(215, 12%, 20%)', home: 'hsl(212, 18%, 40%)', work: 'hsl(0, 70%, 38%)' },
};
/** Hour marks in the 15-minute view: the first block of each hour gets this overlay. */
const HOUR_TICK = { light: 'rgba(0, 0, 0, 0.18)', dark: 'rgba(255, 255, 255, 0.18)' };

/**
 * Date labels by relative zoom: from YEAR_ZOOM each Jan 1 (the year), from MONTH_ZOOM each month's first,
 * from SUNDAY_ZOOM Sundays, from DAY_ZOOM every day; from HOURS_ZOOM the date sits on the midnight block
 * ("16th") and every other hour is labeled on its first block.
 */
const YEAR_ZOOM = 2.8;
const MONTH_ZOOM = 8;
const SUNDAY_ZOOM = 22.6;
const DAY_ZOOM = 64;
const HOURS_ZOOM = 181;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function hourText(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${h < 12 ? 'a' : 'p'}`;
}

function ordinal(n: number): string {
  const t = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${t}`;
}

/** Year, month (0–11), day of month and weekday (0 = Sunday) of every day index, for date labels. */
type DayDates = { birth: string; year: Int16Array; month: Uint8Array; date: Uint8Array; weekday: Uint8Array };

function dayDates(birthDate: string, total: number): DayDates {
  const b = new Date(birthDate + 'T00:00:00');
  const out: DayDates = {
    birth: birthDate, year: new Int16Array(total), month: new Uint8Array(total),
    date: new Uint8Array(total), weekday: new Uint8Array(total),
  };
  for (let i = 0; i < total; i++) {
    const d = new Date(b.getFullYear(), b.getMonth(), b.getDate() + i);
    out.year[i] = d.getFullYear(); out.month[i] = d.getMonth();
    out.date[i] = d.getDate(); out.weekday[i] = d.getDay();
  }
  return out;
}

/** A day's date label at a relative zoom below HOURS_ZOOM, or null when that day isn't labeled yet. */
function dateText(dd: DayDates, i: number, z: number): string | null {
  const date = dd.date[i], month = dd.month[i];
  if (date === 1 && month === 0) {
    if (z < YEAR_ZOOM) return null;
    return z < SUNDAY_ZOOM ? `${dd.year[i]}` : `Jan 1, ${dd.year[i]}`;
  }
  if (date === 1) return z >= MONTH_ZOOM ? `${MONTHS[month]} 1` : null;
  if (dd.weekday[i] === 0) return z >= SUNDAY_ZOOM ? `${date}` : null;
  return z >= DAY_ZOOM ? `${date}` : null;
}

function tracePolygon(ctx: CanvasRenderingContext2D, points: [number, number][]): void {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let j = 1; j < points.length; j++) ctx.lineTo(points[j][0], points[j][1]);
  ctx.closePath();
}

class MementoView extends ItemView {
  private plugin: MementoMoriPlugin;
  private geometry: CalendarGeometry | null = null;
  private geometrySkew = NaN;
  private dayCentroids: [number, number][] = [];
  private vaultData: VaultData | null = null;
  private currentPerspective = DEFAULT_PERSPECTIVE;
  private todayIndex = 0;
  private transform: ZoomTransform = zoomIdentity;
  private canvas: HTMLCanvasElement | null = null;
  private perspectiveBtn: HTMLButtonElement | null = null;
  private zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown> | null = null;
  /** Scale factor at which the full calendar fits the viewport (zoom level 0). */
  private fitScale = 1;
  /** Canvas size in CSS pixels, and device pixels per CSS pixel. */
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  /** Screen boxes of the labels drawn last frame, for tapping. */
  private labelHits: (Box & { entry: LabelEntry })[] = [];
  private annotationHits: (Box & { ann: Annotation })[] = [];
  /** An annotation being dragged, and the finger's canvas position. */
  private drag: { ann: Annotation; sx: number; sy: number } | null = null;
  /** Clicks right after a drop are the end of the drag, not taps. */
  private suppressClickUntil = 0;
  /** The entry whose minzoom panel is open. */
  private selected: Selection | null = null;
  private panel: HTMLElement | null = null;
  private bottomProbe: HTMLElement | null = null;
  private theme: 'light' | 'dark' = 'light';

  /** A stored color, with the sentinels ('default', activities) resolved for the current theme. */
  private resolveColor(c: string, themeTextColor: string): string {
    if (c === 'default') return themeTextColor;
    return (ACTIVITY_COLORS[this.theme] as Record<string, string>)[c] ?? c;
  }

  constructor(leaf: WorkspaceLeaf, plugin: MementoMoriPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Memento Mori'; }

  private get cells(): Cell[] { return this.geometry?.days ?? []; }

  /** (Re)build the curve when the skew setting changes. */
  private ensureGeometry(): void {
    const skew = this.plugin.settings.curveSkew;
    if (this.geometry && skew === this.geometrySkew) return;
    this.geometry = buildGeometry(90 - skew);
    this.geometrySkew = skew;
    this.dayCentroids = this.geometry.days.map(cellCentroid);
  }

  setVaultData(data: VaultData, todayIndex: number): void {
    this.vaultData = data;
    this.todayIndex = todayIndex;
    this.ensureGeometry();
    // If the current perspective was removed, fall back to default
    if (!data.perspectives.includes(this.currentPerspective) &&
        !BUILTIN_PERSPECTIVES.includes(this.currentPerspective)) {
      this.currentPerspective = DEFAULT_PERSPECTIVE;
      if (this.perspectiveBtn) {
        const label = this.perspectiveBtn.querySelector('span:last-child') as HTMLElement | null;
        if (label) label.textContent = DEFAULT_PERSPECTIVE;
      }
    }
    if (this.selected) {
      const e = this.selected.annotation
        ? data.annotations.find(x => x.path === this.selected!.path)
        : data.labelEntries.find(x => x.path === this.selected!.path);
      if (e) this.selected = this.selectionOf(e);
      else this.selected = null;
      this.renderPanel();
    }
    if (this.canvas) this.draw();
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.style.padding = '0';
    container.style.overflow = 'hidden';
    container.style.position = 'relative';

    // Canvas
    const canvas = document.createElement('canvas');
    canvas.style.backgroundColor = 'var(--background-primary)';
    canvas.style.display = 'block';
    this.canvas = canvas;
    container.appendChild(canvas);

    // Toolbar (top-right)
    const controls = document.createElement('div');
    controls.style.cssText = `
      position: absolute; top: 8px; right: 8px; z-index: 10;
      display: flex; align-items: center; gap: 4px;
    `;

    // Perspective button — opens an Obsidian Menu
    const perspectiveBtn = document.createElement('button');
    perspectiveBtn.addClass('clickable-icon');
    perspectiveBtn.style.cssText = `display: flex; align-items: center; gap: 4px; width: auto; padding: 0 8px;`;
    perspectiveBtn.ariaLabel = 'Switch perspective';
    const perspIcon = perspectiveBtn.createSpan();
    setIcon(perspIcon, 'layers');
    const perspLabel = perspectiveBtn.createSpan();
    perspLabel.style.fontSize = 'var(--font-ui-small)';
    perspLabel.textContent = this.currentPerspective;
    perspectiveBtn.addEventListener('click', (evt) => {
      const menu = new Menu();
      const all = [...BUILTIN_PERSPECTIVES, ...(this.vaultData?.perspectives ?? [])];
      for (const p of all) {
        menu.addItem(item => {
          item.setTitle(p);
          item.setChecked(p === this.currentPerspective);
          item.onClick(() => {
            this.currentPerspective = p;
            perspLabel.textContent = p;
            this.draw();
          });
        });
      }
      menu.showAtMouseEvent(evt);
    });
    this.perspectiveBtn = perspectiveBtn;
    controls.appendChild(perspectiveBtn);

    // Zoom-to-today button
    const todayBtn = document.createElement('button');
    todayBtn.addClass('clickable-icon');
    todayBtn.ariaLabel = 'Zoom to today';
    setIcon(todayBtn, 'crosshair');
    todayBtn.addEventListener('click', () => this.zoomToToday());
    controls.appendChild(todayBtn);

    container.appendChild(controls);

    // Minzoom panel (bottom), shown after tapping an entry
    const panel = document.createElement('div');
    panel.addClass('memento-mori-panel');
    panel.style.cssText = `
      position: absolute; left: 8px; right: 8px; z-index: 10; display: none;
      bottom: calc(var(--view-bottom-spacing, 0px) + 28px);
      align-items: center; gap: 4px; padding: 4px 8px; margin: 0 auto; max-width: 420px;
      background: var(--background-secondary); border: 1px solid var(--background-modifier-border);
      border-radius: 8px; font-size: var(--font-ui-small);
    `;
    this.panel = panel;
    container.appendChild(panel);
    // Obsidian mobile's bottom bar floats over views; --view-bottom-spacing is the room it needs
    const probe = document.createElement('div');
    probe.style.cssText = 'position: absolute; visibility: hidden; pointer-events: none; height: var(--view-bottom-spacing, 0px);';
    container.appendChild(probe);
    this.bottomProbe = probe;
    canvas.addEventListener('click', (evt) => this.onTap(evt));

    // Geometry — turnAngle = 90° minus the configured skew
    this.ensureGeometry();
    // Known before the first frame so the initial view can center on today
    this.todayIndex = getTodayIndex(this.plugin.settings.birthDate);
    // Keep "today" and the current 15-minute block up to date
    this.registerInterval(window.setInterval(() => {
      this.todayIndex = getTodayIndex(this.plugin.settings.birthDate);
      this.draw();
    }, 60_000));

    // Zoom
    const zoomBehavior = d3zoom<HTMLCanvasElement, unknown>()
      .on('zoom', (event) => {
        this.transform = event.transform;
        this.draw();
      });
    this.zoomBehavior = zoomBehavior;
    // Double-tap (or double-click) adds an annotation instead of zooming; d3 routes touch double-taps here too
    select(canvas).call(zoomBehavior).on('dblclick.zoom', (event: MouseEvent | TouchEvent) => this.onDoubleTap(event));
    this.setUpDragging(container, canvas);

    // Resize. The container can be 0×0 when the view opens (e.g. a background
    // tab), so the initial view waits for the first real size.
    let initialViewApplied = false;
    const resize = () => {
      // The backing store is in device pixels so drawing is sharp; everything else works in CSS pixels
      this.cssW = container.clientWidth;
      this.cssH = container.clientHeight;
      this.dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(this.cssW * this.dpr);
      canvas.height = Math.round(this.cssH * this.dpr);
      canvas.style.width = `${this.cssW}px`;
      canvas.style.height = `${this.cssH}px`;
      if (this.cssW === 0 || this.cssH === 0) return;
      this.fitScale = fitScale(this.cssW, this.cssH);
      zoomBehavior.scaleExtent([this.fitScale * MIN_ZOOM, this.fitScale * MAX_ZOOM]);
      if (!initialViewApplied) {
        initialViewApplied = true;
        select(canvas).call(zoomBehavior.transform,
          toTransform(todayView(this.cells, this.todayIndex, this.cssW, this.cssH)));
      }
      this.draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    this.register(() => ro.disconnect());
    resize();

    this.plugin.pushData();
  }

  private zoomToToday(): void {
    const canvas = this.canvas;
    const zb = this.zoomBehavior;
    if (!canvas || !zb || this.cells.length === 0) return;
    const target = toTransform(todayView(this.cells, this.todayIndex, this.cssW, this.cssH));
    select(canvas).transition().duration(600)
      .call(zb.transform, target);
  }

  private draw(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = this.cssW;
    const h = this.cssH;
    const { k, x, y } = this.transform;
    const dpr = this.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Screen drawing is in CSS pixels; world drawing adds the zoom transform
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.setTransform(k * dpr, 0, 0, k * dpr, x * dpr, y * dpr);

    const total = this.cells.length;
    // Resolve 'default' sentinel to theme text color (adapts to light/dark mode)
    const themeTextColor = getComputedStyle(canvas).getPropertyValue('--text-normal').trim() || '#222';
    this.theme = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
    const quarterView = isQuarterView(k / this.fitScale);

    if (quarterView) this.drawQuarters(ctx, k, x, y, w, h, themeTextColor);
    else this.drawDays(ctx, themeTextColor);

    ctx.restore();

    // --- Labels ---
    this.drawLabels(ctx, k, x, y, total, w, h, themeTextColor, quarterView);
    // After the entry labels, so dates give way to them
    if (k / this.fitScale < HOURS_ZOOM) this.drawDateLabels(ctx, k, x, y, w, h);
    this.drawAnnotations(ctx, w, h);

    // HUD
    const hudColor = getComputedStyle(canvas).getPropertyValue('--text-faint').trim()
      || 'rgba(128,128,128,0.7)';
    ctx.fillStyle = hudColor;
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const displayZoom = (k / this.fitScale).toFixed(2);
    const bottom = this.bottomProbe?.offsetHeight ?? 0;
    ctx.fillText(`${total.toLocaleString()} cells · zoom ${displayZoom}×`, 10, h - 8 - bottom);
  }

  /** Zoomed out: one filled cell per day. */
  private drawDays(ctx: CanvasRenderingContext2D, themeTextColor: string): void {
    const total = this.cells.length;
    const dayColors = this.vaultData?.dayColorsByPerspective.get(this.currentPerspective);
    const hasColors = dayColors?.length === total;

    for (let i = 0; i < total; i++) {
      const rawColor = hasColors
        ? dayColors![i]
        : `hsl(${Math.round((i / total) * 360)}, 45%, 65%)`;
      ctx.fillStyle = this.resolveColor(rawColor, themeTextColor);
      // Plain cells (month hsl or gray placeholder) fade to 0.2; event/range cells to 0.5
      ctx.globalAlpha = i > this.todayIndex ? futureAlpha(rawColor) : 1.0;
      tracePolygon(ctx, this.cells[i].points);
      ctx.fill();
    }
    ctx.globalAlpha = 1.0;

    // Today cell: theme-inverted fill with a mitered border so it pops in both modes
    if (this.todayIndex >= 0 && this.todayIndex < total) {
      const bgColor = getComputedStyle(this.canvas!).getPropertyValue('--background-primary').trim() || '#fff';
      ctx.fillStyle = bgColor;
      ctx.strokeStyle = themeTextColor;
      ctx.lineWidth = 0.4; // world-space units (gap between cells is ~0.4)
      ctx.lineJoin = 'miter';
      tracePolygon(ctx, this.cells[this.todayIndex].points);
      ctx.fill();
      ctx.stroke();
    }
  }

  /** Zoomed in (≥ 64×): each visible day as 96 fifteen-minute blocks over a faint day cell. */
  private drawQuarters(
    ctx: CanvasRenderingContext2D, k: number, tx: number, ty: number,
    canvasW: number, canvasH: number, themeTextColor: string,
  ): void {
    const geom = this.geometry;
    if (!geom) return;
    const total = this.cells.length;
    const base = this.vaultData?.dayBaseColorsByPerspective.get(this.currentPerspective);
    const blockColors = this.vaultData?.quarterColorsByPerspective.get(this.currentPerspective);
    const bridges = this.vaultData?.quarterBridgesByPerspective.get(this.currentPerspective);
    const hasBase = base?.length === total;
    const nowQ = getNowQuarter(this.plugin.settings.birthDate);
    const resolve = (c: string) => this.resolveColor(c, themeTextColor);
    const schedule = this.currentPerspective === DEFAULT_PERSPECTIVE ? this.vaultData?.schedule : undefined;
    const hourTick = HOUR_TICK[this.theme];
    const visibleDays: number[] = [];
    // A day's centroid can be up to about one day-length outside the viewport while still visible
    const margin = (600 / 127) * k;

    for (let d = 0; d < total; d++) {
      const [cx, cy] = this.dayCentroids[d];
      const sx = cx * k + tx, sy = cy * k + ty;
      if (sx < -margin || sx > canvasW + margin || sy < -margin || sy > canvasH + margin) continue;
      const dayColor = hasBase ? base![d] : `hsl(${Math.round((d / total) * 360)}, 45%, 65%)`;

      // Faint day cell: the free space around the path, available for labels
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = resolve(dayColor);
      tracePolygon(ctx, this.cells[d].points);
      ctx.fill();

      visibleDays.push(d);
      const blocks = geom.quarters(d);
      for (let q = 0; q < QUARTERS_PER_DAY; q++) {
        const abs = d * QUARTERS_PER_DAY + q;
        const raw = blockColors?.get(abs) ?? (schedule ? schedule(d, q) : dayColor);
        ctx.globalAlpha = abs > nowQ ? futureAlpha(raw) : 1.0;
        ctx.fillStyle = resolve(raw);
        tracePolygon(ctx, blocks[q].points);
        ctx.fill();
        // Hour mark: shade the first block of each hour
        if (q % 4 === 0) {
          ctx.fillStyle = hourTick;
          ctx.fill();
        }
        // One timed entry covering this block and the next: fill the gap between them
        const next = blockColors?.get(abs + 1);
        if (bridges?.has(abs) && next === raw) {
          ctx.fillStyle = resolve(raw);
          tracePolygon(ctx, gapQuad(blocks[q].points, blocks[q + 1].points));
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1.0;
    this.drawHourLabels(ctx, k, visibleDays, themeTextColor);

    // Today's outline and the current 15-minute block, at a fixed screen width
    ctx.strokeStyle = themeTextColor;
    ctx.lineWidth = 2 / k;
    ctx.lineJoin = 'miter';
    if (this.todayIndex >= 0 && this.todayIndex < total) {
      tracePolygon(ctx, this.cells[this.todayIndex].points);
      ctx.stroke();
      const nowBlock = nowQ - this.todayIndex * QUARTERS_PER_DAY;
      if (nowBlock >= 0 && nowBlock < QUARTERS_PER_DAY) {
        tracePolygon(ctx, geom.quarters(this.todayIndex)[nowBlock].points);
        ctx.stroke();
      }
    }
  }

  /**
   * From HOURS_ZOOM: the date on each day's midnight block ("16th", or "Nov 1" for a month's first) and
   * every other hour on its first block. Drawn in world space; the caller's transform is active.
   */
  private drawHourLabels(ctx: CanvasRenderingContext2D, k: number, days: number[], color: string): void {
    const geom = this.geometry;
    if (!geom || !days.length || k / this.fitScale < HOURS_ZOOM) return;
    const dd = this.dayDates();
    const blockPx = cellSize(geom.quarters(days[0])[0]) * k;
    const style = getComputedStyle(this.canvas!);
    const fontFamily = style.getPropertyValue('--font-text').trim() || 'system-ui, sans-serif';
    const px = Math.min(14, blockPx * 0.5);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 / k;
    ctx.strokeStyle = style.getPropertyValue('--background-primary').trim() || '#fff';
    ctx.fillStyle = color;
    for (const d of days) {
      const blocks = geom.quarters(d);
      for (let h = 0; h < 24; h++) {
        const text = h > 0 ? hourText(h)
          : dd.date[d] === 1 ? `${MONTHS[dd.month[d]]} 1` : ordinal(dd.date[d]);
        ctx.font = `${h === 0 ? 700 : 600} ${px / k}px ${fontFamily}`;
        ctx.globalAlpha = h === 0 ? 1 : 0.75;
        const [x, y] = cellCentroid(blocks[h * 4]);
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      }
    }
    ctx.restore();
  }

  private dates: DayDates | null = null;
  private dayDates(): DayDates {
    const birth = this.plugin.settings.birthDate;
    if (!this.dates || this.dates.birth !== birth || this.dates.date.length !== this.cells.length) {
      this.dates = dayDates(birth, this.cells.length);
    }
    return this.dates;
  }

  /** Date labels on the days, more of them the further in (see YEAR_ZOOM … DAY_ZOOM). Screen space. */
  private drawDateLabels(ctx: CanvasRenderingContext2D, k: number, tx: number, ty: number, w: number, h: number): void {
    const z = k / this.fitScale;
    if (z < YEAR_ZOOM || !this.cells.length) return;
    const dd = this.dayDates();
    const style = getComputedStyle(this.canvas!);
    const fontFamily = style.getPropertyValue('--font-text').trim() || 'system-ui, sans-serif';
    const PX = 11;
    ctx.save();
    ctx.font = `600 ${PX}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = style.getPropertyValue('--background-primary').trim() || '#fff';
    ctx.fillStyle = style.getPropertyValue('--text-muted').trim() || '#666';
    // Years first, then month starts, Sundays, other days, so the coarser labels win a collision
    const rank = (i: number) => dd.date[i] === 1 ? (dd.month[i] === 0 ? 0 : 1) : dd.weekday[i] === 0 ? 2 : 3;
    const shown: { i: number; text: string; sx: number; sy: number; r: number }[] = [];
    for (let i = 0; i < this.cells.length; i++) {
      const [wx, wy] = this.dayCentroids[i];
      const sx = wx * k + tx, sy = wy * k + ty;
      if (sx < -40 || sx > w + 40 || sy < -20 || sy > h + 20) continue;
      const text = dateText(dd, i, z);
      if (text) shown.push({ i, text, sx, sy, r: rank(i) });
    }
    shown.sort((a, b) => a.r - b.r);
    const boxes: Box[] = this.labelHits.slice();
    for (const l of shown) {
      const hw = ctx.measureText(l.text).width / 2 + 2;
      const box = { l: l.sx - hw, r: l.sx + hw, t: l.sy - PX / 2 - 1, b: l.sy + PX / 2 + 1 };
      if (boxes.some(o => box.r > o.l && box.l < o.r && box.b > o.t && box.t < o.b)) continue;
      boxes.push(box);
      ctx.strokeText(l.text, l.sx, l.sy);
      ctx.fillText(l.text, l.sx, l.sy);
    }
    ctx.restore();
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    k: number, tx: number, ty: number,
    total: number, canvasW: number, canvasH: number,
    textColor: string, quarterView: boolean,
  ): void {
    this.labelHits = [];
    if (!this.vaultData?.labelEntries.length) return;

    const style = getComputedStyle(this.canvas!);
    const bgColor = style.getPropertyValue('--background-primary').trim() || '#fff';
    const fontFamily = style.getPropertyValue('--font-text').trim() || 'system-ui, sans-serif';
    const LINE_H = 16;
    const PAD = 3;     // extra pixels around each box for overlap detection
    const FONT_SIZE = 13;
    const zoomLevel = Math.log2(k / this.fitScale);

    ctx.font = `${FONT_SIZE}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = bgColor;
    ctx.fillStyle = textColor;

    type Candidate = {
      lines: string[];
      sx: number; sy: number;
      boxW: number; boxH: number;
      priority: number;
      name: string;
      anchorIdx: number;
      entry: LabelEntry;
    };

    // Anchors: a day's cell, or in the 15-minute view the block a timed entry starts/ends in.
    // Keys: day index for days, -(absolute quarter + 1) for blocks, so they never collide.
    const anchorFor = (day: number, quarter: number | undefined): { key: number; pos: [number, number] } | null => {
      const d = Math.max(0, Math.min(total - 1, day));
      if (quarterView && quarter !== undefined && this.geometry) {
        return { key: -(d * QUARTERS_PER_DAY + quarter + 1), pos: cellCentroid(this.geometry.quarters(d)[quarter]) };
      }
      return this.cells[d] ? { key: d, pos: this.dayCentroids[d] } : null;
    };
    const showEnd = (entry: LabelEntry) => entry.endLabel !== null && (entry.endDay !== entry.startDay ||
      (quarterView && entry.startQuarter !== undefined && entry.endQuarter !== entry.startQuarter));

    // Phase 1a: count eligible labels per anchor for stack-height estimation
    const anchorCounts = new Map<number, number>();
    const inc = (a: { key: number } | null) => { if (a) anchorCounts.set(a.key, (anchorCounts.get(a.key) ?? 0) + 1); };
    for (const entry of this.vaultData.labelEntries) {
      if (entry.minZoom !== undefined && zoomLevel < entry.minZoom) continue;
      inc(anchorFor(entry.startDay, entry.startQuarter));
      if (showEnd(entry)) inc(anchorFor(entry.endDay, entry.endQuarter));
    }

    // Phase 1b: collect candidates, filter by minZoom and viewport
    const candidates: Candidate[] = [];

    const addCandidate = (text: string, day: number, quarter: number | undefined, entry: LabelEntry) => {
      const minZoom = entry.minZoom;
      const anchor = anchorFor(day, quarter);
      if (!anchor) return;
      const anchorIdx = anchor.key;
      const [wx, wy] = anchor.pos;
      const sx = wx * k + tx;
      const sy = wy * k + ty;
      if (sx < -300 || sx > canvasW + 300 || sy < -300 || sy > canvasH + 300) return;

      const stackH = (anchorCounts.get(anchorIdx) ?? 1) * LINE_H;
      const lines = wrapToRatio(ctx, text, LINE_H, stackH);
      const boxW = Math.max(...lines.map(l => ctx.measureText(l).width)) + PAD * 2;
      const boxH = lines.length * LINE_H + PAD * 2;

      candidates.push({
        lines, sx, sy, boxW, boxH,
        priority: minZoom ?? -Infinity,
        name: text,
        anchorIdx,
        entry,
      });
    };

    for (const entry of this.vaultData.labelEntries) {
      if (entry.minZoom !== undefined && zoomLevel < entry.minZoom) continue;
      addCandidate(entry.startLabel, entry.startDay, entry.startQuarter, entry);
      if (showEnd(entry)) addCandidate(entry.endLabel!, entry.endDay, entry.endQuarter, entry);
    }

    // Phase 2: sort — lower minZoom (more always-visible) wins; alphabetical tiebreak
    candidates.sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.name.localeCompare(b.name)
    );

    // Phase 3: propose → box → occlusion test → commit
    // Each anchor's box is always the centered combined box, so drawn positions match exactly.
    type LabelInStack = { lines: string[]; sx: number; boxW: number; boxH: number; entry: LabelEntry };
    type AnchorState = {
      box: { l: number; r: number; t: number; b: number };
      totalH: number;
      cellSy: number;
      labels: LabelInStack[];
    };
    const anchors = new Map<number, AnchorState>();

    const overlapsOthers = (box: { l: number; r: number; t: number; b: number }, skipIdx: number) => {
      for (const [idx, a] of anchors) {
        if (idx === skipIdx) continue;
        if (box.r > a.box.l && box.l < a.box.r && box.b > a.box.t && box.t < a.box.b) return true;
      }
      return false;
    };

    for (const c of candidates) {
      const existing = anchors.get(c.anchorIdx);
      const newTotalH = (existing?.totalH ?? 0) + c.boxH;
      const hw = c.boxW / 2;

      // Proposed centered combined box
      const proposed = {
        l: Math.min(existing?.box.l ?? (c.sx - hw), c.sx - hw),
        r: Math.max(existing?.box.r ?? (c.sx + hw), c.sx + hw),
        t: c.sy - newTotalH / 2,
        b: c.sy + newTotalH / 2,
      };

      if (overlapsOthers(proposed, c.anchorIdx)) continue;

      anchors.set(c.anchorIdx, {
        box: proposed,
        totalH: newTotalH,
        cellSy: c.sy,
        labels: [...(existing?.labels ?? []), { lines: c.lines, sx: c.sx, boxW: c.boxW, boxH: c.boxH, entry: c.entry }],
      });
    }

    // Phase 4: draw each committed stack, centered on its cell
    // Labels are ordered bottom-to-top (first committed at bottom).
    this.labelHits = [];
    for (const [, state] of anchors) {
      let curBottom = state.cellSy + state.totalH / 2;
      for (const label of state.labels) {
        const box = { l: label.sx - label.boxW / 2, r: label.sx + label.boxW / 2, t: curBottom - label.boxH, b: curBottom };
        this.labelHits.push({ ...box, entry: label.entry });
        if (label.entry.path === this.selected?.path) {
          ctx.save();
          ctx.strokeStyle = getComputedStyle(this.canvas!).getPropertyValue('--interactive-accent').trim() || '#7b6cd9';
          ctx.lineWidth = 2;
          ctx.strokeRect(box.l, box.t, box.r - box.l, box.b - box.t);
          ctx.restore();
        }
        // Text baseline of last line sits at curBottom - PAD
        const drawBottom = curBottom - PAD;
        for (let i = label.lines.length - 1; i >= 0; i--) {
          const lineY = drawBottom - (label.lines.length - 1 - i) * LINE_H;
          ctx.strokeText(label.lines[i], label.sx, lineY);
          ctx.fillText(label.lines[i], label.sx, lineY);
        }
        curBottom -= label.boxH;
      }
    }
  }

  /** Tap: a label or annotation selects it; a day (or 15-minute block) lists the entries covering it. */
  private onTap(evt: MouseEvent): void {
    const canvas = this.canvas;
    if (!canvas || !this.vaultData || performance.now() < this.suppressClickUntil) return;
    const rect = canvas.getBoundingClientRect();
    const sx = evt.clientX - rect.left, sy = evt.clientY - rect.top;
    const ann = this.annotationHits.find(b => inBox(b, sx, sy));
    if (ann) { this.select(ann.ann); return; }
    const hit = this.labelHits.find(b => inBox(b, sx, sy));
    if (hit) { this.select(hit.entry); return; }

    const { k, x, y } = this.transform;
    const wx = (sx - x) / k, wy = (sy - y) / k;
    const day = cellAt(this.cells, this.dayCentroids, wx, wy, 600 / 127);
    let found: LabelEntry[] = [];
    if (day >= 0) {
      let quarter: number | undefined;
      if (isQuarterView(k / this.fitScale) && this.geometry) {
        const blocks = this.geometry.quarters(day);
        const q = cellAt(blocks, blocks.map(cellCentroid), wx, wy, 600 / 127);
        if (q >= 0) quarter = q;
      }
      found = entriesAt(this.vaultData.labelEntries, day, quarter);
      // A free cell or empty block: fall back to anything on that day
      if (!found.length && quarter !== undefined) found = entriesAt(this.vaultData.labelEntries, day);
    }
    if (found.length === 1) this.select(found[0]);
    else if (found.length > 1) {
      const menu = new Menu();
      for (const e of found) menu.addItem(item => { item.setTitle(e.title); item.onClick(() => this.select(e)); });
      menu.showAtMouseEvent(evt);
    } else if (this.selected) {
      this.selected = null;
      this.renderPanel();
      this.draw();
    }
  }

  private selectionOf(item: LabelEntry | Annotation): Selection {
    const annotation = 'u' in item;
    return { path: item.path, title: item.title, minZoom: item.minZoom,
      maxZoom: annotation ? (item as Annotation).maxZoom : undefined, annotation };
  }

  private select(item: LabelEntry | Annotation): void {
    this.selected = this.selectionOf(item);
    this.renderPanel();
    this.draw();
  }

  private get zoomLevel(): number { return Math.log2(this.transform.k / this.fitScale); }

  /** The anchor (block and position in its frame) nearest a canvas point; null off the curve. */
  private anchorAt(sx: number, sy: number): { day: number; quarter: number; u: number; v: number } | null {
    if (!this.geometry) return null;
    const { k, x, y } = this.transform;
    const wx = (sx - x) / k, wy = (sy - y) / k;
    const day = cellAt(this.cells, this.dayCentroids, wx, wy, 600 / 127);
    if (day < 0) return null;
    const blocks = this.geometry.quarters(day);
    const quarter = cellAt(blocks, blocks.map(cellCentroid), wx, wy, 1e9);
    const [u, v] = blockUV(blocks[quarter], wx, wy);
    return { day, quarter, u, v };
  }

  /** Double-tap: ask for text and add an annotation note at that spot, shown from the current zoom. */
  private onDoubleTap(event: MouseEvent | TouchEvent): void {
    const canvas = this.canvas;
    if (!canvas || performance.now() < this.suppressClickUntil) return;
    const p = 'changedTouches' in event ? event.changedTouches[0] : event;
    const rect = canvas.getBoundingClientRect();
    const anchor = this.anchorAt(p.clientX - rect.left, p.clientY - rect.top);
    if (!anchor) return;
    const minZoom = Math.floor(this.zoomLevel / MINZOOM_STEP) * MINZOOM_STEP;
    new AnnotationModal(this.app, (text) => this.plugin.createAnnotation(text, anchor, minZoom)).open();
  }

  /**
   * Hold an annotation to pick it up, then drag it; the map doesn't pan meanwhile. Listeners run in the capture
   * phase so moves can be kept from d3's pan handlers (touch: on the canvas; mouse: on the window).
   */
  private setUpDragging(container: HTMLElement, canvas: HTMLCanvasElement): void {
    let press: { timer: number; x0: number; y0: number } | null = null;
    const pointOf = (e: MouseEvent | TouchEvent): [number, number] => {
      const t = 'touches' in e ? (e.touches[0] ?? e.changedTouches[0]) : e;
      const r = canvas.getBoundingClientRect();
      return [t.clientX - r.left, t.clientY - r.top];
    };
    const cancel = () => { if (press) window.clearTimeout(press.timer); press = null; };
    const down = (e: MouseEvent | TouchEvent) => {
      cancel();
      if ('touches' in e && e.touches.length > 1) return;
      if (e.target !== canvas) return;
      const [sx, sy] = pointOf(e);
      const hit = this.annotationHits.find(b => inBox(b, sx, sy));
      if (!hit) return;
      press = {
        x0: sx, y0: sy,
        timer: window.setTimeout(() => {
          press = null;
          this.drag = { ann: hit.ann, sx, sy };
          navigator.vibrate?.(15);
          this.draw();
        }, HOLD_MS),
      };
    };
    const move = (e: MouseEvent | TouchEvent) => {
      if (this.drag) {
        // d3 also listens in the capture phase on the window (mouse), so stop listeners on the same target too
        e.preventDefault();
        e.stopImmediatePropagation();
        [this.drag.sx, this.drag.sy] = pointOf(e);
        this.draw();
      } else if (press) {
        const [sx, sy] = pointOf(e);
        if (Math.hypot(sx - press.x0, sy - press.y0) > MOVE_TOLERANCE) cancel();
      }
    };
    const up = () => {
      cancel();
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      this.suppressClickUntil = performance.now() + 500;
      void this.dropAnnotation(d.ann, d.sx, d.sy - DRAG_LIFT);
    };
    const listen = (target: EventTarget, type: string, fn: (e: never) => void, passive = true) => {
      target.addEventListener(type, fn as EventListener, { capture: true, passive });
      this.register(() => target.removeEventListener(type, fn as EventListener, { capture: true }));
    };
    listen(container, 'touchstart', down);
    listen(container, 'mousedown', down);
    listen(container, 'touchmove', move, false);
    listen(window, 'mousemove', move, false);
    listen(container, 'touchend', up);
    listen(container, 'touchcancel', up);
    listen(window, 'mouseup', up);
    // A long press shouldn't open the browser's context menu or select text
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.style.setProperty('-webkit-touch-callout', 'none');
    canvas.style.userSelect = 'none';
  }

  private async dropAnnotation(ann: Annotation, sx: number, sy: number): Promise<void> {
    const anchor = this.anchorAt(sx, sy);
    const file = this.app.vault.getAbstractFileByPath(ann.path);
    if (!anchor || !(file instanceof TFile)) { this.draw(); return; }
    Object.assign(ann, anchor);   // show it in place now; the note catches up
    this.draw();
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm['mm-anchor'] = formatAnchor(this.plugin.settings.birthDate, anchor.day, anchor.quarter, anchor.u, anchor.v);
    });
  }

  /**
   * Annotations: their text centered exactly on the anchor, no stacking. While one is dragged it floats above
   * the finger, with a ring under the finger and a crosshair where it will land.
   */
  private drawAnnotations(ctx: CanvasRenderingContext2D, canvasW: number, canvasH: number): void {
    this.annotationHits = [];
    const anns = this.vaultData?.annotations;
    const geom = this.geometry;
    if (!anns?.length || !geom) return;
    const style = getComputedStyle(this.canvas!);
    const accent = style.getPropertyValue('--interactive-accent').trim() || '#7b6cd9';
    const bg = style.getPropertyValue('--background-primary').trim() || '#fff';
    const fontFamily = style.getPropertyValue('--font-text').trim() || 'system-ui, sans-serif';
    const { k, x, y } = this.transform;
    const level = this.zoomLevel;
    ctx.save();
    ctx.font = `italic 600 13px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const label = (text: string, sx: number, sy: number, lifted: boolean): Box => {
      const w = ctx.measureText(text).width + 8, h = 18;
      const box = { l: sx - w / 2, r: sx + w / 2, t: sy - h / 2, b: sy + h / 2 };
      if (lifted) {
        ctx.fillStyle = bg;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(box.l, box.t, w, h, 4);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.lineWidth = 3;
        ctx.strokeStyle = bg;
        ctx.strokeText(text, sx, sy);
      }
      ctx.fillStyle = accent;
      ctx.fillText(text, sx, sy);
      return box;
    };
    for (const a of anns) {
      const dragging = this.drag?.ann === a;
      if (!dragging && ((a.minZoom !== undefined && level < a.minZoom) || (a.maxZoom !== undefined && level > a.maxZoom))) continue;
      if (a.day < 0 || a.day >= this.cells.length) continue;
      const [wx, wy] = blockPoint(geom.quarters(a.day)[a.quarter], a.u, a.v);
      const sx = wx * k + x, sy = wy * k + y;
      if (dragging) { ctx.globalAlpha = 0.3; label(a.title, sx, sy, false); ctx.globalAlpha = 1; continue; }
      if (sx < -200 || sx > canvasW + 200 || sy < -50 || sy > canvasH + 50) continue;
      const box = label(a.title, sx, sy, false);
      this.annotationHits.push({ ...box, ann: a });
      if (a.path === this.selected?.path) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(box.l, box.t, box.r - box.l, box.b - box.t);
      }
    }
    if (this.drag) {
      const { sx, sy, ann } = this.drag;
      const ly = sy - DRAG_LIFT;
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(sx, sy, 36, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(sx, sy - 36);
      ctx.lineTo(sx, ly);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(sx - 6, ly); ctx.lineTo(sx + 6, ly);
      ctx.moveTo(sx, ly - 6); ctx.lineTo(sx, ly + 6);
      ctx.stroke();
      label(ann.title, sx, ly, true);
    }
    ctx.restore();
  }

  /**
   * The panel: title (opens the note), minzoom ↑/↓, close. Annotations also get a max zoom (hidden when zoomed
   * in further) and a delete button, on a second row.
   */
  private renderPanel(): void {
    const panel = this.panel;
    if (!panel) return;
    panel.empty();
    const sel = this.selected;
    panel.style.display = sel ? 'flex' : 'none';
    panel.style.flexWrap = 'wrap';
    if (!sel) return;
    const title = panel.createSpan({ text: sel.title });
    title.style.cssText = `flex: 1 1 ${sel.annotation ? '60%' : '0'}; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; cursor: pointer;`;
    title.ariaLabel = 'Open note';
    title.addEventListener('click', () => this.app.workspace.openLinkText(sel.path, '', false));
    const button = (icon: string, label: string, enabled: boolean, onClick: () => void) => {
      const b = document.createElement('button');
      b.addClass('clickable-icon');
      b.ariaLabel = label;
      setIcon(b, icon);
      b.disabled = !enabled;
      b.style.opacity = enabled ? '' : '0.3';
      b.addEventListener('click', onClick);
      panel.appendChild(b);
    };
    const text = (t: string, label: string, minWidth = 60) => {
      const span = panel.createSpan({ text: t });
      span.style.cssText = `min-width: ${minWidth}px; text-align: center; font-variant-numeric: tabular-nums;`;
      span.ariaLabel = label;
    };
    const close = () => button('x', 'Close', true, () => { this.selected = null; this.renderPanel(); this.draw(); });
    if (sel.annotation) {
      button('trash-2', 'Delete annotation', true, () => this.deleteAnnotation(sel));
      close();
      const br = document.createElement('div');
      br.style.flexBasis = '100%';
      panel.appendChild(br);
    }
    const mz = sel.minZoom, xz = sel.maxZoom;
    if (sel.annotation) text('from', 'Shown from', 0);
    // Lower minzoom = the label appears when more zoomed out
    button('arrow-up', 'Raise priority (show when more zoomed out)', mz !== undefined, () =>
      this.setZoomKey(sel, 'mm-minzoom', mz! - MINZOOM_STEP <= MINZOOM_FLOOR ? undefined : mz! - MINZOOM_STEP));
    text(fmtZoom(mz, 'always'), 'mm-minzoom: shown from this zoom');
    button('arrow-down', 'Lower priority (show only when more zoomed in)',
      (mz ?? MINZOOM_FLOOR) < Math.min(MINZOOM_CEIL, xz ?? Infinity), () =>
        this.setZoomKey(sel, 'mm-minzoom', Math.round(((mz ?? MINZOOM_FLOOR) + MINZOOM_STEP) / MINZOOM_STEP) * MINZOOM_STEP));
    if (!sel.annotation) { close(); return; }
    text('until', 'Shown until', 0);
    // Higher maxzoom = still shown when more zoomed in; none = never hidden
    button('arrow-up', 'Show when more zoomed in', xz !== undefined, () =>
      this.setZoomKey(sel, 'mm-maxzoom', xz! + MINZOOM_STEP >= MINZOOM_CEIL ? undefined : xz! + MINZOOM_STEP));
    text(fmtZoom(xz, 'any'), 'mm-maxzoom: hidden when zoomed in further');
    button('arrow-down', 'Hide when zoomed in this far',
      xz === undefined || xz - MINZOOM_STEP >= (mz ?? MINZOOM_FLOOR), () =>
        this.setZoomKey(sel, 'mm-maxzoom', xz === undefined
          ? Math.max(mz ?? MINZOOM_FLOOR, Math.ceil(this.zoomLevel / MINZOOM_STEP) * MINZOOM_STEP)
          : xz - MINZOOM_STEP));
  }

  private async setZoomKey(sel: Selection, key: 'mm-minzoom' | 'mm-maxzoom', value: number | undefined): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(sel.path);
    if (!(file instanceof TFile)) return;
    if (key === 'mm-minzoom') sel.minZoom = value; else sel.maxZoom = value;
    this.renderPanel();
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (value === undefined) delete fm[key];
      else fm[key] = value;
    });
  }

  private async deleteAnnotation(sel: Selection): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(sel.path);
    this.selected = null;
    this.renderPanel();
    if (file instanceof TFile) await this.app.fileManager.trashFile(file);
  }

  async onClose(): Promise<void> {
    this.drag = null;
    this.panel = null;
    this.canvas = null;
    this.perspectiveBtn = null;
    this.zoomBehavior = null;
  }
}

export default class MementoMoriPlugin extends Plugin {
  settings: MementoSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) =>
      new MementoView(leaf, this)
    );

    this.addRibbonIcon('aperture', 'Open Memento Mori', () => this.activateView());
    this.addCommand({
      id: 'open-memento-mori',
      name: 'Open Memento Mori',
      callback: () => this.activateView(),
    });
    this.addSettingTab(new MementoSettingTab(this.app, this));

    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (file.parent?.path === this.settings.entriesDir.replace(/\/$/, '')) {
          this.pushData();
        }
      })
    );

    this.registerEvent(
      this.app.metadataCache.on('resolved', () => this.pushData())
    );
    // Deleting or renaming notes doesn't fire 'changed'
    this.registerEvent(this.app.vault.on('delete', () => this.pushData()));
    this.registerEvent(this.app.vault.on('rename', () => this.pushData()));
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  pushData(): void {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]
      ?.view as MementoView | undefined;
    if (!view) return;
    const totalCells = 32768;
    const data = parseVaultData(this.app, this.settings, totalCells);
    const todayIndex = getTodayIndex(this.settings.birthDate);
    view.setVaultData(data, todayIndex);
  }

  /** Write a new annotation note into the entries folder. */
  async createAnnotation(
    text: string, anchor: { day: number; quarter: number; u: number; v: number }, minZoom: number,
  ): Promise<void> {
    const dir = this.settings.entriesDir.replace(/\/$/, '');
    const anchorText = formatAnchor(this.settings.birthDate, anchor.day, anchor.quarter, anchor.u, anchor.v);
    const stamp = anchorText.slice(0, 16).replace('T', ' ').replace(':', '');
    const safe = text.replace(/[\\/:*?"<>|#^[\]]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Annotation';
    let path = `${dir}/Annotation ${stamp} ${safe}.md`;
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = `${dir}/Annotation ${stamp} ${safe} (${n}).md`;
    const body = ['---', 'mm: annotation', `mm-title: ${JSON.stringify(text)}`, `mm-anchor: "${anchorText}"`,
      `mm-minzoom: ${minZoom}`, '---', ''].join('\n');
    await this.app.vault.create(path, body);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Saved copies of the first schedule defaults move to the current ones
    const st = this.settings;
    if (st.sleepHours === '23:00-07:00' && st.workHours === '09:00-17:00' && st.workDays === 'Mon-Fri') {
      st.sleepHours = DEFAULT_SETTINGS.sleepHours;
      st.workHours = DEFAULT_SETTINGS.workHours;
      st.workDays = DEFAULT_SETTINGS.workDays;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.pushData();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}
