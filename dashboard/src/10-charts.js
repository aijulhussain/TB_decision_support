// ---------------------------------------------------------------- tooltip
const tipEl = $('#tip');
function placeTip(x, y) {
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let L = x + 14, T = y - h - 12;
  if (L + w > innerWidth - 8) L = x - w - 14;
  if (L < 8) L = 8;
  if (T < 8) T = y + 18;
  tipEl.style.left = L + 'px'; tipEl.style.top = T + 'px';
}
function hideTip() { tipEl.style.display = 'none'; }
/* fn() -> {title, rows:[{v, k, c}]}; c is a CSS colour token for the row key */
function hover(node, fn, focusable = true) {
  const fill = () => {
    const c = fn();
    tipEl.replaceChildren(
      c.title ? el('div', { class: 'tt', text: c.title }) : null,
      ...(c.rows || []).map(r => el('div', { class: 'tr' }, r.c ? el('i', { style: { background: r.c } }) : null, el('b', { text: r.v }), el('span', { text: r.k })))
    );
    tipEl.style.display = 'block';
  };
  node.addEventListener('pointerenter', e => { fill(); placeTip(e.clientX, e.clientY); });
  node.addEventListener('pointermove', e => placeTip(e.clientX, e.clientY));
  node.addEventListener('pointerleave', hideTip);
  if (focusable) {
    if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '0');
    node.addEventListener('focus', () => { fill(); const b = node.getBoundingClientRect(); placeTip(b.left + b.width / 2, b.top); });
    node.addEventListener('blur', hideTip);
  }
  const c = fn();
  node.setAttribute('aria-label', [c.title, ...(c.rows || []).map(r => `${r.k}: ${r.v}`)].filter(Boolean).join('. '));
}

// ---------------------------------------------------------------- charts
const ticks = (min, max, n = 5) => {
  const span = max - min || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || step0;
  const out = []; for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10)); return out;
};
function topRounded(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function legend(items) {
  return el('div', { class: 'lg' }, items.map(([cls, label, color]) => el('span', null, el('i', { class: cls, style: color ? { background: color } : null }), label)));
}
function dataTableDetails(summary, headers, rows) {
  return el('details', { class: 'data' }, el('summary', { text: summary }),
    el('div', { class: 'scroll' }, el('table', null,
      el('thead', null, el('tr', null, headers.map((h, i) => el('th', { class: i ? 'r' : null, text: h })))),
      el('tbody', null, rows.map(r => el('tr', null, r.map((c, i) => el('td', { class: i ? 'r' : null, text: c }))))))));
}

/* Vertical bar chart. data: [{label, y, cls, title, rows}] */
const chartW = () => (innerWidth < 640 ? 420 : 640);
function barChart(data, { h = 230, yfmt = num, every = 1, marker = null, ariaLabel = '' } = {}) {
  const W = chartW(), m = { t: 14, r: 10, b: 30, l: 46 };
  const iw = W - m.l - m.r, ih = h - m.t - m.b;
  const ymax = Math.max(...data.map(d => d.y)) * 1.08 || 1;
  const yt = ticks(0, ymax, 4), ytop = yt[yt.length - 1] < ymax ? ymax : yt[yt.length - 1];
  const Y = v => m.t + ih - (v / ytop) * ih;
  const bw = iw / data.length, gap = Math.max(2, bw * 0.18);
  if (W < 640 && every > 1) every = Math.ceil(every * 1.6);
  const s = sv('svg', { class: 'ch chart', viewBox: `0 0 ${W} ${h}`, role: 'img', 'aria-label': ariaLabel });
  const ax = sv('g', { class: 'ax' });
  yt.forEach(v => { ax.append(sv('line', { class: 'gl', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }), sv('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, yfmt(v))); });
  data.forEach((d, i) => { if (i % every === 0) ax.append(sv('text', { x: m.l + bw * i + bw / 2, y: h - 10, 'text-anchor': 'middle' }, d.label)); });
  s.append(ax);
  if (marker != null) {
    const x = m.l + bw * marker;
    s.append(sv('line', { class: 'ref', x1: x, x2: x, y1: m.t - 4, y2: m.t + ih }));
  }
  data.forEach((d, i) => {
    const x = m.l + bw * i + gap / 2, w = bw - gap, y = Y(d.y), bh = m.t + ih - y;
    const g = sv('g', { class: 'pt' },
      sv('rect', { class: 'hit', x: m.l + bw * i, y: m.t, width: bw, height: ih }),
      sv('path', { class: 'mk ' + (d.cls || 'c1'), d: topRounded(x, y, w, Math.max(bh, 0.5), 4) }));
    hover(g, () => ({ title: d.title || d.label, rows: d.rows || [{ v: yfmt(d.y), k: '' }] }));
    s.append(g);
  });
  s.append(sv('line', { class: 'base', x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih }));
  return s;
}

/* Line chart with points; hovering anywhere in a column snaps to that point. data: [{label, y, title, rows}] */
function lineChart(data, { h = 230, yfmt = num, yMin = null, ariaLabel = '', endLabel = true } = {}) {
  const W = chartW(), m = { t: 18, r: 54, b: 30, l: 46 };
  const iw = W - m.l - m.r, ih = h - m.t - m.b;
  const ys = data.map(d => d.y), lo = yMin == null ? Math.min(...ys) * 0.9 : yMin, hi = Math.max(...ys) * 1.06;
  const yt = ticks(lo, hi, 4);
  const y0 = Math.min(lo, yt[0]), y1 = Math.max(hi, yt[yt.length - 1]);
  const X = i => m.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const Y = v => m.t + ih - ((v - y0) / (y1 - y0)) * ih;
  const s = sv('svg', { class: 'ch chart', viewBox: `0 0 ${W} ${h}`, role: 'img', 'aria-label': ariaLabel });
  const ax = sv('g', { class: 'ax' });
  yt.forEach(v => ax.append(sv('line', { class: 'gl', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }), sv('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, yfmt(v))));
  data.forEach((d, i) => ax.append(sv('text', { x: X(i), y: h - 10, 'text-anchor': 'middle' }, d.label)));
  s.append(ax, sv('path', { class: 's1', d: data.map((d, i) => (i ? 'L' : 'M') + X(i) + ',' + Y(d.y)).join('') }));
  const xh = sv('line', { class: 'xh', x1: 0, x2: 0, y1: m.t, y2: m.t + ih, visibility: 'hidden' });
  s.append(xh);
  const colW = data.length > 1 ? iw / (data.length - 1) : iw;
  data.forEach((d, i) => {
    const g = sv('g', { class: 'pt' },
      sv('rect', { class: 'hit', x: X(i) - colW / 2, y: m.t, width: colW, height: ih }),
      sv('circle', { class: 'mk c1 ring', cx: X(i), cy: Y(d.y), r: 4.5 }));
    g.addEventListener('pointerenter', () => { xh.setAttribute('x1', X(i)); xh.setAttribute('x2', X(i)); xh.setAttribute('visibility', 'visible'); });
    g.addEventListener('pointerleave', () => xh.setAttribute('visibility', 'hidden'));
    hover(g, () => ({ title: d.title || d.label, rows: d.rows || [{ v: yfmt(d.y), k: '' }] }));
    s.append(g);
  });
  if (endLabel) { const L = data[data.length - 1]; s.append(sv('text', { class: 'lblb', x: X(data.length - 1) + 9, y: Y(L.y) + 4 }, yfmt(L.y))); }
  return s;
}

/* Rows of label | horizontal strip | value, drawn in HTML so long labels wrap and marks never distort.
   rows: [{label, v, lo, hi, cls, value, tip}] */
function stripRows(rows, { min, max, log = false, ref = null, mode = 'dot', head = null }) {
  const T = v => log ? Math.log(v) : v;
  const P = v => Math.max(0, Math.min(100, ((T(v) - T(min)) / (T(max) - T(min))) * 100));
  const g = el('div', { class: 'forest' });
  if (head) g.append(el('div', { class: 'frow hd', 'aria-hidden': 'true' }, el('span', { text: head[0] }), el('span', { text: head[1] }), el('span', { class: 'fv', text: head[2] })));
  rows.forEach(r => {
    const strip = el('div', { class: 'strip' }, el('span', { class: 'axisl' }));
    if (ref != null) strip.append(el('span', { class: 'refl', style: { left: P(ref) + '%' } }));
    if (mode === 'bar') {
      const a = P(ref != null ? ref : min), b = P(r.v);
      strip.append(el('span', { class: 'bx ' + (r.cls || '') + (b < a ? ' neg' : ''), style: { left: Math.min(a, b) + '%', width: Math.max(0.6, Math.abs(b - a)) + '%' } }));
      if (r.marker != null) strip.append(el('span', { class: 'tick', style: { left: P(r.marker) + '%' } }));
    } else {
      if (r.lo != null && r.hi != null) strip.append(el('span', { class: 'ci ' + (r.cls || ''), style: { left: P(r.lo) + '%', width: Math.max(0.5, P(r.hi) - P(r.lo)) + '%' } }));
      if (r.v2 != null) strip.append(el('span', { class: 'dt hol', style: { left: P(r.v2) + '%' } }));
      strip.append(el('span', { class: 'dt ' + (r.cls || ''), style: { left: P(r.v) + '%' } }));
    }
    const row = el('div', { class: 'frow' }, el('span', { class: 'fl', text: r.label }), strip, el('span', { class: 'fv' }, r.value));
    if (r.tip) hover(row, r.tip);
    g.append(row);
  });
  return g;
}

/* District scatter: REAL planning strain (x) vs SYNTHETIC outcome index (y). */
function districtScatter(districts, onPick) {
  const W = chartW(), H = W < 640 ? 360 : 400, m = { t: 30, r: 20, b: 48, l: 52 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const X = v => m.l + (v / 100) * iw, Y = v => m.t + ih - (v / 100) * ih;
  const s = sv('svg', { class: 'ch chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Districts by planning strain and outcome index' });
  const ax = sv('g', { class: 'ax' });
  [0, 25, 50, 75, 100].forEach(v => ax.append(
    sv('line', { class: 'gl', x1: X(v), x2: X(v), y1: m.t, y2: m.t + ih }), sv('line', { class: 'gl', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }),
    sv('text', { x: X(v), y: m.t + ih + 16, 'text-anchor': 'middle' }, v), sv('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, v)));
  ax.append(sv('text', { x: m.l + iw / 2, y: H - 8, 'text-anchor': 'middle' }, 'Planning strain, percentile (real RoP 2024-26)'));
  ax.append(sv('text', { x: 14, y: m.t + ih / 2, 'text-anchor': 'middle', transform: `rotate(-90 14 ${m.t + ih / 2})` }, 'Outcome index, percentile (synthetic)'));
  s.append(ax);
  s.append(sv('line', { class: 'ref', x1: X(50), x2: X(50), y1: m.t, y2: m.t + ih }), sv('line', { class: 'ref', x1: m.l, x2: W - m.r, y1: Y(50), y2: Y(50) }));
  s.append(sv('text', { class: 'quad', x: X(75), y: m.t - 10, 'text-anchor': 'middle' }, '↗ Strained and poorer outcomes'));
  s.append(sv('text', { class: 'quad', x: X(25), y: m.t - 10, 'text-anchor': 'middle' }, 'Poorer outcomes, less strain'));
  const placed = [];
  const pts = districts.filter(d => d.real.planning_strain_score != null && d.synthetic.outcome_index != null);
  const labelled = new Set(pts.filter(d => d.pilot).map(d => d.district));
  [...pts].sort((a, b) => (b.real.planning_strain_score + b.synthetic.outcome_index) - (a.real.planning_strain_score + a.synthetic.outcome_index)).slice(0, 3).forEach(d => labelled.add(d.district));
  [...pts].sort((a, b) => b.synthetic.outcome_index - a.synthetic.outcome_index).forEach(d => {
    const cx = X(d.real.planning_strain_score), cy = Y(d.synthetic.outcome_index);
    const g = sv('g', { class: 'pt', role: 'button' },
      sv('circle', { class: 'hit', cx, cy, r: 13 }),
      sv('circle', { class: 'mk ring ' + (d.pilot ? 'c2' : 'c1'), cx, cy, r: d.pilot ? 7 : 5.5 }));
    if (labelled.has(d.district)) {
      const right = cx < W - 130, w = d.district.length * (d.pilot ? 7.4 : 6.4);
      const x0 = right ? cx + 10 : cx - 10 - w;
      let ly = cy + 4;
      for (let k = 0; k < 6 && placed.some(b => x0 < b.x1 && x0 + w > b.x0 && Math.abs(ly - b.y) < 14); k++) ly += 14;
      placed.push({ x0, x1: x0 + w, y: ly });
      g.append(sv('text', { class: (d.pilot ? 'lblb' : 'lbl') + ' halo', x: right ? cx + 10 : cx - 10, y: ly, 'text-anchor': right ? 'start' : 'end' }, d.district));
    }
    hover(g, () => ({ title: d.district + (d.pilot ? ' (pilot)' : ''), rows: [
      { v: fx(d.real.planning_strain_score, 0), k: 'planning strain (real)', c: 'var(--c1)' },
      { v: fx(d.synthetic.outcome_index, 0), k: 'outcome index (synthetic)' },
      { v: pct(d.synthetic.early_death_rate), k: 'early deaths' }] }));
    g.addEventListener('click', () => onPick(d));
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(d); } });
    s.append(g);
  });
  return s;
}

/* Calibration: mean predicted vs observed risk by decile, with the line of perfect calibration. */
function calibrationChart(deciles) {
  const W = chartW(), H = 300, m = { t: 16, r: 18, b: 44, l: 52 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const top = Math.max(...deciles.map(d => Math.max(d.mean_predicted, d.observed))) * 1.1;
  const tk = ticks(0, top, 4), mx = Math.max(top, tk[tk.length - 1]);
  const X = v => m.l + (v / mx) * iw, Y = v => m.t + ih - (v / mx) * ih;
  const s = sv('svg', { class: 'ch chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Calibration by risk decile' });
  const ax = sv('g', { class: 'ax' });
  tk.forEach(v => ax.append(sv('line', { class: 'gl', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }), sv('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, pct(v, 0)),
    sv('text', { x: X(v), y: m.t + ih + 16, 'text-anchor': 'middle' }, pct(v, 0))));
  ax.append(sv('text', { x: m.l + iw / 2, y: H - 8, 'text-anchor': 'middle' }, 'Predicted risk (decile average)'));
  ax.append(sv('text', { x: 14, y: m.t + ih / 2, 'text-anchor': 'middle', transform: `rotate(-90 14 ${m.t + ih / 2})` }, 'Observed rate'));
  s.append(ax, sv('line', { class: 'ref', x1: X(0), y1: Y(0), x2: X(mx), y2: Y(mx) }));
  s.append(sv('path', { class: 's1', d: deciles.map((d, i) => (i ? 'L' : 'M') + X(d.mean_predicted) + ',' + Y(d.observed)).join('') }));
  deciles.forEach(d => {
    const g = sv('g', { class: 'pt' }, sv('circle', { class: 'hit', cx: X(d.mean_predicted), cy: Y(d.observed), r: 13 }),
      sv('circle', { class: 'mk c1 ring', cx: X(d.mean_predicted), cy: Y(d.observed), r: 5 }));
    hover(g, () => ({ title: 'Risk decile ' + d.decile, rows: [{ v: pct(d.mean_predicted), k: 'predicted', c: 'var(--c1)' }, { v: pct(d.observed), k: 'observed' }, { v: num(d.n), k: 'patients' }] }));
    s.append(g);
  });
  return s;
}

