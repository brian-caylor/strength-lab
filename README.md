# Strength Lab

A private dashboard for your [Strong app](https://www.strong.app) training history.
Drop in a CSV export (or a markdown export, if you've been pasting into a Google Doc) —
get progression charts, PR detection, weekly volume, and 3 / 6 / 12-month forecasts
grounded in physiology.

> **Privacy first.** Your data never leaves your browser. No accounts, no
> cookies, no servers. Refresh the page and it's gone.

## Live demo

[**strength-lab.netlify.app**](https://strength-lab.netlify.app) *(replace
with your real URL once deployed)*

The live site ships empty. Click **Try with sample data** for a 32-session
demo, or drop in your own Strong-app `.md` export.

## Features

- **Overview** — total sessions, total tonnage, longest streak, weekly volume
  bars, sets-per-muscle-group for the last 30 days, recent PRs, year-long
  activity heatmap.
- **History** — every session expandable, filter by muscle group, full-text
  search, top sets auto-flagged as PRs.
- **Exercises** — every movement ranked by frequency, with trend arrows
  showing percent change in best e1RM since the first session. Drill into
  per-session e1RM curves, top-weight progression, volume, and set count.
- **Forecast** — pick an exercise, see 3 / 6 / 12-month projections in three
  scenarios (conservative / realistic / optimistic). The model fits a
  logarithmic curve to your per-session best e1RM, classifies your training
  age on that movement, and applies diminishing-returns multipliers.
- **Import** — drag-drop a file, paste markdown, or load the sample.

## How it works

### e1RM (estimated 1-rep max)

Computed via the [Epley formula](https://en.wikipedia.org/wiki/One-repetition_maximum):

```
e1RM = weight × (1 + reps / 30)
```

This is the standard form for sets in the 1–10 rep range. It's not exact (no
formula is) but it's the most widely-used baseline for tracking strength
trends across varying rep schemes.

### Forecast model

For each exercise:

1. Pull every working (non-warmup) weighted set from your history.
2. Compute the best e1RM per session.
3. Fit `y = a + b·ln(t + 1)` to those per-session points (`t` in weeks since
   the first session of that exercise).
4. Classify training age based on weeks of data:

   | Weeks of data | Label              | Slope multiplier |
   |---------------|--------------------|------------------|
   | < 26          | Novice / re-comp   | 1.00             |
   | 26 – 78       | Early intermediate | 0.85             |
   | 78 – 156      | Intermediate       | 0.70             |
   | ≥ 156         | Advanced           | 0.55             |

5. Project forward with the damped slope. Three scenarios are computed:

   ```
   realistic    = lastY + b·factor·(ln(t_future+1) − ln(t_now+1))
   conservative = realistic − 0.6σ − 2% · lastY
   optimistic   = realistic + 0.6σ + 2% · lastY
   ```

   where σ is the residual standard deviation of the fit.

These are **estimates**, not predictions. Real progress depends on sleep,
protein intake (~1.6 g/kg/day for hypertrophy), program design, deloads, and
individual variation. Use the projections as direction, not destiny.

The diminishing-returns curve is informed by published trends from
[Greg Nuckols](https://www.strongerbyscience.com/),
[Lyle McDonald](https://bodyrecomposition.com/),
and Mike Israetel's
[Renaissance Periodization](https://renaissanceperiodization.com/) work.

### Muscle-group mapping

A small lookup maps known exercise names to muscle groups
(`Lat Pulldown → Back`, etc.). For names not in the lookup, a heuristic
fallback uses keywords (`row`, `press`, `curl`, `extension`, etc.).

## Project structure

```
strength-lab/
├── index.html              ← built dashboard (committed; serve as-is)
├── build.py                ← one-command rebuild from sources
├── netlify.toml            ← static deploy config + security headers
├── src/
│   ├── dashboard.css
│   ├── dashboard.js
│   └── sample-data.md      ← the synthetic 8-week sample
└── scripts/
    ├── parse_workouts.py   ← standalone CLI parser (md → json)
    └── generate_sample.py  ← regenerate sample-data.md
```

## Building locally

You don't need a build step to *use* the dashboard — open `index.html` in any
browser. The build script is for when you change the source files.

```bash
# Public/empty build (default)
python3 build.py

# Personal build with your own data baked in
python3 scripts/parse_workouts.py "your-export.md" workouts.json
python3 build.py --with-data workouts.json
```

A personal build saves to `index.html` (overwrites the public one) — easy to
revert with `git checkout`.

## Deploying to Netlify

The simplest path:

1. Push this repo to GitHub.
2. In Netlify, **Add new project → Import from Git → GitHub**.
3. Select the repo. Build command: *(leave blank)*. Publish directory: `.`.
4. Deploy.

`netlify.toml` handles publish dir and security headers. A custom subdomain
(e.g. `dashboard.your-site.com`) can be added under **Domain settings**.

## Importing your Strong app history

### Primary: Strong CSV export

Open the Strong app → **Settings → Export Data → CSV**. Drop the resulting
`strong.csv` file into the dashboard's drop zone. The expected schema
(stable across recent Strong versions):

```
Date, Workout Name, Duration, Exercise Name, Set Order,
Weight, Reps, Distance, Seconds, Notes, Workout Notes, RPE
```

One row per set. The parser groups rows by `(Date, Workout Name)` into
sessions, splits `Exercise Name` into name + equipment (e.g.
`Bicep Curl (Machine)` → `Bicep Curl` / `Machine`), and classifies each
set as **weighted**, **cardio** (when `Distance > 0`), or **bodyweight**
(when `Reps > 0` and `Weight = 0`).

### Supporting: markdown export

If you've been pasting Strong sets into a Google Doc and exporting as
`.md`, that still works. Format detection is automatic — you don't need
to tell the dashboard which one you're dropping in.

The markdown parser handles:

- Cardio sets (`Set 1: 1.8 mi | 0:25`)
- Bodyweight sets (`Set 1: 16 reps`)
- Warmup sets (`W1: 85 lb × 10` or `Set 1: 85 lb × 10 [Warmup]`)
- RPE notation (`Set 3: 265 lb × 15 @ 10`)
- Markdown-wrapped URLs

## License

MIT. See [LICENSE](./LICENSE).

## Credits

Built with [Chart.js](https://www.chartjs.org/),
[Inter](https://rsms.me/inter/), and a healthy respect for the science of
getting stronger.
