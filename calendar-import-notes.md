# Calendar → Memento Mori Import Notes

## Overview

We pull events from two ICS calendar feeds, filter noise, and create Markdown files
in the Memento Mori entries folder inside the Obsidian vault.

---

## Calendar Sources

| Label | URL |
|---|---|
| Outlook (IIT) | secret: `OUTLOOK_ICS_URL` in `~/.config/trunky-ecs.env` |
| Google (personal) | secret: `GOOGLE_ICS_URL` in `~/.config/trunky-ecs.env` |

The Outlook feed exports a rolling ~1-year window (confirmed range: 2025-04-11 to 2026-05-04
when fetched on 2026-04-11). Recurring events are properly expanded when using
`recurring-ical-events`.

---

## Python Environment & Dependencies

Shared venv: `/home/mark/assist/.venv`

```bash
source /home/mark/assist/.venv/bin/activate
uv pip install --python /home/mark/assist/.venv/bin/python icalendar recurring-ical-events
```

---

## Fetch & Expand Script

```python
import os
import urllib.request
from datetime import date, datetime, timezone
from icalendar import Calendar
import recurring_ical_events

OUTLOOK = os.environ["CAL_OUTLOOK_ICS_URL"]
GOOGLE  = os.environ["CAL_GOOGLE_ICS_URL"]

START = date(2026, 5, 1)   # adjust for next window
END   = date(2026, 6, 30)

NOISE_SUBSTRINGS = [
    "pump", "travel", "bedtime routine", "milk is roofied",
    "last call for food", "start bedtime routine", "give cookie her meds",
    "work calls",       # generic [mark] work calls
    "call (during nap", # [mark] call (during nap MW)
]

def is_noise(summary):
    s = summary.lower()
    return any(n in s for n in NOISE_SUBSTRINGS)

def get_dt(component):
    ds = component.get("DTSTART")
    if not ds: return None
    dt = ds.dt
    if isinstance(dt, datetime):
        dt = dt.astimezone(timezone.utc).date()
    return dt

def fetch(label, url):
    with urllib.request.urlopen(url) as r:
        cal = Calendar.from_ical(r.read())
    events = recurring_ical_events.of(cal).between(START, END)
    results = []
    for c in events:
        summary = str(c.get("SUMMARY", "(no title)"))
        if is_noise(summary): continue
        dt = get_dt(c)
        if not dt: continue
        rrule = c.get("RRULE")
        results.append((dt, summary, rrule is not None))
    results.sort(key=lambda x: x[0])
    print(f"\n=== {label} ===")
    for d, s, r in results:
        print(f"  {d}  {'[R]' if r else '   '}  {s}")

fetch("Outlook (IIT)", OUTLOOK)
fetch("Google (personal)", GOOGLE)
```

---

## Categorization Rules

After reviewing output, events are sorted into:

### Recurring weekly → `mm-minzoom: 5`
- Any event appearing weekly on a consistent day of the week
- Tags: `[work, recurring]` or `[family, recurring]`
- Create one file **per occurrence** in the window (no native recurring support in mm plugin)
- Include only instances on the event's normal day of week; skip anomalous one-off days

### Off-schedule / one-time → `mm-minzoom: 4`
- Tags: `[work, off-schedule]` or `[family, off-schedule]`

### Already done at level 3 (skip):
- Major travel / conferences (Magolds in Michigan, Tommy's graduation, QR Conference,
  Meaningful XR Conference, etc.)

### Noise (skip entirely):
- Daily logistics: pump, bedtime routine, milk prep, travel legs, generic work calls
- Pay Day (monthly, not life-event worthy)

### Tag assignment (work vs family):
- **work**: IIT 1:1s, lab meetings, faculty meetings, conferences, flights for work travel
- **family**: kids' appointments, Jordan's appointments, Cookie, birthdays, social events,
  Evergreen MHS, Fit Shepherds, flights home from work travel

---

## Output File Format

Files go in: `/home/mark/assist/knowledge-base/Creative/Memento Mori/Items/`

```markdown
---
mm: event
mm-date: YYYY-MM-DD
mm-tags:
  - work        # or family
  - recurring   # or off-schedule
mm-title: Event Title
mm-minzoom: 5   # or 4
---
```

Filename convention: `slugified-title-YYYY-MM-DD.md`
(e.g. `shujing-mark-2026-04-15.md`, `gabe-swallow-study-2026-05-05.md`)

---

## What Was Done

**Session: 2026-04-11**  
Window: April 11 – May 31, 2026  
Total files created: 105

Recurring series created (minzoom 5):
- Work: Shujing/Mark (Wed), Yudong/Mark (Wed), Rushad/Mark (Thu), Mark/Nelson (Thu),
  Kaiang/Mark (Fri), SSILab Meeting (Fri), Mark and Yishiuan (Fri)
- Family: [ben & gabe] Physical Therapy (Mon), Evergreen MHS (Tue),
  Fit Shepherds (Sat), [jordan] Therapy (Fri, May only)

Off-schedule created (minzoom 4):
- Family: Miller Easter, PCP Doctor, Jordan Therapy Virtual, Telehealth Nutritionist,
  Ben/Gabe Weight Checks, Pointe Pest, Gabe Cranial Tech, Jordan PT, Gabe Swallow Study,
  Cookie nail trim, Jordan OBGYN, four birthdays, Jordan ENT, Jordan Sleep Med
- Work: Rushad/Mark Mon one-off, CS Faculty Meeting ×2, QR Social Events ×3,
  Asawer Intro Defense, UG/GR Advisor Meeting, Strategic Planning Refresh, YYZ/ORD flights

**Next run**: Do the same for June–July 2026. Check whether Outlook feed has
extended beyond May 4 by then (it's a rolling 1-year window).

---

## Reusable script

`calendar_import.py` (in this directory) reimplements the fetch/expand/filter/
classify logic above as a standalone script, so it doesn't depend on an
interactive Claude session each time. Note: it deliberately does **not**
write the mm-plugin-specific frontmatter (`mm-minzoom`, `mm: event`, etc.) —
it writes plain `date` / `title` / `tags` / `source` frontmatter so the
output isn't tied to this Obsidian plugin. Point `--out` at wherever the
target vault/format expects events, and adapt `write_event_file()` if a
different schema is needed.

The original session that did the first real import (2026-04-11, 105 files)
categorized events by hand in conversation with Claude — that transcript
(`14099255-c1b7-4e78-9f48-ff88e4d1782a.jsonl`) has since been rotated/deleted
from `~/.claude/projects/`, so `calendar_import.py`'s `WORK_KEYWORDS` /
`FAMILY_KEYWORDS` / `NOISE_SUBSTRINGS` are reconstructed from the rules
documented above, not extracted verbatim from that run. Treat `--dry-run`
output as a starting point to refine, not ground truth.

```bash
source /home/mark/assist/.venv/bin/activate
uv pip install --python /home/mark/assist/.venv/bin/python icalendar recurring-ical-events

source ~/.config/trunky-ecs.env   # secret feed URLs, never committed
export CAL_OUTLOOK_ICS_URL="$OUTLOOK_ICS_URL"
export CAL_GOOGLE_ICS_URL="$GOOGLE_ICS_URL"

python3 calendar_import.py --start 2026-05-01 --end 2026-06-30 --dry-run
python3 calendar_import.py --start 2026-05-01 --end 2026-06-30 --out ./events
```
