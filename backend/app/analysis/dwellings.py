"""Per-dwelling (동·호) winter-solstice sunlight.

Each main building's main window wall (주개구부 벽면, default: the long wall facing most to the south) is split into
`units_per_floor` equal segments (given in the drawing, else estimated at ~10 m per unit). One receiver sits at the
window centre of each unit on each floor; 호 numbers run left to right as seen from outside (803 = 8층 3호).

Reference lines (winter solstice):
  - 연속: 09:00-15:00 continuous >= 2 h  (also the 영 86조③2호 단서 condition for all dwellings)
  - 총:   08:00-16:00 total >= 4 h
A dwelling "meets" the line when either holds (the line commonly applied in Korean sunlight disputes).

Limits: only the main window wall is evaluated (corner units' side windows are ignored); unit widths are equal.
"""
from __future__ import annotations

from datetime import datetime

import numpy as np

from ..scene.geometry import FLOOR_HEIGHT_M, WINDOW_CENTER_ABOVE_FLOOR_M, Receiver

CONT_WINDOW = ("09:00", "15:00")
CONT_MIN = 120.0
TOTAL_WINDOW = ("08:00", "16:00")
TOTAL_MIN = 240.0
UNIT_WIDTH_GUESS_M = 10.0
RULE = "동지 09~15시 연속 2시간 이상 또는 08~16시 총 4시간 이상"


def _hm(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def window_mask(times_local, window: tuple[str, str]) -> np.ndarray:
    lo, hi = _hm(window[0]), _hm(window[1])
    out = []
    for t in times_local:
        d = t if isinstance(t, datetime) else datetime.fromisoformat(t)
        m = d.hour * 60 + d.minute + d.second / 60
        out.append(lo <= m < hi)
    return np.array(out, dtype=bool)


def max_run(s: np.ndarray) -> np.ndarray:
    best = np.zeros(len(s), dtype=np.int32)
    run = np.zeros(len(s), dtype=np.int32)
    for t in range(s.shape[1]):
        run = (run + 1) * s[:, t]
        best = np.maximum(best, run)
    return best


def reference(sun: np.ndarray, times_local, dt_min: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """(meets_either, cont_min_09_15, total_min_08_16, meets_continuous)"""
    mc, mt = window_mask(times_local, CONT_WINDOW), window_mask(times_local, TOTAL_WINDOW)
    cont = max_run(sun[:, mc].astype(np.int8)) * dt_min if mc.any() else np.zeros(len(sun))
    tot = sun[:, mt].sum(axis=1) * dt_min
    return (cont >= CONT_MIN) | (tot >= TOTAL_MIN), cont, tot, cont >= CONT_MIN


def main_edge(ring: np.ndarray) -> int:
    from ..legal import default_facades
    return default_facades(ring)[1]


def make_dwellings(b, main_override: int | None = None) -> list[Receiver]:
    """b: ResolvedBuilding (MAIN). Receivers carry IDs '<동>-<호>'."""
    from ..legal import edges_of
    ring = np.asarray(b.footprint.exterior.coords)[:-1, :2]
    e = main_override if main_override is not None and 0 <= main_override < len(ring) else main_edge(ring)
    p0, p1, n, L = edges_of(ring)[e]
    if L < 3.0:
        return []
    units = int(getattr(b, "units_per_floor", None) or max(1, min(12, round(L / UNIT_WIDTH_GUESS_M))))
    right = np.array([-n[1], n[0]])  # viewer outside facing the wall: left -> right
    centres = [p0 + (p1 - p0) * ((k + 0.5) / units) for k in range(units)]
    centres.sort(key=lambda c: float(np.dot(c, right)))
    out = []
    for f in range(1, b.floors + 1):
        z = b.base_z + (f - 1) * FLOOR_HEIGHT_M + WINDOW_CENTER_ABOVE_FLOOR_M
        for k, c in enumerate(centres, start=1):
            ho = f"{f}{k:02d}"
            out.append(Receiver(receiver_id=f"{b.id}-{ho}", building_id=b.id, floor=f, edge=e, facade=f"U{k}",
                                position=(float(c[0]), float(c[1]), float(z)), normal=(float(n[0]), float(n[1]), 0.0), patch_w=L / units))
    return out


def compare_dwellings(ra, rb, times_local, dt_min: float, changed: set[str]) -> dict:
    """ra / rb: SunlightResult over dwelling receivers of A / B."""
    ok_a, cont_a, tot_a, c2_a = reference(ra.sun, times_local, dt_min)
    ok_b, cont_b, tot_b, c2_b = reference(rb.sun, times_local, dt_min)
    ia = {r: i for i, r in enumerate(ra.receiver_ids)}
    ib = {r: i for i, r in enumerate(rb.receiver_ids)}
    rows = []
    for rid in sorted(set(ia) | set(ib), key=lambda r: (r.split("-")[0], int(r.split("-")[1]))):
        i, j = ia.get(rid), ib.get(rid)
        bid, ho = rid.split("-")
        r = {"id": rid, "building_id": bid, "ho": ho, "floor": int(ho[:-2]), "unit": int(ho[-2:]), "changed_building": bid in changed,
             "cont_a": float(cont_a[i]) if i is not None else None, "total_a": float(tot_a[i]) if i is not None else None,
             "ok_a": bool(ok_a[i]) if i is not None else None,
             "cont_b": float(cont_b[j]) if j is not None else None, "total_b": float(tot_b[j]) if j is not None else None,
             "ok_b": bool(ok_b[j]) if j is not None else None, "cause_b": None}
        if j is not None:
            blk = rb.blocker[j][rb.sun[j] == 0]
            labs = [rb.labels[c] for c in blk if c >= 0]
            r["cause_b"] = max(set(labs), key=labs.count) if labs else None
        if i is None:
            r["status"] = "ONLY_B_OK" if r["ok_b"] else "ONLY_B_BELOW"
        elif j is None:
            r["status"] = "ONLY_A"
        elif r["ok_a"] and not r["ok_b"]:
            r["status"] = "NEWLY_BELOW"
        elif not r["ok_a"] and not r["ok_b"]:
            r["status"] = "STILL_BELOW"
        elif not r["ok_a"] and r["ok_b"]:
            r["status"] = "IMPROVED"
        else:
            r["status"] = "OK"
        rows.append(r)
    by_b: dict[str, dict] = {}
    for r in rows:
        g = by_b.setdefault(r["building_id"], {"building_id": r["building_id"], "changed_in_b": r["changed_building"], "n": 0,
                                                "counts": {}, "floors_b": 0, "units": 0, "newly_below": []})
        g["n"] += 1
        g["counts"][r["status"]] = g["counts"].get(r["status"], 0) + 1
        g["floors_b"] = max(g["floors_b"], r["floor"] if r["ok_b"] is not None else 0)
        g["units"] = max(g["units"], r["unit"])
        if r["status"] in ("NEWLY_BELOW", "ONLY_B_BELOW"):
            g["newly_below"].append(r["ho"])
    cnt = lambda s: sum(r["status"] == s for r in rows)  # noqa: E731
    in_b = [r for r in rows if r["ok_b"] is not None]
    return {
        "rule": RULE, "receiver": "주개구부 벽면 세대별 창 중심 (층 바닥 + 1.5 m)",
        "n_a": len(ia), "n_b": len(ib), "n_meet_a": int(ok_a.sum()), "n_meet_b": int(ok_b.sum()),
        "n_newly_below": cnt("NEWLY_BELOW"), "n_still_below": cnt("STILL_BELOW"), "n_improved": cnt("IMPROVED"),
        "n_only_b_below": cnt("ONLY_B_BELOW"), "n_only_a": cnt("ONLY_A"),
        "n_newly_below_unchanged_buildings": sum(r["status"] == "NEWLY_BELOW" and not r["changed_building"] for r in rows),
        "all_b_continuous_2h": bool(len(in_b) and all(r["cont_b"] >= CONT_MIN for r in in_b)),
        "n_b_without_continuous_2h": sum(r["cont_b"] < CONT_MIN for r in in_b),
        "by_building": sorted(by_b.values(), key=lambda g: g["building_id"]),
        "rows": rows,
    }
