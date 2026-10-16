import { ItemView, Menu, Plugin, WorkspaceLeaf, setIcon } from 'obsidian';
import { zoom as d3zoom, ZoomBehavior, zoomIdentity, ZoomTransform } from 'd3-zoom';
import { select } from 'd3-selection';
import { buildGeometry, Cell } from './geometry';
import { parseVaultData, getTodayIndex, VaultData, LabelEntry, DEFAULT_PERSPECTIVE } from './data';
import { cellCentroid, fitScale, todayView, View, MIN_ZOOM, MAX_ZOOM } from './viewport';
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

const toTransform = (v: View): ZoomTransform => zoomIdentity.translate(v.x, v.y).scale(v.k);

class MementoView extends ItemView {
  private plugin: MementoMoriPlugin;
  private cells: Cell[] = [];
  private vaultData: VaultData | null = null;
  private currentPerspective = DEFAULT_PERSPECTIVE;
  private todayIndex = 0;
  private transform: ZoomTransform = zoomIdentity;
  private canvas: HTMLCanvasElement | null = null;
  private perspectiveBtn: HTMLButtonElement | null = null;
  private zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown> | null = null;
  /** Scale factor at which the full calendar fits the viewport (zoom level 0). */
  private fitScale = 1;

  constructor(leaf: WorkspaceLeaf, plugin: MementoMoriPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Memento Mori'; }

  setVaultData(data: VaultData, todayIndex: number): void {
    this.vaultData = data;
    this.todayIndex = todayIndex;
    // If the current perspective was removed, fall back to default
    if (!data.perspectives.includes(this.currentPerspective) &&
        this.currentPerspective !== DEFAULT_PERSPECTIVE) {
      this.currentPerspective = DEFAULT_PERSPECTIVE;
      if (this.perspectiveBtn) {
        const label = this.perspectiveBtn.querySelector('span:last-child') as HTMLElement | null;
        if (label) label.textContent = DEFAULT_PERSPECTIVE;
      }
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
      const all = [DEFAULT_PERSPECTIVE, ...(this.vaultData?.perspectives ?? [])];
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

    // Geometry — turnAngle = 90° minus the configured skew
    this.cells = buildGeometry(7, 90 - this.plugin.settings.curveSkew);
    // Known before the first frame so the initial view can center on today
    this.todayIndex = getTodayIndex(this.plugin.settings.birthDate);

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
    const dayColors = this.vaultData?.dayColorsByPerspective.get(this.currentPerspective);
    const hasColors = dayColors?.length === total;

    // Resolve 'default' sentinel to theme text color (adapts to light/dark mode)
    const themeTextColor = getComputedStyle(canvas).getPropertyValue('--text-normal').trim() || '#222';

    // --- Cells ---
    for (let i = 0; i < total; i++) {
      const { points } = this.cells[i];
      const rawColor = hasColors
        ? dayColors![i]
        : `hsl(${Math.round((i / total) * 360)}, 45%, 65%)`;
      const baseColor = rawColor === 'default' ? themeTextColor : rawColor;

      ctx.fillStyle = baseColor;
      // Plain cells (month hsl or gray placeholder) fade to 0.2; event/range cells to 0.5
      const isPlain = rawColor.startsWith('hsl(') || rawColor === '#6b6b6b';
      ctx.globalAlpha = i > this.todayIndex ? (isPlain ? 0.2 : 0.5) : 1.0;

      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let j = 1; j < points.length; j++) ctx.lineTo(points[j][0], points[j][1]);
      ctx.closePath();
      ctx.fill();
    }

    ctx.globalAlpha = 1.0;

    // Today cell: theme-inverted fill with a mitered border so it pops in both modes
    if (this.todayIndex >= 0 && this.todayIndex < total) {
      const todayCell = this.cells[this.todayIndex];
      const bgColor = getComputedStyle(canvas).getPropertyValue('--background-primary').trim() || '#fff';
      ctx.fillStyle = bgColor;
      ctx.strokeStyle = themeTextColor;
      ctx.lineWidth = 0.4; // world-space units (gap between cells is ~0.4)
      ctx.lineJoin = 'miter';
      ctx.beginPath();
      ctx.moveTo(todayCell.points[0][0], todayCell.points[0][1]);
      for (let j = 1; j < todayCell.points.length; j++) ctx.lineTo(todayCell.points[j][0], todayCell.points[j][1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();

    // --- Labels ---
    this.drawLabels(ctx, k, x, y, total, w, h, themeTextColor);

    // HUD
    const hudColor = getComputedStyle(canvas).getPropertyValue('--text-faint').trim()
      || 'rgba(128,128,128,0.7)';
    ctx.fillStyle = hudColor;
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const displayZoom = (k / this.fitScale).toFixed(2);
    ctx.fillText(`${total.toLocaleString()} cells · zoom ${displayZoom}×`, 10, h - 8);
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    k: number, tx: number, ty: number,
    total: number, canvasW: number, canvasH: number,
    textColor: string,
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
    };

    // Phase 1a: count eligible labels per anchor for stack-height estimation
    const anchorCounts = new Map<number, number>();
    for (const entry of this.vaultData.labelEntries) {
      if (entry.minZoom !== undefined && zoomLevel < entry.minZoom) continue;
      const inc = (idx: number) => anchorCounts.set(idx, (anchorCounts.get(idx) ?? 0) + 1);
      inc(Math.max(0, Math.min(total - 1, entry.startDay)));
      if (entry.endLabel !== null && entry.endDay !== entry.startDay)
        inc(Math.max(0, Math.min(total - 1, entry.endDay)));
    }

    // Phase 1b: collect candidates, filter by minZoom and viewport
    const candidates: Candidate[] = [];

    const addCandidate = (text: string, day: number, minZoom: number | undefined) => {
      const anchorIdx = Math.max(0, Math.min(total - 1, day));
      const cell = this.cells[anchorIdx];
      if (!cell) return;
      const [wx, wy] = cellCentroid(cell);
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
      });
    };

    for (const entry of this.vaultData.labelEntries) {
      if (entry.minZoom !== undefined && zoomLevel < entry.minZoom) continue;
      addCandidate(entry.startLabel, entry.startDay, entry.minZoom);
      if (entry.endLabel !== null && entry.endDay !== entry.startDay) {
        addCandidate(entry.endLabel, entry.endDay, entry.minZoom);
      }
    }

    // Phase 2: sort — lower minZoom (more always-visible) wins; alphabetical tiebreak
    candidates.sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.name.localeCompare(b.name)
    );

    // Phase 3: propose → box → occlusion test → commit
    // Each anchor's box is always the centered combined box, so drawn positions match exactly.
    type LabelInStack = { lines: string[]; sx: number; boxH: number };
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
        labels: [...(existing?.labels ?? []), { lines: c.lines, sx: c.sx, boxH: c.boxH }],
      });
    }

    // Phase 4: draw each committed stack, centered on its cell
    // Labels are ordered bottom-to-top (first committed at bottom).
    for (const [, state] of anchors) {
      let curBottom = state.cellSy + state.totalH / 2;
      for (const label of state.labels) {
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

  async onClose(): Promise<void> {
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
