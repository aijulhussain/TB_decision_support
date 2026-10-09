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
    section('Deaths to audit', { prov: 'syn', desc: (!isLive() && S.role === 'state' ? 'Recent deaths in the pilot districts. ' : 'Recent deaths in your scope. ') + 'High priority means an early death with at least one factor the programme could have addressed.' + (canAudit() ? ' Select a death to record the audit.' : '') },
      dataTable('audq', [
        { key: 'priority', label: 'Priority', sort: x => x.audit_priority === 'high' ? 0 : 1, render: x => x.audit_priority === 'high' ? badge('tier high', 'High') : badge('tier standard', 'Standard') },
        { key: 'death', label: 'Died', sort: x => x.death_date, render: x => el('span', null, fmtDate(x.death_date), el('span', { class: 'sub', text: `day ${x.days_after_start} of treatment` })) },
        { key: 'patient', label: 'Patient', sort: x => x.patient_key, render: x => el('span', null, el('span', { class: 'mono', text: x.patient_key }), el('span', { class: 'sub', text: `${x.age} ${x.sex}` })) },
        S.role === 'facility' ? null : { key: 'facility', label: 'Facility', sort: x => facName(x.facility_id), render: x => facName(x.facility_id) },
        { key: 'status', label: 'Audit', sort: x => ({ completed: 2, in_progress: 1 })[(deathState(x) || {}).status] || 0, render: x => deathStatusChip(x) },
        { key: 'factors', label: 'Factors', nosort: true, render: x => [...(x.addressable_factors || []).map(fa => el('span', { class: 'chip reason', text: fa })), ...(x.factors || []).filter(fa => !(x.addressable_factors || []).includes(fa)).map(fa => el('span', { class: 'chip', text: fa }))] },
      ].filter(Boolean), sc.deathQ, { onRow: deathDrawer, empty: 'No deaths to audit in this scope.', caption: 'Deaths to audit' }),
      el('p', { class: 'small muted', text: 'Shaded factors are ones the programme can act on (for example treatment delay or no nutrition support).' })),
  ];
}

