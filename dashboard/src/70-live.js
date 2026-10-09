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
    can.fac ? { fac: '/facilities/priority', dist: '/districts/priority', death: '/death-audit/summary', dqueue: '/death-audit/queue?limit=1000', trends: '/trends', feedback: '/feedback/summary' } : {},
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

  const gaps = ((R.gaps || {}).items || []).map(g => ({ type: g.gap_type, rid: g.record_id, key: g.patient_key, facility: g.facility_id, district: g.district,
    days: g.days_open, over: g.over_by_days, sev: g.severity, ref: g.reference_date, status: g.status, assignee: g.assignee, notes: g.notes }));
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
  const reviewItems = [...((R.r1 || {}).items || []), ...((R.r2 || {}).items || [])];
  const review = reviewItems.map(mapR);
  S.liveActions = {};   // reviews already saved on the server, so status survives a reload
  reviewItems.forEach(it => { if (it.last_action) S.liveActions[it.list_type + ':' + it.patient_key] = { action: it.last_action, note: it.last_note || '', at: it.last_action_at, by: it.last_action_by }; });
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
    live: { audit: R.audit ? R.audit.items : null, feedback: R.feedback || null },
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
  if (S.live && S.live.token) fetch(S.live.api + '/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + S.live.token } }).catch(() => {});   // revoke server-side; best effort
  S.live = null; S.data = SNAP; S.f = {}; S.limit = {}; S.liveActions = {}; S._assignable = null;
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

