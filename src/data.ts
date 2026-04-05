import { App } from 'obsidian';
import { MementoSettings } from './settings';

export const DEFAULT_PERSPECTIVE = 'Month';
const GRAY = '#6b6b6b';
const EVENT_COLOR = '#000000';

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
// Month-based default colors (hue cycles red→blue over Jan→Dec)
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
  };

  const ranges: ParsedRange[] = [];
  const events: { day: number; title: string }[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    if (file.parent?.path !== dirPath) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm?.mm) continue;

    const title: string = fm['mm-title'] ?? file.basename;

    if (fm.mm === 'range') {
      const start = parseDate(fm['mm-start']);
      const end = parseDate(fm['mm-end']);
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
            title, startLabel, endLabel,
          });
        }
      }
    } else if (fm.mm === 'event') {
      const date = parseDate(fm['mm-date']);
      if (date) events.push({ day: dayIndex(date, birth), title });
    }
  }

  // --- Labels: all ranges and events regardless of coloring validity ---
  const labelEntries: LabelEntry[] = [
    ...ranges.map(r => ({
      startLabel: r.startLabel,
      endLabel: r.endLabel,
      startDay: r.startDay,
      endDay: r.endDay,
    })),
    ...events.map(e => ({
      startLabel: e.title,
      endLabel: null,
      startDay: e.day,
      endDay: e.day,
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
  // Range boundary days and events all appear black in the default view
  for (const r of ranges) {
    if (r.startDay >= 0 && r.startDay < totalCells) defaultColors[r.startDay] = EVENT_COLOR;
    if (r.endDay >= 0 && r.endDay < totalCells) defaultColors[r.endDay] = EVENT_COLOR;
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
