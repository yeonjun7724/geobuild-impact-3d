"""Analysis A - geometric direct-sun availability at facade proxy receivers.

direct_sun(r, t) = 1  iff  sun elevation > 0  AND  n·s > 0  AND  ray(p + eps·n, s) hits nothing.
This is *geometric possible direct sunlight time*, not irradiance, illuminance or weather-adjusted sunshine.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .raycast import INVALID, self_offset
from .solar import SunSeries

SIGNIFICANT_LOSS_MIN = 60.0  # review-priority threshold of this PoC (not a legal criterion)

# blocker codes stored in the blocker matrix
NO_BLOCK = -1
BELOW_HORIZON = -2
BACK_FACING = -3


@dataclass
class SunlightResult:
    receiver_ids: list[str]
    building_ids: list[str]
    floors: np.ndarray
    facades: list[str]
    positions: np.ndarray  # (R,3)
    normals: np.ndarray
    sun: np.ndarray  # (R,T) bool
    blocker: np.ndarray  # (R,T) int: label index | NO_BLOCK | BELOW_HORIZON | BACK_FACING
    labels: list[str]
    dt_min: float
    offset_m: float
    rays_cast: int

    @property
    def total_min(self) -> np.ndarray:
        return self.sun.sum(axis=1) * self.dt_min

    @property
    def max_continuous_min(self) -> np.ndarray:
        s = self.sun.astype(np.int8)
        best = np.zeros(len(s), dtype=np.int32)
        run = np.zeros(len(s), dtype=np.int32)
        for t in range(s.shape[1]):
            run = (run + 1) * s[:, t]
            best = np.maximum(best, run)
        return best * self.dt_min


def compute_sunlight(scene, sun: SunSeries, receivers=None) -> SunlightResult:
    recs = receivers if receivers is not None else scene.receivers
    R, T = len(recs), len(sun.vectors)
    P = np.array([r.position for r in recs], dtype=np.float64).reshape(R, 3)
    N = np.array([r.normal for r in recs], dtype=np.float64).reshape(R, 3)
    eps = self_offset(scene.extent_m)
    S = sun.vectors  # (T,3)
    above = sun.elevation_deg > 0
    facing = (N @ S.T) > 1e-9  # (R,T)
    blocker = np.full((R, T), NO_BLOCK, dtype=np.int32)
    blocker[:, ~above] = BELOW_HORIZON
    blocker[(~facing) & above[None, :]] = BACK_FACING
    todo = facing & above[None, :]
    ri, ti = np.nonzero(todo)
    origins = P[ri] + N[ri] * eps
    dirs = S[ti]
    _, lab = scene.engine.first_hit(origins, dirs)
    hit = lab != INVALID
    blocker[ri[hit], ti[hit]] = lab[hit]
    sunm = blocker == NO_BLOCK
    return SunlightResult(
        receiver_ids=[r.receiver_id for r in recs],
        building_ids=[r.building_id for r in recs],
        floors=np.array([r.floor for r in recs], dtype=np.int32),
        facades=[r.facade for r in recs],
        positions=P,
        normals=N,
        sun=sunm,
        blocker=blocker,
        labels=list(scene.engine.labels),
        dt_min=sun.dt_min,
        offset_m=eps,
        rays_cast=int(len(ri)),
    )


def compare_sunlight(a: SunlightResult, b: SunlightResult, changed_buildings: set[str], top_n: int = 20) -> dict:
    """Match receivers by ID. Receivers present in only one scenario are reported, never compared."""
    ia = {rid: i for i, rid in enumerate(a.receiver_ids)}
    ib = {rid: i for i, rid in enumerate(b.receiver_ids)}
    common = [rid for rid in a.receiver_ids if rid in ib]
    only_a = [rid for rid in a.receiver_ids if rid not in ib]
    only_b = [rid for rid in b.receiver_ids if rid not in ia]
    xa = np.array([ia[r] for r in common], dtype=np.int64)
    xb = np.array([ib[r] for r in common], dtype=np.int64)
    tot_a, tot_b = a.total_min[xa], b.total_min[xb]
    mc_a, mc_b = a.max_continuous_min[xa], b.max_continuous_min[xb]
    d_tot = tot_b - tot_a
    d_mc = mc_b - mc_a
    rows = []
    for k, rid in enumerate(common):
        i, j = xa[k], xb[k]
        lost = a.sun[i] & ~b.sun[j]
        causes = b.blocker[j][lost]
        cause_ids = [b.labels[c] for c in causes if c >= 0]
        cause = max(set(cause_ids), key=cause_ids.count) if cause_ids else None
        bid = a.building_ids[i]
        rows.append({
            "receiver_id": rid,
            "building_id": bid,
            "floor": int(a.floors[i]),
            "facade": a.facades[i],
            "x_a": round(float(a.positions[i, 0]), 3), "y_a": round(float(a.positions[i, 1]), 3), "z_a": round(float(a.positions[i, 2]), 3),
            "x_b": round(float(b.positions[j, 0]), 3), "y_b": round(float(b.positions[j, 1]), 3), "z_b": round(float(b.positions[j, 2]), 3),
            "nx_a": round(float(a.normals[i, 0]), 5), "ny_a": round(float(a.normals[i, 1]), 5),
            "nx_b": round(float(b.normals[j, 0]), 5), "ny_b": round(float(b.normals[j, 1]), 5),
            "sun_total_min_a": float(tot_a[k]), "sun_total_min_b": float(tot_b[k]), "delta_total_min": float(d_tot[k]),
            "max_cont_min_a": float(mc_a[k]), "max_cont_min_b": float(mc_b[k]), "delta_max_cont_min": float(d_mc[k]),
            "lost_intervals": int(lost.sum()), "gained_intervals": int((~a.sun[i] & b.sun[j]).sum()),
            "main_cause_b": cause,
            "impact_type": "SELF_MODIFIED" if bid in changed_buildings else "OTHER_BUILDING",
            "coverage_flag": "MODELLED_OBSTRUCTIONS_ONLY",
        })
    dec = d_tot < 0
    inc = d_tot > 0
    same = d_tot == 0
    order = np.argsort(d_tot, kind="stable")
    worst = [rows[i] for i in order[:top_n] if d_tot[i] < 0]
    # per building / floor aggregates
    per_bf: dict[tuple[str, int], list[int]] = {}
    for k, r in enumerate(rows):
        per_bf.setdefault((r["building_id"], r["floor"]), []).append(k)
    floor_rows = []
    for (bid, fl), ks in sorted(per_bf.items()):
        ks_ = np.array(ks)
        floor_rows.append({
            "building_id": bid, "floor": fl, "n_receivers": len(ks),
            "mean_total_min_a": round(float(tot_a[ks_].mean()), 2), "mean_total_min_b": round(float(tot_b[ks_].mean()), 2),
            "mean_delta_min": round(float(d_tot[ks_].mean()), 2), "min_delta_min": float(d_tot[ks_].min()),
            "n_decreased": int(dec[ks_].sum()),
        })
    per_b: dict[str, list[int]] = {}
    for k, r in enumerate(rows):
        per_b.setdefault(r["building_id"], []).append(k)
    bld_rows = []
    for bid, ks in sorted(per_b.items()):
        ks_ = np.array(ks)
        bld_rows.append({
            "building_id": bid, "n_receivers": len(ks), "changed_in_b": bid in changed_buildings,
            "mean_total_min_a": round(float(tot_a[ks_].mean()), 2), "mean_total_min_b": round(float(tot_b[ks_].mean()), 2),
            "mean_delta_min": round(float(d_tot[ks_].mean()), 2), "min_delta_min": float(d_tot[ks_].min()),
            "max_delta_min": float(d_tot[ks_].max()),
            "n_decreased": int(dec[ks_].sum()), "n_increased": int(inc[ks_].sum()), "n_unchanged": int(same[ks_].sum()),
            "n_zero_sun_a": int((tot_a[ks_] == 0).sum()), "n_zero_sun_b": int((tot_b[ks_] == 0).sum()),
        })
    worst_floor = min(floor_rows, key=lambda r: r["mean_delta_min"]) if floor_rows else None
    # all receivers losing >= SIGNIFICANT_LOSS_MIN, grouped by building (review-priority input, not a legal criterion)
    sig: dict[str, dict] = {}
    for r in rows:
        if r["delta_total_min"] <= -SIGNIFICANT_LOSS_MIN or (r["sun_total_min_b"] == 0 < r["sun_total_min_a"]):
            g = sig.setdefault(r["building_id"], {"building_id": r["building_id"], "n_loss_ge_threshold": 0, "n_to_zero": 0,
                                                  "floors": set(), "facades": set(), "causes": {}, "min_delta_min": 0.0})
            if r["delta_total_min"] <= -SIGNIFICANT_LOSS_MIN:
                g["n_loss_ge_threshold"] += 1
            if r["sun_total_min_b"] == 0 < r["sun_total_min_a"]:
                g["n_to_zero"] += 1
            g["floors"].add(r["floor"])
            g["facades"].add(r["facade"])
            g["min_delta_min"] = min(g["min_delta_min"], r["delta_total_min"])
            if r["main_cause_b"]:
                g["causes"][r["main_cause_b"]] = g["causes"].get(r["main_cause_b"], 0) + 1
    significant = [{**g, "floors": [min(g["floors"]), max(g["floors"])], "facades": sorted(g["facades"]),
                    "causes": dict(sorted(g["causes"].items(), key=lambda kv: -kv[1]))} for g in sig.values()]
    significant.sort(key=lambda g: g["min_delta_min"])
    cause_counts: dict[str, int] = {}
    for r in rows:
        if r["delta_total_min"] < 0 and r["main_cause_b"]:
            cause_counts[r["main_cause_b"]] = cause_counts.get(r["main_cause_b"], 0) + 1
    other = np.array([r["impact_type"] == "OTHER_BUILDING" for r in rows], dtype=bool)
    return {
        "n_common": len(common),
        "n_only_a": len(only_a),
        "n_only_b": len(only_b),
        "only_a_ids": only_a[:200],
        "only_b_ids": only_b[:200],
        "n_decreased": int(dec.sum()),
        "n_increased": int(inc.sum()),
        "n_unchanged": int(same.sum()),
        "n_decreased_other_buildings": int((dec & other).sum()),
        "n_decreased_self_modified": int((dec & ~other).sum()),
        "delta_total_min_min": float(d_tot.min()) if len(d_tot) else 0.0,
        "delta_total_min_max": float(d_tot.max()) if len(d_tot) else 0.0,
        "delta_total_min_mean": round(float(d_tot.mean()), 3) if len(d_tot) else 0.0,
        "delta_max_cont_min_min": float(d_mc.min()) if len(d_mc) else 0.0,
        "delta_max_cont_min_max": float(d_mc.max()) if len(d_mc) else 0.0,
        "mean_total_min_a": round(float(tot_a.mean()), 3) if len(tot_a) else 0.0,
        "mean_total_min_b": round(float(tot_b.mean()), 3) if len(tot_b) else 0.0,
        "worst_receivers": worst,
        "worst_floor": worst_floor,
        "significant_loss_threshold_min": SIGNIFICANT_LOSS_MIN,
        "significant_loss": significant,
        "cause_counts": dict(sorted(cause_counts.items(), key=lambda kv: -kv[1])),
        "per_building": bld_rows,
        "per_floor": floor_rows,
        "rows": rows,
    }
