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

