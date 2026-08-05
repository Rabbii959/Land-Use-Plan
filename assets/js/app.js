/* ═══════════════════════════════════════════════════════════════
   Hafizabad District Land Use Plan — dashboard
   Punjab Spatial Planning Authority
   ═══════════════════════════════════════════════════════════════ */
(function () {
'use strict';

/* Bump on every change. Check the live file matches by opening the
   browser console, or by searching the deployed app.js for this line. */
const BUILD = 'hafizabad-dashboard 2026-08-05a';
console.info(BUILD);

/* ─────────────────────────────────────────── palette & labels
   Populated from the source data's own LU_Class field during init(),
   so the legend shows the district's real terminology (e.g. "Transportation
   Network", "Other Uses") instead of an invented scheme. A keyword hint
   picks a familiar hue for common categories; anything unrecognised
   cycles through a neutral fallback palette instead. */
let GROUP_HUE = {};
let GROUP_LABEL = {};

const HUE_HINTS = [
  [/resident/i,                    '#e0b455'],
  [/commerc/i,                     '#cc4f3f'],
  [/industr/i,                     '#8d6aa6'],
  [/transport/i,                   '#78877f'],
  [/agricultur/i,                  '#9dc274'],
  [/notif|regulat|\bstate\b/i,     '#c2879c'],
  [/water|environ|open.?space|park/i, '#3a9c9c'],
  [/other|misc/i,                  '#4a7cb5'],
];
const HUE_FALLBACK = ['#4a7cb5', '#c2879c', '#3a9c9c', '#9dc274', '#8d6aa6',
                       '#cc4f3f', '#e0b455', '#78877f', '#b56a9e', '#5c8f6e'];

function titleCase(slug) {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function assignGroupStyles(groups, labels) {
  let fi = 0;
  Object.keys(groups).forEach(g => {
    const label = (labels && labels[g]) || titleCase(g);
    GROUP_LABEL[g] = label;
    const hit = HUE_HINTS.find(([re]) => re.test(label));
    GROUP_HUE[g] = hit ? hit[1] : HUE_FALLBACK[fi++ % HUE_FALLBACK.length];
  });
  // The source data's own "Commercial" LU_Class also holds schools,
  // hospitals, and institutional buildings — say so in the label.
  if (GROUP_LABEL.commercial) {
    GROUP_LABEL.commercial = 'Commercial & Institutional';
  }
}

/* Fixed legend order, requested explicitly — distinct from the ribbon,
   which stays sorted by share (its own caption says so). A future
   district whose groups don't match this exact set falls back to
   appending anything unrecognised, sorted by area, after this list. */
const GROUP_ORDER = ['residential', 'commercial', 'industrial', 'agriculture',
                      'notified_area', 'transportation_network', 'other_uses'];

function orderedGroupTotals() {
  const all = groupTotals();
  const byKey = {};
  all.forEach(d => { byKey[d.g] = d; });
  const ordered = GROUP_ORDER.filter(g => byKey[g]).map(g => byKey[g]);
  const extra = all.filter(d => !GROUP_ORDER.includes(d.g));
  return ordered.concat(extra);
}

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
  offClasses: new Set(),   // individual land use classes toggled off in the legend
  district  : 'all',
  localGov  : 'all',
  lgAreas   : null,        // local government boundaries, for the district with parcel data
  pendingLgAssign: false,  // true if boundaries arrived before all parcel layers did
  districtIndex   : [],    // [{name, rings}] every district in the province
  lgIndex         : [],    // [{name, district, rings}] every LG in the province
  lgByDistrict    : {},    // district name -> [lg names], for cascading the select
  districtBounds  : {},    // district name -> Leaflet LatLngBounds
  lgBounds        : {},    // lg name -> Leaflet LatLngBounds
  highlightDistrict: null, // which district outline is currently drawn
  highlightLG      : null, // which LG outline is currently drawn, if any
  showDistrict : true,   // District boundary layer visibility (checkbox)
  showLG       : false,  // Local Govt boundary layer visibility (checkbox)
  showLanduse  : false,  // land use parcels visibility (checkbox) — master switch
  showCategory : false,  // dashed outline on Proposed parcels (checkbox)
  cat       : 'all',
  luPick    : null,
  index     : [],          // search index
  sugg      : [],
  suggAt    : -1,
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
  assignGroupStyles(stats.groups, stats.groupLabels);

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
  stage('filters', buildFilters);    // populates district/land-use selects + search index
  stage('layers',  paintLayerList);   // must precede the ribbon (paints group boxes it reads)
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

/* The old KPI strip is gone — its figures now live in the map's own
   selection summary (#selWhat/#selArea/#selShare), which reflects
   whatever the user currently has selected rather than fixed totals.
   See refreshStats() and currentSelectionLabel() below. */

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

  const visibleClasses = S.stats.classes.filter(c => !S.offClasses.has(c.lu));
  const acres = visibleClasses.reduce((s, c) => s + c.acres, 0);
  const cnt   = visibleClasses.reduce((s, c) => s + c.count, 0);
  const anyOnGroups = groupTotals().filter(d =>
    (S.stats.groups[d.g] || []).some(lu => !S.offClasses.has(lu)));

  read.querySelectorAll('.ribbon__item').forEach(n => n.remove());

  const frag = document.createDocumentFragment();
  const add = (html) => {
    const s = document.createElement('span');
    s.className = 'ribbon__item';
    s.innerHTML = html;
    frag.appendChild(s);
  };

  if (anyOnGroups.length === 1) {
    const g = anyOnGroups[0].g;
    add(`<i class="ribbon__sw" style="background:${GROUP_HUE[g]}"></i>` +
        `${GROUP_LABEL[g] || g}`);
  } else {
    add(`Showing <b>${anyOnGroups.length}</b> of ${Object.keys(S.stats.groups).length} layers`);
  }
  add(`<b>${nf(acres)}</b> acres`);
  add(`<b>${nf(100 * acres / S.stats.totals.acres, 1)}%</b> of district`);
  add(`<b>${nf(cnt)}</b> parcels`);

  read.insertBefore(frag, reset);
  reset.hidden = (S.offClasses.size === 0 && !S.luPick && S.cat === 'all' &&
                  S.district === 'all' && S.localGov === 'all');

  $$('.ribbon__bar').forEach(bar => {
    const solo = anyOnGroups.length === 1;
    bar.classList.toggle('is-picked', solo);
    bar.querySelectorAll('.ribbon__seg').forEach(seg =>
      seg.classList.toggle('is-on', anyOnGroups.some(d => d.g === seg.dataset.group)));
  });
}

/* ═══════════════════════════════════════════ layer list */
/* ═══════════════════════════════════════════ legend tree
   Two levels: a Land Use Class (e.g. "Residential") expands to show
   its individual land uses, each with its own checkbox. The group
   checkbox is tri-state — checked, unchecked, or indeterminate when
   some but not all of its classes are on. */
const GROUP_BOX = {};   // group key -> its checkbox element
const GROUP_ROW = {};   // group key -> its row label element
const CLASS_BOX = {};   // land use class -> its checkbox element
const CLASS_ROW = {};   // land use class -> its row label element

const CHEV_SVG =
  '<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">' +
  '<path d="M1 .5 L6.5 4 L1 7.5" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function paintLayerList() {
  const host = $('#layers');
  host.innerHTML = '';

  orderedGroupTotals().forEach(d => {
    const g = d.g;
    const classes = (S.stats.groups[g] || [])
      .map(lu => S.stats.classes.find(c => c.lu === lu))
      .filter(Boolean)
      .sort((a, b) => b.acres - a.acres);

    const wrap = document.createElement('div');
    wrap.className = 'lgroup';
    wrap.dataset.group = g;
    wrap.setAttribute('role', 'group');

    const head = document.createElement('div');
    head.className = 'lgroup__head';

    const chev = document.createElement('button');
    chev.type = 'button';
    chev.className = 'lgroup__chev';
    chev.setAttribute('aria-expanded', 'true');
    chev.setAttribute('aria-label', 'Collapse ' + (GROUP_LABEL[g] || g));
    chev.innerHTML = CHEV_SVG;

    const lab = document.createElement('label');
    lab.className = 'lgroup__row';
    lab.dataset.group = g;
    lab.innerHTML =
      '<input type="checkbox" class="lgroup__box" checked>' +
      `<i class="lgroup__sw" style="background:${GROUP_HUE[g] || '#9aa79f'}"></i>` +
      `<span class="lgroup__nm">${esc(GROUP_LABEL[g] || g)}</span>` +
      `<span class="lgroup__n">${nf(d.count)}</span>`;

    head.append(chev, lab);
    wrap.appendChild(head);

    const kids = document.createElement('div');
    kids.className = 'lchildren';
    kids.setAttribute('role', 'group');

    classes.forEach(c => {
      const row = document.createElement('label');
      row.className = 'lchild__row';
      row.dataset.lu = c.lu;
      row.innerHTML =
        '<input type="checkbox" class="lchild__box" checked>' +
        `<i class="lchild__sw" style="background:${S.colour[c.lu]}"></i>` +
        `<span class="lchild__nm">${esc(c.lu)}</span>` +
        `<span class="lchild__n">${nf(c.count)}</span>`;
      const box = row.querySelector('input');
      box.addEventListener('change', () => {
        box.checked ? S.offClasses.delete(c.lu) : S.offClasses.add(c.lu);
        row.classList.toggle('is-off', !box.checked);
        syncGroupBox(g);
        afterFilter();
      });
      CLASS_BOX[c.lu] = box;
      CLASS_ROW[c.lu] = row;
      kids.appendChild(row);
    });

    wrap.appendChild(kids);
    host.appendChild(wrap);

    const groupBox = lab.querySelector('input');
    GROUP_BOX[g] = groupBox;
    GROUP_ROW[g] = lab;
    groupBox.addEventListener('change', () => {
      const on = groupBox.checked;
      classes.forEach(c => {
        on ? S.offClasses.delete(c.lu) : S.offClasses.add(c.lu);
        if (CLASS_BOX[c.lu]) CLASS_BOX[c.lu].checked = on;
        if (CLASS_ROW[c.lu]) CLASS_ROW[c.lu].classList.toggle('is-off', !on);
      });
      groupBox.indeterminate = false;
      lab.classList.toggle('is-off', !on);
      afterFilter();
    });

    chev.addEventListener('click', () => {
      const open = chev.getAttribute('aria-expanded') === 'true';
      chev.setAttribute('aria-expanded', open ? 'false' : 'true');
      chev.setAttribute('aria-label', (open ? 'Expand ' : 'Collapse ') + (GROUP_LABEL[g] || g));
      kids.hidden = open;
    });
  });
}

function syncGroupBox(g) {
  const box = GROUP_BOX[g];
  if (!box) return;
  const classes = S.stats.groups[g] || [];
  const onCount = classes.filter(lu => !S.offClasses.has(lu)).length;
  box.checked = onCount > 0;
  box.indeterminate = onCount > 0 && onCount < classes.length;
  if (GROUP_ROW[g]) GROUP_ROW[g].classList.toggle('is-off', onCount === 0);
}

function syncClassBox(lu) {
  const box = CLASS_BOX[lu];
  if (box) box.checked = !S.offClasses.has(lu);
  if (CLASS_ROW[lu]) CLASS_ROW[lu].classList.toggle('is-off', S.offClasses.has(lu));
}

function syncAllLayerBoxes() {
  Object.keys(S.stats.groups).forEach(g => {
    (S.stats.groups[g] || []).forEach(syncClassBox);
    syncGroupBox(g);
  });
}

/* ═══════════════════════════════════════════ map */
let map, legend;
const BASES = {};

function buildMap() {
  // Approximate Punjab extent — refined precisely the moment
  // districts.geojson loads and we have the real combined bounds.
  const PUNJAB_APPROX = L.latLngBounds([27.7, 69.3], [34.1, 75.4]);

  map = L.map('map', {
    preferCanvas : true,
    zoomControl  : true,
    maxZoom      : 18,
    minZoom      : 6
  }).fitBounds(PUNJAB_APPROX, { padding: [16, 16] });

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

  loadAdminBoundaries();
  S.stats.manifest.forEach(m => loadLayer(m.group, m.file));
}

/* ── administrative boundaries ──────────────────────────────────
   Province-wide District and Local Govt layers. Populates both
   filters with every district/LG in Punjab, draws whichever one is
   currently selected as an outline, and — for the district that
   actually has parcel data — runs the point-in-polygon assignment
   that powers the Local Govt filter. Absent either file, the page
   falls back to the single-district behaviour it already had. */
function loadAdminBoundaries() {
  Promise.all([
    fetch('data/districts.geojson').then(r => r.ok ? r.json() : Promise.reject('absent')),
    fetch('data/local_govts.geojson').then(r => r.ok ? r.json() : Promise.reject('absent'))
  ]).then(([districtsGJ, lgGJ]) => {
    // Once fetch+parse succeed, everything below is isolated in its own
    // try/catch — a problem in z-ordering or a precise refit shouldn't
    // fall through to the outer .catch() and claim the data is missing
    // when it plainly isn't.
    try {
      S.districtIndex = (districtsGJ.features || []).map(f => ({
        name: (f.properties && f.properties.name) || 'Unnamed',
        rings: ringsOf(f.geometry)
      })).filter(d => d.rings.length);

      S.lgIndex = (lgGJ.features || []).map(f => ({
        name: (f.properties && f.properties.name) || 'Unnamed',
        district: (f.properties && f.properties.district) || '',
        rings: ringsOf(f.geometry)
      })).filter(d => d.rings.length);

      S.lgByDistrict = {};
      S.lgIndex.forEach(a => {
        (S.lgByDistrict[a.district] = S.lgByDistrict[a.district] || []).push(a.name);
      });
      Object.values(S.lgByDistrict).forEach(list => list.sort());

      // Outline layers: every district and every LG in Punjab, drawn all
      // the time — districtStyle()/lgStyle() give the selected one a
      // bolder treatment, everything else stays at its base style.
      S.distLayer = L.geoJSON(districtsGJ, {
        interactive: false,
        style: f => districtStyle((f.properties && f.properties.name))
      }).addTo(map);
      S.lgLayer = L.geoJSON(lgGJ, {
        interactive: false,
        style: f => lgStyle((f.properties && f.properties.name))
      }).addTo(map);

      S.districtBounds = {};
      S.distLayer.eachLayer(l => { S.districtBounds[l.feature.properties.name] = l.getBounds(); });
      S.lgBounds = {};
      S.lgLayer.eachLayer(l => { S.lgBounds[l.feature.properties.name] = l.getBounds(); });

      // Explicit stacking regardless of which fetch resolved first:
      // districts furthest back, LG outlines above them, parcels (added
      // elsewhere, as each loadLayer() call resolves) stay on top. Purely
      // cosmetic — wrapped separately so an old Leaflet build without
      // these methods can't break anything load-bearing above or below.
      try {
        S.distLayer.bringToBack();
        S.lgLayer.bringToFront();
      } catch (e) { console.error('boundary z-ordering failed', e); }

      const allDistricts = [...new Set(S.districtIndex.map(d => d.name))].sort();
      fill('#fDistrict', [['all', 'All districts']].concat(
        allDistricts.map(d => [d, d === S.stats.district ? d : `${d} — boundary only`])));

      populateLocalGovOptions();
      updateHighlight();
      syncControls();

      // The initial view was an approximate Punjab bbox; now that we have
      // the real geometry, refit precisely — unless the user has already
      // picked a specific district or LG in the brief gap while this loaded.
      if (S.district === 'all' && S.localGov === 'all') {
        try { map.fitBounds(S.distLayer.getBounds(), { padding: [16, 16] }); }
        catch (e) { console.error('initial province refit failed', e); }
      }

      // Parcel assignment only makes sense for the district that actually
      // has land-use data loaded.
      S.lgAreas = S.lgIndex.filter(a => a.district === S.stats.district);
      if (S.lgAreas.length) {
        if (S.loaded === S.stats.manifest.length) assignLocalGov();
        else S.pendingLgAssign = true;
      } else {
        note(`No Local Govt boundaries found for ${esc(S.stats.district)} in ` +
             '<code>data/local_govts.geojson</code>.');
      }
    } catch (e) {
      console.error('processing province boundaries failed', e);
    }
  }).catch(() => note(
    'Province-wide boundaries are not present. Add <code>data/districts.geojson</code> ' +
    'and <code>data/local_govts.geojson</code> (see README) and both filters switch on ' +
    'automatically.'));
}


// Every district: black outline, light green fill, always visible.
// The selected one (if any) gets a heavier stroke to stand out once
// zoomed in — same colours, just bolder, rather than a totally
// different treatment that would compete visually with the parcels.
function districtStyle(name) {
  if (!S.showDistrict) return { fill: false, stroke: false };
  const selected = name === S.highlightDistrict;
  return {
    fill: true,
    fillColor: '#9ed6ab',
    fillOpacity: selected ? 0.38 : 0.22,
    color: '#000',
    weight: selected ? 4 : 2,
    opacity: 1
  };
}

// Every Local Govt unit: light red outline, always visible when the
// master checkbox is on. The selected one gets a heavier, fully-opaque
// outline plus a light fill.
function lgStyle(name) {
  if (!S.showLG) return { fill: false, stroke: false };
  const selected = name === S.highlightLG;
  return {
    fill: selected,
    fillColor: '#e0736a',
    fillOpacity: selected ? 0.22 : 0,
    color: '#e0736a',
    weight: selected ? 3.5 : 1.4,
    opacity: selected ? 1 : 0.7
  };
}

// Which outline is bolded — null when 'all' is selected, since every
// district/LG is already shown equally at that point; picking one
// specific district or LG is what earns it the heavier treatment.
function updateHighlight() {
  S.highlightDistrict = S.district !== 'all' ? S.district : null;
  S.highlightLG = S.localGov !== 'all' ? S.localGov : null;
  if (S.distLayer) S.distLayer.setStyle(f => districtStyle(f.properties.name));
  if (S.lgLayer) S.lgLayer.setStyle(f => lgStyle(f.properties.name));
}

// Local Govt options cascade to whichever district is in effect — 'all'
// falls back to showing the district that actually has parcel data,
// rather than all 237 units across the province at once.
function populateLocalGovOptions() {
  const el = $('#fLocal');
  if (!el) return;
  const effective = S.district === 'all' ? S.stats.district : S.district;
  const names = (S.lgByDistrict[effective] || []).slice();
  fill('#fLocal', [['all', 'All local governments']].concat(names.map(n => [n, n])));
  el.disabled = false;
  el.removeAttribute('title');
  const pill = el.closest('.fld');
  if (pill) pill.classList.remove('fld--disabled');
}

function zoomToDistrict(name) {
  if (name === 'all') {
    if (S.distLayer) { map.fitBounds(S.distLayer.getBounds(), { padding: [16, 16] }); return; }
    const bb = S.stats.bbox;
    map.fitBounds(L.latLngBounds([bb[1], bb[0]], [bb[3], bb[2]]), { padding: [16, 16] });
    return;
  }
  const b = S.districtBounds && S.districtBounds[name];
  if (b) map.fitBounds(b, { padding: [24, 24] });
}

function zoomToLocalGov(name) {
  if (name === 'all') return zoomToDistrict(S.district);
  const b = S.lgBounds && S.lgBounds[name];
  if (b) map.fitBounds(b, { padding: [24, 24] });
}

// A district other than the one with real parcel data is a legitimate
// thing to explore (its boundary is real), but the map has no parcels
// to show there — say so rather than leaving an unexplained empty map.
function updateDataAvailabilityNote() {
  const effective = S.district === 'all' ? S.stats.district : S.district;
  if (effective !== S.stats.district) {
    note(`No land use parcels are available for <strong>${esc(effective)}</strong> yet — ` +
         `showing its boundary only. Parcel data currently covers ${esc(S.stats.district)}.`);
  } else {
    note('');
  }
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
      S.layers[group].addTo(map);

      S.loaded++;
      countUp();
      if (S.loaded === S.stats.manifest.length) {
        // Isolated so a problem here can't fall through into the
        // .catch() below and double-count this layer as failed.
        try {
          refreshStats();
          if (S.pendingLgAssign) { S.pendingLgAssign = false; assignLocalGov(); }
        } catch (e) {
          console.error('post-load finalisation failed', e);
        }
      }
    })
    .catch(err => {
      console.error('layer ' + group, err);
      S.loaded++;
      countUp();
    });
}

// Every filter except Local Govt — used by styleFor() to decide whether
// a parcel is drawn at all. A Local Govt mismatch alone doesn't hide a
// parcel, it dims it (see styleFor), so it's deliberately left out here.
function visibleIgnoringLG(p) {
  if (!S.showLanduse)                        return false;
  if (S.offClasses.has(p.lu))               return false;
  if (S.cat !== 'all' && p.ct !== S.cat)    return false;
  if (S.luPick && p.lu !== S.luPick)        return false;
  if (S.district !== 'all' && (p.d || S.stats.district) !== S.district) return false;
  return true;
}

// Full visibility, including Local Govt — this is "is this parcel part
// of the current selection" for stats, clicks, and the CSV/table, where
// a dimmed-but-drawn parcel outside the chosen LG should still count as
// excluded.
function visible(p) {
  if (!visibleIgnoringLG(p)) return false;
  if (S.localGov !== 'all' && p.lg !== S.localGov) return false;
  return true;
}

// "80% transparent" read as 80% see-through — 20% opacity retained.
// Named so the number is a one-line tweak if a different reading was meant.
const LG_DIM_OPACITY = 0.2;

function styleFor(f) {
  const p = f.properties;
  if (!visibleIgnoringLG(p)) return { stroke: false, fill: false, interactive: false };

  const c = S.colour[p.lu] || '#9aa79f';
  const dimmed = S.localGov !== 'all' && p.lg !== S.localGov;

  if (dimmed) {
    return {
      fill        : true,
      fillColor   : c,
      fillOpacity : LG_DIM_OPACITY,
      stroke      : true,
      color       : shade(c, -0.42),
      weight      : 0.3,
      opacity     : LG_DIM_OPACITY,
      interactive : false
    };
  }
  const proposedMark = S.showCategory && p.ct === 'Proposed';
  return {
    fill        : true,
    fillColor   : c,
    fillOpacity : S.luPick ? 0.88 : 0.72,
    stroke      : true,
    color       : proposedMark ? '#8a1f14' : shade(c, -0.42),
    weight      : proposedMark ? 1.6 : (S.luPick ? 0.9 : 0.45),
    dashArray   : proposedMark ? '3 2' : null,
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
  const rows = orderedGroupTotals()
    .filter(d => (S.stats.groups[d.g] || []).some(lu => !S.offClasses.has(lu)))
    .map(d => `<div class="leg__r"><i class="leg__sw" style="background:${GROUP_HUE[d.g]}"></i>` +
              `${GROUP_LABEL[d.g] || d.g}</div>`).join('');
  el.innerHTML = '<h4>Layers shown</h4>' +
    (rows || '<div class="leg__r">No layers selected</div>');
}

/* ═══════════════════════════════════════════ filtering */
// Ribbon segments call this to isolate one class-group, toggling
// every one of its land uses on and every other group's off.
function soloGroup(g) {
  const groups = Object.keys(S.stats.groups);
  const isSolo = groups.every(gr =>
    (S.stats.groups[gr] || []).every(lu => (gr === g) !== S.offClasses.has(lu)));
  S.offClasses.clear();
  if (!isSolo) {
    groups.forEach(gr => {
      if (gr !== g) (S.stats.groups[gr] || []).forEach(lu => S.offClasses.add(lu));
    });
  }
  syncAllLayerBoxes();
  afterFilter();
}

// Direct setter — used by the Land Use select and search results, where
// choosing the same value again should keep it selected, not toggle off.
function setClassPick(lu) {
  S.luPick = lu || null;
  if (S.luPick) {
    S.offClasses.delete(S.luPick);   // picking a class should always reveal it
    syncClassBox(S.luPick);
    syncGroupBox(S.luGroup[S.luPick]);
  }
  syncControls();
  afterFilter();
  markTable();
}

// Toggling wrapper — used by table rows and chart clicks, where clicking
// the same item again clears the isolation.
function pickClass(lu) {
  setClassPick(S.luPick === lu ? null : lu);
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
    Object.values(S.layers).forEach(l => l.setStyle(styleFor));
    paintLegend();
    readRibbon();
    refreshStats();
    updateLGSplitOverlay();
  });
}

/* ── true boundary-straddling split (Turf.js) ─────────────────────
   assignLocalGov()'s point-in-polygon test uses each parcel's centre,
   so a parcel that genuinely straddles an LG boundary is treated as
   wholly inside or outside it. This computes the real intersection —
   but only for the small number of parcels whose bounding box actually
   crosses the selected LG's edge; a fast bbox check rejects everything
   else before any expensive geometry ops run. */
let lgSplitLayer = null;

function updateLGSplitOverlay() {
  if (lgSplitLayer) { map.removeLayer(lgSplitLayer); lgSplitLayer = null; }
  if (S.localGov === 'all' || typeof turf === 'undefined') return;

  const lgEntry = S.lgIndex.find(a => a.name === S.localGov);
  const lgBounds = S.lgBounds && S.lgBounds[S.localGov];
  if (!lgEntry || !lgBounds) return;

  let lgPoly;
  try { lgPoly = turf.multiPolygon(lgEntry.rings); }
  catch (e) { console.error('LG split: bad LG geometry', e); return; }

  const overlayFeatures = [];
  Object.values(S.layers).forEach(lyr => {
    lyr.eachLayer(l => {
      const p = l.feature.properties;
      if (!visibleIgnoringLG(p)) return;
      if (!l.getBounds().intersects(lgBounds)) return;   // fast reject, no overlap at all

      let parcelPoly, inter, interArea, totalArea;
      try {
        parcelPoly = turf.multiPolygon(l.feature.geometry.coordinates);
        inter = turf.intersect(parcelPoly, lgPoly);
        if (!inter) return;
        interArea = turf.area(inter);
        totalArea = turf.area(parcelPoly);
      } catch (e) { return; }   // a handful of messy real-world rings can fail turf's ops — skip, don't break the map
      if (!totalArea) return;

      const frac = interArea / totalArea;
      // Near-total overlaps either way are already handled correctly by
      // the simple per-parcel dim/true-colour styling — only add an
      // overlay for a genuine partial straddle.
      if (frac > 0.98 || frac < 0.02) return;

      overlayFeatures.push({
        type: 'Feature',
        properties: { lu: p.lu },
        geometry: inter.geometry
      });
    });
  });

  if (!overlayFeatures.length) return;
  lgSplitLayer = L.geoJSON({ type: 'FeatureCollection', features: overlayFeatures }, {
    interactive: false,
    style: f => {
      const c = S.colour[f.properties.lu] || '#9aa79f';
      return { fill: true, fillColor: c, fillOpacity: 0.72,
               stroke: true, color: shade(c, -0.42), weight: 0.45, opacity: 0.9 };
    }
  }).addTo(map);
}

function refreshStats() {
  setText('#selWhat', currentSelectionLabel());
  const sel = S.props.filter(visible);
  if (!sel.length) {
    ['#selCount', '#selArea', '#selShare'].forEach(s => setText(s, '—'));
    if (S.props.length) setText('#selCount', '0');
    return;
  }
  const acres = sel.reduce((s, p) => s + p.a, 0);
  setText('#selCount', nf(sel.length));
  setText('#selArea',  nf(acres) + ' ac');
  setText('#selShare', nf(100 * acres / S.stats.totals.acres, 2) + '%');
}

// What is the user currently looking at? Named class > a solo'd group >
// a specific Local Govt > a specific district > a category filter >
// falls back to "Whole district" when nothing narrows the view.
function currentSelectionLabel() {
  if (S.luPick) return S.luPick;
  const active = orderedGroupTotals().filter(d =>
    (S.stats.groups[d.g] || []).some(lu => !S.offClasses.has(lu)));
  if (active.length === 1) return GROUP_LABEL[active[0].g] || active[0].g;
  if (S.localGov !== 'all') return S.localGov;
  if (S.district !== 'all') return S.district;
  if (S.cat !== 'all') return S.cat + ' only';
  return 'Whole district';
}

/* ═══════════════════════════════════════════ filters */
function buildFilters() {
  // District — the source layer carries one, but the control is wired
  // for a merged multi-district layer without further changes.
  const districts = [...new Set(S.props.map(p => p.d).filter(Boolean))];
  if (!districts.length) districts.push(S.stats.district);
  fill('#fDistrict', [['all', 'All districts']]
    .concat(districts.sort().map(d => [d, d])));

  // Land use — every class, with its parcel count.
  fill('#fLanduse', [['all', 'All land uses']].concat(
    S.stats.classes.slice()
      .sort((a, b) => a.lu.localeCompare(b.lu))
      .map(c => [c.lu, `${c.lu} (${nf(c.count)})`])));

  fill('#fLocal', [['all', 'Not available']]);
  const fLocalEl = $('#fLocal');
  if (fLocalEl) fLocalEl.title = 'Local government boundaries have not loaded yet.';
  buildSearchIndex();
}

function fill(sel, pairs) {
  const el = $(sel);
  if (!el) return;
  el.innerHTML = pairs
    .map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ── local government point-in-polygon ───────────────────────────
   S.lgAreas is populated by loadAdminBoundaries(), filtered to
   whichever district actually has parcel data loaded. Each parcel is
   assigned by point-in-polygon on its bounding-box centre. */
function ringsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

function inRing(x, y, ring) {          // ray casting
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) &&
        x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPoly(x, y, poly) {
  if (!inRing(x, y, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) if (inRing(x, y, poly[h])) return false;
  return true;                          // outside every hole
}

function assignLocalGov() {
  const stamp = (lyr) => lyr.eachLayer(l => {
    const p = l.feature.properties;
    if (p.lg) return;
    const c = l.getBounds().getCenter();
    for (const a of S.lgAreas) {
      if (a.rings.some(poly => inPoly(c.lng, c.lat, poly))) { p.lg = a.name; return; }
    }
    p.lg = 'Outside mapped areas';
  });
  Object.values(S.layers).forEach(stamp);

  // This assignment belongs to S.stats.district specifically. If the
  // user has already navigated to a different district in the (brief)
  // time this took, populateLocalGovOptions() already has the right
  // list for wherever they are now — don't clobber it.
  const effective = S.district === 'all' ? S.stats.district : S.district;
  if (effective === S.stats.district) {
    const names = [...new Set(S.props.map(p => p.lg).filter(Boolean))].sort();
    fill('#fLocal', [['all', 'All local governments']].concat(names.map(n => [n, n])));
    note('');
  }
  refreshStats();
}

function note(html) {
  const el = $('#fNote');
  if (!el) return;
  el.innerHTML = html;
  el.hidden = !html;
}

/* ═══════════════════════════════════════════ search
   Tolerant matching over land use classes and named sites: exact,
   prefix, word-prefix, substring, all-tokens, then edit distance so
   "gravyard" still finds Graveyard.                                 */
function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function lev(a, b, cap) {              // bounded Levenshtein
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

function subseq(q, t) {
  let i = 0;
  for (const ch of t) if (ch === q[i] && ++i === q.length) return true;
  return false;
}

function score(q, text) {
  const t = norm(text);
  if (!q || !t) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 860;
  const words = t.split(' ');
  if (words.some(w => w.startsWith(q))) return 720;
  if (t.includes(q)) return 580;
  const qs = q.split(' ');
  if (qs.length > 1 && qs.every(x => t.includes(x))) return 460;
  const cap = q.length <= 4 ? 1 : 2;
  let best = 0;
  for (const w of words) {
    const d = lev(q, w, cap);
    if (d <= cap) best = Math.max(best, 340 - d * 70);
  }
  if (best) return best;
  if (subseq(q.replace(/ /g, ''), t.replace(/ /g, ''))) return 190;
  return 0;
}

// Search now covers land use classes only — named sites are kept out
// of the index on request. Flip this back on to restore them; nothing
// else needs to change, buildSearchIndex still knows how to fold them
// in (see the block below, currently unreachable while this is false).
const SEARCH_INCLUDE_SITES = false;

function buildSearchIndex() {
  const idx = S.stats.classes.map(c => ({
    kind : 'class',
    label: c.lu,
    sub  : `${GROUP_LABEL[c.group] || c.group} · ${nf(c.count)} parcels · ${nf(c.acres)} ac`,
    lu   : c.lu,
    w    : c.acres
  }));

  if (SEARCH_INCLUDE_SITES) {
    // Named sites, grouped so five "Brick Kiln" records read as one entry.
    const byName = {};
    (S.stats.named_sites || []).forEach(s => {
      const k = s.name + '|' + s.lu;
      const g = byName[k] || (byName[k] = { ...s, n: 0, acres: 0 });
      g.n++; g.acres += s.acres;
      if (s.acres >= (g.big || 0)) { g.big = s.acres; g.lat = s.lat; g.lon = s.lon; }
    });
    Object.values(byName).forEach(g => idx.push({
      kind : 'site',
      label: g.name,
      sub  : `${g.lu} · ${nf(g.acres, 2)} ac` + (g.n > 1 ? ` · ${g.n} locations` : ''),
      lu   : g.lu, lat: g.lat, lon: g.lon,
      w    : g.acres
    }));
  }

  S.index = idx;
}

function runSearch(raw) {
  const q = norm(raw);
  if (q.length < 2) return hideSugg();
  S.sugg = S.index
    .map(e => ({ e, s: score(q, e.label) }))
    .filter(r => r.s > 0)
    .sort((a, b) => b.s - a.s || b.e.w - a.e.w)
    .slice(0, 9)
    .map(r => r.e);
  S.suggAt = -1;
  renderSugg(q);
}

function renderSugg(q) {
  const list = $('#fSuggest'), box = $('#fSearch');
  if (!list) return;
  if (!S.sugg.length) {
    list.innerHTML = '<li class="ac__none">Nothing matches that.</li>';
  } else {
    list.innerHTML = S.sugg.map((e, i) => `
      <li class="ac__i" role="option" data-i="${i}" aria-selected="false">
        <i class="ac__sw" style="background:${S.colour[e.lu] || '#9aa79f'}"></i>
        <span class="ac__b">
          <span class="ac__t">${hilite(e.label, q)}</span>
          <span class="ac__s">${esc(e.sub)}</span>
        </span>
      </li>`).join('');
    list.querySelectorAll('.ac__i').forEach(li =>
      li.addEventListener('mousedown', ev => {
        ev.preventDefault();
        choose(+li.dataset.i);
      }));
  }
  list.hidden = false;
  if (box) box.setAttribute('aria-expanded', 'true');
}

function hilite(text, q) {
  const i = norm(text).indexOf(q);
  if (i < 0 || !q) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) +
         '</mark>' + esc(text.slice(i + q.length));
}

function hideSugg() {
  const list = $('#fSuggest'), box = $('#fSearch');
  if (list) list.hidden = true;
  if (box) box.setAttribute('aria-expanded', 'false');
  S.sugg = []; S.suggAt = -1;
}

function moveSugg(step) {
  if (!S.sugg.length) return;
  S.suggAt = (S.suggAt + step + S.sugg.length) % S.sugg.length;
  $$('#fSuggest .ac__i').forEach((li, i) => {
    const on = i === S.suggAt;
    li.classList.toggle('is-on', on);
    li.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) li.scrollIntoView({ block: 'nearest' });
  });
}

function choose(i) {
  const e = S.sugg[i];
  if (!e) return;
  const box = $('#fSearch');
  if (box) box.value = e.label;
  hideSugg();

  setClassPick(e.lu);

  if (SEARCH_INCLUDE_SITES && e.kind === 'site' && e.lat != null) {
    map.setView([e.lat, e.lon], 16);
    L.popup({ maxWidth: 320 })
      .setLatLng([e.lat, e.lon])
      .setContent(`<div class="pop__t">${esc(e.label)}</div>` +
                  `<div class="pop__r"><span>Land use</span><span>${esc(e.lu)}</span></div>` +
                  `<div class="pop__r"><span>Detail</span><span>${esc(e.sub)}</span></div>`)
      .openOn(map);
  } else {
    zoomToClass(e.lu);
  }
}

function syncControls() {
  const set = (sel, v) => { const el = $(sel); if (el) el.value = v; };
  set('#fDistrict', S.district);
  set('#fLocal',    S.localGov);
  set('#fLanduse',  S.luPick || 'all');
  set('#fCategory', S.cat);
  markActive('#fDistrict', S.district !== 'all');
  markActive('#fLocal',    S.localGov !== 'all');
  markActive('#fLanduse',  !!S.luPick);
  markActive('#fCategory', S.cat !== 'all');
}

function markActive(sel, on) {
  const el = $(sel);
  const pill = el && el.closest('.fld');
  if (pill) pill.classList.toggle('is-active', !!on);
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
  syncControls();
  afterFilter();
}

function wire() {
  $$('[data-base]').forEach(b => b.addEventListener('click', () => {
    Object.values(BASES).forEach(l => map.removeLayer(l));
    BASES[b.dataset.base].addTo(map);
    $$('[data-base]').forEach(x => x.classList.toggle('is-on', x === b));
  }));

  $('#btnAll').addEventListener('click', () => {
    S.offClasses.clear();
    syncAllLayerBoxes();
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

  /* ── filter bar: District / Local Govt / Land Use / Category / search ── */
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

  on('#fDistrict', 'change', e => {
    S.district = e.target.value;
    S.localGov = 'all';   // a previous LG pick may not belong to the new district
    populateLocalGovOptions();
    updateHighlight();
    zoomToDistrict(S.district);
    updateDataAvailabilityNote();
    markActive('#fDistrict', S.district !== 'all');
    markActive('#fLocal', false);
    afterFilter();
  });
  on('#fLocal', 'change', e => {
    S.localGov = e.target.value;
    if (S.localGov !== 'all') {
      // Picking an LG from the full "All districts" list should bring
      // its parent district along, so the two controls stay consistent.
      const entry = S.lgIndex.find(a => a.name === S.localGov);
      if (entry && entry.district && entry.district !== S.district) {
        S.district = entry.district;
        populateLocalGovOptions();
        const elL = $('#fLocal'); if (elL) elL.value = S.localGov;
        const elD = $('#fDistrict'); if (elD) elD.value = S.district;
        updateDataAvailabilityNote();
        markActive('#fDistrict', S.district !== 'all');
      }
    }
    updateHighlight();
    zoomToLocalGov(S.localGov);
    markActive('#fLocal', S.localGov !== 'all');
    afterFilter();
  });

  on('#fLanduse', 'change', e => {
    setClassPick(e.target.value === 'all' ? null : e.target.value);
    if (S.luPick) zoomToClass(S.luPick);
  });

  // Direct set on the select — no toggle, since re-picking the same
  // option in a dropdown should keep it selected rather than clear it.
  on('#fCategory', 'change', e => {
    S.cat = e.target.value;
    markActive('#fCategory', S.cat !== 'all');
    afterFilter();
  });

  on('#fSearch', 'input', e => runSearch(e.target.value));
  on('#fSearch', 'focus', e => { if (norm(e.target.value).length >= 2) runSearch(e.target.value); });
  on('#fSearch', 'blur',  () => setTimeout(hideSugg, 120));  // let a click on a result land first
  on('#fSearch', 'keydown', e => {
    if (e.key === 'ArrowDown')      { e.preventDefault(); moveSugg(1); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); moveSugg(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (S.sugg.length) choose(S.suggAt >= 0 ? S.suggAt : 0);
    } else if (e.key === 'Escape') { hideSugg(); e.target.blur(); }
  });

  on('#fReset', 'click', resetAll);

  /* ── layer-visibility checkboxes: District/LG/Land Use/Category ── */
  on('#visDistrict', 'change', e => {
    S.showDistrict = e.target.checked;
    if (S.distLayer) S.distLayer.setStyle(f => districtStyle(f.properties.name));
  });
  on('#visLG', 'change', e => {
    S.showLG = e.target.checked;
    if (S.lgLayer) S.lgLayer.setStyle(f => lgStyle(f.properties.name));
  });
  on('#visLanduse', 'change', e => {
    S.showLanduse = e.target.checked;
    afterFilter();
  });
  on('#visCategory', 'change', e => {
    S.showCategory = e.target.checked;
    afterFilter();
  });
}

function resetAll() {
  S.offClasses.clear();
  S.cat = 'all';
  S.district = 'all';
  S.localGov = 'all';
  S.luPick = null;
  S.query = '';
  S.showDistrict = true;
  S.showLG = false;
  S.showLanduse = false;
  S.showCategory = false;
  const visMap = { visDistrict: true, visLG: false, visLanduse: false, visCategory: false };
  Object.keys(visMap).forEach(id => { const el = $('#' + id); if (el) el.checked = visMap[id]; });
  const tblSearchEl = $('#tblSearch'); if (tblSearchEl) tblSearchEl.value = '';
  const fSearchEl = $('#fSearch');     if (fSearchEl) fSearchEl.value = '';
  hideSugg();
  syncAllLayerBoxes();
  syncControls();
  if (S.lgByDistrict && Object.keys(S.lgByDistrict).length) populateLocalGovOptions();
  updateHighlight();
  updateDataAvailabilityNote();
  afterFilter();
  paintTable();
  zoomToDistrict('all');
}

})();
