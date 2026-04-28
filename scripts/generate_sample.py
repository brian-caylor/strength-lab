"""
Generate a synthetic but realistic 8-week strength training sample log
in the same Strong-app-export-on-Google-Doc format the parser expects.

The numbers are fictional — designed to look like a typical intermediate
hypertrophy block with mixed compound + isolation work, light progressive
overload, the occasional missed rep, and a few PRs sprinkled in.
"""

from __future__ import annotations

import random
from datetime import date, timedelta
from pathlib import Path

random.seed(7)  # deterministic so the same sample ships every time

# Program template: 4-day split (Mon Upper, Tue Lower, Thu Upper, Fri Lower)
# Each exercise has: starting working weight, rep range, sets, equipment, weekly progression %.

EX_TEMPLATES = {
    "Mon-Upper": [
        ("Shoulder Press", "Machine", 70, (8, 10), 3, 0.012),
        ("Chest Press", "Machine", 120, (8, 10), 4, 0.010),
        ("Lat Pulldown", "Machine", 110, (10, 12), 3, 0.012),
        ("Triceps Pushdown", "Cable - Straight Bar", 95, (10, 12), 3, 0.012),
        ("Bicep Curl", "Machine", 75, (10, 12), 3, 0.014),
        ("Lateral Raise", "Dumbbell", 12.5, (12, 15), 3, 0.010),
    ],
    "Tue-Lower": [
        ("Seated Leg Press", "Machine", 270, (8, 10), 3, 0.015),
        ("Leg Extension", "Machine", 90, (10, 12), 3, 0.012),
        ("Seated Leg Curl", "Machine", 95, (10, 12), 3, 0.012),
        ("Seated Calf Raise", "Machine", 160, (12, 15), 3, 0.010),
        ("Crunch", "Machine", 90, (12, 15), 3, 0.010),
    ],
    "Thu-Upper": [
        ("Incline Chest Press", "Machine", 95, (8, 10), 3, 0.010),
        ("Iso-Lateral Row", "Machine", 90, (10, 12), 3, 0.012),
        ("Pec Deck", "Machine", 60, (12, 15), 3, 0.010),
        ("Bicep Curl", "Dumbbell", 25, (10, 12), 3, 0.010),
        ("Triceps Pushdown", "Cable - Straight Bar", 95, (10, 12), 3, 0.012),
    ],
    "Fri-Lower": [
        ("Seated Leg Press", "Machine", 280, (10, 12), 3, 0.012),
        ("Glute Kickback", "Machine", 50, (12, 15), 4, 0.010),
        ("Leg Extension", "Machine", 90, (12, 15), 3, 0.010),
        ("Seated Leg Curl", "Machine", 95, (12, 15), 3, 0.010),
        ("Seated Calf Raise", "Machine", 170, (12, 15), 3, 0.010),
    ],
}

DAY_FOR_TEMPLATE = {
    "Mon-Upper": ("Monday", 0),
    "Tue-Lower": ("Tuesday", 1),
    "Thu-Upper": ("Thursday", 3),
    "Fri-Lower": ("Friday", 4),
}

NOTES_BANK = {
    "Shoulder Press": ["Felt strong today", "Last set burned out a little"],
    "Chest Press": ["Form felt clean", "Slowed eccentrics on set 3"],
    "Seated Leg Press": ["Full range of motion", "Quads cooked"],
    "Lat Pulldown": ["Squeezed at the bottom", "Slight grip fatigue"],
}


def round_weight(w: float) -> float:
    """Round to nearest 5 lb (for plate-loaded) or 2.5 lb (for dumbbells/machines)."""
    if w < 30:
        return round(w * 2) / 2  # nearest 0.5
    return round(w / 5) * 5


def make_set(weight_target: float, reps_target: int, fatigue_factor: float) -> tuple[float, int]:
    """Pick a weight + rep count near targets with realistic noise."""
    w = round_weight(weight_target)
    # Reps decay with fatigue across sets
    actual_reps = max(reps_target - random.randint(0, 1) - int(fatigue_factor), reps_target - 3)
    return w, actual_reps


def main() -> None:
    start = date(2024, 1, 8)  # a Monday
    weeks = 8

    lines: list[str] = []
    lines.append("Strength training history — sample data\n")

    for w_idx in range(weeks):
        week_start = start + timedelta(weeks=w_idx)
        for tmpl_name, exercises in EX_TEMPLATES.items():
            dow_name, dow_offset = DAY_FOR_TEMPLATE[tmpl_name]
            session_date = week_start + timedelta(days=dow_offset)
            time_str = f"{random.randint(5,7)}:{random.choice(['28','35','42','51'])} AM"
            human_date = session_date.strftime(f"%A, %B {session_date.day}, %Y at {time_str}")

            lines.append(dow_name + "  ")
            lines.append(human_date)
            lines.append("")

            for (name, equip, base_w, rep_range, sets_n, weekly_pct) in exercises:
                # Apply weekly progression
                target_weight = base_w * (1 + weekly_pct * w_idx)
                rep_low, rep_high = rep_range
                target_reps = random.randint(rep_low, rep_high)

                lines.append(f"{name} ({equip})  ")
                for s in range(sets_n):
                    fatigue = s * 0.6
                    actual_w, actual_reps = make_set(target_weight, target_reps, fatigue)
                    suffix = "" if s == sets_n - 1 else "  "
                    weight_str = (
                        f"{int(actual_w)}" if actual_w == int(actual_w) else f"{actual_w}"
                    )
                    lines.append(f"Set {s+1}: {weight_str} lb × {actual_reps}{suffix}")

                # Occasional note
                if random.random() < 0.15 and name in NOTES_BANK:
                    lines.append(f"\nNotes: {random.choice(NOTES_BANK[name])}")
                lines.append("")

            lines.append(f"https://link.strong.app/sample-{w_idx}-{tmpl_name.lower()}")
            lines.append("")

    out = Path("sample-data.md")
    out.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    print(f"wrote {out}  ({len(lines)} lines)")


if __name__ == "__main__":
    main()
