import { describe, expect, it } from 'vitest';
import { parseVaultData, parseWhen, DEFAULT_PERSPECTIVE } from '../src/data';
import type { App } from 'obsidian';

const settings = { birthDate: '2000-01-01', entriesDir: 'MM', curveSkew: 1 };
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

  it.each(['', 'tomorrow', '2026-13-45', '2026-10-16T25:00', 42])('rejects %s', (s) => {
    expect(parseWhen(s)).toBeNull();
  });
});

describe('timed entries', () => {
  // 2000-01-01 is day 0; 2000-01-02 is day 1
  const data = parseVaultData(fakeApp({
    Dentist: { mm: 'range', 'mm-start': '2000-01-02T13:00', 'mm-end': '2000-01-02T14:00' },
    Call: { mm: 'event', 'mm-date': '2000-01-03T15:20' },
    Trip: { mm: 'range', 'mm-start': '2000-01-05T18:00', 'mm-end': '2000-01-07' },
    Work: { mm: 'range', 'mm-start': '2000-01-02T08:00', 'mm-end': '2000-01-02T12:00', 'mm-color': '#f00', 'mm-color-perspective': 'Life' },
    Birthday: { mm: 'event', 'mm-date': '2000-01-10' },
  }), settings, TOTAL);
  const quarters = data.quarterColorsByPerspective.get(DEFAULT_PERSPECTIVE)!;
  const days = data.dayColorsByPerspective.get(DEFAULT_PERSPECTIVE)!;
  const base = data.dayBaseColorsByPerspective.get(DEFAULT_PERSPECTIVE)!;

  it('fills exactly the blocks a timed range covers', () => {
    for (let q = Q + 50; q < Q + 58; q++) expect(quarters.has(q)).toBe(q >= Q + 52 && q < Q + 56);
  });

  it('puts a timed event in the block containing its time', () => {
    expect(quarters.has(2 * Q + 61)).toBe(true);   // 15:20 → 15:15 block
    expect(quarters.has(2 * Q + 62)).toBe(false);
  });

  it('runs a range with a date-only end through the end of that day', () => {
    expect(quarters.has(4 * Q + 71)).toBe(false);  // 17:45 on the 5th
    expect(quarters.has(4 * Q + 72)).toBe(true);   // 18:00 on the 5th
    expect(quarters.has(6 * Q + 95)).toBe(true);   // last block of the 7th
    expect(quarters.has(7 * Q)).toBe(false);
  });

  it('marks timed days when zoomed out but not under the blocks', () => {
    expect(days[1]).toBe('default');
    expect(base[1]).not.toBe('default');
    expect(base[9]).toBe('default');                 // date-only event still marks its whole day
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
