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
const TABS = { overview: 'Overview', tasks: 'My tasks', districts: 'Districts', facilities: 'Facilities', review: 'Patient risk', gaps: 'Care gaps', duplicates: 'De-duplication', deaths: 'Death audit', evidence: 'Model evidence' };
const ROLES = [
  { id: 'state', label: 'State TB Cell', tabs: ['overview', 'districts', 'facilities', 'review', 'gaps', 'duplicates', 'deaths', 'evidence'] },
  { id: 'district', label: 'District officer', tabs: ['overview', 'tasks', 'facilities', 'review', 'gaps', 'duplicates', 'deaths', 'evidence'] },
  { id: 'facility', label: 'Facility team', tabs: ['overview', 'tasks', 'review', 'gaps', 'evidence'] },
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
  gapLocal: storeGet('localStorage', 'gaps', {}),       // snapshot-mode gap work: key -> history, newest first
  deathLocal: storeGet('localStorage', 'deaths', {}),   // snapshot-mode death audits: patient_key -> latest review
  liveActions: {},                                       // live-mode reviews as saved on the server
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
/* Short status message. opts.action + opts.onAction add a button (used for Undo); such toasts stay a little longer. */
function toast(msg, opts) {
  const t = $('#toast');
  t.replaceChildren(el('span', { text: msg }));
  if (opts && opts.action) {
    t.append(el('button', { type: 'button', class: 'toast-btn', onclick: () => { t.style.display = 'none'; opts.onAction(); } }, opts.action));
  }
  t.style.display = 'flex';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, opts && opts.action ? 7000 : 3800);
}
const slug = s => String(s).toLowerCase().replace(/ /g, '_');
/* The user the current view acts as: the signed-in account, or the matching demo account in snapshot mode. */
function me() {
  if (S.live) return S.live.me.username;
  return { state: 'state_admin', data: 'data_manager', district: 'dto_' + slug(S.district), facility: 'tu_' + String(S.facility).toLowerCase() }[S.role];
}

