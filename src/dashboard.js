/* =========================================================================
   Strength Lab — workout dashboard logic
   ========================================================================= */

(function () {
  'use strict';

  // ---------- Data load ----------
  let DATA = JSON.parse(document.getElementById('workout-data').textContent);
  let SESSIONS = []; // sorted ascending by date
  let EXERCISE_INDEX = {}; // name -> { name, equipment_options[], muscle_group, instances: [{date, sets, sessionIdx}] }

  // Sample markdown data for the "Try with sample data" button. Inlined at build time.
  const SAMPLE_MD_NODE = document.getElementById('sample-md');
  const SAMPLE_MD = SAMPLE_MD_NODE ? SAMPLE_MD_NODE.textContent : '';
  function hasData() { return SESSIONS && SESSIONS.length > 0; }

  function indexData() {
    SESSIONS = (DATA.sessions || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    EXERCISE_INDEX = {};
    SESSIONS.forEach((s, sidx) => {
      s.exercises.forEach((ex) => {
        if (!EXERCISE_INDEX[ex.name]) {
          EXERCISE_INDEX[ex.name] = {
            name: ex.name,
            muscle_group: ex.muscle_group,
            equipment_options: new Set(),
            instances: [],
          };
        }
        EXERCISE_INDEX[ex.name].equipment_options.add(ex.equipment || '—');
        EXERCISE_INDEX[ex.name].instances.push({
          date: s.date,
          sessionIdx: sidx,
          sets: ex.sets,
          notes: ex.notes || [],
        });
      });
    });
    // Convert sets to arrays for stable ordering
    Object.values(EXERCISE_INDEX).forEach((ex) => {
      ex.equipment_options = [...ex.equipment_options];
      ex.instances.sort((a, b) => a.date.localeCompare(b.date));
    });
  }

  // ---------- Numerics ----------
  function epley(w, r) {
    if (!r || r <= 0) return 0;
    if (r === 1) return w;
    return w * (1 + r / 30);
  }
  function fmt(n, digits) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString(undefined, {
      maximumFractionDigits: digits == null ? 0 : digits,
    });
  }
  function dayDiff(aISO, bISO) {
    return Math.round((new Date(bISO) - new Date(aISO)) / 86400000);
  }
  function isoWeek(dateISO) {
    const d = new Date(dateISO + 'T00:00:00');
    // Monday-anchored ISO week
    const dn = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dn + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week =
      1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  function weekStart(dateISO) {
    // Monday-anchored
    const d = new Date(dateISO + 'T00:00:00');
    const dn = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dn);
    return d.toISOString().slice(0, 10);
  }
  function pretty(dateISO) {
    return new Date(dateISO + 'T00:00:00').toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  function shortDate(dateISO) {
    return new Date(dateISO + 'T00:00:00').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }

  // ---------- Aggregations ----------
  function totalVolume(sets) {
    let v = 0;
    for (const s of sets) {
      if (s.type === 'weighted') v += (s.weight || 0) * (s.reps || 0);
    }
    return v;
  }
  function bestE1rm(sets) {
    let best = 0;
    for (const s of sets) if (s.type === 'weighted' && s.e1rm > best) best = s.e1rm;
    return best;
  }
  function bestRawWeight(sets) {
    let best = 0;
    for (const s of sets) if (s.type === 'weighted' && s.weight > best) best = s.weight;
    return best;
  }
  function topSet(sets) {
    let top = null;
    for (const s of sets)
      if (s.type === 'weighted' && (top === null || s.e1rm > top.e1rm)) top = s;
    return top;
  }
  function setsByMuscle(sessions) {
    const m = {};
    for (const s of sessions) {
      for (const ex of s.exercises) {
        const mg = ex.muscle_group || 'Other';
        let working = 0;
        for (const st of ex.sets) if (!st.warmup) working++;
        m[mg] = (m[mg] || 0) + working;
      }
    }
    return m;
  }
  function withinDays(dateISO, days) {
    const today = new Date(); today.setHours(0,0,0,0);
    const d = new Date(dateISO + 'T00:00:00');
    return (today - d) / 86400000 <= days;
  }

  // ---------- PR detection ----------
  // For each exercise, find first occurrence of: max e1RM, max raw weight, max reps@weight bucket.
  function detectPRs() {
    const prs = []; // { date, exercise, type, value, set }
    for (const ex of Object.values(EXERCISE_INDEX)) {
      let bestE = 0;
      let bestW = 0;
      const repsAtWeight = {}; // weight -> max reps seen so far
      for (const inst of ex.instances) {
        for (const set of inst.sets) {
          if (set.type !== 'weighted') continue;
          if (set.warmup) continue;
          if (set.e1rm > bestE + 0.01) {
            prs.push({ date: inst.date, exercise: ex.name, type: 'e1RM', value: set.e1rm, set });
            bestE = set.e1rm;
          }
          if (set.weight > bestW + 0.01) {
            prs.push({ date: inst.date, exercise: ex.name, type: 'top weight', value: set.weight, set });
            bestW = set.weight;
          }
          const prev = repsAtWeight[set.weight] || 0;
          if (set.reps > prev) repsAtWeight[set.weight] = set.reps;
        }
      }
    }
    prs.sort((a, b) => b.date.localeCompare(a.date));
    return prs;
  }

  // ---------- Forecast model ----------
  // Approach:
  //   1. Take ALL working (non-warmup) weighted sets for an exercise, compute per-session best e1RM.
  //   2. Fit y = a + b * ln(t + 1)  via least squares  (t in weeks since first session).
  //   3. Estimate fit "fitness" via RMSE.
  //   4. Compute observed weekly slope on most recent ~12 weeks.
  //   5. Project 3, 6, 12 months out using the log curve, but apply
  //      diminishing-returns by attenuating the log-slope by a factor that
  //      grows with training-age.
  //   6. Bound scenarios:
  //         conservative = projection * (1 - 0.5 * sigma)
  //         realistic    = projection
  //         optimistic   = projection * (1 + 0.5 * sigma)
  //     where sigma is the residual std.
  function fitLogCurve(points) {
    // points: [{t, y}]
    if (points.length < 4) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    const n = points.length;
    for (const p of points) {
      const x = Math.log(p.t + 1);
      sx += x; sy += p.y; sxx += x * x; sxy += x * p.y;
    }
    const meanX = sx / n;
    const meanY = sy / n;
    const denom = sxx - n * meanX * meanX;
    if (Math.abs(denom) < 1e-9) return null;
    const b = (sxy - n * meanX * meanY) / denom;
    const a = meanY - b * meanX;
    let ss = 0;
    for (const p of points) {
      const yhat = a + b * Math.log(p.t + 1);
      ss += (p.y - yhat) ** 2;
    }
    const rmse = Math.sqrt(ss / n);
    return { a, b, rmse, n };
  }

  function classifyTrainingAge(weeks) {
    if (weeks < 26) return { label: 'Novice / re-comp', factor: 1.0 };
    if (weeks < 78) return { label: 'Early intermediate', factor: 0.85 };
    if (weeks < 156) return { label: 'Intermediate', factor: 0.70 };
    return { label: 'Advanced', factor: 0.55 };
  }

  function forecastExercise(name) {
    const ex = EXERCISE_INDEX[name];
    if (!ex) return null;
    // Best e1RM per session, in chronological order
    const points = [];
    let firstDate = null;
    for (const inst of ex.instances) {
      const e = bestE1rm(inst.sets);
      if (e > 0) {
        if (!firstDate) firstDate = inst.date;
        const t = dayDiff(firstDate, inst.date) / 7; // weeks since first session of this exercise
        points.push({ t, y: e, date: inst.date });
      }
    }
    if (points.length < 4) return { points, curve: null, projections: null, message: 'Need at least 4 sessions of data' };

    const fit = fitLogCurve(points);
    const lastT = points[points.length - 1].t;
    const lastY = points[points.length - 1].y;
    const trainingAge = classifyTrainingAge(lastT);

    // Diminishing-returns slope adjustment: compress future log-slope
    const dampedB = fit.b * trainingAge.factor;

    function predictAt(deltaWeeks) {
      const t = lastT + deltaWeeks;
      // Use damped slope from current point: y = lastY + dampedB * (ln(t+1) - ln(lastT+1))
      return lastY + dampedB * (Math.log(t + 1) - Math.log(lastT + 1));
    }

    // Sanity floor: projection cannot decrease below current
    function bounded(y) { return Math.max(y, lastY); }

    const horizons = [
      { label: '3 months', weeks: 13 },
      { label: '6 months', weeks: 26 },
      { label: '12 months', weeks: 52 },
    ];
    const sigma = fit.rmse;

    const projections = horizons.map((h) => {
      const realistic = bounded(predictAt(h.weeks));
      const conservative = bounded(realistic - 0.6 * sigma - 0.02 * lastY); // ~2% extra margin
      const optimistic = realistic + 0.6 * sigma + 0.02 * lastY;
      return { ...h, conservative, realistic, optimistic };
    });

    return {
      points,
      fit,
      trainingAge,
      lastY,
      lastT,
      sigma,
      projections,
      message: null,
    };
  }

  // ---------- Routing & rendering ----------
  const app = document.getElementById('app');
  const tabs = document.getElementById('tabs');
  let CHARTS = [];
  function destroyCharts() {
    CHARTS.forEach((c) => { try { c.destroy(); } catch (e) {} });
    CHARTS = [];
  }

  function setActiveTab(view) {
    [...tabs.querySelectorAll('.tab')].forEach((t) =>
      t.classList.toggle('active', t.dataset.view === view)
    );
  }

  let CURRENT = { view: 'overview', params: {} };

  function go(view, params) {
    CURRENT = { view, params: params || {} };
    setActiveTab(view);
    destroyCharts();
    app.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    setTimeout(() => render(), 0);
  }

  function render() {
    // Empty-state guard: if no data is loaded, force the welcome screen
    // (except when the user is intentionally on the import tab).
    if (!hasData() && CURRENT.view !== 'import') {
      renderWelcome();
      updateFooter();
      return;
    }
    switch (CURRENT.view) {
      case 'overview':
        renderOverview(); break;
      case 'history':
        renderHistory(); break;
      case 'exercises':
        renderExercises(); break;
      case 'exercise':
        renderExerciseDetail(CURRENT.params.name); break;
      case 'forecast':
        renderForecast(CURRENT.params.name); break;
      case 'import':
        renderImport(); break;
      case 'welcome':
        renderWelcome(); break;
      default:
        renderOverview();
    }
    updateFooter();
  }

  function updateFooter() {
    const totalSessions = SESSIONS.length;
    const totalSets = SESSIONS.reduce(
      (a, s) => a + s.exercises.reduce((b, ex) => b + ex.sets.length, 0),
      0
    );
    const range = SESSIONS.length
      ? `${SESSIONS[0].date} → ${SESSIONS[SESSIONS.length - 1].date}`
      : '—';
    document.getElementById('footer-stats').textContent =
      `${totalSessions} sessions · ${fmt(totalSets)} sets · ${range}`;
  }

  // ---------- Shared: load workout data (CSV or markdown) ----------
  // Used by Welcome's drop-zone, the "Try sample data" button, and the Import tab.
  function loadMarkdown(text, mode /* 'replace' | 'merge' */, onResult) {
    try {
      const fmt = detectFormat(text);
      const parsed = parseWorkouts(text);
      if (!parsed.sessions.length) {
        const hint = fmt === 'csv'
          ? 'No sessions found. Make sure the file is a Strong CSV export with the header row "Date,Workout Name,Duration,…".'
          : 'No sessions found. For markdown, expect date headers like "Monday, April 27, 2026 at 5:37 AM".';
        return onResult({ ok: false, msg: hint });
      }
      if (mode === 'merge' && DATA && DATA.sessions) {
        const merged = {};
        DATA.sessions.forEach((s) => (merged[s.date] = s));
        parsed.sessions.forEach((s) => (merged[s.date] = s));
        DATA = { sessions: Object.values(merged), muscle_map: (DATA && DATA.muscle_map) || {} };
      } else {
        DATA = { sessions: parsed.sessions, muscle_map: (DATA && DATA.muscle_map) || {} };
      }
      indexData();
      onResult({ ok: true, count: parsed.sessions.length });
    } catch (e) {
      onResult({ ok: false, msg: 'Parse error: ' + (e.message || e) });
    }
  }

  function attachDropZone(el, onLoaded) {
    function prevent(e) { e.preventDefault(); e.stopPropagation(); }
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((type) =>
      el.addEventListener(type, prevent)
    );
    ['dragenter', 'dragover'].forEach((type) =>
      el.addEventListener(type, () => el.classList.add('drag-hot'))
    );
    ['dragleave', 'drop'].forEach((type) =>
      el.addEventListener(type, () => el.classList.remove('drag-hot'))
    );
    el.addEventListener('drop', (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => onLoaded(String(reader.result || ''));
      reader.readAsText(file);
    });
  }

  // ---------- View: Welcome ----------
  function renderWelcome() {
    setActiveTab('welcome');
    const sampleAvailable = SAMPLE_MD && SAMPLE_MD.trim().length > 100;
    app.innerHTML = `
      <div class="welcome">
        <div class="welcome-hero">
          <h1>Strength Lab</h1>
          <p class="lede">
            A private dashboard for your <a href="https://www.strong.app" target="_blank" rel="noopener">Strong app</a> training history —
            with progression charts, PR detection, and 3 / 6 / 12-month forecasts grounded in physiology.
          </p>
          <p class="reassure">
            Your data <strong>never leaves your browser</strong>. No accounts, no cookies, no servers.
            Refresh the page and it's gone.
          </p>
        </div>

        <div class="welcome-actions">
          <div class="dropzone" id="welcome-drop">
            <div class="dz-emoji">▲</div>
            <div class="dz-title">Drop your Strong CSV export here</div>
            <div class="dz-sub">…or click to upload — accepts .csv, .md, or .txt</div>
            <input type="file" id="welcome-file" accept=".csv,.md,.txt,text/csv,text/plain,text/markdown" hidden />
          </div>
          ${sampleAvailable
            ? `<div class="welcome-or">or</div>
               <button class="btn btn-large" id="load-sample">Try with sample data →</button>`
            : ''}
        </div>

        <div class="welcome-features grid cols-3">
          <div class="feature">
            <h3>Progression charts</h3>
            <p>Per-exercise e1RM, top working weight, volume, and set count over time.</p>
          </div>
          <div class="feature">
            <h3>PR detection</h3>
            <p>Auto-flag every personal record — by weight, reps-at-weight, and Epley-estimated 1RM.</p>
          </div>
          <div class="feature">
            <h3>Honest forecasts</h3>
            <p>Logarithmic curve fits with diminishing-returns adjustments, classified by training age.</p>
          </div>
        </div>

        <div class="welcome-foot">
          How to export from Strong: open the app → <strong>Settings → Export Data → CSV</strong>. Drop the
          resulting <code>strong.csv</code> here. Markdown exports (or sets pasted into a Google Doc) also work.
        </div>
      </div>
    `;

    const drop = document.getElementById('welcome-drop');
    const fileInput = document.getElementById('welcome-file');
    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => onLoaded(String(reader.result || ''));
      reader.readAsText(f);
    });
    attachDropZone(drop, onLoaded);

    function onLoaded(text) {
      loadMarkdown(text, 'replace', (res) => {
        if (res.ok) {
          go('overview');
        } else {
          drop.classList.add('drop-error');
          drop.querySelector('.dz-sub').textContent = res.msg || 'Could not parse file.';
        }
      });
    }

    const sampleBtn = document.getElementById('load-sample');
    if (sampleBtn) {
      sampleBtn.addEventListener('click', () => {
        loadMarkdown(SAMPLE_MD, 'replace', (res) => {
          if (res.ok) go('overview');
        });
      });
    }
  }

  // ---------- View: Overview ----------
  function renderOverview() {
    const totalSessions = SESSIONS.length;
    if (!totalSessions) {
      app.innerHTML = `<div class="empty">No sessions yet. Use the <strong>Import</strong> tab to paste in a Strong app export.</div>`;
      return;
    }
    const firstDate = SESSIONS[0].date;
    const lastDate = SESSIONS[SESSIONS.length - 1].date;
    const totalDays = dayDiff(firstDate, lastDate) + 1;
    const totalVol = SESSIONS.reduce(
      (a, s) => a + s.exercises.reduce((b, ex) => b + totalVolume(ex.sets), 0), 0
    );
    const totalSets = SESSIONS.reduce(
      (a, s) => a + s.exercises.reduce((b, ex) => b + ex.sets.length, 0), 0
    );
    const sessionsPerWeek = (totalSessions / (totalDays / 7)).toFixed(1);

    // Last-30-day stats
    const recent = SESSIONS.filter((s) => withinDays(s.date, 30));
    const recentVol = recent.reduce(
      (a, s) => a + s.exercises.reduce((b, ex) => b + totalVolume(ex.sets), 0), 0
    );
    const muscle30 = setsByMuscle(recent);

    // Streak: longest gap of <=4 days in a row → consecutive workout streak
    let streak = 0, longestStreak = 0;
    let prev = null;
    for (const s of SESSIONS) {
      if (prev && dayDiff(prev, s.date) <= 4) streak++;
      else streak = 1;
      if (streak > longestStreak) longestStreak = streak;
      prev = s.date;
    }

    // PRs (recent)
    const allPRs = detectPRs();
    const recentPRs = allPRs.filter((p) => withinDays(p.date, 30)).slice(0, 6);

    // Weekly volume series
    const weekMap = {};
    for (const s of SESSIONS) {
      const w = weekStart(s.date);
      const v = s.exercises.reduce((b, ex) => b + totalVolume(ex.sets), 0);
      weekMap[w] = (weekMap[w] || 0) + v;
    }
    const weeks = Object.keys(weekMap).sort();
    const recentWeeks = weeks.slice(-16);

    app.innerHTML = `
      <div class="section-head">
        <h1>Overview</h1>
        <span class="sub">${pretty(firstDate)} → ${pretty(lastDate)} · ${fmt(totalDays)} days of training data</span>
      </div>

      <div class="grid cols-4" style="margin-bottom:18px;">
        <div class="panel kpi kpi-accent">
          <div class="label">Total sessions</div>
          <div class="value">${fmt(totalSessions)}</div>
          <div class="delta">${sessionsPerWeek} / week avg</div>
        </div>
        <div class="panel kpi">
          <div class="label">Total volume lifted</div>
          <div class="value">${fmt(totalVol)}<span class="unit">lb</span></div>
          <div class="delta">last 30d: ${fmt(recentVol)} lb</div>
        </div>
        <div class="panel kpi">
          <div class="label">Working sets logged</div>
          <div class="value">${fmt(totalSets)}</div>
          <div class="delta">${fmt(totalSets / totalSessions, 1)} per session</div>
        </div>
        <div class="panel kpi">
          <div class="label">Longest streak</div>
          <div class="value">${longestStreak}</div>
          <div class="delta">consecutive workouts (≤4d apart)</div>
        </div>
      </div>

      <div class="grid cols-2" style="margin-bottom:18px;">
        <div class="panel">
          <h2>Weekly volume — last 16 weeks</h2>
          <div class="chart-wrap"><canvas id="chart-vol"></canvas></div>
        </div>
        <div class="panel">
          <h2>Sets per muscle group — last 30 days</h2>
          <div class="chart-wrap"><canvas id="chart-muscle"></canvas></div>
        </div>
      </div>

      <div class="grid cols-2" style="margin-bottom:18px;">
        <div class="panel">
          <h2>Recent PRs (last 30 days)</h2>
          ${recentPRs.length === 0
            ? '<div class="empty" style="padding:14px;">No PRs in the last 30 days. Plateaus build the foundation for breakthroughs.</div>'
            : `<div class="ex-list">${recentPRs
                .map(
                  (p) => `
                <div class="ex-row" data-jump="${p.exercise}">
                  <div class="ex-row-name">
                    ${p.exercise}
                    <span class="sub">${pretty(p.date)}</span>
                  </div>
                  <div><div class="stat-label">Type</div><div class="stat-value">${p.type}</div></div>
                  <div><div class="stat-label">Value</div><div class="stat-value">${
                    p.type === 'e1RM' ? fmt(p.value, 1) + ' lb' : fmt(p.value) + ' lb'
                  }</div></div>
                  <div><div class="stat-label">Set</div><div class="stat-value">${
                    p.set ? `${fmt(p.set.weight)}×${p.set.reps}` : '—'
                  }</div></div>
                  <div class="trend up">↑ NEW</div>
                </div>`
                )
                .join('')}</div>`
          }
        </div>
        <div class="panel">
          <h2>Activity — last 365 days</h2>
          <div id="heatmap-host"></div>
        </div>
      </div>
    `;

    // Volume chart
    const ctxVol = document.getElementById('chart-vol').getContext('2d');
    CHARTS.push(
      new Chart(ctxVol, {
        type: 'bar',
        data: {
          labels: recentWeeks.map((w) => shortDate(w)),
          datasets: [{
            label: 'Volume (lb)',
            data: recentWeeks.map((w) => weekMap[w] || 0),
            backgroundColor: '#ff7a45',
            borderRadius: 4,
          }],
        },
        options: chartOpts({ y: 'Volume (lb)' }),
      })
    );

    // Muscle group chart
    const ctxM = document.getElementById('chart-muscle').getContext('2d');
    const muscleLabels = Object.keys(muscle30).sort((a, b) => muscle30[b] - muscle30[a]);
    CHARTS.push(
      new Chart(ctxM, {
        type: 'bar',
        data: {
          labels: muscleLabels,
          datasets: [{
            label: 'Working sets',
            data: muscleLabels.map((m) => muscle30[m]),
            backgroundColor: muscleLabels.map(muscleColor),
            borderRadius: 4,
          }],
        },
        options: chartOpts({ y: 'Working sets', horizontal: true }),
      })
    );

    // Heatmap
    renderHeatmap(document.getElementById('heatmap-host'));

    // PR row click → exercise detail
    app.querySelectorAll('.ex-row[data-jump]').forEach((el) => {
      el.addEventListener('click', () => go('exercise', { name: el.dataset.jump }));
    });
  }

  function muscleColor(name) {
    const map = {
      Chest: '#f472b6', Back: '#60a5fa', Shoulders: '#ffb86b',
      Biceps: '#a78bfa', Triceps: '#a78bfa', Forearms: '#a78bfa',
      Legs: '#4ade80', Glutes: '#4ade80', Hamstrings: '#4ade80', Calves: '#4ade80',
      Core: '#ff7a45', Cardio: '#60a5fa', Other: '#6b7384',
    };
    return map[name] || '#6b7384';
  }

  function renderHeatmap(host) {
    if (!SESSIONS.length) return;
    const today = new Date(); today.setHours(0,0,0,0);
    const days = 365;
    const start = new Date(today); start.setDate(start.getDate() - (days - 1));
    // Adjust start to Monday
    const startDow = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - startDow);
    const totalDays = Math.round((today - start) / 86400000) + 1;

    const sessionByDay = {};
    for (const s of SESSIONS) sessionByDay[s.date] = (sessionByDay[s.date] || 0) + 1;

    const grid = document.createElement('div');
    grid.className = 'heatmap';
    grid.style.gridTemplateColumns = `repeat(${Math.ceil(totalDays / 7)}, minmax(8px, 1fr))`;

    // Build column-major (week-by-week)
    const weeks = Math.ceil(totalDays / 7);
    // Each cell positioned by [week, dow]
    const cells = [];
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const dt = new Date(start);
        dt.setDate(dt.getDate() + w * 7 + d);
        if (dt > today) continue;
        const key = dt.toISOString().slice(0, 10);
        const count = sessionByDay[key] || 0;
        cells.push({ w, d, key, count });
      }
    }
    // We need a CSS-grid layout with rows = 7. Switch to row layout via inline styles:
    grid.style.gridTemplateColumns = `repeat(${weeks}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(7, 1fr)`;
    grid.style.gridAutoFlow = 'column';
    grid.innerHTML = '';
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const dt = new Date(start);
        dt.setDate(dt.getDate() + w * 7 + d);
        const cell = document.createElement('div');
        cell.className = 'day';
        if (dt > today || dt < new Date(SESSIONS[0].date + 'T00:00:00')) {
          cell.style.opacity = 0.25;
        } else {
          const key = dt.toISOString().slice(0, 10);
          const count = sessionByDay[key] || 0;
          if (count >= 1) cell.classList.add('l3');
          if (count >= 2) cell.classList.add('l4');
          cell.title = `${pretty(key)} — ${count} session${count !== 1 ? 's' : ''}`;
        }
        grid.appendChild(cell);
      }
    }
    host.innerHTML = '';
    host.appendChild(grid);

    const legend = document.createElement('div');
    legend.className = 'heatmap-legend';
    legend.innerHTML = `
      <span>less</span>
      <span class="swatch" style="background:var(--panel-2);"></span>
      <span class="swatch" style="background:rgba(255,122,69,0.5);"></span>
      <span class="swatch" style="background:var(--accent);"></span>
      <span>more</span>
    `;
    host.appendChild(legend);
  }

  // ---------- View: History ----------
  function renderHistory() {
    const muscleFilter = CURRENT.params.muscle || 'all';
    const search = (CURRENT.params.q || '').trim().toLowerCase();
    const muscles = ['all', ...new Set(Object.values(EXERCISE_INDEX).map((e) => e.muscle_group))];

    app.innerHTML = `
      <div class="section-head">
        <h1>History</h1>
        <span class="sub">${SESSIONS.length} sessions · click a card to expand</span>
      </div>
      <div class="toolbar">
        <input type="search" id="hsearch" placeholder="Search exercise, note, or template…" value="${search.replace(/"/g, '&quot;')}" style="flex:1; min-width: 220px;" />
        <select id="hmuscle">
          ${muscles.map((m) => `<option value="${m}" ${m === muscleFilter ? 'selected' : ''}>${m === 'all' ? 'All muscle groups' : m}</option>`).join('')}
        </select>
      </div>
      <div id="session-list"></div>
    `;

    const list = document.getElementById('session-list');
    const reversed = SESSIONS.slice().reverse();
    const filtered = reversed.filter((s) => {
      const muscles = new Set(s.exercises.map((e) => e.muscle_group));
      if (muscleFilter !== 'all' && !muscles.has(muscleFilter)) return false;
      if (search) {
        const blob = JSON.stringify(s).toLowerCase();
        if (!blob.includes(search)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      list.innerHTML = '<div class="empty">No sessions match those filters.</div>';
    } else {
      const allPRs = detectPRs();
      const prKey = (p) => `${p.date}|${p.exercise}|${p.type}`;
      const prSet = new Set(allPRs.map(prKey));

      list.innerHTML = filtered.map((s) => sessionCardHTML(s, prSet)).join('');
      list.querySelectorAll('.session-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.exercise-pr')) return;
          card.classList.toggle('open');
        });
      });
    }

    document.getElementById('hsearch').addEventListener('input', (e) => {
      CURRENT.params.q = e.target.value;
      // Light debounce
      clearTimeout(window.__hs);
      window.__hs = setTimeout(() => renderHistory(), 200);
    });
    document.getElementById('hmuscle').addEventListener('change', (e) => {
      CURRENT.params.muscle = e.target.value;
      renderHistory();
    });
  }

  function sessionCardHTML(s, prSet) {
    const muscleSet = [...new Set(s.exercises.map((e) => e.muscle_group))];
    const totalSetsCount = s.exercises.reduce((a, ex) => a + ex.sets.length, 0);
    const totalVol = s.exercises.reduce((a, ex) => a + totalVolume(ex.sets), 0);
    return `
      <div class="session-card">
        <div class="session-head">
          <div>
            <div class="session-date">${pretty(s.date)}</div>
            <div class="session-meta">
              ${s.exercises.length} exercises · ${totalSetsCount} sets · ${fmt(totalVol)} lb total
              ${s.template ? ` · <em>${escapeHTML(s.template)}</em>` : ''}
            </div>
          </div>
          <div class="session-tags">
            ${muscleSet.map((m) => `<span class="tag muscle-${m}">${m}</span>`).join('')}
          </div>
        </div>
        <div class="session-body">
          ${s.exercises.map((ex) => {
            const isPR = prSet && prSet.has(`${s.date}|${ex.name}|e1RM`);
            return `
              <div class="exercise-block">
                <div class="exercise-name">
                  <span>${escapeHTML(ex.name)}</span>
                  <span class="exercise-equip">${escapeHTML(ex.equipment || '')}</span>
                  ${isPR ? '<span class="exercise-pr">PR</span>' : ''}
                </div>
                <ul class="set-list">
                  ${ex.sets.map((st) => setPillHTML(st)).join('')}
                </ul>
                ${(ex.notes || []).map((n) => `<div class="exercise-note">${escapeHTML(n)}</div>`).join('')}
              </div>
            `;
          }).join('')}
          ${s.share_link ? `<div class="exercise-note">Strong app: <a href="${s.share_link}" target="_blank" rel="noopener">${s.share_link}</a></div>` : ''}
        </div>
      </div>
    `;
  }

  function setPillHTML(st) {
    let inner;
    if (st.type === 'weighted') {
      inner = `${fmt(st.weight)} lb × <span class="reps">${st.reps}</span>${st.rpe ? ` @${st.rpe}` : ''}`;
    } else if (st.type === 'cardio') {
      const min = Math.floor(st.duration_s / 60);
      const sec = st.duration_s % 60;
      inner = `${st.distance_mi} mi · ${min}:${String(sec).padStart(2, '0')}`;
    } else if (st.type === 'bodyweight') {
      inner = `<span class="reps">${st.reps}</span> reps`;
    } else {
      inner = '?';
    }
    return `<li class="set-pill ${st.warmup ? 'warmup' : ''}">${inner}</li>`;
  }

  // ---------- View: Exercises ----------
  function renderExercises() {
    const exs = Object.values(EXERCISE_INDEX).slice().sort(
      (a, b) => b.instances.length - a.instances.length
    );

    const rows = exs.map((ex) => {
      // Last vs first session: e1RM trend
      const e1rms = ex.instances.map((inst) => bestE1rm(inst.sets)).filter((x) => x > 0);
      const last = e1rms[e1rms.length - 1] || 0;
      const first = e1rms[0] || 0;
      const delta = first > 0 ? ((last - first) / first) * 100 : 0;
      const trendCls = delta > 3 ? 'up' : delta < -3 ? 'down' : 'flat';
      const trendIcon = delta > 3 ? '↑' : delta < -3 ? '↓' : '→';
      const top = ex.instances
        .flatMap((i) => i.sets)
        .filter((s) => s.type === 'weighted' && !s.warmup)
        .reduce((best, s) => (!best || s.e1rm > best.e1rm ? s : best), null);

      return `
        <div class="ex-row" data-name="${escapeHTML(ex.name)}">
          <div class="ex-row-name">
            ${escapeHTML(ex.name)}
            <span class="sub">${ex.equipment_options.join(' · ')} · ${ex.muscle_group}</span>
          </div>
          <div>
            <div class="stat-label">Sessions</div>
            <div class="stat-value">${ex.instances.length}</div>
          </div>
          <div>
            <div class="stat-label">Top set</div>
            <div class="stat-value">${top ? `${fmt(top.weight)} × ${top.reps}` : '—'}</div>
          </div>
          <div>
            <div class="stat-label">Best e1RM</div>
            <div class="stat-value">${last ? fmt(last, 1) + ' lb' : '—'}</div>
          </div>
          <div class="trend ${trendCls}">${trendIcon} ${delta >= 0 ? '+' : ''}${fmt(delta, 1)}%</div>
        </div>
      `;
    }).join('');

    app.innerHTML = `
      <div class="section-head">
        <h1>Exercises</h1>
        <span class="sub">${exs.length} unique exercises</span>
      </div>
      <div class="ex-list">${rows}</div>
    `;
    app.querySelectorAll('.ex-row[data-name]').forEach((el) => {
      el.addEventListener('click', () => go('exercise', { name: el.dataset.name }));
    });
  }

  // ---------- View: Exercise detail ----------
  function renderExerciseDetail(name) {
    const ex = EXERCISE_INDEX[name];
    if (!ex) {
      app.innerHTML = `<div class="empty">Exercise not found.</div>`;
      return;
    }
    const labels = ex.instances.map((i) => i.date);
    const e1Series = ex.instances.map((i) => +bestE1rm(i.sets).toFixed(1) || null);
    const wSeries = ex.instances.map((i) => bestRawWeight(i.sets) || null);
    const volSeries = ex.instances.map((i) => +totalVolume(i.sets).toFixed(0));
    const setCount = ex.instances.map((i) => i.sets.filter((s) => !s.warmup).length);

    const recent = ex.instances.slice(-6).reverse();

    app.innerHTML = `
      <a href="#" class="back-btn" id="back-ex">← All exercises</a>
      <div class="ex-detail-head">
        <div>
          <h1>${escapeHTML(ex.name)}</h1>
          <div class="meta">${ex.equipment_options.join(' · ')} · ${ex.muscle_group} · ${ex.instances.length} sessions</div>
        </div>
        <button class="btn" id="forecast-jump">Forecast 3 / 6 / 12 mo →</button>
      </div>

      <div class="grid cols-2" style="margin-bottom:18px;">
        <div class="panel">
          <h2>Estimated 1-rep max over time</h2>
          <div class="chart-wrap"><canvas id="ex-e1rm"></canvas></div>
        </div>
        <div class="panel">
          <h2>Top working weight per session</h2>
          <div class="chart-wrap"><canvas id="ex-weight"></canvas></div>
        </div>
      </div>

      <div class="grid cols-2" style="margin-bottom:18px;">
        <div class="panel">
          <h2>Volume per session (lb)</h2>
          <div class="chart-wrap"><canvas id="ex-vol"></canvas></div>
        </div>
        <div class="panel">
          <h2>Working sets per session</h2>
          <div class="chart-wrap"><canvas id="ex-sets"></canvas></div>
        </div>
      </div>

      <div class="panel">
        <h2>Last 6 sessions</h2>
        <div class="ex-list">
          ${recent.map((i) => `
            <div class="ex-row">
              <div class="ex-row-name">
                ${pretty(i.date)}
                <span class="sub">${i.sets.length} sets</span>
              </div>
              <div>
                <div class="stat-label">Top set</div>
                <div class="stat-value">${(() => { const t = topSet(i.sets); return t ? `${fmt(t.weight)} × ${t.reps}` : '—'; })()}</div>
              </div>
              <div>
                <div class="stat-label">Volume</div>
                <div class="stat-value">${fmt(totalVolume(i.sets))} lb</div>
              </div>
              <div>
                <div class="stat-label">Best e1RM</div>
                <div class="stat-value">${fmt(bestE1rm(i.sets), 1)} lb</div>
              </div>
              <div></div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    document.getElementById('back-ex').addEventListener('click', (e) => {
      e.preventDefault();
      go('exercises');
    });
    document.getElementById('forecast-jump').addEventListener('click', () => {
      go('forecast', { name });
    });

    const opts = chartOpts({ y: 'lb' });
    CHARTS.push(new Chart(document.getElementById('ex-e1rm'), {
      type: 'line',
      data: {
        labels, datasets: [{
          label: 'Best e1RM',
          data: e1Series,
          borderColor: '#ff7a45',
          backgroundColor: 'rgba(255,122,69,0.15)',
          fill: true,
          tension: 0.25,
          pointRadius: 2.5,
          spanGaps: true,
        }],
      },
      options: opts,
    }));
    CHARTS.push(new Chart(document.getElementById('ex-weight'), {
      type: 'line',
      data: {
        labels, datasets: [{
          label: 'Top working weight',
          data: wSeries, stepped: true,
          borderColor: '#60a5fa',
          backgroundColor: 'rgba(96,165,250,0.15)',
          fill: true,
          pointRadius: 2.5,
          spanGaps: true,
        }],
      },
      options: opts,
    }));
    CHARTS.push(new Chart(document.getElementById('ex-vol'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Volume', data: volSeries, backgroundColor: '#a78bfa', borderRadius: 4 }],
      },
      options: opts,
    }));
    CHARTS.push(new Chart(document.getElementById('ex-sets'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Working sets', data: setCount, backgroundColor: '#4ade80', borderRadius: 4 }],
      },
      options: chartOpts({ y: 'sets' }),
    }));
  }

  // ---------- View: Forecast ----------
  function renderForecast(name) {
    const exs = Object.values(EXERCISE_INDEX)
      .filter((e) => e.instances.some((i) => bestE1rm(i.sets) > 0))
      .sort((a, b) => b.instances.length - a.instances.length);
    if (!name) name = exs[0] ? exs[0].name : null;

    app.innerHTML = `
      <div class="section-head">
        <h1>Forecast</h1>
        <span class="sub">3 / 6 / 12 month projections grounded in physiology</span>
      </div>

      <div class="callout">
        <strong>How this works:</strong> e1RM is computed via the Epley formula
        (<code>weight × (1 + reps/30)</code>), and a logarithmic curve is fit to your
        per-session best e1RM. Future projections apply a diminishing-returns
        multiplier based on your training age (novice → advanced) — modeled on
        published trends from Greg Nuckols, Lyle McDonald, and Mike Israetel.
        Three scenarios (conservative / realistic / optimistic) show a range, not a guarantee.
      </div>

      <div class="toolbar">
        <select id="fselect" style="min-width: 260px;">
          ${exs.map((e) => `<option value="${escapeHTML(e.name)}" ${e.name === name ? 'selected' : ''}>${escapeHTML(e.name)} · ${e.instances.length} sessions</option>`).join('')}
        </select>
      </div>

      <div id="forecast-host"></div>
    `;

    document.getElementById('fselect').addEventListener('change', (e) => {
      go('forecast', { name: e.target.value });
    });

    if (!name) return;
    renderForecastFor(name);
  }

  function renderForecastFor(name) {
    const host = document.getElementById('forecast-host');
    const fc = forecastExercise(name);
    if (!fc || fc.message) {
      host.innerHTML = `<div class="empty">${fc ? fc.message : 'No data.'}</div>`;
      return;
    }
    const { points, fit, trainingAge, lastY, sigma, projections } = fc;

    // Build dataset: historical points + future projection curve
    const histLabels = points.map((p) => p.date);
    const histY = points.map((p) => +p.y.toFixed(1));

    // Project forward in 2-week steps to ~13 months out
    const projLabels = [];
    const projRealistic = [];
    const projConservative = [];
    const projOptimistic = [];
    const lastDate = new Date(points[points.length - 1].date + 'T00:00:00');
    const lastT = points[points.length - 1].t;

    for (let w = 2; w <= 56; w += 2) {
      const dt = new Date(lastDate); dt.setDate(dt.getDate() + w * 7);
      projLabels.push(dt.toISOString().slice(0, 10));
      const dampedB = fit.b * trainingAge.factor;
      const t = lastT + w;
      const y = lastY + dampedB * (Math.log(t + 1) - Math.log(lastT + 1));
      const yReal = Math.max(y, lastY);
      projRealistic.push(+yReal.toFixed(1));
      projConservative.push(+Math.max(yReal - 0.6 * sigma - 0.02 * lastY, lastY).toFixed(1));
      projOptimistic.push(+(yReal + 0.6 * sigma + 0.02 * lastY).toFixed(1));
    }

    const allLabels = histLabels.concat(projLabels);
    const histPad = new Array(projLabels.length).fill(null);
    const projPadStart = new Array(histLabels.length - 1).fill(null);
    // overlap the last historical point with first projection point for continuity
    const overlapY = histY[histY.length - 1];

    host.innerHTML = `
      <div class="forecast-grid">
        ${projections.map((p) => `
          <div class="forecast-card">
            <div class="horizon">${p.label}</div>
            <div class="scenarios">
              <div class="scenario"><span class="lbl">Conservative</span><span class="val">${fmt(p.conservative, 1)} lb</span></div>
              <div class="scenario realistic"><span class="lbl">Realistic</span><span class="val">${fmt(p.realistic, 1)} lb</span></div>
              <div class="scenario"><span class="lbl">Optimistic</span><span class="val">${fmt(p.optimistic, 1)} lb</span></div>
            </div>
            <div class="horizon" style="margin-top:8px;">vs. today: <strong style="color:var(--green)">+${fmt(p.realistic - lastY, 1)} lb</strong> (${fmt(((p.realistic - lastY) / lastY) * 100, 1)}%)</div>
          </div>
        `).join('')}
      </div>

      <div class="panel">
        <h2>${escapeHTML(name)} — historical vs. projected e1RM</h2>
        <div class="chart-wrap tall"><canvas id="fchart"></canvas></div>
      </div>

      <div class="panel" style="margin-top:18px;">
        <h2>Model details</h2>
        <div class="grid cols-3">
          <div>
            <div class="stat-label">Training age (this exercise)</div>
            <div class="stat-value">${trainingAge.label}</div>
            <div class="horizon">${fmt(lastT, 1)} weeks of data</div>
          </div>
          <div>
            <div class="stat-label">Current best e1RM</div>
            <div class="stat-value">${fmt(lastY, 1)} lb</div>
          </div>
          <div>
            <div class="stat-label">Fit quality (RMSE)</div>
            <div class="stat-value">±${fmt(sigma, 1)} lb</div>
            <div class="horizon">log-curve, ${points.length} points</div>
          </div>
        </div>
        <div class="callout" style="margin-top:14px;">
          <strong>Caveats worth holding lightly:</strong> these projections assume
          you keep training with similar frequency, intensity, and recovery quality.
          Real results depend on sleep, protein intake (~1.6 g/kg/day for hypertrophy),
          program design, deloads, and individual genetic ceilings.
          Diminishing returns are real — your first year will always grow faster than your fifth.
          Use these as <em>direction</em>, not destiny.
        </div>
      </div>
    `;

    const projDataSet = projPadStart.concat([overlapY], projRealistic);
    const consDataSet = projPadStart.concat([overlapY], projConservative);
    const optDataSet = projPadStart.concat([overlapY], projOptimistic);
    const histDataSet = histY.concat(histPad);

    CHARTS.push(new Chart(document.getElementById('fchart'), {
      type: 'line',
      data: {
        labels: allLabels,
        datasets: [
          {
            label: 'Historical e1RM',
            data: histDataSet,
            borderColor: '#ff7a45',
            backgroundColor: 'rgba(255,122,69,0.15)',
            fill: false,
            pointRadius: 2.5,
            tension: 0.2,
          },
          {
            label: 'Projected (realistic)',
            data: projDataSet,
            borderColor: '#ffb86b',
            borderDash: [6, 4],
            fill: false,
            pointRadius: 0,
          },
          {
            label: 'Optimistic',
            data: optDataSet,
            borderColor: 'rgba(74,222,128,0.55)',
            borderDash: [2, 4],
            fill: '+1',
            backgroundColor: 'rgba(74,222,128,0.08)',
            pointRadius: 0,
          },
          {
            label: 'Conservative',
            data: consDataSet,
            borderColor: 'rgba(96,165,250,0.55)',
            borderDash: [2, 4],
            fill: false,
            pointRadius: 0,
          },
        ],
      },
      options: chartOpts({ y: 'e1RM (lb)', legend: true }),
    }));
  }

  // ---------- View: Import ----------
  function renderImport() {
    const empty = !hasData();
    app.innerHTML = `
      <div class="section-head">
        <h1>Import data</h1>
        <span class="sub">Drop a file, paste data, or load the sample. Auto-detects CSV vs. markdown.</span>
      </div>

      <div class="grid cols-2" style="margin-bottom:18px;">
        <div class="dropzone" id="import-drop">
          <div class="dz-emoji">⬇</div>
          <div class="dz-title">Drop your Strong CSV (or .md) here</div>
          <div class="dz-sub">…or click to choose a .csv / .md / .txt file</div>
          <input type="file" id="import-file" accept=".csv,.md,.txt,text/csv,text/plain,text/markdown" hidden />
        </div>
        <div class="panel">
          <h2>Or paste data</h2>
          <textarea id="paste" placeholder="Paste the contents of strong.csv here — or paste your markdown export. The format is auto-detected."></textarea>
          <div class="import-actions" style="justify-content:flex-start;">
            <button class="btn" id="parse-btn">${empty ? 'Load' : 'Merge'}</button>
            ${empty ? '' : '<button class="btn-ghost" id="replace-btn">Replace all</button>'}
            ${SAMPLE_MD ? '<button class="btn-ghost" id="sample-btn">Load sample data</button>' : ''}
            ${empty ? '' : '<button class="btn-ghost" id="reset-btn" style="margin-left:auto; color:#f87171;">Clear all data</button>'}
          </div>
          <div class="import-result" id="import-msg"></div>
        </div>
      </div>

      <div class="callout">
        <strong>Privacy:</strong> everything happens in your browser. Nothing is uploaded;
        nothing is stored. Refresh the page to start fresh.
      </div>
    `;
    const drop = document.getElementById('import-drop');
    const fileInput = document.getElementById('import-file');
    const ta = document.getElementById('paste');
    const msg = document.getElementById('import-msg');

    function showResult(res, mode) {
      if (res.ok) {
        msg.className = 'import-result ok';
        msg.textContent = `Loaded ${res.count} session${res.count === 1 ? '' : 's'}. Switching to Overview…`;
        setTimeout(() => go('overview'), 500);
      } else {
        msg.className = 'import-result err';
        msg.textContent = res.msg || 'Could not parse file.';
      }
    }

    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => loadMarkdown(String(r.result || ''), 'replace', showResult);
      r.readAsText(f);
    });
    attachDropZone(drop, (text) => loadMarkdown(text, 'replace', showResult));

    document.getElementById('parse-btn').addEventListener('click', () => {
      loadMarkdown(ta.value || '', empty ? 'replace' : 'merge', showResult);
    });
    const replaceBtn = document.getElementById('replace-btn');
    if (replaceBtn) replaceBtn.addEventListener('click', () =>
      loadMarkdown(ta.value || '', 'replace', showResult)
    );
    const sampleBtn = document.getElementById('sample-btn');
    if (sampleBtn) sampleBtn.addEventListener('click', () =>
      loadMarkdown(SAMPLE_MD, 'replace', showResult)
    );
    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      if (!confirm('Clear all loaded workout data?')) return;
      DATA = { sessions: [], muscle_map: (DATA && DATA.muscle_map) || {} };
      indexData();
      go('welcome');
    });
  }

  // ---------- In-browser parser (port of parse_workouts.py) ----------
  const MONTHS_M = { January:1, February:2, March:3, April:4, May:5, June:6, July:7, August:8, September:9, October:10, November:11, December:12 };
  const DAY_HEADER = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;
  const DATE_LINE = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})(?:\s+at\s+(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)))?$/;
  const PROGRAM_LABEL = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\S+/i;
  const EXERCISE_PAREN = /^([A-Za-z][A-Za-z0-9 \-/'’]*?)\s+\(([^)]+)\)$/;
  const EXERCISE_BARE = /^([A-Za-z][A-Za-z0-9 \-/'’]*[A-Za-z0-9'’])$/;
  const SET_PREFIX = /^(?:Set\s+(\d+)|W(\d+)):\s+/i;
  const SET_WEIGHTED = /^(?:Set\s+(\d+)|W(\d+)):\s+(\d+(?:\.\d+)?)\s*lb\s*[×x]\s*(\d+)(?:\s*@\s*(\d+(?:\.\d+)?))?(?:\s*\[?Warm[- ]?up\]?)?$/i;
  const SET_CARDIO = /^(?:Set\s+(\d+)|W(\d+)):\s+(\d+(?:\.\d+)?)\s*mi\s*\|\s*(\d+:\d{2})$/;
  const SET_BODYWEIGHT = /^(?:Set\s+(\d+)|W(\d+)):\s+(\d+)\s+reps$/;
  const NOTES = /^Notes:\s*(.*)$/;
  const URL_LINE = /^(https?:\/\/\S+)$/;
  const URL_MD = /^\[(https?:\/\/[^\]]+)\]\(https?:\/\/[^)]+\)$/;
  const MUSCLE_MAP = {
    'Chest Press':'Chest','Incline Chest Press':'Chest','Pec Deck':'Chest','Cable Crossover':'Chest',
    'Lat Pulldown':'Back','Iso-Lateral Row':'Back','Seated Row':'Back','Bent Over Row':'Back','Shrug':'Back',
    'Shoulder Press':'Shoulders','Lateral Raise':'Shoulders','Reverse Fly':'Shoulders',
    'Bicep Curl':'Biceps','Hammer Curl':'Biceps','Concentration Curl':'Biceps','Reverse Curl':'Biceps',
    'Seated Palms Up Wrist Curl':'Forearms',
    'Triceps Pushdown':'Triceps','Triceps Extension':'Triceps','Tricep Kickbacks':'Triceps','Skullcrusher':'Triceps',
    'Seated Leg Press':'Legs','Leg Extension':'Legs','Seated Leg Curl':'Legs',
    'Glute Kickback':'Glutes','Romanian Deadlift':'Hamstrings','Goblet Squat':'Legs',
    'Seated Calf Raise':'Calves','Crunch':'Core','Running':'Cardio',
  };
  function muscleFor(name) {
    if (MUSCLE_MAP[name]) return MUSCLE_MAP[name];
    const l = name.toLowerCase();
    if (l.includes('row') || l.includes('pulldown')) return 'Back';
    if (l.includes('press') && !l.includes('leg')) return 'Chest';
    if (l.includes('curl') && !l.includes('leg')) return 'Biceps';
    if (l.includes('extension') && !l.includes('leg')) return 'Triceps';
    if (l.includes('raise')) return 'Shoulders';
    if (l.includes('leg') || l.includes('squat') || l.includes('lunge')) return 'Legs';
    return 'Other';
  }
  function epleyJS(w, r) { return r <= 0 ? 0 : (r === 1 ? w : w * (1 + r / 30)); }

  // ---- Strong CSV parser ----
  // Cols: Date, Workout Name, Duration, Exercise Name, Set Order,
  //       Weight, Reps, Distance, Seconds, Notes, Workout Notes, RPE
  function parseCSVLine(line) {
    // Handles quoted fields with commas. Strong escapes embedded quotes by doubling them.
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') { inQ = false; }
        else cur += c;
      } else {
        if (c === ',') { out.push(cur); cur = ''; }
        else if (c === '"') inQ = true;
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  }
  function parseStrongCSV(text) {
    const rows = text.replace(/\r/g, '').split('\n').filter((r) => r.length);
    if (!rows.length) return { sessions: [] };
    const header = parseCSVLine(rows[0]);
    const idx = (name) => header.indexOf(name);
    const I = {
      date: idx('Date'), wname: idx('Workout Name'), dur: idx('Duration'),
      ex: idx('Exercise Name'), so: idx('Set Order'),
      w: idx('Weight'), r: idx('Reps'), d: idx('Distance'), s: idx('Seconds'),
      n: idx('Notes'), wn: idx('Workout Notes'), rpe: idx('RPE'),
    };
    const sessByKey = new Map();
    const order = [];

    function num(v) { const x = parseFloat(v || '0'); return isFinite(x) ? x : 0; }

    for (let r = 1; r < rows.length; r++) {
      const cols = parseCSVLine(rows[r]);
      if (!cols[I.date]) continue;
      const dateIso = cols[I.date].slice(0, 10);
      const time = cols[I.date].length > 10 ? cols[I.date].slice(11) : null;
      const wname = cols[I.wname] || '';
      const key = dateIso + '|' + wname;
      let sess = sessByKey.get(key);
      if (!sess) {
        const dow = (() => {
          try { return new Date(dateIso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }); }
          catch (e) { return ''; }
        })();
        sess = {
          date: dateIso, day_of_week: dow, time, duration: cols[I.dur] || null,
          template: wname || null, exercises: [], share_link: null, notes: [],
          _exIdx: {},
        };
        const wn = (cols[I.wn] || '').trim();
        if (wn) sess.notes.push(wn);
        sessByKey.set(key, sess);
        order.push(sess);
      }
      const exFull = (cols[I.ex] || '').trim();
      const m = exFull.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      const exName = m ? m[1].trim() : exFull;
      const equip = m ? m[2].trim() : 'Bodyweight';
      let ex = sess._exIdx[exName];
      if (!ex) {
        ex = {
          name: exName, equipment: equip, muscle_group: muscleFor(exName),
          sets: [], notes: [],
        };
        sess._exIdx[exName] = ex;
        sess.exercises.push(ex);
      }
      const note = (cols[I.n] || '').trim();
      if (note && !ex.notes.includes(note)) ex.notes.push(note);

      const w = num(cols[I.w]);
      const reps = parseInt(num(cols[I.r])) || 0;
      const dist = num(cols[I.d]);
      const secs = num(cols[I.s]);
      const setN = parseInt(num(cols[I.so])) || (ex.sets.length + 1);
      const rpeVal = cols[I.rpe] ? parseFloat(cols[I.rpe]) : null;

      if (dist > 0 || (w === 0 && reps === 0 && secs > 0)) {
        ex.sets.push({ set: setN, type: 'cardio', distance_mi: dist, duration_s: secs, warmup: false });
      } else if (w > 0) {
        ex.sets.push({
          set: setN, type: 'weighted', weight: w, reps,
          rpe: rpeVal, e1rm: +epleyJS(w, reps).toFixed(1),
          volume: +(w * reps).toFixed(1), warmup: false,
        });
      } else if (reps > 0) {
        ex.sets.push({ set: setN, type: 'bodyweight', reps, e1rm: null, volume: reps, warmup: false });
      }
    }
    // Strip helper indexes, drop empty notes arrays, drop empty sessions
    const out = order
      .filter((s) => s.exercises.some((e) => e.sets.length))
      .map((s) => {
        delete s._exIdx;
        if (!s.notes.length) delete s.notes;
        s.exercises.forEach((e) => { if (!e.notes.length) delete e.notes; });
        return s;
      });
    out.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    return { sessions: out };
  }

  function detectFormat(text) {
    for (const raw of text.split(/\r?\n/)) {
      const s = raw.trim();
      if (!s) continue;
      if (s.startsWith('Date,Workout Name') || s.startsWith('"Date","Workout Name"')) return 'csv';
      return 'markdown';
    }
    return 'markdown';
  }

  // Top-level dispatcher used by the import flow
  function parseWorkouts(text) {
    return detectFormat(text) === 'csv' ? parseStrongCSV(text) : parseMarkdown(text);
  }

  function parseMarkdown(text) {
    const lines = text.split(/\r?\n/).map((l) =>
      l.replace(/\\\+/g, '+').replace(/\\-/g, '-').trimEnd()
    );
    const sessions = [];
    let cur = null;
    let curEx = null;
    function closeEx() { if (curEx && cur) cur.exercises.push(curEx); curEx = null; }
    function closeSess() { closeEx(); if (cur) sessions.push(cur); cur = null; }
    function nextNonblank(i) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      return j < lines.length ? lines[j] : '';
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      let m = line.match(DATE_LINE);
      if (m) {
        closeSess();
        const month = MONTHS_M[m[2]];
        const iso = `${m[4]}-${String(month).padStart(2,'0')}-${String(parseInt(m[3])).padStart(2,'0')}`;
        cur = {
          date: iso, day_of_week: m[1], time: m[5] || null,
          template: null, exercises: [], share_link: null,
        };
        continue;
      }
      if (DAY_HEADER.test(line)) continue;
      if (!cur) continue;

      if (URL_LINE.test(line)) { cur.share_link = line; closeEx(); continue; }
      m = line.match(URL_MD);
      if (m) { cur.share_link = m[1]; closeEx(); continue; }

      m = line.match(NOTES);
      if (m) {
        const note = m[1].trim();
        if (curEx) (curEx.notes ||= []).push(note);
        else (cur.notes ||= []).push(note);
        continue;
      }

      m = line.match(SET_WEIGHTED);
      if (m && curEx) {
        const w = parseFloat(m[3]); const r = parseInt(m[4]);
        const isWarm = !!m[2];
        curEx.sets.push({
          set: parseInt(m[1] || m[2]), type: 'weighted', weight: w, reps: r,
          rpe: m[5] ? parseFloat(m[5]) : null, e1rm: +epleyJS(w,r).toFixed(1),
          volume: +(w*r).toFixed(1), warmup: isWarm,
        });
        continue;
      }
      m = line.match(SET_CARDIO);
      if (m && curEx) {
        const [mins, secs] = m[4].split(':').map(Number);
        curEx.sets.push({
          set: parseInt(m[1] || m[2]), type: 'cardio',
          distance_mi: parseFloat(m[3]), duration_s: mins * 60 + secs, warmup: !!m[2],
        });
        continue;
      }
      m = line.match(SET_BODYWEIGHT);
      if (m && curEx) {
        const r = parseInt(m[3]);
        curEx.sets.push({ set: parseInt(m[1] || m[2]), type: 'bodyweight', reps: r, e1rm: null, volume: r, warmup: !!m[2] });
        continue;
      }

      m = line.match(EXERCISE_PAREN);
      if (m && !PROGRAM_LABEL.test(line)) {
        closeEx();
        curEx = {
          name: m[1].trim(), equipment: m[2].trim(),
          muscle_group: muscleFor(m[1].trim()), sets: [],
        };
        continue;
      }
      m = line.match(EXERCISE_BARE);
      if (m && SET_PREFIX.test(nextNonblank(i))) {
        closeEx();
        curEx = {
          name: m[1].trim(), equipment: 'Bodyweight',
          muscle_group: muscleFor(m[1].trim()), sets: [],
        };
        continue;
      }

      if (!cur.exercises.length && !curEx) {
        cur.template = line.trim();
        continue;
      }
      if (curEx) (curEx.notes ||= []).push(line.trim());
      else (cur.notes ||= []).push(line.trim());
    }
    closeSess();
    const filtered = sessions.filter((s) => s.exercises.some((e) => e.sets.length));
    filtered.sort((a, b) => a.date.localeCompare(b.date));
    return { sessions: filtered };
  }

  // ---------- Chart defaults ----------
  function chartOpts({ y, horizontal, legend } = {}) {
    const text = getCSS('--text');
    const muted = getCSS('--text-2');
    const grid = 'rgba(128,128,128,0.10)';
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      indexAxis: horizontal ? 'y' : 'x',
      plugins: {
        legend: legend ? { labels: { color: text, font: { size: 11 } } } : { display: false },
        tooltip: {
          backgroundColor: 'rgba(20,22,30,0.95)',
          titleColor: text, bodyColor: text, borderColor: muted, borderWidth: 1,
          padding: 10, cornerRadius: 8,
        },
      },
      scales: {
        x: { grid: { color: grid, drawBorder: false }, ticks: { color: muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 } },
        y: { grid: { color: grid, drawBorder: false }, ticks: { color: muted } },
      },
    };
  }
  function getCSS(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  // ---------- Utilities ----------
  function escapeHTML(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------- Boot ----------
  tabs.addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    go(t.dataset.view);
  });

  indexData();
  go(hasData() ? 'overview' : 'welcome');
})();
