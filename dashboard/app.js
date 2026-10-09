/* TB decision support dashboard.
 *
 * Two data modes, one interface:
 *   snapshot  the pipeline snapshot embedded in the page (`D`, from dashboard_data.json). Works offline; actions stay in this browser.
 *   live      signed in to the FastAPI service. Views are scoped by the server to the account's role, and actions are saved
 *             and audit-logged. Evidence that the API does not serve (state series, validation) still comes from the snapshot.
 *
 * No external libraries: charts are hand-built SVG/CSS so the page works on restricted networks.
 * Data values are always inserted with textContent (via el()), never as HTML.
 */
(function () {
'use strict';

const SNAP = D;
const NS = 'http://www.w3.org/2000/svg';
const $ = (sel, root = document) => root.querySelector(sel);
if (!SNAP) {
  $('#view').textContent = 'No data snapshot is embedded in this page. Build it with: python -m tbds.cli build-dashboard';
  return;
}

// ---------------------------------------------------------------- DOM helpers
function setAttrs(n, a) {
  if (!a) return;
  for (const [k, v] of Object.entries(a)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
}
function addKids(n, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false || k === '') continue;
    n.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
}
function el(tag, attrs, ...kids) { const n = document.createElement(tag); setAttrs(n, attrs); return addKids(n, kids); }
function sv(tag, attrs, ...kids) { const n = document.createElementNS(NS, tag); setAttrs(n, attrs); return addKids(n, kids); }

// ---------------------------------------------------------------- formatting
const nf = new Intl.NumberFormat('en-IN');
const num = x => (x == null || Number.isNaN(x)) ? '–' : nf.format(Math.round(x));
const pct = (x, d = 1) => x == null ? '–' : (x * 100).toFixed(d) + '%';
const fx = (x, d = 2) => x == null ? '–' : Number(x).toFixed(d);
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : (many || one + 's')}`;
function fmtDate(s) {
  if (!s) return '–';
  const d = new Date(String(s).length === 10 ? s + 'T00:00:00' : s);
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateTime(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function monthLabel(m) { const [y, mo] = m.split('-'); return new Date(+y, +mo - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }); }

// ---------------------------------------------------------------- vocabulary
const TABS = { overview: 'Overview', districts: 'Districts', facilities: 'Facilities', review: 'Patient risk', gaps: 'Care gaps', duplicates: 'De-duplication', deaths: 'Death audit', evidence: 'Model evidence' };
const ROLES = [
  { id: 'state', label: 'State TB Cell', tabs: ['overview', 'districts', 'facilities', 'review', 'gaps', 'duplicates', 'deaths', 'evidence'] },
  { id: 'district', label: 'District officer', tabs: ['overview', 'facilities', 'review', 'gaps', 'duplicates', 'deaths', 'evidence'] },
  { id: 'facility', label: 'Facility team', tabs: ['overview', 'review', 'gaps', 'evidence'] },
  { id: 'data', label: 'Data manager', tabs: ['overview', 'duplicates', 'evidence'] },
];
const API_ROLE = { state_admin: 'state', data_manager: 'data', district_officer: 'district', facility_user: 'facility', field_worker: 'facility' };
const API_ROLE_LABEL = { state_admin: 'State admin', data_manager: 'Data manager', district_officer: 'District TB officer', facility_user: 'Facility user', field_worker: 'Field worker' };
const GAP = {
  missed_follow_up: { label: 'Missed follow-up', rule: 'On treatment with no follow-up contact for more than 14 days' },
  tested_not_notified: { label: 'Tested positive, not notified', rule: 'Positive test result not notified within 3 days' },
  notified_not_started: { label: 'Notified, treatment not started', rule: 'Notified but treatment not started within 7 days' },
  referral_not_closed: { label: 'Referral not closed', rule: 'Referral still open after 14 days' },
};
const GAP_KEYS = Object.keys(GAP);
const PRI = { supervise_first: 'Supervise first', watch: 'Watch', routine: 'Routine' };
const TIER = { high: 'High', medium: 'Medium', standard: 'Standard' };
const SEV = { severe: ['high', 'Severe'], high: ['medium', 'High'], moderate: ['standard', 'Moderate'] };
const LIST = { early_death: 'Early death', unfavourable_outcome: 'Unfavourable outcome' };
const LIST_LONG = { early_death: 'Death within 60 days of starting treatment', unfavourable_outcome: 'Death, loss to follow-up or treatment failure' };
const PTIER = { highest_strain: 'Highest strain', elevated: 'Elevated', lower: 'Lower' };
const DEMAND = { rising: '▲ Rising', stable: '● Stable', falling: '▼ Falling' };
const ACTIONS = { reviewed: 'Reviewed', acted: 'Action taken', disagree: 'Disagree with flag', not_applicable: 'Not applicable' };
const FIELDS = { first: 'First name', last: 'Last name', guardian: "Guardian's name", age: 'Age', phone: 'Phone', village: 'Village', district: 'District', dates: 'Dates', sex: 'Sex' };
const ORL = {
  age_60_74: 'Age 60 to 74', age_75p: 'Age 75 or older', age_lt15: 'Age under 15', alcohol: 'Alcohol use', bact_unknown: 'Bacteriological status unknown',
  bmi_16_185: 'Moderate undernutrition (BMI 16 to 18.5)', bmi_lt16: 'Severe undernutrition (BMI below 16)', bmi_missing: 'BMI not recorded',
  delay_8_14: 'Treatment started 8 to 14 days after diagnosis', delay_15_30: 'Treatment started 15 to 30 days after diagnosis',
  delay_gt30: 'Treatment started more than 30 days after diagnosis', diabetes: 'Diabetes', diabetes_unknown: 'Diabetes status unknown',
  drug_resistant: 'Drug-resistant TB', extrapulmonary: 'Extrapulmonary TB', hard_to_reach_district: 'Hard-to-reach district', hiv_pos: 'HIV positive',
  hiv_unknown: 'HIV status unknown', male: 'Male', migrant: 'Migrant worker', missed_1_3: '1 to 3 doses missed in first month',
  missed_4_7: '4 to 7 doses missed in first month', missed_8p: '8 or more doses missed in first month', no_npy15: 'No Nikshay Poshan enrolment by day 15',
  not_bact_confirmed: 'Not bacteriologically confirmed', prior_tb: 'Previous TB treatment', private_sector: 'Notified by private sector',
  tea_garden: 'Tea garden worker', tobacco: 'Tobacco use', tribal: 'Tribal community',
};
const MISS = { age: 'Age', sex: 'Sex', bmi: 'BMI', hiv_positive: 'HIV status', diabetes: 'Diabetes status', bact_confirmed: 'Bacteriological confirmation', treatment_start_date: 'Treatment start date', diag_to_start_days: 'Diagnosis-to-start interval' };
const RULES = { age_outside_0_100: 'Age outside 0–100', bmi_implausible_lt10_or_gt50: 'Implausible BMI (below 10 or above 50)', treatment_start_before_diagnosis: 'Treatment start before diagnosis', death_before_treatment_start: 'Death before treatment start', notification_in_future: 'Notification date in the future', diag_to_start_negative: 'Negative diagnosis-to-start interval' };

// ---------------------------------------------------------------- persistence (per-viewer conveniences only)
function storeGet(area, k, d) { try { const v = window[area].getItem('tbds:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function storeSet(area, k, v) { try { if (v == null) window[area].removeItem('tbds:' + k); else window[area].setItem('tbds:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }

// ---------------------------------------------------------------- state
const pilotFacilities = SNAP.facilities.filter(f => f.pilot);
const S = {
  data: SNAP,
  role: 'state',
  district: SNAP.meta.pilot[0],
  facility: (pilotFacilities[0] || {}).id || null,
  tab: 'overview',
  list: 'early_death',
  model: 'early_death',
  sort: {}, limit: {}, f: {},
  actions: storeGet('localStorage', 'actions', {}),
  decisions: storeGet('localStorage', 'decisions', {}),
  live: null,   // {api, token, me}
};
const NAME = {};
SNAP.facilities.forEach(f => { NAME[f.id] = f.name; });
const facName = id => NAME[id] || id || '–';
const isLive = () => !!S.live;
const roleDef = () => ROLES.find(r => r.id === S.role);
const isPilot = d => S.data.meta.pilot.includes(d);

// ---------------------------------------------------------------- scoping
function scoped() {
  const d = S.data, r = S.role;
  const okD = dist => (r !== 'district' && r !== 'facility') || dist === S.district;
  const okF = (fid, dist) => r === 'facility' ? fid === S.facility : okD(dist);
  const da = d.death_audit;
  return {
    facilities: d.facilities.filter(f => okF(f.id, f.district)),
    districts: d.districts.filter(x => okD(x.district)),
    review: d.review.filter(p => okF(p.facility, p.district)),
    gaps: d.gaps.filter(g => okF(g.facility, g.district)),
    dups: r === 'facility' ? [] : d.duplicates.filter(p => r !== 'district' || p.district === S.district),
    deathQ: da ? da.queue.filter(q => okF(q.facility_id, q.district)) : [],
    flagged: da ? da.flagged_facilities.filter(f => okF(f.facility_id, f.district)) : [],
  };
}
function gapCounts() {
  const d = S.data;
  if (isLive() || S.role === 'state' || S.role === 'data') return Object.assign(zeroGaps(), d.gap_totals);
  if (S.role === 'district') { const x = d.districts.find(z => z.district === S.district); return x ? x.synthetic.gaps : zeroGaps(); }
  const f = d.facilities.find(z => z.id === S.facility); return f ? f.gaps : zeroGaps();
}
function onTreatment() {
  const d = S.data;
  if (isLive()) return d.kpi.on_treatment;
  if (S.role === 'district') { const x = d.districts.find(z => z.district === S.district); return x ? x.synthetic.on_treatment : null; }
  if (S.role === 'facility') { const f = d.facilities.find(z => z.id === S.facility); return f ? f.on_treatment : null; }
  return d.districts.reduce((a, x) => a + (x.synthetic.on_treatment || 0), 0);
}
function pendingDups(sc) {
  if (isLive()) return S.data.kpi.pending_dups;
  if (S.role === 'state' || S.role === 'data') return S.data.dedup_eval.review.pairs_flagged;
  return sc.dups.length;
}
function scopeName() {
  if (S.role === 'district') return S.district + ' district';
  if (S.role === 'facility') return facName(S.facility);
  return 'Assam';
}
const zeroGaps = () => ({ tested_not_notified: 0, notified_not_started: 0, referral_not_closed: 0, missed_follow_up: 0 });
const sumGaps = g => GAP_KEYS.reduce((a, k) => a + (g[k] || 0), 0);

// ---------------------------------------------------------------- small UI pieces
function prov(kind) {
  return kind === 'real'
    ? el('span', { class: 'prov real', title: 'Published NHM Assam data' }, 'Real · NHM Assam')
    : el('span', { class: 'prov syn', title: isLive() && S.data.meta.source === 'extract' ? 'Programme extract' : 'Generated data, for demonstration' }, S.data.meta.source === 'extract' ? 'Programme extract' : 'Synthetic');
}
function badge(cls, text) { return el('span', { class: cls }, text); }
const tierBadge = t => badge('tier ' + t, TIER[t] || t);
const priBadge = p => badge('pri ' + p, PRI[p] || p);
function sevBadge(s) { const [c, l] = SEV[s] || ['standard', s]; return badge('tier ' + c, l); }
/* A titled card. o.bare renders a heading row without the card frame, for bodies that are themselves rows of cards. */
function section(title, o, ...body) {
  o = o || {};
  const head = [el('div', { class: 'grow' },
    el('div', { class: 'row', style: { gap: '6px 10px' } }, el('h2', { text: title }), o.prov ? [].concat(o.prov).map(prov) : null),
    o.desc ? el('div', { class: 'sub', text: o.desc }) : null),
    o.right ? el('div', { class: 'right' }, o.right) : null];
  if (o.bare) return el('section', { class: 'sec', id: o.id }, el('div', { class: 'sec-hd' }, head), body);
  return el('section', { class: 'card', id: o.id }, el('div', { class: 'card-hd' }, head), el('div', { class: 'card-bd' + (o.flush ? ' flush' : '') }, body));
}
/* Sets the header title for the current view; returns the optional one-line introduction. */
function pageHead(title, lede) {
  S.title = title;
  return lede ? el('p', { class: 'lede', text: lede }) : null;
}
function card(title, sub, right, ...body) {
  return el('div', { class: 'card' },
    el('div', { class: 'card-hd' }, el('div', { class: 'grow' }, el('h2', { text: title }), sub ? el('div', { class: 'sub', text: sub }) : null), right ? el('div', { class: 'right' }, right) : null),
    body);
}
const lvl = t => el('span', { class: 'lvl ' + t }, el('i'), ({ high: 'HIGH', medium: 'MED', standard: 'STD' })[t] || t);
function kpi({ label, value, sub, tone, go }) {
  return el(go ? 'button' : 'div', { class: 'kpi' + (tone ? ' ' + tone : ''), type: go ? 'button' : null, onclick: go ? () => goTab(go) : null },
    el('span', { class: 'l', text: label }), el('span', { class: 'v', text: value }), sub ? el('span', { class: 's', text: sub }) : null);
}
function kv(pairs) { return el('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [el('dt', { text: k }), el('dd', null, v == null ? '–' : v)])); }
function callout(kind, ...kids) { return el('div', { class: 'callout' + (kind ? ' ' + kind : '') }, kids); }
function seg(label, options, value, onPick) {
  return el('div', { class: 'seg', role: 'group', 'aria-label': label },
    Object.entries(options).map(([k, v]) => el('button', { type: 'button', 'aria-pressed': String(k === value), onclick: () => onPick(k) }, v)));
}
function select(label, options, value, onPick) {
  const s = el('select', { 'aria-label': label, onchange: e => onPick(e.target.value) },
    options.map(o => o.group
      ? el('optgroup', { label: o.group }, o.items.map(i => el('option', { value: i.value, selected: i.value === value }, i.label)))
      : el('option', { value: o.value, selected: o.value === value }, o.label)));
  return el('label', null, label, s);
}
function cellBar(v, max, txt, cls) {
  const w = max > 0 ? Math.max(2, Math.min(100, (v / max) * 100)) : 0;
  return el('div', { class: 'cellbar' }, el('b', { text: txt }), el('span', { class: 'track' }, el('span', { class: 'bar' + (cls ? ' ' + cls : ''), style: { width: w + '%' } })));
}
function emptyState(text) { return el('div', { class: 'empty', text }); }

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3800);
}

// ---------------------------------------------------------------- tooltip
const tipEl = $('#tip');
function placeTip(x, y) {
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let L = x + 14, T = y - h - 12;
  if (L + w > innerWidth - 8) L = x - w - 14;
  if (L < 8) L = 8;
  if (T < 8) T = y + 18;
  tipEl.style.left = L + 'px'; tipEl.style.top = T + 'px';
}
function hideTip() { tipEl.style.display = 'none'; }
/* fn() -> {title, rows:[{v, k, c}]}; c is a CSS colour token for the row key */
function hover(node, fn, focusable = true) {
  const fill = () => {
    const c = fn();
    tipEl.replaceChildren(
      c.title ? el('div', { class: 'tt', text: c.title }) : null,
      ...(c.rows || []).map(r => el('div', { class: 'tr' }, r.c ? el('i', { style: { background: r.c } }) : null, el('b', { text: r.v }), el('span', { text: r.k })))
    );
    tipEl.style.display = 'block';
  };
  node.addEventListener('pointerenter', e => { fill(); placeTip(e.clientX, e.clientY); });
  node.addEventListener('pointermove', e => placeTip(e.clientX, e.clientY));
  node.addEventListener('pointerleave', hideTip);
  if (focusable) {
    if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '0');
    node.addEventListener('focus', () => { fill(); const b = node.getBoundingClientRect(); placeTip(b.left + b.width / 2, b.top); });
    node.addEventListener('blur', hideTip);
  }
  const c = fn();
  node.setAttribute('aria-label', [c.title, ...(c.rows || []).map(r => `${r.k}: ${r.v}`)].filter(Boolean).join('. '));
}

// ---------------------------------------------------------------- charts
const ticks = (min, max, n = 5) => {
  const span = max - min || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || step0;
  const out = []; for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10)); return out;
};
function topRounded(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function legend(items) {
  return el('div', { class: 'lg' }, items.map(([cls, label, color]) => el('span', null, el('i', { class: cls, style: color ? { background: color } : null }), label)));
}
function dataTableDetails(summary, headers, rows) {
  return el('details', { class: 'data' }, el('summary', { text: summary }),
    el('div', { class: 'scroll' }, el('table', null,
      el('thead', null, el('tr', null, headers.map((h, i) => el('th', { class: i ? 'r' : null, text: h })))),
      el('tbody', null, rows.map(r => el('tr', null, r.map((c, i) => el('td', { class: i ? 'r' : null, text: c }))))))));
}

/* Vertical bar chart. data: [{label, y, cls, title, rows}] */
const chartW = () => (innerWidth < 640 ? 420 : 640);
function barChart(data, { h = 230, yfmt = num, every = 1, marker = null, ariaLabel = '' } = {}) {
  const W = chartW(), m = { t: 14, r: 10, b: 30, l: 46 };
  const iw = W - m.l - m.r, ih = h - m.t - m.b;
  const ymax = Math.max(...data.map(d => d.y)) * 1.08 || 1;
  const yt = ticks(0, ymax, 4), ytop = yt[yt.length - 1] < ymax ? ymax : yt[yt.length - 1];
  const Y = v => m.t + ih - (v / ytop) * ih;
  const bw = iw / data.length, gap = Math.max(2, bw * 0.18);
  if (W < 640 && every > 1) every = Math.ceil(every * 1.6);
  const s = sv('svg', { class: 'ch chart', viewBox: `0 0 ${W} ${h}`, role: 'img', 'aria-label': ariaLabel });
  const ax = sv('g', { class: 'ax' });
  yt.forEach(v => { ax.append(sv('line', { class: 'gl', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }), sv('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, yfmt(v))); });
  data.forEach((d, i) => { if (i % every === 0) ax.append(sv('text', { x: m.l + bw * i + bw / 2, y: h - 10, 'text-anchor': 'middle' }, d.label)); });
  s.append(ax);
  if (marker != null) {
    const x = m.l + bw * marker;
    s.append(sv('line', { class: 'ref', x1: x, x2: x, y1: m.t - 4, y2: m.t + ih }));
  }
  data.forEach((d, i) => {
    const x = m.l + bw * i + gap / 2, w = bw - gap, y = Y(d.y), bh = m.t + ih - y;
    const g = sv('g', { class: 'pt' },
      sv('rect', { class: 'hit', x: m.l + bw * i, y: m.t, width: bw, height: ih }),
      sv('path', { class: 'mk ' + (d.cls || 'c1'), d: topRounded(x, y, w, Math.max(bh, 0.5), 4) }));
    hover(g, () => ({ title: d.title || d.label, rows: d.rows || [{ v: yfmt(d.y), k: '' }] }));
    s.append(g);
  });
  s.append(sv('line', { class: 'base', x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih }));
  return s;
}

/* Line chart with points; hovering anywhere in a column snaps to that point. data: [{label, y, title, rows}] */
function lineChart(data, { h = 230, yfmt = num, yMin = null, ariaLabel = '', endLabel = true } = {}) {
  const W = chartW(), m = { t: 18, r: 54, b: 30, l: 46 };
  const iw = W - m.l - m.r, ih = h - m.t - m.b;
  const ys = data.map(d => d.y), lo = yMin == null ? Math.min(...ys) * 0.9 : yMin, hi = Math.max(...ys) * 1.06;
  const yt = ticks(lo, hi, 4);
  const y0 = Math.min(lo, yt[0]), y1 = Math.max(hi, yt[yt.length - 1]);
  const X = i => m.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const Y = v => m.t + ih - ((v - y0) / (y1 - y0)) * ih;
  const s = sv('svg', { class: 'ch chart', viewBox: `0 0 ${W} ${h}`, role: 'img', 'aria-label': ariaLabel });
  const ax = sv('g', { class: 'ax' });
  yt.forEach(v => ax.append(sv('line', { class: 'gl', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }), sv('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, yfmt(v))));
  data.forEach((d, i) => ax.append(sv('text', { x: X(i), y: h - 10, 'text-anchor': 'middle' }, d.label)));
  s.append(ax, sv('path', { class: 's1', d: data.map((d, i) => (i ? 'L' : 'M') + X(i) + ',' + Y(d.y)).join('') }));
  const xh = sv('line', { class: 'xh', x1: 0, x2: 0, y1: m.t, y2: m.t + ih, visibility: 'hidden' });
  s.append(xh);
  const colW = data.length > 1 ? iw / (data.length - 1) : iw;
  data.forEach((d, i) => {
    const g = sv('g', { class: 'pt' },
      sv('rect', { class: 'hit', x: X(i) - colW / 2, y: m.t, width: colW, height: ih }),
      sv('circle', { class: 'mk c1 ring', cx: X(i), cy: Y(d.y), r: 4.5 }));
    g.addEventListener('pointerenter', () => { xh.setAttribute('x1', X(i)); xh.setAttribute('x2', X(i)); xh.setAttribute('visibility', 'visible'); });
    g.addEventListener('pointerleave', () => xh.setAttribute('visibility', 'hidden'));
    hover(g, () => ({ title: d.title || d.label, rows: d.rows || [{ v: yfmt(d.y), k: '' }] }));
    s.append(g);
  });
  if (endLabel) { const L = data[data.length - 1]; s.append(sv('text', { class: 'lblb', x: X(data.length - 1) + 9, y: Y(L.y) + 4 }, yfmt(L.y))); }
  return s;
}

/* Rows of label | horizontal strip | value, drawn in HTML so long labels wrap and marks never distort.
   rows: [{label, v, lo, hi, cls, value, tip}] */
function stripRows(rows, { min, max, log = false, ref = null, mode = 'dot', head = null }) {
  const T = v => log ? Math.log(v) : v;
  const P = v => Math.max(0, Math.min(100, ((T(v) - T(min)) / (T(max) - T(min))) * 100));
  const g = el('div', { class: 'forest' });
  if (head) g.append(el('div', { class: 'frow hd', 'aria-hidden': 'true' }, el('span', { text: head[0] }), el('span', { text: head[1] }), el('span', { class: 'fv', text: head[2] })));
  rows.forEach(r => {
    const strip = el('div', { class: 'strip' }, el('span', { class: 'axisl' }));
    if (ref != null) strip.append(el('span', { class: 'refl', style: { left: P(ref) + '%' } }));
    if (mode === 'bar') {
      const a = P(ref != null ? ref : min), b = P(r.v);
      strip.append(el('span', { class: 'bx ' + (r.cls || '') + (b < a ? ' neg' : ''), style: { left: Math.min(a, b) + '%', width: Math.max(0.6, Math.abs(b - a)) + '%' } }));
      if (r.marker != null) strip.append(el('span', { class: 'tick', style: { left: P(r.marker) + '%' } }));
    } else {
      if (r.lo != null && r.hi != null) strip.append(el('span', { class: 'ci ' + (r.cls || ''), style: { left: P(r.lo) + '%', width: Math.max(0.5, P(r.hi) - P(r.lo)) + '%' } }));
      if (r.v2 != null) strip.append(el('span', { class: 'dt hol', style: { left: P(r.v2) + '%' } }));
      strip.append(el('span', { class: 'dt ' + (r.cls || ''), style: { left: P(r.v) + '%' } }));
    }
    const row = el('div', { class: 'frow' }, el('span', { class: 'fl', text: r.label }), strip, el('span', { class: 'fv' }, r.value));
    if (r.tip) hover(row, r.tip);
    g.append(row);
  });
  return g;
}

/* District scatter: REAL planning strain (x) vs SYNTHETIC outcome index (y). */
function districtScatter(districts, onPick) {
  const W = chartW(), H = W < 640 ? 360 : 400, m = { t: 30, r: 20, b: 48, l: 52 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const X = v => m.l + (v / 100) * iw, Y = v => m.t + ih - (v / 100) * ih;
  const s = sv('svg', { class: 'ch chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Districts by planning strain and outcome index' });
  const ax = sv('g', { class: 'ax' });
  [0, 25, 50, 75, 100].forEach(v => ax.append(
    sv('line', { class: 'gl', x1: X(v), x2: X(v), y1: m.t, y2: m.t + ih }), sv('line', { class: 'gl', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }),
    sv('text', { x: X(v), y: m.t + ih + 16, 'text-anchor': 'middle' }, v), sv('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, v)));
  ax.append(sv('text', { x: m.l + iw / 2, y: H - 8, 'text-anchor': 'middle' }, 'Planning strain, percentile (real RoP 2024-26)'));
  ax.append(sv('text', { x: 14, y: m.t + ih / 2, 'text-anchor': 'middle', transform: `rotate(-90 14 ${m.t + ih / 2})` }, 'Outcome index, percentile (synthetic)'));
  s.append(ax);
  s.append(sv('line', { class: 'ref', x1: X(50), x2: X(50), y1: m.t, y2: m.t + ih }), sv('line', { class: 'ref', x1: m.l, x2: W - m.r, y1: Y(50), y2: Y(50) }));
  s.append(sv('text', { class: 'quad', x: X(75), y: m.t - 10, 'text-anchor': 'middle' }, '↗ Strained and poorer outcomes'));
  s.append(sv('text', { class: 'quad', x: X(25), y: m.t - 10, 'text-anchor': 'middle' }, 'Poorer outcomes, less strain'));
  const placed = [];
  const pts = districts.filter(d => d.real.planning_strain_score != null && d.synthetic.outcome_index != null);
  const labelled = new Set(pts.filter(d => d.pilot).map(d => d.district));
  [...pts].sort((a, b) => (b.real.planning_strain_score + b.synthetic.outcome_index) - (a.real.planning_strain_score + a.synthetic.outcome_index)).slice(0, 3).forEach(d => labelled.add(d.district));
  [...pts].sort((a, b) => b.synthetic.outcome_index - a.synthetic.outcome_index).forEach(d => {
    const cx = X(d.real.planning_strain_score), cy = Y(d.synthetic.outcome_index);
    const g = sv('g', { class: 'pt', role: 'button' },
      sv('circle', { class: 'hit', cx, cy, r: 13 }),
      sv('circle', { class: 'mk ring ' + (d.pilot ? 'c2' : 'c1'), cx, cy, r: d.pilot ? 7 : 5.5 }));
    if (labelled.has(d.district)) {
      const right = cx < W - 130, w = d.district.length * (d.pilot ? 7.4 : 6.4);
      const x0 = right ? cx + 10 : cx - 10 - w;
      let ly = cy + 4;
      for (let k = 0; k < 6 && placed.some(b => x0 < b.x1 && x0 + w > b.x0 && Math.abs(ly - b.y) < 14); k++) ly += 14;
      placed.push({ x0, x1: x0 + w, y: ly });
      g.append(sv('text', { class: (d.pilot ? 'lblb' : 'lbl') + ' halo', x: right ? cx + 10 : cx - 10, y: ly, 'text-anchor': right ? 'start' : 'end' }, d.district));
    }
    hover(g, () => ({ title: d.district + (d.pilot ? ' (pilot)' : ''), rows: [
      { v: fx(d.real.planning_strain_score, 0), k: 'planning strain (real)', c: 'var(--c1)' },
      { v: fx(d.synthetic.outcome_index, 0), k: 'outcome index (synthetic)' },
      { v: pct(d.synthetic.early_death_rate), k: 'early deaths' }] }));
    g.addEventListener('click', () => onPick(d));
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(d); } });
    s.append(g);
  });
  return s;
}

/* Calibration: mean predicted vs observed risk by decile, with the line of perfect calibration. */
function calibrationChart(deciles) {
  const W = chartW(), H = 300, m = { t: 16, r: 18, b: 44, l: 52 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const top = Math.max(...deciles.map(d => Math.max(d.mean_predicted, d.observed))) * 1.1;
  const tk = ticks(0, top, 4), mx = Math.max(top, tk[tk.length - 1]);
  const X = v => m.l + (v / mx) * iw, Y = v => m.t + ih - (v / mx) * ih;
  const s = sv('svg', { class: 'ch chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Calibration by risk decile' });
  const ax = sv('g', { class: 'ax' });
  tk.forEach(v => ax.append(sv('line', { class: 'gl', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }), sv('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, pct(v, 0)),
    sv('text', { x: X(v), y: m.t + ih + 16, 'text-anchor': 'middle' }, pct(v, 0))));
  ax.append(sv('text', { x: m.l + iw / 2, y: H - 8, 'text-anchor': 'middle' }, 'Predicted risk (decile average)'));
  ax.append(sv('text', { x: 14, y: m.t + ih / 2, 'text-anchor': 'middle', transform: `rotate(-90 14 ${m.t + ih / 2})` }, 'Observed rate'));
  s.append(ax, sv('line', { class: 'ref', x1: X(0), y1: Y(0), x2: X(mx), y2: Y(mx) }));
  s.append(sv('path', { class: 's1', d: deciles.map((d, i) => (i ? 'L' : 'M') + X(d.mean_predicted) + ',' + Y(d.observed)).join('') }));
  deciles.forEach(d => {
    const g = sv('g', { class: 'pt' }, sv('circle', { class: 'hit', cx: X(d.mean_predicted), cy: Y(d.observed), r: 13 }),
      sv('circle', { class: 'mk c1 ring', cx: X(d.mean_predicted), cy: Y(d.observed), r: 5 }));
    hover(g, () => ({ title: 'Risk decile ' + d.decile, rows: [{ v: pct(d.mean_predicted), k: 'predicted', c: 'var(--c1)' }, { v: pct(d.observed), k: 'observed' }, { v: num(d.n), k: 'patients' }] }));
    s.append(g);
  });
  return s;
}

// ---------------------------------------------------------------- generic sortable table
function cmp(a, b) {
  if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'en', { numeric: true });
}
function dataTable(id, cols, rows, { onRow, empty = 'Nothing to show for this selection.', page = 25, caption } = {}) {
  const st = S.sort[id] || {};
  let data = rows;
  if (st.key) {
    const c = cols.find(x => x.key === st.key);
    if (c) { const get = c.sort || (r => r[c.key]); data = [...rows].sort((a, b) => { const va = get(a), vb = get(b); if (va == null || vb == null) return cmp(va, vb); return cmp(va, vb) * st.dir; }); }
  }
  const lim = S.limit[id] || page;
  const shown = data.slice(0, lim);
  const head = el('tr', null, cols.map(c => el('th', { class: c.num ? 'r' : null, scope: 'col', 'aria-sort': st.key === c.key ? (st.dir > 0 ? 'ascending' : 'descending') : null },
    c.nosort ? c.label : el('button', { type: 'button', 'data-sort': id + ':' + c.key, onclick: () => {
      S.sort[id] = { key: c.key, dir: st.key === c.key ? -st.dir : (c.num ? -1 : 1) };
      render(); const b = document.querySelector(`[data-sort="${id}:${c.key}"]`); if (b) b.focus();
    } }, c.label, el('span', { class: 'sort', 'aria-hidden': 'true', text: st.key === c.key ? (st.dir > 0 ? '▲' : '▼') : '' })))));
  const body = shown.length ? shown.map(r => el('tr', {
    class: onRow ? 'click' : null, tabindex: onRow ? '0' : null,
    onclick: onRow ? () => onRow(r) : null,
    onkeydown: onRow ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRow(r); } }) : null,
  }, cols.map(c => el('td', { class: c.num ? 'r' : null }, c.render ? c.render(r) : (r[c.key] == null ? '–' : String(r[c.key]))))))
    : [el('tr', null, el('td', { colspan: cols.length, class: 'empty', text: empty }))];
  const out = el('div', { class: 'dt' },
    el('p', { class: 'count', text: data.length ? `Showing ${num(shown.length)} of ${num(data.length)}` + (onRow ? ' · select a row for details' : '') : '' }),
    el('div', { class: 'scroll' }, el('table', null, caption ? el('caption', { class: 'sr-only', text: caption }) : null, el('thead', null, head), el('tbody', null, body))));
  if (data.length > lim) out.append(el('div', { class: 'more' }, el('button', { class: 'btn', type: 'button', onclick: () => { S.limit[id] = lim + page * 2; render(); } }, `Show ${num(Math.min(page * 2, data.length - lim))} more`)));
  return out;
}

// ---------------------------------------------------------------- drawer
let drawerReturn = null;
function openDrawer(title, badges, ...body) {
  const d = $('#drawer');
  drawerReturn = document.activeElement;
  d.replaceChildren();
  addKids(d, [
    el('div', { class: 'drawer-h' }, el('h2', { id: 'drawer-title', text: title }),
      el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close details', onclick: closeDrawer }, icon('close'))),
    badges ? el('div', { class: 'row', style: { marginBottom: '14px' } }, badges) : null, body]);
  d.setAttribute('aria-labelledby', 'drawer-title');
  d.classList.add('open'); $('#veil').classList.add('on'); d.focus();
}
function closeDrawer() {
  $('#drawer').classList.remove('open'); $('#veil').classList.remove('on');
  if (drawerReturn && document.body.contains(drawerReturn)) drawerReturn.focus();
}

function icon(name) {
  const P = {
    close: 'M6 6l12 12M18 6L6 18',
    sun: 'M12 4V2M12 22v-2M4 12H2m20 0h-2M5.6 5.6 4.2 4.2m15.6 15.6-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
    auto: 'M12 3a9 9 0 1 0 0 18V3z M12 3a9 9 0 0 1 0 18',
    print: 'M7 9V3h10v6M7 17H4v-6h16v6h-3M7 14h10v7H7z',
    download: 'M12 3v12m0 0-5-5m5 5 5-5M4 20h16',
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    home: 'M3 20V10l9-6 9 6v10M9 20v-6h6v6',
    map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
    arrow: 'M4 12h16M14 6l6 6-6 6',
    copy: 'M3 6h11v13H3zM10 3h11v13',
    pulse: 'M3 12h4l3-7 4 14 3-7h4',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.01',
    chev: 'M6 9l6 6 6-6',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  };
  return sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, sv('path', { d: P[name] }));
}

// ---------------------------------------------------------------- exports
function csvDownload(name, headers, rows) {
  const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const text = ['# ' + S.data.meta.notice, '# Source: ' + (isLive() ? 'live API' : 'pipeline snapshot ' + S.data.meta.version) + ', as of ' + S.data.meta.as_of,
    headers.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\r\n');
  saveBlob(new Blob([text], { type: 'text/csv' }), name + '.csv');
}
function saveBlob(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function canExport() { return isLive() ? ['state_admin', 'district_officer', 'facility_user'].includes(S.live.me.role) : S.role !== 'data'; }
function exportBtn(report, localFn) {
  if (!canExport()) return null;
  if (isLive() && report === 'facility_priority' && S.live.me.role === 'facility_user') return null;
  return el('button', { class: 'btn', type: 'button', onclick: async () => {
    if (!isLive()) { localFn(); toast('CSV downloaded from the snapshot.'); return; }
    try {
      const r = await api('/reports/export?report=' + report, { raw: true });
      saveBlob(await r.blob(), report + '.csv'); toast('Export downloaded. It is recorded in the audit log.');
    } catch (e) { toast('Export failed: ' + e.message); }
  } }, icon('download'), ' Export CSV');
}

// ================================================================= VIEWS
function viewOverview() {
  const sc = scoped(), d = S.data, gc = gapCounts(), role = S.role;
  const out = [];
  const sup = sc.facilities.filter(f => f.priority === 'supervise_first').sort((a, b) => b.index - a.index);
  const highKeys = new Set(sc.review.filter(p => p.tier === 'high').map(p => p.key));
  const severeGaps = sc.gaps.filter(g => g.sev === 'severe');
  const rising = sc.districts.filter(x => x.synthetic.demand_flag === 'rising');
  const nd = pendingDups(sc);
  const scopeTitle = role === 'district' ? `${S.district} district` : role === 'facility' ? facName(S.facility) : 'Assam';
  out.push(pageHead(role === 'data' ? 'Data quality overview' : role === 'facility' ? 'Facility overview' : role === 'district' ? 'District overview' : 'State overview',
    role === 'facility'
      ? 'Patients with the highest predicted risk and patients whose care has stalled. Every flag comes with its reasons; every decision stays with your team.'
      : 'Routine Nikshay data and published district plans, combined to show which patients, facilities and districts most need attention. The tool ranks and explains. People decide.'));

  // ---- stat cards
  const tiles = [];
  if (role === 'data') {
    const q = d.quality, de = d.dedup_eval;
    tiles.push(kpi({ label: 'Possible duplicates', value: num(nd), sub: 'Awaiting human review', tone: 'med', go: 'duplicates' }));
    if (de) tiles.push(kpi({ label: 'Precision, very likely', value: pct(de.very_likely.precision, 0), sub: `Recall ${pct(de.very_likely.recall, 0)}` }));
    if (q) tiles.push(kpi({ label: 'Usable for scoring', value: pct(q.share_records_usable_for_risk_model, 0), sub: `${num(q.records)} records checked`, go: 'evidence' }));
    if (q) tiles.push(kpi({ label: 'Low-completeness TUs', value: num(q.facilities_low_quality.filter(f => f.completeness < 0.9).length), sub: 'Below 90% complete', tone: 'high', go: 'evidence' }));
  } else {
    tiles.push(kpi({ label: 'Active patients', value: num(onTreatment()), sub: `On treatment · ${scopeTitle}` }));
    tiles.push(kpi({ label: 'High risk', value: num(highKeys.size), sub: (role === 'state' && !isLive()) ? 'Need review · pilot districts' : 'Need review this cycle', tone: 'high', go: 'review' }));
    tiles.push(kpi({ label: 'Care gaps', value: num(sumGaps(gc)), sub: 'Pending closure', tone: 'med', go: 'gaps' }));
    if (role === 'facility') {
      const all = sc.review, done = all.filter(actionOf).length;
      tiles.push(kpi({ label: 'Reviews recorded', value: `${num(done)} / ${num(all.length)}`, sub: isLive() ? 'Saved to the server' : 'Saved in this browser', tone: 'brand', go: 'review' }));
    } else {
      tiles.push(kpi({ label: 'Facilities flagged', value: num(sup.length), sub: 'Priority supervision', tone: 'brand', go: 'facilities' }));
    }
  }
  out.push(el('div', { class: 'kpis' }, tiles));

  // ---- risk list + facility priority, then gaps
  if (role !== 'data') {
    const right = (role === 'state' || role === 'district') ? facilityPriorityCard(sc) : attentionCard(sc, gc, sup, highKeys, severeGaps, rising, nd);
    out.push(el('div', { class: 'cols-15' }, riskListCard(sc), right));
    out.push(gapsCard(sc, gc));
  }

  // ---- what needs attention and evidence
  if (role === 'state' || role === 'district' || role === 'data') {
    out.push(el('div', { class: 'cols' }, attentionCard(sc, gc, sup, highKeys, severeGaps, rising, nd), evidenceAtAGlance()));
  }
  if (role === 'district' || role === 'facility') {
    const x = d.districts.find(z => z.district === S.district);
    if (x) out.push(districtProfile(x));
  }
  if (role === 'state') out.push(stateTrends());
  out.push(howItWorks());
  return out;
}

function riskListCard(sc) {
  const pilotBlocked = (S.role === 'district' || S.role === 'facility') && !isPilot(S.district);
  // one row per patient: their highest-risk listing
  const best = new Map();
  sc.review.forEach(p => { const b = best.get(p.key); if (!b || p.risk > b.risk) best.set(p.key, p); });
  const rows = [...best.values()].sort((a, b) => b.risk - a.risk);
  const flagged = rows.filter(p => p.tier !== 'standard').length;
  const top = rows.slice(0, 6);
  const open = p => { S.sel = p.key; S.list = p.list; goTab('review'); };
  const grid = el('div', { class: 'rlist', role: 'table', 'aria-label': 'Highest-risk patients' },
    ['Patient (pseudonymised)', 'Score', 'Top factor', 'Action'].map((h, i) => el('div', { class: 'h' + (i === 2 ? ' f' : i === 3 ? ' a' : ''), role: 'columnheader', text: h })),
    top.map(p => {
      const hot = p.tier === 'high' ? ' hot' : '';
      const r = p.reasons && p.reasons[0];
      return [
        el('div', { class: 'p' + hot, role: 'cell' }, el('b', { class: 'mono', text: `${p.key.slice(0, 10)} · ${p.sex}, ${p.age}` }), el('span', { text: `${facName(p.facility)} · ${p.dr ? 'DR-TB' : 'DS-TB'} · ${LIST[p.list]}` })),
        el('div', { class: hot.trim() || null, role: 'cell' }, lvl(p.tier)),
        el('div', { class: 'f' + hot, role: 'cell', text: r ? r.factor : '–' }),
        el('div', { class: 'a' + hot, role: 'cell' }, actionOf(p) ? el('span', { class: 'chip done', text: 'Reviewed' }) : el('button', { class: 'link', type: 'button', onclick: () => open(p) }, p.tier === 'high' ? 'Call review' : 'Review')),
      ];
    }));
  return el('div', { class: 'card' },
    el('div', { class: 'card-hd' }, el('div', { class: 'grow' }, el('h2', { text: 'Patient risk list' }),
      el('div', { class: 'sub', text: pilotBlocked ? 'Pilot districts only' : `Top ${top.length} of ${num(flagged)} flagged · decision support only` })),
      !pilotBlocked && rows.length ? el('div', { class: 'right' }, el('button', { class: 'link', type: 'button', onclick: () => goTab('review') }, 'View all →')) : null),
    pilotBlocked ? emptyState(`Patient-level risk lists are switched on only in ${S.data.meta.pilot.join(' and ')} during the pilot.`)
      : rows.length ? grid : emptyState('No patients on the review lists in this scope.'),
    el('div', { class: 'card-ft', text: '⚠ Scores do not replace clinical diagnosis or authorised programme decisions. For review by authorised staff only.' }));
}

function facilityPriorityCard(sc) {
  const facs = [...sc.facilities].sort((a, b) => b.index - a.index);
  const P = { supervise_first: ['p1', 'P1', 'var(--high-dot)'], watch: ['p2', 'P2', 'var(--med-dot)'], routine: ['p3', 'P3', 'var(--ok)'] };
  return el('div', { class: 'card' },
    el('div', { class: 'card-hd' }, el('div', { class: 'grow' }, el('h2', { text: 'Facility priority index' }), el('div', { class: 'sub', text: 'Supervision priority · current cycle' })),
      el('div', { class: 'right' }, el('button', { class: 'link', type: 'button', onclick: () => goTab('facilities') }, `All ${num(facs.length)} →`))),
    facs.slice(0, 6).map(f => {
      const [cls, lab, col] = P[f.priority] || P.routine;
      return el('div', { class: 'prio', tabindex: '0', role: 'button', onclick: () => facilityDrawer(f), onkeydown: e => { if (e.key === 'Enter') facilityDrawer(f); } },
        el('div', { class: 'prio-top' }, el('div', null, el('b', { text: f.name }), el('span', { text: `${f.district} · ${(f.drivers || []).join(' · ') || 'Within expected range'}` })),
          el('span', { class: 'prio-badge ' + cls, text: lab, title: PRI[f.priority] })),
        el('div', { class: 'prio-bar' }, el('i', { style: { width: Math.max(3, f.index) + '%', background: col } })));
    }));
}

function gapsCard(sc, gc) {
  const tone = { tested_not_notified: 'high', notified_not_started: 'high', missed_follow_up: 'med', referral_not_closed: '' };
  const cols = GAP_KEYS.map(k => {
    const list = sc.gaps.filter(g => g.type === k);
    const avg = list.length ? list.reduce((a, g) => a + g.days, 0) / list.length : null;
    const byFac = {}; list.forEach(g => { byFac[g.facility] = (byFac[g.facility] || 0) + 1; });
    const ranked = Object.entries(byFac).sort((a, b) => b[1] - a[1]);
    const others = ranked.slice(2).reduce((a, [, n]) => a + n, 0);
    return el('button', { class: 'gapcol ' + tone[k], type: 'button', onclick: () => { S.f.gapType = k; goTab('gaps'); } },
      el('div', { class: 'l', text: GAP[k].label }),
      el('div', { class: 'v', text: num(gc[k] || 0) }),
      el('div', { class: 's', text: avg != null ? `Avg. ${num(avg)} days open` : GAP[k].rule }),
      ranked.length ? el('ul', null, ranked.slice(0, 2).map(([f, n]) => el('li', { text: `${facName(f)} · ${plural(n, 'case')}` })), others ? el('li', { class: 'o', text: `Others · ${plural(others, 'case')}` }) : null) : null);
  });
  const partial = !isLive() && (S.role === 'state' || !isPilot(S.district));
  return el('div', { class: 'card' },
    el('div', { class: 'card-hd' }, el('div', { class: 'grow' }, el('h2', { text: 'Referral and follow-up gaps' }),
      el('div', { class: 'sub', text: `Rules-based flags · ${num(sumGaps(gc))} cases pending resolution` + (partial ? ' · facility breakdown covers pilot districts' : '') })),
      el('div', { class: 'right' }, el('button', { class: 'link', type: 'button', onclick: () => goTab('gaps') }, `View all ${num(sumGaps(gc))} →`))),
    el('div', { class: 'gapcols' }, cols));
}

function attentionCard(sc, gc, sup, highKeys, severeGaps, rising, nd) {
  const d = S.data, role = S.role, items = [];
  if (sup.length) items.push({ n: sup.length, t: [el('b', { text: 'facilities to supervise first. ' }), `Highest: ${sup[0].name} (index ${fx(sup[0].index, 0)}), driven by ${(sup[0].drivers || []).join(' and ').toLowerCase() || 'several indicators'}.`], s: 'Rates are size-adjusted, so small facilities are not flagged on chance alone.', go: 'facilities' });
  if (highKeys.size) items.push({ n: highKeys.size, t: [el('b', { text: 'high-risk patients ' }), 'on this cycle’s review lists.'], s: 'Each comes with its top three reasons and a place to record what was done.', go: 'review' });
  if (gc.notified_not_started) items.push({ n: gc.notified_not_started, t: [el('b', { text: 'notified but not started. ' }), 'The gap most likely to end in an early death.'], s: severeGaps.length ? `${num(severeGaps.length)} listed gaps are severe (well past threshold).` : GAP.notified_not_started.rule + '.', go: 'gaps' });
  if (gc.missed_follow_up) items.push({ n: gc.missed_follow_up, t: [el('b', { text: 'missed follow-ups. ' }), 'No contact for more than 14 days while on treatment.'], go: 'gaps' });
  if (sc.flagged.length && role !== 'facility' && role !== 'data') items.push({ n: sc.flagged.length, t: [el('b', { text: 'facilities with excess early deaths ' }), 'given their patients’ risk. Audit these first.'], go: 'deaths' });
  if (rising.length && role === 'state') items.push({ n: rising.length, t: [el('b', { text: 'districts with rising demand: ' }), rising.slice(0, 4).map(x => x.district).join(', ') + (rising.length > 4 ? '…' : '') + '.'], go: 'districts' });
  if (nd && role !== 'facility') items.push({ n: nd, t: [el('b', { text: 'possible duplicate records ' }), 'need a person to confirm or reject. Nothing is merged automatically.'], go: 'duplicates' });
  if (role === 'data' && d.quality) items.push({ n: d.quality.facilities_low_quality.filter(f => f.completeness < 0.9).length, t: [el('b', { text: 'facilities below 90% completeness. ' }), 'Missing HIV, BMI and diabetes data lowers score accuracy.'], go: 'evidence' });
  const shown = items.filter(it => roleDef().tabs.includes(it.go));
  const list = el('ol', { class: 'attn' }, shown.map(it => el('li', { class: 'go', tabindex: '0', role: 'link', onclick: () => goTab(it.go), onkeydown: e => { if (e.key === 'Enter') goTab(it.go); } },
    el('span', { class: 'n', text: num(it.n) }), el('span', { class: 't' }, it.t), it.s ? el('span', { class: 's', text: it.s }) : null)));
  return el('div', { class: 'card' },
    el('div', { class: 'card-hd' }, el('div', { class: 'grow' }, el('div', { class: 'row', style: { gap: '6px 10px' } }, el('h2', { text: 'What needs attention' }), prov('syn')),
      el('div', { class: 'sub', text: 'Ordered by how directly each item affects survival' }))),
    shown.length ? list : emptyState('Nothing needs attention in this scope.'));
}

function howItWorks() {
  return card('How it works', 'The pipeline reruns every cycle. People make every decision at the end.', null,
    el('div', { class: 'card-bd' }, el('ol', { class: 'steps', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' } },
      el('li', null, el('b', { text: 'Check data quality' }), el('span', { text: 'Missing values and impossible dates are counted, not hidden.' })),
      el('li', null, el('b', { text: 'Link duplicate records' }), el('span', { text: 'Probabilistic matching flags the same person registered twice.' })),
      el('li', null, el('b', { text: 'Score patient risk' }), el('span', { text: 'Transparent models, each flag with its top three reasons.' })),
      el('li', null, el('b', { text: 'Rank facilities and districts' }), el('span', { text: 'Size-adjusted indicators plus real district planning data.' })),
      el('li', null, el('b', { text: 'Find care gaps and audit deaths' }), el('span', { text: 'Simple rules for stalled referrals, missed follow-up and excess deaths.' })),
      el('li', { class: 'human' }, el('b', { text: 'A person reviews and acts' }), el('span', { text: 'Feedback, including disagreement, goes back into model reviews.' })))));
}

function evidenceAtAGlance() {
  const c = S.data.cards, de = S.data.dedup_eval, ms = S.data.shrinkage_multiseed;
  const facts = [];
  if (c.early_death) facts.push([fx(c.early_death.metrics.auc, 2), 'AUC, early-death model (time-ordered hold-out)']);
  if (c.early_death) facts.push([pct(c.early_death.metrics.capture_top_10pct, 0), 'of early deaths fall in the top 10% of scores']);
  if (de) facts.push([pct(de.very_likely.precision, 0), `precision on "very likely" duplicates (recall ${pct(de.very_likely.recall, 0)})`]);
  if (ms) facts.push([pct(ms.mean_mse_reduction_all, 0), `less error in facility rates after size adjustment (${ms.seeds} test datasets)`]);
  return el('div', { class: 'card' },
    el('div', { class: 'card-hd' }, el('div', { class: 'grow' }, el('div', { class: 'row', style: { gap: '6px 10px' } }, el('h2', { text: 'Evidence at a glance' }), prov('syn')),
      el('div', { class: 'sub', text: 'Held-out synthetic data with known answers. Re-validate on pilot records before live use.' })),
      el('div', { class: 'right' }, el('button', { class: 'link', type: 'button', onclick: () => goTab('evidence') }, 'Full evidence →'))),
    el('div', { class: 'card-bd' }, el('div', { class: 'facts' }, facts.map(([v, l]) => el('div', { class: 'fact' }, el('div', { class: 'v', text: v }), el('div', { class: 'l', text: l }))))));
}

function stateTrends() {
  const ss = S.data.state_series.filter(r => r.notif_rate_total != null);
  const sm = S.data.state_monthly;
  const last = S.data.state_series[S.data.state_series.length - 1];
  const fig = (title, kind, sub, ...body) => el('figure', { class: 'figure card' },
    el('div', { class: 'card-hd' }, el('div', { class: 'grow' }, el('div', { class: 'row', style: { gap: '6px 10px' } }, el('h2', { text: title }), prov(kind)), el('div', { class: 'sub', text: sub }))),
    el('div', { class: 'card-bd' }, body));
  const left = fig('TB notification rate, Assam', 'real', 'Cases notified per lakh population per year, public and private combined.',
    lineChart(ss.map(r => ({ label: String(r.year), y: r.notif_rate_total, title: String(r.year), rows: [
      { v: num(r.notif_rate_total), k: 'per lakh, total', c: 'var(--c1)' }, { v: num(r.notif_rate_public), k: 'public' }, { v: num(r.notif_rate_private), k: 'private' }] })),
      { yMin: 0, ariaLabel: 'Notification rate per lakh by year' }),
    last && last.notif_target_total ? el('figcaption', { text: `${last.year}: ${num(last.notif_achieved_total)} notified against a target of ${num(last.notif_target_total)} (${pct(last.notif_achieved_total / last.notif_target_total, 0)}). Source: NHM Assam / India TB Reports.` }) : null,
    dataTableDetails('View as table', ['Year', 'Total per lakh', 'Public', 'Private', 'Treatment success, new (%)'], ss.map(r => [r.year, r.notif_rate_total, r.notif_rate_public, r.notif_rate_private, r.tsr_new_pct ?? '–'])));
  const right = fig('Monthly notifications in the pipeline', 'syn', 'What the tool sees each month. The latest months are still filling in.',
    barChart(sm.map(r => ({ label: monthLabel(r.month), y: r.notified, title: monthLabel(r.month), rows: [{ v: num(r.notified), k: 'notified', c: 'var(--c1)' }] })), { every: Math.ceil(sm.length / 9), ariaLabel: 'Monthly notifications' }),
    dataTableDetails('View as table', ['Month', 'Notified'], sm.map(r => [monthLabel(r.month), num(r.notified)])));
  return el('div', { class: 'cols' }, left, right);
}

function districtProfile(x) {
  const r = x.real, s = x.synthetic;
  return section(`${x.district} district profile`, { desc: 'Published plan targets next to what the pipeline measures. Capacity figures are real; outcomes are synthetic in this demo.' },
    el('div', { class: 'cols' },
      el('div', { class: 'panel' }, el('div', { class: 'card-h' }, el('h3', { text: 'Planning and capacity' }), prov('real')),
        kv([['Tuberculosis Units', num(r.tu_count)], ['Diagnostic centres', num(r.tdc_count)], ['Expected patients (RoP)', num(r.expected_patients)],
          ['Patients per TU', num(r.patients_per_tu)], ['Lab tests per patient', fx(r.lab_tests_per_patient, 1)], ['Planning strain', `${fx(r.planning_strain_score, 0)} (${PTIER[r.planning_tier] || r.planning_tier})`],
          r.hill_district ? ['Terrain', 'Hill district'] : null, r.tribal_action_plan ? ['Tribal action plan', 'Yes'] : null])),
      el('div', { class: 'panel' }, el('div', { class: 'card-h' }, el('h3', { text: 'Outcomes' }), prov('syn')),
        kv([['Outcome index', fx(s.outcome_index, 0) + ' / 100'], ['Early deaths', `${pct(s.early_death_rate)} (${pct(s.early_death_lo)}–${pct(s.early_death_hi)})`],
          ['Lost before treatment', pct(s.pre_treatment_loss)], ['Started more than 14 days after diagnosis', pct(s.delay_over_14d)],
          ['Next quarter (projected)', s.projected_next_quarter != null ? `${num(s.projected_next_quarter)} notifications (${num(s.projected_lo)}–${num(s.projected_hi)})` : '–'],
          ['Demand', s.demand_flag ? el('span', { class: 'trend ' + s.demand_flag, text: DEMAND[s.demand_flag] }) : '–']]))));
}

// ---------------------------------------------------------------- districts
function viewDistricts() {
  const ds = scoped().districts;
  const maxPPT = Math.max(...ds.map(x => x.real.patients_per_tu || 0));
  const cols = [
    { key: 'district', label: 'District', render: x => el('span', null, el('b', { text: x.district }), x.pilot ? el('span', { class: 'sub', text: 'Pilot district' }) : null), sort: x => x.district },
    { key: 'strain', label: 'Planning strain', num: true, sort: x => x.real.planning_strain_score, render: x => el('span', null, fx(x.real.planning_strain_score, 0), el('span', { class: 'sub', text: PTIER[x.real.planning_tier] })) },
    { key: 'ppt', label: 'Patients per TU', num: true, sort: x => x.real.patients_per_tu, render: x => cellBar(x.real.patients_per_tu, maxPPT, num(x.real.patients_per_tu)) },
    { key: 'expected', label: 'Expected patients', num: true, sort: x => x.real.expected_patients, render: x => num(x.real.expected_patients) },
    { key: 'outcome', label: 'Outcome index', num: true, sort: x => x.synthetic.outcome_index, render: x => cellBar(x.synthetic.outcome_index, 100, fx(x.synthetic.outcome_index, 0), x.synthetic.outcome_index >= 75 ? 'high' : x.synthetic.outcome_index >= 50 ? 'med' : '') },
    { key: 'ed', label: 'Early deaths', num: true, sort: x => x.synthetic.early_death_rate, render: x => el('span', null, pct(x.synthetic.early_death_rate), el('span', { class: 'sub', text: `${pct(x.synthetic.early_death_lo)}–${pct(x.synthetic.early_death_hi)}` })) },
    { key: 'gaps', label: 'Open gaps', num: true, sort: x => sumGaps(x.synthetic.gaps), render: x => num(sumGaps(x.synthetic.gaps)) },
    { key: 'demand', label: 'Next quarter', sort: x => x.synthetic.qoq_change_pct, render: x => x.synthetic.demand_flag ? el('span', null, el('span', { class: 'trend ' + x.synthetic.demand_flag, text: DEMAND[x.synthetic.demand_flag] }), el('span', { class: 'sub', text: x.synthetic.projected_next_quarter != null ? `~${num(x.synthetic.projected_next_quarter)} notifications` : '' })) : '–' },
  ];
  if (!S.sort.districts) S.sort.districts = { key: 'outcome', dir: -1 };
  const highBoth = ds.filter(x => x.real.planning_strain_score >= 50 && x.synthetic.outcome_index >= 50);
  return [
    pageHead('Districts · capacity against outcomes', 'Planning strain comes from the published NHM Assam district plans (patients per TU, lab tests and outreach per patient). The outcome index ranks districts on early deaths, losses before treatment, delays and open referrals. Districts that rank high on both are where extra support is most likely to pay off.'),
    section('Strain against outcomes', { prov: ['real', 'syn'], desc: `${highBoth.length} districts sit in the top-right quadrant (above the median on both). Pilot districts are shown in amber. Select a point for details.` },
      legend([['dot', 'District', 'var(--c1)'], ['dot', 'Pilot district', 'var(--c2)'], ['dash', 'State median']]), districtScatter(ds, districtDrawer)),
    section('All districts', { desc: 'Sort by any column. Outcome index and early deaths are size-adjusted estimates with 95% intervals.', right: canExport() ? el('button', { class: 'btn', type: 'button', onclick: () => {
      csvDownload('districts', ['district', 'pilot', 'planning_strain', 'planning_tier', 'patients_per_tu', 'expected_patients', 'outcome_index', 'early_death_rate', 'open_gaps', 'demand_flag', 'projected_next_quarter'],
        ds.map(x => [x.district, x.pilot ? 1 : 0, x.real.planning_strain_score, x.real.planning_tier, x.real.patients_per_tu, x.real.expected_patients, x.synthetic.outcome_index, x.synthetic.early_death_rate, sumGaps(x.synthetic.gaps), x.synthetic.demand_flag, x.synthetic.projected_next_quarter]));
    } }, icon('download'), ' Export CSV') : null },
      dataTable('districts', cols, ds, { onRow: districtDrawer, page: 40, caption: 'Districts' })),
  ];
}

function districtDrawer(x) {
  const facs = S.data.facilities.filter(f => f.district === x.district).sort((a, b) => b.index - a.index);
  const r = x.real;
  openDrawer(x.district, [x.pilot ? badge('chip done', 'Pilot district') : null, el('span', { class: 'trend ' + (x.synthetic.demand_flag || 'stable'), text: DEMAND[x.synthetic.demand_flag] || '' })],
    districtProfile(x).querySelector('.cols'),
    el('h3', { text: 'Plan targets 2024-26' }), prov('real'),
    kv([['NPY beneficiaries (DS-TB)', num(r.npy_ds_target)], ['NPY beneficiaries (DR-TB)', num(r.npy_dr_target)], ['ACF house visits', num(r.acf_house_visit_target)],
      ['Lab tests', num(r.lab_tests_target)], ['Private-sector notifications', num(r.ppsa_notification_target)], ['ACF visits per patient', fx(r.acf_visits_per_patient, 1)]]),
    facs.length ? [el('h3', { text: `Facilities (${facs.length})` }),
      el('div', { class: 'scroll' }, el('table', null, el('thead', null, el('tr', null, el('th', { text: 'Facility' }), el('th', { text: 'Priority' }), el('th', { class: 'r', text: 'Index' }))),
        el('tbody', null, facs.map(f => el('tr', { class: 'click', tabindex: '0', onclick: () => facilityDrawer(f), onkeydown: e => { if (e.key === 'Enter') facilityDrawer(f); } },
          el('td', { text: f.name }), el('td', null, priBadge(f.priority)), el('td', { class: 'r', text: fx(f.index, 0) }))))))] : null);
}

// ---------------------------------------------------------------- facilities
function viewFacilities() {
  const all = scoped().facilities;
  const f = S.f;
  let rows = all;
  if (S.role === 'state' && f.facDistrict) rows = rows.filter(x => x.district === f.facDistrict);
  if (f.facPri) rows = rows.filter(x => x.priority === f.facPri);
  if (f.facQ) { const q = f.facQ.toLowerCase(); rows = rows.filter(x => (x.name + ' ' + x.id + ' ' + x.district).toLowerCase().includes(q)); }
  const counts = { supervise_first: 0, watch: 0, routine: 0 }; all.forEach(x => { counts[x.priority] = (counts[x.priority] || 0) + 1; });
  const edMax = Math.min(0.2, Math.max(...all.map(x => Math.max(x.early_death.raw || 0, x.early_death.hi || 0))) * 1.05) || 0.1;
  const fv = S.data.facility_validation, ms = S.data.shrinkage_multiseed;
  if (!S.sort.fac) S.sort.fac = { key: 'index', dir: -1 };

  const db = x => {
    const P = v => Math.max(0, Math.min(100, (v / edMax) * 100));
    const e = x.early_death;
    const s = el('div', { class: 'strip db' }, el('span', { class: 'axisl' }));
    if (e.lo != null) s.append(el('span', { class: 'ci', style: { left: P(e.lo) + '%', width: Math.max(0.5, P(e.hi) - P(e.lo)) + '%' } }));
    if (e.raw != null) s.append(el('span', { class: 'dt hol', style: { left: P(e.raw) + '%' } }));
    s.append(el('span', { class: 'dt', style: { left: P(e.shrunk) + '%' } }));
    hover(s, () => ({ title: x.name + ', early deaths', rows: [{ v: pct(e.shrunk), k: 'size-adjusted', c: 'var(--c1)' }, { v: pct(e.raw), k: 'raw rate', c: 'var(--c0)' }, { v: `${pct(e.lo)}–${pct(e.hi)}`, k: '95% interval' }, { v: num(x.cases), k: 'cases evaluated' }] }));
    return s;
  };
  const cols = [
    { key: 'name', label: 'Facility', sort: x => x.name, render: x => el('span', null, el('b', { text: x.name }), el('span', { class: 'sub', text: x.district + (x.low_data ? ' · few cases' : '') })) },
    { key: 'priority', label: 'Priority', sort: x => ({ supervise_first: 0, watch: 1, routine: 2 })[x.priority], render: x => priBadge(x.priority) },
    { key: 'index', label: 'Index', num: true, render: x => cellBar(x.index, 100, fx(x.index, 0), x.priority === 'supervise_first' ? 'high' : x.priority === 'watch' ? 'med' : '') },
    { key: 'drivers', label: 'Main drivers', nosort: true, render: x => (x.drivers || []).length ? x.drivers.map(t => el('span', { class: 'chip', text: t })) : el('span', { class: 'muted', text: '–' }) },
    { key: 'ed', label: 'Early deaths', nosort: false, sort: x => x.early_death.shrunk, render: db },
    { key: 'cases', label: 'Cases', num: true },
    { key: 'gaps', label: 'Open gaps', num: true, sort: x => sumGaps(x.gaps), render: x => num(sumGaps(x.gaps)) },
    { key: 'sup', label: 'Last supervision', sort: x => x.last_supervision, render: x => el('span', null, fmtDate(x.last_supervision), el('span', { class: 'sub', text: x.visits_90d ? `${x.visits_90d} visits in 90 days` : 'none in 90 days' })) },
  ];
  const districts = [...new Set(all.map(x => x.district))].sort();
  return [
    pageHead('Facility supervision priority', 'Each TU gets a 0–100 index from six weighted indicators: early deaths (30%), losses before treatment (20%), diagnosis-to-treatment delay (15%), open referrals (15%), missed follow-up (10%) and time since supervision (10%). The top 20% are marked "supervise first".'),
    el('div', { class: 'kpis' },
      kpi({ label: 'Supervise first', value: num(counts.supervise_first), tone: 'high' }),
      kpi({ label: 'Watch', value: num(counts.watch), tone: 'med' }),
      kpi({ label: 'Routine', value: num(counts.routine), tone: 'ok' }),
      kpi({ label: 'Facilities with few cases', value: num(all.filter(x => x.low_data).length), sub: 'rates pulled toward the district average' })),
    callout(null, el('b', { text: 'Why the rates are size-adjusted. ' }),
      'A TU with 12 patients and 2 deaths has a raw rate of 17%, but that is mostly chance. The index uses empirical-Bayes shrinkage, pulling small facilities toward their district average in proportion to how little data they have.',
      ms ? ` Across ${ms.seeds} synthetic datasets with known true rates, this cut estimation error by ${pct(ms.mean_mse_reduction_all, 0)} (${pct(ms.mean_mse_reduction_small_facilities, 0)} for small facilities) and found more of the truly worst facilities (${pct(ms.mean_top20_recall_shrunk, 0)} vs ${pct(ms.mean_top20_recall_naive, 0)} of the top 20).`
        : fv ? ` On this dataset it cut estimation error from ${fx(fv.mse_naive * 1e4, 1)} to ${fx(fv.mse_shrunk * 1e4, 1)} (×10⁻⁴).` : ''),
    section('Facilities', { prov: 'syn', right: exportBtn('facility_priority', () => csvDownload('facility_priority', ['facility_id', 'facility', 'district', 'index', 'priority', 'drivers', 'early_death_adjusted', 'early_death_raw', 'cases', 'open_gaps', 'last_supervision'],
      rows.map(x => [x.id, x.name, x.district, x.index, x.priority, (x.drivers || []).join('; '), x.early_death.shrunk, x.early_death.raw, x.cases, sumGaps(x.gaps), x.last_supervision]))) },
      el('div', { class: 'filters' },
        S.role === 'state' ? select('District', [{ value: '', label: 'All districts' }, ...districts.map(d => ({ value: d, label: d }))], f.facDistrict || '', v => { f.facDistrict = v; S.limit.fac = 0; render(); }) : null,
        seg('Priority', { '': 'All', supervise_first: 'Supervise first', watch: 'Watch', routine: 'Routine' }, f.facPri || '', v => { f.facPri = v; S.limit.fac = 0; render(); }),
        el('label', null, el('span', { class: 'sr-only', text: 'Search facilities' }), el('input', { type: 'search', placeholder: 'Search facility or district', value: f.facQ || '', oninput: debounce(e => { f.facQ = e.target.value; S.limit.fac = 0; render(); keepFocus('input[type=search]'); }, 250) }))),
      legend([['dot', 'Early-death rate, size-adjusted', 'var(--c1)'], ['hollow', 'Raw rate'], ['line', '95% interval', 'var(--c1)']]),
      dataTable('fac', cols, rows, { onRow: facilityDrawer, caption: 'Facility priority' })),
  ];
}
function debounce(fn, ms) { let t; return e => { clearTimeout(t); t = setTimeout(() => fn(e), ms); }; }
function keepFocus(sel) { const n = document.querySelector('#view ' + sel); if (n) { n.focus(); const v = n.value; n.value = ''; n.value = v; } }

function facilityDrawer(x) {
  const e = x.early_death;
  const metric = (label, shr, raw, lo, hi) => el('tr', null, el('td', { text: label }), el('td', { class: 'r num', text: pct(shr) }), el('td', { class: 'r', text: raw == null ? '–' : pct(raw) }), el('td', { class: 'r muted', text: lo != null ? `${pct(lo)}–${pct(hi)}` : '' }));
  const g = x.gaps || zeroGaps();
  openDrawer(x.name, [priBadge(x.priority), el('span', { class: 'chip', text: 'Index ' + fx(x.index, 0) }), x.low_data ? el('span', { class: 'chip', text: 'Few cases' }) : null],
    el('p', { class: 'muted', text: `${x.district} · ${x.id} · ${num(x.on_treatment)} on treatment · ${num(x.cases)} cases evaluated` }),
    (x.drivers || []).length ? el('p', null, 'Main drivers: ', x.drivers.map(t => el('span', { class: 'chip reason', text: t }))) : null,
    el('h3', { text: 'Indicators' }),
    el('div', { class: 'scroll' }, el('table', null, el('thead', null, el('tr', null, el('th', { text: 'Indicator' }), el('th', { class: 'r', text: 'Adjusted' }), el('th', { class: 'r', text: 'Raw' }), el('th', { class: 'r', text: '95% interval' }))),
      el('tbody', null, metric('Early deaths (60 days)', e.shrunk, e.raw, e.lo, e.hi), metric('Lost before treatment', x.pre_tx_loss.shrunk, x.pre_tx_loss.raw),
        metric('Started >14 days after diagnosis', x.delay_over_14d), metric('Open referrals', x.open_referral_rate), metric('Missed follow-up', x.missed_follow_up_rate)))),
    x.index_naive != null ? el('p', { class: 'small muted', style: { marginTop: '8px' }, text: `Without size adjustment this facility would score ${fx(x.index_naive, 0)} instead of ${fx(x.index, 0)}.` }) : null,
    x.oe ? [el('h3', { text: 'Early deaths against expected' }), kv([['Observed', num(x.oe.observed)], ['Expected from patient risk', fx(x.oe.expected, 1)], ['Ratio', fx(x.oe.ratio, 2) + (x.oe.flag ? ' · flagged for audit' : '')], ['Chance of an excess this large', pct(x.oe.p, 1)]])] : null,
    el('h3', { text: 'Supervision' }), kv([['Last visit', fmtDate(x.last_supervision)], ['Visits in last 90 days', num(x.visits_90d)], ['Median diagnosis-to-start', x.median_delay_days != null ? fx(x.median_delay_days, 0) + ' days' : '–']]),
    el('h3', { text: 'Open care gaps' }), kv(GAP_KEYS.map(k => [GAP[k].label, num(g[k])])),
    el('div', { class: 'btnrow', style: { marginTop: '18px' } },
      x.pilot && roleDef().tabs.includes('review') ? el('button', { class: 'btn primary', type: 'button', onclick: () => { S.f.revFac = x.id; closeDrawer(); goTab('review'); } }, 'Open review list') : null,
      roleDef().tabs.includes('gaps') ? el('button', { class: 'btn', type: 'button', onclick: () => { S.f.gapFac = x.id; closeDrawer(); goTab('gaps'); } }, 'View care gaps') : null));
}

// ---------------------------------------------------------------- review lists
function actionOf(p) { return S.actions[p.list + ':' + p.key]; }
function viewReview() {
  const d = S.data;
  if ((S.role === 'district' || S.role === 'facility') && !isPilot(S.district)) {
    return [pageHead('Patient risk'),
      callout('warn', el('b', { text: 'Not enabled in this district yet. ' }), `During the pilot, patient-level risk lists are switched on only in ${d.meta.pilot.join(' and ')}. Facility priority, care gaps and the death audit work everywhere.`)];
  }
  const sc = scoped(), f = S.f;
  const all = sc.review.filter(p => p.list === S.list);
  const facs = [...new Set(all.map(p => p.facility))].sort((a, b) => facName(a).localeCompare(facName(b)));
  let rows = all;
  if (f.revFac && S.role !== 'facility') rows = rows.filter(p => p.facility === f.revFac);
  if (f.revStatus === 'open') rows = rows.filter(p => !actionOf(p)); else if (f.revStatus === 'done') rows = rows.filter(p => actionOf(p));
  if (f.revQ) {
    const q = f.revQ.toLowerCase();
    rows = rows.filter(p => (p.key + ' ' + facName(p.facility) + ' ' + (p.reasons || []).map(r => r.factor).join(' ')).toLowerCase().includes(q));
  }
  rows = [...rows].sort((a, b) => b.risk - a.risk);
  const nHigh = all.filter(p => p.tier === 'high').length, nMed = all.filter(p => p.tier === 'medium').length;
  pageHead(`Patient risk list · ${num(all.length)} flagged`);
  S.headPills = [pill('high', `High · ${num(nHigh)}`), pill('med', `Med · ${num(nMed)}`)];

  const sel = rows.find(p => p.key === S.sel) || rows[0] || null;
  S.sel = sel ? sel.key : null;
  const nextOpen = sel ? (rows.slice(rows.indexOf(sel) + 1).find(p => !actionOf(p)) || rows.find(p => p !== sel && !actionOf(p))) : null;

  // ---- master list, grouped by tier
  const lim = S.limit.rev || 40;
  const listEl = el('div', { class: 'md-scroll', role: 'list', 'aria-label': 'Patients' });
  let shown = 0;
  ['high', 'medium', 'standard'].forEach(t => {
    const g = rows.filter(p => p.tier === t);
    const take = g.slice(0, Math.max(0, lim - shown));
    if (!take.length) return;
    listEl.append(el('div', { class: 'grp ' + t, text: `${TIER[t]} risk · ${plural(g.length, 'patient')}` }));
    take.forEach(p => listEl.append(patientItem(p, p === sel)));
    shown += take.length;
  });
  if (!rows.length) listEl.append(emptyState('No patients match these filters.'));
  if (rows.length > shown) listEl.append(el('div', { class: 'more' }, el('button', { class: 'link', type: 'button', onclick: () => { S.limit.rev = lim + 60; render(); } }, `Show ${num(rows.length - shown)} more →`)));

  const opt = (v, l, cur) => el('option', { value: v, selected: v === cur }, l);
  const tools = el('div', { class: 'md-tools' },
    seg('Risk list', LIST, S.list, v => { S.list = v; S.limit.rev = 0; S.sel = null; render(); }),
    el('label', { class: 'search' }, icon('search'), el('span', { class: 'sr-only', text: 'Search patients' }),
      el('input', { type: 'search', placeholder: 'Search key, facility or factor', value: f.revQ || '', oninput: debounce(e => { f.revQ = e.target.value; render(); keepFocus('.md-tools input[type=search]'); }, 250) })),
    el('div', { class: 'filters' },
      S.role !== 'facility' ? el('select', { 'aria-label': 'Facility', onchange: e => { f.revFac = e.target.value; S.sel = null; render(); } }, opt('', 'All facilities', f.revFac || ''), facs.map(id => opt(id, facName(id), f.revFac || ''))) : null,
      el('select', { 'aria-label': 'Review status', onchange: e => { f.revStatus = e.target.value; S.sel = null; render(); } }, opt('', 'All', f.revStatus || ''), opt('open', 'To review', f.revStatus || ''), opt('done', 'Reviewed', f.revStatus || '')),
      exportBtn('review_list', () => csvDownload('review_list', ['list', 'patient_key', 'facility_id', 'district', 'risk', 'tier', 'day_on_treatment', 'reasons', 'status'],
        rows.map(p => [p.list, p.key, p.facility, p.district, p.risk, p.tier, p.day, (p.reasons || []).map(r => r.factor).join('; '), actionOf(p) ? actionOf(p).action : ''])))));

  return [el('div', { class: 'md' },
    el('div', { class: 'md-list' }, tools, listEl),
    el('div', { class: 'md-detail', id: 'pdetail', tabindex: '-1' }, sel ? patientDetail(sel, nextOpen) : emptyState('Select a patient from the list.')))];
}

function patientItem(p, current) {
  const a = actionOf(p), r = (p.reasons || [])[0];
  return el('button', { class: 'pitem', type: 'button', role: 'listitem', 'aria-current': current ? 'true' : null, 'data-key': p.key, onclick: () => {
    S.sel = p.key; render();
    const again = document.querySelector(`.pitem[data-key="${p.key}"]`); if (again) again.focus({ preventScroll: true });
    if (innerWidth < 900) { const det = $('#pdetail'); if (det) det.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  } },
    el('div', { class: 'pitem-top' }, el('b', { text: `${identName(p.key) || p.key.slice(0, 10)} · ${p.sex}, ${p.age}`, class: identName(p.key) ? 'named' : null }), a ? el('span', { class: 'done', text: '✓ ' + ACTIONS[a.action] }) : null, lvl(p.tier)),
    el('span', { class: 'sub', text: `${facName(p.facility)} · ${p.dr ? 'DR-TB' : 'DS-TB'}${r ? ' · ' + r.factor : ''}` }));
}

function patientDetail(p, nextOpen) {
  const c = S.data.cards[p.list];
  const k = p.list + ':' + p.key, cur = S.actions[k];
  const col = { high: 'var(--high-dot)', medium: 'var(--med-dot)', standard: 'var(--ok)' }[p.tier] || 'var(--accent)';
  const R = 30, C = 2 * Math.PI * R, frac = Math.max(0.02, Math.min(1, p.risk));
  const ring = el('div', { class: 'ring' }, el('small', { text: 'Predicted risk' }),
    sv('svg', { viewBox: '0 0 76 76', role: 'img', 'aria-label': `Predicted risk ${pct(p.risk, 0)}` },
      sv('circle', { cx: 38, cy: 38, r: R, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': 7 }),
      sv('circle', { cx: 38, cy: 38, r: R, fill: 'none', stroke: col, 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-dasharray': `${(C * frac).toFixed(1)} ${C.toFixed(1)}`, transform: 'rotate(-90 38 38)' }),
      sv('text', { x: 38, y: 44, 'text-anchor': 'middle', class: 'rv', style: { fill: col } }, pct(p.risk, 0))),
    c && c.metrics.observed_rate ? el('div', { class: 'rx', text: `${fx(p.risk / c.metrics.observed_rate, 1)}× the average` }) : null);
  const sexWord = p.sex === 'M' ? 'Male' : p.sex === 'F' ? 'Female' : p.sex;
  const head = el('div', { class: 'card' }, el('div', { class: 'card-bd' },
    el('div', { class: 'pd-head' },
      el('div', { class: 'who' },
        el('div', { class: 'pd-id' }, el('h2', { text: p.key }), badge('tier ' + p.tier, `${TIER[p.tier]} risk`), cur ? el('span', { class: 'chip done', text: '✓ ' + ACTIONS[cur.action] }) : null),
        el('div', { class: 'pd-meta' },
          el('div', { text: `${sexWord} · ${p.age} years · ${facName(p.facility)} · ${p.district}` }),
          el('div', { text: `${p.dr ? 'Drug-resistant TB' : 'Drug-sensitive TB'} · day ${num(p.day)} of treatment · #${p.rank} in facility this cycle` }),
          el('div', { text: `List: ${LIST_LONG[p.list]}` })),
        el('div', { style: { marginTop: '12px' } }, (p.reasons || []).map(r => el('span', { class: 'chip reason', text: r.factor }))),
        identityBlock(p)),
      ring)));

  // factor breakdown: bar length is log(odds ratio) relative to the model's strongest factor
  const orMax = c ? Math.max(2, ...Object.values(c.odds_ratios)) : 4;
  const breakdown = el('div', { class: 'card' },
    el('div', { class: 'card-hd' }, el('div', { class: 'grow' }, el('h2', { text: 'Risk factor breakdown' }), el('div', { class: 'sub', text: 'The factors that raise this patient’s score most · for review purposes only' }))),
    el('div', { class: 'card-bd', style: { paddingTop: '4px', paddingBottom: '4px' } },
      (p.reasons || []).map(r => {
        const w = Math.max(4, Math.min(100, (Math.log(r.odds_ratio) / Math.log(orMax)) * 100));
        const hot = r.odds_ratio >= 2;
        return el('div', { class: 'fbar' },
          el('div', { class: 'fbar-top' }, el('span', { text: r.factor }), el('b', { class: 'up', text: `×${fx(r.odds_ratio, 2)} odds` })),
          el('div', { class: 'prio-bar' }, el('i', { style: { width: w + '%', background: hot ? 'var(--high-dot)' : 'var(--med-dot)' } })));
      }),
      (p.reasons || []).length ? null : emptyState('No risk-raising factors recorded.')),
    el('div', { class: 'card-ft plain', text: c
      ? `Model: ${c.algorithm === 'logistic_regression' ? 'logistic regression' : c.algorithm} · ${c.version} · AUC ${fx(c.metrics.auc, 2)} on ${num(c.cohort.test_n)} time-ordered hold-out patients · odds ratios show association, not cause`
      : 'Odds ratios show association, not cause.' }));

  // review and action
  let picked = cur ? cur.action : null;
  const note = el('textarea', { maxlength: '500', placeholder: 'Optional note: what was done, or why you disagree' }, cur ? cur.note : '');
  const btns = el('div', { class: 'btnrow', role: 'group', 'aria-label': 'Review outcome' }, Object.entries(ACTIONS).map(([a, l]) => el('button', {
    class: 'btn' + (picked === a ? ' sel' : ''), type: 'button', 'aria-pressed': String(picked === a), onclick: ev => {
      picked = a; btns.querySelectorAll('button').forEach(b => { b.classList.remove('sel'); b.setAttribute('aria-pressed', 'false'); });
      ev.currentTarget.classList.add('sel'); ev.currentTarget.setAttribute('aria-pressed', 'true');
    } }, l)));
  const canAct = !isLive() || ['district_officer', 'facility_user', 'field_worker'].includes(S.live.me.role);
  const save = el('button', { class: 'btn primary', type: 'button', disabled: !canAct, onclick: async () => {
    if (!picked) { toast('Choose an outcome first.'); return; }
    const rec = { action: picked, note: note.value.trim().slice(0, 500), at: new Date().toISOString() };
    if (isLive()) {
      try { const r = await api(`/patients/${encodeURIComponent(p.key)}/actions`, { method: 'POST', json: { list_type: p.list, action: picked, note: rec.note } }); toast('Saved. ' + (r.feedback_use || '')); }
      catch (e) { toast('Could not save: ' + e.message); return; }
    } else toast('Saved in this browser (demo snapshot).');
    S.actions[k] = rec; storeSet('localStorage', 'actions', S.actions);
    if (nextOpen) S.sel = nextOpen.key;
    render();
  } }, nextOpen ? 'Save and next' : 'Save review');
  const action = el('div', { class: 'card' },
    el('div', { class: 'card-hd' }, el('div', { class: 'grow' }, el('h2', { text: 'Review and action' }), el('div', { class: 'sub', text: 'Record what was done. Disagreement is useful: it feeds model reviews.' }))),
    el('div', { class: 'card-bd' },
      canAct ? null : el('p', { class: 'warnline', style: { marginBottom: '10px' }, text: 'Your role can view this list but not record reviews. District officers and facility teams record them.' }),
      btns,
      el('label', { class: 'field', style: { marginTop: '12px' } }, el('span', { text: 'Note' }), note),
      el('div', { class: 'row' }, save, el('span', { class: 'grow' })),
      el('p', { class: 'warnline', style: { marginTop: '12px', marginBottom: 0 }, text: '⚠ This score is decision support only. Any action must be taken by authorised staff based on clinical and programme assessment. ' + (isLive() ? 'Your review will be logged.' : 'In this demo your review is saved in this browser only.') })));
  return [head, breakdown, action];
}

/* Identifiers revealed this session. Held in memory only (never browser storage) and cleared on sign-out. */
const IDENT = {};
const identName = key => { const r = IDENT[key]; return r ? [r.first_name, r.last_name].filter(Boolean).join(' ') : ''; };
const canReveal = () => isLive() && ['district_officer', 'facility_user', 'field_worker', 'data_manager'].includes(S.live.me.role);

function identityBlock(p) {
  const wrap = el('div', { class: 'ident-box' });
  const r = IDENT[p.key];
  if (r) {
    wrap.append(el('div', { class: 'ident-name', text: identName(p.key) || '–' }),
      kv([['Guardian', r.guardian_name || '–'], ['Phone', r.phone || '–'], ['Village', r.village || '–']]),
      el('p', { class: 'small muted', style: { margin: '6px 0 0' }, text: 'Revealed for this session. The reveal is recorded in the audit log with your reason.' }));
    return wrap;
  }
  if (!canReveal()) {
    wrap.append(el('p', { class: 'small muted', style: { margin: 0 }, text: isLive()
      ? 'Name hidden: your role sees pseudonymous keys only. District officers and facility teams can reveal names.'
      : 'Name hidden. Sign in as a district officer or facility user to reveal names; every reveal is audit-logged.' }));
    return wrap;
  }
  const reason = el('input', { type: 'text', minlength: '8', placeholder: 'Reason, e.g. "home visit to restart treatment"', 'aria-label': 'Reason for revealing identity (logged)' });
  const go = async () => {
    if (reason.value.trim().length < 8) { toast('Please give a reason of at least 8 characters.'); reason.focus(); return; }
    try {
      IDENT[p.key] = await api(`/patients/${encodeURIComponent(p.key)}/identity?reason=${encodeURIComponent(reason.value.trim())}`);
      toast('Identity revealed. Recorded in the audit log.');
      render();
    } catch (e) { toast('Could not reveal: ' + e.message); }
  };
  const form = el('div', { class: 'ident-form', hidden: true }, reason, el('button', { class: 'btn primary sm', type: 'button', onclick: go }, 'Reveal'));
  reason.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  wrap.append(el('button', { class: 'btn sm', type: 'button', onclick: e => { e.currentTarget.hidden = true; form.hidden = false; reason.focus(); } }, icon('user'), 'Reveal name'), form);
  return wrap;
}

// ---------------------------------------------------------------- gaps
function viewGaps() {
  const sc = scoped(), gc = gapCounts(), f = S.f;
  let rows = sc.gaps;
  const facs = [...new Set(rows.map(g => g.facility))].sort();
  if (f.gapType) rows = rows.filter(g => g.type === f.gapType);
  if (f.gapSev) rows = rows.filter(g => g.sev === f.gapSev);
  if (f.gapFac && S.role !== 'facility') rows = rows.filter(g => g.facility === f.gapFac);
  if (!S.sort.gaps) S.sort.gaps = { key: 'over', dir: -1 };
  const maxOver = Math.max(1, ...sc.gaps.map(g => g.over));
  const cols = [
    { key: 'type', label: 'Gap', sort: g => GAP[g.type] ? GAP[g.type].label : g.type, render: g => el('span', null, el('b', { text: GAP[g.type] ? GAP[g.type].label : g.type }), el('span', { class: 'sub', text: g.key ? 'Patient ' + g.key : 'Lab result, patient not yet registered' })) },
    S.role === 'facility' ? null : { key: 'facility', label: 'Facility', sort: g => facName(g.facility), render: g => el('span', null, facName(g.facility), el('span', { class: 'sub', text: g.district })) },
    { key: 'days', label: 'Days open', num: true },
    { key: 'over', label: 'Days past threshold', num: true, render: g => cellBar(g.over, maxOver, num(g.over), g.sev === 'severe' ? 'high' : g.sev === 'high' ? 'med' : '') },
    { key: 'sev', label: 'Severity', sort: g => ({ severe: 0, high: 1, moderate: 2 })[g.sev], render: g => sevBadge(g.sev) },
  ].filter(Boolean);
  const partial = !isLive() && (S.role === 'state' || !isPilot(S.district));
  return [
    pageHead('Referral and follow-up gaps', 'Simple, auditable rules find patients whose next step is overdue. Each gap closes when the record shows the step was done. Severity reflects how far past the threshold it is.'),
    el('div', { class: 'kpis' }, GAP_KEYS.map(k => {
      const b = el('button', { class: 'kpi' + (f.gapType === k ? ' brand' : ''), type: 'button', 'aria-pressed': String(f.gapType === k), onclick: () => { f.gapType = f.gapType === k ? '' : k; S.limit.gaps = 0; render(); } },
        el('span', { class: 'l', text: GAP[k].label }), el('span', { class: 'v', text: num(gc[k]) }), el('span', { class: 's', text: GAP[k].rule }));
      return b;
    })),
    partial ? callout(null, el('b', { text: 'Counts cover the whole scope; the patient list covers pilot districts. ' }), 'In this snapshot, patient-level gap lists are included for ' + S.data.meta.pilot.join(' and ') + ' only. Signed-in users see every gap in their scope.') : null,
    section('Open gaps', { prov: 'syn', right: exportBtn('referral_gaps', () => csvDownload('referral_gaps', ['gap_type', 'patient_key', 'facility_id', 'district', 'days_open', 'over_by_days', 'severity'], rows.map(g => [g.type, g.key, g.facility, g.district, g.days, g.over, g.sev]))) },
      el('div', { class: 'filters' },
        select('Gap type', [{ value: '', label: 'All gap types' }, ...GAP_KEYS.map(k => ({ value: k, label: GAP[k].label }))], f.gapType || '', v => { f.gapType = v; render(); }),
        select('Severity', [{ value: '', label: 'All' }, { value: 'severe', label: 'Severe' }, { value: 'high', label: 'High' }, { value: 'moderate', label: 'Moderate' }], f.gapSev || '', v => { f.gapSev = v; render(); }),
        S.role !== 'facility' ? select('Facility', [{ value: '', label: 'All facilities' }, ...facs.map(id => ({ value: id, label: facName(id) }))], f.gapFac || '', v => { f.gapFac = v; render(); }) : null),
      dataTable('gaps', cols, rows, { empty: 'No open gaps match these filters.', caption: 'Open care gaps' })),
  ];
}

// ---------------------------------------------------------------- duplicates
function viewDuplicates() {
  const sc = scoped(), de = S.data.dedup_eval, f = S.f;
  const dec = id => S.decisions[id];
  let rows = sc.dups;
  if (f.dupStatus === 'open') rows = rows.filter(p => !dec(p.id)); else if (f.dupStatus === 'done') rows = rows.filter(p => dec(p.id));
  const lim = S.limit.dups || 24;
  const canDecide = !isLive() || ['state_admin', 'data_manager', 'district_officer'].includes(S.live.me.role);
  const decide = async (p, decision) => {
    if (isLive()) {
      try { const r = await api(`/duplicates/${p.id}/decision`, { method: 'POST', json: { decision, note: '' } }); toast(r.note || 'Decision recorded.'); }
      catch (e) { toast('Could not save: ' + e.message); return; }
    } else toast(decision === 'confirm' ? 'Marked as the same person (saved in this browser).' : 'Marked as different people (saved in this browser).');
    S.decisions[p.id] = decision; storeSet('localStorage', 'decisions', S.decisions); render();
  };
  const card = p => {
    const d0 = dec(p.id);
    const rec = (r, lbl) => el('div', { class: 'rec' }, el('span', { text: lbl }), el('b', { text: r.name }), el('span', { text: r.village }), el('span', { text: [r.age != null ? 'Age ' + r.age : null, facName(r.facility)].filter(Boolean).join(' · ') }));
    return el('article', { class: 'card pair' + (d0 ? ' decided' : '') },
      el('div', { class: 'card-h' }, el('span', { class: 'p', text: pct(p.p, p.p >= 0.995 ? 0 : 1) }), el('span', { class: 'muted small', text: 'match probability' }), el('span', { class: 'grow' }),
        el('span', { class: 'tier ' + (p.band === 'very_likely' ? 'high' : 'medium'), text: p.band === 'very_likely' ? 'Very likely' : 'Possible' })),
      el('div', { class: 'recs' }, rec(p.a, 'Record A'), rec(p.b, 'Record B')),
      el('div', null, (p.matching || []).map(x => el('span', { class: 'chip ok', text: '✓ ' + (FIELDS[x] || x) })), (p.differing || []).map(x => el('span', { class: 'chip no', text: FIELDS[x] || x }))),
      el('div', { class: 'btnrow', style: { marginTop: '10px' } }, d0
        ? [el('span', { class: 'chip done', text: d0 === 'confirm' ? 'Confirmed: same person' : 'Rejected: different people' })]
        : canDecide ? [el('button', { class: 'btn ok', type: 'button', onclick: () => decide(p, 'confirm') }, 'Same person'), el('button', { class: 'btn danger', type: 'button', onclick: () => decide(p, 'reject') }, 'Different people')] : null));
  };
  const nd = pendingDups(sc);
  return [
    pageHead('De-duplication · possible duplicate records', 'The same patient registered twice inflates counts and hides deaths and losses. Records are compared on names, guardian, age, phone, village and dates using probabilistic (Fellegi–Sunter) matching. Names are masked here. Nothing is merged automatically: a person decides, and merging is done in Nikshay by authorised staff.'),
    de ? el('div', { class: 'kpis' },
      kpi({ label: 'Pairs awaiting review', value: num(nd), tone: 'med' }),
      kpi({ label: 'Precision, "very likely"', value: pct(de.very_likely.precision, 0), sub: `recall ${pct(de.very_likely.recall, 0)}`, tone: 'ok' }),
      kpi({ label: 'Precision, all flagged', value: pct(de.review.precision, 0), sub: `recall ${pct(de.review.recall, 0)}` }),
      kpi({ label: 'Candidate pairs compared', value: num(de.candidate_pairs_compared), sub: `blocking keeps ${pct(de.blocking_recall, 0)} of true pairs` })) : null,
    section('Review queue', { bare: true, prov: 'syn', desc: !isLive() && (S.role === 'state' || S.role === 'data') ? `The snapshot includes the ${num(S.data.duplicates.length)} highest-probability pairs of ${num(nd)} flagged.` : null },
      el('div', { class: 'filters' }, seg('Status', { '': 'All', open: 'To review', done: 'Decided' }, f.dupStatus || '', v => { f.dupStatus = v; S.limit.dups = 0; render(); })),
      rows.length ? el('div', { class: 'pairs' }, rows.slice(0, lim).map(card)) : emptyState(S.role === 'district' && !isLive() ? 'No flagged pairs from this district are in the snapshot. Sign in to see the full queue.' : 'No pairs to show.'),
      rows.length > lim ? el('div', { class: 'more' }, el('button', { class: 'btn', type: 'button', onclick: () => { S.limit.dups = lim + 24; render(); } }, `Show more (${num(rows.length - lim)} more)`)) : null),
  ];
}

// ---------------------------------------------------------------- death audit
function viewDeaths() {
  const da = S.data.death_audit;
  if (!da) return [emptyState('The death audit is not available for this role.')];
  const sc = scoped(), t = da.timing;
  const hist = t.histogram.map(b => ({ label: b.bin, y: b.deaths, cls: /^(0-7|8-14|15-29|30-59)$/.test(b.bin) ? 'c1' : 'c0', title: `Day ${b.bin} after treatment start`, rows: [{ v: num(b.deaths), k: 'deaths' }] }));
  const marker = t.histogram.findIndex(b => b.bin.startsWith('60'));
  const fac = da.factors.slice().sort((a, b) => b.ratio - a.ratio);
  const fmax = Math.max(...fac.map(x => x.ratio_hi || x.ratio)) * 1.08;
  if (!S.sort.audq) S.sort.audq = { key: 'priority', dir: 1 };
  if (!S.sort.oe) S.sort.oe = { key: 'ratio', dir: -1 };
  return [
    pageHead('Death audit', 'Most TB deaths happen early, often before the system has a chance to act. This view shows when deaths happen, which factors are over-represented among early deaths, and which facilities have more deaths than their patients’ risk would predict.'),
    el('div', { class: 'kpis' },
      kpi({ label: 'Deaths among patients started', value: num(t.deaths), sub: pct(t.share_of_started) + ' of those started', tone: 'brand' }),
      kpi({ label: 'Within 60 days of starting', value: pct(t.share_early, 0), sub: num(t.early_deaths) + ' early deaths', tone: 'high' }),
      kpi({ label: 'Within 14 days', value: pct(t.within_14_days_share, 0), sub: num(t.within_14_days) + ' deaths', tone: 'high' }),
      kpi({ label: 'Early deaths with a fixable factor', value: pct(da.addressable, 0), sub: da.addressable2 != null ? pct(da.addressable2, 0) + ' had two or more' : 'such as delay or no nutrition support', tone: 'med' })),
    el('div', { class: 'cols sec' },
      el('figure', { class: 'figure panel' }, el('div', { class: 'card-h' }, el('h3', { text: 'When deaths happen' }), prov('syn')),
        el('p', { class: 'muted small', text: `Days from treatment start to death. Median ${num(t.median_days_to_death)} days.` }),
        legend([['', 'Within 60 days (early)', 'var(--c1)'], ['', 'Later', 'var(--c0)'], ['dash', '60-day mark']]),
        barChart(hist, { marker: marker >= 0 ? marker : null, ariaLabel: 'Deaths by days since treatment start' }),
        el('figcaption', { text: 'Bins are unequal in width; the early bins cover fewer days, so early deaths are even more concentrated than the bars suggest.' })),
      el('div', { class: 'panel' }, el('div', { class: 'card-h' }, el('h3', { text: 'Over-represented among early deaths' }), prov('syn')),
        el('p', { class: 'muted small', text: 'How much more common each factor is among early deaths than among everyone started on treatment (1 = no difference), with 95% intervals.' }),
        stripRows(fac.map(x => ({ label: x.factor, v: x.ratio, lo: x.ratio_lo, hi: x.ratio_hi, value: ['×' + fx(x.ratio, 1)],
          tip: () => ({ title: x.factor, rows: [{ v: '×' + fx(x.ratio, 2), k: 'ratio', c: 'var(--c1)' }, { v: `${fx(x.ratio_lo, 2)}–${fx(x.ratio_hi, 2)}`, k: '95% interval' }, { v: pct(x.share_of_early_deaths, 0), k: 'of early deaths' }, { v: pct(x.share_of_all_started, 0), k: 'of all started' }] }) })),
          { min: 0.5, max: fmax, log: true, ref: 1, head: ['Factor', 'Ratio (log scale)', ''] }))),
    S.role !== 'facility' ? section('Facilities with more early deaths than expected', { prov: 'syn', desc: 'Expected deaths come from each patient’s baseline risk, so a facility serving sicker patients is not penalised. Flagged when the excess is unlikely to be chance alone.' },
      dataTable('oe', [
        { key: 'facility', label: 'Facility', sort: x => facName(x.facility_id), render: x => el('span', null, el('b', { text: facName(x.facility_id) }), el('span', { class: 'sub', text: x.district })) },
        { key: 'observed', label: 'Observed', num: true },
        { key: 'expected', label: 'Expected', num: true, render: x => fx(x.expected, 1) },
        { key: 'ratio', label: 'Observed ÷ expected', num: true, sort: x => x.oe_ratio, render: x => cellBar(x.oe_ratio, 3, fx(x.oe_ratio, 2), 'high') },
        { key: 'p', label: 'Chance', num: true, sort: x => x.p_excess, render: x => pct(x.p_excess, 1) },
        { key: 'n', label: 'Patients', num: true, render: x => num(x.n) },
      ], sc.flagged, { onRow: x => { const f0 = S.data.facilities.find(z => z.id === x.facility_id); if (f0) facilityDrawer(f0); }, empty: 'No facility in this scope has a flagged excess of early deaths.', caption: 'Facilities with excess early deaths' })) : null,
    section('Deaths to audit', { prov: 'syn', desc: (!isLive() && S.role === 'state' ? 'Recent deaths in the pilot districts. ' : 'Recent deaths in your scope. ') + 'High priority means an early death with at least one factor the programme could have addressed.' },
      dataTable('audq', [
        { key: 'priority', label: 'Priority', sort: x => x.audit_priority === 'high' ? 0 : 1, render: x => x.audit_priority === 'high' ? badge('tier high', 'High') : badge('tier standard', 'Standard') },
        { key: 'death', label: 'Died', sort: x => x.death_date, render: x => el('span', null, fmtDate(x.death_date), el('span', { class: 'sub', text: `day ${x.days_after_start} of treatment` })) },
        { key: 'patient', label: 'Patient', sort: x => x.patient_key, render: x => el('span', null, el('span', { class: 'mono', text: x.patient_key }), el('span', { class: 'sub', text: `${x.age} ${x.sex}` })) },
        S.role === 'facility' ? null : { key: 'facility', label: 'Facility', sort: x => facName(x.facility_id), render: x => facName(x.facility_id) },
        { key: 'factors', label: 'Factors', nosort: true, render: x => [...(x.addressable_factors || []).map(fa => el('span', { class: 'chip reason', text: fa })), ...(x.factors || []).filter(fa => !(x.addressable_factors || []).includes(fa)).map(fa => el('span', { class: 'chip', text: fa }))] },
      ].filter(Boolean), sc.deathQ, { empty: 'No deaths to audit in this scope.', caption: 'Deaths to audit' }),
      el('p', { class: 'small muted', text: 'Shaded factors are ones the programme can act on (for example treatment delay or no nutrition support).' })),
  ];
}

// ---------------------------------------------------------------- model evidence
function viewEvidence() {
  const d = S.data, c = d.cards[S.model];
  const out = [pageHead('Model evidence and governance', 'Every model has a card: what it predicts, when, on whom it was tested, how accurate and how well calibrated it is, and how it performs across subgroups. All figures are from time-ordered hold-out data the model never saw during training.')];
  if (c) {
    const m = c.metrics, bc = c.baseline_vs_challenger;
    const ors = Object.entries(c.odds_ratios).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
    const orMax = Math.max(...ors.map(o => o.v)) * 1.1, orMin = Math.min(0.6, ...ors.map(o => o.v));
    if (!S.sort.sub) S.sort.sub = { key: 'group', dir: 1 };
    out.push(el('div', { class: 'filters' }, seg('Model', LIST, S.model, v => { S.model = v; render(); })),
      el('div', { class: 'panel' },
        el('div', { class: 'card-h' }, el('h2', { text: c.outcome }), prov('syn'), el('span', { class: 'grow' }), el('span', { class: 'chip mono', text: c.version })),
        el('div', { class: 'cols' },
          kv([['Predicts', c.outcome], ['Scored at', c.moment], ['Algorithm', c.algorithm === 'logistic_regression' ? 'Logistic regression (transparent)' : c.algorithm], ['Intended use', c.intended_use]]),
          kv([['Training patients', num(c.cohort.train_n) + ` (${fmtDate(c.cohort.train_window[0])} – ${fmtDate(c.cohort.train_window[1])})`], ['Test patients', num(c.cohort.test_n) + ` (${fmtDate(c.cohort.test_window[0])} – ${fmtDate(c.cohort.test_window[1])})`], ['Split', c.cohort.split], ['Tier cut-offs', `High above ${pct(c.thresholds.high, 1)}, medium above ${pct(c.thresholds.medium, 1)}`]])),
        bc ? el('p', { class: 'small', style: { marginTop: '12px' }, text: `Model choice: a gradient-boosting challenger scored AUC ${fx(bc.gbm_auc, 3)} against ${fx(bc.logistic_auc, 3)} for logistic regression. The challenger must beat the transparent model by at least ${fx(bc.required_gain, 2)} to replace it, so the explainable model was kept.` }) : null),
      el('div', { class: 'kpis' },
        kpi({ label: 'AUC (discrimination)', value: fx(m.auc, 2), sub: `95% CI ${fx(m.auc_ci95[0], 2)}–${fx(m.auc_ci95[1], 2)}`, tone: 'brand' }),
        kpi({ label: 'Calibration slope', value: fx(m.calibration_slope, 2), sub: '1.00 is ideal', tone: 'ok' }),
        kpi({ label: 'Events in top 10%', value: pct(m.capture_top_10pct, 0), sub: `top 20% captures ${pct(m.capture_top_20pct, 0)}` }),
        kpi({ label: 'Hit rate in top 10%', value: pct(m.ppv_top_10pct, 0), sub: `vs ${pct(m.observed_rate, 1)} overall` }),
        kpi({ label: 'Test set', value: num(m.n), sub: `${num(m.events)} events` })),
      el('div', { class: 'cols sec' },
        el('figure', { class: 'figure panel' }, el('h3', { text: 'Calibration: are the risks honest?' }),
          el('p', { class: 'muted small', text: 'Average predicted risk against what actually happened, by risk decile. Points on the dashed line mean a 10% score really means about 10%.' }),
          legend([['line', 'Model', 'var(--c1)'], ['dash', 'Perfect calibration']]), calibrationChart(c.deciles),
          dataTableDetails('View as table', ['Decile', 'Predicted', 'Observed', 'Patients'], c.deciles.map(x => [x.decile, pct(x.mean_predicted), pct(x.observed), num(x.n)]))),
        el('div', { class: 'panel' }, el('h3', { text: 'Who the list catches' }),
          el('p', { class: 'muted small', text: 'Share of all events found by reviewing the highest-scoring patients, against reviewing at random (tick).' }),
          stripRows([['Top 5%', m.capture_top_5pct, 0.05], ['Top 10%', m.capture_top_10pct, 0.1], ['Top 20%', m.capture_top_20pct, 0.2]].map(([l, v, base]) => ({ label: l + ' of patients', v, marker: base, value: [pct(v, 0)],
            tip: () => ({ title: l + ' of patients by risk', rows: [{ v: pct(v, 0), k: 'of events captured', c: 'var(--c1)' }, { v: pct(base, 0), k: 'expected at random' }] }) })), { min: 0, max: 1, mode: 'bar', head: ['Reviewed', 'Events captured', ''] }),
          el('h3', { text: 'What drives risk', style: { marginTop: '22px' } }),
          el('p', { class: 'muted small', text: 'Odds ratios from the model (log scale). Above 1 raises risk; below 1 lowers it.' }),
          legend([['', 'Raises risk', 'var(--c2)'], ['', 'Lowers risk', 'var(--c1)']]),
          stripRows(ors.slice(0, 14).map(o => ({ label: ORL[o.k] || o.k, v: o.v, cls: o.v >= 1 ? 'c2' : '', value: ['×' + fx(o.v, 2)], tip: () => ({ title: ORL[o.k] || o.k, rows: [{ v: '×' + fx(o.v, 2), k: 'odds ratio' }] }) })),
            { min: orMin, max: orMax, log: true, ref: 1, mode: 'bar' }),
          ors.length > 14 ? dataTableDetails(`All ${ors.length} factors`, ['Factor', 'Odds ratio'], ors.map(o => [ORL[o.k] || o.k, fx(o.v, 2)])) : null)),
      section('Fairness: performance across groups', { desc: 'The model should rank patients similarly well and be equally well calibrated in every group. Groups whose observed-to-expected ratio falls outside 0.8–1.25 are flagged for review.' },
        dataTable('sub', [
          { key: 'group', label: 'Group', sort: x => x.group + x.level, render: x => el('span', null, el('b', { text: x.level }), el('span', { class: 'sub', text: x.group.replace(/_/g, ' ') })) },
          { key: 'n', label: 'Patients', num: true, render: x => num(x.n) },
          { key: 'events', label: 'Events', num: true, render: x => num(x.events) },
          { key: 'auc', label: 'AUC', num: true, render: x => x.auc == null ? '–' : cellBar(x.auc, 1, fx(x.auc, 2)) },
          { key: 'oe', label: 'Observed ÷ expected', num: true, sort: x => x.observed_over_expected, render: x => fx(x.observed_over_expected, 2) },
          { key: 'flag', label: 'Check', sort: x => x.flag ? 0 : 1, render: x => x.flag ? badge('tier medium', 'Review') : badge('tier standard', 'OK') },
        ], c.subgroups, { page: 40, caption: 'Subgroup performance' })),
      section('Known limitations', null, el('ul', { style: { paddingLeft: '18px', margin: 0 } }, c.limitations.map(l => el('li', { text: l, style: { marginBottom: '4px' } })))));
  }

  // data quality
  const q = d.quality;
  if (q) {
    const miss = Object.entries(q.missingness).sort((a, b) => b[1] - a[1]);
    const viol = Object.entries(q.rule_violations);
    out.push(section('Data quality', { bare: true, prov: 'syn', desc: `${num(q.records)} records checked, as of ${fmtDate(q.as_of)}. Missing values are not imputed silently: in the risk models they appear as their own reasons.` },
      el('div', { class: 'cols' },
        el('div', { class: 'panel' }, el('h3', { text: 'Missing values' }),
          stripRows(miss.map(([k, v]) => ({ label: MISS[k] || k, v, cls: v > 0.1 ? 'c2' : '', value: [pct(v, 1)] })), { min: 0, max: Math.max(0.2, miss[0][1] * 1.1), mode: 'bar' })),
        el('div', { class: 'panel' }, el('h3', { text: 'Rule checks' }),
          kv([...viol.map(([k, v]) => [RULES[k] || k, v ? el('span', { class: 'tier medium', text: num(v) }) : el('span', { class: 'tier standard', text: '0' })]),
            ['Notification lag', `median ${plural(q.notification_lag_days.median, 'day')}, 90th percentile ${plural(q.notification_lag_days.p90, 'day')}`],
            ['Usable for risk scoring', pct(q.share_records_usable_for_risk_model, 0)],
            ['Facilities below 90% complete', num(q.facilities_low_quality.filter(x => x.completeness < 0.9).length)]])))));
  }

  // validation of the facility method and duplicates
  const fv = d.facility_validation, ms = d.shrinkage_multiseed, de = d.dedup_eval;
  if (fv || de) out.push(section('Method validation against known answers', { bare: true, prov: 'syn', desc: 'Synthetic data lets us check each method against the truth used to generate it. This is the reason the demo uses synthetic data: the pipeline can be proven before it touches real records.' },
    el('div', { class: 'cols' },
      fv ? el('div', { class: 'panel' }, el('h3', { text: 'Facility rate adjustment' }),
        kv([['Error, raw rates', fx(fv.mse_naive * 1e4, 2) + ' ×10⁻⁴'], ['Error, size-adjusted', fx(fv.mse_shrunk * 1e4, 2) + ' ×10⁻⁴'], ['Small facilities (<50 cases)', `${fx(fv.mse_naive_small_facilities * 1e4, 1)} → ${fx(fv.mse_shrunk_small_facilities * 1e4, 1)} ×10⁻⁴ (${fv.small_facilities_under_50_cases} TUs)`],
          ['Rank agreement with truth', `${fx(fv.spearman_naive, 2)} → ${fx(fv.spearman_shrunk, 2)}`], ['Worst 20 found', `${pct(fv.top20_recall_naive, 0)} → ${pct(fv.top20_recall_shrunk, 0)}`],
          ms ? ['Across ' + ms.seeds + ' datasets', `error ${pct(ms.mean_mse_reduction_all, 0)} lower on average`] : null])) : null,
      de ? el('div', { class: 'panel' }, el('h3', { text: 'Duplicate detection' }),
        kv([['True duplicate pairs', num(de.true_duplicate_pairs)], ['Kept by blocking', pct(de.blocking_recall, 1)], ['Pairs compared', num(de.candidate_pairs_compared)],
          ['Flagged for review', `${num(de.review.pairs_flagged)} · precision ${pct(de.review.precision, 0)} · recall ${pct(de.review.recall, 0)}`],
          ['"Very likely" band', `${num(de.very_likely.pairs_flagged)} · precision ${pct(de.very_likely.precision, 0)} · recall ${pct(de.very_likely.recall, 0)}`]])) : null)));

  // live audit log
  if (isLive() && d.live && d.live.audit) {
    out.push(section('Recent activity (audit log)', { desc: 'Every view, export, decision and identity reveal is recorded with the user and time.' },
      dataTable('audit', [
        { key: 'ts', label: 'When', render: x => fmtDateTime(x.ts) },
        { key: 'username', label: 'User' }, { key: 'role', label: 'Role' }, { key: 'action', label: 'Action' }, { key: 'resource', label: 'Resource' },
      ], d.live.audit, { page: 20, caption: 'Audit log' })));
  }
  return out;
}

// ================================================================= live API
function api(path, opts = {}) {
  const headers = { Authorization: 'Bearer ' + S.live.token };
  let body;
  if (opts.json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  return fetch(S.live.api + path, { method: opts.method || 'GET', headers, body }).then(async r => {
    if (r.status === 401) { signOut('Your session has expired. Please sign in again.'); throw new Error('Session expired'); }
    if (!r.ok) { let msg = r.statusText; try { const j = await r.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch (e) { /* not json */ } throw new Error(msg); }
    return opts.raw ? r : r.json();
  });
}
function defaultApi() {
  if (/^https?:$/.test(location.protocol) && location.pathname.replace(/\/$/, '').endsWith('/app')) return location.origin;
  return storeGet('localStorage', 'api', 'http://localhost:8000');
}

async function loadLive() {
  const me = S.live.me, role = me.role, pilot = me.pilot_districts || SNAP.meta.pilot;
  const can = {
    fac: ['state_admin', 'district_officer'].includes(role),
    gaps: role !== 'data_manager',
    dups: ['state_admin', 'data_manager', 'district_officer'].includes(role),
    dq: ['state_admin', 'data_manager', 'district_officer'].includes(role),
    review: role !== 'data_manager' && (role === 'state_admin' || pilot.includes(me.district)),
    audit: role === 'state_admin',
  };
  const calls = Object.assign({ overview: '/overview', cards: '/model/cards' },
    can.fac ? { fac: '/facilities/priority', dist: '/districts/priority', death: '/death-audit/summary', dqueue: '/death-audit/queue', trends: '/trends' } : {},
    can.gaps ? { gaps: '/referral-gaps?limit=1000' } : {},
    can.dups ? { dups: '/duplicates?limit=500' } : {},
    can.dq ? { quality: '/data-quality' } : {},
    can.review ? { r1: '/patients/review-list?list_type=early_death&limit=500', r2: '/patients/review-list?list_type=unfavourable_outcome&limit=500' } : {},
    can.audit ? { audit: '/audit/log?limit=100' } : {});
  const keys = Object.keys(calls);
  const res = await Promise.allSettled(keys.map(k => api(calls[k])));
  const R = {};
  keys.forEach((k, i) => { if (res[i].status === 'fulfilled') R[k] = res[i].value; else console.warn('Live load failed for', calls[k], res[i].reason); });
  if (!R.overview) throw res[keys.indexOf('overview')].reason;
  const ov = R.overview;

  const gaps = ((R.gaps || {}).items || []).map(g => ({ type: g.gap_type, key: g.patient_key, facility: g.facility_id, district: g.district, days: g.days_open, over: g.over_by_days, sev: g.severity }));
  const tally = keyf => { const m = {}; gaps.forEach(g => { const k = keyf(g); (m[k] = m[k] || zeroGaps())[g.type]++; }); return m; };
  const gF = tally(g => g.facility), gD = tally(g => g.district);
  const oe = {}; ((R.death || {}).facility_oe || []).forEach(o => { oe[o.facility_id] = o; });

  const facilities = ((R.fac || {}).items || []).map(it => {
    const x = it.data || {}, o = oe[it.facility_id];
    NAME[it.facility_id] = x.facility_name || NAME[it.facility_id];
    return { id: it.facility_id, name: x.facility_name || it.facility_id, district: it.district, pilot: pilot.includes(it.district), index: it.index_score, index_naive: x.index_raw_score,
      priority: it.priority, drivers: x.drivers || [], cases: x.cases_evaluated, low_data: !!x.low_data, on_treatment: x.on_treatment_now,
      early_death: { shrunk: x.early_death_rate, raw: x.early_death_rate_raw, lo: x.early_death_rate_lo, hi: x.early_death_rate_hi },
      pre_tx_loss: { shrunk: x.pre_treatment_loss, raw: x.pre_treatment_loss_raw }, delay_over_14d: x.diagnosis_to_start_delay, open_referral_rate: x.open_referral_rate,
      missed_follow_up_rate: x.missed_follow_up_rate, median_delay_days: x.median_delay_days, supervision_gap: x.supervision_gap, last_supervision: x.last_supervision_date,
      visits_90d: x.supervision_visits_90d || 0, gaps: gF[it.facility_id] || zeroGaps(),
      oe: o ? { observed: o.observed, expected: o.expected, ratio: o.oe_ratio, p: o.p_excess, flag: o.flag } : null };
  });
  const tr = {}; ((R.trends || {}).items || []).forEach(t => { tr[t.district] = t; });
  const districts = ((R.dist || {}).items || []).map(it => {
    const p = it.planning || {}, o = it.outcomes || p.outcomes || {}, t = tr[it.district] || {};
    return { district: it.district, pilot: pilot.includes(it.district),
      real: { tu_count: p.tu_count, tdc_count: p.tdc_count, expected_patients: p.expected_patients, npy_ds_target: p.npy_ds_target, npy_dr_target: p.npy_dr_target,
        acf_house_visit_target: p.acf_house_visit_target, lab_tests_target: p.lab_tests_target, ppsa_notification_target: p.ppsa_notification_target,
        tribal_action_plan: p.tribal_action_plan, hill_district: p.hill_district, patients_per_tu: p.patients_per_tu, patients_per_tdc: p.patients_per_tdc,
        lab_tests_per_patient: p.lab_tests_per_patient, acf_visits_per_patient: p.acf_visits_per_patient, planning_strain_score: p.planning_strain_score, planning_tier: p.planning_tier },
      synthetic: { outcome_index: o.outcome_index, early_death_rate: o.early_death_rate, early_death_lo: o.early_death_rate_lo, early_death_hi: o.early_death_rate_hi,
        pre_treatment_loss: o.pre_treatment_loss, delay_over_14d: o.diagnosis_to_start_delay, open_referral_rate: o.open_referral_rate, missed_follow_up_rate: o.missed_follow_up_rate,
        cases_evaluated: o.cases_evaluated, on_treatment: o.on_treatment_now, gaps: gD[it.district] || zeroGaps(), qoq_change_pct: t.qoq_change_pct,
        projected_next_quarter: t.projected_next_quarter, projected_lo: t.projected_lo, projected_hi: t.projected_hi, last_quarter: t.last_quarter, demand_flag: t.demand_flag } };
  });
  const mapR = it => ({ key: it.patient_key, list: it.list_type, risk: it.risk, tier: it.tier, reasons: it.reasons || [], facility: it.facility_id, district: it.district,
    day: it.days_since_start, age: it.age, sex: it.sex, dr: it.drug_resistant, rank: it.rank_in_facility });
  const review = [...((R.r1 || {}).items || []), ...((R.r2 || {}).items || [])].map(mapR);
  const split = s => s ? String(s).split(',').filter(Boolean) : [];
  const duplicates = ((R.dups || {}).items || []).map(p => ({ id: p.id, p: p.probability, band: p.band, district: p.district, matching: split(p.matching), differing: split(p.differing),
    a: p.record_a, b: p.record_b }));
  const cards = {};
  Object.entries(R.cards || {}).forEach(([k, c]) => {
    const pm = c.performance_holdout || {};
    cards[k] = { model: c.model, version: c.version, algorithm: c.chosen_algorithm, outcome: c.outcome_definition, moment: c.scoring_moment, intended_use: c.intended_use,
      cohort: c.training_cohort, limitations: c.known_limitations || [], baseline_vs_challenger: c.baseline_vs_challenger, thresholds: c.tier_thresholds, reasons_method: c.reasons_method,
      metrics: pm, deciles: pm.decile_calibration || [], subgroups: c.subgroup_performance || [], odds_ratios: c.odds_ratios || {} };
  });
  const death = R.death ? { timing: R.death.timing, factors: R.death.factors || [], addressable: R.death.addressable_share, addressable2: null,
    queue: (R.dqueue || {}).items || [], flagged_facilities: (R.death.facility_oe || []).filter(f => f.flag) } : null;

  S.data = Object.assign({}, SNAP, {
    meta: Object.assign({}, SNAP.meta, { as_of: ov.meta && ov.meta.as_of, source: ov.meta && ov.meta.source, version: ov.meta && ov.meta.version, pilot }),
    districts, facilities, review, gaps, duplicates, cards: Object.keys(cards).length ? cards : SNAP.cards,
    gap_totals: ov.open_gaps || {}, death_audit: death, quality: R.quality || null, tier_counts: null,
    kpi: { on_treatment: ov.on_treatment, pending_dups: ov.pending_duplicate_pairs },
    live: { audit: R.audit ? R.audit.items : null },
  });
}

async function signIn(apiBase, username, password) {
  const base = apiBase.replace(/\/+$/, '');
  const r = await fetch(base + '/auth/token', { method: 'POST', body: new URLSearchParams({ username, password }) });
  if (!r.ok) { let msg = 'Sign-in failed'; try { msg = (await r.json()).detail || msg; } catch (e) { /* ignore */ } throw new Error(msg); }
  const tok = await r.json();
  S.live = { api: base, token: tok.access_token, me: null };
  try { S.live.me = await api('/me'); await activateLive(); }
  catch (e) { S.live = null; throw e; }
  storeSet('sessionStorage', 'session', { api: base, token: tok.access_token });
  storeSet('localStorage', 'api', base);
}
async function activateLive() {
  $('#view').classList.add('busy');
  try {
    await loadLive();
    const me = S.live.me;
    S.role = API_ROLE[me.role] || 'state';
    S.district = me.district || S.district;
    S.facility = me.facility_id || S.facility;
    S.f = {}; S.limit = {};
    if (!roleDef().tabs.includes(S.tab)) S.tab = 'overview';
  } finally { $('#view').classList.remove('busy'); }
  renderAll();
}
function signOut(msg) {
  S.live = null; S.data = SNAP; S.f = {}; S.limit = {};
  Object.keys(IDENT).forEach(k => { delete IDENT[k]; });
  storeSet('sessionStorage', 'session', null);
  renderAll();
  if (msg) toast(msg);
}
async function restoreSession() {
  const s = storeGet('sessionStorage', 'session', null);
  if (!s || !s.token) return;
  S.live = { api: s.api, token: s.token, me: null };
  try { S.live.me = await api('/me'); await activateLive(); toast('Signed in as ' + S.live.me.display_name); }
  catch (e) { S.live = null; storeSet('sessionStorage', 'session', null); }
}

function loginDialog() {
  const dlg = $('#login');
  const err = el('p', { class: 'err', role: 'alert' });
  const apiIn = el('input', { type: 'url', name: 'api', required: true, value: defaultApi(), autocomplete: 'url' });
  const userIn = el('input', { type: 'text', name: 'username', required: true, autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
  const passIn = el('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const demo = ['state_admin', 'data_manager', 'dto_dibrugarh', 'dto_kamrup_metro', 'dto_cachar', 'tu_as-dib-tu01', 'field_as-kmm-tu02'];
  const form = el('form', { onsubmit: async e => {
    e.preventDefault(); err.textContent = ''; submit.disabled = true; submit.textContent = 'Signing in…';
    try { await signIn(apiIn.value.trim(), userIn.value.trim(), passIn.value); dlg.close(); toast('Signed in as ' + S.live.me.display_name + '. Showing live data.'); }
    catch (ex) { err.textContent = ex.message === 'Failed to fetch' ? 'Could not reach the API at that address. Is the server running (python -m tbds.cli serve)?' : ex.message; }
    finally { submit.disabled = false; submit.textContent = 'Sign in'; }
  } },
    el('h2', { id: 'login-title', text: 'Sign in for live data' }),
    el('p', { class: 'muted small', text: 'Connects to the TB decision support API. What you see is limited by your role, and your views and actions are logged.' }),
    el('label', { class: 'field' }, el('span', { text: 'API address' }), apiIn),
    el('label', { class: 'field' }, el('span', { text: 'Username' }), userIn),
    el('label', { class: 'field' }, el('span', { text: 'Password' }), passIn),
    el('div', { class: 'small muted', text: 'Demo accounts (password set at seeding, default ChangeMe!2026):' }),
    el('div', { class: 'demo-acc' }, demo.map(u => el('button', { type: 'button', onclick: () => { userIn.value = u; passIn.focus(); } }, u))),
    err,
    el('div', { class: 'btnrow' }, submit, el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel')));
  dlg.replaceChildren(form);
  dlg.showModal(); userIn.focus();
}

// ================================================================= shell
const VIEWS = { overview: viewOverview, districts: viewDistricts, facilities: viewFacilities, review: viewReview, gaps: viewGaps, duplicates: viewDuplicates, deaths: viewDeaths, evidence: viewEvidence };
const NAV = [
  { id: 'overview', icon: 'grid' },
  { id: 'review', icon: 'clock', badge: c => [c.highRisk, 'high'] },
  { id: 'facilities', icon: 'home', badge: c => [c.supervise, 'med'] },
  { id: 'districts', icon: 'map' },
  { id: 'gaps', icon: 'arrow', badge: c => [c.gaps, 'high'] },
  { id: 'duplicates', icon: 'copy', badge: c => [c.dups, ''] },
  { id: 'deaths', icon: 'pulse', badge: c => [c.flagged, ''] },
  { sep: true },
  { id: 'evidence', icon: 'info', sub: true },
];
const pill = (cls, text) => el('span', { class: 'pill hide-sm ' + cls }, el('i'), text);

function navCounts() {
  const sc = scoped();
  return {
    highRisk: new Set(sc.review.filter(p => p.tier === 'high').map(p => p.key)).size,
    supervise: sc.facilities.filter(f => f.priority === 'supervise_first').length,
    gaps: sumGaps(gapCounts()),
    dups: Math.max(0, pendingDups(sc) - (isLive() ? 0 : sc.dups.filter(p => S.decisions[p.id]).length)),
    flagged: sc.flagged.length,
  };
}
const roleLabel = () => isLive() ? (API_ROLE_LABEL[S.live.me.role] || S.live.me.role) : roleDef().label;
const userName = () => isLive() ? S.live.me.display_name : `Demo · ${roleDef().label}`;
function initials(s) {
  const words = s.replace(/\(.*?\)/g, '').replace(/^Demo · /, '').split(/[\s,]+/).filter(w => /^[A-Za-z]/.test(w));
  return words.slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'U';
}

function goTab(t) {
  if (!roleDef().tabs.includes(t)) return;
  S.tab = t;
  if (location.hash !== '#' + t) history.replaceState(null, '', '#' + t);
  closeNav(); render(); window.scrollTo({ top: 0 });
}

function renderSidebar() {
  const c = navCounts(), tabs = roleDef().tabs;
  const scopeLabel = S.role === 'district' ? 'Active district' : S.role === 'facility' ? 'Active facility' : 'Scope';
  const scopeValue = S.role === 'district' ? S.district : S.role === 'facility' ? facName(S.facility) : S.role === 'data' ? 'State-wide · data' : 'Assam · state-wide';
  $('#scope-slot').replaceChildren(el('button', { class: 'scope-box', type: 'button', title: isLive() ? 'Set by your account' : 'Change view', onclick: e => { e.stopPropagation(); openMenu(); } },
    el('small', { text: scopeLabel }), el('b', { text: scopeValue })));
  const items = [];
  NAV.forEach(n => {
    if (n.sep) { items.push(el('div', { class: 'nav-sep' })); return; }
    if (!tabs.includes(n.id)) return;
    const b = n.badge ? n.badge(c) : null;
    items.push(el('button', { class: 'nav-item' + (n.sub ? ' sub' : ''), type: 'button', 'data-tab': n.id, 'aria-current': S.tab === n.id ? 'page' : null, onclick: () => goTab(n.id) },
      icon(n.icon), el('span', { text: TABS[n.id] }), b && b[0] ? el('span', { class: 'nav-badge ' + b[1], text: b[0] > 999 ? '999+' : num(b[0]) }) : null));
  });
  $('#nav').replaceChildren(...items);
}

function renderHeader() {
  $('#crumb').textContent = `Assam NHM · TB Programme · ${roleLabel()}`;
  $('#page-title').textContent = S.title || TABS[S.tab];
  const m = S.data.meta;
  const dataPill = isLive()
    ? el('span', { class: 'pill live hide-sm', title: `Live data from ${S.live.api}` }, el('i'), `Live · ${fmtDate(m.as_of)}`)
    : el('span', { class: 'pill hide-sm', title: 'Pipeline snapshot embedded in this page; works offline' }, el('i'), `Snapshot · ${fmtDate(m.as_of)}`);
  const name = userName();
  const chip = el('button', { class: 'user-chip', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': String($('#umenu').classList.contains('open')), title: name,
    onclick: e => { e.stopPropagation(); toggleMenu(); } },
    el('span', { class: 'avatar', text: initials(name) }), el('span', { text: name }), icon('chev'));
  $('#head-right').replaceChildren(...(S.headPills || []), dataPill, chip);
}

function renderMenu() {
  const secs = [];
  secs.push(el('div', { class: 'um-sec um-who' }, el('b', { text: userName() }),
    el('span', { text: isLive() ? `${roleLabel()} · ${S.live.api}` : 'Offline snapshot · actions stay in this browser' })));
  if (!isLive()) {
    secs.push(el('div', { class: 'um-sec' }, el('div', { class: 'um-h', text: 'View as' }),
      el('div', { class: 'um-roles' }, ROLES.map(r => el('button', { type: 'button', 'aria-pressed': String(S.role === r.id), onclick: () => setRole(r.id) }, r.label))),
      S.role === 'district' ? districtPicker() : S.role === 'facility' ? facilityPicker() : null));
    secs.push(el('div', { class: 'um-sec' }, el('button', { class: 'btn primary', type: 'button', style: { width: '100%', justifyContent: 'center' }, onclick: () => { closeMenu(); loginDialog(); } }, icon('user'), 'Sign in for live data')));
  } else {
    secs.push(el('div', { class: 'um-sec um-actions' },
      el('button', { class: 'btn sm', type: 'button', onclick: () => { closeMenu(); activateLive().then(() => toast('Refreshed from the server.')).catch(e => toast('Refresh failed: ' + e.message)); } }, icon('refresh'), 'Refresh'),
      el('button', { class: 'btn sm', type: 'button', onclick: () => { closeMenu(); signOut('Signed out. Showing the snapshot.'); } }, icon('logout'), 'Sign out')));
  }
  const theme = storeGet('localStorage', 'theme', 'auto');
  secs.push(el('div', { class: 'um-sec' }, el('div', { class: 'um-h', text: 'Appearance' }),
    el('div', { class: 'row' }, seg('Theme', { auto: 'Auto', light: 'Light', dark: 'Dark' }, theme, v => { storeSet('localStorage', 'theme', v); applyTheme(); renderMenu(); }),
      el('span', { class: 'grow' }),
      el('button', { class: 'iconbtn', type: 'button', title: 'Print this page', 'aria-label': 'Print this page', onclick: () => { closeMenu(); window.print(); } }, icon('print')))));
  $('#umenu').replaceChildren(...secs);
}
function districtPicker() {
  return el('select', { 'aria-label': 'District', onchange: e => { S.district = e.target.value; resetView(); render(); renderMenu(); } },
    SNAP.districts.map(x => x.district).sort().map(dn => el('option', { value: dn, selected: dn === S.district }, dn + (isPilot(dn) ? ' (pilot)' : ''))));
}
function facilityPicker() {
  return el('select', { 'aria-label': 'Facility', onchange: e => { S.facility = e.target.value; S.district = SNAP.facilities.find(f => f.id === S.facility).district; resetView(); render(); renderMenu(); } },
    SNAP.meta.pilot.map(dn => el('optgroup', { label: dn }, pilotFacilities.filter(f => f.district === dn).map(f => el('option', { value: f.id, selected: f.id === S.facility }, f.name)))));
}
function resetView() { S.f = {}; S.limit = {}; S.sel = null; }
function setRole(id) {
  S.role = id; resetView();
  if (id === 'facility') {
    const fac = SNAP.facilities.find(f => f.id === S.facility);
    if (!fac || !fac.pilot) S.facility = pilotFacilities[0].id;
    S.district = SNAP.facilities.find(f => f.id === S.facility).district;
  }
  if (!roleDef().tabs.includes(S.tab)) S.tab = 'overview';
  render(); renderMenu();
}
function openMenu() { renderMenu(); $('#umenu').classList.add('open'); renderHeader(); const b = $('#umenu button'); if (b) b.focus(); }
function closeMenu() { if (!$('#umenu').classList.contains('open')) return; $('#umenu').classList.remove('open'); renderHeader(); }
function toggleMenu() { if ($('#umenu').classList.contains('open')) closeMenu(); else openMenu(); }
function openNav() { $('#side').classList.add('open'); $('#veil').classList.add('on'); $('#menu-btn').setAttribute('aria-expanded', 'true'); }
function closeNav() {
  if (!$('#side').classList.contains('open')) return;
  $('#side').classList.remove('open'); $('#menu-btn').setAttribute('aria-expanded', 'false');
  if (!$('#drawer').classList.contains('open')) $('#veil').classList.remove('on');
}
function applyTheme() {
  const t = storeGet('localStorage', 'theme', 'auto');
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}
function renderFoot() {
  const m = S.data.meta;
  $('#foot').replaceChildren(el('div', { class: 'row' },
    el('span', { text: `Version ${m.version} · data as of ${fmtDate(m.as_of)} · ${num(m.records || SNAP.meta.records)} records · ${m.source === 'synthetic' ? 'synthetic patient data' : 'programme extract'}` }),
    el('span', { class: 'grow' }),
    prov('real'), el('a', { href: m.rop_url || SNAP.meta.rop_url, target: '_blank', rel: 'noopener' }, 'NHM Assam NTEP District RoP 2024-26')),
    el('p', { style: { marginTop: '6px' }, text: (m.notice || SNAP.meta.notice) + ' ' + (isLive() ? `Live data from ${S.live.api}; views and actions are recorded in the audit log.` : 'Snapshot mode: data are embedded in this page and work offline.') }));
}
function render() {
  hideTip();
  S.title = TABS[S.tab]; S.headPills = [];
  let nodes;
  try { nodes = VIEWS[S.tab](); }
  catch (e) { console.error(e); nodes = [callout('stop', el('b', { text: 'This view could not be drawn. ' }), String(e.message || e))]; }
  $('#view').replaceChildren(...[].concat(nodes).flat(Infinity).filter(Boolean));
  renderHeader(); renderSidebar();
  document.title = `${S.title} · TB Decision Support, Assam`;
}
function renderAll() { render(); renderFoot(); if ($('#umenu').classList.contains('open')) renderMenu(); }

// ---------------------------------------------------------------- boot
function boot() {
  applyTheme();
  $('#veil').addEventListener('click', () => { closeDrawer(); closeNav(); });
  $('#menu-btn').addEventListener('click', openNav);
  document.addEventListener('click', e => { const m = $('#umenu'); if (m.classList.contains('open') && !e.composedPath().includes(m)) closeMenu(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if ($('#umenu').classList.contains('open')) closeMenu();
    else if ($('#drawer').classList.contains('open')) closeDrawer();
    else closeNav();
  });
  window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS[t] && t !== S.tab) goTab(t); });
  window.addEventListener('scroll', hideTip, { passive: true });
  let narrow = innerWidth < 640;
  window.addEventListener('resize', debounce(() => { if ((innerWidth < 640) !== narrow) { narrow = !narrow; render(); } }, 200));
  const h = location.hash.slice(1);
  if (TABS[h] && roleDef().tabs.includes(h)) S.tab = h;
  renderAll();
  restoreSession();
}
boot();
})();
