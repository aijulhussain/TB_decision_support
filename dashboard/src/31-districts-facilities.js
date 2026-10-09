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

