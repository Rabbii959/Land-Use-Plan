#!/usr/bin/env python3
"""
Punjab administrative boundaries -> web-ready GeoJSON for the District and
Local Govt filters (dropdown population + zoom-to-selection + outline).

Unlike build_data.py (parcel processing, rerun per district), this only
needs to run once — the boundary files are province-wide regardless of
which district's land-use parcels are currently loaded.
"""
import json, os, collections
import numpy as np

SRC_DISTRICTS = os.environ["SRC_DISTRICTS"]
SRC_LOCAL_GOVTS = os.environ["SRC_LOCAL_GOVTS"]
OUT = os.environ.get("OUT", ".")
# Coarser than the parcel tolerance (0.00005) — these are province-overview
# administrative outlines, not cadastral-precision parcel edges.
TOL = 0.001


def planar_signed_area(ring):
    a = np.asarray(ring, dtype=np.float64)
    if len(a) < 4:
        return 0.0
    x, y = a[:, 0], a[:, 1]
    return 0.5 * np.sum(x[:-1] * y[1:] - x[1:] * y[:-1])


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


def dedupe(ring):
    out = [ring[0]]
    for p in ring[1:]:
        if p != out[-1]:
            out.append(p)
    if out[0] != out[-1]:
        out.append(out[0])
    return out


def rings_to_multipolygon(rings, dp=5):
    polys, cur = [], None
    for r in rings:
        s = simplify(r, TOL)
        q = [[round(float(x), dp), round(float(y), dp)] for x, y in s]
        q = dedupe(q)
        if len(q) < 4:
            for finer_dp in (6, 7):
                q = dedupe([[round(float(x), finer_dp), round(float(y), finer_dp)] for x, y in r])
                if len(q) >= 4:
                    break
        if len(q) < 4:
            continue
        outer = planar_signed_area(r) < 0
        if outer or cur is None:
            cur = [q]
            polys.append(cur)
        else:
            cur.append(q)
    return polys


def main():
    os.makedirs(f"{OUT}/data", exist_ok=True)

    districts_src = json.load(open(SRC_DISTRICTS))
    lg_src = json.load(open(SRC_LOCAL_GOVTS))

    v_before = v_after = 0
    district_names = set()

    district_feats = []
    for f in districts_src["features"]:
        name = (f["attributes"].get("District") or "").strip()
        rings = f.get("geometry", {}).get("rings") or []
        if not name or not rings:
            continue
        v_before += sum(len(r) for r in rings)
        polys = rings_to_multipolygon(rings)
        v_after += sum(len(ring) for poly in polys for ring in poly)
        if not polys:
            continue
        district_names.add(name)
        district_feats.append({
            "type": "Feature",
            "properties": {"name": name},
            "geometry": {"type": "MultiPolygon", "coordinates": polys},
        })

    lg_feats = []
    lg_by_district = collections.Counter()
    for f in lg_src["features"]:
        name = (f["attributes"].get("Local_govt") or "").strip()
        district = (f["attributes"].get("District") or "").strip()
        rings = f.get("geometry", {}).get("rings") or []
        if not name or not rings:
            continue
        v_before += sum(len(r) for r in rings)
        polys = rings_to_multipolygon(rings)
        v_after += sum(len(ring) for poly in polys for ring in poly)
        if not polys:
            continue
        lg_by_district[district] += 1
        lg_feats.append({
            "type": "Feature",
            "properties": {"name": name, "district": district},
            "geometry": {"type": "MultiPolygon", "coordinates": polys},
        })

    with open(f"{OUT}/data/districts.geojson", "w") as fh:
        json.dump({"type": "FeatureCollection", "features": district_feats},
                  fh, separators=(",", ":"))
    with open(f"{OUT}/data/local_govts.geojson", "w") as fh:
        json.dump({"type": "FeatureCollection", "features": lg_feats},
                  fh, separators=(",", ":"))

    orphan_lg_districts = set(lg_by_district) - district_names
    d_kb = os.path.getsize(f"{OUT}/data/districts.geojson") / 1024
    l_kb = os.path.getsize(f"{OUT}/data/local_govts.geojson") / 1024

    print(f"districts        : {len(district_feats)} written ({d_kb:,.0f} KB)")
    print(f"local governments : {len(lg_feats)} written ({l_kb:,.0f} KB), "
          f"across {len(lg_by_district)} districts")
    print(f"vertices          : {v_before:,} -> {v_after:,} "
          f"({100 * v_after / v_before:.1f}%)")
    if orphan_lg_districts:
        print(f"** WARNING: Local Govt records reference districts not in "
              f"the district file: {sorted(orphan_lg_districts)} **")
    print("\nlocal govt units per district (min/max):",
          min(lg_by_district.values()), "/", max(lg_by_district.values()))


if __name__ == "__main__":
    main()
