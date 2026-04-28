"""
Parse Strong app workout history into structured JSON.

Two input formats supported:
  - Strong CSV export (the official, primary format)
  - Markdown — Strong sets copied into a Google Doc and exported (.md/.txt)

Auto-detects format by sniffing the header. Both produce the same JSON
shape so downstream code is format-agnostic.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Regexes
# ---------------------------------------------------------------------------

DATE_LINE_RE = re.compile(
    r"^(?P<dow>Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+"
    r"(?P<month>[A-Z][a-z]+)\s+(?P<day>\d{1,2}),\s+(?P<year>\d{4})"
    r"(?:\s+at\s+(?P<time>\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)))?$"
)

DAY_HEADER_RE = re.compile(r"^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$")

# Exercise header: "Name (Equipment)" — but NOT a program label
EXERCISE_WITH_EQUIP_RE = re.compile(
    r"^(?P<name>[A-Za-z][A-Za-z0-9 \-/'’]*?)\s+\((?P<equip>[^)]+)\)$"
)
# Bare exercise (no parens) — only valid when followed by a Set/W line
EXERCISE_BARE_RE = re.compile(r"^(?P<name>[A-Za-z][A-Za-z0-9 \-/'’]*[A-Za-z0-9'’])$")

# Program labels start with a day-of-week followed by another word
PROGRAM_LABEL_RE = re.compile(
    r"^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\S+",
    re.IGNORECASE,
)

# Set lines (accept "Set N:" or "WN:" warmup notation)
SET_PREFIX = r"(?:Set\s+(?P<n>\d+)|W(?P<wn>\d+))"
SET_WEIGHTED_RE = re.compile(
    rf"^{SET_PREFIX}:\s+(?P<w>\d+(?:\.\d+)?)\s*lb\s*[×x]\s*(?P<r>\d+)"
    r"(?:\s*@\s*(?P<rpe>\d+(?:\.\d+)?))?(?:\s*\[?Warm[- ]?up\]?)?$",
    re.IGNORECASE,
)
SET_CARDIO_RE = re.compile(
    rf"^{SET_PREFIX}:\s+(?P<dist>\d+(?:\.\d+)?)\s*mi\s*\|\s*(?P<time>\d+:\d{{2}})$"
)
SET_BODYWEIGHT_RE = re.compile(rf"^{SET_PREFIX}:\s+(?P<r>\d+)\s+reps$")

# Detect a Set/W line generically (used for lookahead)
SET_LINE_RE = re.compile(rf"^{SET_PREFIX}:", re.IGNORECASE)

NOTES_RE = re.compile(r"^Notes:\s*(?P<text>.*)$")
URL_RE = re.compile(r"^(https?://\S+)$")
# Markdown-wrapped link: [https://...](https://...)
URL_MD_RE = re.compile(r"^\[(https?://[^\]]+)\]\(https?://[^\)]+\)$")

MONTHS = {
    m: i + 1
    for i, m in enumerate(
        [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December",
        ]
    )
}

# ---------------------------------------------------------------------------
# Muscle group mapping
# Curated for the exercises actually present in this dataset.
# ---------------------------------------------------------------------------

MUSCLE_MAP: dict[str, str] = {
    # Chest
    "Chest Press": "Chest",
    "Incline Chest Press": "Chest",
    "Pec Deck": "Chest",
    "Cable Crossover": "Chest",
    # Back
    "Lat Pulldown": "Back",
    "Iso-Lateral Row": "Back",
    "Seated Row": "Back",
    "Bent Over Row": "Back",
    "Shrug": "Back",
    # Shoulders
    "Shoulder Press": "Shoulders",
    "Lateral Raise": "Shoulders",
    "Reverse Fly": "Shoulders",
    # Arms - biceps
    "Bicep Curl": "Biceps",
    "Hammer Curl": "Biceps",
    "Concentration Curl": "Biceps",
    "Reverse Curl": "Biceps",
    "Seated Palms Up Wrist Curl": "Forearms",
    # Arms - triceps
    "Triceps Pushdown": "Triceps",
    "Triceps Extension": "Triceps",
    "Tricep Kickbacks": "Triceps",
    "Skullcrusher": "Triceps",
    # Legs
    "Seated Leg Press": "Legs",
    "Leg Extension": "Legs",
    "Seated Leg Curl": "Legs",
    "Glute Kickback": "Glutes",
    "Romanian Deadlift": "Hamstrings",
    "Goblet Squat": "Legs",
    "Seated Calf Raise": "Calves",
    # Core
    "Crunch": "Core",
    # Cardio
    "Running": "Cardio",
}


def muscle_for(name: str) -> str:
    if name in MUSCLE_MAP:
        return MUSCLE_MAP[name]
    # heuristics
    lower = name.lower()
    if "row" in lower or "pulldown" in lower or "pull" in lower:
        return "Back"
    if "press" in lower and "leg" not in lower:
        return "Chest"
    if "curl" in lower and "leg" not in lower:
        return "Biceps"
    if "extension" in lower and "leg" not in lower:
        return "Triceps"
    if "raise" in lower:
        return "Shoulders"
    if "leg" in lower or "squat" in lower or "lunge" in lower:
        return "Legs"
    return "Other"


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


def clean_line(s: str) -> str:
    # Strip markdown trailing 2-space line breaks and backslash escapes
    s = s.rstrip()
    # Remove markdown escapes for + and -
    s = s.replace(r"\+", "+").replace(r"\-", "-")
    return s


def epley_e1rm(weight: float, reps: int) -> float:
    if reps <= 0:
        return 0.0
    if reps == 1:
        return weight
    return round(weight * (1 + reps / 30.0), 1)


DOW_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def parse_csv_text(text: str) -> dict:
    """Parse the official Strong CSV export.

    Columns (Strong's standard schema):
        Date, Workout Name, Duration, Exercise Name, Set Order,
        Weight, Reps, Distance, Seconds, Notes, Workout Notes, RPE
    """
    reader = csv.DictReader(text.splitlines())
    sessions: list[dict] = []
    by_session: dict[tuple, dict] = {}

    for row in reader:
        date_iso = row["Date"][:10]
        try:
            dow = datetime.fromisoformat(date_iso).strftime("%A")
        except ValueError:
            dow = ""
        time_str = row["Date"][11:] if len(row["Date"]) > 10 else None
        wkey = (date_iso, row.get("Workout Name", "") or "")

        if wkey not in by_session:
            by_session[wkey] = {
                "date": date_iso,
                "day_of_week": dow,
                "time": time_str,
                "duration": row.get("Duration") or None,
                "template": row.get("Workout Name") or None,
                "exercises": [],
                "share_link": None,
                "_ex_index": {},  # name → exercise dict (for grouping)
                "notes": [],
            }
            wn = (row.get("Workout Notes") or "").strip()
            if wn:
                by_session[wkey]["notes"].append(wn)

        sess = by_session[wkey]

        ex_name_full = row.get("Exercise Name", "").strip()
        # Split "Bicep Curl (Machine)" → name + equipment
        m = re.match(r"^(?P<name>.+?)\s*\((?P<equip>[^)]+)\)\s*$", ex_name_full)
        if m:
            ex_name = m.group("name").strip()
            equip = m.group("equip").strip()
        else:
            ex_name = ex_name_full
            equip = "Bodyweight"

        if ex_name not in sess["_ex_index"]:
            ex = {
                "name": ex_name,
                "equipment": equip,
                "muscle_group": muscle_for(ex_name),
                "sets": [],
                "notes": [],
            }
            sess["_ex_index"][ex_name] = ex
            sess["exercises"].append(ex)
        ex = sess["_ex_index"][ex_name]

        # Per-set notes appear on the first row of an exercise; attach to exercise
        n = (row.get("Notes") or "").strip()
        if n and n not in ex["notes"]:
            ex["notes"].append(n)

        # Determine set type
        def _f(key: str) -> float:
            v = row.get(key) or "0"
            try:
                return float(v)
            except ValueError:
                return 0.0

        weight = _f("Weight")
        reps = int(_f("Reps"))
        distance = _f("Distance")
        seconds = _f("Seconds")
        rpe = row.get("RPE") or None
        try:
            set_n = int(_f("Set Order")) or len(ex["sets"]) + 1
        except ValueError:
            set_n = len(ex["sets"]) + 1

        if distance > 0 or (weight == 0 and reps == 0 and seconds > 0):
            ex["sets"].append({
                "set": set_n,
                "type": "cardio",
                "distance_mi": distance,
                "duration_s": int(seconds),
                "warmup": False,
            })
        elif weight > 0:
            ex["sets"].append({
                "set": set_n,
                "type": "weighted",
                "weight": weight,
                "reps": reps,
                "rpe": float(rpe) if rpe else None,
                "e1rm": epley_e1rm(weight, reps),
                "volume": round(weight * reps, 1),
                "warmup": False,
            })
        elif reps > 0:
            ex["sets"].append({
                "set": set_n,
                "type": "bodyweight",
                "reps": reps,
                "e1rm": None,
                "volume": reps,
                "warmup": False,
            })

    # Materialize: drop the helper index, drop empty sessions
    for sess in by_session.values():
        sess.pop("_ex_index", None)
        if not sess["notes"]:
            sess.pop("notes", None)
        for ex in sess["exercises"]:
            if not ex.get("notes"):
                ex.pop("notes", None)

    sessions = [s for s in by_session.values() if any(e["sets"] for e in s["exercises"])]
    sessions.sort(key=lambda s: (s["date"], s.get("time") or ""))
    return {"sessions": sessions, "muscle_map": MUSCLE_MAP}


def parse_markdown_text(text: str) -> dict:
    raw = text.splitlines()
    lines = [clean_line(l) for l in raw]

    sessions: list[dict] = []
    current: dict | None = None
    current_exercise: dict | None = None

    def close_exercise():
        nonlocal current_exercise
        if current_exercise and current is not None:
            current["exercises"].append(current_exercise)
            current_exercise = None

    def close_session():
        nonlocal current, current_exercise
        close_exercise()
        if current is not None:
            sessions.append(current)
            current = None

    def set_n(m):
        return int(m.group("n") or m.group("wn"))

    def is_warmup(m):
        return m.group("wn") is not None

    n = len(lines)

    def next_nonblank(i):
        j = i + 1
        while j < n and not lines[j].strip():
            j += 1
        return lines[j] if j < n else ""

    raw_idx = -1
    while True:
        raw_idx += 1
        if raw_idx >= n:
            break
        line = lines[raw_idx]
        if not line.strip():
            continue

        # 1. Full date line -> start new session
        m = DATE_LINE_RE.match(line)
        if m:
            close_session()
            month = MONTHS[m.group("month")]
            day = int(m.group("day"))
            year = int(m.group("year"))
            iso = f"{year:04d}-{month:02d}-{day:02d}"
            current = {
                "date": iso,
                "day_of_week": m.group("dow"),
                "time": m.group("time"),
                "template": None,
                "exercises": [],
                "share_link": None,
            }
            continue

        # 2. Day-only header (just "Monday") -> precedes a date, ignore
        if DAY_HEADER_RE.match(line):
            continue

        if current is None:
            # Lines before any session — usually a Google Docs heading like the doc title.
            continue

        # 3. Share link URL (plain or markdown-wrapped)
        if URL_RE.match(line):
            current["share_link"] = line
            close_exercise()
            continue
        m = URL_MD_RE.match(line)
        if m:
            current["share_link"] = m.group(1)
            close_exercise()
            continue

        # 4. Notes
        m = NOTES_RE.match(line)
        if m:
            note = m.group("text").strip()
            if current_exercise is not None:
                current_exercise.setdefault("notes", []).append(note)
            else:
                current.setdefault("notes", []).append(note)
            continue

        # 5. Set lines
        m = SET_WEIGHTED_RE.match(line)
        if m and current_exercise is not None:
            w = float(m.group("w"))
            r = int(m.group("r"))
            current_exercise["sets"].append(
                {
                    "set": set_n(m),
                    "type": "weighted",
                    "weight": w,
                    "reps": r,
                    "rpe": float(m.group("rpe")) if m.group("rpe") else None,
                    "e1rm": epley_e1rm(w, r),
                    "volume": round(w * r, 1),
                    "warmup": is_warmup(m),
                }
            )
            continue

        m = SET_CARDIO_RE.match(line)
        if m and current_exercise is not None:
            mins, secs = m.group("time").split(":")
            duration_s = int(mins) * 60 + int(secs)
            current_exercise["sets"].append(
                {
                    "set": set_n(m),
                    "type": "cardio",
                    "distance_mi": float(m.group("dist")),
                    "duration_s": duration_s,
                    "warmup": is_warmup(m),
                }
            )
            continue

        m = SET_BODYWEIGHT_RE.match(line)
        if m and current_exercise is not None:
            r = int(m.group("r"))
            current_exercise["sets"].append(
                {
                    "set": set_n(m),
                    "type": "bodyweight",
                    "reps": r,
                    "e1rm": None,
                    "volume": r,  # reps as volume proxy
                    "warmup": is_warmup(m),
                }
            )
            continue

        # 6. Exercise header WITH equipment in parens
        m = EXERCISE_WITH_EQUIP_RE.match(line)
        if m and not PROGRAM_LABEL_RE.match(line):
            close_exercise()
            name = m.group("name").strip()
            equip = m.group("equip").strip()
            current_exercise = {
                "name": name,
                "equipment": equip,
                "muscle_group": muscle_for(name),
                "sets": [],
            }
            continue

        # 7. Bare exercise (no parens) — only if next non-blank line is a Set line
        m = EXERCISE_BARE_RE.match(line)
        if m and SET_LINE_RE.match(next_nonblank(raw_idx)):
            close_exercise()
            name = m.group("name").strip()
            current_exercise = {
                "name": name,
                "equipment": "Bodyweight",
                "muscle_group": muscle_for(name),
                "sets": [],
            }
            continue

        # 8. If we're at the start of a session (no exercises yet), it's a template label
        if not current["exercises"] and current_exercise is None:
            current["template"] = line.strip()
            continue

        # 9. Free-text comment between exercises -> attach as a note
        if current_exercise is not None:
            current_exercise.setdefault("notes", []).append(line.strip())
        else:
            current.setdefault("notes", []).append(line.strip())

    close_session()

    # Filter sessions that ended up empty (no exercises with sets)
    sessions = [s for s in sessions if any(ex.get("sets") for ex in s["exercises"])]
    sessions.sort(key=lambda s: s["date"])

    return {"sessions": sessions, "muscle_map": MUSCLE_MAP}


def detect_format(text: str) -> str:
    """Return 'csv' or 'markdown' based on the first non-empty line."""
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        # Strong's CSV header is stable across exports
        if s.startswith("Date,Workout Name") or s.startswith('"Date","Workout Name"'):
            return "csv"
        return "markdown"
    return "markdown"


def parse(in_path: Path) -> dict:
    """Auto-detect and parse a Strong CSV or markdown workout history file."""
    text = in_path.read_text(encoding="utf-8")
    fmt = detect_format(text)
    if fmt == "csv":
        return parse_csv_text(text)
    return parse_markdown_text(text)


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: parse_workouts.py <input.csv|.md> <output.json>", file=sys.stderr)
        return 2
    in_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    fmt = detect_format(in_path.read_text(encoding="utf-8"))
    print(f"detected format: {fmt}")
    data = parse(in_path)
    out_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    # Quick stats
    n_sess = len(data["sessions"])
    n_ex = sum(len(s["exercises"]) for s in data["sessions"])
    n_sets = sum(len(ex["sets"]) for s in data["sessions"] for ex in s["exercises"])
    dates = [s["date"] for s in data["sessions"]]
    print(f"sessions: {n_sess}")
    print(f"exercises (instances): {n_ex}")
    print(f"sets: {n_sets}")
    if dates:
        print(f"date range: {dates[0]}  ->  {dates[-1]}")
    n_stray = sum(len(s.get("stray_lines", [])) for s in data["sessions"])
    print(f"stray (unparsed) lines inside sessions: {n_stray}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
