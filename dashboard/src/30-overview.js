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
  out.push(demoGuide());
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

