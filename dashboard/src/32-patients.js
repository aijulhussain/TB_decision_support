// ---------------------------------------------------------------- review lists
function actionOf(p) { const k = p.list + ':' + p.key; return S.live ? S.liveActions[k] : S.actions[k]; }
function setAction(p, rec) {
  const k = p.list + ':' + p.key;
  if (S.live) S.liveActions[k] = rec;
  else { S.actions[k] = rec; storeSet('localStorage', 'actions', S.actions); }
}
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
  S.revOrder = rows.map(p => p.key);       // for ↑/↓ and j/k navigation
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
  const cur = actionOf(p);
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
          el('div', { class: 'fbar-top' }, el('span', { text: r.factor }),
            el('b', { class: 'up', text: `×${fx(r.odds_ratio, 2)} odds` + (r.share != null ? ` · ${pct(r.share, 0)} of added risk` : '') })),
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
    setAction(p, rec);
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

