"""Regression tests for defects found in the deep review (each test failed before its fix)."""
import json
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app

LON, LAT, DX, DY = 126.7545222, 37.5559943, 0.0004, 0.00012
RING = [[LON, LAT], [LON + DX, LAT], [LON + DX, LAT + DY], [LON, LAT + DY], [LON, LAT]]


@pytest.fixture(scope="module")
def c():
    with TestClient(app) as cl:
        yield cl


def _wait(c, url, timeout=900):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = c.get(url).json()
        if r["status"] in ("SUCCEEDED", "FAILED"):
            return r
        time.sleep(1)
    raise TimeoutError(url)


def test_pad_stays_flat_where_dem_has_nodata():
    from app.geo.terrain import build_ground

    class S:
        def sample_xy(self, X, Y):
            z = np.full(np.shape(X), 10.0)
            z[(np.abs(X) < 50) & (np.abs(Y) < 50)] = np.nan
            return z
    g = build_ground(S(), (-150, -150, 150, 150))
    inside = (np.abs(g.xs)[None, :] <= 170) & (np.abs(g.ys)[:, None] <= 170)
    assert np.isfinite(g.z[inside]).all() and np.allclose(g.z[inside], g.pad_z)


@pytest.mark.parametrize("body", [{"interval_min": 7}, {"start": "16:00", "end": "08:00"}, {"snapshot_times": ["25:00"]},
                                  {"timezone": "Mars/Base"}, {"date": "1900-01-01"}])
def test_invalid_analysis_conditions_rejected_upfront(c, body):
    p = c.post("/api/projects", json={"name": "v"}).json()
    r = c.post(f"/api/projects/{p['id']}/analyses", json={"analysis_type": "C", **body})
    assert r.status_code == 422, r.text


def _upload(c, feats, name="b.geojson"):
    p = c.post("/api/projects", json={"name": "u"}).json()
    r = c.post(f"/api/projects/{p['id']}/datasets/buildings",
               files={"file": (name, json.dumps({"type": "FeatureCollection", "features": feats}).encode())}).json()
    return p, r


def _feat(bid, coords=None, floors=5):
    return {"type": "Feature", "properties": {"id": bid, "floors": floors}, "geometry": {"type": "Polygon", "coordinates": coords or [RING]}}


def test_courtyard_hole_rejected_not_silently_filled(c):
    hole = [[LON + DX * a, LAT + DY * b] for a, b in ((.3, .3), (.6, .3), (.6, .6), (.3, .6), (.3, .3))]
    _, r = _upload(c, [_feat("H1", [RING, hole])])
    assert r["status"] == "REJECTED" and any("중정" in e for e in r["qa"]["errors"])


@pytest.mark.parametrize("feats,needle", [([_feat("X" * 40)], "1~32자"), ([_feat("D1"), _feat("D1")], "중복"),
                                          ([_feat("C01")], "충돌"), ([_feat("F1", floors=500)], "범위")])
def test_building_id_and_floor_validation(c, feats, needle):
    _, r = _upload(c, feats)
    assert r["status"] == "REJECTED" and any(needle in e for e in r["qa"]["errors"]), r["qa"]


def test_upload_filename_is_sanitised_and_never_overwrites(c):
    from app.services import save_upload
    a = save_upload("pX", "terrain", "../../evil.tif", b"1")
    b = save_upload("pX", "terrain", "../../evil.tif", b"2")
    assert a != b and a.read_bytes() == b"1" and ".." not in a.name and a.parent.name == "terrain"
    assert save_upload("pX", "terrain", "..", b"3").name.endswith("upload.bin")


def test_stale_jobs_are_reported_as_failed(c):
    from app.db import AnalysisRun, Report, SessionLocal
    p = c.post("/api/projects", json={"name": "stale"}).json()
    old = datetime.now(timezone.utc) - timedelta(hours=2)
    with SessionLocal() as s:
        r = AnalysisRun(project_id=p["id"], analysis_type="C", status="PENDING", params={}, snapshot={}, cache_key="x", logs=[], created_at=old)
        s.add(r)
        s.commit()
        rid = r.id
        rp = Report(run_id=rid, status="RUNNING", created_at=old)
        s.add(rp)
        s.commit()
        rpid = rp.id
    j = c.get(f"/api/analyses/{rid}").json()
    assert j["status"] == "FAILED" and "응답 없음" in j["error"]
    assert c.get(f"/api/reports/{rpid}").json()["status"] == "FAILED"


def test_large_upload_is_clipped_with_provenance(c, monkeypatch, tmp_path):
    import app.services as S
    from tests.test_terrain import _tif
    monkeypatch.setattr(S, "LARGE_RASTER_CELLS", 100_000)
    big = _tif(tmp_path / "srtm_big.tif", np.full((600, 600), 12.0), res=26.0)
    p = c.post("/api/projects", json={"name": "big"}).json()
    r = c.post(f"/api/projects/{p['id']}/datasets/terrain", files={"file": ("srtm_big.tif", big.read_bytes(), "image/tiff")}).json()
    assert r["activated"] and r["clipped"]
    ds = [d for d in c.get(f"/api/projects/{p['id']}/datasets").json() if d["kind"] == "TERRAIN" and d["data_class"] == "USER_UPLOADED"][0]
    assert ds["meta"]["source_sha256"] and ds["meta"]["source_cells"] == 360_000 and ds["meta"]["region_half_m"] == 4800.0
    assert abs(ds["qa"]["cell_size_x"] - 26.0) < 1e-6  # native cell size reported


def test_offset_follows_analysis_targets_not_terrain_extent():
    from app.analysis.raycast import self_offset
    from app.geo.terrain import GroundModel
    from app.scene import demo
    from app.scene.builder import build_scene, resolve_scenario
    xs = np.arange(-4800, 4801, 200.0)
    Z = np.zeros((len(xs), len(xs)))
    g = GroundModel(xs, xs.copy(), Z, Z.copy(), 0.0, (-170, -170, 170, 170), 60.0, 200.0, {})
    sc = build_scene(resolve_scenario({"buildings": demo.demo_buildings()}, {}, g), g)
    assert sc.extent_m < 700 and self_offset(sc.extent_m) == pytest.approx(0.02)


def test_significant_loss_counts_all_receivers_and_c_without_pairs_reports(c):
    """A+C on a single uploaded building: C has no pairs (guard), A significant-loss summary is over all receivers."""
    p, r = _upload(c, [_feat("S1", floors=10)])
    assert r["status"] in ("OK", "WARN")
    run = c.post(f"/api/projects/{p['id']}/analyses", json={"analysis_type": "ALL", "interval_min": 30, "grid_spacing_m": 5,
                                                             "include_sensitivity": False, "reuse_cache": False}).json()
    run = _wait(c, f"/api/analyses/{run['id']}")
    assert run["status"] == "SUCCEEDED", run["logs"][-1]
    sm = c.get(f"/api/analyses/{run['id']}/results").json()["summary"]
    assert sm["C"]["n_pairs"] == 0 and sm["C"]["min_pair_a"] is None
    rows = c.get(f"/api/analyses/{run['id']}/sunlight").json()["receivers"]
    expect = sum(1 for x in rows if x["delta_total_min"] <= -60)
    assert sum(g["n_loss_ge_threshold"] for g in sm["A"]["significant_loss"]) == expect
    rp = c.post(f"/api/analyses/{run['id']}/reports").json()
    rp = _wait(c, f"/api/reports/{rp['id']}")
    assert rp["status"] == "SUCCEEDED", rp["error"]
    assert rp["quality"]["first_page_has_title"] and rp["quality"]["korean_text_extractable"]
