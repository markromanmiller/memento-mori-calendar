#!/usr/bin/env python3
"""
Fetch events from Outlook + Google ICS calendar feeds, expand recurrences,
filter noise, classify (work/family, recurring/off-schedule), and write one
plain-frontmatter Markdown file per event.

This reimplements the logic originally worked out interactively in a Claude
Code session for the Memento Mori Obsidian plugin importer (see
calendar-import-notes.md). The output format here is deliberately generic
(no mm-minzoom / mm plugin fields) — the reusable part is the *interpretation*:
what counts as noise, what counts as work vs. family, and how recurring
events get split into per-occurrence files.

Setup:
    python3 -m venv .venv && source .venv/bin/activate
    pip install icalendar recurring-ical-events

Usage:
    python3 calendar_import.py --start 2026-05-01 --end 2026-06-30 --dry-run
    python3 calendar_import.py --start 2026-05-01 --end 2026-06-30 --out ./events

Calendar URLs are read from environment variables so they never need to be
hardcoded here:
    CAL_OUTLOOK_ICS_URL
    CAL_GOOGLE_ICS_URL
(or pass --outlook-url / --google-url directly)
"""

import argparse
import os
import re
import sys
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

from icalendar import Calendar
import recurring_ical_events

# ---------------------------------------------------------------------------
# Calendar sources
# ---------------------------------------------------------------------------

DEFAULT_OUTLOOK_URL = os.environ.get("CAL_OUTLOOK_ICS_URL", "")
DEFAULT_GOOGLE_URL = os.environ.get("CAL_GOOGLE_ICS_URL", "")

# ---------------------------------------------------------------------------
# Interpretation rules (the part worth carrying between machines)
# ---------------------------------------------------------------------------

# Substrings (case-insensitive) that mean "skip this event entirely" —
# recurring daily logistics that aren't life-event worthy.
NOISE_SUBSTRINGS = [
    "pump",
    "travel",
    "bedtime routine",
    "milk is roofied",
    "last call for food",
    "start bedtime routine",
    "give cookie her meds",
    "work calls",
    "call (during nap",
    "pay day",
]

# Keyword -> tag hints, checked against the lowercased summary. First match
# wins. These are *defaults* distilled from a real categorization pass —
# expect to refine them per-person/per-calendar rather than trust blindly.
WORK_KEYWORDS = [
    "1:1", "lab meeting", "faculty meeting", "conference", "defense",
    "advisor meeting", "strategic planning", "ssilab", "flight",
]
FAMILY_KEYWORDS = [
    "therapy", "pt", "doctor", "pediatric", "dentist", "nutritionist",
    "birthday", "cookie", "nail trim", "weight check", "obgyn", "ent",
    "sleep med", "swallow study", "school", "cranial",
]


def classify_tag(summary: str) -> str:
    """Best-effort work/family guess. Always eyeball the dry-run output —
    this is a starting point, not ground truth."""
    s = summary.lower()
    for kw in WORK_KEYWORDS:
        if kw in s:
            return "work"
    for kw in FAMILY_KEYWORDS:
        if kw in s:
            return "family"
    return "unclassified"


def is_noise(summary: str) -> bool:
    s = summary.lower()
    return any(n in s for n in NOISE_SUBSTRINGS)


# ---------------------------------------------------------------------------
# Fetch + expand
# ---------------------------------------------------------------------------


@dataclass
class Event:
    dt: date
    summary: str
    recurring: bool
    source: str
    tag: str = ""


def get_dt(component) -> date | None:
    ds = component.get("DTSTART")
    if not ds:
        return None
    dt = ds.dt
    if isinstance(dt, datetime):
        dt = dt.astimezone(timezone.utc).date()
    return dt


def fetch_events(label: str, url: str, start: date, end: date) -> list[Event]:
    if not url:
        print(f"  (skipping {label}: no URL configured)", file=sys.stderr)
        return []
    with urllib.request.urlopen(url) as r:
        cal = Calendar.from_ical(r.read())
    raw = recurring_ical_events.of(cal).between(start, end)

    events = []
    for c in raw:
        summary = str(c.get("SUMMARY", "(no title)"))
        if is_noise(summary):
            continue
        dt = get_dt(c)
        if not dt:
            continue
        rrule = c.get("RRULE") is not None
        events.append(Event(dt=dt, summary=summary, recurring=rrule, source=label))

    for e in events:
        e.tag = classify_tag(e.summary)

    events.sort(key=lambda e: e.dt)
    return events


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def slugify(text: str) -> str:
    s = text.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def write_event_file(out_dir: Path, e: Event) -> Path:
    schedule = "recurring" if e.recurring else "off-schedule"
    tags = [t for t in (e.tag, schedule) if t and t != "unclassified"]
    fname = f"{slugify(e.summary)}-{e.dt.isoformat()}.md"
    path = out_dir / fname

    lines = ["---"]
    lines.append(f"date: {e.dt.isoformat()}")
    lines.append(f"title: {e.summary}")
    lines.append(f"source: {e.source}")
    if tags:
        lines.append("tags:")
        for t in tags:
            lines.append(f"  - {t}")
    lines.append("---")
    lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def print_report(events: list[Event]) -> None:
    for e in events:
        flag = "[R]" if e.recurring else "   "
        tag = e.tag if e.tag != "unclassified" else "??? "
        print(f"  {e.dt}  {flag}  [{e.source[:2]}] [{tag:10s}]  {e.summary}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="YYYY-MM-DD")
    ap.add_argument("--outlook-url", default=DEFAULT_OUTLOOK_URL)
    ap.add_argument("--google-url", default=DEFAULT_GOOGLE_URL)
    ap.add_argument("--out", default="./events", help="output directory for written files")
    ap.add_argument("--dry-run", action="store_true", help="print classification, don't write files")
    args = ap.parse_args()

    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end)

    all_events: list[Event] = []
    print(f"=== Outlook ===")
    outlook_events = fetch_events("outlook", args.outlook_url, start, end)
    print_report(outlook_events)
    all_events += outlook_events

    print(f"\n=== Google ===")
    google_events = fetch_events("google", args.google_url, start, end)
    print_report(google_events)
    all_events += google_events

    unclassified = [e for e in all_events if e.tag == "unclassified"]
    if unclassified:
        print(f"\n{len(unclassified)} event(s) didn't match a work/family keyword — "
              f"review WORK_KEYWORDS / FAMILY_KEYWORDS or tag manually after writing.",
              file=sys.stderr)

    if args.dry_run:
        print(f"\n(dry run — {len(all_events)} events matched, nothing written)")
        return

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for e in all_events:
        write_event_file(out_dir, e)
    print(f"\nWrote {len(all_events)} files to {out_dir}/")


if __name__ == "__main__":
    main()
