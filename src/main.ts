import { ItemView, Menu, Plugin, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import { zoom as d3zoom, ZoomBehavior, zoomIdentity, ZoomTransform } from 'd3-zoom';
import { select } from 'd3-selection';
import { buildGeometry, CalendarGeometry, Cell, QUARTERS_PER_DAY } from './geometry';
import {
  parseVaultData, getTodayIndex, getNowQuarter, entriesAt, VaultData, LabelEntry, Activity, ACTIVITIES,
  DEFAULT_PERSPECTIVE, BUILTIN_PERSPECTIVES,
} from './data';
import { cellAt, cellCentroid, fitScale, todayView, View, MIN_ZOOM, MAX_ZOOM, isQuarterView } from './viewport';
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

const toTransform = (v: View): ZoomTransform => zoomIdentity.translate(v.x, v.y).scale(v.k);

const GRAY = '#6b6b6b';
/** mm-minzoom steps by this much; at MINZOOM_FLOOR (the most zoomed-out view) the key is removed. */
const MINZOOM_STEP = 0.5;
const MINZOOM_FLOOR = Math.log2(MIN_ZOOM);
const MINZOOM_CEIL = Math.log2(MAX_ZOOM);
/** Plain colors (month hues, activities, gray placeholder) fade more in the future than entry colors. */
const isPlainColor = (c: string) => c.startsWith('hsl(') || c === GRAY || (ACTIVITIES as string[]).includes(c);

/** Default perspective: colors for sleep, work and home hours, per theme. */
const ACTIVITY_COLORS: Record<'light' | 'dark', Record<Activity, string>> = {
  light: { sleep: 'hsl(230, 25%, 84%)', home: 'hsl(38, 80%, 72%)', work: 'hsl(200, 60%, 62%)' },
  dark: { sleep: 'hsl(230, 18%, 26%)', home: 'hsl(38, 50%, 44%)', work: 'hsl(200, 50%, 42%)' },
};
/** Hour marks in the 15-minute view: the first block of each hour gets this overlay. */
const HOUR_TICK = { light: 'rgba(0, 0, 0, 0.18)', dark: 'rgba(255, 255, 255, 0.18)' };
/** Screen sizes (px) at which hour labels appear: every 3 hours on the 3-hour square, every hour on its block. */
const THREE_HOUR_LABEL_PX = 36;
const HOUR_LABEL_PX = 20;

function hourText(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${h < 12 ? 'a' : 'p'}`;
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
  /** Screen boxes of the labels drawn last frame, for tapping. */
  private labelHits: { l: number; r: number; t: number; b: number; entry: LabelEntry }[] = [];
  /** The entry whose minzoom panel is open. */
  private selected: { path: string; title: string; minZoom: number | undefined } | null = null;
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
      const e = data.labelEntries.find(x => x.path === this.selected!.path);
      if (e) this.selected.minZoom = e.minZoom;
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
    select(canvas).call(zoomBehavior);

    // Resize. The container can be 0×0 when the view opens (e.g. a background
    // tab), so the initial view waits for the first real size.
    let initialViewApplied = false;
    const resize = () => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      if (canvas.width === 0 || canvas.height === 0) return;
      this.fitScale = fitScale(canvas.width, canvas.height);
      zoomBehavior.scaleExtent([this.fitScale * MIN_ZOOM, this.fitScale * MAX_ZOOM]);
      if (!initialViewApplied) {
        initialViewApplied = true;
        select(canvas).call(zoomBehavior.transform,
          toTransform(todayView(this.cells, this.todayIndex, canvas.width, canvas.height)));
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
    const target = toTransform(todayView(this.cells, this.todayIndex, canvas.width, canvas.height));
    select(canvas).transition().duration(600)
      .call(zb.transform, target);
  }

  private draw(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const { k, x, y } = this.transform;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.setTransform(k, 0, 0, k, x, y);

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
      ctx.globalAlpha = i > this.todayIndex ? (isPlainColor(rawColor) ? 0.2 : 0.5) : 1.0;
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
        ctx.globalAlpha = abs > nowQ ? (isPlainColor(raw) ? 0.2 : 0.5) : 1.0;
        ctx.fillStyle = resolve(raw);
        tracePolygon(ctx, blocks[q].points);
        ctx.fill();
        // Hour mark: shade the first block of each hour
        if (q % 4 === 0) {
          ctx.fillStyle = hourTick;
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
   * Hour labels in the 15-minute view: "12a 3a 6a …" on each 3-hour square once those are big enough,
   * then every hour on its first block. Drawn in world space; the caller's transform is active.
   */
  private drawHourLabels(ctx: CanvasRenderingContext2D, k: number, days: number[], color: string): void {
    const geom = this.geometry;
    if (!geom || !days.length) return;
    const blockPx = cellSize(geom.quarters(days[0])[0]) * k;
    const threeHourPx = blockPx * 6;    // a 3-hour square is 2 × 45-minute squares of 3 cells
    const every = blockPx >= HOUR_LABEL_PX ? 1 : threeHourPx >= THREE_HOUR_LABEL_PX ? 3 : 0;
    if (!every) return;
    const style = getComputedStyle(this.canvas!);
    const fontFamily = style.getPropertyValue('--font-text').trim() || 'system-ui, sans-serif';
    const px = every === 1 ? Math.min(14, blockPx * 0.5) : Math.min(14, threeHourPx * 0.3);
    ctx.save();
    ctx.font = `600 ${px / k}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 / k;
    ctx.strokeStyle = style.getPropertyValue('--background-primary').trim() || '#fff';
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.75;
    for (const d of days) {
      const blocks = geom.quarters(d);
      for (let h = 0; h < 24; h += every) {
        let pos: [number, number];
        if (every === 1) pos = cellCentroid(blocks[h * 4]);
        else {
          // Center of the 3-hour square: mean of its 12 blocks' centroids
          let sx = 0, sy = 0;
          for (let q = h * 4; q < h * 4 + 12; q++) { const [x, y] = cellCentroid(blocks[q]); sx += x; sy += y; }
          pos = [sx / 12, sy / 12];
        }
        ctx.strokeText(hourText(h), pos[0], pos[1]);
        ctx.fillText(hourText(h), pos[0], pos[1]);
      }
    }
    ctx.restore();
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    k: number, tx: number, ty: number,
    total: number, canvasW: number, canvasH: number,
    textColor: string, quarterView: boolean,
  ): void {
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

  /** Tap: a label selects its entry; a day (or 15-minute block) lists the entries covering it. */
  private onTap(evt: MouseEvent): void {
    const canvas = this.canvas;
    if (!canvas || !this.vaultData) return;
    const rect = canvas.getBoundingClientRect();
    const sx = evt.clientX - rect.left, sy = evt.clientY - rect.top;
    const hit = this.labelHits.find(b => sx >= b.l && sx <= b.r && sy >= b.t && sy <= b.b);
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

  private select(entry: LabelEntry): void {
    this.selected = { path: entry.path, title: entry.title, minZoom: entry.minZoom };
    this.renderPanel();
    this.draw();
  }

  /** The panel: entry title (opens the note), its minzoom with −/+ steps, and close. */
  private renderPanel(): void {
    const panel = this.panel;
    if (!panel) return;
    panel.empty();
    const sel = this.selected;
    panel.style.display = sel ? 'flex' : 'none';
    if (!sel) return;
    const title = panel.createSpan({ text: sel.title });
    title.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;';
    title.ariaLabel = 'Open note';
    title.addEventListener('click', () => this.app.workspace.openLinkText(sel.path, '', false));
    const mz = sel.minZoom;
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
    // Lower minzoom = the label appears when more zoomed out
    button('arrow-up', 'Raise priority (show when more zoomed out)', mz !== undefined, () =>
      this.setMinZoom(sel, mz! - MINZOOM_STEP <= MINZOOM_FLOOR ? undefined : mz! - MINZOOM_STEP));
    const value = panel.createSpan({
      text: mz === undefined ? 'always' : `${+mz.toFixed(2)} · ${+Math.pow(2, mz).toPrecision(3)}×`,
    });
    value.style.cssText = 'min-width: 72px; text-align: center; font-variant-numeric: tabular-nums;';
    value.ariaLabel = 'mm-minzoom: shown from this zoom';
    button('arrow-down', 'Lower priority (show only when more zoomed in)', (mz ?? MINZOOM_FLOOR) < MINZOOM_CEIL, () =>
      this.setMinZoom(sel, Math.round(((mz ?? MINZOOM_FLOOR) + MINZOOM_STEP) / MINZOOM_STEP) * MINZOOM_STEP));
    button('x', 'Close', true, () => { this.selected = null; this.renderPanel(); this.draw(); });
  }

  private async setMinZoom(sel: { path: string; minZoom: number | undefined }, value: number | undefined): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(sel.path);
    if (!(file instanceof TFile)) return;
    sel.minZoom = value;
    this.renderPanel();
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (value === undefined) delete fm['mm-minzoom'];
      else fm['mm-minzoom'] = value;
    });
  }

  async onClose(): Promise<void> {
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

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
