"""API end-to-end: project -> demo seed -> edit B -> A/B/C run -> results -> report -> downloads -> persistence."""
import io
import json
import time
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app


def wait(c, url, key="status", done=("SUCCEEDED", "FAILED"), timeout=900):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = c.get(url).json()
        if r[key] in done:
            return r
        time.sleep(1.0)
    raise TimeoutError(url)


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def project(client):
    r = client.post("/api/projects", json={"name": "pytest 프로젝트"})
    assert r.status_code == 200, r.text
    return r.json()


def test_health(client):
    h = client.get("/api/health").json()
    assert h["database"]["ok"] and h["job_backend"] == "thread"


def test_project_badges_mark_synthetic(project):
    b = project["data_badges"]
    assert b["terrain"]["class"] == "SYNTHETIC" and b["mode"] == "DEMO"
    assert b["location"]["boundary_verified"] is False
    assert "실제 LH 설계안" in b["disclaimer"]
    codes = {s["code"]: s for s in project["scenarios"]}
    assert codes["A"]["locked"] and not codes["B"]["locked"]


def test_scene_and_ground_mesh_shared(client, project):
    pid = project["id"]
    g = client.get(f"/api/projects/{pid}/ground-mesh").json()
    import base64
    v = np.frombuffer(base64.b64decode(g["vertices_f32_b64"]), dtype=np.float32).reshape(-1, 3)
    assert len(v) == g["n_vertices"] and abs(v[:, 2].max() - g["z_max"]) < 0.01
    sc = client.get(f"/api/projects/{pid}/scene?scenario=A").json()
    mains = [b for b in sc["buildings"] if b["kind"] == "MAIN"]
    assert len(mains) == 7 and all(abs(b["base_z"] - g["pad_z"]) < 1e-6 for b in mains)
    assert len(sc["model_matrix"]) == 16


def test_baseline_locked_and_variant_editable(client, project):
    codes = {s["code"]: s for s in project["scenarios"]}
    r = client.patch(f"/api/scenarios/{codes['A']['id']}/buildings/101", json={"dx": 5})
    assert r.status_code == 400
    r = client.patch(f"/api/scenarios/{codes['B']['id']}/buildings/C01", json={"dx": 5})
    assert r.status_code == 400  # context buildings are not editable
    r = client.patch(f"/api/scenarios/{codes['B']['id']}/buildings/101", json={"dx": 500})
    assert r.status_code == 422
    before = codes["B"]["content_hash"]
    r = client.patch(f"/api/scenarios/{codes['B']['id']}/buildings/102", json={"floors_delta": 2})
    assert r.status_code == 200 and r.json()["content_hash"] != before
    assert r.json()["transforms"]["102"]["floors_delta"] == 2


def test_report_refused_without_successful_run(client, project):
    r = client.post(f"/api/projects/{project['id']}/analyses", json={"analysis_type": "C", "include_sensitivity": False, "reuse_cache": False})
    rid = r.json()["id"]
    # immediately (likely PENDING/RUNNING) -> must refuse; after success it is allowed
    st = client.get(f"/api/analyses/{rid}").json()["status"]
    if st != "SUCCEEDED":
        assert client.post(f"/api/analyses/{rid}/reports").status_code == 409
    assert client.post("/api/analyses/doesnotexist/reports").status_code == 404


def test_full_run_report_and_downloads(client, project):
    pid = project["id"]
    body = {"analysis_type": "ALL", "interval_min": 10, "grid_spacing_m": 4, "include_sensitivity": True, "reuse_cache": False}
    run = client.post(f"/api/projects/{pid}/analyses", json=body).json()
    run = wait(client, f"/api/analyses/{run['id']}")
    assert run["status"] == "SUCCEEDED", run["logs"][-1]
    rid = run["id"]
    res = client.get(f"/api/analyses/{rid}/results").json()
    q = res["quality"]
    assert not q["critical_fail"], q["critical_fail"]
    names = {c["name"]: c["status"] for c in q["checks"]}
    assert names["A: A==B(동일 입력) 직사일조 delta 0"] == "PASS"
    assert names["B: A==B(동일 입력) 신규음영·해소 면적 0"] == "PASS"
    assert names["C: A==A 이격 delta 0"] == "PASS"
    sm = res["summary"]
    assert sm["A"]["n_common"] > 1000 and sm["B"]["n_cells_valid"] > 1000 and sm["C"]["n_pairs"] == 21
    # drilldowns
    rec = sm["A"]["worst_receivers"][0]["receiver_id"]
    ts = client.get(f"/api/analyses/{rid}/sunlight/receivers/{rec}").json()
    assert len(ts["A"]["sun"]) == 48 and ts["A"]["total_min"] > ts["B"]["total_min"]
    cell = client.get(f"/api/analyses/{rid}/shadow/cell", params={"x": 0, "y": -40}).json()
    assert "excluded" in cell
    sh = client.get(f"/api/analyses/{rid}/shadow").json()
    assert len(sh["grid"]["delta_min"]) == sh["grid"]["nx"] * sh["grid"]["ny"]
    # CSV export
    f = client.get(f"/api/analyses/{rid}/files/sunlight_receivers.csv")
    assert f.status_code == 200 and len(f.content) > 10000
    # cache reuse returns the same run
    again = client.post(f"/api/projects/{pid}/analyses", json={**body, "reuse_cache": True}).json()
    assert again["reused"] and again["id"] == rid
    # report
    rp = client.post(f"/api/analyses/{rid}/reports").json()
    rp = wait(client, f"/api/reports/{rp['id']}")
    assert rp["status"] == "SUCCEEDED", rp["error"]
    pq = rp["quality"]
    assert pq["ok"] and pq["pages"] >= 12 and pq["korean_text_extractable"] and pq["first_page_has_title"]
    assert pq["all_key_numbers_found"] and pq["toc_consistent_after_rerender"]
    assert pq["cesium_capture"]["ok"] is False  # unreachable frontend -> static-map fallback, report still built
    pdf = client.get(f"/api/reports/{rp['id']}/download?format=pdf")
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF" and len(pdf.content) > 100_000
    html = client.get(f"/api/reports/{rp['id']}/download?format=html")
    assert html.status_code == 200 and "기술보고서" in html.text
    z = client.get(f"/api/reports/{rp['id']}/download?format=zip")
    zf = zipfile.ZipFile(io.BytesIO(z.content))
    names = set(zf.namelist())
    for need in ("manifest.json", "analysis_summary.json", "quality_check.json", "data/sunlight_receivers.csv", "data/shadow_grid_cells.csv",
                 "data/clearance_pairs.csv", "data/buildings_B.geojson"):
        assert need in names, need
    assert any(n.endswith(".pdf") for n in names) and any(n.endswith(".svg") for n in names) and any(n.endswith(".png") for n in names)
    manifest = json.loads(zf.read("manifest.json"))
    assert manifest["run_id"] == rid and manifest["files"]
    # report numbers == analysis_summary.json
    summ = json.loads(zf.read("analysis_summary.json"))
    assert summ["A"]["n_decreased"] == sm["A"]["n_decreased"]


def test_persistence_across_new_client(project):
    """A fresh app client (simulated restart) sees the same project, runs and reports from the DB/files."""
    with TestClient(app) as c2:
        runs = c2.get(f"/api/projects/{project['id']}/analyses").json()
        ok = [r for r in runs if r["status"] == "SUCCEEDED" and r["analysis_type"] == "ALL"]
        assert ok
        assert c2.get(f"/api/analyses/{ok[0]['id']}/results").status_code == 200
        assert c2.get(f"/api/analyses/{ok[0]['id']}/reports").json()


def test_terrain_upload_valid_and_invalid(client):
    p = client.post("/api/projects", json={"name": "upload test"}).json()
    from tests.test_terrain import _tif
    import tempfile
    from pathlib import Path
    d = Path(tempfile.mkdtemp())
    good = _tif(d / "user_dem_30m.tif", np.full((140, 140), 25.0) + np.linspace(0, 10, 140)[None, :])
    r = client.post(f"/api/projects/{p['id']}/datasets/terrain", files={"file": ("user_dem_30m.tif", good.read_bytes(), "image/tiff")},
                    data={"vertical_datum": "EGM2008", "acquired": "2026-11-01", "license": "test"}).json()
    assert r["activated"] and r["qa"]["vertical_datum_status"] == "UNRESOLVED"
    pr = client.get(f"/api/projects/{p['id']}").json()
    assert pr["data_badges"]["terrain"]["class"] == "USER_UPLOADED" and pr["data_badges"]["mode"] == "UPLOADED"
    r2 = client.post(f"/api/projects/{p['id']}/datasets/terrain", files={"file": ("broken.tif", b"not a tiff", "image/tiff")}).json()
    assert not r2["activated"] and r2["status"] == "REJECTED"
    pr2 = client.get(f"/api/projects/{p['id']}").json()
    assert pr2["data_badges"]["terrain"]["class"] == "USER_UPLOADED"  # previous terrain kept


def test_buildings_geojson_upload_validation(client):
    p = client.post("/api/projects", json={"name": "bld upload"}).json()
    bad = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"id": "G1", "floors": 10}, "geometry": {"type": "GeometryCollection", "geometries": []}},
        {"type": "Feature", "properties": {"id": "U1"}, "geometry": {"type": "Polygon", "coordinates": [[[126.7545, 37.5559], [126.7550, 37.5559], [126.7550, 37.5562], [126.7545, 37.5559]]]}},
    ]}
    r = client.post(f"/api/projects/{p['id']}/datasets/buildings", files={"file": ("b.geojson", json.dumps(bad).encode(), "application/geo+json")}).json()
    assert r["status"] == "REJECTED" and len(r["qa"]["errors"]) == 2
    lon, lat, dx, dy = 126.7545222, 37.5559943, 0.0004, 0.00012
    good = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"id": "U1", "floors": 12},
            "geometry": {"type": "Polygon", "coordinates": [[[lon, lat], [lon + dx, lat], [lon + dx, lat + dy], [lon, lat + dy], [lon, lat]]]}}]}
    r = client.post(f"/api/projects/{p['id']}/datasets/buildings", files={"file": ("g.geojson", json.dumps(good).encode(), "application/geo+json")}).json()
    assert r["status"] in ("OK", "WARN"), r
    sc = client.get(f"/api/projects/{p['id']}/scene?scenario=A").json()
    u = [b for b in sc["buildings"] if b["id"] == "U1"][0]
    assert 300 < u["footprint_area_m2"] < 600 and u["data_class"] == "USER_UPLOADED"
