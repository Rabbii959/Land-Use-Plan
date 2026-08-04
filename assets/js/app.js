/* ═══════════════════════════════════════════════════════════════
   Hafizabad District Land Use Plan — dashboard
   Punjab Spatial Planning Authority
   ═══════════════════════════════════════════════════════════════ */
(function () {
'use strict';

/* Bump on every change. Check the live file matches by opening the
   browser console, or by searching the deployed app.js for this line. */
const BUILD = 'hafizabad-dashboard 2026-08-04c';
console.info(BUILD);

/* ─────────────────────────────────────────── palette
   Base hues follow land use plan convention: residential in ochre,
   commercial red, industrial violet, agriculture green, public blue,
   water and open space teal, movement grey.                        */
const GROUP_HUE = {
  residential : '#e0b455',
  commercial  : '#cc4f3f',
  industrial  : '#8d6aa6',
  transport   : '#78877f',
  agriculture : '#9dc274',
  amenities   : '#4a7cb5',
  environment : '#3a9c9c',
  regulatory  : '#c2879c'
};

const GROUP_LABEL = {
  residential : 'Residential & settlement',
  commercial  : 'Commercial & mixed use',
  industrial  : 'Industrial & agro-industry',
  transport   : 'Movement & transport',
  agriculture : 'Agriculture & rural land',
  amenities   : 'Public facilities',
  environment : 'Water & open space',
  regulatory  : 'Regulatory designations'
};

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map(v =>
    Math.max(0, Math.min(255, Math.round(amt > 0
      ? v + (255 - v) * amt
      : v * (1 + amt))))
  );
  return '#' + ch.map(v => v.toString(16).padStart(2, '0')).join('');
}

/* ─────────────────────────────────────────── state */
const S = {
  stats     : null,
  colour    : {},          // land use class -> hex
  luGroup   : {},          // land use class -> layer group
  layers    : {},          // group -> L.geoJSON
  props     : [],          // every feature's properties, for live stats
  onGroups  : new Set(),
  cat       : 'all',
  luPick    : null,
  loaded    : 0,
  sortKey   : 'acres',
  sortDir   : -1,
  query     : ''
};

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const nf = (v, d = 0) => v.toLocaleString('en-US',
  { minimumFractionDigits: d, maximumFractionDigits: d });

/* ═══════════════════════════════════════════ boot */
fetch('data/stats.json')
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(init)
  .catch(err => {
    $('#mapCount').textContent =
      'Could not load data/stats.json — check the file is published alongside index.html.';
    console.error(err);
  });

function init(stats) {
  S.stats = stats;

  // class -> group, and a distinct shade per class within its group
  Object.entries(stats.groups).forEach(([g, classes]) => {
    const n = classes.length;
    classes.forEach((lu, i) => {
      S.luGroup[lu] = g;
      const t = n === 1 ? 0 : (i / (n - 1)) * 0.52 - 0.2;   // -0.20 … +0.32
      S.colour[lu] = shade(GROUP_HUE[g], t);
    });
  });
  stats.classes.forEach(c => {
    if (!S.colour[c.lu]) { S.colour[c.lu] = '#9aa79f'; S.luGroup[c.lu] = 'other'; }
  });

  // Each stage is isolated: if one throws, the others still run, so the
  // map never goes blank because of a problem in a chart or a table.
  const stage = (name, fn) => {
    try { fn(); } catch (e) { console.error('stage failed: ' + name, e); }
  };
  stage('kpis',    paintKpis);
  stage('layers',  paintLayerList);   // seeds S.onGroups — must precede the ribbon
  stage('ribbon',  paintRibbon);
  stage('map',     buildMap);
  stage('charts',  paintCharts);
  stage('table',   paintTable);
  stage('wiring',  wire);
}

/* ═══════════════════════════════════════════ key figures */
/* Writes text only if the element exists. A partial deploy (new HTML,
   stale JS, or vice versa) should degrade to a few blank figures, not
   throw and take the map, ribbon and layer list down with it. */
function setText(sel, v) {
  const el = $(sel);
  if (el) el.textContent = v;
  return !!el;
}

function paintKpis() {
  const t = S.stats.totals;
  const prop = S.stats.categories.find(c => c.name === 'Proposed');
  const farm = groupTotals().find(g => g.g === 'agriculture');
  setText('#kpiAcres',    nf(t.acres));
  setText('#kpiKm',       nf(t.sqkm, 1));
  setText('#kpiAvg',      nf(t.acres / t.features, 1));
  setText('#kpiProposed', prop ? nf(prop.pct, 1) : '0');
  setText('#kpiFarm',     farm ? nf(100 * farm.acres / t.acres, 1) : '0');
  // masthead figure chips
  setText('#mcParcels',   nf(t.features));
  setText('#mcClasses',   t.classes);
  // figures carried by the earlier layout, if this page still has them
  setText('#kpiParcels',  nf(t.features));
  setText('#kpiClasses',  t.classes);
}

/* ═══════════════════════════════════════════ share ribbon
   Two readings of the same district: the true proportions, then the
   same land with agriculture removed and the remainder rescaled —
   because at 87% of the district, farmland would otherwise flatten
   every other use into an unreadable sliver.                        */
function groupTotals() {
  const m = {};
  S.stats.classes.forEach(c => {
    const g = S.luGroup[c.lu] || 'other';
    (m[g] = m[g] || { g, acres: 0, count: 0 });
    m[g].acres += c.acres;
    m[g].count += c.count;
  });
  return Object.values(m).sort((a, b) => b.acres - a.acres);
}

function paintRibbon() {
  const totals = groupTotals();
  const all    = totals.reduce((s, d) => s + d.acres, 0);
  const rest   = totals.filter(d => d.g !== 'agriculture');
  const restT  = rest.reduce((s, d) => s + d.acres, 0);

  const host = $('#ribbon');
  host.innerHTML = '';
  host.appendChild(row('All land in the plan · ' + nf(all) + ' acres', totals, all));
  host.appendChild(row('Agriculture removed · ' + nf(restT) +
                       ' acres rescaled to full width', rest, restT));

  function row(caption, data, denom) {
    const wrap = document.createElement('div');
    wrap.className = 'ribbon__row';

    const cap = document.createElement('span');
    cap.className = 'ribbon__cap';
    cap.textContent = caption;
    wrap.appendChild(cap);

    const bar = document.createElement('div');
    bar.className = 'ribbon__bar';
    data.forEach(d => {
      const b = document.createElement('button');
      b.className = 'ribbon__seg';
      b.dataset.group = d.g;
      b.style.flexGrow = String(Math.max(d.acres / denom, 0.0006));
      b.style.background = GROUP_HUE[d.g] || '#9aa79f';
      b.title = `${GROUP_LABEL[d.g] || d.g} — ${nf(d.acres)} ac ` +
                `(${nf(100 * d.acres / denom, 1)}%)`;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => soloGroup(d.g));
      bar.appendChild(b);
    });
    wrap.appendChild(bar);
    return wrap;
  }
  readRibbon();
}

function readRibbon() {
  const read = $('#ribbonRead');
  const reset = $('#ribbonReset');
  const on = Array.from(S.onGroups);
  const parts = groupTotals().filter(d => S.onGroups.has(d.g));
  const acres = parts.reduce((s, d) => s + d.acres, 0);
  const cnt   = parts.reduce((s, d) => s + d.count, 0);

  read.querySelectorAll('.ribbon__item').forEach(n => n.remove());

  const frag = document.createDocumentFragment();
  const add = (html) => {
    const s = document.createElement('span');
    s.className = 'ribbon__item';
    s.innerHTML = html;
    frag.appendChild(s);
  };

  if (on.length === 1) {
    const g = on[0];
    add(`<i class="ribbon__sw" style="background:${GROUP_HUE[g]}"></i>` +
        `${GROUP_LABEL[g] || g}`);
  } else {
    add(`Showing <b>${on.length}</b> of 8 layers`);
  }
  add(`<b>${nf(acres)}</b> acres`);
  add(`<b>${nf(100 * acres / S.stats.totals.acres, 1)}%</b> of district`);
  add(`<b>${nf(cnt)}</b> parcels`);

  read.insertBefore(frag, reset);
  reset.hidden = (on.length === 8 && !S.luPick && S.cat === 'all');

  $$('.ribbon__bar').forEach(bar => {
    const solo = on.length === 1;
    bar.classList.toggle('is-picked', solo);
    bar.querySelectorAll('.ribbon__seg').forEach(seg =>
      seg.classList.toggle('is-on', S.onGroups.has(seg.dataset.group)));
  });
}

/* ═══════════════════════════════════════════ layer list */
function paintLayerList() {
  const host = $('#layers');
  host.innerHTML = '';
  groupTotals().forEach(d => {
    const lab = document.createElement('label');
    lab.className = 'lay';
    lab.innerHTML =
      `<input type="checkbox" checked data-group="${d.g}">` +
      `<i class="lay__sw" style="background:${GROUP_HUE[d.g] || '#9aa79f'}"></i>` +
      `<span class="lay__nm">${GROUP_LABEL[d.g] || d.g}</span>` +
      `<span class="lay__n">${nf(d.count)}</span>`;
    lab.querySelector('input').addEventListener('change', e => {
      toggleGroup(d.g, e.target.checked);
      lab.classList.toggle('is-off', !e.target.checked);
    });
    host.appendChild(lab);
    S.onGroups.add(d.g);
  });
}

function syncLayerBoxes() {
  $$('#layers input').forEach(i => {
    i.checked = S.onGroups.has(i.dataset.group);
    i.closest('.lay').classList.toggle('is-off', !i.checked);
  });
}

/* ═══════════════════════════════════════════ map */
let map, legend;
const BASES = {};

function buildMap() {
  const b = S.stats.bbox;
  const bounds = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);

  map = L.map('map', {
    preferCanvas : true,
    zoomControl  : true,
    maxZoom      : 18,
    minZoom      : 8
  }).fitBounds(bounds, { padding: [16, 16] });

  BASES.street = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 });

  BASES.satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics', maxZoom: 19 });

  BASES.plain = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; OpenStreetMap contributors &copy; CARTO', maxZoom: 19 });

  BASES.street.addTo(map);

  legend = L.control({ position: 'bottomright' });
  legend.onAdd = function () {
    const d = L.DomUtil.create('div', 'leg');
    L.DomEvent.disableClickPropagation(d);
    return d;
  };
  legend.addTo(map);
  paintLegend();

  S.stats.manifest.forEach(m => loadLayer(m.group, m.file));
}

function loadLayer(group, file) {
  fetch(file)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(gj => {
      gj.features.forEach(f => S.props.push(f.properties));

      // Leaflet's canvas renderer still hit-tests paths that are drawn
      // with no fill or stroke, so filtered-out parcels would stay
      // clickable under bindPopup. Gate the popup on the same
      // visibility test the styler uses.
      S.layers[group] = L.geoJSON(gj, {
        style: styleFor,
        onEachFeature: (f, lyr) => lyr.on('click', e => {
          if (!visible(f.properties)) return;
          L.popup({ maxWidth: 320 })
            .setLatLng(e.latlng)
            .setContent(popup(f.properties))
            .openOn(map);
        })
      });
      if (S.onGroups.has(group)) S.layers[group].addTo(map);

      S.loaded++;
      countUp();
      if (S.loaded === S.stats.manifest.length) refreshStats();
    })
    .catch(err => {
      console.error('layer ' + group, err);
      S.loaded++;
      countUp();
    });
}

function visible(p) {
  if (!S.onGroups.has(S.luGroup[p.lu])) return false;
  if (S.cat !== 'all' && p.ct !== S.cat) return false;
  if (S.luPick && p.lu !== S.luPick)     return false;
  return true;
}

function styleFor(f) {
  const p = f.properties;
  if (!visible(p)) return { stroke: false, fill: false, interactive: false };
  const c = S.colour[p.lu] || '#9aa79f';
  return {
    fill        : true,
    fillColor   : c,
    fillOpacity : S.luPick ? 0.88 : 0.72,
    stroke      : true,
    color       : shade(c, -0.42),
    weight      : S.luPick ? 0.9 : 0.45,
    opacity     : 0.9,
    interactive : true
  };
}

function popup(p) {
  const c = S.colour[p.lu] || '#9aa79f';
  const cls = S.stats.classes.find(x => x.lu === p.lu);
  return (
    `<div class="pop__t"><i class="ribbon__sw" style="background:${c}"></i>${p.lu}</div>` +
    (p.nm ? `<div class="pop__r"><span>Name</span><span>${p.nm}</span></div>` : '') +
    `<div class="pop__r"><span>Category</span><span>${p.ct}</span></div>` +
    `<div class="pop__r"><span>Parcel area</span><span>${nf(p.a, 2)} ac</span></div>` +
    `<div class="pop__r"><span>Parcel area</span><span>${nf(p.a * 0.00404686, 4)} km²</span></div>` +
    (cls ? `<div class="pop__r"><span>Class total</span><span>${nf(cls.acres)} ac · ${nf(cls.count)} parcels</span></div>` : '') +
    `<div class="pop__r"><span>Layer</span><span>${GROUP_LABEL[S.luGroup[p.lu]] || '—'}</span></div>`
  );
}

function countUp() {
  const done = S.loaded === S.stats.manifest.length;
  $('#mapCount').textContent = done
    ? `${nf(S.props.length)} parcels loaded · 60 classes · WGS 84`
    : `Loading parcels… ${S.loaded}/${S.stats.manifest.length} layers`;
}

function paintLegend() {
  const el = document.querySelector('.leg');
  if (!el) return;
  const rows = groupTotals()
    .filter(d => S.onGroups.has(d.g))
    .map(d => `<div class="leg__r"><i class="leg__sw" style="background:${GROUP_HUE[d.g]}"></i>` +
              `${GROUP_LABEL[d.g] || d.g}</div>`).join('');
  el.innerHTML = '<h4>Layers shown</h4>' +
    (rows || '<div class="leg__r">No layers selected</div>');
}

/* ═══════════════════════════════════════════ filtering */
function toggleGroup(g, on) {
  on ? S.onGroups.add(g) : S.onGroups.delete(g);
  const lyr = S.layers[g];
  if (lyr) on ? lyr.addTo(map) : map.removeLayer(lyr);
  afterFilter();
}

function soloGroup(g) {
  const only = S.onGroups.size === 1 && S.onGroups.has(g);
  S.onGroups = new Set(only ? Object.keys(S.stats.groups) : [g]);
  Object.entries(S.layers).forEach(([k, lyr]) => {
    if (!map) return;
    S.onGroups.has(k) ? lyr.addTo(map) : map.removeLayer(lyr);
  });
  syncLayerBoxes();
  afterFilter();
}

function pickClass(lu) {
  S.luPick = (S.luPick === lu) ? null : lu;
  if (S.luPick) {
    const g = S.luGroup[S.luPick];
    if (!S.onGroups.has(g)) { S.onGroups.add(g); S.layers[g] && S.layers[g].addTo(map); }
    syncLayerBoxes();
  }
  afterFilter();
  markTable();
  if (S.luPick) zoomToClass(S.luPick);
}

function zoomToClass(lu) {
  const g = S.luGroup[lu];
  const lyr = S.layers[g];
  if (!lyr) return;
  const b = L.latLngBounds([]);
  lyr.eachLayer(l => {
    if (l.feature.properties.lu === lu) b.extend(l.getBounds());
  });
  if (b.isValid()) map.fitBounds(b, { padding: [28, 28], maxZoom: 15 });
}

let raf = null;
function afterFilter() {
  if (raf) cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    S.onGroups.forEach(g => { if (S.layers[g]) S.layers[g].setStyle(styleFor); });
    paintLegend();
    readRibbon();
    refreshStats();
  });
}

function refreshStats() {
  const sel = S.props.filter(visible);
  if (!sel.length) {
    ['#selCount', '#selArea', '#selShare', '#selMed'].forEach(s => $(s).textContent = '—');
    if (S.props.length) $('#selCount').textContent = '0';
    return;
  }
  const acres = sel.reduce((s, p) => s + p.a, 0);
  const sorted = sel.map(p => p.a).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  $('#selCount').textContent = nf(sel.length);
  $('#selArea').textContent  = nf(acres) + ' ac';
  $('#selShare').textContent = nf(100 * acres / S.stats.totals.acres, 2) + '%';
  $('#selMed').textContent   = med < 1 ? nf(med, 3) + ' ac' : nf(med, 2) + ' ac';
}

/* ═══════════════════════════════════════════ charts */
const CH = {};
const GRID = { color: '#edf7f2' };
const TICK = { color: '#6b8a78', font: { family: 'Tahoma, Geneva, sans-serif', size: 10 } };

function paintCharts() {
  Chart.defaults.font.family = 'Tahoma, Geneva, sans-serif';
  Chart.defaults.color = '#3d5c4a';

  /* — largest classes, log scale so farmland does not flatten the rest — */
  const top = S.stats.classes.slice(0, 15);
  CH.top = new Chart($('#chartTop'), {
    type: 'bar',
    data: {
      labels: top.map(c => c.lu),
      datasets: [{
        data: top.map(c => c.acres),
        backgroundColor: top.map(c => S.colour[c.lu]),
        borderColor: top.map(c => shade(S.colour[c.lu], -0.4)),
        borderWidth: 1
      }]
    },
    options: {
      indexAxis: 'y',
      maintainAspectRatio: false,
      onClick: (e, els) => els.length && pickClass(top[els[0].index].lu),
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => {
          const d = top[c.dataIndex];
          return ` ${nf(d.acres)} ac · ${nf(d.count)} parcels · ${nf(d.pct, 2)}%`;
        } } }
      },
      scales: {
        x: { type: 'logarithmic', grid: GRID,
             ticks: { ...TICK, callback: v => nf(v) },
             title: { text: 'Acres (logarithmic)', display: true,
                      color: '#6b8a78', font: { size: 11 } } },
        y: { grid: { display: false },
             ticks: { ...TICK, font: { ...TICK.font, size: 10.5 }, autoSkip: false } }
      }
    }
  });

  /* — existing against proposed — */
  const cats = S.stats.categories;
  CH.cat = new Chart($('#chartCat'), {
    type: 'doughnut',
    data: {
      labels: cats.map(c => c.name),
      datasets: [{
        data: cats.map(c => c.acres),
        backgroundColor: ['#2d7a52', '#b8952a', '#8d6aa6'],
        borderColor: '#fff', borderWidth: 2
      }]
    },
    options: {
      maintainAspectRatio: false,
      cutout: '58%',
      onClick: (e, els) => els.length && setCat(cats[els[0].index].name),
      plugins: {
        legend: { position: 'bottom',
                  labels: { boxWidth: 11, boxHeight: 11, padding: 14,
                            font: { size: 12 } } },
        tooltip: { callbacks: { label: c => {
          const d = cats[c.dataIndex];
          return ` ${nf(d.acres)} ac · ${nf(d.count)} parcels · ${nf(d.pct, 1)}%`;
        } } }
      }
    }
  });

  /* — fragmentation — */
  const pts = S.stats.classes.filter(c => c.count > 0 && c.acres > 0);
  const byGroup = {};
  pts.forEach(c => {
    const g = S.luGroup[c.lu] || 'other';
    (byGroup[g] = byGroup[g] || []).push({
      x: c.count, y: c.acres / c.count, r: Math.max(3, Math.sqrt(c.acres) / 9), lu: c.lu
    });
  });
  CH.frag = new Chart($('#chartFrag'), {
    type: 'bubble',
    data: {
      datasets: Object.entries(byGroup).map(([g, data]) => ({
        label: GROUP_LABEL[g] || g,
        data,
        backgroundColor: (GROUP_HUE[g] || '#9aa79f') + 'cc',
        borderColor: shade(GROUP_HUE[g] || '#9aa79f', -0.4),
        borderWidth: 1
      }))
    },
    options: {
      maintainAspectRatio: false,
      onClick: (e, els) => {
        if (!els.length) return;
        const el = els[0];
        pickClass(CH.frag.data.datasets[el.datasetIndex].data[el.index].lu);
      },
      plugins: {
        legend: { position: 'bottom',
                  labels: { boxWidth: 10, boxHeight: 10, padding: 12,
                            font: { size: 11.5 } } },
        tooltip: { callbacks: { label: c => {
          const d = c.raw;
          return ` ${d.lu} — ${nf(d.x)} parcels, ${nf(d.y, 2)} ac average`;
        } } }
      },
      scales: {
        x: { type: 'logarithmic', grid: GRID,
             ticks: { ...TICK, callback: v => nf(v) },
             title: { text: 'Parcels in class (logarithmic)', display: true,
                      color: '#6b8a78', font: { size: 11 } } },
        y: { type: 'logarithmic', grid: GRID,
             ticks: { ...TICK, callback: v => nf(v, v < 1 ? 2 : 0) },
             title: { text: 'Average parcel size, acres (logarithmic)', display: true,
                      color: '#6b8a78', font: { size: 11 } } }
      }
    }
  });
}

/* ═══════════════════════════════════════════ table */
function rowsForTable() {
  const q = S.query.trim().toLowerCase();
  const rows = S.stats.classes
    .map(c => ({ ...c, avg: c.count ? c.acres / c.count : 0 }))
    .filter(c => !q || c.lu.toLowerCase().includes(q) ||
                       (GROUP_LABEL[c.group] || '').toLowerCase().includes(q));
  const k = S.sortKey, dir = S.sortDir;
  rows.sort((a, b) => {
    const x = a[k], y = b[k];
    if (typeof x === 'string') return dir * x.localeCompare(y);
    return dir * (x - y);
  });
  return rows;
}

function paintTable() {
  const body = $('#tblBody');
  body.innerHTML = '';
  const frag = document.createDocumentFragment();
  rowsForTable().forEach(c => {
    const tr = document.createElement('tr');
    tr.dataset.lu = c.lu;
    if (c.lu === S.luPick) tr.className = 'is-on';
    tr.innerHTML =
      `<td class="is-txt"><i class="tbl__sw" style="background:${S.colour[c.lu]}"></i>${c.lu}</td>` +
      `<td class="is-txt">${GROUP_LABEL[c.group] || c.group}</td>` +
      `<td class="is-txt"><span class="tbl__tag${c.category === 'Proposed' ? ' is-prop' : ''}">${c.category}</span></td>` +
      `<td>${nf(c.count)}</td>` +
      `<td>${nf(c.acres, 1)}</td>` +
      `<td>${nf(c.sqkm, 3)}</td>` +
      `<td>${c.pct < 0.01 ? '&lt;0.01' : nf(c.pct, 2)}%</td>` +
      `<td>${c.avg < 1 ? nf(c.avg, 3) : nf(c.avg, 2)}</td>`;
    tr.addEventListener('click', () => pickClass(c.lu));
    frag.appendChild(tr);
  });
  body.appendChild(frag);
}

function markTable() {
  $$('#tblBody tr').forEach(tr =>
    tr.classList.toggle('is-on', tr.dataset.lu === S.luPick));
}

function csv() {
  const head = ['Land use class', 'Layer', 'Category', 'Parcels',
                'Area (acres)', 'Area (sq km)', 'Share of district (%)',
                'Average parcel (acres)'];
  const esc = v => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
  const lines = [head.join(',')].concat(
    rowsForTable().map(c => [
      esc(c.lu), esc(GROUP_LABEL[c.group] || c.group), c.category,
      c.count, c.acres.toFixed(2), c.sqkm.toFixed(4),
      c.pct.toFixed(4), c.avg.toFixed(4)
    ].join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'hafizabad-land-use-classification.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ═══════════════════════════════════════════ wiring */
function setCat(c) {
  S.cat = (S.cat === c) ? 'all' : c;
  $$('[data-cat]').forEach(b => b.classList.toggle('is-on', b.dataset.cat === S.cat));
  afterFilter();
}

function wire() {
  $$('[data-base]').forEach(b => b.addEventListener('click', () => {
    Object.values(BASES).forEach(l => map.removeLayer(l));
    BASES[b.dataset.base].addTo(map);
    $$('[data-base]').forEach(x => x.classList.toggle('is-on', x === b));
  }));

  $$('[data-cat]').forEach(b =>
    b.addEventListener('click', () => setCat(b.dataset.cat)));

  $('#btnAll').addEventListener('click', () => {
    S.onGroups = new Set(Object.keys(S.stats.groups));
    Object.entries(S.layers).forEach(([, l]) => l.addTo(map));
    syncLayerBoxes();
    afterFilter();
  });

  $('#btnReset').addEventListener('click', resetAll);
  $('#ribbonReset').addEventListener('click', resetAll);

  $('#tblSearch').addEventListener('input', e => {
    S.query = e.target.value;
    paintTable();
  });

  $('#btnCsv').addEventListener('click', csv);

  $$('#tbl thead th').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (S.sortKey === k) S.sortDir *= -1;
    else { S.sortKey = k; S.sortDir = th.classList.contains('is-txt') ? 1 : -1; }
    $$('#tbl thead th').forEach(x => x.classList.remove('is-sorted', 'is-asc'));
    th.classList.add('is-sorted');
    if (S.sortDir === 1) th.classList.add('is-asc');
    paintTable();
  }));
}

function resetAll() {
  S.onGroups = new Set(Object.keys(S.stats.groups));
  S.cat = 'all';
  S.luPick = null;
  S.query = '';
  $('#tblSearch').value = '';
  Object.entries(S.layers).forEach(([, l]) => l.addTo(map));
  $$('[data-cat]').forEach(b => b.classList.toggle('is-on', b.dataset.cat === 'all'));
  syncLayerBoxes();
  afterFilter();
  paintTable();
  const b = S.stats.bbox;
  map.fitBounds(L.latLngBounds([b[1], b[0]], [b[3], b[2]]), { padding: [16, 16] });
}

})();
