"""Surrounding buildings from a GIS건물통합정보-style SHP zip (CP949 attributes, EPSG:5186 .prj)."""
import io
import zipfile

import pytest
import shapefile
from fastapi.testclient import TestClient
from pyproj import CRS, Transformer

from app.main import app

LAT0, LON0 = 37.5559943, 126.7545222


def make_shp_zip(rows) -> bytes:
    """rows: (dx, dy, w, d, A9 용도, A16 높이, A24 건물명, A26 지상층수) around the site origin, metres."""
    ox, oy = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True).transform(LON0, LAT0)
    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    w = shapefile.Writer(shp=shp, shx=shx, dbf=dbf, shapeType=shapefile.POLYGON, encoding="cp949")
    for f, n in (("A9", 40), ("A24", 60), ("A26", 10)):
        w.field(f, "C" if f != "A26" else "N", n)
    w.field("A16", "N", 10, 2)
    for dx, dy, ww, dd, use, h, name, fl in rows:
        x0, y0 = ox + dx, oy + dy
        w.poly([[(x0, y0), (x0, y0 + dd), (x0 + ww, y0 + dd), (x0 + ww, y0), (x0, y0)]])
        w.record(use, name, fl, h)
    w.close()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("AL_D010_28_20261101.shp", shp.getvalue())
        z.writestr("AL_D010_28_20261101.shx", shx.getvalue())
        z.writestr("AL_D010_28_20261101.dbf", dbf.getvalue())
        z.writestr("AL_D010_28_20261101.prj", CRS.from_epsg(5186).to_wkt())
    return buf.getvalue()


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_context_shp_import(client):
    pid = client.post("/api/projects", json={"name": "주변건물 테스트"}).json()["id"]
    data = make_shp_zip([
        (-60, 170, 50, 14, "공동주택", 43.0, "계양센트럴 아파트", 14),   # north neighbour, height wins
        (160, -20, 20, 20, "제1종근린생활시설", 0, "상가", 3),          # non-residential, floors only
        (-20, -20, 30, 30, "공동주택", 30.0, "대지 안 기존 건물", 10),   # inside the site -> dropped
        (900, 900, 30, 30, "공동주택", 30.0, "먼 아파트", 10),          # outside radius -> dropped
    ])
    r = client.post(f"/api/projects/{pid}/context-buildings", files={"file": ("건물통합정보.zip", data, "application/zip")}, data={"radius_m": "400"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["accepted"] == 2 and j["skipped"]["far"] == 1 and j["skipped"]["in_site"] == 1
    assert j["fields"]["floors"] == "A26" and j["fields"]["height"] == "A16" and j["n_residential"] == 1
    sc = client.get(f"/api/projects/{pid}/scene?scenario=A").json()
    ctx = {b["id"]: b for b in sc["buildings"] if b["kind"] == "CONTEXT"}
    assert set(ctx) == {"N001", "N002"}
    apt = next(b for b in ctx.values() if "아파트" in b["name"])
    assert apt["floors"] == 14  # (43 - 1.2) / 2.9 = 14.4 -> 14
