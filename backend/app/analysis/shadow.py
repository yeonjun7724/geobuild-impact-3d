"""Analysis B - quantitative ground shadow change on a regular analysis grid.

* Grid spacing (default 2 m) is a sampling interval only; it says nothing about DEM accuracy.
* Cell height is taken by casting a vertical ray onto the *same* ground mesh used for analysis & display.
* Common denominator: a cell is analysable only if it is valid in BOTH scenarios (not NoData, not inside a
  footprint of A or B). A and B therefore always share the same set of cells and the same total area.
* Intervals with sun elevation <= 0 are excluded from the analysed time (neither sun nor shade).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import shapely
from shapely.geometry import Polygon

from .raycast import INVALID, make_engine, self_offset
from .solar import SunSeries

STATE_SUN_SUN = 0
STATE_SHADE_SHADE = 1
STATE_NEW_SHADE = 2  # SUN_A -> SHADE_B
STATE_RELIEVED = 3  # SHADE_A -> SUN_B
STATE_NAMES = {0: "SUN→SUN", 1: "SHADE→SHADE", 2: "SUN→SHADE(신규 음영)", 3: "SHADE→SUN(음영 해소)"}

EXCL_NONE = 0
EXCL_BUILDING = 1
EXCL_NODATA = 2


@dataclass
class Grid:
    spacing: float
    xs: np.ndarray  # cell centre x (nx)
    ys: np.ndarray  # cell centre y (ny)
    z: np.ndarray  # (ny,nx) ground height at cell centre, NaN = no ground
    exclusion: np.ndarray  # (ny,nx) int8 exclusion code

    @property
    def valid(self) -> np.ndarray:
        return self.exclusion == EXCL_NONE

    @property
    def cell_area(self) -> float:
        return self.spacing * self.spacing


def make_grid(ground_mesh, site_rect, spacing: float, footprints: list[Polygon]) -> Grid:
    xmin, ymin, xmax, ymax = site_rect
    xs = np.arange(xmin + spacing / 2, xmax, spacing)
    ys = np.arange(ymin + spacing / 2, ymax, spacing)
    X, Y = np.meshgrid(xs, ys)
    eng = make_engine("open3d")
    eng.add_mesh("TERRAIN", *ground_mesh)
    top = 10000.0
    o = np.column_stack([X.ravel(), Y.ravel(), np.full(X.size, top)])
    d = np.tile([0.0, 0.0, -1.0], (X.size, 1))
    t, lab = eng.first_hit(o, d)
    z = np.where(lab != INVALID, top - t, np.nan).reshape(X.shape)
    excl = np.zeros(X.shape, dtype=np.int8)
    excl[~np.isfinite(z)] = EXCL_NODATA
    if footprints:
        pts = shapely.points(X.ravel(), Y.ravel())
        inside = np.zeros(X.size, dtype=bool)
        for fp in footprints:
            inside |= shapely.intersects(fp, pts)
        excl[(inside.reshape(X.shape)) & (excl == EXCL_NONE)] = EXCL_BUILDING
    return Grid(spacing, xs, ys, z, excl)


@dataclass
class ShadowResult:
    shade: np.ndarray  # (C,T) bool for valid cells (row-major order of grid.valid)
    blocker: np.ndarray  # (C,T) int label idx, -1 if sun
    labels: list[str]
    analysed: np.ndarray  # (T,) bool interval analysed (sun above horizon)
    rays_cast: int


def compute_shadow(scene, grid: Grid, sun: SunSeries) -> ShadowResult:
    vy, vx = np.nonzero(grid.valid)
    P = np.column_stack([grid.xs[vx], grid.ys[vy], grid.z[vy, vx]])
    eps = self_offset(scene.extent_m)
    P[:, 2] += eps
    C, T = len(P), len(sun.vectors)
    analysed = sun.elevation_deg > 0
    shade = np.zeros((C, T), dtype=bool)
    blocker = np.full((C, T), -1, dtype=np.int32)
    rays = 0
    for t in np.nonzero(analysed)[0]:
        d = np.tile(sun.vectors[t], (C, 1))
        _, lab = scene.engine.first_hit(P, d)
        hit = lab != INVALID
        shade[:, t] = hit
        blocker[hit, t] = lab[hit]
        rays += C
    return ShadowResult(shade, blocker, list(scene.engine.labels), analysed, rays)


def compare_shadow(grid: Grid, a: ShadowResult, b: ShadowResult, sun: SunSeries, open_spaces: list[dict], top_n: int = 20) -> dict:
    if a.shade.shape != b.shade.shape:
        raise ValueError("A/B 분석 격자 불일치 - 공통 분모 규칙 위반")
    an = a.analysed & b.analysed
    ca = grid.cell_area
    sa, sb = a.shade[:, an], b.shade[:, an]
    new = ~sa & sb
    rel = sa & ~sb
    dt = sun.dt_min
    shade_min_a = sa.sum(axis=1) * dt
    shade_min_b = sb.sum(axis=1) * dt
    delta = shade_min_b - shade_min_a
    times = [t.strftime("%H:%M:%S") for t, k in zip(sun.times_local, an) if k]
    curve = {
        "time_local": times,
        "new_shade_area_m2": (new.sum(axis=0) * ca).round(2).tolist(),
        "relieved_area_m2": (rel.sum(axis=0) * ca).round(2).tolist(),
        "shade_area_a_m2": (sa.sum(axis=0) * ca).round(2).tolist(),
        "shade_area_b_m2": (sb.sum(axis=0) * ca).round(2).tolist(),
    }
    vy, vx = np.nonzero(grid.valid)
    order = np.argsort(-delta, kind="stable")
    top = []
    for i in order[:top_n]:
        if delta[i] <= 0:
            break
        lost = new[i]
        cause = b.blocker[i, an][lost]
        ids = [b.labels[c] for c in cause if c >= 0]
        top.append({
            "cell_index": int(i), "x": round(float(grid.xs[vx[i]]), 2), "y": round(float(grid.ys[vy[i]]), 2),
            "shade_min_a": float(shade_min_a[i]), "shade_min_b": float(shade_min_b[i]), "delta_min": float(delta[i]),
            "main_cause_b": max(set(ids), key=ids.count) if ids else None,
        })
    cell_x = grid.xs[vx]
    cell_y = grid.ys[vy]
    os_rows = []
    pts = shapely.points(cell_x, cell_y)
    for osp in open_spaces:
        poly = Polygon(osp["polygon"])
        m = shapely.intersects(poly, pts)
        n = int(m.sum())
        if n == 0:
            os_rows.append({"id": osp["id"], "name": osp["name"], "kind": osp["kind"], "n_cells": 0, "note": "유효 격자 없음"})
            continue
        os_rows.append({
            "id": osp["id"], "name": osp["name"], "kind": osp["kind"], "data_class": osp.get("data_class", "SYNTHETIC"),
            "n_cells": n, "area_m2": round(n * ca, 1), "polygon_area_m2": round(poly.area, 1),
            "mean_shade_min_a": round(float(shade_min_a[m].mean()), 2), "mean_shade_min_b": round(float(shade_min_b[m].mean()), 2),
            "mean_delta_min": round(float(delta[m].mean()), 2), "max_delta_min": float(delta[m].max()),
            "peak_new_shade_area_m2": round(float((new[m].sum(axis=0) * ca).max()), 1),
            "new_shade_cell_minutes_m2min": round(float(new[m].sum() * ca * dt), 1),
            "relieved_cell_minutes_m2min": round(float(rel[m].sum() * ca * dt), 1),
        })
    n_valid = int(grid.valid.sum())
    return {
        "grid_spacing_m": grid.spacing,
        "cell_area_m2": ca,
        "n_cells_total": int(grid.valid.size),
        "n_cells_valid": n_valid,
        "n_cells_excluded_building": int((grid.exclusion == EXCL_BUILDING).sum()),
        "n_cells_excluded_nodata": int((grid.exclusion == EXCL_NODATA).sum()),
        "valid_area_m2": round(n_valid * ca, 1),
        "analysed_intervals": int(an.sum()),
        "excluded_intervals_sun_below_horizon": int((~an).sum()),
        "analysed_minutes": float(an.sum() * dt),
        "mean_shade_min_a": round(float(shade_min_a.mean()), 3),
        "mean_shade_min_b": round(float(shade_min_b.mean()), 3),
        "n_cells_more_shade": int((delta > 0).sum()),
        "n_cells_less_shade": int((delta < 0).sum()),
        "n_cells_unchanged": int((delta == 0).sum()),
        "area_more_shade_m2": round(float((delta > 0).sum() * ca), 1),
        "area_less_shade_m2": round(float((delta < 0).sum() * ca), 1),
        "max_new_shade_area_m2": max(curve["new_shade_area_m2"]) if times else 0.0,
        "max_new_shade_time": times[int(np.argmax(curve["new_shade_area_m2"]))] if times else None,
        "max_relieved_area_m2": max(curve["relieved_area_m2"]) if times else 0.0,
        "max_relieved_time": times[int(np.argmax(curve["relieved_area_m2"]))] if times else None,
        "delta_min_max": float(delta.max()) if len(delta) else 0.0,
        "delta_min_min": float(delta.min()) if len(delta) else 0.0,
        "curve": curve,
        "top_cells": top,
        "open_spaces": os_rows,
        "_cell_arrays": {"x": cell_x, "y": cell_y, "shade_min_a": shade_min_a, "shade_min_b": shade_min_b, "delta": delta},
    }


def snapshot_states(a_shade: np.ndarray, b_shade: np.ndarray) -> np.ndarray:
    """Per-cell state code for one instant."""
    st = np.where(a_shade & b_shade, STATE_SHADE_SHADE, STATE_SUN_SUN)
    st = np.where(~a_shade & b_shade, STATE_NEW_SHADE, st)
    st = np.where(a_shade & ~b_shade, STATE_RELIEVED, st)
    return st.astype(np.int8)
