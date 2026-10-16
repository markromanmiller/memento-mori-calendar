/**
 * Minimal stand-in for the `obsidian` module so the real plugin bundle can run
 * in a plain browser page. Implements only what src/ uses; extend as needed.
 */

// --- HTMLElement helpers Obsidian adds to the prototype ---
declare global {
  interface HTMLElement {
    empty(): void;
    addClass(...cls: string[]): void;
    createSpan(o?: { text?: string; cls?: string }): HTMLSpanElement;
    createDiv(o?: { text?: string; cls?: string }): HTMLDivElement;
  }
}
function createChild<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement, tag: K, o?: { text?: string; cls?: string },
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (o?.text) el.textContent = o.text;
  if (o?.cls) el.className = o.cls;
  parent.appendChild(el);
  return el;
}
HTMLElement.prototype.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
HTMLElement.prototype.addClass = function (...cls: string[]) { this.classList.add(...cls); };
HTMLElement.prototype.createSpan = function (o) { return createChild(this, 'span', o); };
HTMLElement.prototype.createDiv = function (o) { return createChild(this, 'div', o); };

// --- Fake vault / metadata ---
export type FakeFile = { path: string; basename: string; parent: { path: string } | null; frontmatter: Record<string, unknown> };

type Handler = (...args: unknown[]) => void;
class Events {
  private handlers = new Map<string, Handler[]>();
  on(name: string, fn: Handler) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
    return { name, fn };
  }
  trigger(name: string, ...args: unknown[]) { for (const fn of this.handlers.get(name) ?? []) fn(...args); }
}

/** Any fake file counts as a TFile. */
export class TFile {
  static [Symbol.hasInstance](x: unknown) { return !!x && typeof (x as FakeFile).path === 'string'; }
}

export class App {
  files: FakeFile[] = [];
  /** Paths passed to openLinkText, for checks. */
  opened: string[] = [];
  vault = Object.assign(new Events(), {
    getMarkdownFiles: () => this.files,
    getAbstractFileByPath: (p: string) => this.files.find(f => f.path === p) ?? null,
    /** Creates a fake file; frontmatter lines are "key: value" with JSON or plain values. */
    create: async (path: string, content: string) => {
      const fm: Record<string, unknown> = {};
      const m = /^---\n([\s\S]*?)\n---/.exec(content);
      for (const line of m ? m[1].split('\n') : []) {
        const [k, ...rest] = line.split(':');
        const raw = rest.join(':').trim();
        try { fm[k.trim()] = JSON.parse(raw); } catch { fm[k.trim()] = raw; }
      }
      const slash = path.lastIndexOf('/');
      const f: FakeFile = { path, basename: path.slice(slash + 1).replace(/\.md$/, ''), parent: { path: path.slice(0, slash) }, frontmatter: fm };
      this.files.push(f);
      this.metadataCache.trigger('changed', f);
      return f;
    },
  });
  metadataCache = Object.assign(new Events(), {
    getFileCache: (f: FakeFile) => ({ frontmatter: f.frontmatter }),
  });
  fileManager = {
    processFrontMatter: async (f: FakeFile, fn: (fm: Record<string, unknown>) => void) => {
      fn(f.frontmatter);
      this.metadataCache.trigger('changed', f);
    },
    trashFile: async (f: FakeFile) => {
      this.files = this.files.filter(x => x !== f);
      this.vault.trigger('delete', f);
    },
  };
  workspace: Workspace;
  constructor(public root: HTMLElement) { this.workspace = new Workspace(this); }
}

// --- Workspace / leaves / views ---
export class WorkspaceLeaf {
  view: ItemView | null = null;
  constructor(public ws: Workspace) {}
  async setViewState(state: { type: string }) {
    const factory = this.ws.viewFactories.get(state.type);
    if (!factory) throw new Error(`No view registered for ${state.type}`);
    const view = factory(this);
    this.view = view;
    this.ws.app.root.appendChild(view.containerEl);
    await view.onOpen();
  }
}

class Workspace {
  viewFactories = new Map<string, (leaf: WorkspaceLeaf) => ItemView>();
  leaves: WorkspaceLeaf[] = [];
  constructor(public app: App) {}
  getLeavesOfType(type: string) { return this.leaves.filter(l => l.view?.getViewType() === type); }
  async openLinkText(path: string) { this.app.opened.push(path); }
  getLeaf(_kind?: string) { const l = new WorkspaceLeaf(this); this.leaves.push(l); return l; }
  revealLeaf(_leaf: WorkspaceLeaf) {}
  detachLeavesOfType(type: string) {
    for (const l of this.getLeavesOfType(type)) { l.view?.onClose(); l.view?.containerEl.remove(); }
    this.leaves = this.leaves.filter(l => l.view?.getViewType() !== type);
  }
}

class Component {
  private cleanups: (() => void)[] = [];
  register(fn: () => void) { this.cleanups.push(fn); }
  registerInterval(id: number) { this.cleanups.push(() => window.clearInterval(id)); return id; }
  registerEvent(_ref: unknown) {}
  unload() { for (const fn of this.cleanups) fn(); }
}

export class ItemView extends Component {
  containerEl: HTMLElement;
  app: App;
  constructor(public leaf: WorkspaceLeaf) {
    super();
    // Same shape as Obsidian: children[0] = header, children[1] = content
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'workspace-leaf-content';
    this.containerEl.createDiv({ cls: 'view-header' });
    this.containerEl.createDiv({ cls: 'view-content' });
    this.app = leaf.ws.app;
  }
  getViewType(): string { return ''; }
  getDisplayText(): string { return ''; }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class Plugin extends Component {
  private data: unknown = null;
  constructor(public app: App, public manifest: unknown = {}) { super(); }
  async loadData() { return this.data; }
  async saveData(d: unknown) { this.data = d; }
  registerView(type: string, factory: (leaf: WorkspaceLeaf) => ItemView) {
    this.app.workspace.viewFactories.set(type, factory);
  }
  addRibbonIcon() { return document.createElement('div'); }
  addCommand(c: unknown) { return c; }
  addSettingTab(_t: unknown) {}
}

export class PluginSettingTab {
  containerEl = document.createElement('div');
  constructor(public app: App, public plugin: Plugin) {}
}

export class Setting {
  constructor(_el: HTMLElement) {}
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
}

// --- Modal: a plain overlay ---
export class Modal {
  containerEl = document.createElement('div');
  contentEl: HTMLElement;
  constructor(public app: App) {
    this.containerEl.className = 'modal';
    this.contentEl = this.containerEl.createDiv({ cls: 'modal-content' });
  }
  open() { document.body.appendChild(this.containerEl); this.onOpen(); }
  close() { this.onClose(); this.containerEl.remove(); }
  onOpen() {}
  onClose() {}
}

// --- Menu: renders a simple list so screenshots show it ---
export class Menu {
  private items: { title: string; checked: boolean; onClick: () => void }[] = [];
  addItem(cb: (item: { setTitle(t: string): unknown; setChecked(c: boolean): unknown; onClick(f: () => void): unknown }) => void) {
    const entry = { title: '', checked: false, onClick: () => {} };
    const api = {
      setTitle(t: string) { entry.title = t; return api; },
      setChecked(c: boolean) { entry.checked = c; return api; },
      onClick(f: () => void) { entry.onClick = f; return api; },
    };
    cb(api);
    this.items.push(entry);
    return this;
  }
  showAtMouseEvent(evt: MouseEvent) {
    document.querySelector('.menu')?.remove();
    const el = document.body.createDiv({ cls: 'menu' });
    el.style.left = `${evt.clientX}px`;
    el.style.top = `${evt.clientY}px`;
    for (const item of this.items) {
      const row = el.createDiv({ cls: 'menu-item', text: (item.checked ? '✓ ' : '   ') + item.title });
      row.addEventListener('click', () => { el.remove(); item.onClick(); });
    }
  }
}

// --- Icons: draw the icon name as text; enough to see layout ---
const ICON_GLYPHS: Record<string, string> = { layers: '≡', crosshair: '⌖', aperture: '◎', 'arrow-up': '↑', 'arrow-down': '↓', 'trash-2': '🗑', x: '×' };
export function setIcon(el: HTMLElement, name: string) {
  el.textContent = ICON_GLYPHS[name] ?? '□';
  el.dataset.icon = name;
}
