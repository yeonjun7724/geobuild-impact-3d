"""Fast, coarse impact preview for interactive editing (not persisted, never used in reports).

Same engine and rules as the full analysis but coarser sampling: 30-minute intervals for A, a 4 m grid at three
instants for B, footprint distances for C. Typically < 1 s for the demo complex; the UI labels it as an
approximation and the authoritative numbers come only from an analysis run.
"""
from __future__ import annotations

import time
from datetime import date

import numpy as np

from .analysis import clearance as C
from .analysis.shadow import compute_shadow, make_grid
from .analysis.solar import instants, sample_window
from .analysis.sunlight import compare_sunlight, compute_sunlight
from .scene.builder import build_scene, resolve_scenario

PREVIEW_RULE = "미리보기 근사: A 30분 간격 · B 4 m 격자 3개 시각(09·12·15시) · C 수평 최단거리 (확정 수치는 분석 실행)"


def quick_preview(site: dict, ground, transforms_b: dict, day: date, lat: float, lon: float) -> dict:
    t0 = time.time()
    gmesh = ground.mesh()
    A = resolve_scenario(site, {}, ground)
    B = resolve_scenario(site, transforms_b, ground)
    changed = {k for k, v in transforms_b.items() if any(v.get(x) for x in ("dx", "dy", "rot_deg", "floors_delta"))}
    sA, sB = build_scene(A, ground, ground_mesh=gmesh), build_scene(B, ground, ground_mesh=gmesh)
    sun = sample_window(day, "08:00", "16:00", 30, lat, lon)
    ca = compare_sunlight(compute_sunlight(sA, sun), compute_sunlight(sB, sun), changed, top_n=5)
    cc = C.compare_clearance(C.pairwise(A), C.pairwise(B), [], [], [], [], top_n=5)
    snaps = instants(day, ["09:00", "12:00", "15:00"], lat, lon)
    grid = make_grid(gmesh, tuple(site["site_rect"]), 4.0, [b.footprint for b in A + B])
    sha, shb = compute_shadow(sA, grid, snaps), compute_shadow(sB, grid, snaps)
    shadow = []
    for k, tl in enumerate(snaps.times_local):
        a, b = sha.shade[:, k], shb.shade[:, k]
        shadow.append({"time": tl.strftime("%H:%M"), "new_shade_m2": float((~a & b).sum() * grid.cell_area),
                       "relieved_m2": float((a & ~b).sum() * grid.cell_area)})
    per_b = {r["building_id"]: r["mean_delta_min"] for r in ca["per_building"]}
    return {
        "rule": PREVIEW_RULE,
        "elapsed_s": round(time.time() - t0, 3),
        "changed": sorted(changed),
        "A": {"n_decreased": ca["n_decreased"], "n_increased": ca["n_increased"], "n_common": ca["n_common"],
              "mean_total_min_a": ca["mean_total_min_a"], "mean_total_min_b": ca["mean_total_min_b"],
              "delta_total_min_min": ca["delta_total_min_min"],
              "worst": ca["worst_receivers"][0]["receiver_id"] if ca["worst_receivers"] else None,
              "per_building_mean_delta": per_b},
        "B": {"snapshots": shadow, "max_new_shade_m2": max(s["new_shade_m2"] for s in shadow)},
        "C": {"min_pair_a": cc["min_pair_a"], "min_pair_b": cc["min_pair_b"], "n_worsened": cc["n_worsened"],
              "worst": cc["worsened_top"][0] if cc["worsened_top"] else None,
              "warnings": sorted({w for b in B for w in b.warnings})},
    }


def grid_payload(ground) -> dict:
    """Blended ground height grid (the analysis ground) for the viewer's terrain provider."""
    import base64
    z = np.where(np.isfinite(ground.z), ground.z, ground.pad_z).astype(np.float32)
    return {"x0": float(ground.xs[0]), "y0": float(ground.ys[0]), "dx": float(ground.xs[1] - ground.xs[0]),
            "dy": float(ground.ys[1] - ground.ys[0]), "nx": int(len(ground.xs)), "ny": int(len(ground.ys)),
            "pad_z": float(ground.pad_z), "z_f32_b64": base64.b64encode(np.ascontiguousarray(z).tobytes()).decode(),
            "note": "분석 레이캐스팅과 동일한 지면 높이장(정점 격자). 화면 표시는 z − pad_z"}
