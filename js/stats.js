/*
 * stats.js: pure Z-score / percentile / unit math. No DOM access.
 * Loaded by the browser as a global (window.BioStats) and by node tests via require().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BioStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // erf: W. J. Cody-style rational approximation via erfc (abs error < 1.2e-7).
  function erfc(x) {
    const z = Math.abs(x);
    const t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
      t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
      t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }

  /** Standard normal CDF. */
  function normCdf(z) {
    return 0.5 * erfc(-z / Math.SQRT2);
  }

  /** Inverse standard normal CDF (Acklam's algorithm, rel. error ~1e-9). */
  function normInv(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const pl = 0.02425;
    let q, r;
    if (p < pl) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - pl) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  // ---------- units ----------

  /** Loose unit key: case-insensitive, no spaces, µ/u unified. */
  function unitKey(u) {
    return String(u || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\s+/g, '').replace(/[µμ]/g, 'u').replace('mcg', 'ug')
      .replace(/^uiu\/ml$/, 'miu/l'); // µIU/mL and mIU/L are numerically identical (TSH)
  }

  /** All units a marker accepts: [{unit, factor}] where value_in_unit = value_primary * factor. */
  function markerUnits(marker) {
    const list = [{ unit: marker.unit, factor: 1 }];
    for (const a of marker.alt_units || []) if (a && a.unit && a.factor) list.push({ unit: a.unit, factor: Number(a.factor) });
    return list;
  }

  // Generic concentration units: [dimension, scale relative to the base unit].
  const PREFIX = { '': 1, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 };
  const VOL = { l: 1, dl: 0.1, ml: 1e-3 };
  function parseConc(u) {
    const m = unitKey(u).match(/^([munp]?)(g|mol)\/(l|dl|ml)$/);
    if (!m) return null;
    return { dim: m[2], scale: PREFIX[m[1]] / VOL[m[3]] };
  }

  /**
   * Factor for a unit (value_in_unit = value_primary * factor), or null if unknown.
   * Matches the marker's own units first; failing that, converts within the same dimension
   * (e.g. ng/mL <-> ng/dL, mmol/L <-> umol/L) from any known unit. Never crosses mass <-> molar.
   * opts.noApprox skips units labelled "approx".
   */
  function unitFactor(marker, unit, opts) {
    if (unit == null || unit === '') return 1; // blank unit means primary unit
    const k = unitKey(unit);
    const units = markerUnits(marker).filter((u) => !(opts && opts.noApprox && /approx/i.test(u.unit)));
    for (const u of units) if (unitKey(u.unit) === k) return u.factor;
    const target = parseConc(unit);
    if (target) {
      for (const u of units) {
        const src = parseConc(u.unit);
        if (src && src.dim === target.dim) return u.factor * src.scale / target.scale;
      }
    }
    return null;
  }

  /** Convert a value in `unit` to the marker's primary unit. Returns NaN if the unit is unknown. */
  function toPrimary(marker, value, unit) {
    const f = unitFactor(marker, unit);
    if (f == null) return NaN;
    return Number(value) / f;
  }

  /** Convert a primary-unit value to `unit`. */
  function fromPrimary(marker, value, unit) {
    const f = unitFactor(marker, unit);
    return f == null ? NaN : value * f;
  }

  // ---------- z and percentile ----------

  /**
   * Z-score of primary-unit value x against stats {mean, sd, log_mean, log_sd}.
   * log_scale true -> (ln x - log_mean) / log_sd, else (x - mean) / sd.
   */
  function zScore(x, stats, logScale) {
    if (!stats || !(x > -Infinity)) return NaN;
    if (logScale && stats.log_mean != null && stats.log_sd > 0) {
      if (!(x > 0)) return NaN;
      return (Math.log(x) - stats.log_mean) / stats.log_sd;
    }
    if (stats.mean != null && stats.sd > 0) return (x - stats.mean) / stats.sd;
    return NaN;
  }

  /** Sorted [[p, value], ...] from a {"5": v, ...} table, dropping nulls. */
  function pctTable(table) {
    return Object.entries(table || {})
      .filter(([, v]) => v != null)
      .map(([p, v]) => [Number(p), Number(v)])
      .filter(([p, v]) => isFinite(p) && isFinite(v))
      .sort((a, b) => a[0] - b[0]);
  }

  /**
   * Percentile (0-100) of x.
   * Inside the table's range: linear interpolation between neighbouring entries
   * (in ln space when logScale, since the table is roughly geometric there).
   * Outside it (the tails): normal CDF of z, clamped so it never contradicts the table end.
   * Returns {pct, method: 'empirical'|'normal-tail'|'normal'|null, model}, where model is normCdf(z)*100.
   */
  function percentile(x, stats, logScale, table) {
    const z = zScore(x, stats, logScale);
    const model = isFinite(z) ? normCdf(z) * 100 : NaN;
    const t = pctTable(table || (stats && (stats.percentiles || stats.p)));
    if (t.length < 2 || !isFinite(x)) {
      return { pct: model, method: isFinite(model) ? 'normal' : null, model, z };
    }
    const tr = logScale && x > 0 && t[0][1] > 0 ? (v) => Math.log(v) : (v) => v;
    const lo = t[0], hi = t[t.length - 1];
    if (x < lo[1]) {
      const pct = isFinite(model) ? Math.min(model, lo[0]) : NaN;
      return { pct, method: 'normal-tail', model, z };
    }
    if (x > hi[1]) {
      const pct = isFinite(model) ? Math.max(model, hi[0]) : NaN;
      return { pct, method: 'normal-tail', model, z };
    }
    // Interpolate on every segment containing x; with tied table values (e.g. a block of
    // results at the detection limit) x spans several segments, so take the middle of the span.
    const xv = tr(x);
    let first = null, last = null;
    for (let i = 0; i < t.length - 1; i++) {
      const [p0, v0] = t[i], [p1, v1] = t[i + 1];
      if (x >= v0 && x <= v1) {
        const a = tr(v0), b = tr(v1);
        const p = b === a ? null : p0 + (p1 - p0) * (xv - a) / (b - a);
        const lo = p == null ? p0 : p, hi = p == null ? p1 : p;
        if (first == null) first = lo;
        last = hi;
      }
    }
    if (first != null) return { pct: (first + last) / 2, method: 'empirical', model, z };
    return { pct: model, method: 'normal', model, z };
  }

  // ---------- age bands ----------

  /** Parse "20-29", "80+", "18–39" into {lo, hi}. */
  function parseBand(band) {
    const s = String(band).replace(/[–—]/g, '-');
    let m = s.match(/^\s*(\d+)\s*\+\s*$/);
    if (m) return { lo: +m[1], hi: Infinity };
    m = s.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    if (m) return { lo: +m[1], hi: +m[2] };
    m = s.match(/^\s*<\s*(\d+)\s*$/);
    if (m) return { lo: 0, hi: +m[1] - 1 };
    return null;
  }

  /** The by_age entry for an age, clamping to the first/last band. */
  function bandForAge(byAge, age) {
    if (!byAge || !byAge.length || !isFinite(age)) return null;
    let best = null;
    for (const b of byAge) {
      const r = parseBand(b.band);
      if (r && age >= r.lo && age < r.hi + 1) return b;
    }
    const parsed = byAge.map((b) => ({ b, r: parseBand(b.band) })).filter((o) => o.r);
    if (!parsed.length) return best;
    parsed.sort((a, b) => a.r.lo - b.r.lo);
    return age < parsed[0].r.lo ? parsed[0].b : parsed[parsed.length - 1].b;
  }

  /** Age in whole years at an ISO date given a birth year (mid-year assumption). */
  function ageAt(birthYear, isoDate) {
    if (!birthYear) return NaN;
    const d = isoDate ? new Date(isoDate) : new Date();
    const y = d.getFullYear() + d.getMonth() / 12;
    return Math.floor(y - (Number(birthYear) + 0.5));
  }

  /** True if a marker has usable population data for a sex. */
  function sexStats(marker, sex) {
    if (!marker || marker.population === null || !marker.sexes) return null;
    const s = marker.sexes[sex];
    return s && (s.mean != null || s.log_mean != null) ? s : null;
  }

  /**
   * Full evaluation of one value.
   * opts: {sex, age, ageAdjusted}
   * Returns {x (primary), z, pct, pctMethod, modelPct, band} or null fields when not computable.
   */
  function evaluate(marker, value, unit, opts) {
    const x = toPrimary(marker, value, unit);
    const out = { x, z: NaN, pct: NaN, pctMethod: null, modelPct: NaN, band: null, unitOk: isFinite(x) };
    const s = sexStats(marker, opts && opts.sex);
    if (!s || !isFinite(x)) return out;
    let stats = s, table = s.percentiles;
    if (opts.ageAdjusted && s.by_age && isFinite(opts.age)) {
      const b = bandForAge(s.by_age, opts.age);
      if (b && (b.mean != null || b.log_mean != null)) { stats = b; table = b.p; out.band = b.band; }
    }
    const r = percentile(x, stats, !!marker.log_scale, table);
    out.z = r.z; out.pct = r.pct; out.pctMethod = r.method; out.modelPct = r.model;
    return out;
  }

  // ---------- marker-name aliases (for CSV import) ----------

  const ALIAS_GROUPS = [
    ['testosterone total', 'total testosterone', 'testosterone', 'testosterone serum', 'tt', 'testosterone total ms', 'testosterone total lc ms ms'],
    ['testosterone free', 'free testosterone', 'ft', 'free t', 'testosterone free calculated', 'calculated free testosterone'],
    ['testosterone bioavailable', 'bioavailable testosterone'],
    ['estradiol', 'e2', 'oestradiol', 'estradiol sensitive', 'estradiol ultrasensitive'],
    ['shbg', 'sex hormone binding globulin', 'sex hormone binding globulin shbg'],
    ['lh', 'luteinizing hormone', 'luteinising hormone'],
    ['fsh', 'follicle stimulating hormone'],
    ['prolactin', 'prl'],
    ['dhea s', 'dheas', 'dhea sulfate dhea s', 'dhea sulfate', 'dhea sulphate', 'dehydroepiandrosterone sulfate'],
    ['progesterone'],
    ['tsh', 'thyroid stimulating hormone', 'thyrotropin'],
    ['free t4', 'ft4', 't4 free', 'free thyroxine', 'thyroxine free', 'free t4 direct'],
    ['free t3', 'ft3', 't3 free', 'free triiodothyronine', 'triiodothyronine free'],
    ['total t4', 't4', 't4 total', 'thyroxine', 'thyroxine total'],
    ['total t3', 't3', 't3 total', 'triiodothyronine'],
    ['tpo', 'tpo antibodies', 'thyroid peroxidase antibodies', 'anti tpo'],
    ['ldl', 'ldl c', 'ldl cholesterol', 'ldl cholesterol calc', 'ldl chol calc nih', 'ldl direct', 'low density lipoprotein', 'ldl chol'],
    ['hdl', 'hdl c', 'hdl cholesterol', 'high density lipoprotein', 'hdl chol'],
    ['total cholesterol', 'cholesterol', 'cholesterol total', 'tc', 'chol'],
    ['triglycerides', 'triglyceride', 'tg', 'trig', 'trigs'],
    ['apob', 'apo b', 'apolipoprotein b', 'apolipoprotein b100'],
    ['lp a', 'lpa', 'lipoprotein a', 'lipoprotein little a'],
    ['non hdl cholesterol', 'non hdl', 'non hdl c'],
    ['hba1c', 'a1c', 'hemoglobin a1c', 'haemoglobin a1c', 'glycohemoglobin', 'glycated hemoglobin', 'glycosylated hemoglobin'],
    ['glucose', 'fasting glucose', 'glucose fasting', 'blood glucose', 'glucose serum'],
    ['insulin', 'fasting insulin', 'insulin fasting'],
    ['hs crp', 'hscrp', 'crp', 'c reactive protein', 'high sensitivity crp', 'c reactive protein cardiac', 'crp high sensitivity'],
    ['ferritin', 'ferritin serum'],
    ['serum iron', 'iron', 'iron total', 'iron serum', 'fe'],
    ['tibc', 'total iron binding capacity', 'iron binding capacity', 'iron binding capacity total'],
    ['transferrin saturation', 'transferrin sat', 'tsat', 'iron saturation', 'percent saturation', 'iron saturation percent', 'saturation'],
    ['transferrin'],
    ['vitamin d', '25 oh vitamin d', 'vitamin d 25 hydroxy', '25 hydroxyvitamin d', 'vit d', 'vitamin d 25 oh total'],
    ['creatinine', 'creatinine serum'],
    ['alt', 'alanine aminotransferase', 'sgpt', 'alt sgpt'],
    ['ast', 'aspartate aminotransferase', 'sgot', 'ast sgot'],
    ['ggt', 'gamma glutamyl transferase', 'gamma gt'],
    ['albumin', 'albumin serum'],
    ['psa', 'prostate specific antigen', 'psa total'],
    ['cortisol', 'cortisol am'],
    ['igf 1', 'igf1', 'insulin like growth factor 1', 'somatomedin c'],
    ['homocysteine'],
    ['uric acid', 'urate'],
    ['hemoglobin', 'haemoglobin', 'hgb', 'hb'],
    ['hematocrit', 'haematocrit', 'hct'],
  ];

  /** "Testosterone, Total (LC/MS)" -> "testosterone total lc ms" */
  function normName(s) {
    return String(s || '').toLowerCase().replace(/[µμ]/g, 'u').replace(/_/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function sortedTokens(s) { return normName(s).split(' ').filter(Boolean).sort().join(' '); }

  const aliasIndex = new Map();
  ALIAS_GROUPS.forEach((g, i) => g.forEach((a) => { aliasIndex.set(normName(a), i); aliasIndex.set(sortedTokens(a), i); }));

  function groupOf(s) {
    const n = normName(s);
    if (aliasIndex.has(n)) return aliasIndex.get(n);
    const st = sortedTokens(s);
    if (aliasIndex.has(st)) return aliasIndex.get(st);
    // retry without a trailing parenthetical / "serum" / "calc" style qualifiers
    const stripped = normName(String(s).replace(/\(.*?\)/g, ' ')).replace(/\b(serum|plasma|blood|calc|calculated|direct|level)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (aliasIndex.has(stripped)) return aliasIndex.get(stripped);
    if (aliasIndex.has(sortedTokens(stripped))) return aliasIndex.get(sortedTokens(stripped));
    return -1;
  }

  /**
   * Map a loose marker name to a marker id from `markers` ([{id, name}]).
   * Tries exact id/name (also with words reordered), then alias groups.
   */
  function resolveMarker(input, markers) {
    if (!input) return null;
    const n = normName(input), st = sortedTokens(input);
    for (const m of markers) {
      if (normName(m.id) === n || normName(m.name) === n || sortedTokens(m.id) === st || sortedTokens(m.name) === st) return m.id;
      for (const a of m.aliases || []) if (normName(a) === n || sortedTokens(a) === st) return m.id;
    }
    const g = groupOf(input);
    if (g < 0) return null;
    for (const m of markers) {
      if (groupOf(m.id) === g || groupOf(m.name) === g) return m.id;
    }
    return null;
  }

  /** Minimal CSV parser (handles quoted fields with commas and doubled quotes). */
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', q = false;
    text = String(text).replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some((f) => f.trim() !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    return rows;
  }

  /** Normalise a date string to YYYY-MM-DD, or null. Accepts ISO, YYYY/MM/DD, MM/DD/YYYY. */
  function normDate(s) {
    s = String(s || '').trim();
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; // US order
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }

  // ---------- lab-report text extraction (PDF text layer or OCR output) ----------

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const DATE_RE = /(\d{4}-\d{1,2}-\d{1,2})|(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})|((jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i;

  /** One date string from a report -> YYYY-MM-DD (US month/day order for slashes; 2-digit years -> 20xx). */
  function reportDate(s) {
    let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/);
    if (m) s = `${m[1]}/${m[2]}/20${m[3]}`;
    m = s.match(/^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
    if (m) { const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()]; return mo ? `${m[3]}-${String(mo).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; }
    return normDate(s.replace(/[.-]/g, '/').replace(/^(\d{4})\/(\d+)\/(\d+)$/, '$1-$2-$3'));
  }

  /** Collection date of a report: prefers a date labelled collected/drawn/specimen, else the first date found. */
  function findReportDate(text) {
    const lines = String(text).split(/\n/);
    for (const re of [/collect|drawn|specimen/i, /received|reported|date/i]) {
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]) || /birth|dob/i.test(lines[i])) continue;
        // label and value are often split across adjacent lines in PDF tables
        const m = (lines[i] + ' ' + (lines[i + 1] || '')).slice(lines[i].search(re)).match(DATE_RE);
        if (m) { const d = reportDate(m[0]); if (d) return d; }
      }
    }
    for (const l of lines) { if (/birth|dob/i.test(l)) continue; const m = l.match(DATE_RE); if (m) { const d = reportDate(m[0]); if (d) return d; } }
    return null;
  }

  const NUM_TOKEN = /^[<>≤≥]?\d[\d,]*(\.\d+)?$/;
  const FLAG_TOKEN = /^(h|l|hi|lo|high|low|a|abn|abnormal|\*+|[↑↓])$/i;

  /**
   * Pull marker values out of report text, one result per line ("<name> <value> [flag] [range] <unit>").
   * `markers`: full marker objects (id, name, unit, alt_units, aliases). Returns
   * { date, rows: [{marker, value, unit, line, unitOk}] } with the first value per marker.
   */
  function extractLabs(text, markers) {
    const rows = [], seen = new Set();
    for (const raw of String(text).split(/\n/)) {
      // OCR reads I and 1 as l: "ulU/mL" -> uIU/mL, "Hemoglobin Alc" -> A1c
      const line = raw.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/\b([um])lU\//gi, '$1IU/').replace(/\bAlc\b/g, 'A1c');
      const tok = line.split(' ');
      const ni = tok.findIndex((t, i) => i > 0 && NUM_TOKEN.test(t));
      if (ni < 1) continue;
      // Labcorp puts a performing-lab code ("01") between name and result
      const vi = /^0\d$/.test(tok[ni]) && NUM_TOKEN.test(tok[ni + 1] || '') ? ni + 1 : ni;
      // name = words before the value; allow up to two leading junk words ("Result:", a test code)
      let id = null;
      for (let s = 0; s <= Math.min(2, ni - 1) && !id; s++) id = resolveMarker(tok.slice(s, ni).join(' '), markers);
      if (!id || seen.has(id)) continue;
      const m = markers.find((x) => x.id === id);
      const value = parseFloat(tok[vi].replace(/[<>≤≥,]/g, ''));
      if (!isFinite(value)) continue;
      // unit: first later token the marker recognises (skips flags and reference ranges)
      let unit = '';
      for (let j = vi + 1; j < tok.length && j <= vi + 6; j++) {
        if (FLAG_TOKEN.test(tok[j]) || /\d/.test(tok[j]) && !/[a-z]/i.test(tok[j])) continue;
        if (unitFactor(m, tok[j]) != null) { unit = (markerUnits(m).find((u) => unitKey(u.unit) === unitKey(tok[j])) || { unit: tok[j] }).unit; break; }
      }
      seen.add(id);
      rows.push({ marker: id, value, unit: unit || m.unit, unitOk: !!unit, line });
    }
    return { date: findReportDate(text), rows };
  }

  return {
    normCdf, normInv, erfc,
    unitKey, markerUnits, unitFactor, toPrimary, fromPrimary,
    zScore, percentile, pctTable,
    parseBand, bandForAge, ageAt, sexStats, evaluate,
    normName, resolveMarker, ALIAS_GROUPS,
    parseCsv, normDate, extractLabs, findReportDate,
  };
});
