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
      monitoringSection(c),
      section('Known limitations', null, el('ul', { style: { paddingLeft: '18px', margin: 0 } }, c.limitations.map(l => el('li', { text: l, style: { marginBottom: '4px' } })))));
  }

  out.push(feedbackSection());

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

