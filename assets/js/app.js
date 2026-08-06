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
  districts : new Set(),   // empty = 'all districts' (no restriction) — multi-select
  localGovs : new Set(),   // empty = 'all local governments' — multi-select
  lgAreas   : null,        // local government boundaries, for the district with parcel data
  pendingLgAssign: false,  // true if boundaries arrived before all parcel layers did
  districtIndex   : [],    // [{name, rings}] every district in the province
  lgIndex         : [],    // [{name, district, rings}] every LG in the province
  lgByDistrict    : {},    // district name -> [lg names], for cascading the select
  districtBounds  : {},    // district name -> Leaflet LatLngBounds
  lgBounds        : {},    // lg name -> Leaflet LatLngBounds
  highlightDistricts: new Set(), // which district outlines are currently bolded
  highlightLGs      : new Set(), // which LG outlines are currently bolded
  patternLayer     : null, // SVG layer holding parcels whose class uses a real hatch texture
  opDistrict : 1, opLG : 1, opLanduse : 1, opCategory : 1,  // transparency sliders, 0–1
  showDistrict : true,   // District boundary layer visibility (checkbox)
  showLG       : false,  // Local Govt boundary layer visibility (checkbox)
  showLanduse  : false,  // land use parcels visibility (checkbox) — master switch
  showCategory : false,  // dashed outline on Proposed parcels (checkbox)
  cat       : 'all',
  luPicks   : new Set(),   // empty = 'all land uses' — multi-select
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
const fmtAc = acres => nf(acres, acres < 10 ? 2 : acres < 100 ? 1 : 0) + ' ac';

/* ═══════════════════════════════════════════ boot */
fetch('data/stats.json')
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(init)
  .catch(err => {
    $('#mapCount').textContent =
      'Could not load data/stats.json — check the file is published alongside index.html.';
    console.error(err);
  });

/* ─────────────────────────────────────────── official symbology
   Extracted directly from the Punjab Spatial Planning Authority's own
   Landuse_Symbology.pdf (an Esri ArcMap legend export) — not invented.
   Solid swatches use their fill colour as-is; hatched/patterned
   swatches (many of the industrial and buffer-zone classes) use the
   colour of the pattern's ink, sampled from the rendered page and
   cross-checked against the PDF's own vector fill/stroke data, since
   web polygons can't reproduce a hatch texture. A few of these are
   pale (Religious Building, Vacant Area) and will show mainly by their
   darker outline on the map rather than a visible fill — that's the
   source legend's own choice, not a rendering bug. */
const LU_SYMBOLOGY = {
  'Agriculture Area': '#d3ffbe',
  'Agriculture Zone AUD': '#a87000',
  'Agro Based Industry': '#8400a8',
  'Agro Industry Zone': '#c500ff',
  'Approved Housing Scheme': '#ffebbe',
  'Brick Kiln': '#df73ff',
  'Bypass or Ring Road': '#a80000',
  'CBD Zone': '#00c5ff',
  'City Park and Open Spaces': '#55ff00',
  'Commercial': '#73b2ff',
  'Commercial Urban Block': '#005ce6',
  'Commercial Zone': '#73dfff',
  'Cottage Industrial Zone': '#2892c7',
  'Disposal Site': '#f5a27a',
  'Economic Zone': '#ff00c5',
  'Educational Institution - Private': '#ffff00',
  'Educational Institution - Public': '#ffff00',
  'Educational Institutional Zone': '#a0c29b',
  'Educational Neighbourhood': '#ffff00',
  'Existing Settlement': '#b66a50',
  'Farm to Market Road': '#2892c7',
  'Gawala Colony': '#beffe8',
  'Grassland': '#267300',
  'Graveyard': '#ffff00',
  'Green Buffer Zone': '#4ce600',
  'Health Institution - Private': '#ff7f7f',
  'Health Institution - Public': '#ff7f7f',
  'Health Neighbourhood': '#ff7f7f',
  'Health Zone': '#ff7f7f',
  'IT Neighbourhood': '#ffaa00',
  'Industrial': '#d133ff',
  'Industrial Urban Block': '#a900e6',
  'Industrial Zone': '#e8beff',
  'Institutional Zone': '#ff0000',
  'Katchi Abadis': '#ffffbe',
  'List A Abutting': '#004da8',
  'Livestock Farming': '#d1ff73',
  'Mixed Use Zone': '#73dfff',
  'Natural Growth Boundary': '#d7c29e',
  'Notified Area': '#e1e1e1',
  'Oil Depot Buffer Zone': '#fa8d34',
  'Orchard': '#a3ff73',
  'Park and Open Spaces': '#55ff00',
  'Public Building and Govt Office': '#e81014',
  'Railway Station': '#ff0000',
  'Recreational Zone': '#00a9e6',
  'Religious Building': '#ffffff',
  'Relocation Zone': '#b2b2b2',
  'Residential Urban Block': '#ffaa00',
  'Residential Zone': '#ffebaf',
  'Road Widening': '#a87000',
  'Specialized Industrial Zone': '#e8beff',
  'State Land': '#4d4d4d',
  'Structure Plan Road': '#004c73',
  'Transport Terminal': '#9c9c9c',
  'Transportation Network': '#e1e1e1',
  'Vacant Area': '#e1e1e1',
  'Warehouse and Freight Terminal': '#005ce6',
  'Waste Water Treatment Plant': '#a87000',
  'Water Body': '#bee8ff',
};

/* Classes the source PDF draws as a hatch/crosshatch/stripe/dot texture
   rather than a flat fill. Web polygons can't reproduce this via a
   plain colour, so these ~1,500 parcels (8.8% of the district) render
   on a small separate SVG layer with real pattern fills, while the
   other ~91% stay on the fast canvas layer as flat colour. Each entry:
   pattern type, ink colour, and an optional background (defaults to
   white) for the handful of classes whose backing tint is itself part
   of the symbol (Educational Institution - Private, State Land). */
const LU_PATTERN = {
  'Agro Based Industry':               { type: 'cross',  ink: '#8400a8' },
  'Agro Industry Zone':                { type: 'hlines', ink: '#c500ff' },
  'Approved Housing Scheme':           { type: 'cross',  ink: '#e69800' },
  'Brick Kiln':                        { type: 'diag',   ink: '#df73ff' },
  'CBD Zone':                          { type: 'cross',  ink: '#00c5ff' },
  'City Park and Open Spaces':         { type: 'cross',  ink: '#2b8000' },
  'Commercial Zone':                   { type: 'diag',   ink: '#0091d9' },
  'Disposal Site':                     { type: 'diag',   ink: '#8a4b2f' },
  'Economic Zone':                     { type: 'vlines', ink: '#ff00c5' },
  'Educational Institution - Private': { type: 'diag',   ink: '#ff0000', bg: '#ffff00' },
  'Educational Neighbourhood':         { type: 'hlines', ink: '#e6c300', bg: '#fffbe0' },
  'Orchard':                           { type: 'dots',   ink: '#2b8000' },
  'Railway Station':                   { type: 'diag',   ink: '#ff0000' },
  'Recreational Zone':                 { type: 'vlines', ink: '#00a9e6' },
  'Relocation Zone':                   { type: 'hlines', ink: '#707070' },
  'Residential Zone':                  { type: 'hlines', ink: '#e6b800' },
  'Specialized Industrial Zone':       { type: 'cross',  ink: '#c500ff' },
  'State Land':                        { type: 'cross',  ink: '#000000', bg: '#d9d9d9' },
  'Vacant Area':                       { type: 'diag',   ink: '#bdbdbd' },
  'Warehouse and Freight Terminal':    { type: 'cross',  ink: '#005ce6' },
  'Waste Water Treatment Plant':       { type: 'cross',  ink: '#a87000' },
};

const SVGNS = 'http://www.w3.org/2000/svg';
const PATTERN_TILE = 8;

// Builds one <pattern> element for a class's hatch spec, sized to
// PATTERN_TILE, tileable. Assigns and returns its element id.
function buildPatternDef(lu, spec, index) {
  const id = 'luPat' + index;
  const s = PATTERN_TILE, h = s / 2;
  let shapes = '';
  if (spec.type === 'diag') {
    shapes = `<line x1="0" y1="${s}" x2="${s}" y2="0" stroke="${spec.ink}" stroke-width="1.3"/>`;
  } else if (spec.type === 'cross') {
    shapes = `<line x1="0" y1="0" x2="${s}" y2="${s}" stroke="${spec.ink}" stroke-width="1"/>` +
             `<line x1="0" y1="${s}" x2="${s}" y2="0" stroke="${spec.ink}" stroke-width="1"/>`;
  } else if (spec.type === 'hlines') {
    shapes = `<line x1="0" y1="${h}" x2="${s}" y2="${h}" stroke="${spec.ink}" stroke-width="1.5"/>`;
  } else if (spec.type === 'vlines') {
    shapes = `<line x1="${h}" y1="0" x2="${h}" y2="${s}" stroke="${spec.ink}" stroke-width="1.5"/>`;
  } else if (spec.type === 'dots') {
    shapes = `<circle cx="${h}" cy="${h}" r="1.1" fill="${spec.ink}"/>`;
  }
  const pat = document.createElementNS(SVGNS, 'pattern');
  pat.setAttribute('id', id);
  pat.setAttribute('width', s);
  pat.setAttribute('height', s);
  pat.setAttribute('patternUnits', 'userSpaceOnUse');
  pat.innerHTML = `<rect width="${s}" height="${s}" fill="${spec.bg || '#ffffff'}"/>` + shapes;
  spec._id = id;
  return pat;
}

// Small UI swatches (legend, search, table, big-numbers) — a flat
// colour for solid classes, or a scaled-down CSS approximation of the
// real hatch/cross/stripe/dot pattern for the ~21 classes that use one,
// so these stay visually consistent with the map itself.
function swatchCSS(lu) {
  const spec = LU_PATTERN[lu];
  const c = S.colour[lu] || '#9aa79f';
  if (!spec) return `background:${c}`;
  const bg = spec.bg || '#ffffff';
  const ink = spec.ink;
  if (spec.type === 'diag')
    return `background:${bg};background-image:repeating-linear-gradient(45deg,${ink} 0,${ink} 1.2px,transparent 1.2px,transparent 4px)`;
  if (spec.type === 'cross')
    return `background:${bg};background-image:` +
      `repeating-linear-gradient(45deg,${ink} 0,${ink} 1px,transparent 1px,transparent 4px),` +
      `repeating-linear-gradient(135deg,${ink} 0,${ink} 1px,transparent 1px,transparent 4px)`;
  if (spec.type === 'hlines')
    return `background:${bg};background-image:repeating-linear-gradient(0deg,${ink} 0,${ink} 1.2px,transparent 1.2px,transparent 4px)`;
  if (spec.type === 'vlines')
    return `background:${bg};background-image:repeating-linear-gradient(90deg,${ink} 0,${ink} 1.2px,transparent 1.2px,transparent 4px)`;
  if (spec.type === 'dots')
    return `background:${bg};background-image:radial-gradient(${ink} 35%,transparent 35%);background-size:4px 4px`;
  return `background:${c}`;
}

function init(stats) {
  S.stats = stats;
  assignGroupStyles(stats.groups, stats.groupLabels);

  // class -> group; colour comes from the official symbology table when
  // the class is in it, otherwise falls back to a shade within the
  // group's hue (keeps this working for a future district whose classes
  // aren't covered by this specific legend).
  Object.entries(stats.groups).forEach(([g, classes]) => {
    const n = classes.length;
    classes.forEach((lu, i) => {
      S.luGroup[lu] = g;
      if (LU_SYMBOLOGY[lu]) {
        S.colour[lu] = LU_SYMBOLOGY[lu];
      } else {
        const t = n === 1 ? 0 : (i / (n - 1)) * 0.52 - 0.2;   // -0.20 … +0.32
        S.colour[lu] = shade(GROUP_HUE[g], t);
      }
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
  reset.hidden = (S.offClasses.size === 0 && !S.luPicks.size && S.cat === 'all' &&
                  !S.districts.size && !S.localGovs.size);

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
const GROUP_N_EL = {};  // group key -> its number span (updated to filtered acres)
const CLASS_BOX = {};   // land use class -> its checkbox element
const CLASS_ROW = {};   // land use class -> its row label element
const CLASS_N_EL = {};  // land use class -> its number span (updated to filtered acres)

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
    chev.setAttribute('aria-expanded', 'false');
    chev.setAttribute('aria-label', 'Expand ' + (GROUP_LABEL[g] || g));
    chev.innerHTML = CHEV_SVG;

    const lab = document.createElement('label');
    lab.className = 'lgroup__row';
    lab.dataset.group = g;
    lab.innerHTML =
      '<input type="checkbox" class="lgroup__box" checked>' +
      `<i class="lgroup__sw" style="background:${GROUP_HUE[g] || '#9aa79f'}"></i>` +
      `<span class="lgroup__nm">${esc(GROUP_LABEL[g] || g)}</span>` +
      `<span class="lgroup__n">${fmtAc(d.acres)}</span>`;

    head.append(chev, lab);
    wrap.appendChild(head);

    const kids = document.createElement('div');
    kids.className = 'lchildren';
    kids.setAttribute('role', 'group');
    kids.hidden = true;

    classes.forEach(c => {
      const row = document.createElement('label');
      row.className = 'lchild__row';
      row.dataset.lu = c.lu;
      row.innerHTML =
        '<input type="checkbox" class="lchild__box" checked>' +
        `<i class="lchild__sw" style="${swatchCSS(c.lu)}"></i>` +
        `<span class="lchild__nm">${esc(c.lu)}</span>` +
        `<span class="lchild__n">${fmtAc(c.acres)}</span>`;
      const box = row.querySelector('input');
      box.addEventListener('change', () => {
        box.checked ? S.offClasses.delete(c.lu) : S.offClasses.add(c.lu);
        row.classList.toggle('is-off', !box.checked);
        syncGroupBox(g);
        afterFilter();
      });
      CLASS_BOX[c.lu] = box;
      CLASS_ROW[c.lu] = row;
      CLASS_N_EL[c.lu] = row.querySelector('.lchild__n');
      kids.appendChild(row);
    });

    wrap.appendChild(kids);
    host.appendChild(wrap);

    const groupBox = lab.querySelector('input');
    GROUP_BOX[g] = groupBox;
    GROUP_ROW[g] = lab;
    GROUP_N_EL[g] = lab.querySelector('.lgroup__n');
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
    zoomControl  : false,   // re-added below, moved to bottom-right
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

  // Bottom-right stack: base-map switcher, then zoom, then scale — added
  // in this order so they stack in this order (Leaflet stacks controls
  // within one corner in the order they're added).
  const baseSwitch = L.control({ position: 'bottomright' });
  baseSwitch.onAdd = function () {
    const d = L.DomUtil.create('div', 'seg seg--map');
    L.DomEvent.disableClickPropagation(d);
    d.innerHTML =
      '<button class="seg__b is-on" data-base="street">Street</button>' +
      '<button class="seg__b" data-base="satellite">Satellite</button>' +
      '<button class="seg__b" data-base="plain">Plain</button>';
    return d;
  };
  baseSwitch.addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ position: 'bottomright', imperial: false, maxWidth: 140 }).addTo(map);

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
        allDistricts.map(d => [d, d])));

      populateLocalGovOptions();
      updateHighlight();
      syncControls();

      // The initial view was an approximate Punjab bbox; now that we have
      // the real geometry, refit precisely — unless the user has already
      // picked a specific district or LG in the brief gap while this loaded.
      if (!S.districts.size && !S.localGovs.size) {
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
  }).catch(() => {
    note(
      'Province-wide boundaries are not present. Add <code>data/districts.geojson</code> ' +
      'and <code>data/local_govts.geojson</code> (see README) and both filters switch on ' +
      'automatically.');
    // Without them the map would otherwise stay stuck at the approximate
    // whole-Punjab placeholder view forever — fall back to the district
    // this dashboard actually has parcel data for.
    try {
      const bb = S.stats.bbox;
      map.fitBounds(L.latLngBounds([bb[1], bb[0]], [bb[3], bb[2]]), { padding: [16, 16] });
    } catch (e) { console.error('fallback zoom failed', e); }
  });
}


// Every district: black outline, light green fill, always visible.
// The selected one (if any) gets a heavier stroke to stand out once
// zoomed in — same colours, just bolder, rather than a totally
// different treatment that would compete visually with the parcels.
function districtStyle(name) {
  if (!S.showDistrict) return { fill: false, stroke: false };
  const selected = S.highlightDistricts.has(name);
  return {
    fill: false,
    color: selected ? '#ffd400' : '#FFA7A9',
    weight: selected ? 4 : 2,
    opacity: S.opDistrict
  };
}

// Local Govt: black outline by default, no fill; red and heavier when
// selected. ("Red black" in the request read as black-by-default with
// red reserved for the selected state, matching point 4's own wording —
// flag if a literal dark-red default was meant instead.)
function lgStyle(name) {
  if (!S.showLG) return { fill: false, stroke: false };
  const selected = S.highlightLGs.has(name);
  return {
    fill: false,
    color: selected ? '#ff0000' : '#000000',
    weight: selected ? 3.5 : 1.4,
    opacity: selected ? 1 : S.opLG
  };
}

// Which outlines are bolded — empty when 'all' is selected, since every
// district/LG is already shown equally at that point; picking one or
// more specific districts/LGs is what earns them the heavier treatment.
function updateHighlight() {
  S.highlightDistricts = new Set(S.districts);
  S.highlightLGs = new Set(S.localGovs);
  if (S.distLayer) S.distLayer.setStyle(f => districtStyle(f.properties.name));
  if (S.lgLayer) S.lgLayer.setStyle(f => lgStyle(f.properties.name));
}

// Local Govt options cascade to whichever district(s) are selected —
// empty selection falls back to showing the district that actually has
// parcel data, rather than all 237 units across the province at once.
// With multiple districts selected, shows the union of their LGs.
function populateLocalGovOptions() {
  const el = $('#fLocal');
  if (!el) return;
  const effective = S.districts.size ? [...S.districts] : [S.stats.district];
  const names = [...new Set(effective.flatMap(d => S.lgByDistrict[d] || []))].sort();
  fill('#fLocal', [['all', 'All local governments']].concat(names.map(n => [n, n])));
  el.disabled = false;
  el.removeAttribute('title');
  const pill = el.closest('.fld');
  if (pill) pill.classList.remove('fld--disabled');
}

// Land Use options cascade to the current District/Local Govt (and
// Category) scope — only classes actually present there are
// selectable, each labelled with its count for that scope specifically,
// not the whole-district count. Clears the current pick if it no
// longer exists in the new scope, rather than leaving a stale selection.
function populateLanduseOptions() {
  const el = $('#fLanduse');
  if (!el || !S.props.length) return;   // parcels not loaded yet — leave the static placeholder list
  const totals = computeFilteredClassTotals();
  const available = S.stats.classes
    .filter(c => totals[c.lu])
    .slice()
    .sort((a, b) => a.lu.localeCompare(b.lu));
  fill('#fLanduse', [['all', 'All land uses']].concat(
    available.map(c => [c.lu, `${c.lu} (${totals[c.lu].count})`])));
  // drop any picks that no longer exist in this scope, rather than
  // clearing the whole multi-selection over one invalidated entry
  [...S.luPicks].forEach(lu => { if (!totals[lu]) S.luPicks.delete(lu); });
  setMultiSelected('#fLanduse', S.luPicks);
}

function zoomToDistricts(names) {
  const list = names && names.size ? [...names] : null;
  if (!list) {
    if (S.distLayer) { map.fitBounds(S.distLayer.getBounds(), { padding: [16, 16] }); return; }
    const bb = S.stats.bbox;
    map.fitBounds(L.latLngBounds([bb[1], bb[0]], [bb[3], bb[2]]), { padding: [16, 16] });
    return;
  }
  const combined = L.latLngBounds([]);
  list.forEach(name => { const b = S.districtBounds && S.districtBounds[name]; if (b) combined.extend(b); });
  if (combined.isValid()) map.fitBounds(combined, { padding: [24, 24] });
}

function zoomToLocalGovs(names) {
  const list = names && names.size ? [...names] : null;
  if (!list) return zoomToDistricts(S.districts);
  const combined = L.latLngBounds([]);
  list.forEach(name => { const b = S.lgBounds && S.lgBounds[name]; if (b) combined.extend(b); });
  if (combined.isValid()) map.fitBounds(combined, { padding: [24, 24] });
}

// A district other than the one with parcel data legitimately shows an
// empty map (its boundary is still real and correctly drawn) — no
// separate note is shown for this any more, on request.
function updateDataAvailabilityNote() {
  note('');
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
          populateLanduseOptions();
          buildPatternLayer();
          if (S.pendingLgAssign) { S.pendingLgAssign = false; assignLocalGov(); }
          // The boundary layers were brought to front back when they first
          // loaded, but parcel layers (and the pattern layer) finish later
          // and get added on top of them — re-assert the order now that
          // everything actually exists, or the LG/district lines end up
          // invisible under the parcel fill wherever they overlap.
          if (S.distLayer) S.distLayer.bringToFront();
          if (S.lgLayer) S.lgLayer.bringToFront();
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
  if (S.luPicks.size && !S.luPicks.has(p.lu))            return false;
  if (S.districts.size && !S.districts.has(p.d || S.stats.district)) return false;
  return true;
}

// Full visibility, including Local Govt — this is "is this parcel part
// of the current selection" for stats, clicks, and the CSV/table, where
// a dimmed-but-drawn parcel outside the chosen LG should still count as
// excluded.
function visible(p) {
  if (!visibleIgnoringLG(p)) return false;
  if (S.localGovs.size && !S.localGovs.has(p.lg)) return false;
  return true;
}

// "80% transparent" read as 80% see-through — 20% opacity retained.
// Named so the number is a one-line tweak if a different reading was meant.
const LG_DIM_OPACITY = 0.2;

function styleFor(f) {
  const p = f.properties;
  if (!visibleIgnoringLG(p)) return { stroke: false, fill: false, interactive: false };
  if (LU_PATTERN[p.lu]) return { stroke: false, fill: false, interactive: false };  // drawn on the pattern layer instead

  const c = S.colour[p.lu] || '#9aa79f';
  const dimmed = S.localGovs.size && !S.localGovs.has(p.lg);

  if (dimmed) {
    return {
      fill        : true,
      fillColor   : c,
      fillOpacity : LG_DIM_OPACITY * S.opLanduse,
      stroke      : true,
      color       : shade(c, -0.42),
      weight      : 0.3,
      opacity     : LG_DIM_OPACITY * S.opLanduse,
      interactive : false
    };
  }
  const proposedMark = S.showCategory && p.ct === 'Proposed';
  // The slider IS the opacity now — 100% means fully opaque (the basemap
  // shouldn't show through at all), not 72-88% of opaque as before.
  return {
    fill        : true,
    fillColor   : c,
    fillOpacity : S.opLanduse,
    stroke      : true,
    color       : proposedMark ? '#8a1f14' : shade(c, -0.42),
    weight      : proposedMark ? 1.6 : (S.luPicks.size ? 0.9 : 0.45),
    dashArray   : proposedMark ? '3 2' : null,
    opacity     : proposedMark ? S.opCategory : S.opLanduse,
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
// Single pick — used by table rows, chart clicks, and search, which all
// mean "isolate just this one class" rather than add to a multi-select.
function setClassPick(lu) {
  S.luPicks = lu ? new Set([lu]) : new Set();
  if (lu) {
    S.offClasses.delete(lu);   // picking a class should always reveal it
    syncClassBox(lu);
    syncGroupBox(S.luGroup[lu]);
  }
  syncControls();
  afterFilter();
  markTable();
}

// Used by the multi-select Land Use dropdown specifically — replaces
// the whole picked set at once (ctrl/cmd-click chooses several), and
// reveals any of them that had been individually toggled off in the
// legend, same as a single pick does.
function setClassPicks(list) {
  S.luPicks = new Set(list);
  S.luPicks.forEach(lu => {
    S.offClasses.delete(lu);
    syncClassBox(lu);
    syncGroupBox(S.luGroup[lu]);
  });
  syncControls();
  afterFilter();
  markTable();
}

// Toggling wrapper — used by table rows and chart clicks, where clicking
// the same item again clears the isolation.
function pickClass(lu) {
  setClassPick(S.luPicks.size === 1 && S.luPicks.has(lu) ? null : lu);
  if (S.luPicks.size) zoomToClasses(S.luPicks);
}

function zoomToClasses(names) {
  const list = names && names.size ? [...names] : [];
  if (!list.length) return;
  const combined = L.latLngBounds([]);
  list.forEach(lu => {
    const g = S.luGroup[lu];
    const lyr = S.layers[g];
    if (!lyr) return;
    lyr.eachLayer(l => { if (l.feature.properties.lu === lu) combined.extend(l.getBounds()); });
  });
  if (combined.isValid()) map.fitBounds(combined, { padding: [28, 28], maxZoom: 15 });
}

let raf = null;
function afterFilter() {
  if (raf) cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    // Each step isolated: a failure in one (e.g. the pattern layer) must
    // not silently prevent later steps — refreshStats() in particular —
    // from running. This is what was making the legend look frozen.
    try { Object.values(S.layers).forEach(l => l.setStyle(styleFor)); }
    catch (e) { console.error('parcel layer restyle failed', e); }

    try { if (S.patternLayer) S.patternLayer.setStyle(patternStyleFor); }
    catch (e) { console.error('pattern layer restyle failed', e); }

    try { refreshBigNumbers(); }
    catch (e) { console.error('big numbers refresh failed', e); }

    try { readRibbon(); }
    catch (e) { console.error('ribbon refresh failed', e); }

    try { refreshStats(); }
    catch (e) { console.error('stats refresh failed', e); }

    try { updateLGSplitOverlay(); }
    catch (e) { console.error('LG split overlay failed', e); }
  });
}

// Same visibility/dimming/category rules as the main styleFor(), but
// fills with the class's real pattern instead of a flat colour.
function patternStyleFor(f) {
  const p = f.properties;
  if (!visibleIgnoringLG(p)) return { stroke: false, fill: false, interactive: false };

  const spec = LU_PATTERN[p.lu];
  const dimmed = S.localGovs.size && !S.localGovs.has(p.lg);
  const proposedMark = S.showCategory && p.ct === 'Proposed';
  const ink = spec ? spec.ink : '#9aa79f';

  return {
    fill        : true,
    fillColor   : spec ? `url(#${spec._id})` : ink,
    fillOpacity : dimmed ? LG_DIM_OPACITY * S.opLanduse : S.opLanduse,
    stroke      : true,
    color       : dimmed ? shade(ink, -0.3) : (proposedMark ? '#8a1f14' : shade(ink, -0.3)),
    weight      : dimmed ? 0.3 : (proposedMark ? 1.6 : (S.luPicks.size ? 0.9 : 0.45)),
    dashArray   : (!dimmed && proposedMark) ? '3 2' : null,
    opacity     : dimmed ? LG_DIM_OPACITY * S.opLanduse : (proposedMark ? S.opCategory : S.opLanduse),
    interactive : !dimmed
  };
}

// Built once, after every parcel layer has loaded: pulls out just the
// ~1,500 parcels (8.8% of the district) whose class needs a real hatch
// texture rather than a flat fill, and renders them on their own SVG
// layer with genuine <pattern> fills — the other ~91% stay on the fast
// canvas layers untouched.
function buildPatternLayer() {
  const patternedLu = Object.keys(LU_PATTERN);
  if (!patternedLu.length) return;

  const features = [];
  Object.values(S.layers).forEach(lyr => {
    lyr.eachLayer(l => {
      if (LU_PATTERN[l.feature.properties.lu]) features.push(l.feature);
    });
  });
  if (!features.length) return;

  let renderer;
  try {
    renderer = L.svg();
    renderer.addTo(map);
  } catch (e) { console.error('pattern layer: SVG renderer unavailable', e); return; }

  try {
    const svgRoot = renderer._container;
    if (svgRoot) {
      let defs = svgRoot.querySelector('defs');
      if (!defs) {
        defs = document.createElementNS(SVGNS, 'defs');
        svgRoot.insertBefore(defs, svgRoot.firstChild);
      }
      Object.entries(LU_PATTERN).forEach(([lu, spec], i) => {
        defs.appendChild(buildPatternDef(lu, spec, i));
      });
    }
  } catch (e) { console.error('pattern defs failed', e); }

  S.patternLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
    renderer,
    style: patternStyleFor,
    onEachFeature: (f, lyr) => lyr.on('click', e => {
      if (!visible(f.properties)) return;
      L.popup({ maxWidth: 320 }).setLatLng(e.latlng).setContent(popup(f.properties)).openOn(map);
    })
  }).addTo(map);

  try { S.patternLayer.bringToFront(); } catch (e) { /* cosmetic only */ }
  console.info(`pattern layer: ${features.length} parcels across ${patternedLu.length} patterned classes`);
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
  if (!S.localGovs.size || typeof turf === 'undefined') return;

  const lgEntries = [...S.localGovs].map(n => S.lgIndex.find(a => a.name === n)).filter(Boolean);
  if (!lgEntries.length) return;

  const combinedBounds = L.latLngBounds([]);
  S.localGovs.forEach(n => { const b = S.lgBounds && S.lgBounds[n]; if (b) combinedBounds.extend(b); });
  if (!combinedBounds.isValid()) return;

  // Union every selected LG's polygon into one shape, so a parcel
  // straddling the boundary BETWEEN two selected LGs isn't wrongly
  // treated as partially outside the selection.
  let lgPoly;
  try {
    lgPoly = turf.multiPolygon(lgEntries[0].rings);
    for (let i = 1; i < lgEntries.length; i++) {
      const merged = turf.union(lgPoly, turf.multiPolygon(lgEntries[i].rings));
      if (merged) lgPoly = merged;
    }
  } catch (e) { console.error('LG split: bad LG geometry', e); return; }

  const overlayFeatures = [];
  Object.values(S.layers).forEach(lyr => {
    lyr.eachLayer(l => {
      const p = l.feature.properties;
      if (!visibleIgnoringLG(p)) return;
      if (!l.getBounds().intersects(combinedBounds)) return;   // fast reject, no overlap at all

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
  refreshLegendAcres();
  refreshBigNumbers();
}

// Area AND count per land-use class under the current District/Local
// Govt/Category filters — deliberately NOT narrowed by luPick or
// offClasses, since this answers "what does everything look like under
// my geographic/category filter" (the legend numbers, the big-numbers
// list, the Land Use dropdown's own options), not "what's currently
// drawn on the map".
function computeFilteredClassTotals() {
  const totals = {};
  S.props.forEach(p => {
    if (S.districts.size && !S.districts.has(p.d || S.stats.district)) return;
    if (S.localGovs.size && !S.localGovs.has(p.lg)) return;
    if (S.cat !== 'all' && p.ct !== S.cat) return;
    const t = totals[p.lu] || (totals[p.lu] = { acres: 0, count: 0 });
    t.acres += p.a;
    t.count += 1;
  });
  return totals;
}

// Updates the acreage shown next to every class/group in the legend
// tree in place — no rebuild, so expand/collapse state and checkbox
// listeners are untouched. Classes (and whole groups, if none of their
// classes have anything here) absent from the current District/Local
// Govt scope are hidden rather than just shown at zero, matching "only
// land use in that LG should be available to select".
function refreshLegendAcres() {
  const totals = computeFilteredClassTotals();
  const scoped = S.districts.size > 0 || S.localGovs.size > 0;   // is a geographic scope active at all?
  Object.keys(S.stats.groups).forEach(g => {
    let groupSum = 0, groupCount = 0;
    (S.stats.groups[g] || []).forEach(lu => {
      const t = totals[lu];
      const acres = t ? t.acres : 0;
      groupSum += acres;
      groupCount += t ? t.count : 0;
      if (CLASS_N_EL[lu]) CLASS_N_EL[lu].textContent = fmtAc(acres);
      if (CLASS_ROW[lu]) CLASS_ROW[lu].classList.toggle('is-unavailable', scoped && !t);
    });
    if (GROUP_N_EL[g]) GROUP_N_EL[g].textContent = fmtAc(groupSum);
    if (GROUP_ROW[g] && GROUP_ROW[g].closest) {
      const wrap = GROUP_ROW[g].closest('.lgroup');
      if (wrap) wrap.classList.toggle('is-unavailable', scoped && groupCount === 0);
    }
  });
}

// What is the user currently looking at? Named class > a solo'd group >
// a specific Local Govt > a specific district > a category filter >
// falls back to "Whole district" when nothing narrows the view.
function setLabel(set, noun) {
  const arr = [...set];
  if (arr.length <= 2) return arr.join(' & ');
  if (arr.length <= 4) return arr.join(', ');
  return `${arr.length} ${noun}`;
}

function currentSelectionLabel() {
  if (S.luPicks.size) return setLabel(S.luPicks, 'land uses');
  const active = orderedGroupTotals().filter(d =>
    (S.stats.groups[d.g] || []).some(lu => !S.offClasses.has(lu)));
  if (active.length === 1) return GROUP_LABEL[active[0].g] || active[0].g;
  if (S.localGovs.size) return setLabel(S.localGovs, 'local govts');
  if (S.districts.size) return setLabel(S.districts, 'districts');
  if (S.cat !== 'all') return S.cat + ' only';
  return 'Whole district';
}

// The right-hand panel: one big figure for whatever's specifically
// picked (a class, or a solo'd group), or — when nothing narrows the
// view — every land use's area under the current district/LG/category
// filter, largest first.
function refreshBigNumbers() {
  const host = $('#bigNumbers');
  if (!host) return;

  const totals = computeFilteredClassTotals();
  const viewTotal = Object.values(totals).reduce((s, t) => s + t.acres, 0);

  if (S.luPicks.size) {
    const acres = [...S.luPicks].reduce((s, lu) => s + (totals[lu] ? totals[lu].acres : 0), 0);
    const pct = viewTotal ? 100 * acres / viewTotal : 0;
    const title = S.luPicks.size === 1 ? [...S.luPicks][0] : `${S.luPicks.size} land uses selected`;
    host.innerHTML =
      `<p class="bn__label">Selected land use${S.luPicks.size > 1 ? 's' : ''}</p>` +
      `<h3 class="bn__title">${esc(title)}</h3>` +
      `<div class="bn__figure">` +
        `<span class="bn__n">${nf(acres, acres < 100 ? 1 : 0)}</span><span class="bn__u">acres</span>` +
        `<div class="bn__pct">${nf(pct, 1)}% of this view</div>` +
      `</div>`;
    return;
  }

  const activeGroups = orderedGroupTotals().filter(d =>
    (S.stats.groups[d.g] || []).some(lu => !S.offClasses.has(lu)));

  if (activeGroups.length === 1) {
    const g = activeGroups[0].g;
    const members = (S.stats.groups[g] || [])
      .map(lu => ({ lu, acres: totals[lu] ? totals[lu].acres : 0 }))
      .sort((a, b) => b.acres - a.acres);
    const groupAcres = members.reduce((s, m) => s + m.acres, 0);
    const pct = viewTotal ? 100 * groupAcres / viewTotal : 0;
    host.innerHTML =
      `<p class="bn__label">Selected group</p>` +
      `<h3 class="bn__title">${esc(GROUP_LABEL[g] || g)}</h3>` +
      `<div class="bn__figure">` +
        `<span class="bn__n">${nf(groupAcres, groupAcres < 100 ? 1 : 0)}</span><span class="bn__u">acres</span>` +
        `<div class="bn__pct">${nf(pct, 1)}% of this view</div>` +
      `</div>` +
      `<p class="bn__label">By land use</p>` +
      `<div class="bn__list">` + members.map(bnRow).join('') + `</div>`;
    wireBigNumberRows(host);
    return;
  }

  const all = Object.keys(totals)
    .map(lu => ({ lu, acres: totals[lu].acres }))
    .filter(d => d.acres > 0)
    .sort((a, b) => b.acres - a.acres);
  host.innerHTML =
    `<p class="bn__label">${esc(currentSelectionLabel())}</p>` +
    `<div class="bn__figure">` +
      `<span class="bn__n">${nf(viewTotal, 0)}</span><span class="bn__u">acres total</span>` +
    `</div>` +
    `<p class="bn__label">By land use, largest first</p>` +
    `<div class="bn__list">` + all.map(bnRow).join('') + `</div>`;
  wireBigNumberRows(host);
}

function bnRow(d) {
  return `<div class="bn__row" data-lu="${esc(d.lu)}">` +
    `<i class="bn__sw" style="${swatchCSS(d.lu)}"></i>` +
    `<span class="bn__nm">${esc(d.lu)}</span>` +
    `<span class="bn__ac">${fmtAc(d.acres)}</span></div>`;
}

function wireBigNumberRows(host) {
  host.querySelectorAll('.bn__row').forEach(row =>
    row.addEventListener('click', () => pickClass(row.dataset.lu)));
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

// fill() rebuilds every <option> via innerHTML, which drops any selected
// state — call this right after to re-apply which ones should be
// selected. Empty set selects the "all" option, so it's visually clear
// that's the active state on the multi-select rather than looking like
// nothing at all is chosen.
function setMultiSelected(sel, valuesSet) {
  const el = $(sel);
  if (!el) return;
  Array.from(el.options).forEach(o => {
    o.selected = valuesSet.size === 0 ? (o.value === 'all') : valuesSet.has(o.value);
  });
}

// Reads a multi-select's chosen values into a Set, normalising the
// "all X" option: picking it (or picking nothing) means no restriction
// (empty Set) and visually deselects everything else; picking specific
// values visually deselects "all" so the control isn't showing two
// contradictory things as selected at once.
function readMultiSelect(el) {
  const vals = Array.from(el.selectedOptions).map(o => o.value);
  if (!vals.length || vals.includes('all')) {
    Array.from(el.options).forEach(o => { o.selected = (o.value === 'all'); });
    return new Set();
  }
  Array.from(el.options).forEach(o => { if (o.value === 'all') o.selected = false; });
  return new Set(vals);
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
  const effective = S.districts.size ? [...S.districts] : [S.stats.district];
  if (effective.includes(S.stats.district)) {
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
        <i class="ac__sw" style="${swatchCSS(e.lu)}"></i>
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
    zoomToClasses(new Set([e.lu]));
  }
}

function syncControls() {
  const set = (sel, v) => { const el = $(sel); if (el) el.value = v; };
  setMultiSelected('#fDistrict', S.districts);
  setMultiSelected('#fLocal',    S.localGovs);
  setMultiSelected('#fLanduse',  S.luPicks);
  set('#fCategory', S.cat);
  markActive('#fDistrict', S.districts.size > 0);
  markActive('#fLocal',    S.localGovs.size > 0);
  markActive('#fLanduse',  S.luPicks.size > 0);
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
    if (S.luPicks.has(c.lu)) tr.className = 'is-on';
    tr.innerHTML =
      `<td class="is-txt"><i class="tbl__sw" style="${swatchCSS(c.lu)}"></i>${c.lu}</td>` +
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
    tr.classList.toggle('is-on', S.luPicks.has(tr.dataset.lu)));
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
    S.districts = readMultiSelect(e.target);
    S.localGovs = new Set();   // a previous LG pick may not belong to the new district(s)
    populateLocalGovOptions();
    populateLanduseOptions();
    updateHighlight();
    zoomToDistricts(S.districts);
    updateDataAvailabilityNote();
    markActive('#fDistrict', S.districts.size > 0);
    markActive('#fLocal', false);
    afterFilter();
  });
  on('#fLocal', 'change', e => {
    S.localGovs = readMultiSelect(e.target);
    if (S.localGovs.size) {
      // If any picked LG belongs to a district not currently selected,
      // bring its parent district along too, so the two controls stay
      // consistent — same idea as the old single-select behaviour.
      const parents = new Set([...S.localGovs]
        .map(n => { const entry = S.lgIndex.find(a => a.name === n); return entry && entry.district; })
        .filter(Boolean));
      const needsUpdate = [...parents].some(d => !S.districts.has(d));
      if (needsUpdate && parents.size) {
        parents.forEach(d => S.districts.add(d));
        populateLocalGovOptions();
        setMultiSelected('#fLocal', S.localGovs);
        setMultiSelected('#fDistrict', S.districts);
        updateDataAvailabilityNote();
        markActive('#fDistrict', S.districts.size > 0);
      }
    }
    populateLanduseOptions();
    updateHighlight();
    zoomToLocalGovs(S.localGovs);
    markActive('#fLocal', S.localGovs.size > 0);
    afterFilter();
  });

  on('#fLanduse', 'change', e => {
    const picked = readMultiSelect(e.target);
    setClassPicks(picked);
    if (S.luPicks.size) zoomToClasses(S.luPicks);
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

  /* ── transparency sliders: District/LG/Land Use/Category ── */
  const wireOpacity = (id, readoutId, setter, restyle) => {
    on('#' + id, 'input', e => {
      const v = Number(e.target.value) / 100;
      setter(v);
      setText('#' + readoutId, e.target.value + '%');
      restyle();
    });
  };
  wireOpacity('opDistrict', 'opDistrictN', v => { S.opDistrict = v; },
    () => { if (S.distLayer) S.distLayer.setStyle(f => districtStyle(f.properties.name)); });
  wireOpacity('opLG', 'opLGN', v => { S.opLG = v; },
    () => { if (S.lgLayer) S.lgLayer.setStyle(f => lgStyle(f.properties.name)); });
  wireOpacity('opLanduse', 'opLanduseN', v => { S.opLanduse = v; }, afterFilter);
  wireOpacity('opCategory', 'opCategoryN', v => { S.opCategory = v; }, afterFilter);
}

function resetAll() {
  S.offClasses.clear();
  S.cat = 'all';
  S.districts = new Set();
  S.localGovs = new Set();
  S.luPicks = new Set();
  S.query = '';
  S.showDistrict = true;
  S.showLG = false;
  S.showLanduse = false;
  S.showCategory = false;
  const visMap = { visDistrict: true, visLG: false, visLanduse: false, visCategory: false };
  Object.keys(visMap).forEach(id => { const el = $('#' + id); if (el) el.checked = visMap[id]; });
  S.opDistrict = S.opLG = S.opLanduse = S.opCategory = 1;
  ['opDistrict', 'opLG', 'opLanduse', 'opCategory'].forEach(id => {
    const el = $('#' + id); if (el) el.value = 100;
    setText('#' + id + 'N', '100%');
  });
  const tblSearchEl = $('#tblSearch'); if (tblSearchEl) tblSearchEl.value = '';
  const fSearchEl = $('#fSearch');     if (fSearchEl) fSearchEl.value = '';
  hideSugg();
  syncAllLayerBoxes();
  syncControls();
  if (S.lgByDistrict && Object.keys(S.lgByDistrict).length) populateLocalGovOptions();
  populateLanduseOptions();
  updateHighlight();
  updateDataAvailabilityNote();
  afterFilter();
  paintTable();
  zoomToDistricts(S.districts);
}

})();
