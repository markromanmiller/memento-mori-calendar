/**
 * Boots the real plugin (src/main.ts) against the Obsidian stub and exposes
 * hooks on window.__mm for scripts/shot.mjs.
 */
import { select } from 'd3-selection';
import { zoomIdentity } from 'd3-zoom';
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
    /** Center a date (YYYY-MM-DD) at a relative zoom. */
    showDay: (date: string, rel: number) => {
      const v = view();
      const birth = new Date(plugin.settings.birthDate + 'T00:00:00');
      const day = Math.round((new Date(date + 'T00:00:00').getTime() - birth.getTime()) / 86_400_000);
      const [wx, wy] = v.dayCentroids[day];
      const k = v.fitScale * rel;
      v.zoomBehavior.transform(select(v.canvas), zoomIdentity.translate(v.cssW / 2 - wx * k, v.cssH / 2 - wy * k).scale(k));
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
    /** Double-click at canvas coordinates (d3 routes touch double-taps to the same handler). */
    doubleTap: (sx: number, sy: number) => {
      const r = view().canvas.getBoundingClientRect();
      view().canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: r.left + sx, clientY: r.top + sy, bubbles: true }));
    },
    /** Fill in and submit the open annotation dialog. */
    submitAnnotation: (text: string) => {
      (document.querySelector('.modal input') as HTMLInputElement).value = text;
      (document.querySelector('.modal .mod-cta') as HTMLElement).click();
    },
    /** Canvas-coordinate center of a drawn annotation, or null. */
    annotationAt: (title: string) => {
      const b = view().annotationHits.find((h: { ann: { title: string } }) => h.ann.title === title);
      return b ? [(b.l + b.r) / 2, (b.t + b.b) / 2] : null;
    },
    /** Mouse events at canvas coordinates: down on the canvas, move/up on the window (as d3 listens). */
    mouse: (type: string, sx: number, sy: number) => {
      const r = view().canvas.getBoundingClientRect();
      const target = type === 'mousedown' ? view().canvas : window;
      target.dispatchEvent(new MouseEvent(type, { clientX: r.left + sx, clientY: r.top + sy, bubbles: true, view: window }));
    },
    files: () => app.files,
    frontmatter: (title: string) => app.files.find(f => f.basename === title)?.frontmatter,
    clickToday: () => (document.querySelector('[aria-label="Zoom to today"]') as HTMLElement).click(),
    ready: true,
  };
}

main().catch(e => console.error(e));
