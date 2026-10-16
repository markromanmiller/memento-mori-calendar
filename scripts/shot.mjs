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

const PHONE = { width: 390, height: 760, isMobile: true, hasTouch: true };
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
