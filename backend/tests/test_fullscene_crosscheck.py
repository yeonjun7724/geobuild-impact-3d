"""Full demo scene (synthetic 30 m DEM terrain mesh + all buildings): Open3D vs independent float64 engine."""
from datetime import date

import numpy as np

from app.analysis.raycast import INVALID, NumpyEngine, self_offset
from app.analysis.solar import sample_window
from app.geo.enu import LocalFrame
from app.geo.terrain import DemSampler, build_ground, write_synthetic_dem
from app.scene import demo
from app.scene.builder import build_scene, building_mesh, resolve_scenario


def test_full_scene_receiver_and_ground_rays_agree(tmp_path):
    fr = LocalFrame(demo.SITE_META["lat0"], demo.SITE_META["lon0"])
    dem = write_synthetic_dem(tmp_path / "d.tif", fr)
    g = build_ground(DemSampler(dem, fr), demo.SITE_RECT)
    gm = g.mesh()
    B = resolve_scenario({"buildings": demo.demo_buildings()}, demo.DEMO_B_TRANSFORMS, g)
    sc = build_scene(B, g, ground_mesh=gm)
    ref = NumpyEngine()
    ref.add_mesh("TERRAIN", *gm)
    for b in B:
        ref.add_mesh(b.id, *building_mesh(b))
    sun = sample_window(date(2026, 12, 22), "08:00", "16:00", 5, fr.lat0, fr.lon0)
    rng = np.random.default_rng(11)
    eps = self_offset(sc.extent_m)
    # facade receiver rays (only facing intervals)
    R = sc.receivers
    idx = rng.choice(len(R), 400, replace=False)
    ti = rng.integers(0, len(sun.vectors), 400)
    P = np.array([R[i].position for i in idx]); N = np.array([R[i].normal for i in idx]); S = sun.vectors[ti]
    keep = (N * S).sum(1) > 1e-9
    O, D = (P + N * eps)[keep], S[keep]
    # ground grid rays (inside the site, outside footprints)
    xs = rng.uniform(-148, 148, 400); ys = rng.uniform(-148, 148, 400)
    from shapely import points, intersects
    inside = np.zeros(400, bool)
    for b in B:
        inside |= intersects(b.footprint, points(xs, ys))
    G = np.column_stack([xs, ys, np.full(400, g.pad_z + eps)])[~inside]
    O = np.vstack([O, G]); D = np.vstack([D, sun.vectors[rng.integers(0, len(sun.vectors), len(G))]])
    _, la = sc.engine.first_hit(O, D)
    _, lb = ref.first_hit(O, D, chunk=4)
    labs_a = np.array([sc.engine.labels[i] if i != INVALID else "-" for i in la])
    labs_b = np.array([ref.labels[i] if i != INVALID else "-" for i in lb])
    hit_agree = ((la != INVALID) == (lb != INVALID)).mean()
    lab_agree = (labs_a == labs_b).mean()
    assert len(O) > 500
    assert hit_agree == 1.0, hit_agree
    assert lab_agree == 1.0, lab_agree
    assert (la != INVALID).mean() > 0.05  # the sample actually contains occluded rays
