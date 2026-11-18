"""Analytic shadow tests, engine cross-check, self-intersection offset."""
import numpy as np
import pytest
from shapely.geometry import MultiPoint, box

from app.analysis.qa import engine_crosscheck, pole_shadow_length
from app.analysis.raycast import INVALID, self_offset
from app.analysis.solar import sun_vector
from app.scene.geometry import extrude


@pytest.mark.parametrize("elev,az", [(29.0, 180.0), (15.0, 150.0), (8.0, 230.0), (45.0, 200.0)])
def test_pole_shadow_matches_H_over_tan_alpha(elev, az):
    r = pole_shadow_length(30.0, elev, az)
    assert r["abs_error_m"] <= 0.05, r
    # shadow points away from the sun
    assert abs(((r["shadow_azimuth_deg"] - (az + 180)) + 180) % 360 - 180) < 1e-6


def test_box_shadow_area_on_flat_ground(flat_engine):
    """Shadow of a box = hull(footprint ∪ footprint shifted by H/tanα) − footprint; compare with grid ray casting."""
    H, elev, az = 20.0, 25.0, 160.0
    eng = flat_engine({"B": (-10, -5, 10, 5, H)})
    s = sun_vector(az, elev)
    L = H / np.tan(np.radians(elev))
    d = -s[:2] / np.linalg.norm(s[:2]) * L
    fp = box(-10, -5, 10, 5)
    pts = list(fp.exterior.coords) + [(x + d[0], y + d[1]) for x, y in fp.exterior.coords]
    analytic = MultiPoint(pts).convex_hull.difference(fp).area
    sp = 0.25
    xs = np.arange(-80, 80, sp) + sp / 2
    X, Y = np.meshgrid(xs, xs)
    P = np.column_stack([X.ravel(), Y.ravel(), np.full(X.size, 0.01)])
    inside = (np.abs(P[:, 0]) < 10) & (np.abs(P[:, 1]) < 5)
    _, lab = eng.first_hit(P[~inside], np.tile(s, ((~inside).sum(), 1)))
    measured = (lab != INVALID).sum() * sp * sp
    assert abs(measured - analytic) / analytic < 0.01, (measured, analytic)


def test_open3d_agrees_with_independent_engine():
    rng = np.random.default_rng(0)
    meshes = []
    for i in range(6):
        x, y = rng.uniform(-60, 60, 2)
        v, t = extrude(box(x, y, x + rng.uniform(8, 30), y + rng.uniform(8, 20)), 0, rng.uniform(10, 70))
        meshes.append((f"b{i}", v, t))
    O = np.column_stack([rng.uniform(-90, 90, 3000), rng.uniform(-90, 90, 3000), rng.uniform(0.5, 40, 3000)])
    D = sun_vector(rng.uniform(90, 270, 3000), rng.uniform(3, 40, 3000))
    r = engine_crosscheck(meshes, O, D)
    assert r["hit_agreement_ratio"] >= 0.999, r
    assert r["label_agreement_ratio"] >= 0.999, r


def test_self_intersection_offset_prevents_wall_self_hit(flat_engine):
    eng = flat_engine({"W": (0, 0, 40, 12, 30)})
    # receivers on the south wall (y=0), outward normal -y, sun from the south-west (facing)
    xs = np.linspace(1, 39, 200)
    P = np.column_stack([xs, np.zeros_like(xs), np.full_like(xs, 10.0)])
    n = np.array([0, -1.0, 0])
    s = sun_vector(200, 20)
    assert n @ s > 0
    eps = self_offset(2400.0)
    t0, l0 = eng.first_hit(P, np.tile(s, (len(P), 1)))
    t1, l1 = eng.first_hit(P + n * eps, np.tile(s, (len(P), 1)))
    assert (l1 == INVALID).all(), "managed offset must not self-hit"
    assert eps >= 0.02
