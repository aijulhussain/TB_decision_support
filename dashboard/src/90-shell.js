// ================================================================= shell
const VIEWS = { overview: viewOverview, tasks: viewTasks, districts: viewDistricts, facilities: viewFacilities, review: viewReview, gaps: viewGaps, duplicates: viewDuplicates, deaths: viewDeaths, evidence: viewEvidence };
const NAV = [
  { id: 'overview', icon: 'grid' },
  { id: 'tasks', icon: 'check', badge: c => [c.tasks, 'high'] },
  { id: 'review', icon: 'clock', badge: c => [c.highRisk, 'high'] },
  { id: 'facilities', icon: 'home', badge: c => [c.supervise, 'med'] },
  { id: 'districts', icon: 'map' },
  { id: 'gaps', icon: 'arrow', badge: c => [c.gaps, 'high'] },
  { id: 'duplicates', icon: 'copy', badge: c => [c.dups, ''] },
  { id: 'deaths', icon: 'pulse', badge: c => [c.flagged, ''] },
  { sep: true },
  { id: 'evidence', icon: 'info', sub: true },
];
const pill = (cls, text) => el('span', { class: 'pill hide-sm ' + cls }, el('i'), text);

function navCounts() {
  const sc = scoped();
  return {
    highRisk: new Set(sc.review.filter(p => p.tier === 'high').map(p => p.key)).size,
    supervise: sc.facilities.filter(f => f.priority === 'supervise_first').length,
    gaps: sumGaps(gapCounts()),
    dups: Math.max(0, pendingDups(sc) - (isLive() ? 0 : sc.dups.filter(p => S.decisions[p.id]).length)),
    flagged: sc.flagged.length,
    tasks: roleDef().tabs.includes('tasks') ? myTasks().total : 0,
  };
}
const roleLabel = () => isLive() ? (API_ROLE_LABEL[S.live.me.role] || S.live.me.role) : roleDef().label;
const userName = () => isLive() ? S.live.me.display_name : `Demo · ${roleDef().label}`;
function initials(s) {
  const words = s.replace(/\(.*?\)/g, '').replace(/^Demo · /, '').split(/[\s,]+/).filter(w => /^[A-Za-z]/.test(w));
  return words.slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'U';
}

function goTab(t) {
  if (!roleDef().tabs.includes(t)) return;
  S.tab = t;
  if (location.hash !== '#' + t) history.replaceState(null, '', '#' + t);
  closeNav(); render(); window.scrollTo({ top: 0 });
}

function renderSidebar() {
  const c = navCounts(), tabs = roleDef().tabs;
  const scopeLabel = S.role === 'district' ? 'Active district' : S.role === 'facility' ? 'Active facility' : 'Scope';
  const scopeValue = S.role === 'district' ? S.district : S.role === 'facility' ? facName(S.facility) : S.role === 'data' ? 'State-wide · data' : 'Assam · state-wide';
  $('#scope-slot').replaceChildren(el('button', { class: 'scope-box', type: 'button', title: isLive() ? 'Set by your account' : 'Change view', onclick: e => { e.stopPropagation(); openMenu(); } },
    el('small', { text: scopeLabel }), el('b', { text: scopeValue })));
  const items = [];
  NAV.forEach(n => {
    if (n.sep) { items.push(el('div', { class: 'nav-sep' })); return; }
    if (!tabs.includes(n.id)) return;
    const b = n.badge ? n.badge(c) : null;
    items.push(el('button', { class: 'nav-item' + (n.sub ? ' sub' : ''), type: 'button', 'data-tab': n.id, 'aria-current': S.tab === n.id ? 'page' : null, onclick: () => goTab(n.id) },
      icon(n.icon), el('span', { text: TABS[n.id] }), b && b[0] ? el('span', { class: 'nav-badge ' + b[1], text: b[0] > 999 ? '999+' : num(b[0]) }) : null));
  });
  $('#nav').replaceChildren(...items);
}

function renderHeader() {
  $('#crumb').textContent = `Assam NHM · TB Programme · ${roleLabel()}`;
  $('#page-title').textContent = S.title || TABS[S.tab];
  const m = S.data.meta;
  const dataPill = isLive()
    ? el('span', { class: 'pill live hide-sm', title: `Live data from ${S.live.api}` }, el('i'), `Live · ${fmtDate(m.as_of)}`)
    : el('span', { class: 'pill hide-sm', title: 'Pipeline snapshot embedded in this page; works offline' }, el('i'), `Snapshot · ${fmtDate(m.as_of)}`);
  const name = userName();
  const chip = el('button', { class: 'user-chip', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': String($('#umenu').classList.contains('open')), title: name,
    onclick: e => { e.stopPropagation(); toggleMenu(); } },
    el('span', { class: 'avatar', text: initials(name) }), el('span', { text: name }), icon('chev'));
  $('#head-right').replaceChildren(...(S.headPills || []), dataPill, chip);
}

function renderMenu() {
  const secs = [];
  secs.push(el('div', { class: 'um-sec um-who' }, el('b', { text: userName() }),
    el('span', { text: isLive() ? `${roleLabel()} · ${S.live.api}` : 'Offline snapshot · actions stay in this browser' })));
  if (!isLive()) {
    secs.push(el('div', { class: 'um-sec' }, el('div', { class: 'um-h', text: 'View as' }),
      el('div', { class: 'um-roles' }, ROLES.map(r => el('button', { type: 'button', 'aria-pressed': String(S.role === r.id), onclick: () => setRole(r.id) }, r.label))),
      S.role === 'district' ? districtPicker() : S.role === 'facility' ? facilityPicker() : null));
    secs.push(el('div', { class: 'um-sec' }, el('button', { class: 'btn primary', type: 'button', style: { width: '100%', justifyContent: 'center' }, onclick: () => { closeMenu(); loginDialog(); } }, icon('user'), 'Sign in for live data')));
  } else {
    secs.push(el('div', { class: 'um-sec um-actions' },
      el('button', { class: 'btn sm', type: 'button', onclick: () => { closeMenu(); activateLive().then(() => toast('Refreshed from the server.')).catch(e => toast('Refresh failed: ' + e.message)); } }, icon('refresh'), 'Refresh'),
      el('button', { class: 'btn sm', type: 'button', onclick: () => { closeMenu(); signOut('Signed out. Showing the snapshot.'); } }, icon('logout'), 'Sign out')));
  }
  const theme = storeGet('localStorage', 'theme', 'auto');
  secs.push(el('div', { class: 'um-sec' }, el('div', { class: 'um-h', text: 'Appearance' }),
    el('div', { class: 'row' }, seg('Theme', { auto: 'Auto', light: 'Light', dark: 'Dark' }, theme, v => { storeSet('localStorage', 'theme', v); applyTheme(); renderMenu(); }),
      el('span', { class: 'grow' }),
      el('button', { class: 'iconbtn', type: 'button', title: 'Print this page', 'aria-label': 'Print this page', onclick: () => { closeMenu(); window.print(); } }, icon('print')))));
  $('#umenu').replaceChildren(...secs);
}
function districtPicker() {
  return el('select', { 'aria-label': 'District', onchange: e => { S.district = e.target.value; resetView(); render(); renderMenu(); } },
    SNAP.districts.map(x => x.district).sort().map(dn => el('option', { value: dn, selected: dn === S.district }, dn + (isPilot(dn) ? ' (pilot)' : ''))));
}
function facilityPicker() {
  return el('select', { 'aria-label': 'Facility', onchange: e => { S.facility = e.target.value; S.district = SNAP.facilities.find(f => f.id === S.facility).district; resetView(); render(); renderMenu(); } },
    SNAP.meta.pilot.map(dn => el('optgroup', { label: dn }, pilotFacilities.filter(f => f.district === dn).map(f => el('option', { value: f.id, selected: f.id === S.facility }, f.name)))));
}
function resetView() { S.f = {}; S.limit = {}; S.sel = null; }
function setRole(id) {
  S.role = id; resetView();
  if (id === 'facility') {
    const fac = SNAP.facilities.find(f => f.id === S.facility);
    if (!fac || !fac.pilot) S.facility = pilotFacilities[0].id;
    S.district = SNAP.facilities.find(f => f.id === S.facility).district;
  }
  if (!roleDef().tabs.includes(S.tab)) S.tab = 'overview';
  render(); renderMenu();
}
function openMenu() { renderMenu(); $('#umenu').classList.add('open'); renderHeader(); const b = $('#umenu button'); if (b) b.focus(); }
function closeMenu() { if (!$('#umenu').classList.contains('open')) return; $('#umenu').classList.remove('open'); renderHeader(); }
function toggleMenu() { if ($('#umenu').classList.contains('open')) closeMenu(); else openMenu(); }
function openNav() { $('#side').classList.add('open'); $('#veil').classList.add('on'); $('#menu-btn').setAttribute('aria-expanded', 'true'); }
function closeNav() {
  if (!$('#side').classList.contains('open')) return;
  $('#side').classList.remove('open'); $('#menu-btn').setAttribute('aria-expanded', 'false');
  if (!$('#drawer').classList.contains('open')) $('#veil').classList.remove('on');
}
function applyTheme() {
  const t = storeGet('localStorage', 'theme', 'auto');
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}
function renderFoot() {
  const m = S.data.meta;
  $('#foot').replaceChildren(el('div', { class: 'row' },
    el('span', { text: `Version ${m.version} · data as of ${fmtDate(m.as_of)} · ${num(m.records || SNAP.meta.records)} records · ${m.source === 'synthetic' ? 'synthetic patient data' : 'programme extract'}` }),
    el('span', { class: 'grow' }),
    prov('real'), el('a', { href: m.rop_url || SNAP.meta.rop_url, target: '_blank', rel: 'noopener' }, 'NHM Assam NTEP District RoP 2024-26')),
    el('p', { style: { marginTop: '6px' }, text: (m.notice || SNAP.meta.notice) + ' ' + (isLive() ? `Live data from ${S.live.api}; views and actions are recorded in the audit log.` : 'Snapshot mode: data are embedded in this page and work offline.') }));
}
function render() {
  hideTip();
  S.title = TABS[S.tab]; S.headPills = [];
  let nodes;
  try { nodes = VIEWS[S.tab](); }
  catch (e) { console.error(e); nodes = [callout('stop', el('b', { text: 'This view could not be drawn. ' }), String(e.message || e))]; }
  $('#view').replaceChildren(...[].concat(nodes).flat(Infinity).filter(Boolean));
  renderHeader(); renderSidebar();
  document.title = `${S.title} · TB Decision Support, Assam`;
}
function renderAll() { render(); renderFoot(); if ($('#umenu').classList.contains('open')) renderMenu(); }

// ---------------------------------------------------------------- keyboard
let gPending = 0;
function typing(e) { const t = e.target; return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }
function shortcuts(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || typing(e) || $('#login').open) return;
  if (gPending && Date.now() - gPending < 1200) {
    const to = { o: 'overview', p: 'review', t: 'tasks', g: 'gaps', f: 'facilities', d: 'deaths', e: 'evidence' }[e.key];
    gPending = 0;
    if (to && roleDef().tabs.includes(to)) { e.preventDefault(); goTab(to); }
    return;
  }
  if (e.key === 'g') { gPending = Date.now(); return; }
  if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }
  if (e.key === '/') {
    const box = document.querySelector('#view input[type=search]');
    if (box) { e.preventDefault(); box.focus(); box.select(); }
    return;
  }
  if (S.tab === 'review' && ['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key) && !$('#drawer').classList.contains('open')) {
    const order = S.revOrder || [], i = order.indexOf(S.sel);
    const next = order[Math.max(0, Math.min(order.length - 1, i + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next || next === S.sel) return;
    e.preventDefault();
    if (order.indexOf(next) >= (S.limit.rev || 40)) S.limit.rev = order.indexOf(next) + 20;
    S.sel = next; render();
    const item = document.querySelector(`.pitem[data-key="${next}"]`);
    if (item) { item.focus({ preventScroll: true }); item.scrollIntoView({ block: 'nearest' }); }
  }
}

// ---------------------------------------------------------------- offline app (served pages only)
/* When the page is served by the API at /app/, register a service worker so it opens offline and can be installed.
   The worker caches only the dashboard page and its icon, never API responses (they contain patient data). */
function registerOfflineApp() {
  if (!/^https?:$/.test(location.protocol) || !location.pathname.startsWith('/app/') || !('serviceWorker' in navigator)) return;
  if (!document.querySelector('link[rel=manifest]')) document.head.append(el('link', { rel: 'manifest', href: 'manifest.webmanifest' }));
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(err => console.warn('Offline app not available:', err));
}

// ---------------------------------------------------------------- boot
function boot() {
  applyTheme();
  $('#veil').addEventListener('click', () => { closeDrawer(); closeNav(); });
  $('#menu-btn').addEventListener('click', openNav);
  document.addEventListener('click', e => { const m = $('#umenu'); if (m.classList.contains('open') && !e.composedPath().includes(m)) closeMenu(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if ($('#umenu').classList.contains('open')) closeMenu();
    else if ($('#drawer').classList.contains('open')) closeDrawer();
    else closeNav();
  });
  window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS[t] && t !== S.tab) goTab(t); });
  window.addEventListener('scroll', hideTip, { passive: true });
  document.addEventListener('keydown', shortcuts);
  registerOfflineApp();
  let narrow = innerWidth < 640;
  window.addEventListener('resize', debounce(() => { if ((innerWidth < 640) !== narrow) { narrow = !narrow; render(); } }, 200));
  const h = location.hash.slice(1);
  if (TABS[h] && roleDef().tabs.includes(h)) S.tab = h;
  renderAll();
  restoreSession();
}
boot();
