/* _biomarkers: single-page app. Hash routes: #/  #/m/<id>  #/labs
 * All personal data lives in localStorage under KEY. Nothing is ever sent anywhere:
 * the only network requests are GETs for the static marker/content JSON files.
 */
(function () {
  'use strict';
  const S = window.BioStats;
  const KEY = 'biomarkers.v1';
  const GROUPS = [
    ['sex_hormones', 'Sex hormones'],
    ['thyroid', 'Thyroid'],
    ['cardiometabolic', 'Cardiometabolic'],
    ['iron', 'Iron'],
    ['liver', 'Liver'],
    ['kidney', 'Kidney'],
    ['vitamins_minerals', 'Vitamins & minerals'],
    ['lipids', 'Lipids'],
    ['other', 'Other'],
  ];
  // Markers listed here come first within their group, in this order; the rest keep index order.
  const MARKER_ORDER = ['testosterone_total', 'testosterone_free', 'shbg', 'dhea_s', 'estradiol', 'progesterone'];
  const C = {
    bg: '#12141a', grid: '#1f232c', text: '#cfd3dc', muted: '#8a909c', accent: '#f7931a',
    male: '#4aa3ff', female: '#ff6fae', good: '#22c55e', warn: '#f5a524', bad: '#ef4444',
  };
  const SEXCOL = { male: C.male, female: C.female };
  const SEXLABEL = { male: 'Men', female: 'Women' };

  // ---------------------------------------------------------------- state
  const app = { markers: [], byId: {}, content: {}, mode: '', route: null, view: {} };

  function loadState() {
    let s;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { s = null; }
    s = s && typeof s === 'object' ? s : {};
    s.profile = s.profile || {};
    s.entries = Array.isArray(s.entries) ? s.entries : [];
    s.prefs = s.prefs || {};
    s.prefs.units = s.prefs.units || {};
    return s;
  }
  let state = loadState();
  function save() {
    localStorage.setItem(KEY, JSON.stringify(state));
    // Ask the browser to exempt this site's storage from automatic eviction (best effort; no prompt in most browsers).
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // ---------------------------------------------------------------- utils
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmt(v) {
    if (v == null || !isFinite(v)) return '–';
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    if (a === 0) return '0';
    return v.toPrecision(2);
  }
  function fmtZ(z) { return isFinite(z) ? (z >= 0 ? '+' : '') + z.toFixed(2) : '–'; }
  function fmtP(p) {
    if (!isFinite(p)) return '–';
    if (p < 1) return 'P' + Math.max(p, 0.01).toFixed(p < 0.1 ? 2 : 1);
    if (p > 99) return 'P' + Math.min(p, 99.99).toFixed(p > 99.9 ? 2 : 1);
    return 'P' + Math.round(p);
  }
  function zClass(z) { if (!isFinite(z)) return ''; const a = Math.abs(z); return a < 1 ? 'z0' : a < 2 ? 'z1' : 'z2'; }
  function zColor(z) { if (!isFinite(z)) return C.muted; const a = Math.abs(z); return a < 1 ? C.good : a < 2 ? C.warn : C.bad; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function groupLabel(g) { if (app.groups && app.groups[g] && app.groups[g].name) return app.groups[g].name; const f = GROUPS.find((x) => x[0] === g); return f ? f[1] : String(g || 'Other').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()); }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function hasPop(m) { return !!(m && m.population !== null && m.sexes && (S.sexStats(m, 'male') || S.sexStats(m, 'female'))); }
  function userSex() { return state.profile.sex === 'female' ? 'female' : state.profile.sex === 'male' ? 'male' : null; }

  // ---------------------------------------------------------------- data loading
  async function getJson(url) {
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }

  async function loadData() {
    const [real, groups] = await Promise.all([getJson('data/markers/index.json'), getJson('content/_groups.json')]);
    app.groups = groups || {};
    const mock = null;
    const list = [];
    const seen = new Set();
    for (const e of real || []) if (e && e.id && !seen.has(e.id)) { seen.add(e.id); list.push({ ...e, _src: 'real' }); }
    for (const e of mock || []) if (e && e.id && !seen.has(e.id)) { seen.add(e.id); list.push({ ...e, _src: 'mock' }); }
    await Promise.all(list.map(async (e) => {
      // Prefer a real file even for mock-indexed markers (a real file may land before the index is updated).
      let doc = await getJson(`data/markers/${e.id}.json`);
      let src = doc ? 'real' : null;
      if (doc && doc.mock) src = 'mock';
      const m = { ...e, ...(doc || {}), _src: src || 'missing' };
      if (!doc) m.population = null;
      m.alt_units = m.alt_units || [];
      applyPopView(m);
      app.byId[m.id] = m;
      app.content[m.id] = await getJson(`content/${m.id}.json`);
    }));
    const order = GROUPS.map((g) => g[0]);
    app.markers = list.map((e) => app.byId[e.id]).sort((a, b) => {
      const ga = order.indexOf(a.group), gb = order.indexOf(b.group);
      const ra = MARKER_ORDER.indexOf(a.id), rb = MARKER_ORDER.indexOf(b.id);
      return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb) || (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
    });
    const nReal = app.markers.filter((m) => m._src === 'real').length;
    const nMock = app.markers.filter((m) => m._src === 'mock').length;
    const nMiss = app.markers.length - nReal - nMock;
    app.mode = `${nReal} real` + (nMock ? `, ${nMock} mock` : '') + (nMiss ? `, ${nMiss} without data` : '');
  }

  // ---------------------------------------------------------------- population view (All NHANES / Untreated)
  // Marker JSONs may carry `variants` {all, untreated, reference?}, each with the same `sexes` schema as the
  // top-level block (which is always the all-participant aggregate). The chosen view is global and persisted
  // in state.prefs.popView; it is applied by swapping m.sexes / m.population_note, so every chart, percentile,
  // z-score and the user's value placement follow it. A marker lacking the chosen view falls back
  // reference -> untreated -> all.
  const POP_ORDER = ['all', 'untreated', 'reference'];
  function popView() { return POP_ORDER.includes(state.prefs.popView) ? state.prefs.popView : 'all'; }
  function variantKey(m, k) {
    const vs = m.variants || {};
    const ok = (x) => x === 'all' || (vs[x] && vs[x].sexes);
    if (k === 'reference' && !ok(k)) k = 'untreated';
    return ok(k) ? k : 'all';
  }
  function applyPopView(m) {
    if (!m._base) m._base = { sexes: m.sexes, population_note: m.population_note, source: m.source, cycles: m.cycles };
    const k = variantKey(m, popView());
    const vr = k === 'all' ? null : m.variants[k];
    m._view = k;
    m.sexes = vr ? vr.sexes : m._base.sexes;
    m.population_note = vr ? vr.population_note : m._base.population_note;
    // a variant may come from a different NHANES sample (e.g. 2011-16 for sex hormones)
    m.source = vr && vr.source ? vr.source : m._base.source;
    m.cycles = vr && vr.cycles ? vr.cycles : m._base.cycles;
  }
  function pctTreated(e) {
    return ['male', 'female'].filter((x) => e && e[x]).map((x) => `${SEXLABEL[x].toLowerCase()} ${e[x].pct_excluded_weighted}%`).join(', ');
  }
  function popTitle(m) {
    const vs = m.variants || {};
    return POP_ORDER.filter((k) => k !== 'all' && vs[k]).map((k) => `${vs[k].label}: ${vs[k].exclusion}.` +
      (vs[k].references && vs[k].references.length ? ' Refs: ' + vs[k].references.join(' | ') : '')).join('\n\n');
  }
  /** Segmented control next to the sex toggle; disabled with an explanation when no variant exists. */
  function popSeg(m) {
    if (m.variants) {
      const keys = POP_ORDER.filter((k) => k === 'all' || (m.variants[k] && m.variants[k].sexes));
      return `<div class="seg" id="popSeg" title="${esc('Which NHANES participants make up the population. ' + popTitle(m))}">${keys.map((k) =>
        `<button data-v="${k}" class="${m._view === k ? 'on' : ''}">${esc(k === 'all' ? 'All NHANES' : m.variants[k].label)}</button>`).join('')}</div>`;
    }
    if (m.variants_unavailable) {
      return `<div class="seg disabled" id="popSeg" title="${esc(m.variants_unavailable)}"><button class="on" disabled>All NHANES</button><button disabled>Untreated</button></div>`;
    }
    return '';
  }
  /** One-paragraph caption: who is excluded and how many, with references. */
  function popCaption(m) {
    if (m.variants_unavailable) return `<div class="popnote">${esc(m.variants_unavailable)}</div>`;
    if (!m.variants) return '';
    const vs = m.variants;
    if (m._view === 'all') {
      const u = vs.untreated;
      return `<div class="popnote"><b>All NHANES participants</b>, including people on treatment${u && u.excluded ? ` (${esc(pctTreated(u.excluded))} of the weighted population${u.separate_sample ? ' in ' + esc(u.source) : ''})` : ''}. Switch to <i>${esc(u ? u.label : 'Untreated')}</i> to exclude them.</div>`;
    }
    const v = vs[m._view];
    const ex = v.excluded || {};
    const counts = ['male', 'female'].filter((x) => ex[x]).map((x) => `${SEXLABEL[x].toLowerCase()} ${ex[x].n_excluded} of ${ex[x].n_total} (${ex[x].pct_excluded_weighted}% weighted), n = ${ex[x].n_total - ex[x].n_excluded} remaining`).join('; ');
    // separate earlier sample: show how much the exclusion itself moved the median
    const meds = v.separate_sample ? ['male', 'female'].filter((x) => ex[x] && ex[x].median_before != null).map((x) =>
      `${SEXLABEL[x].toLowerCase()} ${ex[x].median_before} to ${ex[x].median_after} ${m.unit}`).join('; ') : '';
    const sep = v.separate_sample ? ` <b>Different sample:</b> ${esc(v.source)}, not a subset of the All NHANES view (${esc((m._base.cycles || []).join(', '))}); within it, the exclusion moved the median ${esc(meds)}. Any further gap to the All view reflects the earlier cohort, not the exclusion.` : '';
    return `<div class="popnote"><b>${esc(v.label)} view</b>: ${esc(v.exclusion)}. Excluded ${esc(counts)}.${sep}` +
      (v.references && v.references.length ? srcFold('Basis', `<span class="muted">${v.references.map(esc).join('; ')}.</span>`) : '') + '</div>';
  }

  /** Markers of a group: those with notes first, then the 'extended' ones (no content file). */
  function groupMarkers(g, filter) {
    const ms = app.markers.filter((m) => (m.group || 'other') === g && (!filter || filter(m)));
    return { core: ms.filter((m) => app.content[m.id]), ext: ms.filter((m) => !app.content[m.id]) };
  }
  function groupsPresent() {
    const gs = [];
    for (const m of app.markers) if (!gs.includes(m.group || 'other')) gs.push(m.group || 'other');
    return gs;
  }

  // ---------------------------------------------------------------- per-entry math
  function entriesFor(id) {
    return state.entries.filter((e) => e.marker === id).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  function latest(id) { const es = entriesFor(id); return es.length ? es[es.length - 1] : null; }
  function evalEntry(e, opts) {
    const m = app.byId[e.marker];
    if (!m) return null;
    const sex = (opts && opts.sex) || userSex() || 'male';
    const age = S.ageAt(state.profile.birthYear, e.date);
    const r = S.evaluate(m, e.value, e.unit, { sex, age, ageAdjusted: !!(opts && opts.ageAdjusted) });
    r.age = age; r.sex = sex;
    return r;
  }
  function dispUnit(m) {
    const u = state.prefs.units[m.id];
    return S.markerUnits(m).some((x) => x.unit === u) ? u : m.unit;
  }
  function dispFactor(m) { return S.unitFactor(m, dispUnit(m)) || 1; }

  // ---------------------------------------------------------------- plotly helpers
  const WATERMARK = { text: '_biomarkers', xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, showarrow: false, font: { size: 52, color: 'rgba(255,255,255,0.035)' } };
  function axis(extra) {
    return Object.assign({ gridcolor: C.grid, zerolinecolor: '#2b303b', linecolor: '#2b303b', tickfont: { color: C.muted, size: 11 }, title: { font: { color: C.muted, size: 12 } } }, extra || {});
  }
  function layout(extra) {
    return Object.assign({
      paper_bgcolor: C.bg, plot_bgcolor: C.bg,
      font: { family: getComputedStyle(document.body).fontFamily, color: C.text, size: 12 },
      margin: { l: 60, r: 24, t: 36, b: 48 },
      hovermode: 'x unified',
      hoverlabel: { bgcolor: '#1b1e26', bordercolor: '#333a47', font: { color: '#eee', size: 12 } },
      legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 11, color: C.muted }, bgcolor: 'rgba(0,0,0,0)' },
      showlegend: true,
    }, extra || {});
  }
  const PCONF = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'] };
  function plot(el, traces, lay) {
    if (!el) return;
    lay.annotations = [WATERMARK].concat(lay.annotations || []);
    Plotly.react(el, traces, lay, PCONF);
  }
  function rgba(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
  function purgeAll() { $$('.js-plotly-plot').forEach((el) => { try { Plotly.purge(el); } catch (e) { /* ignore */ } }); }

  /** Histogram of a sex block as a step-area series: % of population per bin. Falls back to a model curve. */
  function distSeries(m, sex, f, override) {
    const s = override || S.sexStats(m, sex);
    const out = { x: [], y: [], cd: [] };
    const h = override ? null : s.histogram;
    if (h && h.edges && h.density && h.edges.length === h.density.length + 1) {
      const e = h.edges, d = h.density;
      for (let i = 0; i < d.length; i++) {
        out.x.push(e[i] * f); out.y.push(d[i] * (e[i + 1] - e[i]) * 100); out.cd.push([fmt(e[i] * f), fmt(e[i + 1] * f)]);
      }
      out.x.push(e[e.length - 1] * f); out.y.push(out.y[out.y.length - 1]); out.cd.push(out.cd[out.cd.length - 1]);
      return out;
    }
    // No histogram: draw the fitted normal / lognormal as 60 bins between P0.5 and P99.5.
    const log = !!m.log_scale && s.log_mean != null;
    const q = (p) => log ? Math.exp(s.log_mean + S.normInv(p) * s.log_sd) : s.mean + S.normInv(p) * s.sd;
    const lo = q(0.005), hi = q(0.995), N = 60;
    const edge = (i) => log ? lo * Math.pow(hi / lo, i / N) : lo + (hi - lo) * i / N;
    for (let i = 0; i < N; i++) {
      const a = edge(i), b = edge(i + 1);
      const za = S.zScore(a, s, log), zb = S.zScore(b, s, log);
      out.x.push(a * f); out.y.push((S.normCdf(zb) - S.normCdf(za)) * 100); out.cd.push([fmt(a * f), fmt(b * f)]);
    }
    out.x.push(edge(N) * f); out.y.push(out.y[N - 1]); out.cd.push(out.cd[N - 1]);
    return out;
  }

  function bandQ(b, k, log) {
    if (b.p && b.p[k] != null) return b.p[k];
    if (log && b.log_mean != null) return Math.exp(b.log_mean + S.normInv(+k / 100) * b.log_sd);
    if (b.mean != null) return b.mean + S.normInv(+k / 100) * b.sd;
    return null;
  }

  // ---------------------------------------------------------------- shell
  function renderSidebar() {
    const filter = ($('#sideFilter').value || '').toLowerCase();
    const cur = app.route && (app.route.page === 'marker' || app.route.page === 'deep') ? app.route.id : null;
    let html = '';
    for (const g of groupsPresent()) {
      const gm = groupMarkers(g, (m) => !filter || (m.name + ' ' + m.id).toLowerCase().includes(filter));
      if (!gm.core.length && !gm.ext.length) continue;
      html += `<div class="side-group"><h4>${esc(groupLabel(g))}</h4>`;
      for (const m of gm.core.concat(gm.ext)) {
        if (m === gm.ext[0]) html += '<div class="side-sub">extended</div>';
        const l = latest(m.id);
        const ev = l ? evalEntry(l) : null;
        const dot = ev && isFinite(ev.z) ? `<span class="dot" style="background:${zColor(ev.z)}" title="z ${fmtZ(ev.z)}"></span>` : l ? `<span class="dot" style="border:1px solid ${C.muted}"></span>` : '';
        const tag = m._src === 'mock' ? ' <span class="badge mock">mock</span>' : !hasPop(m) ? ' <span class="badge nodata">no data</span>' : '';
        html += `<a href="#/m/${esc(m.id)}" class="${cur === m.id ? 'active' : ''}"><span>${esc(m.name)}${tag}</span>${dot}</a>`;
      }
      html += '</div>';
    }
    $('#sideGroups').innerHTML = html;
    $('#dataStatus').innerHTML = 'Your data is saved in this browser on this device only.';
    const p = state.profile;
    $('#profileBadge').innerHTML = (p.sex ? esc(SEXLABEL[p.sex].replace(/en$/, 'an')) : '<a href="#/labs">set sex</a>') + ' · ' +
      (p.birthYear ? 'born ' + esc(p.birthYear) : '<a href="#/labs">set birth year</a>') + ' · ' + state.entries.length + ' values';
    $$('.topnav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (app.route && app.route.page)));
  }

  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/').map(decodeURIComponent);
    if (parts[0] === 'm' && parts[1]) return { page: 'marker', id: parts[1] };
    if (parts[0] === 'd' && parts[1]) return { page: 'deep', id: parts[1] };
    if (parts[0] === 'labs') return { page: 'labs' };
    if (parts[0] === 'dash') return { page: 'dash' };
    return { page: 'home' };
  }

  function render() {
    app.route = parseRoute();
    purgeAll();
    const main = $('#main');
    if (app.route.page === 'marker') renderMarker(main, app.route.id);
    else if (app.route.page === 'deep') renderDeep(main, app.route.id);
    else if (app.route.page === 'dash') renderDash(main);
    else if (app.route.page === 'labs') renderLabs(main);
    else renderHome(main);
    renderSidebar();
    $('#sidebar').classList.remove('open');
  }

  // ---------------------------------------------------------------- home
  function sparkSvg(m) {
    let sex = userSex() || 'male';
    if (hasPop(m) && !S.sexStats(m, sex)) sex = sex === 'male' ? 'female' : 'male';
    if (!hasPop(m) || !S.sexStats(m, sex)) return '<svg viewBox="0 0 100 30" preserveAspectRatio="none"><text x="50" y="18" fill="#555" font-size="7" text-anchor="middle">no population data yet</text></svg>';
    const s = S.sexStats(m, sex);
    const d = distSeries(m, sex, 1);
    const n = d.y.length - 1, ymax = Math.max(...d.y) || 1;
    const X = (i) => (i / n) * 100, Y = (v) => 29 - (v / ymax) * 26;
    // position of a primary-unit value on the bin-index axis
    const pos = (v) => {
      const xs = d.x;
      if (v <= xs[0]) return 0; if (v >= xs[n]) return 100;
      for (let i = 0; i < n; i++) if (v >= xs[i] && v <= xs[i + 1]) {
        const t = m.log_scale && v > 0 ? (Math.log(v) - Math.log(xs[i])) / (Math.log(xs[i + 1]) - Math.log(xs[i])) : (v - xs[i]) / (xs[i + 1] - xs[i]);
        return X(i + t);
      }
      return 50;
    };
    let path = `M0,29`;
    for (let i = 0; i < n; i++) path += ` L${X(i).toFixed(2)},${Y(d.y[i]).toFixed(2)} L${X(i + 1).toFixed(2)},${Y(d.y[i]).toFixed(2)}`;
    path += ' L100,29 Z';
    const p25 = s.percentiles && s.percentiles['25'], p75 = s.percentiles && s.percentiles['75'];
    const iq = p25 != null && p75 != null ? `<rect x="${pos(p25)}" y="0" width="${Math.max(0, pos(p75) - pos(p25))}" height="30" fill="rgba(34,197,94,0.08)"/>` : '';
    const l = latest(m.id);
    let you = '';
    if (l) {
      const x = S.toPrimary(m, l.value, l.unit);
      if (isFinite(x)) you = `<line x1="${pos(x)}" x2="${pos(x)}" y1="0" y2="30" stroke="${C.accent}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
    }
    const col = SEXCOL[sex];
    return `<svg viewBox="0 0 100 30" preserveAspectRatio="none">${iq}<path d="${path}" fill="${rgba(col, 0.25)}" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke"/>${you}</svg>`;
  }

  function card(m) {
    const c = app.content[m.id];
    const l = latest(m.id);
    const ev = l ? evalEntry(l) : null;
    const tag = (m._src === 'mock' ? '<span class="badge mock">mock data</span>' : !hasPop(m) ? '<span class="badge nodata">no pop. data</span>' : '') + (m.approximate ? ' <span class="badge mock">approx.</span>' : '');
    let foot = '<span class="muted">No values yet</span>';
    if (l) {
      const f = dispFactor(m), x = S.toPrimary(m, l.value, l.unit);
      const val = isFinite(x) ? `${fmt(x * f)} ${esc(dispUnit(m))}` : `${esc(l.value)} ${esc(l.unit)} <span class="z2">(unit?)</span>`;
      foot = `<span>You: <b>${val}</b> <span class="muted">${esc(l.date)}</span></span>` +
        (ev && isFinite(ev.z) ? `<span class="zpill ${zClass(ev.z)}">${fmtP(ev.pct)} · z ${fmtZ(ev.z)}</span>` : '');
    }
    return `<a class="card" href="#/m/${esc(m.id)}">
      <div class="card-top"><span class="card-name">${esc(m.name)}</span><span class="card-unit">${esc(dispUnit(m))} ${tag}</span></div>
      ${hasPop(m) && userSex() && !S.sexStats(m, userSex()) ? `<div class="muted" style="font-size:11px">no ${SEXLABEL[userSex()].toLowerCase()} data; showing ${SEXLABEL[userSex() === 'male' ? 'female' : 'male'].toLowerCase()}</div>` : ''}
      <div class="card-sum">${esc(c && c.summary ? c.summary : 'Notes coming soon.')}</div>
      ${sparkSvg(m)}
      <div class="card-foot">${foot}</div></a>`;
  }

  function renderHome(main) {
    const withVals = app.markers.filter((m) => latest(m.id));
    let html = `<h1>Overview</h1><div class="sub">Your lab results, compared with the population: see whether you're typical, high or low for your age and sex.</div>`;
    html += `<div class="panel"><div class="panel-head"><h2>My Z-scores</h2><span class="muted">latest value per marker vs ${userSex() ? SEXLABEL[userSex()].toLowerCase() : 'men (set your sex in My labs)'}</span><span class="spacer"></span>
      <label class="chk"><input type="checkbox" id="zAge" ${app.view.homeAge ? 'checked' : ''}> age-adjusted</label></div>`;
    html += withVals.length ? '<div id="zSummary" class="chart short"></div><div class="chart-note">Green |z|&lt;1, amber 1-2, red &gt;2. Click a dot to open the marker.</div>'
      : '<div class="panel-body"><div class="empty">No values entered yet. <a href="#/labs">Add your labs</a> to see where you sit.</div></div>';
    html += '</div>';
    for (const g of groupsPresent()) {
      const gm = groupMarkers(g);
      const blurb = app.groups[g] && app.groups[g].blurb;
      html += `<h3>${esc(groupLabel(g))}</h3>${blurb ? `<div class="sub">${esc(blurb)}</div>` : ''}<div class="cards">${gm.core.map(card).join('')}</div>`;
      if (gm.ext.length) html += `<div class="subhead">${esc(groupLabel(g))}: extended</div><div class="cards">${gm.ext.map(card).join('')}</div>`;
    }
    main.innerHTML = html;
    $('#zAge').onchange = (e) => { app.view.homeAge = e.target.checked; drawZSummary(withVals); };
    if (withVals.length) drawZSummary(withVals);
  }

  function drawZSummary(ms) {
    const el = $('#zSummary');
    if (!el) return;
    const rows = [];
    for (const m of ms) {
      const l = latest(m.id), ev = evalEntry(l, { ageAdjusted: app.view.homeAge });
      if (!ev || !isFinite(ev.z)) continue;
      const f = dispFactor(m);
      rows.push({ m, l, ev, label: m.name, text: `${fmt(ev.x * f)} ${dispUnit(m)} · ${fmtP(ev.pct)} (model ${fmtP(ev.modelPct)})${ev.band ? ' · ' + ev.band : ''} · ${l.date}` });
    }
    if (!rows.length) { el.outerHTML = '<div class="panel-body"><div class="empty">Your values are for markers without population data, or their units were not recognised.</div></div>'; return; }
    rows.reverse();
    const zmax = Math.max(3, ...rows.map((r) => Math.abs(r.ev.z) + 0.4));
    const shapes = [
      [-1, 1, C.good, 0.10], [1, 2, C.warn, 0.10], [-2, -1, C.warn, 0.10], [2, zmax, C.bad, 0.08], [-zmax, -2, C.bad, 0.08],
    ].map(([a, b, c, o]) => ({ type: 'rect', xref: 'x', yref: 'paper', x0: a, x1: b, y0: 0, y1: 1, fillcolor: rgba(c, o), line: { width: 0 }, layer: 'below' }));
    shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: 0, x1: 0, y0: 0, y1: 1, line: { color: '#555', width: 1, dash: 'dot' } });
    el.style.height = Math.max(200, 70 + rows.length * 30) + 'px';
    plot(el, [{
      type: 'scatter', mode: 'markers', x: rows.map((r) => r.ev.z), y: rows.map((r) => r.label),
      marker: { size: 13, color: rows.map((r) => zColor(r.ev.z)), line: { color: '#000', width: 1 } },
      customdata: rows.map((r) => [r.text, r.m.id]),
      hovertemplate: '<b>%{y}</b><br>z %{x:+.2f}<br>%{customdata[0]}<extra></extra>', name: 'z',
    }], layout({
      hovermode: 'closest', showlegend: false, margin: { l: 200, r: 24, t: 14, b: 40 }, shapes,
      xaxis: axis({ range: [-zmax, zmax], title: { text: 'Z-score', font: { color: C.muted, size: 12 } }, dtick: 1 }),
      yaxis: axis({ automargin: true, gridcolor: '#191c23' }),
    }));
    el.on('plotly_click', (ev) => { const id = ev.points[0].customdata[1]; location.hash = '#/m/' + id; });
  }

  // ---------------------------------------------------------------- marker page
  /** Cohort stats for sex + age selection: 'all' | 'auto' (user's age at `date`) | band label. */
  function cohort(m, sex, ageSel, date) {
    const s = S.sexStats(m, sex);
    if (!s) return null;
    if (ageSel && ageSel !== 'all' && s.by_age && s.by_age.length) {
      let b = null;
      if (ageSel === 'auto') b = S.bandForAge(s.by_age, S.ageAt(state.profile.birthYear, date));
      else b = s.by_age.find((x) => x.band === ageSel);
      if (b && (b.mean != null || b.log_mean != null)) return { stats: b, table: b.p, band: b.band, label: `${SEXLABEL[sex].toLowerCase()} ${b.band}`, s };
    }
    return { stats: s, table: s.percentiles, band: null, label: `${SEXLABEL[sex].toLowerCase()}, all ages`, s };
  }
  function evalCohort(m, x, co) {
    if (!co || !isFinite(x)) return { z: NaN, pct: NaN, modelPct: NaN, method: null };
    const r = S.percentile(x, co.stats, !!m.log_scale, co.table);
    return { z: r.z, pct: r.pct, modelPct: r.model, method: r.method };
  }
  /** ref_range / optimal from content, converted to primary units. kind = 'ref_range' | 'optimal'. */
  function rangeFor(m, kind, sex) {
    const c = app.content[m.id], r = c && c[kind];
    if (!r || !r[sex]) return null;
    const f = S.unitFactor(m, r.unit, { noApprox: true });
    if (f == null) return { bad: true, unit: r.unit, source: r.source };
    const [lo, hi] = r[sex];
    return { lo: lo == null ? null : lo / f, hi: hi == null ? null : hi / f, source: r.source, note: r.note, rationale: r.rationale, unit: r.unit };
  }
  /** Collapsed-by-default disclosure for source/citation text. */
  function srcFold(label, inner, cls) {
    return inner ? `<details class="srcfold${cls ? ' ' + cls : ''}"><summary>${label}</summary><div class="srcfold-body">${inner}</div></details>` : '';
  }
  const RANGE_STYLE = { ref_range: { col: '#9aa4b2', label: 'Lab ref range' }, optimal: { col: '#2dd4bf', label: 'Optimal' } };
  function deepLink(m) {
    const c = app.content[m.id];
    const src = srcFold(m.approximate ? 'Source <b>(approximate)</b>' : 'Source', `${esc(m.source || 'none')}${m.population_note ? ' · ' + esc(m.population_note) : ''}`, 'srcnote' + (m.approximate ? ' approx' : ''));
    return src + `<div class="chart-note">${c && c.summary ? esc(c.summary) + ' ' : ''}${c ? `<a href="#/d/${esc(m.id)}">Deep dive &raquo;</a>` : ''}</div>`;
  }

  function renderMarker(main, id) {
    const m = app.byId[id];
    if (!m) { main.innerHTML = `<div class="empty">Unknown marker "${esc(id)}". <a href="#/">Back to overview</a></div>`; return; }
    const v = app.view[id] = app.view[id] || {};
    const pop = hasPop(m);
    const sexes = ['male', 'female'].filter((s) => S.sexStats(m, s));
    if (!v.sex || !sexes.includes(v.sex)) v.sex = sexes.includes(userSex()) ? userSex() : sexes[0] || 'male';
    if (v.logx == null) v.logx = !!m.log_scale;
    if (!v.ageSel) v.ageSel = state.profile.birthYear ? 'auto' : 'all';
    const units = S.markerUnits(m), du = dispUnit(m);
    const c = app.content[id];
    const s = S.sexStats(m, v.sex);
    const bands = s && s.by_age ? s.by_age.map((b) => b.band) : [];
    const tags = (m._src === 'mock' ? '<span class="badge mock">mock data</span> ' : pop ? '<span class="badge real">NHANES</span> ' : '<span class="badge nodata">no population data yet</span> ') +
      (m.approximate ? '<span class="badge mock">approximate</span>' : '');

    let html = `<h1>${esc(m.name)} ${tags}</h1>
      <div class="sub">${pop ? 'n = ' + sexes.map((x) => `${SEXLABEL[x].toLowerCase()} ${S.sexStats(m, x).n}`).join(', ') : ''}${srcFold('Data source', `${esc(m.source || '')}${m.population_note ? '<br>' + esc(m.population_note) : ''}`)}</div>`;
    if (m.method_note) html += `<div class="why">${esc(m.method_note)}</div>`;
    if (pop && !S.sexStats(m, userSex() || 'male') && userSex()) html += `<div class="why">No ${SEXLABEL[userSex()].toLowerCase()} population data for this marker; showing ${SEXLABEL[v.sex].toLowerCase()} for reference only.</div>`;
    html += `<div class="panel"><div class="panel-head">
      ${pop ? `<div class="seg" id="sexSeg">${sexes.map((x) => `<button data-v="${x}" class="${v.sex === x ? 'on' : ''}">${SEXLABEL[x]}</button>`).join('')}</div>` : ''}
      ${pop ? popSeg(m) : ''}
      ${pop && bands.length ? `<select id="ageSel" title="Age band: applies to histogram, percentile and Z-score">
        <option value="all" ${v.ageSel === 'all' ? 'selected' : ''}>All ages</option>
        ${state.profile.birthYear ? `<option value="auto" ${v.ageSel === 'auto' ? 'selected' : ''}>My age band</option>` : ''}
        ${bands.map((b) => `<option ${v.ageSel === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>` : ''}
      <div class="seg" id="unitSeg">${units.map((u) => `<button data-v="${esc(u.unit)}" class="${u.unit === du ? 'on' : ''}">${esc(u.unit)}</button>`).join('')}</div>
      <span class="spacer"></span>
      <form id="valBox" class="form-row" style="gap:6px" title="Type a value to see where it falls; Save stores it in My labs">
        <input name="value" type="number" step="any" placeholder="your value" style="width:100px" value="${v.trial ? esc(v.trial.value) : ''}">
        <select name="unit">${units.map((u) => `<option ${u.unit === (v.trial ? v.trial.unit : du) ? 'selected' : ''}>${esc(u.unit)}</option>`).join('')}</select>
        <input name="date" type="date" value="${today()}">
        <button class="btn primary">Save</button></form></div>`;
    html += `<div class="panel-body">${pop ? popCaption(m) : ''}<div class="statgrid" id="stats"></div><div id="rangeInfo" class="muted" style="font-size:12px"></div></div></div>`;

    if (pop) {
      html += `<div class="panel"><div class="panel-head"><h2>Percentile bands by age</h2><span class="muted" id="ageSub"></span></div>
        <div id="ageChart" class="chart"></div><div class="chart-note" id="ageNote"></div>${deepLink(m)}</div>`;
      html += `<div class="panel"><div class="panel-head"><h2>Population distribution</h2><span class="muted" id="distSub"></span><span class="spacer"></span>
        <label class="chk"><input type="checkbox" id="both" ${v.both ? 'checked' : ''}> overlay other sex</label>
        <label class="chk"><input type="checkbox" id="logx" ${v.logx ? 'checked' : ''}> log x-axis</label></div>
        <div id="distChart" class="chart"></div>
        <div class="chart-note" id="distNote"></div>${deepLink(m)}</div>`;
      if (m.supplement && m.supplement.sexes) {
        html += `<div class="panel"><div class="panel-head"><h2>Supplementary reference: ${esc(m.supplement.unit || '')}</h2><span class="muted">${esc(m.supplement.source || '')}</span>${m.supplement.approximate ? ' <span class="badge mock">approximate</span>' : ''}</div>
          <div id="suppChart" class="chart short"></div>${srcFold('Citation', `${esc(m.supplement.source || '')}${m.supplement.population_note ? ' · ' + esc(m.supplement.population_note) : ''}`, 'srcnote approx')}<div class="chart-note" id="suppNote"></div></div>`;
      }
      html += `<div class="panel"><div class="panel-head"><h2>My Z-score vs cohort</h2><span class="muted" id="zSub"></span></div>
        <div id="zChart" class="chart short"></div><div class="chart-note" id="zNote"></div>${deepLink(m)}</div>`;
    } else {
      html += `<div class="panel"><div class="panel-body"><div class="empty">No population data yet for this marker. You can still track your own values; they're plotted below.</div></div></div>`;
    }
    html += `<div class="panel"><div class="panel-head"><h2>My history</h2><span class="muted">${esc(du)}</span></div><div id="histChart" class="chart short"></div>${deepLink(m)}</div>`;
    main.innerHTML = html;

    const rerender = () => { purgeAll(); renderMarker(main, id); renderSidebar(); };
    $$('#sexSeg button').forEach((b) => (b.onclick = () => { v.sex = b.dataset.v; rerender(); }));
    $$('#popSeg button:not([disabled])').forEach((b) => (b.onclick = () => {
      state.prefs.popView = b.dataset.v; save();
      app.markers.forEach(applyPopView);
      rerender();
    }));
    $$('#unitSeg button').forEach((b) => (b.onclick = () => { state.prefs.units[id] = b.dataset.v; save(); rerender(); }));
    if ($('#ageSel')) $('#ageSel').onchange = (e) => { v.ageSel = e.target.value; rerender(); };
    const on = (sel, key) => { const el = $(sel); if (el) el.onchange = () => { v[key] = el.checked; rerender(); }; };
    on('#both', 'both'); on('#logx', 'logx');
    const box = $('#valBox');
    const readTrial = () => {
      const val = parseFloat(box.value.value);
      v.trial = isFinite(val) ? { value: val, unit: box.unit.value } : null;
    };
    box.value.oninput = box.unit.onchange = () => { readTrial(); drawMarkerCharts(m, v); };
    box.onsubmit = (e) => {
      e.preventDefault(); readTrial();
      if (!v.trial) return;
      state.entries.push({ uid: uid(), marker: id, value: v.trial.value, unit: v.trial.unit, date: box.date.value || today(), added: new Date().toISOString() });
      v.trial = null; save(); rerender();
    };
    drawMarkerCharts(m, v);
  }

  /** The value to highlight: what's typed in the value box, else the latest saved entry. */
  function currentPoint(m, v) {
    if (v.trial) { const x = S.toPrimary(m, v.trial.value, v.trial.unit); if (isFinite(x)) return { x, date: today(), trial: true }; }
    const l = latest(m.id);
    if (l) { const x = S.toPrimary(m, l.value, l.unit); if (isFinite(x)) return { x, date: l.date, trial: false }; }
    return null;
  }

  function drawMarkerCharts(m, v) {
    const es = entriesFor(m.id);
    const f = dispFactor(m), du = dispUnit(m);
    const cur = currentPoint(m, v);
    const pop = hasPop(m);
    const co = pop ? cohort(m, v.sex, v.ageSel, cur ? cur.date : today()) : null;
    // stats boxes
    const stats = [];
    if (cur) {
      const r = evalCohort(m, cur.x, co);
      stats.push([cur.trial ? 'Typed value' : 'Your latest', `${fmt(cur.x * f)} <small>${esc(du)}</small>`, cur.trial ? 'not saved' : cur.date]);
      if (co) {
        stats.push(['Percentile', `<span class="${zClass(r.z)}">${fmtP(r.pct)}</span>`, (r.method === 'empirical' ? 'empirical table' : 'normal tail') + ' · ' + co.label]);
        stats.push(['Model percentile', fmtP(r.modelPct), 'normal CDF of z']);
        stats.push(['Z-score', `<span class="${zClass(r.z)}">${fmtZ(r.z)}</span>`, co.label + (m.log_scale ? ' · ln scale' : '')]);
      }
      for (const kind of ['ref_range', 'optimal']) {
        const rg = rangeFor(m, kind, userSex() || v.sex);
        if (rg && !rg.bad) {
          const inside = (rg.lo == null || cur.x >= rg.lo) && (rg.hi == null || cur.x <= rg.hi);
          stats.push([RANGE_STYLE[kind].label, `<span class="${inside ? 'z0' : 'z1'}">${inside ? 'inside' : cur.x < (rg.lo ?? -Infinity) ? 'below' : 'above'}</span>`, `${rg.lo == null ? '' : fmt(rg.lo * f)}–${rg.hi == null ? '' : fmt(rg.hi * f)} ${du}`]);
        }
      }
    } else stats.push(['Your value', '<small>none yet</small>', 'type one above']);
    if (co && co.table && co.table['50'] != null) stats.push([`Median (${co.label})`, `${fmt(co.table['50'] * f)} <small>${esc(du)}</small>`, `P5–P95 ${fmt(co.table['5'] * f)}–${fmt(co.table['95'] * f)}`]);
    $('#stats').innerHTML = stats.map(([k, val, sub]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${val}</div><div class="muted" style="font-size:11px">${esc(sub || '')}</div></div>`).join('');
    // range sources
    const info = [], srcs = [];
    for (const kind of ['ref_range', 'optimal']) {
      const rg = rangeFor(m, kind, v.sex);
      if (!rg) continue;
      if (rg.bad) info.push(`${RANGE_STYLE[kind].label}: given in ${esc(rg.unit)}, which doesn't convert to this marker's units, so it isn't drawn.`);
      else info.push(`<span style="color:${RANGE_STYLE[kind].col}">${RANGE_STYLE[kind].label}</span> (${SEXLABEL[v.sex].toLowerCase()}): ${rg.lo == null ? '' : fmt(rg.lo * f)}–${rg.hi == null ? '' : fmt(rg.hi * f)} ${esc(du)}`);
      srcs.push(`<b>${RANGE_STYLE[kind].label}:</b> ${esc(rg.source || '')}${rg.note ? '. ' + esc(rg.note) : ''}${rg.rationale ? ' <i>' + esc(rg.rationale) + '</i>' : ''}`);
    }
    $('#rangeInfo').innerHTML = info.join('<br>') + srcFold('Range sources', srcs.join('<br>'));
    if (pop) { drawAge(m, v, es, cur); drawDist(m, v, cur, co); drawZ(m, v, es); if (m.supplement && m.supplement.sexes) drawSupp(m, v, cur); }
    drawHistory(m, v, es);
  }

  /** Shapes for ref/optimal ranges. orient 'x' = vertical bands across x, 'y' = horizontal bands. */
  function rangeShapes(m, sex, f, orient, bounds, isLog) {
    const L = (val) => (isLog ? Math.log10(val) : val); // annotations on log axes take log10 coordinates
    const [bmin, bmax] = bounds;
    const out = { shapes: [], ann: [] };
    for (const kind of ['ref_range', 'optimal']) {
      const rg = rangeFor(m, kind, sex);
      if (!rg || rg.bad) continue;
      const st = RANGE_STYLE[kind];
      const lo = rg.lo == null || rg.lo <= 0 ? null : rg.lo * f, hi = rg.hi == null ? null : rg.hi * f;
      const a = Math.max(lo ?? bmin, bmin), b = Math.min(hi ?? bmax, bmax);
      if (!(b > a)) continue;
      if (orient === 'x') {
        // bracket along the top of the plot
        const y0 = kind === 'optimal' ? 0.955 : 0.985;
        out.shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: a, x1: b, y0, y1: y0, line: { color: st.col, width: 4 } });
        for (const x of [lo, hi]) if (x != null && x >= bmin && x <= bmax) out.shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: y0, line: { color: rgba(st.col, 0.6), width: 1, dash: 'dash' } });
        out.ann.push({ xref: 'paper', yref: 'paper', x: 1, y: y0, xanchor: 'right', yanchor: 'middle', text: st.label, showarrow: false, font: { size: 10, color: st.col }, bgcolor: C.bg });
      } else {
        out.shapes.push({ type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: a, y1: b, fillcolor: rgba(st.col, kind === 'optimal' ? 0.07 : 0.04), line: { width: 0 }, layer: 'below' });
        for (const y of [lo, hi]) if (y != null && y >= bmin && y <= bmax) out.shapes.push({ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: y, y1: y, line: { color: rgba(st.col, 0.7), width: 1, dash: kind === 'optimal' ? 'dot' : 'dash' } });
        const yl = b;
        out.ann.push({ xref: 'paper', yref: 'y', x: 1, y: L(yl), xanchor: 'right', yanchor: 'bottom', text: st.label, showarrow: false, font: { size: 10, color: st.col } });
      }
    }
    return out;
  }

  function drawDist(m, v, cur, co) {
    const f = dispFactor(m), du = dispUnit(m);
    const sexes = v.both ? [v.sex, v.sex === 'male' ? 'female' : 'male'].filter((x) => S.sexStats(m, x)) : [v.sex];
    const banded = co && co.band;
    const traces = sexes.map((sex, i) => {
      const cs = banded ? cohort(m, sex, co.band) : null;
      const d = banded && cs && cs.band ? distSeries(m, sex, f, cs.stats) : distSeries(m, sex, f);
      return {
        type: 'scatter', mode: 'lines', x: d.x, y: d.y, customdata: d.cd, name: SEXLABEL[sex] + (banded ? ' ' + co.band : ''),
        line: { shape: 'hv', color: SEXCOL[sex], width: i ? 1.2 : 1.6 }, fill: 'tozeroy', fillcolor: rgba(SEXCOL[sex], i ? 0.08 : 0.22),
        hovertemplate: `${SEXLABEL[sex]}: %{customdata[0]}–%{customdata[1]} ${du}: <b>%{y:.2f}%</b><extra></extra>`,
      };
    });
    const P = (co && co.table) || {};
    const shapes = [], ann = [];
    const bands = [['1', '5', C.bad, 0.07], ['5', '25', C.warn, 0.07], ['25', '75', C.good, 0.08], ['75', '95', C.warn, 0.07], ['95', '99', C.bad, 0.07]];
    for (const [a, b, col, o] of bands) if (P[a] != null && P[b] != null) shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: P[a] * f, x1: P[b] * f, y0: 0, y1: 0.93, fillcolor: rgba(col, o), line: { width: 0 }, layer: 'below' });
    for (const k of ['5', '25', '50', '75', '95']) if (P[k] != null) {
      shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: P[k] * f, x1: P[k] * f, y0: 0, y1: 0.86, line: { color: k === '50' ? '#aaa' : '#555', width: 1, dash: 'dot' } });
      ann.push({ x: v.logx ? Math.log10(P[k] * f) : P[k] * f, y: 0.86, xref: 'x', yref: 'paper', text: `P${k}<br>${fmt(P[k] * f)}`, showarrow: false, yanchor: 'bottom', font: { size: 10, color: C.muted } });
    }
    const allx = traces.flatMap((t) => t.x);
    const rs = rangeShapes(m, v.sex, f, 'x', [Math.min(...allx), Math.max(...allx)], v.logx);
    shapes.push(...rs.shapes); ann.push(...rs.ann);
    if (cur) {
      const r = evalCohort(m, cur.x, co);
      shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: cur.x * f, x1: cur.x * f, y0: 0, y1: 0.7, line: { color: C.accent, width: 2.5, dash: cur.trial ? 'dot' : 'solid' } });
      ann.push({ x: v.logx ? Math.log10(cur.x * f) : cur.x * f, y: 0.7, xref: 'x', yref: 'paper', yanchor: 'bottom', showarrow: false, bgcolor: '#1b1e26', bordercolor: C.accent, borderpad: 3,
        text: `<b>${cur.trial ? 'Typed' : 'You'} ${fmt(cur.x * f)} ${esc(du)}</b><br>${fmtP(r.pct)} · model ${fmtP(r.modelPct)} · z ${fmtZ(r.z)}`, font: { size: 11, color: '#fff' } });
    }
    $('#distSub').textContent = co ? co.label : '';
    $('#distNote').textContent = (banded ? `Age band ${co.band}: curve modelled from the band's ${m.log_scale ? 'log-normal' : 'normal'} fit (bands have no histogram); shading from the band's P5/P25/P75/P95. ` : 'Share of the population in each histogram bin. ') +
      'Shading: P25–P75 green, P5–P25 / P75–P95 amber, outer tails red. Orange line: your value.';
    plot($('#distChart'), traces, layout({
      shapes, annotations: ann, margin: { l: 56, r: 24, t: 40, b: 50 },
      xaxis: axis({ type: v.logx ? 'log' : 'linear', title: { text: `${m.name} (${du})`, font: { color: C.muted, size: 12 } } }),
      yaxis: axis({ title: { text: '% of population per bin', font: { color: C.muted, size: 12 } }, rangemode: 'tozero' }),
    }));
  }

  function drawAge(m, v, es, cur) {
    const f = dispFactor(m), du = dispUnit(m), log = !!m.log_scale;
    const s = S.sexStats(m, v.sex);
    const note = $('#ageNote');
    $('#ageSub').textContent = `${SEXLABEL[v.sex]} · P5 / P25 / P50 / P75 / P95`;
    if (!s.by_age || !s.by_age.length) { if ($('#ageChart')) $('#ageChart').outerHTML ='<div class="panel-body"><div class="empty">No age-band breakdown in this dataset.</div></div>'; return; }
    const cats = s.by_age.map((b) => b.band);
    const q = (k) => s.by_age.map((b) => { const x = bandQ(b, k, log); return x == null ? null : x * f; });
    const col = SEXCOL[v.sex];
    // legendrank orders the unified hover to match the chart (P95 on top); trace order itself must stay as-is for the tonexty fills.
    const rank = { 95: 5, 75: 4, 50: 3, 25: 2, 5: 1 };
    const ln = (k, extra) => Object.assign({ type: 'scatter', mode: 'lines', x: cats, y: q(k), name: 'P' + k, legendrank: rank[k], line: { color: rgba(col, 0.5), width: 1 },
      hovertemplate: k === '50' ? `<b>P50: %{y:.3~g} ${du}</b><extra></extra>` : `P${k}: %{y:.3~g} ${du}<extra></extra>` }, extra || {});
    const traces = [
      ln('5', { showlegend: false }),
      ln('95', { fill: 'tonexty', fillcolor: rgba(col, 0.12), name: 'P5–P95' }),
      ln('25', { showlegend: false }),
      ln('75', { fill: 'tonexty', fillcolor: rgba(col, 0.24), name: 'P25–P75' }),
      ln('50', { line: { color: col, width: 2.5 }, name: 'Median', mode: 'lines+markers', marker: { size: 6 } }),
      { type: 'bar', x: cats, y: s.by_age.map((b) => b.n), yaxis: 'y2', name: 'n', marker: { color: 'rgba(255,255,255,0.05)' }, hovertemplate: 'n = %{y}<extra></extra>', showlegend: false },
    ];
    const by = state.profile.birthYear;
    const myBand = by ? S.bandForAge(s.by_age, S.ageAt(by, today())) : null;
    const pts = [];
    if (by) for (const e of es) {
      const x = S.toPrimary(m, e.value, e.unit), age = S.ageAt(by, e.date), b = S.bandForAge(s.by_age, age);
      if (!isFinite(x) || !b) continue;
      const r = evalCohort(m, x, cohort(m, v.sex, b.band));
      pts.push({ band: b.band, y: x * f, t: `${e.date} · age ${age} · ${fmtP(r.pct)} in band · z ${fmtZ(r.z)}` });
    }
    if (pts.length) traces.push({ type: 'scatter', mode: 'markers', x: pts.map((p) => p.band), y: pts.map((p) => p.y), name: 'My values', customdata: pts.map((p) => p.t),
      marker: { color: rgba(C.accent, 0.7), size: 8, symbol: 'diamond', line: { color: '#000', width: 1 } }, hovertemplate: `<b>You %{y:.3~g} ${du}</b> %{customdata}<extra></extra>` });
    if (cur) {
      const band = v.ageSel !== 'all' && v.ageSel !== 'auto' ? v.ageSel : by ? (S.bandForAge(s.by_age, S.ageAt(by, cur.date)) || {}).band : null;
      if (band) {
        const r = evalCohort(m, cur.x, cohort(m, v.sex, band));
        traces.push({ type: 'scatter', mode: 'markers+text', x: [band], y: [cur.x * f], name: cur.trial ? 'Typed value' : 'Latest', text: [`${fmtP(r.pct)}`], textposition: 'middle right', textfont: { color: C.accent, size: 12 },
          marker: { color: C.accent, size: 15, symbol: 'diamond', line: { color: '#fff', width: cur.trial ? 2 : 1 } }, hovertemplate: `<b>${cur.trial ? 'Typed' : 'Latest'} %{y:.3~g} ${du}</b> · ${fmtP(r.pct)} · z ${fmtZ(r.z)} (${band})<extra></extra>` });
      }
    }
    const ally = traces.slice(0, 5).flatMap((t) => t.y).concat(pts.map((p) => p.y)).filter((y) => y != null && (!log || y > 0));
    const rs = rangeShapes(m, v.sex, f, 'y', [Math.min(...ally) * (log ? 0.8 : 1), Math.max(...ally) * 1.1], log);
    const sel = v.ageSel === 'auto' ? (myBand && myBand.band) : v.ageSel !== 'all' ? v.ageSel : null;
    if (sel && cats.includes(sel)) {
      const i = cats.indexOf(sel);
      rs.shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: i - 0.5, x1: i + 0.5, y0: 0, y1: 1, fillcolor: 'rgba(247,147,26,0.06)', line: { color: 'rgba(247,147,26,0.35)', width: 1 }, layer: 'below' });
    }
    note.innerHTML = (by ? `Diamonds: your values at your age band (birth year ${esc(by)}).` : es.length || cur ? 'Set your birth year in <a href="#/labs">My labs</a> (or pick an age band) to place your value on this chart.' : '') + ' Faint bars: sample size per band.';
    plot($('#ageChart'), traces, layout({
      shapes: rs.shapes, annotations: rs.ann,
      xaxis: axis({ type: 'category', title: { text: 'Age band', font: { color: C.muted, size: 12 } } }),
      yaxis: axis({ type: log ? 'log' : 'linear', title: { text: `${m.name} (${du})`, font: { color: C.muted, size: 12 } } }),
      yaxis2: { overlaying: 'y', side: 'right', showgrid: false, showticklabels: false, rangemode: 'tozero', range: [0, Math.max(...s.by_age.map((b) => b.n || 0)) * 4] },
    }));
  }

  function drawZ(m, v, es) {
    const f = dispFactor(m), du = dispUnit(m);
    const sex = v.sex;
    const note = $('#zNote');
    const label = v.ageSel === 'auto' ? `${SEXLABEL[sex].toLowerCase()}, your age band at each date` : v.ageSel === 'all' ? `${SEXLABEL[sex].toLowerCase()}, all ages` : `${SEXLABEL[sex].toLowerCase()} ${v.ageSel}`;
    $('#zSub').textContent = 'vs ' + label + (userSex() && userSex() !== sex ? ' (not your sex)' : '');
    if (!es.length) { if ($('#zChart')) $('#zChart').outerHTML ='<div class="panel-body"><div class="empty">Save a value above to see your Z-score history.</div></div>'; return; }
    const pts = es.map((e) => {
      const x = S.toPrimary(m, e.value, e.unit), co = cohort(m, sex, v.ageSel, e.date);
      return { e, x, co, r: evalCohort(m, x, co) };
    }).filter((o) => isFinite(o.r.z));
    const traces = [{
      type: 'scatter', mode: 'lines+markers', x: pts.map((o) => o.e.date), y: pts.map((o) => o.r.z), name: 'Z',
      line: { color: C.accent, width: 2 }, marker: { size: 10, color: pts.map((o) => zColor(o.r.z)), line: { color: '#000', width: 1 } },
      customdata: pts.map((o) => [`${fmt(o.x * f)} ${du}`, fmtP(o.r.pct), fmtP(o.r.modelPct), o.co.label]),
      hovertemplate: '<b>z %{y:+.2f}</b> · %{customdata[0]} · %{customdata[1]} (model %{customdata[2]}) · %{customdata[3]}<extra></extra>',
    }];
    const zmax = Math.max(3, ...pts.map((o) => Math.abs(o.r.z) + 0.5));
    const shapes = [[-1, 1, C.good, 0.10], [1, 2, C.warn, 0.10], [-2, -1, C.warn, 0.10], [2, zmax, C.bad, 0.07], [-zmax, -2, C.bad, 0.07]]
      .map(([a, b, c, o]) => ({ type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: a, y1: b, fillcolor: rgba(c, o), line: { width: 0 }, layer: 'below' }));
    shapes.push({ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: '#555', width: 1, dash: 'dot' } });
    plot($('#zChart'), traces, layout({
      shapes, showlegend: false, xaxis: axis(Object.assign({ type: 'date' }, dateRange(pts.map((o) => o.e.date)))),
      yaxis: axis({ range: [-zmax, zmax], dtick: 1, title: { text: 'Z-score', font: { color: C.muted, size: 12 } } }),
    }));
    const skipped = es.length - pts.length;
    note.textContent = 'Bands: |z|<1 green, 1–2 amber, >2 red. ' + (v.ageSel === 'auto' && !state.profile.birthYear ? 'Set birth year for age bands. ' : '') +
      (skipped ? `${skipped} value(s) skipped (unrecognised unit or no data for this sex). ` : '') + (m.log_scale ? 'Z on ln(value) using the cohort log_mean / log_sd.' : 'Z on the raw value using the cohort mean / sd.');
  }

  /** Published-quantile supplement (e.g. UK Biobank Lp(a) in nmol/L): percentile ladders per subgroup. */
  function drawSupp(m, v, cur) {
    const sp = m.supplement, su = sp.unit;
    const groups = Object.entries(sp.sexes).filter(([, g]) => g && g.percentiles);
    const label = (k) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const traces = [];
    const shapes = [], ann = [];
    groups.forEach(([k, g]) => {
      const t = S.pctTable(g.percentiles);
      const col = k.startsWith('female') ? C.female : C.male;
      traces.push({ type: 'scatter', mode: 'lines+markers+text', x: t.map((r) => r[1]), y: t.map(() => label(k)), text: t.map((r) => 'P' + r[0]), textposition: 'top center', textfont: { size: 10, color: C.muted },
        line: { color: rgba(col, 0.6), width: 6 }, marker: { size: 10, color: col }, name: label(k), hovertemplate: `${label(k)} (n ${g.n}): %{text} = %{x} ${esc(su)}${g.share_ge_125 != null ? ` · ${Math.round(g.share_ge_125 * 100)}% ≥ 125` : ''}<extra></extra>` });
    });
    let noteTxt = 'Only published quantiles exist for this source (no histogram, tails or age bands), so percentiles outside the published range are shown as bounds.';
    if (cur) {
      const xs = S.fromPrimary(m, cur.x, su);
      if (isFinite(xs)) {
        shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: xs, x1: xs, y0: 0, y1: 1, line: { color: C.accent, width: 2.5, dash: cur.trial ? 'dot' : 'solid' } });
        const parts = groups.map(([k, g]) => {
          const t = S.pctTable(g.percentiles);
          if (xs < t[0][1]) return `${label(k)} <P${t[0][0]}`;
          if (xs > t[t.length - 1][1]) return `${label(k)} >P${t[t.length - 1][0]}`;
          const r = S.percentile(xs, null, true, g.percentiles);
          return `${label(k)} ${fmtP(r.pct)}`;
        });
        ann.push({ x: Math.log10(xs), y: 1, xref: 'x', yref: 'paper', yanchor: 'bottom', showarrow: false, text: `<b>You ${fmt(xs)} ${esc(su)}</b>`, font: { color: C.accent, size: 11 } });
        noteTxt = `Your ${fmt(xs)} ${su}: ${parts.join(' · ')}. ` + (S.unitKey(su) !== S.unitKey(m.unit) ? `Converted from ${m.unit} with an approximate factor; entering the value in ${su} is more reliable. ` : '') + noteTxt;
      }
    }
    const rs = rangeShapes({ id: m.id, unit: su, alt_units: [] }, v.sex, 1, 'x', [Math.min(...traces.flatMap((t) => t.x)) * 0.5, Math.max(...traces.flatMap((t) => t.x)) * 2], true);
    shapes.push(...rs.shapes); ann.push(...rs.ann);
    $('#suppNote').textContent = noteTxt;
    plot($('#suppChart'), traces, layout({ hovermode: 'closest', showlegend: false, shapes, annotations: ann, margin: { l: 150, r: 24, t: 30, b: 46 },
      xaxis: axis({ type: 'log', title: { text: `${m.name} (${su})`, font: { color: C.muted, size: 12 } } }), yaxis: axis({ automargin: true }) }));
  }

  function dateRange(dates) {
    if (dates.length !== 1) return {};
    const d = new Date(dates[0]);
    return { range: [new Date(+d - 120 * 864e5).toISOString().slice(0, 10), new Date(+d + 120 * 864e5).toISOString().slice(0, 10)] };
  }

  function drawHistory(m, v, es) {
    const el = $('#histChart');
    const f = dispFactor(m), du = dispUnit(m);
    const pts = es.map((e) => ({ d: e.date, y: S.toPrimary(m, e.value, e.unit) * f, raw: `${fmt(e.value)} ${e.unit}` })).filter((p) => isFinite(p.y));
    if (!pts.length) { if (el) el.outerHTML = '<div class="panel-body"><div class="empty">No saved values yet. Use the value box above or <a href="#/labs">My labs</a>.</div></div>'; return; }
    const hy = pts.map((p) => p.y);
    const histLog = !!(m.log_scale && v.logx);
    const rs = rangeShapes(m, userSex() || v.sex, f, 'y', [Math.min(...hy) * 0.6, Math.max(...hy) * 1.5], histLog);
    const co = hasPop(m) ? cohort(m, v.sex, v.ageSel, today()) : null;
    if (co && co.table && co.table['25'] != null) {
      rs.shapes.push({ type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: co.table['25'] * f, y1: co.table['75'] * f, fillcolor: rgba(SEXCOL[v.sex], 0.08), line: { width: 0 }, layer: 'below' });
      rs.ann.push({ xref: 'paper', yref: 'y', x: 0, y: histLog ? Math.log10(co.table['75'] * f) : co.table['75'] * f, xanchor: 'left', yanchor: 'bottom', text: `P25–P75 ${co.label}`, showarrow: false, font: { size: 10, color: rgba(SEXCOL[v.sex], 0.8) } });
    }
    plot(el, [{ type: 'scatter', mode: 'lines+markers', x: pts.map((p) => p.d), y: pts.map((p) => p.y), customdata: pts.map((p) => p.raw), name: m.name, line: { color: C.accent, width: 2 }, marker: { size: 9 }, hovertemplate: `<b>%{y:.3~g} ${du}</b> (entered as %{customdata})<extra></extra>` }],
      layout({ shapes: rs.shapes, annotations: rs.ann, showlegend: false, xaxis: axis(Object.assign({ type: 'date' }, dateRange(pts.map((p) => p.d)))), yaxis: axis({ type: histLog ? 'log' : 'linear', title: { text: du, font: { color: C.muted } } }) }));
  }

  // ---------------------------------------------------------------- deep-dive page
  const DISCLAIMER = 'Educational only, not medical advice. Population percentiles describe how common a value is, not what is healthy, and are not treatment targets. Discuss results with a clinician.';
  function renderDeep(main, id) {
    const m = app.byId[id], c = app.content[id];
    if (!m) { main.innerHTML = `<div class="empty">Unknown marker "${esc(id)}".</div>`; return; }
    let html = `<div class="sub"><a href="#/m/${esc(id)}">&laquo; ${esc(m.name)} charts</a></div><h1>${esc(m.name)}: deep dive</h1>`;
    html += `<div class="why" style="border-color:var(--bad)"><b>Disclaimer.</b> ${esc(DISCLAIMER)}</div>`;
    if (!c) html += '<div class="empty">Notes for this marker haven\'t been written yet.</div>';
    else {
      if (c.summary) html += `<p class="notes"><b>${esc(c.summary)}</b></p>`;
      if (c.why_it_matters) html += `<div class="panel"><div class="panel-head"><h2>Why it matters</h2></div><div class="panel-body notes">${esc(c.why_it_matters)}</div></div>`;
      const rr = [], rs = [];
      for (const kind of ['ref_range', 'optimal']) {
        const r = c[kind];
        if (!r) continue;
        rr.push(`<tr><td style="color:${RANGE_STYLE[kind].col}">${RANGE_STYLE[kind].label}</td><td class="mono">${r.male ? esc(r.male.map((x) => x ?? '').join('–')) : '–'}</td><td class="mono">${r.female ? esc(r.female.map((x) => x ?? '').join('–')) : '–'}</td><td>${esc(r.unit || '')}</td></tr>`);
        rs.push(`<b>${RANGE_STYLE[kind].label}:</b> ${esc(r.source || '')}${r.note ? '<br><span class="muted">' + esc(r.note) + '</span>' : ''}${r.rationale ? '<br><span class="muted">' + esc(r.rationale) + '</span>' : ''}`);
      }
      if (rr.length) html += `<div class="panel"><div class="panel-head"><h2>Ranges</h2></div><div class="panel-body"><table class="data"><thead><tr><th></th><th>Men</th><th>Women</th><th>Unit</th></tr></thead><tbody>${rr.join('')}</tbody></table>${srcFold('Range sources', rs.join('<br><br>'))}</div></div>`;
      if (c.deep) html += `<div class="panel"><div class="panel-body notes">${window.marked ? window.marked.parse(String(c.deep)) : '<pre>' + esc(c.deep) + '</pre>'}</div></div>`;
    }
    html += `<div class="sub" style="margin-top:20px">${srcFold('Population data source', `${esc(m.source || 'none')}${m.population_note ? '. ' + esc(m.population_note) : ''}`)}</div>`;
    main.innerHTML = html;
    // fold "References"/"Sources" sections of the notes markdown
    $$('.notes h2, .notes h3', main).forEach((h) => {
      if (!/^\s*(references|sources|citations)\b/i.test(h.textContent)) return;
      const d = document.createElement('details'); d.className = 'srcfold';
      d.innerHTML = `<summary>${esc(h.textContent)}</summary>`;
      const body = document.createElement('div'); body.className = 'srcfold-body'; d.appendChild(body);
      while (h.nextElementSibling && !/^H[1-3]$/.test(h.nextElementSibling.tagName)) body.appendChild(h.nextElementSibling);
      h.replaceWith(d);
    });
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- dashboard
  function renderDash(main) {
    const ms = app.markers.filter((m) => latest(m.id));
    let html = `<h1>My Dashboard</h1><div class="sub">Every marker you've entered, latest value against ${userSex() ? SEXLABEL[userSex()].toLowerCase() : 'men (set your sex in <a href="#/labs">My labs</a>)'}.</div>`;
    if (!ms.length) { main.innerHTML = html + '<div class="empty">No values yet. <a href="#/labs">Add your labs</a>.</div>'; return; }
    html += `<div class="panel"><div class="panel-head"><h2>Z-score summary</h2><span class="spacer"></span><label class="chk"><input type="checkbox" id="zAge" ${app.view.homeAge ? 'checked' : ''}> age-adjusted</label></div><div id="zSummary" class="chart short"></div><div class="chart-note">Green |z|&lt;1, amber 1–2, red &gt;2. Click a dot to open the marker.</div></div>`;
    html += `<div class="panel"><div class="panel-body"><table class="data"><thead><tr><th>Marker</th><th>Latest</th><th style="text-align:right">Value</th><th>Unit</th><th style="text-align:right">Percentile</th><th style="text-align:right">Model</th><th style="text-align:right">Z all ages</th><th style="text-align:right">Z age band</th><th>Ref range</th><th style="text-align:right">#</th></tr></thead><tbody>`;
    for (const m of ms) {
      const l = latest(m.id), ev = evalEntry(l), ea = evalEntry(l, { ageAdjusted: true });
      const f = dispFactor(m), x = ev.x;
      const rg = rangeFor(m, 'ref_range', userSex() || 'male');
      const rs = rg && !rg.bad && isFinite(x) ? ((rg.lo == null || x >= rg.lo) && (rg.hi == null || x <= rg.hi) ? '<span class="z0">inside</span>' : '<span class="z1">outside</span>') : '<span class="muted">–</span>';
      html += `<tr><td><a href="#/m/${esc(m.id)}">${esc(m.name)}</a>${m._src === 'mock' ? ' <span class="badge mock">mock</span>' : ''}</td><td class="mono">${esc(l.date)}</td><td class="num">${isFinite(x) ? fmt(x * f) : esc(l.value)}</td><td>${esc(isFinite(x) ? dispUnit(m) : l.unit)}</td>
        <td class="num ${zClass(ev.z)}">${fmtP(ev.pct)}</td><td class="num muted">${fmtP(ev.modelPct)}</td><td class="num ${zClass(ev.z)}">${fmtZ(ev.z)}</td>
        <td class="num ${zClass(ea.z)}">${ea.band ? fmtZ(ea.z) + ' <span class="muted">' + esc(ea.band) + '</span>' : '–'}</td><td>${rs}</td><td class="num">${entriesFor(m.id).length}</td></tr>`;
    }
    html += '</tbody></table></div></div>';
    main.innerHTML = html;
    $('#zAge').onchange = (e) => { app.view.homeAge = e.target.checked; drawZSummary(ms); };
    drawZSummary(ms);
  }

  // ---------------------------------------------------------------- my labs
  function markerOptions(sel) {
    return groupsPresent().map((g) => `<optgroup label="${esc(groupLabel(g))}">` +
      app.markers.filter((m) => (m.group || 'other') === g).map((m) => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('') + '</optgroup>').join('');
  }

  function renderLabs(main) {
    const p = state.profile;
    const yr = new Date().getFullYear();
    // Served from the Quantile site, signed-in patients also see results pulled from their account.
    const portal = document.body.classList.contains('portal');
    const fromPortal = state.entries.some((e) => e.source === 'quantile');
    let html = `<h1>My labs</h1><div class="panel storage-note"><div class="panel-body">
      ${portal
        ? `<b>Two kinds of data live here.</b> Results from tests you ordered through Quantile${fromPortal ? ` (${state.entries.filter((e) => e.source === 'quantile').length} values so far)` : ''} are stored in your Quantile account, in Canada, encrypted, and appear here automatically when you're signed in. Anything you add by hand or upload on this page yourself is saved on this device only, in this browser; it is never uploaded and we can't see it.`
        : `<b>Your data is saved on this device only, in this browser.</b> It is never uploaded; we can't see it, and we can't recover it for you.`}
      <ul>
        <li><b>It stays</b> when you close the tab, quit the browser, or restart.</li>
        <li><b>It is lost</b> if you use a private/incognito window (wiped on close) or clear this site's browsing data.</li>
        <li><b>Safari / iPhone:</b> data for sites not visited in ~7 days may be removed. Add this site to your Home Screen to avoid that.</li>
        <li><b>Other browsers and devices</b> don't see it. To move it, use <b>Export</b> below, then <b>Import</b> on the other device.</li>
      </ul>
      Export a backup after adding new labs.</div></div>`;
    html += `<div class="panel"><div class="panel-head"><h2>Profile</h2></div><div class="panel-body"><form id="profForm" class="form-row">
      <label>Sex (reference population)<select name="sex"><option value="">-</option><option value="male" ${p.sex === 'male' ? 'selected' : ''}>Male</option><option value="female" ${p.sex === 'female' ? 'selected' : ''}>Female</option></select></label>
      <label>Birth year<input name="birthYear" type="number" min="1900" max="${yr}" value="${esc(p.birthYear || '')}" style="width:100px"></label>
      <button class="btn primary">Save</button></form><div id="profMsg" class="msg"></div></div></div>`;
    html += `<div class="panel"><div class="panel-head"><h2>Add a value</h2></div><div class="panel-body"><form id="addForm" class="form-row">
      <label>Marker<select name="marker" id="addMarker">${markerOptions(app.view.lastMarker)}</select></label>
      <label>Value<input name="value" type="number" step="any" required style="width:110px"></label>
      <label>Unit<select name="unit" id="addUnit"></select></label>
      <label>Date<input name="date" type="date" value="${today()}" required></label>
      <button class="btn primary">Add</button></form><div id="addMsg" class="msg"></div></div></div>`;
    html += `<div class="panel"><div class="panel-head"><h2>Read a lab report</h2><span class="muted">PDF or screenshot · read on this device, never uploaded</span></div>
      <div class="panel-body"><input type="file" id="reportFile" accept=".pdf,application/pdf,image/*"> <span class="muted" style="font-size:12px">You'll check every value before anything is saved. Screenshots are slower and less accurate than PDFs.</span>
      <div id="reportMsg" class="msg"></div><div id="reportReview"></div></div></div>`;
    html += `<div class="panel"><div class="panel-head"><h2>Upload CSV</h2><span class="muted">columns: date, marker, value, unit</span><span class="spacer"></span><button class="btn" id="tmplBtn">Download template</button></div>
      <div class="panel-body"><input type="file" id="csvFile" accept=".csv,text/csv,text/plain"> <span class="muted" style="font-size:12px">Loose names like "Testosterone, Total" or "LDL-C" are matched automatically. Blank unit = the marker's default unit.</span><div id="csvMsg" class="msg"></div></div></div>`;
    html += `<div class="panel"><div class="panel-head"><h2>Backup</h2></div><div class="panel-body form-row">
      <button class="btn" id="expBtn">Export JSON</button>
      <label>Import mode<select id="impMode"><option value="merge">merge</option><option value="replace">replace everything</option></select></label>
      <label>Import JSON<input type="file" id="impFile" accept=".json,application/json"></label>
      <span class="spacer" style="flex:1"></span><button class="btn danger" id="clearBtn">Delete all my data</button></div><div class="panel-body" style="padding-top:0"><div id="impMsg" class="msg"></div></div></div>`;
    html += `<div class="panel"><div class="panel-head"><h2>My values</h2><span class="muted">${state.entries.length} total</span></div><div class="panel-body" id="entryTable"></div></div>`;
    main.innerHTML = html;

    const fillUnits = () => {
      const m = app.byId[$('#addMarker').value];
      $('#addUnit').innerHTML = m ? S.markerUnits(m).map((u) => `<option ${u.unit === dispUnit(m) ? 'selected' : ''}>${esc(u.unit)}</option>`).join('') : '';
    };
    $('#addMarker').onchange = fillUnits; fillUnits();

    $('#profForm').onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const by = parseInt(fd.get('birthYear'), 10);
      state.profile.sex = fd.get('sex') || undefined;
      state.profile.birthYear = by >= 1900 && by <= yr ? by : undefined;
      save(); renderSidebar(); drawEntryTable();
      const m = $('#profMsg'); m.className = 'msg ok'; m.textContent = 'Saved.';
    };
    $('#addForm').onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const id = fd.get('marker'), val = parseFloat(fd.get('value'));
      const msg = $('#addMsg');
      if (!isFinite(val)) { msg.className = 'msg err'; msg.textContent = 'Enter a number.'; return; }
      const entry = { uid: uid(), marker: id, value: val, unit: fd.get('unit'), date: fd.get('date'), added: new Date().toISOString() };
      state.entries.push(entry); save();
      app.view.lastMarker = id;
      const m = app.byId[id], ev = evalEntry(entry);
      msg.className = 'msg ok';
      msg.innerHTML = `Added ${esc(m.name)} ${fmt(val)} ${esc(entry.unit)}.` + (ev && isFinite(ev.z) ? ` That's ${fmtP(ev.pct)} (model ${fmtP(ev.modelPct)}), z ${fmtZ(ev.z)} vs ${SEXLABEL[ev.sex].toLowerCase()}.` : hasPop(m) ? '' : ' No population data for this marker yet.') + ` <a href="#/m/${esc(id)}">Open chart</a>`;
      e.target.value.value = '';
      renderSidebar(); drawEntryTable();
    };
    $('#tmplBtn').onclick = () => download('biomarkers_template.csv',
      'date,marker,value,unit\n2026-01-15,"Testosterone, Total",612,ng/dL\n2026-01-15,SHBG,38,nmol/L\n2026-01-15,Estradiol,28,pg/mL\n2026-01-15,TSH,1.8,mIU/L\n2026-01-15,Free T4,1.3,ng/dL\n2026-01-15,LDL-C,110,mg/dL\n', 'text/csv');
    $('#csvFile').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      const res = importCsv(await file.text());
      const msg = $('#csvMsg');
      msg.className = 'msg ' + (res.added ? 'ok' : 'err');
      msg.innerHTML = `Imported ${res.added} value(s)` + (res.dupes ? `, ${res.dupes} duplicate(s) skipped` : '') + '.' +
        (res.problems.length ? '<br><span class="err" style="color:var(--bad)">' + res.problems.slice(0, 30).map(esc).join('<br>') + (res.problems.length > 30 ? `<br>...and ${res.problems.length - 30} more` : '') + '</span>' : '');
      e.target.value = '';
      renderSidebar(); drawEntryTable();
    };
    $('#reportFile').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      const msg = $('#reportMsg'), say = (t) => { msg.className = 'msg'; msg.textContent = t; };
      $('#reportReview').innerHTML = '';
      try {
        const text = await reportText(file, say);
        const r = S.extractLabs(text, app.markers);
        e.target.value = '';
        if (!r.rows.length) { msg.className = 'msg err'; msg.textContent = 'No recognisable results found in that file. Try a PDF, a sharper screenshot, or add values by hand.'; return; }
        msg.className = 'msg ok';
        msg.textContent = `Found ${r.rows.length} value(s). Check each one against your report, fix anything wrong, then save.`;
        drawReportReview(r, file.type === 'application/pdf' || /\.pdf$/i.test(file.name) ? 'pdf' : 'image');
      } catch (err) {
        msg.className = 'msg err'; msg.textContent = 'Could not read that file: ' + (err && err.message || err);
      }
    };
    $('#expBtn').onclick = () => download(`biomarkers_backup_${today()}.json`, JSON.stringify({ app: 'biomarkers', version: 1, exported: new Date().toISOString(), profile: state.profile, entries: state.entries, prefs: state.prefs }, null, 1), 'application/json');
    $('#impFile').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      const msg = $('#impMsg');
      try {
        const d = JSON.parse(await file.text());
        if (!d || !Array.isArray(d.entries)) throw new Error('no "entries" array');
        const clean = d.entries.filter((x) => x && x.marker && isFinite(parseFloat(x.value)) && x.date).map((x) => ({ uid: x.uid || uid(), marker: String(x.marker), value: parseFloat(x.value), unit: String(x.unit || ''), date: String(x.date).slice(0, 10), added: x.added || new Date().toISOString() }));
        if ($('#impMode').value === 'replace') {
          if (!confirm(`Replace all ${state.entries.length} current values with ${clean.length} from the file?`)) return;
          state.entries = clean; state.profile = d.profile || {}; if (d.prefs) state.prefs = Object.assign({ units: {} }, d.prefs);
        } else {
          const keys = new Set(state.entries.map(entryKey));
          let n = 0;
          for (const x of clean) if (!keys.has(entryKey(x))) { state.entries.push(x); keys.add(entryKey(x)); n++; }
          if (!state.profile.sex && d.profile && d.profile.sex) state.profile.sex = d.profile.sex;
          if (!state.profile.birthYear && d.profile && d.profile.birthYear) state.profile.birthYear = d.profile.birthYear;
          clean.length = n;
        }
        save(); msg.className = 'msg ok'; msg.textContent = `Imported ${clean.length} value(s).`;
        render();
      } catch (err) { msg.className = 'msg err'; msg.textContent = 'Could not import: ' + err.message; }
    };
    $('#clearBtn').onclick = () => {
      if (!confirm('Delete your profile and all stored values from this browser? Export a backup first if unsure.')) return;
      state = { profile: {}, entries: [], prefs: { units: {} } }; save(); render();
    };
    drawEntryTable();
  }

  // ---------------------------------------------------------------- lab report reading (all local)
  const loaded = {};
  function loadScript(src) {
    return loaded[src] || (loaded[src] = new Promise((ok, bad) => {
      const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('failed to load ' + src)); document.head.appendChild(s);
    }));
  }

  /** Text of a PDF (text layer, lines rebuilt from item positions) or an image (OCR). Scanned PDFs fall back to OCR. */
  async function reportText(file, say) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) return ocr([await upscale(file)], say);
    say('Reading PDF…');
    await loadScript('vendor/pdfjs/pdf.min.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
    const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
    let out = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const items = (await (await doc.getPage(p)).getTextContent()).items.filter((it) => it.str.trim());
      const lines = [];
      for (const it of items) {
        const y = it.transform[5], x = it.transform[4];
        let l = lines.find((l) => Math.abs(l.y - y) < Math.max(2, (it.height || 10) * 0.4));
        if (!l) lines.push(l = { y, parts: [] });
        l.parts.push({ x, s: it.str });
      }
      lines.sort((a, b) => b.y - a.y);
      out += lines.map((l) => l.parts.sort((a, b) => a.x - b.x).map((q) => q.s).join(' ')).join('\n') + '\n';
    }
    if (out.replace(/\s/g, '').length > 40) return out;
    // no text layer: a scanned PDF. Render pages to images and OCR them.
    const imgs = [];
    for (let p = 1; p <= Math.min(doc.numPages, 6); p++) {
      const page = await doc.getPage(p), vp = page.getViewport({ scale: 2.5 });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      imgs.push(c);
    }
    return ocr(imgs, say);
  }

  /** Screenshots are often ~12px text; OCR misreads decimals at that size. Scale small images up to ~2400px wide, greyscale. */
  async function upscale(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(4, Math.max(1, 2400 / bmp.width));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d'); g.filter = 'grayscale(1) contrast(1.4)'; g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }

  async function ocr(images, say) {
    say('Loading text recognition (first time only, ~4 MB)…');
    await loadScript('vendor/ocr/tesseract.min.js');
    const worker = await Tesseract.createWorker('eng', 1, {
      workerPath: 'vendor/ocr/worker.min.js', corePath: 'vendor/ocr', langPath: 'vendor/ocr/lang', workerBlobURL: false,
      logger: (m) => { if (m.status === 'recognizing text') say(`Reading image… ${Math.round(m.progress * 100)}%`); },
    });
    try {
      let out = '';
      for (const img of images) out += (await worker.recognize(img)).data.text + '\n';
      return out;
    } finally { await worker.terminate(); }
  }

  function drawReportReview(r, source) {
    const el = $('#reportReview');
    const unusual = (x) => { const ev = evalEntry({ marker: x.marker, value: x.value, unit: x.unit, date: r.date || today() }); return ev && Math.abs(ev.z) > 4; };
    const unitOpts = (m, sel) => S.markerUnits(m).map((u) => `<option ${u.unit === sel ? 'selected' : ''}>${esc(u.unit)}</option>`).join('');
    el.innerHTML = `<div class="form-row" style="margin:10px 0"><label>Collection date<input type="date" id="repDate" value="${esc(r.date || today())}" required></label>
        ${r.date ? '' : '<span class="z2" style="font-size:12px">No date found in the report; set it here.</span>'}</div>
      <table class="data"><thead><tr><th></th><th>Marker</th><th>Value</th><th>Unit</th><th>Read from</th></tr></thead><tbody>` +
      r.rows.map((x, i) => `<tr data-i="${i}"><td><input type="checkbox" class="repUse" checked></td>
        <td><select class="repMarker">${markerOptions(x.marker)}</select></td>
        <td><input class="repVal" type="number" step="any" value="${esc(x.value)}" style="width:90px"></td>
        <td><select class="repUnit">${unitOpts(app.byId[x.marker], x.unit)}</select>${x.unitOk ? '' : ' <span class="z2" title="No unit found on this line; check it">check unit</span>'}${unusual(x) ? ' <span class="z2" title="Far outside the population range: a dropped decimal point is a common misread">check value</span>' : ''}</td>
        <td class="muted mono" style="font-size:11px">${esc(x.line)}</td></tr>`).join('') +
      `</tbody></table><div class="form-row" style="margin-top:10px"><button class="btn primary" id="repSave">Save checked values</button><button class="btn" id="repCancel">Discard</button></div>`;
    $$('tr[data-i]', el).forEach((tr) => {
      $('.repMarker', tr).onchange = (e) => { const m = app.byId[e.target.value]; $('.repUnit', tr).innerHTML = unitOpts(m, m.unit); };
    });
    $('#repCancel').onclick = () => { el.innerHTML = ''; $('#reportMsg').textContent = ''; };
    $('#repSave').onclick = () => {
      const date = $('#repDate').value, msg = $('#reportMsg');
      if (!date) { msg.className = 'msg err'; msg.textContent = 'Set the collection date first.'; return; }
      const keys = new Set(state.entries.map(entryKey));
      let added = 0, dupes = 0;
      $$('tr[data-i]', el).forEach((tr) => {
        const val = parseFloat($('.repVal', tr).value);
        if (!$('.repUse', tr).checked || !isFinite(val)) return;
        const e = { uid: uid(), marker: $('.repMarker', tr).value, value: val, unit: $('.repUnit', tr).value, date, added: new Date().toISOString(), source };
        if (keys.has(entryKey(e))) { dupes++; return; }
        keys.add(entryKey(e)); state.entries.push(e); added++;
      });
      save();
      el.innerHTML = '';
      msg.className = 'msg ok'; msg.textContent = `Saved ${added} value(s)` + (dupes ? `, ${dupes} already saved and skipped` : '') + '. Remember to Export a backup.';
      renderSidebar(); drawEntryTable();
    };
  }

  function entryKey(e) { return [e.marker, e.date, Number(e.value), S.unitKey(e.unit)].join('|'); }

  /** Parse CSV text into entries; returns {added, dupes, problems[]}. */
  function importCsv(text) {
    const rows = S.parseCsv(text);
    const out = { added: 0, dupes: 0, problems: [] };
    if (!rows.length) { out.problems.push('File is empty.'); return out; }
    let col = { date: 0, marker: 1, value: 2, unit: 3 }, start = 0;
    const head = rows[0].map((h) => S.normName(h));
    if (head.some((h) => ['date', 'marker', 'value', 'unit', 'units', 'test', 'name', 'result'].includes(h))) {
      const find = (names) => head.findIndex((h) => names.includes(h));
      col = { date: find(['date', 'collected', 'collection date', 'drawn']), marker: find(['marker', 'test', 'name', 'analyte', 'biomarker']), value: find(['value', 'result', 'level']), unit: find(['unit', 'units']) };
      start = 1;
      if (col.marker < 0 || col.value < 0) { out.problems.push('Header needs at least "marker" and "value" columns.'); return out; }
    }
    const keys = new Set(state.entries.map(entryKey));
    const list = app.markers.map((m) => ({ id: m.id, name: m.name }));
    for (let i = start; i < rows.length; i++) {
      const r = rows[i], line = i + 1;
      const get = (k) => (col[k] >= 0 && r[col[k]] != null ? String(r[col[k]]).trim() : '');
      const name = get('marker');
      const id = S.resolveMarker(name, list);
      if (!id) { out.problems.push(`Line ${line}: unknown marker "${name}"`); continue; }
      const raw = get('value');
      const val = parseFloat(raw.replace(/[<>≤≥,\s]/g, '').replace(/[^0-9.eE+-].*$/, ''));
      if (!isFinite(val)) { out.problems.push(`Line ${line}: value "${raw}" is not a number`); continue; }
      const m = app.byId[id];
      let unit = get('unit');
      const fct = S.unitFactor(m, unit);
      if (fct == null) { out.problems.push(`Line ${line}: unit "${unit}" not known for ${m.name} (expected ${S.markerUnits(m).map((u) => u.unit).join(' / ')})`); continue; }
      unit = unit ? (S.markerUnits(m).find((u) => S.unitKey(u.unit) === S.unitKey(unit)) || { unit }).unit : m.unit;
      const date = col.date >= 0 ? S.normDate(get('date')) : today();
      if (!date) { out.problems.push(`Line ${line}: date "${get('date')}" not understood (use YYYY-MM-DD)`); continue; }
      const e = { uid: uid(), marker: id, value: val, unit, date, added: new Date().toISOString(), source: 'csv' };
      if (keys.has(entryKey(e))) { out.dupes++; continue; }
      keys.add(entryKey(e)); state.entries.push(e); out.added++;
    }
    save();
    return out;
  }

  function drawEntryTable() {
    const el = $('#entryTable'); if (!el) return;
    if (!state.entries.length) { el.innerHTML = '<div class="empty">No values yet.</div>'; return; }
    const rows = state.entries.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    el.innerHTML = `<table class="data"><thead><tr><th>Date</th><th>Marker</th><th style="text-align:right">Value</th><th>Unit</th><th style="text-align:right">Percentile</th><th style="text-align:right">Model</th><th style="text-align:right">Z</th><th style="text-align:right">Z age band</th><th></th></tr></thead><tbody>` +
      rows.map((e) => {
        const m = app.byId[e.marker];
        const ev = m ? evalEntry(e) : null, ea = m ? evalEntry(e, { ageAdjusted: true }) : null;
        const ok = ev && ev.unitOk;
        return `<tr><td class="mono">${esc(e.date)}</td><td>${m ? `<a href="#/m/${esc(m.id)}">${esc(m.name)}</a>` : esc(e.marker) + ' <span class="muted">(unknown marker)</span>'}</td>
          <td class="num">${esc(fmt(e.value))}</td><td>${esc(e.unit)}${m && !ok ? ' <span class="z2">unit?</span>' : ''}</td>
          <td class="num ${ev ? zClass(ev.z) : ''}">${ev ? fmtP(ev.pct) : '–'}</td><td class="num muted">${ev ? fmtP(ev.modelPct) : '–'}</td>
          <td class="num ${ev ? zClass(ev.z) : ''}">${ev ? fmtZ(ev.z) : '–'}</td><td class="num ${ea ? zClass(ea.z) : ''}">${ea && ea.band ? fmtZ(ea.z) + ' <span class="muted">' + esc(ea.band) + '</span>' : '–'}</td>
          <td><button class="x" data-del="${esc(e.uid)}" title="Delete">&times;</button></td></tr>`;
      }).join('') + '</tbody></table>';
    $$('[data-del]', el).forEach((b) => (b.onclick = () => {
      state.entries = state.entries.filter((e) => e.uid !== b.dataset.del); save(); drawEntryTable(); renderSidebar();
    }));
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    $('#navToggle').onclick = () => $('#sidebar').classList.toggle('open');
    $('#sideFilter').oninput = renderSidebar;
    window.addEventListener('hashchange', render);
    window.addEventListener('storage', (e) => { if (e.key === KEY) { state = loadState(); render(); } });
    await loadData();
    render();
  }
  // exposed for debugging / headless checks
  window.BioApp = { app, get state() { return state; }, importCsv, evalEntry };
  boot();
})();
