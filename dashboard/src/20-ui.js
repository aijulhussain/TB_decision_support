// ---------------------------------------------------------------- generic sortable table
function cmp(a, b) {
  if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'en', { numeric: true });
}
function dataTable(id, cols, rows, { onRow, empty = 'Nothing to show for this selection.', page = 25, caption } = {}) {
  const st = S.sort[id] || {};
  let data = rows;
  if (st.key) {
    const c = cols.find(x => x.key === st.key);
    if (c) { const get = c.sort || (r => r[c.key]); data = [...rows].sort((a, b) => { const va = get(a), vb = get(b); if (va == null || vb == null) return cmp(va, vb); return cmp(va, vb) * st.dir; }); }
  }
  const lim = S.limit[id] || page;
  const shown = data.slice(0, lim);
  const head = el('tr', null, cols.map(c => el('th', { class: c.num ? 'r' : null, scope: 'col', 'aria-sort': st.key === c.key ? (st.dir > 0 ? 'ascending' : 'descending') : null },
    c.nosort ? c.label : el('button', { type: 'button', 'data-sort': id + ':' + c.key, onclick: () => {
      S.sort[id] = { key: c.key, dir: st.key === c.key ? -st.dir : (c.num ? -1 : 1) };
      render(); const b = document.querySelector(`[data-sort="${id}:${c.key}"]`); if (b) b.focus();
    } }, c.label, el('span', { class: 'sort', 'aria-hidden': 'true', text: st.key === c.key ? (st.dir > 0 ? '▲' : '▼') : '' })))));
  const body = shown.length ? shown.map(r => el('tr', {
    class: onRow ? 'click' : null, tabindex: onRow ? '0' : null,
    onclick: onRow ? () => onRow(r) : null,
    onkeydown: onRow ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRow(r); } }) : null,
  }, cols.map(c => el('td', { class: c.num ? 'r' : null }, c.render ? c.render(r) : (r[c.key] == null ? '–' : String(r[c.key]))))))
    : [el('tr', null, el('td', { colspan: cols.length, class: 'empty', text: empty }))];
  const out = el('div', { class: 'dt' },
    el('p', { class: 'count', text: data.length ? `Showing ${num(shown.length)} of ${num(data.length)}` + (onRow ? ' · select a row for details' : '') : '' }),
    el('div', { class: 'scroll' }, el('table', null, caption ? el('caption', { class: 'sr-only', text: caption }) : null, el('thead', null, head), el('tbody', null, body))));
  if (data.length > lim) out.append(el('div', { class: 'more' }, el('button', { class: 'btn', type: 'button', onclick: () => { S.limit[id] = lim + page * 2; render(); } }, `Show ${num(Math.min(page * 2, data.length - lim))} more`)));
  return out;
}

// ---------------------------------------------------------------- drawer
let drawerReturn = null;
function openDrawer(title, badges, ...body) {
  const d = $('#drawer');
  drawerReturn = document.activeElement;
  d.replaceChildren();
  addKids(d, [
    el('div', { class: 'drawer-h' }, el('h2', { id: 'drawer-title', text: title }),
      el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close details', onclick: closeDrawer }, icon('close'))),
    badges ? el('div', { class: 'row', style: { marginBottom: '14px' } }, badges) : null, body]);
  d.setAttribute('aria-labelledby', 'drawer-title');
  d.classList.add('open'); $('#veil').classList.add('on'); d.focus();
}
function closeDrawer() {
  $('#drawer').classList.remove('open'); $('#veil').classList.remove('on');
  if (drawerReturn && document.body.contains(drawerReturn)) drawerReturn.focus();
}

function icon(name) {
  const P = {
    close: 'M6 6l12 12M18 6L6 18',
    sun: 'M12 4V2M12 22v-2M4 12H2m20 0h-2M5.6 5.6 4.2 4.2m15.6 15.6-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
    auto: 'M12 3a9 9 0 1 0 0 18V3z M12 3a9 9 0 0 1 0 18',
    print: 'M7 9V3h10v6M7 17H4v-6h16v6h-3M7 14h10v7H7z',
    download: 'M12 3v12m0 0-5-5m5 5 5-5M4 20h16',
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    home: 'M3 20V10l9-6 9 6v10M9 20v-6h6v6',
    map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
    arrow: 'M4 12h16M14 6l6 6-6 6',
    copy: 'M3 6h11v13H3zM10 3h11v13',
    pulse: 'M3 12h4l3-7 4 14 3-7h4',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.01',
    chev: 'M6 9l6 6 6-6',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    check: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9',
  };
  return sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, sv('path', { d: P[name] }));
}

// ---------------------------------------------------------------- exports
function csvDownload(name, headers, rows) {
  const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const text = ['# ' + S.data.meta.notice, '# Source: ' + (isLive() ? 'live API' : 'pipeline snapshot ' + S.data.meta.version) + ', as of ' + S.data.meta.as_of,
    headers.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\r\n');
  saveBlob(new Blob([text], { type: 'text/csv' }), name + '.csv');
}
function saveBlob(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function canExport() { return isLive() ? ['state_admin', 'district_officer', 'facility_user'].includes(S.live.me.role) : S.role !== 'data'; }
function exportBtn(report, localFn) {
  if (!canExport()) return null;
  if (isLive() && report === 'facility_priority' && S.live.me.role === 'facility_user') return null;
  return el('button', { class: 'btn', type: 'button', onclick: async () => {
    if (!isLive()) { localFn(); toast('CSV downloaded from the snapshot.'); return; }
    try {
      const r = await api('/reports/export?report=' + report, { raw: true });
      saveBlob(await r.blob(), report + '.csv'); toast('Export downloaded. It is recorded in the audit log.');
    } catch (e) { toast('Export failed: ' + e.message); }
  } }, icon('download'), ' Export CSV');
}

