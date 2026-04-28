"""
Strength Lab — one-command build.

Reads sources from ./src/ and produces ./index.html (the public, demo-mode
build with empty initial data and the sample dataset inlined).

Usage:
  python3 build.py                # default: public build (empty data + sample)
  python3 build.py --with-data X  # personal build with X (a workouts.json) baked in
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "src"
CSS_FILE = SRC / "dashboard.css"
JS_FILE = SRC / "dashboard.js"
SAMPLE_MD = SRC / "sample-data.md"
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
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
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
  <script id="sample-md" type="text/markdown">
__SAMPLE_MD__
  </script>

  <script>
__JS__
  </script>
</body>
</html>
"""


def build(with_data_path: Path | None) -> None:
    css = CSS_FILE.read_text(encoding="utf-8")
    js = JS_FILE.read_text(encoding="utf-8")
    sample = SAMPLE_MD.read_text(encoding="utf-8") if SAMPLE_MD.exists() else ""

    if "</script>" in sample:
        raise SystemExit("sample-data.md contains </script>; refusing to inline.")

    if with_data_path:
        data = with_data_path.read_text(encoding="utf-8")
    else:
        data = json.dumps({"sessions": [], "muscle_map": {}})

    html = (
        HTML_TEMPLATE
        .replace("__CSS__", css)
        .replace("__DATA__", data)
        .replace("__SAMPLE_MD__", sample)
        .replace("__JS__", js)
    )
    OUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUT}  ({len(html):,} chars)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-data", type=Path, default=None,
                    help="Path to a workouts.json to bake in (personal build)")
    args = ap.parse_args()
    build(args.with_data)
