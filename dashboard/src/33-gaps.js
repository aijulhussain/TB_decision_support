// ---------------------------------------------------------------- gaps
function viewGaps() {
  const sc = scoped(), gc = gapCounts(), f = S.f;
  let rows = sc.gaps;
  const facs = [...new Set(rows.map(g => g.facility))].sort();
  if (f.gapType) rows = rows.filter(g => g.type === f.gapType);
  if (f.gapSev) rows = rows.filter(g => g.sev === f.gapSev);
  if (f.gapFac && S.role !== 'facility') rows = rows.filter(g => g.facility === f.gapFac);
  const gst = f.gapStatus == null ? 'unresolved' : f.gapStatus;
  if (gst === 'unresolved') rows = rows.filter(g => gapState(g).status !== 'resolved');
  else if (gst) rows = rows.filter(g => gapState(g).status === gst);
  if (f.gapMine) rows = rows.filter(g => gapState(g).assignee === me());
  if (!S.sort.gaps) S.sort.gaps = { key: 'over', dir: -1 };
  const maxOver = Math.max(1, ...sc.gaps.map(g => g.over));
  const cols = [
    { key: 'type', label: 'Gap', sort: g => GAP[g.type] ? GAP[g.type].label : g.type, render: g => el('span', null, el('b', { text: GAP[g.type] ? GAP[g.type].label : g.type }), el('span', { class: 'sub', text: g.key ? 'Patient ' + g.key : 'Lab result, patient not yet registered' })) },
    S.role === 'facility' ? null : { key: 'facility', label: 'Facility', sort: g => facName(g.facility), render: g => el('span', null, facName(g.facility), el('span', { class: 'sub', text: g.district })) },
    { key: 'days', label: 'Days open', num: true },
    { key: 'over', label: 'Days past threshold', num: true, render: g => cellBar(g.over, maxOver, num(g.over), g.sev === 'severe' ? 'high' : g.sev === 'high' ? 'med' : '') },
    { key: 'sev', label: 'Severity', sort: g => ({ severe: 0, high: 1, moderate: 2 })[g.sev], render: g => sevBadge(g.sev) },
    { key: 'status', label: 'Status', sort: g => ({ open: 0, assigned: 1, resolved: 2 })[gapState(g).status], render: g => gapStatusChip(g) },
  ].filter(Boolean);
  const partial = !isLive() && (S.role === 'state' || !isPilot(S.district));
  return [
    pageHead('Referral and follow-up gaps', 'Simple, auditable rules find patients whose next step is overdue. Assign each gap to a person, add notes as you work it, and mark it resolved when the step is done.'),
    el('div', { class: 'kpis' }, GAP_KEYS.map(k => {
      const b = el('button', { class: 'kpi' + (f.gapType === k ? ' brand' : ''), type: 'button', 'aria-pressed': String(f.gapType === k), onclick: () => { f.gapType = f.gapType === k ? '' : k; S.limit.gaps = 0; render(); } },
        el('span', { class: 'l', text: GAP[k].label }), el('span', { class: 'v', text: num(gc[k]) }), el('span', { class: 's', text: GAP[k].rule }));
      return b;
    })),
    partial ? callout(null, el('b', { text: 'Counts cover the whole scope; the patient list covers pilot districts. ' }), 'In this snapshot, patient-level gap lists are included for ' + S.data.meta.pilot.join(' and ') + ' only. Signed-in users see every gap in their scope.') : null,
    section('Gaps', { prov: 'syn', right: exportBtn('referral_gaps', () => csvDownload('referral_gaps', ['gap_type', 'patient_key', 'facility_id', 'district', 'days_open', 'over_by_days', 'severity'], rows.map(g => [g.type, g.key, g.facility, g.district, g.days, g.over, g.sev]))) },
      el('div', { class: 'filters' },
        select('Gap type', [{ value: '', label: 'All gap types' }, ...GAP_KEYS.map(k => ({ value: k, label: GAP[k].label }))], f.gapType || '', v => { f.gapType = v; render(); }),
        select('Severity', [{ value: '', label: 'All' }, { value: 'severe', label: 'Severe' }, { value: 'high', label: 'High' }, { value: 'moderate', label: 'Moderate' }], f.gapSev || '', v => { f.gapSev = v; render(); }),
        S.role !== 'facility' ? select('Facility', [{ value: '', label: 'All facilities' }, ...facs.map(id => ({ value: id, label: facName(id) }))], f.gapFac || '', v => { f.gapFac = v; render(); }) : null,
        seg('Status', { unresolved: 'Unresolved', open: 'Open', assigned: 'Assigned', resolved: 'Resolved', '': 'All' }, gst, v => { f.gapStatus = v; S.limit.gaps = 0; render(); }),
        canWorkGaps() ? el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !!f.gapMine, onchange: e => { f.gapMine = e.target.checked; render(); } }), el('span', { text: 'Assigned to me' })) : null),
      dataTable('gaps', cols, rows, { onRow: gapDrawer, empty: gst === 'resolved' ? 'No resolved gaps yet.' : 'No gaps match these filters.', caption: 'Care gaps' })),
  ];
}

