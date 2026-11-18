"""DEM inspection, failure paths, synthetic labelling, pad joint QA."""
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

from app.geo.enu import LocalFrame
from app.geo.terrain import SYNTHETIC, USER_UPLOADED, DemSampler, build_ground, horizon_check, inspect_dem, write_synthetic_dem

FR = LocalFrame(37.5559943, 126.7545222)


def _tif(path: Path, arr, crs="EPSG:5179", nodata=-9999.0, x0=None, y1=None, res=30.0):
    from pyproj import Transformer
    if x0 is None:
        cx, cy = Transformer.from_crs("EPSG:4326", "EPSG:5179", always_xy=True).transform(FR.lon0, FR.lat0)
        x0, y1 = cx - arr.shape[1] * res / 2, cy + arr.shape[0] * res / 2
    with rasterio.open(path, "w", driver="GTiff", width=arr.shape[1], height=arr.shape[0], count=1, dtype="float32",
                       crs=crs, transform=from_origin(x0, y1, res, res), nodata=nodata) as d:
        d.write(arr.astype("float32"), 1)
    return path


def test_synthetic_dem_is_labelled_and_30m(tmp_path):
    p = write_synthetic_dem(tmp_path / "s.tif", FR)
    info = inspect_dem(p, SYNTHETIC)
    assert info.ok and info.data_class == SYNTHETIC
    assert info.vertical_datum_status == "SYNTHETIC_UNIFIED"
    assert abs(info.cell_size_x - 30.0) < 1e-6
    with rasterio.open(p) as d:
        assert d.tags()["DATA_CLASS"] == "SYNTHETIC"


def test_uploaded_dem_without_vertical_datum_is_unresolved(tmp_path):
    p = _tif(tmp_path / "u.tif", np.full((140, 140), 20.0))
    info = inspect_dem(p, USER_UPLOADED)
    assert info.ok and info.vertical_datum_status == "UNRESOLVED"
    assert any("vertical_datum_unresolved" in w for w in info.warnings)


def test_missing_crs_is_rejected(tmp_path):
    p = tmp_path / "nocrs.tif"
    with rasterio.open(p, "w", driver="GTiff", width=10, height=10, count=1, dtype="float32", transform=from_origin(0, 10, 1, 1)) as d:
        d.write(np.ones((10, 10), "float32"), 1)
    info = inspect_dem(p, USER_UPLOADED)
    assert not info.ok and any("CRS" in e for e in info.errors)


def test_all_nodata_rejected_and_partial_nodata_warned(tmp_path):
    p = _tif(tmp_path / "nd.tif", np.full((20, 20), -9999.0))
    assert not inspect_dem(p, USER_UPLOADED).ok
    a = np.full((140, 140), 15.0)
    a[:10, :10] = -9999.0
    info = inspect_dem(_tif(tmp_path / "pnd.tif", a), USER_UPLOADED)
    assert info.ok and info.nodata_ratio > 0 and any("NoData" in w for w in info.warnings)


def test_dsm_hint_flags_double_modelling(tmp_path):
    p = _tif(tmp_path / "Copernicus_DSM_COG_10_N37_00_E126_00_DEM.tif", np.full((140, 140), 20.0))
    info = inspect_dem(p, USER_UPLOADED, name_hint=p.name)
    assert info.surface_type == "DSM_POSSIBLE"


def test_geographic_dem_reports_metre_cell_size(tmp_path):
    res = 1 / 3600.0  # 1 arc-second
    arr = np.full((300, 300), 12.0)
    p = _tif(tmp_path / "srtm.tif", arr, crs="EPSG:4326", x0=FR.lon0 - 150 * res, y1=FR.lat0 + 150 * res, res=res)
    info = inspect_dem(p, USER_UPLOADED)
    assert 24 < info.cell_size_x < 32
    s = DemSampler(p, FR)
    assert np.isclose(s.sample_xy(np.array([0.0]), np.array([0.0]))[0], 12.0)


def test_sampler_outside_coverage_is_nan(tmp_path):
    p = _tif(tmp_path / "small.tif", np.full((20, 20), 5.0))
    s = DemSampler(p, FR)
    v = s.sample_xy(np.array([0.0, 5000.0]), np.array([0.0, 0.0]))
    assert np.isfinite(v[0]) and np.isnan(v[1])


def test_pad_joint_and_horizon_qa(tmp_path):
    p = write_synthetic_dem(tmp_path / "s.tif", FR)
    g = build_ground(DemSampler(p, FR), (-150, -150, 150, 150))
    assert g.qa["blend_band_slope_max_deg"] < 20
    v, t = g.mesh()
    assert len(t) > 0 and np.isfinite(v).all()
    # pad is flat at pad_z inside the pad rectangle
    assert abs(g.height_at(0, 0) - g.pad_z) < 1e-9 and abs(g.height_at(140, -140) - g.pad_z) < 1e-9
    hz = horizon_check(g, 2.5)
    assert "outside_region_obstruction_possible" in hz
    g2 = build_ground(DemSampler(p, FR), (-150, -150, 150, 150), pad_offset_m=3.0)
    assert abs(g2.pad_z - g.pad_z - 3.0) < 1e-9


def test_clip_large_dem_keeps_grid_and_provenance(tmp_path):
    from app.geo.terrain import clip_dem_to_aoi
    big = _tif(tmp_path / "srtm_dem_30.tif", np.arange(600 * 600, dtype=float).reshape(600, 600) % 97, res=26.0)
    out = clip_dem_to_aoi(big, tmp_path / "clip.tif", FR, 3000.0, {"path": str(big), "sha256": "abc"})
    with rasterio.open(big) as a, rasterio.open(out) as b:
        assert b.crs == a.crs and abs(b.res[0] - a.res[0]) < 1e-9  # same grid, no resampling
        assert 220 <= b.width <= 236 and 220 <= b.height <= 236  # ~6000 m / 26 m
        r0, c0 = a.index(*b.xy(0, 0))
        assert a.read(1)[r0, c0] == b.read(1)[0, 0]  # identical values
        assert b.tags()["SOURCE_SHA256"] == "abc" and b.tags()["DATA_CLASS"] == "USER_UPLOADED"


def test_srtm_flagged_as_surface_model_and_region_choice(tmp_path):
    from app.services import ground_region_for
    big = _tif(tmp_path / "srtm_dem_30.tif", np.full((600, 600), 10.0), res=26.0)
    info = inspect_dem(big, USER_UPLOADED, name_hint=big.name)
    assert info.surface_type == "DSM_POSSIBLE" and any("SRTM" in w for w in info.warnings)
    assert ground_region_for(big, FR, USER_UPLOADED) == (4800.0, 20.0)  # covers ±4.8 km
    small = _tif(tmp_path / "small.tif", np.full((140, 140), 10.0))
    assert ground_region_for(small, FR, USER_UPLOADED) == (1200.0, 10.0)
    assert ground_region_for(big, FR, SYNTHETIC) == (1200.0, 10.0)
