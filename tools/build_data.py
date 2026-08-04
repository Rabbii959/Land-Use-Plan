#!/usr/bin/env python3
"""
Hafizabad Land Use Plan — Esri JSON -> web-ready GeoJSON + statistics.

- Computes true geodesic (spherical-excess) area per polygon, holes subtracted.
- Converts Esri rings -> GeoJSON MultiPolygon (CW = outer, CCW = hole).
- Douglas-Peucker simplification + coordinate quantisation for web delivery.
"""
import json, math, os, collections
import numpy as np

SRC = os.environ.get("SRC", "Hafizabad.json")
OUT = os.environ.get("OUT", ".")
R = 6371007.181           # WGS84 authalic radius (m)
SQM_PER_ACRE = 4046.8564224
TOL = 0.00005             # ~5.5 m simplification tolerance (degrees)
DP = 5                    # coordinate decimal places (~1.1 m)


# ---------------------------------------------------------------- geodesy
def ring_signed_area(ring):
    """Signed geodesic area (m^2). CCW positive, CW negative."""
    a = np.asarray(ring, dtype=np.float64)
    if len(a) < 4:
        return 0.0
    lon = np.radians(a[:, 0])
    lat = np.radians(a[:, 1])
    dlon = lon[1:] - lon[:-1]
    # wrap guard (not needed at this longitude range, kept for safety)
    dlon = (dlon + np.pi) % (2 * np.pi) - np.pi
    s = np.sum(dlon * (np.sin(lat[:-1]) + np.sin(lat[1:])))
    return s * R * R / 2.0


def planar_signed_area(ring):
    """Shoelace in degrees — used only to decide ring orientation."""
    a = np.asarray(ring, dtype=np.float64)
    if len(a) < 4:
        return 0.0
    x, y = a[:, 0], a[:, 1]
    return 0.5 * np.sum(x[:-1] * y[1:] - x[1:] * y[:-1])


# ---------------------------------------------------- Douglas-Peucker (iterative)
def simplify(ring, tol):
    pts = np.asarray(ring, dtype=np.float64)
    n = len(pts)
    if n <= 5:
        return pts
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        seg = pts[i + 1:j]
        p0, p1 = pts[i], pts[j]
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        L2 = dx * dx + dy * dy
        if L2 == 0:
            d = np.hypot(seg[:, 0] - p0[0], seg[:, 1] - p0[1])
        else:
            t = ((seg[:, 0] - p0[0]) * dx + (seg[:, 1] - p0[1]) * dy) / L2
            t = np.clip(t, 0.0, 1.0)
            px = p0[0] + t * dx
            py = p0[1] + t * dy
            d = np.hypot(seg[:, 0] - px, seg[:, 1] - py)
        k = int(np.argmax(d))
        if d[k] > tol:
            idx = i + 1 + k
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    out = pts[keep]
    return out if len(out) >= 4 else pts


def quantise(ring, dp=DP):
    return [[round(float(x), dp), round(float(y), dp)] for x, y in ring]


def dedupe(ring):
    """Drop consecutive duplicates created by rounding; keep ring closed."""
    out = [ring[0]]
    for p in ring[1:]:
        if p != out[-1]:
            out.append(p)
    if out[0] != out[-1]:
        out.append(out[0])
    return out


# ---------------------------------------------------------------- main
def main():
    os.makedirs(f"{OUT}/data", exist_ok=True)
    src = json.load(open(SRC))
    feats = src["features"]

    stats = collections.defaultdict(
        lambda: {"count": 0, "area_m2": 0.0, "category": "", "vertices": 0}
    )
    cat_stats = collections.defaultdict(lambda: {"count": 0, "area_m2": 0.0})
    named = []
    out_feats = []
    minx, miny = 1e9, 1e9
    maxx, maxy = -1e9, -1e9
    v_before = v_after = 0

    for f in feats:
        att = f["attributes"]
        rings = f.get("geometry", {}).get("rings") or []
        if not rings:
            continue

        lu = (att.get("Landuse") or "").strip() or "Unclassified"
        cat = (att.get("Category") or "").strip() or "Unspecified"
        name = (att.get("Name") or "").strip()

        # --- true area, holes subtracted
        area = 0.0
        for r in rings:
            area += ring_signed_area(r)
        area = abs(area)

        # --- rings -> MultiPolygon, simplified
        polys, cur = [], None
        cx_acc = cy_acc = w_acc = 0.0
        for r in rings:
            v_before += len(r)
            s = simplify(r, TOL)
            q = dedupe(quantise(s))
            # Rounding can collapse a sub-metre sliver. Retry at finer
            # precision rather than dropping the feature, so counts
            # reconcile exactly with the source layer.
            if len(q) < 4:
                for dp in (6, 7, 8):
                    q = dedupe(quantise(r, dp))
                    if len(q) >= 4:
                        break
            v_after += len(q)
            if len(q) < 4:
                continue
            arr = np.asarray(q)
            minx = min(minx, arr[:, 0].min()); maxx = max(maxx, arr[:, 0].max())
            miny = min(miny, arr[:, 1].min()); maxy = max(maxy, arr[:, 1].max())

            outer = planar_signed_area(r) < 0          # Esri: CW ring = outer
            if outer or cur is None:
                cur = [q]
                polys.append(cur)
                pa = abs(planar_signed_area(q))
                if pa > 0:
                    cx_acc += arr[:-1, 0].mean() * pa
                    cy_acc += arr[:-1, 1].mean() * pa
                    w_acc += pa
            else:
                cur.append(q)

        if not polys:
            continue

        s = stats[lu]
        s["count"] += 1
        s["area_m2"] += area
        s["category"] = cat
        c = cat_stats[cat]
        c["count"] += 1
        c["area_m2"] += area

        props = {"lu": lu, "ct": cat, "a": round(area / SQM_PER_ACRE, 3)}
        if name:
            props["nm"] = name
            if w_acc > 0:
                named.append({
                    "name": name, "lu": lu, "cat": cat,
                    "acres": round(area / SQM_PER_ACRE, 3),
                    "lon": round(cx_acc / w_acc, 5),
                    "lat": round(cy_acc / w_acc, 5),
                })

        out_feats.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "MultiPolygon", "coordinates": polys},
        })

    # ------------------------------------------------ write geometry files
    # Split by land-use class into thematic groups so the map streams in.
    here = os.path.dirname(os.path.abspath(__file__))
    groups = json.load(open(os.path.join(here, "groups.json")))
    lu2grp = {}
    for g, classes in groups.items():
        for c in classes:
            lu2grp[c] = g

    buckets = collections.defaultdict(list)
    for ft in out_feats:
        buckets[lu2grp.get(ft["properties"]["lu"], "other")].append(ft)

    manifest = []
    for g, fts in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
        path = f"{OUT}/data/lu_{g}.geojson"
        with open(path, "w") as fh:
            json.dump({"type": "FeatureCollection", "features": fts},
                      fh, separators=(",", ":"))
        manifest.append({
            "group": g, "file": f"data/lu_{g}.geojson",
            "features": len(fts),
            "kb": round(os.path.getsize(path) / 1024),
        })

    # ------------------------------------------------ stats file
    total_area = sum(v["area_m2"] for v in stats.values())
    classes = sorted(
        ({"lu": k,
          "category": v["category"],
          "count": v["count"],
          "acres": round(v["area_m2"] / SQM_PER_ACRE, 3),
          "sqkm": round(v["area_m2"] / 1e6, 5),
          "pct": round(100 * v["area_m2"] / total_area, 4) if total_area else 0,
          "group": lu2grp.get(k, "other")}
         for k, v in stats.items()),
        key=lambda d: -d["acres"])

    payload = {
        "district": "Hafizabad",
        "province": "Punjab",
        "generated": "2026",
        "totals": {
            "features": len(out_feats),
            "classes": len(stats),
            "acres": round(total_area / SQM_PER_ACRE, 2),
            "sqkm": round(total_area / 1e6, 3),
        },
        "bbox": [round(minx, 5), round(miny, 5), round(maxx, 5), round(maxy, 5)],
        "categories": [
            {"name": k, "count": v["count"],
             "acres": round(v["area_m2"] / SQM_PER_ACRE, 2),
             "pct": round(100 * v["area_m2"] / total_area, 3) if total_area else 0}
            for k, v in sorted(cat_stats.items(), key=lambda kv: -kv[1]["area_m2"])
        ],
        "classes": classes,
        "groups": groups,
        "manifest": manifest,
        "named_sites": sorted(named, key=lambda d: -d["acres"])[:400],
    }
    with open(f"{OUT}/data/stats.json", "w") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    # ------------------------------------------------ report
    print(f"features out : {len(out_feats):,}")
    print(f"classes      : {len(stats)}")
    print(f"total area   : {total_area/SQM_PER_ACRE:,.0f} acres "
          f"({total_area/1e6:,.1f} km2)")
    print(f"bbox         : {minx:.4f},{miny:.4f} -> {maxx:.4f},{maxy:.4f}")
    print(f"vertices     : {v_before:,} -> {v_after:,} "
          f"({100*v_after/v_before:.1f}%)")
    print("\nfiles:")
    for m in manifest:
        print(f"  {m['file']:34s} {m['features']:6,} feats  {m['kb']:6,} KB")
    print(f"  data/stats.json{'':20s}"
          f"{os.path.getsize(OUT+'/data/stats.json')/1024:9,.0f} KB")
    print("\ntop classes by area:")
    for c in classes[:12]:
        print(f"  {c['lu']:36s} {c['count']:5,}  {c['acres']:12,.1f} ac  {c['pct']:6.2f}%")


if __name__ == "__main__":
    main()
