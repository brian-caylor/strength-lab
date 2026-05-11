"""
Strength Lab — one-command build.

Reads sources from ./src/ and produces ./index.html (the public, demo-mode
build with empty initial data and the sample dataset inlined). It can also
produce a trainer handoff build with historical data baked in.

Usage:
  python3 build.py                       # public build (empty data + sample)
  python3 build.py --with-data X         # bake in X (a workouts.json)
  python3 build.py --from-export X       # parse Strong CSV/Markdown, then bake it in
  python3 build.py --from-export X --trainer-export --out trainer-dashboard.html
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from scripts.parse_workouts import parse

ROOT = Path(__file__).parent
SRC = ROOT / "src"
CSS_FILE = SRC / "dashboard.css"
JS_FILE = SRC / "dashboard.js"
SAMPLE_MD = SRC / "sample-data.md"
CHART_FILE = SRC / "vendor" / "chart.umd.js"
OUT = ROOT / "index.html"


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0b0d12" />
  <meta name="description" content="A private dashboard for your Strong-app strength training history. Progression charts, PR detection, and physiology-grounded forecasts. Your data never leaves your browser." />
  <meta property="og:title" content="Strength Lab" />
  <meta property="og:description" content="A private dashboard for your Strong-app strength training history." />
  <title>Strength Lab</title>
  <style>
__CSS__
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="logo">▲</span>
      <div>
        <div class="brand-title">Strength Lab</div>
        <div class="brand-sub">A field guide to your training history</div>
      </div>
    </div>
    <nav class="tabs" id="tabs">
      <button data-view="overview" class="tab active">Overview</button>
      <button data-view="history" class="tab">History</button>
      <button data-view="exercises" class="tab">Exercises</button>
      <button data-view="forecast" class="tab">Forecast</button>
      <button data-view="import" class="tab tab-import">Import</button>
    </nav>
  </header>

  <main id="app"></main>

  <footer class="foot">
    <span id="footer-stats"></span>
    <span class="foot-sep">·</span>
    <span>e1RM via Epley · Forecast: log-fit + diminishing returns</span>
  </footer>

  <script id="workout-data" type="application/json">
__DATA__
  </script>
  <script id="app-config" type="application/json">
__CONFIG__
  </script>
  <script id="sample-md" type="text/markdown">
__SAMPLE_MD__
  </script>

  <script>
__CHART_JS__
  </script>
  <script>
__JS__
  </script>
</body>
</html>
"""


def _resolve_out(path: Path | None) -> Path:
    if path is None:
        return OUT
    return path if path.is_absolute() else ROOT / path


def _safe_script_text(text: str) -> str:
    """Prevent embedded data from closing the surrounding script tag."""
    return text.replace("</", "<\\/")


def _read_data(with_data_path: Path | None, from_export_path: Path | None) -> tuple[str, str | None]:
    if with_data_path and from_export_path:
        raise SystemExit("Use either --with-data or --from-export, not both.")

    if from_export_path:
        data = parse(from_export_path)
        return json.dumps(data, indent=2), from_export_path.name

    if with_data_path:
        data_text = with_data_path.read_text(encoding="utf-8")
        json.loads(data_text)
        return data_text, with_data_path.name

    return json.dumps({"sessions": [], "muscle_map": {}}), None


def build(
    with_data_path: Path | None,
    from_export_path: Path | None,
    trainer_export: bool,
    out_path: Path | None,
) -> None:
    css = CSS_FILE.read_text(encoding="utf-8")
    js = JS_FILE.read_text(encoding="utf-8")
    sample = SAMPLE_MD.read_text(encoding="utf-8") if SAMPLE_MD.exists() else ""
    chart_js = CHART_FILE.read_text(encoding="utf-8")

    if "</script>" in sample:
        raise SystemExit("sample-data.md contains </script>; refusing to inline.")

    data, source_name = _read_data(with_data_path, from_export_path)
    config = {
        "trainer_export": trainer_export,
        "source_name": source_name,
        "generated_at": datetime.now(timezone.utc).isoformat() if (trainer_export or source_name) else None,
        "handoff_note": (
            "Historical archive only. Future live coaching data is tracked in Caliber Strong."
            if trainer_export
            else ""
        ),
    }

    html = (
        HTML_TEMPLATE
        .replace("__CSS__", css)
        .replace("__DATA__", _safe_script_text(data))
        .replace("__CONFIG__", _safe_script_text(json.dumps(config, indent=2)))
        .replace("__SAMPLE_MD__", _safe_script_text(sample))
        .replace("__CHART_JS__", chart_js)
        .replace("__JS__", js)
    )
    out = _resolve_out(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out}  ({len(html):,} chars)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-data", type=Path, default=None,
                    help="Path to a workouts.json to bake in (personal build)")
    ap.add_argument("--from-export", type=Path, default=None,
                    help="Path to a Strong CSV or markdown export to parse and bake in")
    ap.add_argument("--trainer-export", action="store_true",
                    help="Add trainer handoff context and print/PDF affordances")
    ap.add_argument("--out", type=Path, default=None,
                    help="Output HTML path. Relative paths are resolved from the project root.")
    args = ap.parse_args()
    build(args.with_data, args.from_export, args.trainer_export, args.out)
