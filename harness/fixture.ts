/**
 * Sample vault for the harness. Screenshots pin "today" to FIXTURE_TODAY via the
 * Playwright clock, so entries near that date land inside the default view.
 */
import type { FakeFile } from './obsidian-stub';

export const FIXTURE_TODAY = '2026-10-16';
export const FIXTURE_SETTINGS = { birthDate: '1995-06-15', entriesDir: 'Memento Mori', curveSkew: 1 };

const entry = (name: string, frontmatter: Record<string, unknown>): FakeFile => ({
  path: `Memento Mori/${name}.md`,
  basename: name,
  parent: { path: 'Memento Mori' },
  frontmatter,
});

export const FIXTURE_FILES: FakeFile[] = [
  entry('College', { mm: 'range', 'mm-start': '2013-08-20', 'mm-end': '2017-05-15', 'mm-color': '#4a7fb5', 'mm-color-perspective': 'Life' }),
  entry('Grad school', { mm: 'range', 'mm-start': '2019-08-15', 'mm-end': '2025-05-10', 'mm-color': '#8e5bb5', 'mm-color-perspective': 'Life' }),
  entry('Current job', { mm: 'range', 'mm-start': '2025-08-01', 'mm-ongoing': true, 'mm-color': '#3a9a6a', 'mm-color-perspective': 'Life' }),
  entry('Moved to Chicago', { mm: 'event', 'mm-date': '2019-08-10', 'mm-minzoom': 2 }),
  // This week, around FIXTURE_TODAY
  entry('Dentist', { mm: 'event', 'mm-date': '2026-10-14', 'mm-minzoom': 5 }),
  entry('Paper deadline', { mm: 'event', 'mm-date': '2026-10-17', 'mm-minzoom': 5 }),
  entry('Conference trip', { mm: 'range', 'mm-start': '2026-10-19', 'mm-end': '2026-10-22', 'mm-minzoom': 5 }),
];
