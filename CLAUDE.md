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
- Perspectives: built-in "Default" (sleep/work/home from the settings `sleepHours`, `workHours`, `workDays`; colors in `ACTIVITY_COLORS`, resolved per theme like the `'default'` sentinel) and "Old default" (month hues), then the user's `mm-color-perspective` names.
- Hour marks in the 15-minute view: the first block of each hour is shaded; labels show every 3 hours on the 3-hour squares, then every hour, once big enough (`THREE_HOUR_LABEL_PX`, `HOUR_LABEL_PX`).
- UI near the bottom edge leaves `var(--view-bottom-spacing)` for Obsidian mobile's floating bottom bar (the harness fakes it for phone scenarios).
- Tapping a label, day or 15-minute block selects an entry (a menu when several cover the spot); the bottom panel steps its `mm-minzoom` by 0.5 via `processFrontMatter` (stepping down to the floor removes the key).
- Annotations (`mm: annotation`): free text pinned to a spot, `mm-anchor: "YYYY-MM-DDTHH:MM u,v"` = a 15-minute block plus a position in that block's own frame (`blockPoint`/`blockUV`, so they follow the skew), with `mm-minzoom` and optional `mm-maxzoom`. Double-tap creates one (d3's `dblclick.zoom` is replaced; d3 routes touch double-taps there too). Hold 450 ms to drag: capture-phase listeners stop d3's pan, which needs `stopImmediatePropagation` because d3's mouse listener is also a window capture listener. Delete all by deleting the `mm: annotation` notes.
- Short UI timers use `performance.now()`: the harness freezes `Date.now()` to pin "today".
- Calendar notes are written into the entries folder by the Trunky System "Write calendar notes" (`~/trunky-v0.7/tools/systems/write_calendar_notes.py`); they carry `trunky-id` and `mm-busy-status`.
