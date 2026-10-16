import { App } from 'obsidian';
import { MementoSettings } from './settings';
import { QUARTERS_PER_DAY } from './geometry';

export const DEFAULT_PERSPECTIVE = 'Default';
const GRAY = '#6b6b6b';
// Sentinel resolved at draw time to --text-normal (adapts to light/dark theme)
const EVENT_COLOR = 'default';

/**
 * A frontmatter date, optionally with a time: "2026-10-16", "2026-10-16T13:00", or with a UTC offset as
 * Trunky writes it, "2026-10-09T09:00:00+02:00" (or "...Z"). A time with an offset is converted to the
 * device's local time; one without is taken as local time already.
 */
type When = { date: Date; minutes: number | null };

export function parseWhen(s: unknown): When | null {
  if (typeof s !== 'string' || !s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s.trim());
  if (!m) return null;
  const [, day, hh, mm, ss, offset] = m;
  if (offset) {
    if (Number(hh) > 23 || Number(mm) > 59) return null;
    const off = offset === 'Z' ? 'Z' : offset.replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
    const t = new Date(`${day}T${hh.padStart(2, '0')}:${mm}:${ss ?? '00'}${off}`);
    if (isNaN(t.getTime())) return null;
    return { date: new Date(t.getFullYear(), t.getMonth(), t.getDate()), minutes: t.getHours() * 60 + t.getMinutes() };
  }
  const date = new Date(day + 'T00:00:00');
  if (isNaN(date.getTime())) return null;
  const minutes = hh === undefined ? null : Number(hh) * 60 + Number(mm);
  if (minutes !== null && minutes > 24 * 60) return null;
  return { date, minutes };
}

function dayIndex(date: Date, birth: Date): number {
  // Round to absorb DST shifts between midnight timestamps
  return Math.round((date.getTime() - birth.getTime()) / 86400000);
}

export function getTodayIndex(birthDate: string): number {
  const birth = new Date(birthDate + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - birth.getTime()) / 86400000);
}

/** Absolute 15-minute index (day × 96 + quarter of the day) for the current time. */
export function getNowQuarter(birthDate: string): number {
  const now = new Date();
  return getTodayIndex(birthDate) * QUARTERS_PER_DAY + Math.floor((now.getHours() * 60 + now.getMinutes()) / 15);
}

/** A range or event that should show a label on the canvas. */
export type LabelEntry = {
  /** Vault path of the entry's note. */
  path: string;
  /** mm-title, or the note's name. */
  title: string;
  startLabel: string;       // shown at startDay position
  endLabel: string | null;  // shown at endDay position; null for events (single label)
  startDay: number;
  endDay: number;
  /** Quarter of the day (0–95) for timed entries; anchors the label in the 15-minute view. */
  startQuarter?: number;
  endQuarter?: number;
  /** Minimum zoom level (log2 of scale relative to fit-to-viewport) to show this label. */
  minZoom?: number;
};

export type VaultData = {
  /** User-defined perspective names, sorted. Does not include DEFAULT_PERSPECTIVE. */
  perspectives: string[];
  /** Whole-day colors for the zoomed-out view, by perspective (includes DEFAULT_PERSPECTIVE). */
  dayColorsByPerspective: Map<string, string[]>;
  /** Day colors under the 15-minute blocks: like dayColors, but without timed entries. */
  dayBaseColorsByPerspective: Map<string, string[]>;
  /** Colors of individual 15-minute blocks from timed entries, keyed by absolute quarter. */
  quarterColorsByPerspective: Map<string, Map<number, string>>;
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
  if (isNaN(birth.getTime())) {
    const gray = new Array<string>(totalCells).fill(GRAY);
    return {
      perspectives: [],
      dayColorsByPerspective: new Map([[DEFAULT_PERSPECTIVE, gray]]),
      dayBaseColorsByPerspective: new Map([[DEFAULT_PERSPECTIVE, gray]]),
      quarterColorsByPerspective: new Map([[DEFAULT_PERSPECTIVE, new Map()]]),
      labelEntries: [],
    };
  }

  const dirPath = settings.entriesDir.replace(/\/$/, '');
  const Q = QUARTERS_PER_DAY;
  const totalQuarters = totalCells * Q;

  type ParsedRange = {
    startDay: number;
    endDay: number;
    /** Absolute quarters [startQ, endQ); only for ranges with a time on either end. */
    timed: { startQ: number; endQ: number } | null;
    duration: number;
    color: string;
    perspective: string | null;
    path: string;
    title: string;
    startLabel: string;
    endLabel: string | null;
    minZoom?: number;
    ongoing: boolean;
  };
  type ParsedEvent = { path: string; day: number; quarter: number | null; title: string; minZoom?: number };

  const ranges: ParsedRange[] = [];
  const events: ParsedEvent[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    if (file.parent?.path !== dirPath) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    // Cancelled calendar events whose notes were kept (Trunky System "Write calendar notes")
    if (!fm?.mm || fm['mm-cancelled'] === true) continue;

    const title: string = fm['mm-title'] ?? file.basename;

    const minZoom: number | undefined = (() => {
      const raw = fm['mm-minzoom'];
      const n = typeof raw === 'number' ? raw : parseFloat(raw);
      return isNaN(n) ? undefined : n;
    })();

    if (fm.mm === 'range') {
      const start = parseWhen(fm['mm-start']);
      const ongoing: boolean = fm['mm-ongoing'] === true;
      const now = new Date();
      const end: When | null = ongoing
        ? { date: new Date(now.getFullYear(), now.getMonth(), now.getDate()), minutes: start?.minutes != null ? now.getHours() * 60 + now.getMinutes() : null }
        : parseWhen(fm['mm-end']);
      const color: string | null = fm['mm-color'] ?? null;
      const perspective: string | null = fm['mm-color-perspective'] ?? null;
      if (start && end) {
        const s = dayIndex(start.date, birth);
        const e = dayIndex(end.date, birth);
        const isTimed = start.minutes !== null || end.minutes !== null;
        // A timed range within one day (an appointment) gets a single label by default
        const sameDayTimed = isTimed && s === e;
        const startLabel: string = fm['mm-title-start'] ?? (sameDayTimed ? title : `Start of ${title}`);
        const endLabel: string | null = fm['mm-title-end'] ?? (sameDayTimed ? null : `End of ${title}`);
        // A date-only end means "through the end of that day"
        const startQ = s * Q + Math.floor((start.minutes ?? 0) / 15);
        const endQ = end.minutes === null ? (e + 1) * Q : e * Q + Math.ceil(end.minutes / 15);
        if (e >= s && endQ > startQ) {
          ranges.push({
            startDay: s,
            // A range ending exactly at midnight belongs to the previous day
            endDay: isTimed ? Math.floor((endQ - 1) / Q) : e,
            timed: isTimed ? { startQ, endQ } : null,
            duration: isTimed ? endQ - startQ : (e - s + 1) * Q,
            color: color ?? GRAY,
            perspective: (color && perspective) ? perspective : null,
            path: file.path, title, startLabel, endLabel, minZoom, ongoing,
          });
        }
      }
    } else if (fm.mm === 'event') {
      const when = parseWhen(fm['mm-date']);
      if (when) events.push({
        path: file.path,
        day: dayIndex(when.date, birth),
        quarter: when.minutes === null ? null : Math.min(Q - 1, Math.floor(when.minutes / 15)),
        title, minZoom,
      });
    }
  }

  // --- Labels: all ranges and events regardless of coloring validity ---
  const labelEntries: LabelEntry[] = [
    ...ranges.map(r => ({
      path: r.path,
      title: r.title,
      startLabel: r.startLabel,
      endLabel: r.ongoing ? null : r.endLabel,  // ongoing ranges have no visible end
      startDay: r.startDay,
      endDay: r.endDay,
      startQuarter: r.timed ? r.timed.startQ - r.startDay * Q : undefined,
      endQuarter: r.timed ? r.timed.endQ - 1 - r.endDay * Q : undefined,
      minZoom: r.minZoom,
    })),
    ...events.map(e => ({
      path: e.path,
      title: e.title,
      startLabel: e.title,
      endLabel: null,
      startDay: e.day,
      endDay: e.day,
      startQuarter: e.quarter ?? undefined,
      endQuarter: e.quarter ?? undefined,
      minZoom: e.minZoom,
    })),
  ];

  // --- Perspectives ---
  const perspectiveSet = new Set<string>();
  for (const r of ranges) if (r.perspective) perspectiveSet.add(r.perspective);
  const perspectives = Array.from(perspectiveSet).sort();

  // --- Color maps ---
  const dayColorsByPerspective = new Map<string, string[]>();
  const dayBaseColorsByPerspective = new Map<string, string[]>();
  const quarterColorsByPerspective = new Map<string, Map<number, string>>();
  const inDays = (d: number) => d >= 0 && d < totalCells;
  const inQuarters = (q: number) => q >= 0 && q < totalQuarters;

  // Default month perspective
  {
    const base = buildDefaultColors(totalCells, birth);
    const quarters = new Map<number, string>();
    // Date-only range boundaries and events mark the whole day; skip end day for ongoing ranges
    for (const r of ranges) {
      if (r.timed) continue;
      if (inDays(r.startDay)) base[r.startDay] = EVENT_COLOR;
      if (!r.ongoing && inDays(r.endDay)) base[r.endDay] = EVENT_COLOR;
    }
    for (const e of events) if (e.quarter === null && inDays(e.day)) base[e.day] = EVENT_COLOR;

    // Timed entries fill their own blocks, and mark their days when zoomed out
    const days = base.slice();
    for (const r of ranges) {
      if (!r.timed || r.ongoing) continue;
      for (let q = Math.max(0, r.timed.startQ); q < Math.min(totalQuarters, r.timed.endQ); q++) quarters.set(q, EVENT_COLOR);
      for (let d = Math.max(0, r.startDay); d <= Math.min(totalCells - 1, r.endDay); d++) days[d] = EVENT_COLOR;
    }
    for (const e of events) {
      if (e.quarter === null) continue;
      const q = e.day * Q + e.quarter;
      if (inQuarters(q)) quarters.set(q, EVENT_COLOR);
      if (inDays(e.day)) days[e.day] = EVENT_COLOR;
    }
    dayColorsByPerspective.set(DEFAULT_PERSPECTIVE, days);
    dayBaseColorsByPerspective.set(DEFAULT_PERSPECTIVE, base);
    quarterColorsByPerspective.set(DEFAULT_PERSPECTIVE, quarters);
  }

  // Sort ranges by duration descending so shorter (more specific) overwrites
  const sorted = [...ranges].sort((a, b) => b.duration - a.duration);

  for (const perspective of perspectives) {
    const days = new Array<string>(totalCells).fill(GRAY);
    const base = new Array<string>(totalCells).fill(GRAY);
    const quarters = new Map<number, string>();
    for (const r of sorted) {
      if (r.perspective !== perspective) continue;
      const from = Math.max(0, r.startDay);
      const to = Math.min(totalCells - 1, r.endDay);
      for (let d = from; d <= to; d++) {
        days[d] = r.color;
        if (!r.timed) base[d] = r.color;
      }
      if (r.timed) {
        for (let q = Math.max(0, r.timed.startQ); q < Math.min(totalQuarters, r.timed.endQ); q++) quarters.set(q, r.color);
      }
    }
    for (const e of events) {
      if (!inDays(e.day)) continue;
      days[e.day] = EVENT_COLOR;
      if (e.quarter === null) base[e.day] = EVENT_COLOR;
      else quarters.set(e.day * Q + e.quarter, EVENT_COLOR);
    }
    dayColorsByPerspective.set(perspective, days);
    dayBaseColorsByPerspective.set(perspective, base);
    quarterColorsByPerspective.set(perspective, quarters);
  }

  return { perspectives, dayColorsByPerspective, dayBaseColorsByPerspective, quarterColorsByPerspective, labelEntries };
}

/** Absolute quarters [first, last] an entry covers; date-only ends cover their whole day. */
function quarterSpan(e: LabelEntry): [number, number] {
  const Q = QUARTERS_PER_DAY;
  return [e.startDay * Q + (e.startQuarter ?? 0), e.endDay * Q + (e.endQuarter ?? Q - 1)];
}

/**
 * Entries covering a tapped day (quarter undefined) or 15-minute block (quarter of that day), shortest
 * first, one per note.
 */
export function entriesAt(entries: LabelEntry[], day: number, quarter?: number): LabelEntry[] {
  const Q = QUARTERS_PER_DAY;
  const [lo, hi] = quarter === undefined ? [day * Q, day * Q + Q - 1] : [day * Q + quarter, day * Q + quarter];
  const seen = new Set<string>();
  return entries
    .filter(e => { const [a, b] = quarterSpan(e); return a <= hi && b >= lo; })
    .sort((x, y) => (quarterSpan(x)[1] - quarterSpan(x)[0]) - (quarterSpan(y)[1] - quarterSpan(y)[0]))
    .filter(e => !seen.has(e.path) && !!seen.add(e.path));
}
