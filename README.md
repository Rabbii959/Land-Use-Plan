# Hafizabad District Land Use Plan — Statistical Dashboard

An interactive map and statistical dashboard for the Hafizabad district land use
plan, built for the **Punjab Spatial Planning Authority**. It is a companion to
the province-wide [Punjab Land Use Plan dashboard](https://rabbii959.github.io/Punjab-Landuse-Plan/)
and follows the same visual identity, adding a spatial map view and per-parcel
statistics that the province-level dashboard does not carry.

Static site. No build step, no server, no dependencies to install.

---

## What it shows

| | |
|---|---|
| **582,892 acres** | total planned area |
| **2,358.9 km²** | land area, computed from geometry |
| **16,980** | mapped parcels |
| **60** | land use classes |
| **3.3%** | of area is newly proposed zoning |

**Map view** — all 16,980 parcels on a Leaflet canvas, grouped into seven
layers taken from the source's own `LU_Class` field, over a street, satellite
or plain basemap. Every parcel is clickable and reports its class, category,
area in acres and km², and its class totals.

**Legend** — each `LU_Class` group expands to show its individual land uses,
every one independently checkable, so a single class (say, just "Katchi
Abadis") can be hidden without touching the rest of its group.

**Filters** — District, Local Govt, Land Use, and Category sit in one row
below the header, alongside a typo-tolerant search restricted to land use
classes. Local Govt stays disabled until a `data/local_govt.geojson` boundary
file is supplied (see below); nothing is fabricated in its place.

**Cross-filtering** — the share ribbon, the legend, the filters, the charts
and the table all drive the same state. Selecting a bar, a ribbon band, a
legend checkbox, or a table row updates the map and the statistics panel
together; picking a specific class also zooms the map to its extent.

**Statistics** — parcel counts, area in acres and km², share of district, average
and median parcel size, existing against proposed, and a fragmentation plot of
parcel count against average parcel size. The full classification table sorts on
every column and exports to CSV.

---

## Deploying to GitHub Pages

1. **Create a repository** on GitHub — `Hafizabad-Landuse-Dashboard` is a
   reasonable name. Leave it public; Pages requires a public repo on the free
   plan.

2. **Upload the contents of this folder** to the repository root — so
   `index.html` sits at the top level, not inside a subfolder. Either drag the
   files into GitHub's web uploader, or from a terminal:

   ```bash
   git init
   git add .
   git commit -m "Hafizabad land use dashboard"
   git branch -M main
   git remote add origin https://github.com/<your-username>/Hafizabad-Landuse-Dashboard.git
   git push -u origin main
   ```

3. **Turn on Pages** — repository **Settings → Pages → Build and deployment**.
   Set *Source* to **Deploy from a branch**, *Branch* to **main**, folder
   **/ (root)**. Save.

4. **Wait about a minute**, then open
   `https://<your-username>.github.io/Hafizabad-Landuse-Dashboard/`.

To add it to your existing `Punjab-Landuse-Plan` repository instead, copy this
folder in as a subdirectory — say `hafizabad/` — and it will publish at
`https://rabbii959.github.io/Punjab-Landuse-Plan/hafizabad/`. Nothing needs to
change: every path in the page is relative.

> **Opening `index.html` straight from your hard drive will not work.** The page
> loads its data with `fetch()`, which browsers block on `file://` URLs. To
> preview locally, run `python3 -m http.server 8000` in this folder and visit
> `http://localhost:8000`.

---

## Repository layout

```
index.html                     the dashboard
assets/css/style.css           styling
assets/js/app.js               map, filters, charts, table
data/stats.json                pre-computed statistics (60 KB)
data/lu_*.geojson              geometry, split into 8 thematic layers
tools/build_data.py            regenerates data/ from the source Esri JSON
tools/groups.json              which land use class belongs to which layer
.nojekyll                      serve files as-is
```

Total data payload is 7.3 MB, which GitHub Pages compresses to about 1.3 MB in
transit. Layers load in parallel and the page is usable before the last one
arrives.

---

## A note on the area and grouping figures

**Areas here are computed from the polygon geometry, not read from any
pre-computed area attribute** — the current source export doesn't carry one
at all. Each polygon's area is computed by spherical excess on the WGS 84
authalic radius, with interior rings subtracted so that holes are not
double-counted. The resulting total, **2,358.9 km²**, sits within 0.4% of
Hafizabad's gazetted area of 2,367 km² — which is the check that the method is
sound. Acres use the international definition, 4,046.8564224 m².

**The seven land-use groups shown in the legend — Residential, Commercial,
Industrial, Agriculture, Transportation Network, Notified Area, and Other
Uses — come from the source layer's own `LU_Class` field**, not an invented
scheme. One data-entry typo is corrected in processing: every "Orchard"
parcel carried `Agricuture` in that field rather than `Agriculture`; it's
folded into Agriculture rather than left as a stray class of one. `tools/groups.json`
is kept only as a fallback for older exports that ship `LU_Class` blank (the
very first Hafizabad file did); it has no effect once the source provides
real values.

Geometry is generalised for browser delivery with Douglas–Peucker at roughly a
5 metre tolerance, taking 536,288 vertices down to 249,490. **All 16,980 parcels
are retained** — sub-metre slivers that collapse at the standard 5-decimal
coordinate precision are re-encoded at finer precision rather than dropped, so
parcel counts reconcile exactly with the source. Areas and counts are computed
from full-resolution geometry *before* generalisation, so no published figure is
affected by it.

---

## Regenerating the data

Needs Python 3 and NumPy only.

```bash
SRC=Updatedjson3.json OUT=. python3 tools/build_data.py
```

`SRC` is the source Esri JSON feature set, `OUT` is the folder containing
`data/`. The script prints a reconciliation report — feature counts, total area,
bounding box, vertex reduction, per-file sizes, and the derived group list —
so any change to the source can be checked against the figures above. It also
warns if a future export ever assigns the same land use to more than one
`LU_Class` (this one doesn't).

To retune the *fallback* grouping used only when `LU_Class` is blank, edit
`tools/groups.json` and re-run.

---

## Source data

Hafizabad district land use plan, Esri JSON feature set, WGS 84 (EPSG:4326),
16,980 polygons across 60 land use classes grouped into 7 `LU_Class` categories,
attributed by land use, category (existing or proposed), and name where recorded.

Basemaps: OpenStreetMap, Esri World Imagery, CARTO. Libraries: Leaflet 1.9.4,
Chart.js 4.4.1, both from CDN.

---

Punjab Spatial Planning Authority — Local Government & Community Development
Department, Government of Punjab.
