import { ItemView, Plugin, WorkspaceLeaf } from 'obsidian';
import { zoom as d3zoom, zoomIdentity, ZoomTransform } from 'd3-zoom';
import { select } from 'd3-selection';
import { buildGeometry, Cell } from './geometry';
import { parseVaultData, getTodayIndex, VaultData, LabelEntry, DEFAULT_PERSPECTIVE } from './data';
import { MementoSettings, DEFAULT_SETTINGS, MementoSettingTab } from './settings';

const VIEW_TYPE = 'memento-mori';


function cellCentroid(cell: Cell): [number, number] {
  const pts = cell.points;
  const n = pts.length;
  return [
    pts.reduce((s, p) => s + p[0], 0) / n,
    pts.reduce((s, p) => s + p[1], 0) / n,
  ];
}

class MementoView extends ItemView {
  private plugin: MementoMoriPlugin;
  private cells: Cell[] = [];
  private vaultData: VaultData | null = null;
  private currentPerspective = DEFAULT_PERSPECTIVE;
  private todayIndex = 0;
  private transform: ZoomTransform = zoomIdentity;
  private canvas: HTMLCanvasElement | null = null;
  private select: HTMLSelectElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MementoMoriPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Memento Mori'; }

  setVaultData(data: VaultData, todayIndex: number): void {
    this.vaultData = data;
    this.todayIndex = todayIndex;
    this.syncDropdown();
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

    // Perspective dropdown
    const controls = document.createElement('div');
    controls.style.cssText = `
      position: absolute; top: 8px; right: 8px; z-index: 10;
      display: flex; align-items: center; gap: 6px;
    `;
    const label = document.createElement('span');
    label.textContent = 'Perspective';
    label.style.cssText = `
      font-size: var(--font-ui-small); color: var(--text-muted);
    `;
    const sel = document.createElement('select');
    sel.style.cssText = `
      background: var(--background-secondary);
      color: var(--text-normal);
      border: 1px solid var(--background-modifier-border);
      border-radius: var(--radius-s);
      padding: 3px 8px;
      font-size: var(--font-ui-small);
      cursor: pointer;
    `;
    sel.addEventListener('change', () => {
      this.currentPerspective = sel.value;
      this.draw();
    });
    this.select = sel;
    controls.appendChild(label);
    controls.appendChild(sel);
    container.appendChild(controls);

    // Geometry
    this.cells = buildGeometry();

    // Resize
    const ro = new ResizeObserver(() => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      this.draw();
    });
    ro.observe(container);
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    this.register(() => ro.disconnect());

    // Initial transform
    this.transform = this.fitTransform(canvas.width, canvas.height);

    // Zoom
    const zoomBehavior = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.05, 64])
      .on('zoom', (event) => {
        this.transform = event.transform;
        this.draw();
      });
    select(canvas)
      .call(zoomBehavior)
      .call(zoomBehavior.transform, this.transform);

    this.draw();
    this.plugin.pushData();
  }

  private fitTransform(canvasW: number, canvasH: number): ZoomTransform {
    const worldSize = 600, padding = 24;
    const scale = (Math.min(canvasW, canvasH) - padding * 2) / worldSize;
    const tx = (canvasW - worldSize * scale) / 2;
    const ty = (canvasH - worldSize * scale) / 2;
    return zoomIdentity.translate(tx, ty).scale(scale);
  }

  private syncDropdown(): void {
    const sel = this.select;
    if (!sel || !this.vaultData) return;
    const prev = sel.value || this.currentPerspective;
    sel.innerHTML = '';

    const addOption = (value: string, label: string) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    };

    addOption(DEFAULT_PERSPECTIVE, DEFAULT_PERSPECTIVE);
    for (const p of this.vaultData.perspectives) addOption(p, p);

    // Restore previous selection if still valid, else fall back to default
    const valid = sel.querySelector(`option[value="${CSS.escape(prev)}"]`);
    sel.value = valid ? prev : DEFAULT_PERSPECTIVE;
    this.currentPerspective = sel.value;
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

    // --- Cells ---
    for (let i = 0; i < total; i++) {
      const { points } = this.cells[i];
      const baseColor = hasColors
        ? dayColors![i]
        : `hsl(${Math.round((i / total) * 360)}, 45%, 65%)`;

      ctx.fillStyle = baseColor;
      ctx.globalAlpha = i > this.todayIndex ? 0.2 : 1.0;

      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let j = 1; j < points.length; j++) ctx.lineTo(points[j][0], points[j][1]);
      ctx.closePath();
      ctx.fill();
    }

    ctx.globalAlpha = 1.0;
    ctx.restore();

    // --- Labels (screen-space: constant visual size regardless of zoom) ---
    if (this.vaultData?.labelEntries.length) {
      const style = getComputedStyle(canvas);
      const textColor = style.getPropertyValue('--text-normal').trim() || '#222';
      const bgColor = style.getPropertyValue('--background-primary').trim() || '#fff';
      const fontFamily = style.getPropertyValue('--font-text').trim() || 'system-ui, sans-serif';

      ctx.font = `13px ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = bgColor;
      ctx.fillStyle = textColor;

      for (const entry of this.vaultData.labelEntries) {
        this.drawScreenLabel(ctx, entry.startLabel, entry.startDay, total, k, x, y);
        if (entry.endLabel !== null && entry.endDay !== entry.startDay) {
          this.drawScreenLabel(ctx, entry.endLabel, entry.endDay, total, k, x, y);
        }
      }
    }

    // HUD
    const hudColor = getComputedStyle(canvas).getPropertyValue('--text-faint').trim()
      || 'rgba(128,128,128,0.7)';
    ctx.fillStyle = hudColor;
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${total.toLocaleString()} cells · zoom ${k.toFixed(2)}×`, 10, h - 8);
  }

  private drawScreenLabel(
    ctx: CanvasRenderingContext2D,
    text: string,
    day: number,
    totalCells: number,
    k: number, tx: number, ty: number,
  ): void {
    const idx = Math.max(0, Math.min(totalCells - 1, day));
    const cell = this.cells[idx];
    if (!cell) return;
    const [wx, wy] = cellCentroid(cell);
    // Convert world → screen
    const sx = wx * k + tx;
    const sy = wy * k + ty;
    ctx.strokeText(text, sx, sy);
    ctx.fillText(text, sx, sy);
  }

  async onClose(): Promise<void> {
    this.canvas = null;
    this.select = null;
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
