import { App } from 'obsidian';
import type { MementoSettings } from './settings';
import { QUARTERS_PER_DAY } from './geometry';

export const DEFAULT_PERSPECTIVE = 'Default';
/** The month-hue scheme that was the default until 0.2.0-beta.3. */
export const OLD_DEFAULT_PERSPECTIVE = 'Old default';
/** Built-in perspectives, listed before the user's. */
export const BUILTIN_PERSPECTIVES = [DEFAULT_PERSPECTIVE, OLD_DEFAULT_PERSPECTIVE];
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

/**
 * A free-floating note on the canvas (mm: annotation), anchored to a point near a 15-minute block:
 * mm-anchor: "2026-10-16T14:15 0.31,0.72" = the block starting then, and (u, v) in its frame (see blockPoint).
 */
export type Annotation = {
  path: string;
  title: string;
  day: number;
  quarter: number;
  u: number;
  v: number;
  minZoom?: number;
  maxZoom?: number;
};

export function parseAnchor(s: unknown, birthDate: string): { day: number; quarter: number; u: number; v: number } | null {
  if (typeof s !== 'string') return null;
  const m = /^\s*(\S+)\s+(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(s);
  if (!m) return null;
  const when = parseWhen(m[1]);
  const birth = new Date(birthDate + 'T00:00:00');
  const u = Number(m[2]), v = Number(m[3]);
  if (!when || when.minutes === null || isNaN(birth.getTime()) || !isFinite(u) || !isFinite(v)) return null;
  return { day: dayIndex(when.date, birth), quarter: Math.min(QUARTERS_PER_DAY - 1, Math.floor(when.minutes / 15)), u, v };
}

export function formatAnchor(birthDate: string, day: number, quarter: number, u: number, v: number): string {
  const b = new Date(birthDate + 'T00:00:00');
  const d = new Date(b.getFullYear(), b.getMonth(), b.getDate() + day);
  const pad = (n: number) => String(n).padStart(2, '0');
  const minutes = quarter * 15;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)} ` +
    `${u.toFixed(3)},${v.toFixed(3)}`;
}

/** A number from frontmatter (number or numeric string), else undefined. */
function fmNumber(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : parseFloat(raw as string);
  return isNaN(n) ? undefined : n;
}

export type VaultData = {
  /** User-defined perspective names, sorted. Does not include the BUILTIN_PERSPECTIVES. */
  perspectives: string[];
  /** Whole-day colors for the zoomed-out view, by perspective (includes DEFAULT_PERSPECTIVE). */
  dayColorsByPerspective: Map<string, string[]>;
  /** Day colors under the 15-minute blocks: like dayColors, but without timed entries. */
  dayBaseColorsByPerspective: Map<string, string[]>;
  /** Colors of individual 15-minute blocks from timed entries, keyed by absolute quarter. */
  quarterColorsByPerspective: Map<string, Map<number, string>>;
  /** What fills each 15-minute block covered by timed entries: one BlockFill per entry, by lane. */
  quarterFillsByPerspective: Map<string, Map<number, BlockFill[]>>;
  /** All ranges + events, for label rendering. */
  labelEntries: LabelEntry[];
  /** Sleep / work / home for a day's 15-minute block, from the settings. */
  schedule: Schedule;
  annotations: Annotation[];
};

// ---------------------------------------------------------------------------
// Daily schedule: sleep, work and home hours
// ---------------------------------------------------------------------------

export type Activity = 'sleep' | 'work' | 'home';
export type Schedule = (day: number, quarter: number) => Activity;
/** Color sentinels resolved at draw time (theme-aware), like 'default'. */
export const ACTIVITIES: Activity[] = ['sleep', 'work', 'home'];

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "HH:MM-HH:MM" as a 96-slot mask of 15-minute blocks (wraps past midnight); null if malformed. */
/** The schedule settings' defaults: sleep 9:30 pm–5:30 am, work 8–4 Monday to Thursday, home otherwise. */
export const SCHEDULE_DEFAULTS = { sleepHours: '21:30-05:30', workHours: '08:00-16:00', workDays: 'Mon-Thu' };

export function hoursMask(s: string): boolean[] | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(s ?? '');
  if (!m) return null;
  const a = (Number(m[1]) * 60 + Number(m[2])) / 15, b = (Number(m[3]) * 60 + Number(m[4])) / 15;
  if (a > 96 || b > 96) return null;
  const mask = new Array<boolean>(96).fill(false);
  for (let q = 0; q < 96; q++) mask[q] = a <= b ? q >= a && q < b : q >= a || q < b;
  return mask;
}

/** "Mon-Fri", "Mon,Wed,Fri" or "Sat-Sun,Wed" as a 7-slot mask indexed by Date.getDay(); null if malformed. */
export function daysMask(s: string): boolean[] | null {
  const mask = new Array<boolean>(7).fill(false);
  for (const part of (s ?? '').toLowerCase().split(',').map(p => p.trim()).filter(Boolean)) {
    const [from, to] = part.split('-').map(p => WEEKDAYS.indexOf(p.trim().slice(0, 3)));
    if (from < 0 || (to !== undefined && to < 0)) return null;
    for (let d = from; ; d = (d + 1) % 7) { mask[d] = true; if (to === undefined || d === to) break; }
  }
  return mask;
}

export function buildSchedule(settings: MementoSettings): Schedule {
  const sleep = hoursMask(settings.sleepHours) ?? hoursMask(SCHEDULE_DEFAULTS.sleepHours)!;
  const work = hoursMask(settings.workHours) ?? hoursMask(SCHEDULE_DEFAULTS.workHours)!;
  const workDays = daysMask(settings.workDays) ?? daysMask(SCHEDULE_DEFAULTS.workDays)!;
  const birth = new Date(settings.birthDate + 'T00:00:00');
  const valid = !isNaN(birth.getTime());
  return (day, q) => {
    if (sleep[q]) return 'sleep';
    if (!valid) return 'home';
    const weekday = new Date(birth.getFullYear(), birth.getMonth(), birth.getDate() + day).getDay();
    return workDays[weekday] && work[q] ? 'work' : 'home';
  };
}

/** Work days show as work, other days as home, in the zoomed-out Default view. */
function buildActivityDayColors(totalCells: number, schedule: Schedule, settings: MementoSettings): string[] {
  const work = hoursMask(settings.workHours) ?? hoursMask(SCHEDULE_DEFAULTS.workHours)!;
  const firstWorkQ = Math.max(0, work.indexOf(true));
  const colors = new Array<string>(totalCells);
  for (let i = 0; i < totalCells; i++) colors[i] = schedule(i, firstWorkQ) === 'work' ? 'work' : 'home';
  return colors;
}

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
      quarterFillsByPerspective: new Map([[DEFAULT_PERSPECTIVE, new Map()]]),
      labelEntries: [],
      schedule: buildSchedule(settings),
      annotations: [],
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
    /** mm-category-color: the color of the entry's time-budget category (calendar notes from Trunky). */
    categoryColor?: string;
    status: BusyStatus;
  };
  type ParsedEvent = {
    path: string; day: number; quarter: number | null; title: string; minZoom?: number; categoryColor?: string;
    status: BusyStatus;
  };

  const annotations: Annotation[] = [];
  const ranges: ParsedRange[] = [];
  const events: ParsedEvent[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    if (file.parent?.path !== dirPath) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    // Cancelled calendar events whose notes were kept (Trunky System "Write calendar notes")
    if (!fm?.mm || fm['mm-cancelled'] === true) continue;

    const title: string = fm['mm-title'] ?? file.basename;
    const busy = String(fm['mm-busy-status'] ?? '').toLowerCase();
    const status: BusyStatus = busy === 'free' ? 'free' : busy === 'tentative' ? 'tentative' : 'busy';
    const categoryColor = typeof fm['mm-category-color'] === 'string' && fm['mm-category-color'].trim()
      ? fm['mm-category-color'].trim() : undefined;

    const minZoom: number | undefined = (() => {
      const raw = fm['mm-minzoom'];
      const n = typeof raw === 'number' ? raw : parseFloat(raw);
      return isNaN(n) ? undefined : n;
    })();

    if (fm.mm === 'annotation') {
      const anchor = parseAnchor(fm['mm-anchor'], settings.birthDate);
      if (anchor) annotations.push({ path: file.path, title, ...anchor, minZoom, maxZoom: fmNumber(fm['mm-maxzoom']) });
    } else if (fm.mm === 'range') {
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
            path: file.path, title, startLabel, endLabel, minZoom, ongoing, categoryColor, status,
          });
        }
      }
    } else if (fm.mm === 'event') {
      const when = parseWhen(fm['mm-date']);
      if (when) events.push({
        path: file.path,
        day: dayIndex(when.date, birth),
        quarter: when.minutes === null ? null : Math.min(Q - 1, Math.floor(when.minutes / 15)),
        title, minZoom, categoryColor, status,
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
  for (const r of ranges) if (r.perspective && !BUILTIN_PERSPECTIVES.includes(r.perspective)) perspectiveSet.add(r.perspective);
  const perspectives = Array.from(perspectiveSet).sort();

  // --- Color maps ---
  const dayColorsByPerspective = new Map<string, string[]>();
  const dayBaseColorsByPerspective = new Map<string, string[]>();
  const quarterColorsByPerspective = new Map<string, Map<number, string>>();
  const quarterFillsByPerspective = new Map<string, Map<number, BlockFill[]>>();
  const inDays = (d: number) => d >= 0 && d < totalCells;
  // Timed ranges that fill their blocks: not ongoing, and not so long they'd hide everything under them
  const fillsBlocks = (r: ParsedRange) => r.timed !== null && !r.ongoing && r.timed.endQ - r.timed.startQ <= LONG_QUARTERS;
  const timedEvents = events.filter(e => e.quarter !== null);
  const setFills = (name: string, items: TimedItem[]) => {
    const fills = laneFills(items, totalQuarters);
    const quarters = new Map<number, string>();
    for (const [q, fs] of fills) quarters.set(q, fs[0].color);
    quarterFillsByPerspective.set(name, fills);
    quarterColorsByPerspective.set(name, quarters);
  };

  // Built-in perspectives: a base (activity or month hue) with entries marked in the theme's text color.
  // Default marks only the 15-minute blocks of timed entries; Old default also marks whole days.
  const schedule = buildSchedule(settings);
  const builtin = (name: string, base: string[], markDays: boolean) => {
    // Default fills a timed entry's blocks with its category's color, when it has one
    const blockColor = (c?: string) => (name === DEFAULT_PERSPECTIVE && c) || EVENT_COLOR;
    // Date-only range boundaries and events mark the whole day; skip end day for ongoing ranges
    for (const r of markDays ? ranges : []) {
      if (r.timed) continue;
      if (inDays(r.startDay)) base[r.startDay] = EVENT_COLOR;
      if (!r.ongoing && inDays(r.endDay)) base[r.endDay] = EVENT_COLOR;
    }
    if (markDays) for (const e of events) if (e.quarter === null && inDays(e.day)) base[e.day] = EVENT_COLOR;

    // Timed entries fill their own blocks, and in Old default mark their days when zoomed out
    const days = base.slice();
    if (markDays) {
      for (const r of ranges) {
        if (!r.timed || r.ongoing) continue;
        for (let d = Math.max(0, r.startDay); d <= Math.min(totalCells - 1, r.endDay); d++) days[d] = EVENT_COLOR;
      }
      for (const e of timedEvents) if (inDays(e.day)) days[e.day] = EVENT_COLOR;
    }
    setFills(name, [
      ...ranges.filter(fillsBlocks).map(r => ({ ...r.timed!, color: blockColor(r.categoryColor), status: r.status })),
      ...timedEvents.map(e => ({ startQ: e.day * Q + e.quarter!, endQ: e.day * Q + e.quarter! + 1, color: blockColor(e.categoryColor), status: e.status })),
    ]);
    dayColorsByPerspective.set(name, days);
    dayBaseColorsByPerspective.set(name, base);
  };
  builtin(DEFAULT_PERSPECTIVE, buildActivityDayColors(totalCells, schedule, settings), false);
  builtin(OLD_DEFAULT_PERSPECTIVE, buildDefaultColors(totalCells, birth), true);

  // Sort ranges by duration descending so shorter (more specific) overwrites
  const sorted = [...ranges].sort((a, b) => b.duration - a.duration);

  for (const perspective of perspectives) {
    const days = new Array<string>(totalCells).fill(GRAY);
    const base = new Array<string>(totalCells).fill(GRAY);
    for (const r of sorted) {
      if (r.perspective !== perspective) continue;
      const from = Math.max(0, r.startDay);
      const to = Math.min(totalCells - 1, r.endDay);
      for (let d = from; d <= to; d++) {
        days[d] = r.color;
        if (!r.timed) base[d] = r.color;
      }
    }
    for (const e of events) {
      if (!inDays(e.day)) continue;
      days[e.day] = EVENT_COLOR;
      if (e.quarter === null) base[e.day] = EVENT_COLOR;
    }
    setFills(perspective, [
      ...ranges.filter(r => r.perspective === perspective && fillsBlocks(r)).map(r => ({ ...r.timed!, color: r.color, status: r.status })),
      ...timedEvents.map(e => ({ startQ: e.day * Q + e.quarter!, endQ: e.day * Q + e.quarter! + 1, color: EVENT_COLOR, status: e.status })),
    ]);
    dayColorsByPerspective.set(perspective, days);
    dayBaseColorsByPerspective.set(perspective, base);
  }

  return { perspectives, dayColorsByPerspective, dayBaseColorsByPerspective, quarterColorsByPerspective, quarterFillsByPerspective, labelEntries, schedule, annotations };
}

/** How an entry shows on its calendar's free/busy view (mm-busy-status); anything else counts as busy. */
export type BusyStatus = 'busy' | 'tentative' | 'free';
/** A timed entry longer than this (12 hours) doesn't fill its blocks: it draws like a multi-day range. */
export const LONG_QUARTERS = 48;
/** A timed entry's absolute quarters [startQ, endQ), with its color and busy status. */
export type TimedItem = { startQ: number; endQ: number; color: string; status: BusyStatus };
/**
 * One timed entry's share of a 15-minute block. Entries that overlap (transitively) form a group drawn
 * side by side in `lanes` parallel lanes; each keeps its `lane` for its whole length.
 */
export type BlockFill = {
  color: string; status: BusyStatus; lane: number; lanes: number;
  /** The same entry continues into the next block of the same day, so the gap between them is filled. */
  next: boolean;
};

/** Blocks covered by timed items, each with its items' lanes (first free lane, in start order). */
export function laneFills(items: TimedItem[], totalQuarters: number): Map<number, BlockFill[]> {
  const Q = QUARTERS_PER_DAY;
  const sorted = items.filter(i => i.endQ > i.startQ).sort((a, b) => a.startQ - b.startQ || b.endQ - a.endQ);
  const out = new Map<number, BlockFill[]>();
  let group: { item: TimedItem; lane: number }[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    for (const { item, lane } of group) {
      for (let q = Math.max(0, item.startQ); q < Math.min(totalQuarters, item.endQ); q++) {
        const f: BlockFill = {
          color: item.color, status: item.status, lane, lanes: laneEnds.length,
          next: q + 1 < item.endQ && (q + 1) % Q !== 0,
        };
        const list = out.get(q);
        if (list) list.push(f); else out.set(q, [f]);
      }
    }
    group = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    if (item.startQ >= groupEnd) flush();
    let lane = laneEnds.findIndex(end => end <= item.startQ);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(item.endQ); } else laneEnds[lane] = item.endQ;
    group.push({ item, lane });
    groupEnd = Math.max(groupEnd, item.endQ);
  }
  flush();
  for (const list of out.values()) list.sort((a, b) => a.lane - b.lane);
  return out;
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
