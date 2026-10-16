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
- Times come from frontmatter: `mm-date`, `mm-start`, `mm-end` accept `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`.
