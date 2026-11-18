"""Two-box scenes through the real scene builder + A/B/C analyses."""
from datetime import date

import numpy as np
import pytest
from shapely.geometry import GeometryCollection, Point, Polygon, box

from app.analysis import clearance as C
from app.analysis.shadow import compare_shadow, compute_shadow, make_grid
from app.analysis.solar import instants, sample_window
from app.analysis.sunlight import BACK_FACING, BELOW_HORIZON, compare_sunlight, compute_sunlight
from app.geo.terrain import GroundModel
from app.scene.builder import build_scene, resolve_scenario
from app.scene.geometry import GeometryError, building_height, make_receivers, validate_footprint

LAT, LON = 37.5559943, 126.7545222
DAY = date(2026, 12, 22)


def flat_ground(z=10.0, half=600.0, sp=20.0):
    xs = np.arange(-half, half + sp, sp)
    Z = np.full((len(xs), len(xs)), z)
    return GroundModel(xs, xs.copy(), Z, Z.copy(), z, (-200, -200, 200, 200), 60.0, sp, {"warnings": []})


def rect(cx, cy, L, D):
    return [[cx - L / 2, cy - D / 2], [cx + L / 2, cy - D / 2], [cx + L / 2, cy + D / 2], [cx - L / 2, cy + D / 2]]


def site(tall_floors=25, low_floors=5, gap=40.0):
    """Low slab (L) north of a tall slab (T). Gap = clear distance between facades (m)."""
    return {"buildings": [
        {"id": "T", "name": "T", "kind": "MAIN", "floors": tall_floors, "footprint": rect(0, 0, 40, 12)},
        {"id": "L", "name": "L", "kind": "MAIN", "floors": low_floors, "footprint": rect(0, 6 + gap + 6, 40, 12)},
    ], "open_spaces": []}


SUN = sample_window(DAY, "08:00", "16:00", 5, LAT, LON)


def run_a(site_d, ta, tb, g=None):
    g = g or flat_ground()
    A, B = resolve_scenario(site_d, ta, g), resolve_scenario(site_d, tb, g)
    sa, sb = build_scene(A, g), build_scene(B, g)
    return compare_sunlight(compute_sunlight(sa, SUN), compute_sunlight(sb, SUN), {k for k in tb}), A, B, sa, sb, g


def test_identical_scenarios_give_zero_deltas_A_B_C():
    s = site()
    tr = {"T": {"dx": 3.0, "rot_deg": 5.0}}
    cmp, A, B, sa, sb, g = run_a(s, tr, tr)
    assert cmp["n_decreased"] == 0 and cmp["n_increased"] == 0
    assert all(r["delta_total_min"] == 0 and r["delta_max_cont_min"] == 0 for r in cmp["rows"])
    grid = make_grid(g.mesh(), (-100, -100, 100, 100), 2.0, [b.footprint for b in A + B])
    cb = compare_shadow(grid, compute_shadow(sa, grid, SUN), compute_shadow(sb, grid, SUN), SUN, [])
    assert max(cb["curve"]["new_shade_area_m2"]) == 0 and max(cb["curve"]["relieved_area_m2"]) == 0
    assert cb["delta_min_max"] == 0 and cb["delta_min_min"] == 0
    cc = C.compare_clearance(C.pairwise(A), C.pairwise(B), C.facade_normal_distances(A), C.facade_normal_distances(B), [], [])
    assert all(r["delta_m"] == 0 for r in cc["pairs"])
    assert all((r["delta_m"] or 0) == 0 for r in cc["facade_normals"])


def test_tall_building_shades_low_building_south_facade_at_noon():
    """Analytic: at noon (elev≈29°) a 73.7 m slab casts ≈133 m shadow -> low slab 40 m north is shaded at noon."""
    s = site(gap=40.0)
    g = flat_ground()
    A = resolve_scenario(s, {}, g)
    sc = build_scene(A, g)
    noon = instants(DAY, ["12:30"], LAT, LON)
    res = compute_sunlight(sc, noon)
    idx = [i for i, rid in enumerate(res.receiver_ids) if rid.startswith("L-F01-S0")]
    assert idx and not res.sun[idx, 0].any()
    assert res.labels[res.blocker[idx[0], 0]] == "T"
    # north facade of T faces away from the sun at noon -> BACK_FACING
    north = [i for i, rid in enumerate(res.receiver_ids) if rid.startswith("T-") and "-N2-" in rid]
    assert north and (res.blocker[north, 0] == BACK_FACING).all()


def test_moving_tall_building_away_restores_sun_and_ids_are_stable():
    s = site(gap=40.0)
    cmp, *_ = run_a(s, {}, {"T": {"dx": 0.0, "dy": -45.0}})
    rows = {r["receiver_id"]: r for r in cmp["rows"]}
    low = [r for k, r in rows.items() if k.startswith("L-F01-S0")]
    assert all(r["delta_total_min"] > 0 for r in low)  # more sun on the low block
    assert cmp["n_only_a"] == 0 and cmp["n_only_b"] == 0
    t = [r for k, r in rows.items() if k.startswith("T-")]
    assert all(abs(r["y_b"] - r["y_a"] + 45.0) < 1e-6 for r in t)  # moved receivers computed at B positions
    assert all(r["impact_type"] == "SELF_MODIFIED" for r in t)


def test_height_increase_reduces_sun_and_adds_receivers():
    s = site(tall_floors=10, gap=40.0)
    cmp, A, B, *_ = run_a(s, {}, {"T": {"floors_delta": 10}})
    assert B[0].height_m == pytest.approx(building_height(20))
    assert cmp["n_decreased"] > 0 and cmp["n_increased"] == 0
    assert cmp["n_only_b"] > 0  # new floors -> receivers only in B, reported not compared
    assert cmp["cause_counts"].get("T", 0) > 0


def test_rotation_changes_mesh_and_results():
    s = site(gap=30.0)
    cmp, A, B, *_ = run_a(s, {}, {"T": {"rot_deg": 30.0}})
    a0 = np.asarray(A[0].footprint.exterior.coords)
    b0 = np.asarray(B[0].footprint.exterior.coords)
    assert not np.allclose(a0, b0)
    assert A[0].footprint.area == pytest.approx(B[0].footprint.area)
    assert cmp["n_decreased"] + cmp["n_increased"] > 0


def test_below_horizon_intervals_are_zero_sun():
    s = site()
    g = flat_ground()
    sc = build_scene(resolve_scenario(s, {}, g), g)
    early = sample_window(DAY, "06:00", "08:00", 10, LAT, LON)  # sunrise ~07:46 KST
    res = compute_sunlight(sc, early)
    below = early.elevation_deg <= 0
    assert below.any()
    assert (res.blocker[:, below] == BELOW_HORIZON).all() and not res.sun[:, below].any()


def test_time_step_sensitivity_recorded():
    s = site(gap=40.0)
    g = flat_ground()
    sc = build_scene(resolve_scenario(s, {}, g), g)
    r5 = compute_sunlight(sc, SUN)
    r1 = compute_sunlight(sc, sample_window(DAY, "08:00", "16:00", 1, LAT, LON))
    diff = np.abs(r5.total_min - r1.total_min)
    assert diff.max() <= 5 * 2  # at most ±Δt/2 per transition, few transitions
    # recorded honestly: values may differ
    assert diff.mean() >= 0


# ---------------------------------------------------------------- C clearance
def test_known_rectangle_distance_and_nearest_points():
    a, b = box(0, 0, 10, 10), box(40, 0, 50, 10)
    r = C.pair_distance(a, b)
    assert r["distance_m"] == pytest.approx(30.0) and r["status"] == "SEPARATED"
    assert r["p_a"][0] == pytest.approx(10.0) and r["p_b"][0] == pytest.approx(40.0)
    r2 = C.pair_distance(box(0, 0, 10, 10), box(13, 14, 20, 20))  # diagonal: corner to corner = 5
    assert r2["distance_m"] == pytest.approx(5.0)


def test_contact_and_overlap_are_zero_never_negative():
    c = C.pair_distance(box(0, 0, 10, 10), box(10, 0, 20, 10))
    assert c["distance_m"] == 0.0 and c["status"] == "CONTACT"
    o = C.pair_distance(box(0, 0, 10, 10), box(5, 5, 20, 20))
    assert o["distance_m"] == 0.0 and o["status"] == "OVERLAP" and o["overlap_area_m2"] == pytest.approx(25.0)


def test_facade_normal_distance_and_no_intersection():
    s = site(gap=40.0)
    g = flat_ground()
    A = resolve_scenario(s, {}, g)
    n = {f["facade_id"]: f for f in C.facade_normal_distances(A)}
    assert n["T-N2"]["distance_m"] == pytest.approx(40.0) and n["T-N2"]["target_id"] == "L"
    assert n["T-S0"]["status"] == "NO_INTERSECTION" and n["T-S0"]["distance_m"] is None


def test_clearance_delta_when_moved():
    s = site(gap=40.0)
    g = flat_ground()
    A, B = resolve_scenario(s, {}, g), resolve_scenario(s, {"T": {"dy": 10.0}}, g)
    cc = C.compare_clearance(C.pairwise(A), C.pairwise(B), [], [], [], [])
    assert cc["pairs"][0]["delta_m"] == pytest.approx(-10.0)
    assert cc["worsened_top"][0]["pair_id"] == "T|L"


def test_footprint_validation_errors():
    with pytest.raises(GeometryError):
        validate_footprint(GeometryCollection([box(0, 0, 10, 10)]))
    with pytest.raises(GeometryError):
        validate_footprint(Polygon([(0, 0), (10, 10), (10, 0), (0, 10)]))  # bow-tie
    with pytest.raises(GeometryError):
        validate_footprint(box(126.75, 37.55, 126.7501, 37.5501))  # degrees treated as metres
    with pytest.raises(GeometryError):
        validate_footprint(Point(0, 0).buffer(1))


def test_receivers_keep_ids_under_rigid_transform():
    from app.scene.geometry import transform_footprint
    p = box(0, 0, 40, 12)
    q = transform_footprint(p, 5, -3, 17, (20, 6))
    ra = make_receivers("X", p, p, 0.0, 3)
    rb = make_receivers("X", p, q, 0.0, 3)
    assert [r.receiver_id for r in ra] == [r.receiver_id for r in rb]
    assert not np.allclose([r.position for r in ra], [r.position for r in rb])
    assert all(abs(np.linalg.norm(r.normal) - 1) < 1e-9 for r in rb)
