/**
 * Render the real plugin in headless Chrome and save screenshots.
 *
 *   npm run shot                       # all scenarios
 *   npm run shot -- phone-default      # only scenarios whose name contains the arg
 *   npm run shot -- --zoom=128         # extra phone screenshot at a relative zoom
 *
 * Writes screenshots/<name>.png and prints each scenario's view state as JSON.
 * Exits non-zero if the page logs an error.
 */
import esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const BUILD = resolve(ROOT, '.harness-build');
const OUT = resolve(ROOT, 'screenshots');
const TODAY = '2026-10-16T12:00:00'; // keep in sync with harness/fixture.ts
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

const PHONE = { width: 390, height: 760, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const DESKTOP = { width: 1200, height: 800 };

const scenarios = [
  { name: 'phone-default', vp: PHONE },
  { name: 'phone-default-dark', vp: PHONE, theme: 'dark' },
  { name: 'desktop-default', vp: DESKTOP },
  { name: 'phone-fit', vp: PHONE, run: mm => mm.setZoom(1) },
  // Either side of the 64× switch to 15-minute blocks
  { name: 'phone-16', vp: PHONE, run: mm => mm.setZoom(16) },
  { name: 'phone-256', vp: PHONE, run: mm => mm.setZoom(256) },
  // Zoom out, then press the Today button and let the 600ms transition finish
  { name: 'phone-today-button', vp: PHONE, run: async mm => { mm.setZoom(4); mm.clickToday(); await new Promise(r => setTimeout(r, 900)); } },
  // Old default scheme, via the perspective menu
  { name: 'phone-old-default', vp: PHONE, run: async mm => {
    document.querySelector('[aria-label="Switch perspective"]').dispatchEvent(new MouseEvent('click', { clientX: 300, clientY: 30, bubbles: true }));
    [...document.querySelectorAll('.menu-item')].find(e => e.textContent.includes('Old default')).click();
  } },
  { name: 'phone-128', vp: PHONE, run: mm => mm.setZoom(128) },
  // Overlapping entries: lanes, tentative stripes, free outlines, a long appointment as labels only
  { name: 'phone-overlaps-past', vp: PHONE, run: mm => mm.showDay('2026-10-14', 200) },
  { name: 'phone-overlaps-future', vp: PHONE, run: mm => mm.showDay('2026-10-19', 200) },
  { name: 'phone-overlaps-close', vp: PHONE, run: mm => mm.showDay('2026-10-14', 450, 140, -171) },
  { name: 'phone-overlaps-dark', vp: PHONE, theme: 'dark', run: mm => mm.showDay('2026-10-14', 200) },
  // Date label tiers: years, month starts, Sundays, every day, dates with hours
  { name: 'phone-dates-4', vp: PHONE, run: mm => mm.setZoom(4) },
  { name: 'phone-dates-12', vp: PHONE, run: mm => mm.setZoom(12) },
  { name: 'phone-dates-32', vp: PHONE, run: mm => mm.setZoom(32) },
  { name: 'phone-dates-200', vp: PHONE, run: mm => mm.setZoom(200) },
  // Double-tap empty space to add an annotation, then hold and drag the fixture one; screenshot mid-drag
  { name: 'phone-annotations', vp: PHONE, run: async mm => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    mm.doubleTap(195, 470); await wait(50);
    mm.submitAnnotation('note to self'); await wait(50);
    const made = mm.files().find(f => f.frontmatter.mm === 'annotation' && f.frontmatter['mm-title'] === 'note to self');
    if (!made) throw new Error('annotation not created');
    if (!mm.annotationAt('note to self')) throw new Error('new annotation not drawn');
    const before = mm.frontmatter('Annotation 2026-10-16 1500 3p goes here')['mm-anchor'];
    const [x, y] = mm.annotationAt('3p goes here');
    mm.mouse('mousedown', x, y); await wait(600);
    mm.mouse('mousemove', x - 40, y + 60); await wait(20);
    mm.mouse('mousemove', x - 80, y + 120); await wait(20);
    window.__dropAt = [x - 80, y + 120];
    window.__before = before;
  } },
  { name: 'phone-annotations-dropped', vp: PHONE, run: async mm => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const [x, y] = mm.annotationAt('3p goes here');
    const before = mm.frontmatter('Annotation 2026-10-16 1500 3p goes here')['mm-anchor'];
    const view0 = mm.state();
    mm.mouse('mousedown', x, y); await wait(600);
    mm.mouse('mousemove', x - 80, y + 120); await wait(20);
    if (mm.state().x !== view0.x || mm.state().y !== view0.y) throw new Error('map panned during drag');
    mm.mouse('mouseup', x - 80, y + 120); await wait(50);
    const after = mm.frontmatter('Annotation 2026-10-16 1500 3p goes here')['mm-anchor'];
    if (after === before) throw new Error('anchor did not change');
    const [nx, ny] = mm.annotationAt('3p goes here');
    // Dropped where the floating label was: 64px above the finger
    if (Math.abs(nx - (x - 80)) > 3 || Math.abs(ny - (y + 120 - 64)) > 3) throw new Error(`landed at ${nx},${ny}`);
    await wait(550); mm.tap(nx, ny); await wait(20);
    if (!document.querySelector('.memento-mori-panel [aria-label="Delete annotation"]')) throw new Error('annotation panel not shown: ' + JSON.stringify({ sel: mm.view().selected, hits: mm.view().annotationHits.map(h => [h.l, h.t, h.r, h.b]), at: [nx, ny], panel: document.querySelector('.memento-mori-panel')?.innerHTML }));
  } },
  // Tap the Dentist label, then lower its minzoom twice (5 → 4)
  { name: 'phone-tap-label', vp: PHONE, run: async mm => {
    if (!mm.tapLabel('Dentist')) throw new Error('Dentist label not drawn');
    mm.press('Raise priority (show when more zoomed out)'); await new Promise(r => setTimeout(r, 50));
    mm.press('Raise priority (show when more zoomed out)'); await new Promise(r => setTimeout(r, 50));
    const mz = mm.frontmatter('Dentist')['mm-minzoom'];
    if (mz !== 4) throw new Error(`expected mm-minzoom 4, got ${mz}`);
  } },
];

const args = process.argv.slice(2);
const zoomArg = args.find(a => a.startsWith('--zoom='));
if (zoomArg) {
  const z = Number(zoomArg.slice(7));
  scenarios.push({ name: `phone-zoom-${z}`, vp: PHONE, run: (mm, z) => mm.setZoom(z), arg: z });
}
const filters = args.filter(a => !a.startsWith('--'));
const selected = scenarios.filter(s =>
  filters.length ? filters.some(f => s.name.includes(f)) : !s.name.startsWith('phone-zoom-') || zoomArg);

mkdirSync(BUILD, { recursive: true });
mkdirSync(OUT, { recursive: true });
await esbuild.build({
  entryPoints: [resolve(ROOT, 'harness/harness.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  alias: { obsidian: resolve(ROOT, 'harness/obsidian-stub.ts') },
  outfile: resolve(BUILD, 'harness.js'),
  logLevel: 'warning',
});
copyFileSync(resolve(ROOT, 'harness/index.html'), resolve(BUILD, 'index.html'));

const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];
try {
  for (const s of selected) {
    const { width, height, ...ctxOpts } = s.vp;
    const context = await browser.newContext({ viewport: { width, height }, ...ctxOpts });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(TODAY));
    page.on('console', m => { if (m.type() === 'error') errors.push(`[${s.name}] ${m.text()}`); });
    page.on('pageerror', e => errors.push(`[${s.name}] ${e.message}`));

    const params = new URLSearchParams();
    if (s.theme) params.set('theme', s.theme);
    if (s.vp.isMobile) params.set('mobile', '1');
    const url = pathToFileURL(resolve(BUILD, 'index.html')).href + (params.size ? `?${params}` : '');
    await page.goto(url);
    await page.waitForFunction(() => window.__mm?.ready, null, { timeout: 5000 });
    if (s.run) await page.evaluate(`(${s.run.toString()})(window.__mm, ${JSON.stringify(s.arg ?? null)})`);

    const state = await page.evaluate(() => window.__mm.state());
    const file = resolve(OUT, `${s.name}.png`);
    await page.screenshot({ path: file });
    console.log(JSON.stringify({ scenario: s.name, file, ...state, zoom: +state.zoom.toFixed(2) }));
    await context.close();
  }
} finally {
  await browser.close();
}

if (errors.length) {
  console.error('Page errors:\n' + errors.join('\n'));
  process.exit(1);
}
