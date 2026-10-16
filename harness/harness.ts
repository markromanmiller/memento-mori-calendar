/**
 * Boots the real plugin (src/main.ts) against the Obsidian stub and exposes
 * hooks on window.__mm for scripts/shot.mjs.
 */
import { select } from 'd3-selection';
import { App } from './obsidian-stub';
import { FIXTURE_FILES, FIXTURE_SETTINGS } from './fixture';
import MementoMoriPlugin from '../src/main';

declare global {
  interface Window { __mm: Record<string, unknown> }
}

async function main() {
  const params = new URLSearchParams(location.search);
  if (params.get('theme') === 'dark') document.body.classList.add('theme-dark');
  if (params.get('mobile')) {
    document.body.classList.add('is-mobile');
    document.body.createDiv({ cls: 'mobile-navbar', text: '←   →   +   ☰   ⋯' });
  }

  const app = new App(document.getElementById('workspace')!);
  app.files = FIXTURE_FILES;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin = new MementoMoriPlugin(app as any, {} as any);
  await plugin.saveData(FIXTURE_SETTINGS);
  await plugin.onload();
  await plugin.activateView();

  // Private fields are reachable at runtime; `any` keeps the harness out of the plugin's types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = () => app.workspace.getLeavesOfType('memento-mori')[0]?.view as any;

  window.__mm = {
    plugin,
    view,
    /** Current zoom relative to fit, plus the raw transform. */
    state: () => {
      const v = view();
      const t = v.transform;
      return { zoom: t.k / v.fitScale, k: t.k, x: t.x, y: t.y, todayIndex: v.todayIndex };
    },
    /** Jump to a relative zoom, keeping the canvas center fixed. */
    setZoom: (rel: number) => {
      const v = view();
      v.zoomBehavior.scaleTo(select(v.canvas), v.fitScale * rel);
    },
    /** Click at canvas coordinates (a tap). */
    tap: (sx: number, sy: number) => {
      const r = view().canvas.getBoundingClientRect();
      view().canvas.dispatchEvent(new MouseEvent('click', { clientX: r.left + sx, clientY: r.top + sy, bubbles: true }));
    },
    /** Tap the label of the entry with this title; false when it is not drawn. */
    tapLabel: (title: string) => {
      const b = view().labelHits.find((h: { entry: { title: string } }) => h.entry.title === title);
      if (!b) return false;
      (window.__mm.tap as (x: number, y: number) => void)((b.l + b.r) / 2, (b.t + b.b) / 2);
      return true;
    },
    /** Press a panel button by its aria-label. */
    press: (label: string) => (document.querySelector(`.memento-mori-panel [aria-label="${label}"]`) as HTMLElement).click(),
    frontmatter: (title: string) => app.files.find(f => f.basename === title)?.frontmatter,
    clickToday: () => (document.querySelector('[aria-label="Zoom to today"]') as HTMLElement).click(),
    ready: true,
  };
}

main().catch(e => console.error(e));
