// ---------------------------------------------------------------- workflow: care gaps, death audits, my tasks
/* Gap and audit work is saved on the server in live mode and in this browser in snapshot mode. Both modes share the
   same shapes so every view reads state through gapState() and deathState(). */

const AUDIT_FACTORS = {
  delay_in_diagnosis: 'Delay in diagnosis', delay_in_treatment_start: 'Delay in starting treatment', no_nutrition_support: 'No nutrition support (NPY)',
  missed_follow_up: 'Missed follow-up', comorbidity_not_managed: 'Comorbidity not managed (HIV, diabetes)', referral_not_completed: 'Referral not completed',
  drug_resistance_not_detected: 'Drug resistance not detected in time', adverse_drug_reaction: 'Adverse drug reaction',
  patient_or_social_factors: 'Patient or social factors', other: 'Other',
};
const GAP_STATUS = { open: 'Open', assigned: 'Assigned', resolved: 'Resolved' };
const gapKey = g => g.type + ':' + g.rid;
const canWorkGaps = () => S.live ? ['district_officer', 'facility_user', 'field_worker'].includes(S.live.me.role) : (S.role === 'district' || S.role === 'facility');
const canAudit = () => S.live ? S.live.me.role === 'district_officer' : S.role === 'district';

function gapState(g) {
  if (S.live) return { status: g.status || 'open', assignee: g.assignee || null, notes: g.notes || 0 };
  const h = S.gapLocal[gapKey(g)] || [];
  const res = h.find(x => x.action === 'resolved' || x.action === 'reopened');
  const own = h.find(x => x.action === 'assigned');
  const status = res && res.action === 'resolved' ? 'resolved' : own ? 'assigned' : 'open';
  return { status, assignee: own ? own.assignee : null, notes: h.filter(x => x.action === 'note').length };
}
function gapStatusChip(g) {
  const st = gapState(g);
  if (st.status === 'resolved') return el('span', { class: 'chip ok', text: '✓ Resolved' });
  if (st.status === 'assigned') return el('span', { class: 'chip done', text: '→ ' + personLabel(st.assignee) });
  return el('span', { class: 'chip', text: 'Open' });
}
function personLabel(u) {
  if (!u) return '–';
  if (u === me()) return 'Me';
  const m = /^(tu|field)_(.+)$/.exec(u);
  if (m) return `${m[1] === 'tu' ? 'Facility team' : 'Field staff'}, ${facName(m[2].toUpperCase())}`;
  const d = /^dto_(.+)$/.exec(u);
  if (d) return 'District officer';
  return u;
}

async function assignableFor(g) {
  if (S.live) {
    S._assignable = S._assignable || {};
    if (!S._assignable[g.facility]) S._assignable[g.facility] = (await api('/users/assignable?facility_id=' + encodeURIComponent(g.facility))).items;
    return S._assignable[g.facility];
  }
  const out = [];
  const fac = SNAP.facilities.find(f => f.id === g.facility);
  if (fac && fac.pilot) {
    out.push({ username: 'tu_' + g.facility.toLowerCase(), role: 'facility_user', display_name: facName(g.facility) + ' team' });
    out.push({ username: 'field_' + g.facility.toLowerCase(), role: 'field_worker', display_name: 'Field staff, ' + facName(g.facility) });
  }
  out.push({ username: 'dto_' + slug(g.district), role: 'district_officer', display_name: 'District TB Officer, ' + g.district });
  return out;
}

async function gapAction(g, action, assignee, note) {
  const rec = { ts: new Date().toISOString(), username: me(), action, assignee: action === 'assigned' ? assignee : null, note: (note || '').trim() };
  if (S.live) {
    await api(`/referral-gaps/${encodeURIComponent(g.type)}/${encodeURIComponent(g.rid)}/actions`, { method: 'POST', json: { action, assignee: rec.assignee, note: rec.note } });
    if (action === 'assigned') { g.assignee = assignee; if (g.status !== 'resolved') g.status = 'assigned'; }
    if (action === 'resolved') g.status = 'resolved';
    if (action === 'reopened') g.status = g.assignee ? 'assigned' : 'open';
    if (action === 'note') g.notes = (g.notes || 0) + 1;
  } else {
    const k = gapKey(g);
    S.gapLocal[k] = [rec, ...(S.gapLocal[k] || [])];
    storeSet('localStorage', 'gaps', S.gapLocal);
  }
}

async function gapHistory(g) {
  if (S.live) return (await api(`/referral-gaps/${encodeURIComponent(g.type)}/${encodeURIComponent(g.rid)}/history`)).items;
  return S.gapLocal[gapKey(g)] || [];
}

function gapDrawer(g) {
  const st = gapState(g), info = GAP[g.type] || { label: g.type, rule: '' };
  const write = canWorkGaps();
  const run = async (action, assignee, note, msg) => {
    try { await gapAction(g, action, assignee, note); }
    catch (e) { toast('Could not save: ' + e.message); return; }
    render(); gapDrawer(g);
    if (action === 'resolved') toast(msg, { action: 'Undo', onAction: () => run('reopened', null, 'Undo: reopened', 'Gap reopened.') });
    else toast(msg);
  };
  const historyBox = el('div', { class: 'timeline' }, el('p', { class: 'small muted', text: 'Loading history…' }));
  gapHistory(g).then(items => {
    historyBox.replaceChildren(...(items.length ? items.map(h => el('div', { class: 'tl-item' },
      el('b', { text: { assigned: 'Assigned to ' + personLabel(h.assignee), note: 'Note', resolved: 'Marked resolved', reopened: 'Reopened' }[h.action] || h.action }),
      el('span', { class: 'small muted', text: ` · ${personLabel(h.username)} · ${fmtDateTime(h.ts)}` }),
      h.note ? el('div', { class: 'tl-note', text: h.note }) : null)) : [el('p', { class: 'small muted', text: 'No actions yet.' })]));
  }).catch(e => historyBox.replaceChildren(el('p', { class: 'small muted', text: 'History unavailable: ' + e.message })));

  const work = [];
  if (write) {
    const who = el('select', { 'aria-label': 'Assign to' }, el('option', { value: '', text: 'Choose a person…' }));
    assignableFor(g).then(list => list.forEach(u => who.append(el('option', { value: u.username, selected: u.username === st.assignee }, (u.username === me() ? 'Me · ' : '') + (u.display_name || u.username)))))
      .catch(e => toast('Could not load people: ' + e.message));
    const note = el('textarea', { maxlength: '500', placeholder: 'What was done, or what is blocking it' });
    work.push(el('h3', { text: 'Assign' }),
      el('div', { class: 'ident-form' }, who, el('button', { class: 'btn sm', type: 'button', onclick: () => { if (!who.value) { toast('Choose a person first.'); return; } run('assigned', who.value, '', 'Assigned to ' + personLabel(who.value) + '.'); } }, 'Assign')),
      el('h3', { text: 'Add a note' }), note,
      el('div', { class: 'btnrow', style: { marginTop: '10px' } },
        el('button', { class: 'btn sm', type: 'button', onclick: () => { if (!note.value.trim()) { toast('Write a note first.'); return; } run('note', null, note.value, 'Note added.'); } }, 'Add note'),
        el('span', { class: 'grow' }),
        st.status === 'resolved'
          ? el('button', { class: 'btn sm', type: 'button', onclick: () => run('reopened', null, note.value, 'Gap reopened.') }, 'Reopen')
          : el('button', { class: 'btn primary sm', type: 'button', onclick: () => run('resolved', null, note.value, 'Marked resolved.') }, '✓ Mark resolved')));
  } else {
    work.push(el('p', { class: 'warnline', style: { marginTop: '14px' }, text: 'Your role can see gaps but not work on them. District officers and facility teams assign and resolve gaps.' }));
  }

  openDrawer(info.label, [sevBadge(g.sev), gapStatusChip(g)],
    el('p', { class: 'muted small', text: info.rule + '.' }),
    kv([[g.key ? 'Patient' : 'Lab record', el('span', { class: 'mono', text: g.key || g.rid })], ['Facility', facName(g.facility)], ['District', g.district],
      g.ref ? ['Since', fmtDate(g.ref)] : null, ['Days open', num(g.days)], ['Past threshold by', plural(g.over, 'day')],
      ['Assigned to', st.assignee ? personLabel(st.assignee) : 'Nobody yet']]),
    work,
    el('h3', { text: 'History' }), historyBox,
    el('p', { class: 'small muted', style: { marginTop: '12px' }, text: S.live ? 'Every action is recorded in the audit log.' : 'Snapshot mode: actions are saved in this browser only.' }));
}

// ---- death audits
function deathState(q) { return S.live ? q.review || null : S.deathLocal[q.patient_key] || null; }
function deathStatusChip(q) {
  const r = deathState(q);
  if (!r) return el('span', { class: 'chip', text: 'Not started' });
  if (r.status === 'completed') return el('span', { class: 'chip ok', text: '✓ Audited' + (r.avoidable ? ' · avoidable: ' + r.avoidable : '') });
  return el('span', { class: 'chip done', text: 'In progress' });
}

function deathDrawer(q) {
  const r = deathState(q) || {};
  const can = canAudit();
  let status = r.status || 'in_progress', avoid = r.avoidable || '';
  const chosen = new Set(r.contributing || []);
  const summary = el('textarea', { maxlength: '2000', placeholder: 'What happened, in brief: timeline, care received, gaps found' }, r.summary || '');
  const agreed = el('textarea', { maxlength: '2000', placeholder: 'Actions agreed, owner and date' }, r.actions_agreed || '');
  const statusSeg = () => seg('Audit status', { in_progress: 'In progress', completed: 'Completed' }, status, v => { status = v; statusBox.replaceChildren(statusSeg()); });
  const avoidSeg = () => seg('Avoidable', { yes: 'Yes', no: 'No', unclear: 'Unclear' }, avoid, v => { avoid = v; avoidBox.replaceChildren(avoidSeg()); });
  const statusBox = el('div', null, statusSeg()), avoidBox = el('div', null, avoidSeg());
  const boxes = el('div', { class: 'checks' }, Object.entries(AUDIT_FACTORS).map(([k, l]) => el('label', { class: 'check' },
    el('input', { type: 'checkbox', checked: chosen.has(k), onchange: e => { if (e.target.checked) chosen.add(k); else chosen.delete(k); } }), el('span', { text: l }))));
  const save = async () => {
    if (status === 'completed' && !avoid) { toast('Say whether the death was avoidable before completing.'); return; }
    const rec = { status, avoidable: avoid || null, contributing: [...chosen], summary: summary.value.trim(), actions_agreed: agreed.value.trim(), ts: new Date().toISOString(), username: me() };
    if (S.live) {
      try { await api(`/death-audit/${encodeURIComponent(q.patient_key)}/review`, { method: 'POST', json: { status: rec.status, avoidable: rec.avoidable, contributing: rec.contributing, summary: rec.summary, actions_agreed: rec.actions_agreed } }); }
      catch (e) { toast('Could not save: ' + e.message); return; }
      q.review = rec;
    } else { S.deathLocal[q.patient_key] = rec; storeSet('localStorage', 'deaths', S.deathLocal); }
    toast(status === 'completed' ? 'Audit completed.' : 'Audit saved as in progress.');
    closeDrawer(); render();
  };
  openDrawer('Death audit', [q.audit_priority === 'high' ? badge('tier high', 'High priority') : badge('tier standard', 'Standard'), deathStatusChip(q)],
    kv([['Patient', el('span', { class: 'mono', text: q.patient_key })], ['Died', `${fmtDate(q.death_date)} · day ${q.days_after_start} of treatment`],
      ['Age and sex', `${q.age} ${q.sex}`], ['Facility', facName(q.facility_id)], ['District', q.district]]),
    el('h3', { text: 'Factors on record' }),
    el('div', null, (q.addressable_factors || []).map(f => el('span', { class: 'chip reason', text: f })),
      (q.factors || []).filter(f => !(q.addressable_factors || []).includes(f)).map(f => el('span', { class: 'chip', text: f })),
      !(q.factors || []).length ? el('span', { class: 'muted small', text: 'None recorded.' }) : null),
    can ? [
      el('h3', { text: 'Status' }), statusBox,
      el('h3', { text: 'Was the death avoidable?' }), avoidBox,
      el('h3', { text: 'Contributing factors' }), boxes,
      el('h3', { text: 'Summary' }), summary,
      el('h3', { text: 'Actions agreed' }), agreed,
      el('div', { class: 'btnrow', style: { marginTop: '14px' } }, el('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save audit')),
    ] : [
      el('h3', { text: 'Audit finding' }),
      r.status ? kv([['Status', r.status === 'completed' ? 'Completed' : 'In progress'], ['Avoidable', r.avoidable || '–'],
        ['Contributing', (r.contributing || []).map(k => AUDIT_FACTORS[k] || k).join(', ') || '–'], ['Summary', r.summary || '–'], ['Actions agreed', r.actions_agreed || '–']])
        : el('p', { class: 'small muted', text: 'Not audited yet. District TB officers record death audits.' }),
    ],
    el('p', { class: 'small muted', style: { marginTop: '12px' }, text: S.live ? 'Each save is kept; the latest is the current finding. Recorded in the audit log.' : 'Snapshot mode: saved in this browser only.' }));
}

// ---- my tasks
function myTasks() {
  const sc = scoped();
  const mine = sc.gaps.filter(g => { const st = gapState(g); return st.assignee === me() && st.status !== 'resolved'; });
  const seen = new Set();
  const patients = isPilot(S.district) ? sc.review.filter(p => p.tier === 'high' && !actionOf(p) && !seen.has(p.list + p.key) && seen.add(p.list + p.key)) : [];
  const deaths = canAudit() ? sc.deathQ.filter(q => q.audit_priority === 'high' && (deathState(q) || {}).status !== 'completed') : [];
  return { mine, patients, deaths, total: mine.length + patients.length + deaths.length };
}

function viewTasks() {
  const t = myTasks();
  const head = pageHead('My tasks', 'Everything waiting on you in one place: gaps assigned to you, high-risk patients nobody has reviewed yet' + (canAudit() ? ', and early deaths awaiting audit.' : '.'));
  const gapList = t.mine.length ? el('div', { class: 'task-list' }, t.mine.sort((a, b) => b.over - a.over).map(g => el('button', { class: 'task', type: 'button', onclick: () => gapDrawer(g) },
    sevBadge(g.sev), el('div', { class: 'task-main' }, el('b', { text: (GAP[g.type] || {}).label || g.type }), el('span', { text: `${facName(g.facility)} · ${g.key ? 'patient ' + g.key.slice(0, 10) : 'lab record'} · ${plural(g.over, 'day')} past threshold` })),
    el('span', { class: 'task-go', text: 'Open →' }))))
    : emptyState('No gaps are assigned to you. Assign gaps from the Care gaps page.');
  const patList = t.patients.length ? el('div', { class: 'task-list' }, t.patients.sort((a, b) => b.risk - a.risk).slice(0, 25).map(p => el('button', { class: 'task', type: 'button', onclick: () => { S.sel = p.key; S.list = p.list; goTab('review'); } },
    lvl(p.tier), el('div', { class: 'task-main' }, el('b', { class: 'mono', text: `${identName(p.key) || p.key.slice(0, 10)} · ${p.sex}, ${p.age}` }), el('span', { text: `${facName(p.facility)} · ${LIST[p.list]} · ${pct(p.risk, 0)} predicted risk` })),
    el('span', { class: 'task-go', text: 'Review →' }))))
    : emptyState(isPilot(S.district) ? 'Every high-risk patient has been reviewed.' : `Patient risk lists are enabled only in ${S.data.meta.pilot.join(' and ')}.`);
  const out = [head,
    el('div', { class: 'kpis' },
      kpi({ label: 'Gaps assigned to me', value: num(t.mine.length), tone: t.mine.length ? 'med' : 'ok' }),
      kpi({ label: 'High-risk, not reviewed', value: num(t.patients.length), tone: t.patients.length ? 'high' : 'ok', go: 'review' }),
      canAudit() ? kpi({ label: 'Deaths awaiting audit', value: num(t.deaths.length), tone: t.deaths.length ? 'high' : 'ok', go: 'deaths' }) : null),
    card('Gaps assigned to me', 'Sorted by how far past their threshold they are', null, gapList),
    card('High-risk patients not yet reviewed', t.patients.length > 25 ? `Showing 25 of ${num(t.patients.length)}` : 'Highest predicted risk first', null, patList)];
  if (canAudit()) {
    out.push(card('Early deaths awaiting audit', 'High priority: early death with at least one factor the programme could act on', null,
      t.deaths.length ? el('div', { class: 'task-list' }, t.deaths.slice(0, 25).map(q => el('button', { class: 'task', type: 'button', onclick: () => deathDrawer(q) },
        deathStatusChip(q), el('div', { class: 'task-main' }, el('b', { class: 'mono', text: q.patient_key.slice(0, 10) }), el('span', { text: `${facName(q.facility_id)} · died ${fmtDate(q.death_date)}, day ${q.days_after_start} of treatment` })),
        el('span', { class: 'task-go', text: 'Audit →' }))))
        : emptyState('No high-priority deaths are waiting for audit.')));
  }
  if (!S.live) out.push(el('p', { class: 'small muted', text: `Snapshot mode: "me" is the demo account ${me()}. Work you record here stays in this browser.` }));
  return out;
}

// ---- evidence: monitoring and reviewer feedback
function monitoringSection(c) {
  const rows = c.monitoring || [];
  if (!rows.length) return null;
  const flagged = rows.filter(r => r.flag).length;
  return section('Monitoring by month', { prov: 'syn', desc: 'Hold-out performance for each month of treatment starts. A month is flagged when observed events differ from predicted by more than 25%: the signal to recalibrate.' },
    flagged ? callout('warn', el('b', { text: `${plural(flagged, 'month')} flagged for calibration drift. ` }), 'Review recent data and consider recalibrating before the next cycle.')
      : callout(null, el('b', { text: 'No drift detected. ' }), 'Observed events stayed within 25% of predicted in every month with enough patients.'),
    el('div', { style: { height: '12px' } }),
    dataTable('mon', [
      { key: 'month', label: 'Month', render: r => monthLabel(r.month) },
      { key: 'n', label: 'Patients', num: true, render: r => num(r.n) },
      { key: 'events', label: 'Events', num: true, render: r => num(r.events) },
      { key: 'expected', label: 'Expected', num: true, render: r => fx(r.expected, 1) },
      { key: 'oe', label: 'Observed ÷ expected', num: true, render: r => r.oe == null ? '–' : cellBar(r.oe, 2, fx(r.oe, 2), r.flag ? 'high' : 'ok') },
      { key: 'auc', label: 'AUC', num: true, render: r => r.auc == null ? '–' : fx(r.auc, 2) },
      { key: 'flag', label: 'Check', render: r => r.flag ? badge('tier medium', 'Drift') : badge('tier standard', 'OK') },
    ], rows, { page: 24, caption: 'Monitoring by month' }));
}

function feedbackSummary() {
  if (S.live && S.data.live && S.data.live.feedback) return S.data.live.feedback;
  // snapshot: build the same shape from reviews recorded in this browser
  const by_action = {}, fac = {}, fac2 = {};
  S.data.review.forEach(p => {
    const a = actionOf(p); if (!a) return;
    (by_action[p.list] = by_action[p.list] || {})[a.action] = ((by_action[p.list] || {})[a.action] || 0) + 1;
    const f = fac[p.facility] = fac[p.facility] || { reviewed: 0, disagree: 0 }; f.reviewed++; f.disagree += a.action === 'disagree';
    (p.reasons || []).forEach(r => { const x = fac2[r.factor] = fac2[r.factor] || { reviewed: 0, disagree: 0 }; x.reviewed++; x.disagree += a.action === 'disagree'; });
  });
  return { by_action, by_facility: Object.entries(fac).map(([k, v]) => ({ facility_id: k, ...v })), by_factor: Object.entries(fac2).map(([k, v]) => ({ factor: k, ...v })) };
}

function feedbackSection() {
  const fb = feedbackSummary();
  if (!fb) return null;
  const tot = {};
  Object.values(fb.by_action || {}).forEach(m => Object.entries(m).forEach(([a, n]) => { tot[a] = (tot[a] || 0) + n; }));
  const reviewed = Object.values(tot).reduce((a, b) => a + b, 0);
  const rate = x => x.reviewed ? x.disagree / x.reviewed : 0;
  return section('Reviewer feedback', { prov: S.live ? null : 'syn', desc: 'How reviewers responded to flags. Disagreement is the most useful signal for the next model review: a factor or facility with many disagreements needs a closer look.' },
    reviewed ? [
      el('div', { class: 'kpis' },
        kpi({ label: 'Reviews recorded', value: num(reviewed) }),
        kpi({ label: 'Action taken', value: num(tot.acted || 0), tone: 'ok' }),
        kpi({ label: 'Disagreed with flag', value: num(tot.disagree || 0), sub: pct((tot.disagree || 0) / reviewed, 0) + ' of reviews', tone: (tot.disagree || 0) / reviewed > 0.25 ? 'high' : 'med' }),
        kpi({ label: 'Not applicable', value: num(tot.not_applicable || 0) })),
      el('div', { style: { height: '12px' } }),
      dataTable('fbf', [
        { key: 'factor', label: 'Reason shown', render: x => x.factor },
        { key: 'reviewed', label: 'Reviews', num: true },
        { key: 'disagree', label: 'Disagreed', num: true },
        { key: 'rate', label: 'Disagreement rate', num: true, sort: rate, render: x => cellBar(rate(x), 1, pct(rate(x), 0), rate(x) > 0.25 ? 'high' : '') },
      ], fb.by_factor || [], { page: 12, empty: 'No reviews yet.', caption: 'Disagreement by reason' }),
    ] : emptyState(S.live ? 'No reviews have been recorded in your scope yet.' : 'No reviews recorded in this browser yet. Record some on the Patient risk page to see this summary.'));
}

// ---- demo guide (snapshot mode, first visit)
function demoGuide() {
  if (S.live || storeGet('localStorage', 'guide-dismissed', false)) return null;
  const dismiss = () => { storeSet('localStorage', 'guide-dismissed', true); render(); };
  return el('div', { class: 'guide' },
    el('div', { class: 'guide-text' }, el('b', { text: 'Exploring the demo' }),
      el('span', { text: 'This page runs offline on synthetic patients. Switch roles from the menu at the top right to see what each person sees, or sign in to the live service to save work.' })),
    el('div', { class: 'btnrow' },
      el('button', { class: 'btn sm', type: 'button', onclick: () => { setRole('district'); closeMenu(); } }, 'Try the district view'),
      el('button', { class: 'btn sm', type: 'button', onclick: () => goTab('review') }, 'Open patient risk'),
      el('button', { class: 'btn sm', type: 'button', onclick: () => openShortcuts() }, 'Keyboard shortcuts'),
      el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Dismiss the demo guide', title: 'Dismiss', onclick: dismiss }, icon('close'))));
}

function openShortcuts() {
  const row = (k, d) => [el('dt', null, k.split(' ').map(x => el('kbd', { text: x }))), el('dd', { text: d })];
  openDrawer('Keyboard shortcuts', null,
    el('dl', { class: 'kv shortcuts' },
      row('/', 'Search on this page'),
      row('j ↓', 'Next patient (Patient risk)'),
      row('k ↑', 'Previous patient (Patient risk)'),
      row('g o', 'Go to Overview'),
      row('g p', 'Go to Patient risk'),
      row('g t', 'Go to My tasks'),
      row('g g', 'Go to Care gaps'),
      row('Esc', 'Close a panel or menu'),
      row('?', 'Show this list')));
}
