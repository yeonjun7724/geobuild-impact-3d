"""Layout drawings: DXF (mm, EPSG:5186) -> footprints + 동/층 texts -> scenario layout -> scene, legal checks."""
import io

import ezdxf
import pytest
from fastapi.testclient import TestClient
from pyproj import Transformer

from app import cad
from app.main import app

LAT0, LON0 = 37.5559943, 126.7545222


def make_dxf(path, ox, oy, mm=True, gap=30.0):
    k = 1000.0 if mm else 1.0
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4 if mm else 6
    msp = doc.modelspace()
    doc.layers.add("A-동외곽")
    doc.layers.add("대지경계")
    doc.layers.add("TEXT")
    for i, (bid, fl) in enumerate([("201", 25), ("202", 20)]):
        x0, y0 = ox - 20, oy + i * (12 + gap)
        pts = [(x0, y0), (x0 + 40, y0), (x0 + 40, y0 + 12), (x0, y0 + 12)]
        msp.add_lwpolyline([(x * k, y * k) for x, y in pts], close=True, dxfattribs={"layer": "A-동외곽"})
        msp.add_text(f"{bid}동", dxfattribs={"layer": "TEXT", "insert": ((x0 + 5) * k, (y0 + 6) * k), "height": 2 * k})
        msp.add_text(f"지상{fl}층", dxfattribs={"layer": "TEXT", "insert": ((x0 + 20) * k, (y0 + 4) * k), "height": 2 * k})
    # site boundary drawn as 4 separate lines (not a closed polyline)
    b = [(ox - 80, oy - 60), (ox + 80, oy - 60), (ox + 80, oy + 120), (ox - 80, oy + 120)]
    for a, c in zip(b, b[1:] + b[:1]):
        msp.add_line((a[0] * k, a[1] * k), (c[0] * k, c[1] * k), dxfattribs={"layer": "대지경계"})
    # a stray tiny closed polyline (symbol) that must be ignored
    msp.add_lwpolyline([(ox * k, oy * k), ((ox + 1) * k, oy * k), ((ox + 1) * k, (oy + 1) * k)], close=True, dxfattribs={"layer": "A-동외곽"})
    doc.saveas(path)


def site_5186():
    return Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True).transform(LON0, LAT0)


def test_cad_inspect_and_extract(tmp_path):
    ox, oy = site_5186()
    p = tmp_path / "a.dxf"
    make_dxf(p, ox, oy)
    info = cad.inspect(p)
    names = {l["name"]: l for l in info["layers"]}
    assert names["A-동외곽"]["closed"] == 3 and names["A-동외곽"]["hint"] == "BUILDING" and names["대지경계"]["hint"] == "SITE"
    assert info["unit_m"] == 0.001
    ex = cad.extract(p, ["A-동외곽"], "대지경계", 0.001)
    got = {b["id"]: b for b in ex["buildings"]}
    assert set(got) == {"201", "202"} and got["201"]["floors"] == 25 and got["202"]["floors"] == 20
    assert abs(got["201"]["area_m2"] - 480) < 1 and ex["boundary"] is not None


def test_similarity_two_points():
    T = cad.similarity_from_points([[0, 0], [10, 0]], [[5, 5], [5, 25]], allow_scale=True)
    assert abs(T["scale"] - 2) < 1e-9 and abs(T["rotation_deg"] - 90) < 1e-9
    assert cad.apply_similarity([[10, 0]], T) == [[5.0, 25.0]]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_layout_upload_end_to_end(client, tmp_path):
    pr = client.post("/api/projects", json={"name": "도면 입력 테스트"}).json()
    pid = pr["id"]
    ox, oy = site_5186()
    p = tmp_path / "b.dxf"
    make_dxf(p, ox, oy, gap=20.0)
    up = client.post(f"/api/projects/{pid}/drawings", files={"file": ("변경안.dxf", p.read_bytes(), "application/dxf")}).json()
    assert up["kind"] == "DXF" and up["crs_candidates"][0]["crs"] == "EPSG:5186" and up["crs_candidates"][0]["distance_to_site_m"] < 100
    ex = client.post(f"/api/projects/{pid}/drawings/{up['drawing_id']}/extract",
                     json={"building_layers": ["A-동외곽"], "boundary_layer": "대지경계", "unit_m": up["unit_guess_m"]}).json()
    body = {"buildings": [{"id": b["id"], "floors": b["floors"], "ring": b["ring"]} for b in ex["buildings"]], "boundary": ex["boundary"],
            "placement": {"mode": "crs", "crs": "EPSG:5186"}, "source": {"drawing_id": up["drawing_id"], "filename": "변경안.dxf"}}
    r = client.put(f"/api/projects/{pid}/scenarios/B/layout", json=body)
    assert r.status_code == 200, r.text
    lay = r.json()
    # ENU footprint of 201 sits ~20 m west of the origin, 40 m wide
    xs = [x for x, _ in lay["buildings"][0]["footprint"]]
    assert abs(max(xs) - min(xs) - 40) < 0.5 and abs(min(xs) + 20) < 2
    sc = client.get(f"/api/projects/{pid}/scene?scenario=B").json()
    mains = {b["id"]: b for b in sc["buildings"] if b["kind"] == "MAIN"}
    assert set(mains) == {"201", "202"} and mains["201"]["floors"] == 25
    bx = [q[0] for q in sc["site_boundary"]]
    assert abs(min(bx) + 80) < 2 and abs(max(bx) - 80) < 2
    # slider edits are refused on a drawn scenario
    sid = next(x["id"] for x in client.get(f"/api/projects/{pid}").json()["scenarios"] if x["code"] == "B")
    assert client.patch(f"/api/scenarios/{sid}/buildings/201", json={"dx": 1}).status_code == 400
    # missing floors -> 422
    body["buildings"][0]["floors"] = None
    assert client.put(f"/api/projects/{pid}/scenarios/B/layout", json=body).status_code == 422
    assert client.delete(f"/api/projects/{pid}/scenarios/B/layout").status_code == 200
