# Memento Mori (Obsidian plugin)

Lifetime calendar drawn as a Hilbert curve; one cell per day. Goal: usable as an everyday calendar, primarily on mobile.

## Verifying changes
- `npm test` — vitest unit tests (`test/`). Pure view math lives in `src/viewport.ts` so it can be tested without a DOM.
- `npm run shot [-- <name-filter>] [-- --zoom=N]` — builds `harness/` (the real `src/main.ts` against `harness/obsidian-stub.ts`), renders it in headless Chrome at phone/desktop sizes with "today" pinned to 2026-10-16, writes `screenshots/*.png`, prints view state as JSON, and fails on page errors. Read the PNGs to check rendering.
- Sample vault data is in `harness/fixture.ts`. If the plugin starts using a new Obsidian API, add it to the stub.
- Final check on a real device goes through BRAT (push + release).

## Geometry (src/geometry.ts)
- One Hilbert curve at increasing orders: order 7 = squares (2 days each, laid out with the curve-skew setting), order 8 = half-squares (a day = 2 consecutive, a 1:2 rectangle), order 9 = 3-hour squares, order 10 = 45-minute squares.
- Each 45-minute square is split 3×3; its entry-middle, center and exit-middle cells are three 15-minute blocks (96 per day). The remaining cells are free space for annotations.
- `hilbertPoint(order, i)` matches the L-system curve at every order (tested), so deep levels are computed on demand; `quarters(day)` is cached per day.
- Day gaps are world-space: 0.4, halved only on the two edges where the curve crosses into the previous/next day.

## Conventions
- "Zoom N×" always means relative to the fit-to-viewport scale (`fitScale`), never d3's absolute `k`.
- At ≥ 64× (`isQuarterView`) days draw as 15-minute blocks; below, as whole days. Hard switch, no blending.
- Times come from frontmatter: `mm-date`, `mm-start`, `mm-end` accept `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, or Trunky's form with a UTC offset (`2026-10-09T09:00:00+02:00`, converted to the device's local time).
- Perspectives: built-in "Default" (sleep/work/home from the settings `sleepHours`, `workHours`, `workDays`, defaults in `SCHEDULE_DEFAULTS`: sleep 21:30–05:30, work 08:00–16:00 Mon–Thu; saved copies of the first defaults are migrated on load; colors in `ACTIVITY_COLORS` — work Illinois Tech red, home gray-blue — resolved per theme like the `'default'` sentinel; entries fill only their 15-minute blocks, days aren't marked) and "Old default" (month hues, days with entries marked), then the user's `mm-color-perspective` names.
- In Default, a timed entry with `mm-category-color` (written by Trunky from its Category) fills its blocks with that color instead of the text color.
- Timed entries in the 15-minute view (`quarterFillsByPerspective`, built by `laneFills`): overlapping entries get side-by-side lanes along the path (`laneShape`; L-shapes at turns), each entry keeps its lane, and consecutive blocks of one entry are joined lane to lane (not across midnight). `mm-busy-status` tentative draws striped, free as an outline only. Timed entries over 12 h (`LONG_QUARTERS`) only get labels. Future cells fade (`futureAlpha`): entries 0.5, activities 0.45, other plain colors 0.2.
- Date labels by relative zoom (`YEAR_ZOOM` … `HOURS_ZOOM`): from 2.8× Jan 1 as the year, 8× month firsts ("Nov 1"), 22.6× Sundays, 64× every day, at day centroids and giving way to entry labels; from 181× the date ("16th") sits on the midnight block and every other hour is labeled on its first block. The first block of each hour is shaded in the 15-minute view.
- The canvas backing store is in device pixels (`devicePixelRatio`); all drawing and hit-testing code works in CSS pixels (`cssW`/`cssH`). The harness phone runs at deviceScaleFactor 3.
- UI near the bottom edge leaves `var(--view-bottom-spacing)` for Obsidian mobile's floating bottom bar (the harness fakes it for phone scenarios).
- Tapping a label, day or 15-minute block selects an entry (a menu when several cover the spot); the bottom panel steps its `mm-minzoom` by 0.5 via `processFrontMatter` (stepping down to the floor removes the key).
- Annotations (`mm: annotation`): free text pinned to a spot, `mm-anchor: "YYYY-MM-DDTHH:MM u,v"` = a 15-minute block plus a position in that block's own frame (`blockPoint`/`blockUV`, so they follow the skew), with `mm-minzoom` and optional `mm-maxzoom`. Double-tap creates one (d3's `dblclick.zoom` is replaced; d3 routes touch double-taps there too). Hold 450 ms to drag: capture-phase listeners stop d3's pan, which needs `stopImmediatePropagation` because d3's mouse listener is also a window capture listener. Delete all by deleting the `mm: annotation` notes.
- Short UI timers use `performance.now()`: the harness freezes `Date.now()` to pin "today".
- Calendar notes are written into the entries folder by the Trunky System "Write calendar notes" (`~/trunky-v0.7/tools/systems/write_calendar_notes.py`); they carry `trunky-id` and `mm-busy-status`.
