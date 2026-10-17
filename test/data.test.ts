import { describe, expect, it } from 'vitest';
import { SCHEDULE_DEFAULTS, laneFills, LONG_QUARTERS, buildSchedule, daysMask, entriesAt, formatAnchor, parseAnchor, hoursMask, parseVaultData, OLD_DEFAULT_PERSPECTIVE, parseWhen, DEFAULT_PERSPECTIVE, LabelEntry } from '../src/data';
import type { App } from 'obsidian';

const settings = { birthDate: '2000-01-01', entriesDir: 'MM', curveSkew: 1, sleepHours: '23:00-07:00', workHours: '09:00-17:00', workDays: 'Mon-Fri' };
const TOTAL = 32768;
const Q = 96;

function fakeApp(entries: Record<string, Record<string, unknown>>): App {
  const files = Object.keys(entries).map(name => ({ basename: name, parent: { path: 'MM' }, fm: entries[name] }));
  return {
    vault: { getMarkdownFiles: () => files },
    metadataCache: { getFileCache: (f: { fm: unknown }) => ({ frontmatter: f.fm }) },
  } as unknown as App;
}

describe('parseWhen', () => {
  it.each([
    ['2026-10-16', null],
    ['2026-10-16T13:00', 13 * 60],
    ['2026-10-16 09:45', 9 * 60 + 45],
    ['2026-10-16T13:00:30', 13 * 60],
  ])('parses %s', (s, minutes) => {
    expect(parseWhen(s)?.minutes).toBe(minutes);
  });

  // Trunky's form: local time of the event's zone, with its UTC offset. Converted to the device's zone.
  it.each([
    '2026-10-09T09:00:00+02:00',
    '2026-10-16T09:00:00-05:00',
    '2026-10-16T14:00:00Z',
    '2026-10-16T23:30:00-07:00',   // the next day in Chicago
  ])('parses %s as the same instant in local time', (s) => {
    const t = new Date(s);
    const w = parseWhen(s)!;
    expect(w.minutes).toBe(t.getHours() * 60 + t.getMinutes());
    expect(w.date.getTime()).toBe(new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime());
  });

  it.each(['', 'tomorrow', '2026-13-45', '2026-10-16T25:00', '2026-10-16T24:00:00+02:00', '2026-10-16T09:00+2', 42])('rejects %s', (s) => {
    expect(parseWhen(s)).toBeNull();
  });
});

describe('timed entries', () => {
  // 2000-01-01 is day 0; 2000-01-02 is day 1
  const data = parseVaultData(fakeApp({
    Dentist: { mm: 'range', 'mm-start': '2000-01-02T13:00', 'mm-end': '2000-01-02T14:00' },
    Call: { mm: 'event', 'mm-date': '2000-01-03T15:20' },
    Evening: { mm: 'range', 'mm-start': '2000-01-05T18:00', 'mm-end': '2000-01-05' },
    Trip: { mm: 'range', 'mm-start': '2000-01-05T18:00', 'mm-end': '2000-01-07' },
    Work: { mm: 'range', 'mm-start': '2000-01-02T08:00', 'mm-end': '2000-01-02T12:00', 'mm-color': '#f00', 'mm-color-perspective': 'Life' },
    Birthday: { mm: 'event', 'mm-date': '2000-01-10' },
    Class: { mm: 'range', 'mm-start': '2000-01-04T10:00', 'mm-end': '2000-01-04T11:00', 'mm-category-color': '#e05299' },
  }), settings, TOTAL);
  const quarters = data.quarterColorsByPerspective.get(DEFAULT_PERSPECTIVE)!;
  const days = data.dayColorsByPerspective.get(DEFAULT_PERSPECTIVE)!;
  const base = data.dayBaseColorsByPerspective.get(DEFAULT_PERSPECTIVE)!;

  it('fills exactly the blocks a timed range covers', () => {
    for (let q = Q + 50; q < Q + 58; q++) expect(quarters.has(q)).toBe(q >= Q + 52 && q < Q + 56);
  });

  it('fills a categorized entry with its category color in Default only', () => {
    expect(quarters.get(3 * Q + 40)).toBe('#e05299');
    expect(quarters.get(3 * Q + 52)).toBeUndefined();
    expect(quarters.get(Q + 52)).toBe('default');
    expect(data.quarterColorsByPerspective.get(OLD_DEFAULT_PERSPECTIVE)!.get(3 * Q + 40)).toBe('default');
  });

  it('puts a timed event in the block containing its time', () => {
    expect(quarters.has(2 * Q + 61)).toBe(true);   // 15:20 → 15:15 block
    expect(quarters.has(2 * Q + 62)).toBe(false);
  });

  it('leaves a timed range over 12 hours unfilled (Trip runs 18:00 on the 5th through the 7th)', () => {
    expect(quarters.has(5 * Q + 40)).toBe(false);
  });

  it('runs a range with a date-only end through the end of that day', () => {
    expect(quarters.has(4 * Q + 71)).toBe(false);  // 17:45 on the 5th
    expect(quarters.has(4 * Q + 72)).toBe(true);   // 18:00 on the 5th
    expect(quarters.has(4 * Q + 95)).toBe(true);   // last block of the 5th
    expect(quarters.has(5 * Q)).toBe(false);
  });

  it('leaves days unmarked in Default; Old default marks them when zoomed out but not under the blocks', () => {
    expect(days[1]).not.toBe('default');
    expect(base[9]).not.toBe('default');
    const oldDays = data.dayColorsByPerspective.get(OLD_DEFAULT_PERSPECTIVE)!;
    const oldBase = data.dayBaseColorsByPerspective.get(OLD_DEFAULT_PERSPECTIVE)!;
    expect(oldDays[1]).toBe('default');
    expect(oldBase[1]).not.toBe('default');
    expect(oldBase[9]).toBe('default');              // date-only event still marks its whole day
  });

  it('colors timed ranges in their perspective', () => {
    const life = data.quarterColorsByPerspective.get('Life')!;
    expect(life.get(Q + 32)).toBe('#f00');
    expect(life.has(Q + 48)).toBe(false);
    expect(data.dayBaseColorsByPerspective.get('Life')![1]).not.toBe('#f00');
  });

  it('labels a same-day appointment once, anchored at its blocks', () => {
    const dentist = data.labelEntries.find(e => e.startLabel === 'Dentist')!;
    expect(dentist.endLabel).toBeNull();
    expect(dentist.startQuarter).toBe(52);
    expect(dentist.endQuarter).toBe(55);
    const trip = data.labelEntries.find(e => e.startLabel === 'Start of Trip')!;
    expect([trip.startDay, trip.startQuarter, trip.endDay, trip.endQuarter]).toEqual([4, 72, 6, 95]);
  });
});

describe('entriesAt', () => {
  const e = (path: string, startDay: number, endDay: number, startQuarter?: number, endQuarter?: number): LabelEntry =>
    ({ path, title: path, startLabel: path, endLabel: null, startDay, endDay, startQuarter, endQuarter });
  const entries = [
    e('life', 0, 1000),
    e('trip', 5, 7),
    e('dentist', 6, 6, 52, 55),
    e('call', 6, 6, 61, 61),
  ];

  it('lists entries covering a day, shortest first', () => {
    expect(entriesAt(entries, 6).map(x => x.path)).toEqual(['call', 'dentist', 'trip', 'life']);
  });

  it('narrows to a 15-minute block', () => {
    expect(entriesAt(entries, 6, 53).map(x => x.path)).toEqual(['dentist', 'trip', 'life']);
    expect(entriesAt(entries, 6, 60).map(x => x.path)).toEqual(['trip', 'life']);
  });

  it('lists each note once', () => {
    expect(entriesAt([...entries, e('trip', 5, 7)], 6).filter(x => x.path === 'trip')).toHaveLength(1);
  });
});

describe('cancelled entries', () => {
  it('skips notes marked mm-cancelled', () => {
    const data = parseVaultData(fakeApp({
      Kept: { mm: 'event', 'mm-date': '2000-01-03' },
      Gone: { mm: 'event', 'mm-date': '2000-01-04', 'mm-cancelled': true },
    }), settings, TOTAL);
    expect(data.labelEntries.map(e => e.title)).toEqual(['Kept']);
  });
});

describe('schedule', () => {
  it('reads hour windows, wrapping past midnight', () => {
    const m = hoursMask('23:00-07:00')!;
    expect([m[0], m[27], m[28], m[91], m[92], m[95]]).toEqual([true, true, false, false, true, true]);
    expect(hoursMask('09:00-17:00')!.filter(Boolean)).toHaveLength(32);
    expect(hoursMask('9-5')).toBeNull();
  });

  it('reads day lists and ranges', () => {
    expect(daysMask('Mon-Fri')).toEqual([false, true, true, true, true, true, false]);
    expect(daysMask('Sat-Mon')).toEqual([true, true, false, false, false, false, true]);
    expect(daysMask('mon, Wed,FRIDAY')).toEqual([false, true, false, true, false, true, false]);
    expect(daysMask('Funday')).toBeNull();
  });

  // 2000-01-01 was a Saturday; day 2 is Monday 2000-01-03
  const s = buildSchedule(settings);
  it.each([
    [2, 4 * 6, 'sleep'], [2, 4 * 8, 'home'], [2, 4 * 10, 'work'], [2, 4 * 17, 'home'], [2, 4 * 23, 'sleep'],
    [0, 4 * 10, 'home'], [1, 4 * 10, 'home'],
  ])('day %i block %i is %s', (day, q, want) => {
    expect(s(day, q)).toBe(want);
  });

  it('keeps the month-hue scheme as Old default', () => {
    const data = parseVaultData(fakeApp({}), settings, TOTAL);
    expect(data.dayColorsByPerspective.get(OLD_DEFAULT_PERSPECTIVE)![0]).toMatch(/^hsl\(/);
    expect(data.dayColorsByPerspective.get(DEFAULT_PERSPECTIVE)!.slice(0, 3)).toEqual(['home', 'home', 'work']);
  });
});

describe('annotations', () => {
  it('round-trips an anchor through its text form', () => {
    const text = formatAnchor('2000-01-01', 2, 57, 0.3125, -1.5);
    expect(text).toBe('2000-01-03T14:15 0.313,-1.500');
    expect(parseAnchor(text, '2000-01-01')).toEqual({ day: 2, quarter: 57, u: 0.313, v: -1.5 });
  });

  it.each([undefined, '', '2000-01-03 0.1,0.2', '2000-01-03T14:15', 'soon 0,0'])('rejects anchor %s', (a) => {
    expect(parseAnchor(a, '2000-01-01')).toBeNull();
  });

  it('reads annotation notes with min and max zoom, separately from labels', () => {
    const data = parseVaultData(fakeApp({
      Note: { mm: 'annotation', 'mm-title': '10a over here', 'mm-anchor': '2000-01-03T10:00 0.5,0.5', 'mm-minzoom': 6, 'mm-maxzoom': '8.5' },
      Broken: { mm: 'annotation', 'mm-anchor': 'nowhere' },
    }), settings, TOTAL);
    expect(data.annotations).toEqual([
      { path: undefined, title: '10a over here', day: 2, quarter: 40, u: 0.5, v: 0.5, minZoom: 6, maxZoom: 8.5 },
    ]);
    expect(data.labelEntries).toHaveLength(0);
  });
});

describe('default schedule', () => {
  const s = buildSchedule({ ...settings, sleepHours: SCHEDULE_DEFAULTS.sleepHours, workHours: SCHEDULE_DEFAULTS.workHours, workDays: SCHEDULE_DEFAULTS.workDays });
  // 2000-01-01 (day 0) is a Saturday; day 2 a Monday, day 6 a Friday
  const at = (day: number, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return s(day, (h * 60 + m) / 15); };
  it('sleeps until 5:30 and from 9:30 pm, works 8–4 Mon–Thu, home otherwise', () => {
    expect(at(2, '05:15')).toBe('sleep');
    expect(at(2, '05:30')).toBe('home');
    expect(at(2, '07:45')).toBe('home');
    expect(at(2, '08:00')).toBe('work');
    expect(at(2, '15:45')).toBe('work');
    expect(at(2, '16:00')).toBe('home');
    expect(at(2, '21:15')).toBe('home');
    expect(at(2, '21:30')).toBe('sleep');
    expect(at(6, '10:00')).toBe('home');
    expect(at(0, '10:00')).toBe('home');
    expect(at(1, '10:00')).toBe('home');
  });
});

describe('laneFills', () => {
  const item = (startQ: number, endQ: number, color = '#000') => ({ startQ, endQ, color, status: 'busy' as const });
  it('gives overlapping entries their own lanes, the whole group sharing a lane count', () => {
    // A 10:00-12:30, B 11:00-11:30 overlaps it; C 13:00-14:00 is alone
    const fills = laneFills([item(40, 50, 'A'), item(44, 46, 'B'), item(52, 56, 'C')], 1000);
    expect(fills.get(40)).toEqual([{ color: 'A', status: 'busy', lane: 0, lanes: 2, next: true }]);
    expect(fills.get(44)!.map(f => [f.color, f.lane, f.lanes])).toEqual([['A', 0, 2], ['B', 1, 2]]);
    expect(fills.get(45)!.find(f => f.color === 'B')!.next).toBe(false);
    expect(fills.get(52)![0]).toMatchObject({ color: 'C', lane: 0, lanes: 1 });
  });
  it('reuses a lane once it is free, and never joins blocks across midnight', () => {
    const fills = laneFills([item(10, 20, 'A'), item(12, 14, 'B'), item(15, 18, 'C'), item(94, 98, 'D')], 1000);
    expect(fills.get(16)!.find(f => f.color === 'C')!.lane).toBe(1);
    expect(fills.get(95)![0].next).toBe(false);
    expect(fills.get(96)![0].next).toBe(true);
  });
});

describe('overlap styles', () => {
  const data = parseVaultData(fakeApp({
    Tent: { mm: 'range', 'mm-start': '2000-01-02T09:00', 'mm-end': '2000-01-02T10:00', 'mm-busy-status': 'tentative' },
    Free: { mm: 'range', 'mm-start': '2000-01-02T11:00', 'mm-end': '2000-01-02T11:30', 'mm-busy-status': 'Free' },
    Long: { mm: 'range', 'mm-start': '2000-01-03T08:00', 'mm-end': '2000-01-04T18:00' },
  }), settings, TOTAL);
  const fills = data.quarterFillsByPerspective.get(DEFAULT_PERSPECTIVE)!;
  it('keeps the busy status', () => {
    expect(fills.get(Q + 36)![0].status).toBe('tentative');
    expect(fills.get(Q + 44)![0].status).toBe('free');
  });
  it(`doesn't fill the blocks of a timed entry over ${LONG_QUARTERS / 4} hours, but labels it`, () => {
    expect(fills.has(2 * Q + 40)).toBe(false);
    expect(data.labelEntries.some(e => e.title === 'Long')).toBe(true);
  });
});
