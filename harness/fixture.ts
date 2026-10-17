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
  // This week, around FIXTURE_TODAY (date-only)
  entry('Paper deadline', { mm: 'event', 'mm-date': '2026-10-17', 'mm-minzoom': 5 }),
  entry('Conference trip', { mm: 'range', 'mm-start': '2026-10-19', 'mm-end': '2026-10-22', 'mm-minzoom': 5 }),
  // Timed entries (15-minute view)
  entry('Standup', { mm: 'range', 'mm-start': '2026-10-16T09:00', 'mm-end': '2026-10-16T09:15', 'mm-minzoom': 6 }),
  entry('Meeting', { mm: 'range', 'mm-start': '2026-10-16T10:00', 'mm-end': '2026-10-16T11:30', 'mm-minzoom': 6 }),
  entry('Dentist', { mm: 'range', 'mm-start': '2026-10-16T13:00', 'mm-end': '2026-10-16T14:00', 'mm-minzoom': 5 }),
  entry('Dinner', { mm: 'range', 'mm-start': '2026-10-16T18:30', 'mm-end': '2026-10-16T20:00', 'mm-minzoom': 6 }),
  entry('Workshop', { mm: 'range', 'mm-start': '2026-10-15T08:00', 'mm-end': '2026-10-15T12:00', 'mm-color': '#d9822b', 'mm-color-perspective': 'Life', 'mm-minzoom': 6 }),
  // As the Trunky calendar System writes them: times with UTC offsets
  entry('2026-10-16 1600 Lab meeting', { mm: 'range', 'mm-title': 'Lab meeting', 'mm-start': '2026-10-16T16:00:00-05:00', 'mm-end': '2026-10-16T17:00:00-05:00', 'mm-busy-status': 'busy', 'mm-minzoom': 6, 'trunky-id': '00000000-0000-4000-8000-000000000001' }),
  // A free annotation near today's 3pm block
  entry('Annotation 2026-10-16 1500 3p goes here', { mm: 'annotation', 'mm-title': '3p goes here', 'mm-anchor': '2026-10-16T15:00 1.5,-1.0', 'mm-minzoom': 6 }),
  // Overlaps as calendar notes bring them (Wed 10-14, past; Mon 10-19, future): two lanes, tentative, free, and
  // a multi-day timed appointment that only gets labels
  entry('2026-10-14 1100 Office Hours', { mm: 'range', 'mm-title': 'Office Hours', 'mm-start': '2026-10-14T11:00:00-05:00', 'mm-end': '2026-10-14T12:30:00-05:00', 'mm-busy-status': 'busy', 'mm-category-color': '#ff5fa2', 'mm-minzoom': 7 }),
  entry('2026-10-14 1115 HCI course Office hours with Amelia', { mm: 'range', 'mm-title': 'HCI course Office hours with Amelia', 'mm-start': '2026-10-14T11:15:00-05:00', 'mm-end': '2026-10-14T11:45:00-05:00', 'mm-busy-status': 'busy', 'mm-category-color': '#ff5fa2', 'mm-minzoom': 7 }),
  entry('2026-10-14 1300 Grant Work', { mm: 'range', 'mm-title': 'Grant Work', 'mm-start': '2026-10-14T13:00:00-05:00', 'mm-end': '2026-10-14T15:00:00-05:00', 'mm-busy-status': 'busy', 'mm-category-color': '#ff9800', 'mm-minzoom': 7 }),
  entry('2026-10-14 1400 Mobility Team Meeting', { mm: 'range', 'mm-title': 'Mobility Team Meeting', 'mm-start': '2026-10-14T14:00:00-05:00', 'mm-end': '2026-10-14T15:30:00-05:00', 'mm-busy-status': 'busy', 'mm-category-color': '#7b4fd6', 'mm-minzoom': 7 }),
  entry('2026-10-14 0900 ISMAR PS8', { mm: 'range', 'mm-title': 'ISMAR PS8', 'mm-start': '2026-10-14T09:00:00-05:00', 'mm-end': '2026-10-14T10:00:00-05:00', 'mm-busy-status': 'tentative', 'mm-category-color': '#7b4fd6', 'mm-minzoom': 7 }),
  entry('2026-10-14 1600 3PM CR time', { mm: 'range', 'mm-title': '3PM CR time', 'mm-start': '2026-10-14T16:00:00-05:00', 'mm-end': '2026-10-14T16:30:00-05:00', 'mm-busy-status': 'free', 'mm-minzoom': 7 }),
  entry('2026-10-12 1000 Private Appointment', { mm: 'range', 'mm-title': 'Private Appointment', 'mm-start': '2026-10-12T10:00:00-05:00', 'mm-end': '2026-10-14T18:00:00-05:00', 'mm-busy-status': 'busy', 'mm-minzoom': 7 }),
  entry('2026-10-19 0900 Mobility Team Meeting', { mm: 'range', 'mm-title': 'Mobility Team Meeting', 'mm-start': '2026-10-19T09:00:00-05:00', 'mm-end': '2026-10-19T10:30:00-05:00', 'mm-busy-status': 'busy', 'mm-category-color': '#7b4fd6', 'mm-minzoom': 7 }),
  entry('2026-10-19 0930 Shujing - Mark', { mm: 'range', 'mm-title': 'Shujing <-> Mark', 'mm-start': '2026-10-19T09:30:00-05:00', 'mm-end': '2026-10-19T10:00:00-05:00', 'mm-busy-status': 'busy', 'mm-category-color': '#7b4fd6', 'mm-minzoom': 7 }),
  entry('2026-10-19 1300 Seminars Committee', { mm: 'range', 'mm-title': 'Seminars Committee', 'mm-start': '2026-10-19T13:00:00-05:00', 'mm-end': '2026-10-19T14:00:00-05:00', 'mm-busy-status': 'tentative', 'mm-category-color': '#ffd60a', 'mm-minzoom': 7 }),
  entry('Call with Sam', { mm: 'event', 'mm-date': '2026-10-17T15:15', 'mm-minzoom': 6 }),
];
