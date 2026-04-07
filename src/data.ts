/**
 * Frontmatter schema for entry files in the configured entries folder.
 *
 * RANGE  (mm: range)
 * ──────────────────────────────────────────────────────────────────────
 *   mm-title:            string    display title (default: filename)
 *   mm-start:            YYYY-MM-DD
 *   mm-end:              YYYY-MM-DD  (omit or leave blank for ongoing)
 *   mm-ongoing:          true        end tracks today; hides end marker
 *   mm-color:            CSS color   hex, named, hsl(), etc.
 *   mm-color-perspective: string     perspective name; required for color to apply
 *   mm-title-start:      string      start label (default: "Start of <title>")
 *   mm-title-end:        string      end label   (default: "End of <title>")
 *   mm-minzoom:          number      log2(scale/fitScale); hide label below this zoom
 *   mm-tags:             string[]    reserved for future use
 *
 * EVENT  (mm: event)
 * ──────────────────────────────────────────────────────────────────────
 *   mm-title:            string    display title (default: filename)
 *   mm-date:             YYYY-MM-DD  (blank → file exists but is not rendered)
 *   mm-minzoom:          number      same as range
 *   mm-tags:             string[]    reserved for future use
 *
 * ZOOM LEVELS  (mm-minzoom reference)
 * ──────────────────────────────────────────────────────────────────────
 *   0   = full calendar fits viewport (1× zoom in HUD)
 *   1   = 2× fit       4   = 16× fit
 *   2   = 4× fit       4.5 = ~22× fit  (zoom-to-today default)
 *   3   = 8× fit       ...
 */

import { App } from 'obsidian';
import { MementoSettings } from './settings';

export const DEFAULT_PERSPECTIVE = 'Default';

/** Uncoloured cells in custom perspectives. Exported for use in draw alpha logic. */
export const GRAY = '#6b6b6b';

/**
 * Sentinel colour for event/boundary days in the Default perspective.
 * Resolved at draw time to --text-normal so it adapts to light/dark theme.
 * Exported so the draw loop can distinguish explicit from background colours.
 */
export const EVENT_COLOR = 'default';

function parseDate(s: unknown): Date | null {
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(s + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

function dayIndex(date: Date, birth: Date): number {
  return Math.floor((date.getTime() - birth.getTime()) / 86400000);
}

export function getTodayIndex(birthDate: string): number {
  const birth = new Date(birthDate + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - birth.getTime()) / 86400000);
}

/** A range or event that should show a label on the canvas. */
export type LabelEntry = {
  startLabel: string;       // shown at startDay position
  endLabel: string | null;  // shown at endDay position; null for events (single label)
  startDay: number;
  endDay: number;
  /** Minimum zoom level (log2 of scale relative to fit-to-viewport) to show this label. */
  minZoom?: number;
};

export type VaultData = {
  /** User-defined perspective names, sorted. Does not include DEFAULT_PERSPECTIVE. */
  perspectives: string[];
  /** Colors indexed by perspective name (includes DEFAULT_PERSPECTIVE). */
  dayColorsByPerspective: Map<string, string[]>;
  /** All ranges + events, for label rendering. */
  labelEntries: LabelEntry[];
};

// ---------------------------------------------------------------------------
// Default perspective colors (hue cycles red→blue over Jan→Dec by month)
// ---------------------------------------------------------------------------

function buildDefaultColors(totalCells: number, birth: Date): string[] {
  const colors = new Array<string>(totalCells);
  for (let i = 0; i < totalCells; i++) {
    const date = new Date(birth.getTime() + i * 86400000);
    const month = date.getMonth(); // 0–11
    const hue = Math.round(month * (240 / 11)); // 0°=red, 240°=blue
    colors[i] = `hsl(${hue}, 65%, 62%)`;
  }
  return colors;
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

export function parseVaultData(
  app: App,
  settings: MementoSettings,
  totalCells: number
): VaultData {
  const birth = new Date(settings.birthDate + 'T00:00:00');
  if (isNaN(birth.getTime())) return {
    perspectives: [],
    dayColorsByPerspective: new Map([[DEFAULT_PERSPECTIVE, new Array<string>(totalCells).fill(GRAY)]]),
    labelEntries: [],
  };

  const dirPath = settings.entriesDir.replace(/\/$/, '');

  type ParsedRange = {
    startDay: number;
    endDay: number;
    duration: number;
    color: string;
    perspective: string | null;
    title: string;
    startLabel: string;
    endLabel: string;
    minZoom?: number;
    ongoing: boolean;
  };

  const ranges: ParsedRange[] = [];
  const events: { day: number; title: string; minZoom?: number }[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    if (file.parent?.path !== dirPath) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm?.mm) continue;

    const title: string = fm['mm-title'] ?? file.basename;

    const minZoom: number | undefined = (() => {
      const raw = fm['mm-minzoom'];
      const n = typeof raw === 'number' ? raw : parseFloat(raw);
      return isNaN(n) ? undefined : n;
    })();

    if (fm.mm === 'range') {
      const start = parseDate(fm['mm-start']);
      const ongoing: boolean = fm['mm-ongoing'] === true;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const end = ongoing ? today : parseDate(fm['mm-end']);
      const color: string | null = fm['mm-color'] ?? null;
      const perspective: string | null = fm['mm-color-perspective'] ?? null;
      const startLabel: string = fm['mm-title-start'] ?? `Start of ${title}`;
      const endLabel: string = fm['mm-title-end'] ?? `End of ${title}`;
      if (start && end) {
        const s = dayIndex(start, birth);
        const e = dayIndex(end, birth);
        if (e >= s) {
          ranges.push({
            startDay: s, endDay: e,
            duration: e - s,
            color: color ?? GRAY,
            perspective: (color && perspective) ? perspective : null,
            title, startLabel, endLabel, minZoom, ongoing,
          });
        }
      }
    } else if (fm.mm === 'event') {
      const date = parseDate(fm['mm-date']);
      if (date) events.push({ day: dayIndex(date, birth), title, minZoom });
    }
  }

  // --- Labels: all ranges and events regardless of coloring validity ---
  const labelEntries: LabelEntry[] = [
    ...ranges.map(r => ({
      startLabel: r.startLabel,
      endLabel: r.ongoing ? null : r.endLabel,  // ongoing ranges have no visible end
      startDay: r.startDay,
      endDay: r.endDay,
      minZoom: r.minZoom,
    })),
    ...events.map(e => ({
      startLabel: e.title,
      endLabel: null,
      startDay: e.day,
      endDay: e.day,
      minZoom: e.minZoom,
    })),
  ];

  // --- Perspectives ---
  const perspectiveSet = new Set<string>();
  for (const r of ranges) if (r.perspective) perspectiveSet.add(r.perspective);
  const perspectives = Array.from(perspectiveSet).sort();

  // --- Color maps ---
  const dayColorsByPerspective = new Map<string, string[]>();

  // Default month perspective
  const defaultColors = buildDefaultColors(totalCells, birth);
  // Range boundary days appear black in the default view; skip end day for ongoing ranges
  for (const r of ranges) {
    if (r.startDay >= 0 && r.startDay < totalCells) defaultColors[r.startDay] = EVENT_COLOR;
    if (!r.ongoing && r.endDay >= 0 && r.endDay < totalCells) defaultColors[r.endDay] = EVENT_COLOR;
  }
  for (const e of events) {
    if (e.day >= 0 && e.day < totalCells) defaultColors[e.day] = EVENT_COLOR;
  }
  dayColorsByPerspective.set(DEFAULT_PERSPECTIVE, defaultColors);

  // Sort ranges by duration descending so shorter (more specific) overwrites
  const sorted = [...ranges].sort((a, b) => b.duration - a.duration);

  for (const perspective of perspectives) {
    const colors = new Array<string>(totalCells).fill(GRAY);
    for (const r of sorted) {
      if (r.perspective !== perspective) continue;
      const from = Math.max(0, r.startDay);
      const to = Math.min(totalCells - 1, r.endDay);
      for (let d = from; d <= to; d++) colors[d] = r.color;
    }
    for (const e of events) {
      if (e.day >= 0 && e.day < totalCells) colors[e.day] = EVENT_COLOR;
    }
    dayColorsByPerspective.set(perspective, colors);
  }

  return { perspectives, dayColorsByPerspective, labelEntries };
}
