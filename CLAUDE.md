# Memento Mori (Obsidian plugin)

Lifetime calendar drawn as a Hilbert curve; one cell per day. Goal: usable as an everyday calendar, primarily on mobile.

## Verifying changes
- `npm test` — vitest unit tests (`test/`). Pure view math lives in `src/viewport.ts` so it can be tested without a DOM.
- `npm run shot [-- <name-filter>] [-- --zoom=N]` — builds `harness/` (the real `src/main.ts` against `harness/obsidian-stub.ts`), renders it in headless Chrome at phone/desktop sizes with "today" pinned to 2026-10-16, writes `screenshots/*.png`, prints view state as JSON, and fails on page errors. Read the PNGs to check rendering.
- Sample vault data is in `harness/fixture.ts`. If the plugin starts using a new Obsidian API, add it to the stub.
- Final check on a real device goes through BRAT (push + release).

## Conventions
- "Zoom N×" always means relative to the fit-to-viewport scale (`fitScale`), never d3's absolute `k`.
