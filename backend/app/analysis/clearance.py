"""Analysis C - horizontal clearance between building footprints (local ENU metres).

* Pairwise shortest horizontal distance (Shapely distance) + nearest points.
* Touching / overlapping footprints -> distance 0 with an explicit CONTACT/OVERLAP flag (never negative).
* Facade-normal distance: from the midpoint of each facade edge along its outward normal to the first
  other footprint boundary; 'NO_INTERSECTION' when nothing is crossed within the search range.
* Legal compliance (건축법 제61조, 시행령 제86조) is NOT evaluated.
"""
from __future__ import annotations

import itertools

import numpy as np
from shapely.geometry import LineString, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import nearest_points

from ..scene.geometry import facade_label

NORMAL_SEARCH_M = 500.0


def pair_distance(a: Polygon, b: Polygon) -> dict:
    inter = a.intersection(b)
    if a.intersects(b):
        status = "OVERLAP" if inter.area > 1e-6 else "CONTACT"
        p = inter.representative_point()
        return {"distance_m": 0.0, "status": status, "overlap_area_m2": round(inter.area, 3),
                "p_a": [p.x, p.y], "p_b": [p.x, p.y]}
    pa, pb = nearest_points(a, b)
    return {"distance_m": float(a.distance(b)), "status": "SEPARATED", "overlap_area_m2": 0.0,
            "p_a": [pa.x, pa.y], "p_b": [pb.x, pb.y]}


def pairwise(buildings, kinds=("MAIN",)) -> list[dict]:
    sel = [b for b in buildings if b.kind in kinds]
    out = []
    for a, b in itertools.combinations(sel, 2):
        d = pair_distance(a.footprint, b.footprint)
        out.append({"pair_id": f"{a.id}|{b.id}", "a": a.id, "b": b.id, **d})
    return out


def facade_normal_distances(buildings, kinds=("MAIN",)) -> list[dict]:
    sel = [b for b in buildings if b.kind in kinds]
    others_all = [b for b in buildings]
    out = []
    for b in sel:
        pb = orient(b.footprint_baseline, 1.0)
        pc = orient(b.footprint, 1.0)
        rb = np.asarray(pb.exterior.coords)[:-1]
        rc = np.asarray(pc.exterior.coords)[:-1]
        for e in range(len(rc)):
            a0, a1 = rc[e], rc[(e + 1) % len(rc)]
            L = float(np.hypot(*(a1 - a0)))
            if L < 2.0:
                continue
            t = (a1 - a0) / L
            n = np.array([t[1], -t[0]])
            tb = (rb[(e + 1) % len(rb)] - rb[e])
            lab = facade_label(tb[1], -tb[0])
            mid = (a0 + a1) / 2
            start = mid + n * 1e-3
            ray = LineString([start, start + n * NORMAL_SEARCH_M])
            best = None
            for o in others_all:
                if o.id == b.id:
                    continue
                inter = ray.intersection(o.footprint.boundary)
                if inter.is_empty:
                    continue
                pts = [inter] if inter.geom_type == "Point" else list(getattr(inter, "geoms", []))
                for p in pts:
                    if p.geom_type != "Point":
                        continue
                    d = float(np.hypot(p.x - mid[0], p.y - mid[1]))
                    if best is None or d < best[0]:
                        best = (d, o.id, [p.x, p.y])
            out.append({
                "facade_id": f"{b.id}-{lab}{e}", "building_id": b.id, "facade": lab, "edge": e,
                "origin": [float(mid[0]), float(mid[1])], "normal": [float(n[0]), float(n[1])],
                "distance_m": None if best is None else round(best[0], 3),
                "target_id": None if best is None else best[1],
                "hit": None if best is None else best[2],
                "status": "NO_INTERSECTION" if best is None else "HIT",
            })
    return out


def boundary_distances(buildings, site_boundary: Polygon | None) -> list[dict]:
    if site_boundary is None:
        return []
    out = []
    ring = site_boundary.exterior
    for b in buildings:
        if b.kind != "MAIN":
            continue
        inside = site_boundary.contains(b.footprint)
        pa, pb = nearest_points(b.footprint.exterior, ring)
        out.append({"building_id": b.id, "distance_m": round(float(b.footprint.exterior.distance(ring)), 3),
                    "inside_boundary": bool(inside), "p_a": [pa.x, pa.y], "p_b": [pb.x, pb.y]})
    return out


def compare_clearance(a_pairs, b_pairs, a_normals, b_normals, a_bound, b_bound, top_n: int = 10) -> dict:
    ib = {p["pair_id"]: p for p in b_pairs}
    rows = []
    for p in a_pairs:
        q = ib.get(p["pair_id"])
        if q is None:
            continue
        rows.append({
            "pair_id": p["pair_id"], "a": p["a"], "b": p["b"],
            "distance_a_m": round(p["distance_m"], 3), "distance_b_m": round(q["distance_m"], 3),
            "delta_m": round(q["distance_m"] - p["distance_m"], 3),
            "status_a": p["status"], "status_b": q["status"],
            "p_a_A": p["p_a"], "p_b_A": p["p_b"], "p_a_B": q["p_a"], "p_b_B": q["p_b"],
        })
    worsened = sorted([r for r in rows if r["delta_m"] < -1e-9], key=lambda r: r["delta_m"])[:top_n]
    nb = {f["facade_id"]: f for f in b_normals}
    nrows = []
    for f in a_normals:
        g = nb.get(f["facade_id"])
        if g is None:
            continue
        da, db = f["distance_m"], g["distance_m"]
        nrows.append({
            "facade_id": f["facade_id"], "building_id": f["building_id"], "facade": f["facade"],
            "distance_a_m": da, "target_a": f["target_id"], "distance_b_m": db, "target_b": g["target_id"],
            "delta_m": None if (da is None or db is None) else round(db - da, 3),
            "status_a": f["status"], "status_b": g["status"],
        })
    bb = {r["building_id"]: r for r in b_bound}
    brows = [{"building_id": r["building_id"], "distance_a_m": r["distance_m"], "distance_b_m": bb[r["building_id"]]["distance_m"],
              "delta_m": round(bb[r["building_id"]]["distance_m"] - r["distance_m"], 3),
              "inside_a": r["inside_boundary"], "inside_b": bb[r["building_id"]]["inside_boundary"]}
             for r in a_bound if r["building_id"] in bb]
    mins_a = min(rows, key=lambda r: r["distance_a_m"]) if rows else None
    mins_b = min(rows, key=lambda r: r["distance_b_m"]) if rows else None
    return {
        "n_pairs": len(rows),
        "min_pair_a": mins_a and {"pair_id": mins_a["pair_id"], "distance_m": mins_a["distance_a_m"]},
        "min_pair_b": mins_b and {"pair_id": mins_b["pair_id"], "distance_m": mins_b["distance_b_m"]},
        "n_worsened": int(sum(r["delta_m"] < -1e-9 for r in rows)),
        "n_improved": int(sum(r["delta_m"] > 1e-9 for r in rows)),
        "n_contact_or_overlap_b": int(sum(r["status_b"] != "SEPARATED" for r in rows)),
        "worsened_top": worsened,
        "pairs": rows,
        "facade_normals": nrows,
        "boundary": brows,
        "legal_note": "건축법 제61조·시행령 제86조 등 법정 이격 적합성은 판정하지 않음 (참고 검토항목).",
    }
