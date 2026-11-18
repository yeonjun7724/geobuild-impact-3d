"""Sun position, time handling and coordinate frame tests."""
import math
from datetime import date

import numpy as np
import pytest

from app.analysis.solar import instants, parse_local_window, sample_window, sun_vector
from app.geo.enu import LocalFrame
from app.analysis.qa import roundtrip

LAT, LON = 37.5559943, 126.7545222
FR = LocalFrame(LAT, LON)


def test_sun_vector_cardinal_directions():
    assert np.allclose(sun_vector(0, 0), [0, 1, 0], atol=1e-12)  # north on horizon
    assert np.allclose(sun_vector(90, 0), [1, 0, 0], atol=1e-12)  # east
    assert np.allclose(sun_vector(180, 30), [0, -math.cos(math.radians(30)), 0.5], atol=1e-12)  # south, 30° up
    assert np.allclose(sun_vector(123, 90), [0, 0, 1], atol=1e-12)  # zenith
    v = sun_vector(np.arange(0, 360, 7.0), np.full(52, 17.0))
    assert np.allclose(np.linalg.norm(v, axis=1), 1.0)


def test_winter_solstice_noon_sun_is_south_and_low():
    s = instants(date(2026, 12, 22), ["12:00", "12:30"], LAT, LON)
    # solar noon at 126.75E (KST meridian 135E) is ~12:33 KST -> azimuth slightly east of south before it
    assert 170 < s.azimuth_deg[0] < 182
    # noon elevation ~ 90 - 37.56 - 23.44 = 29.0° (+ refraction ~0.03°)
    assert abs(s.elevation_deg.max() - 29.0) < 0.3
    assert s.vectors[1][1] < 0  # pointing south -> shadows fall north


def test_kst_to_utc_same_instant_for_cesium():
    s = instants(date(2026, 12, 22), ["09:00"], LAT, LON)
    assert s.times_utc_iso[0] == "2026-12-22T00:00:00Z"


def test_midpoint_sampling_rule():
    s = sample_window(date(2026, 12, 22), "08:00", "16:00", 5, LAT, LON)
    assert len(s.times_local) == 96
    assert s.times_local[0].strftime("%H:%M:%S") == "08:02:30"
    assert s.times_local[-1].strftime("%H:%M:%S") == "15:57:30"
    # morning sun in the south-east, afternoon south-west
    assert s.azimuth_deg[0] < 180 < s.azimuth_deg[-1]
    assert (s.elevation_deg > 0).all()


def test_invalid_timezone_and_window():
    with pytest.raises(ValueError):
        parse_local_window(date(2026, 12, 22), "08:00", "16:00", "Mars/Olympus")
    with pytest.raises(ValueError):
        parse_local_window(date(2026, 12, 22), "16:00", "08:00")
    with pytest.raises(ValueError):
        sample_window(date(2026, 12, 22), "08:00", "16:00", 7, LAT, LON)  # 480/7 not integral


def test_enu_ecef_geodetic_roundtrip():
    rt = roundtrip(FR, (-150, -150, 150, 150))
    assert rt["max_error_geodetic_roundtrip_m"] < 1e-4
    assert rt["max_error_ecef_roundtrip_m"] < 1e-6
    # origin maps to (0,0,0)
    assert np.allclose(FR.geodetic_to_enu([LON], [LAT], [0.0]), 0, atol=1e-6)


def test_enu_matches_projected_crs_distances():
    """ENU (true local metres) vs EPSG:5179 grid distance: differ only by the TM scale factor (<0.1%)."""
    a, b = np.array([[-100.0, -50.0]]), np.array([[180.0, 120.0]])
    xa, ya = FR.enu_xy_to_crs(a)
    xb, yb = FR.enu_xy_to_crs(b)
    d_grid = math.hypot(xb[0] - xa[0], yb[0] - ya[0])
    d_enu = float(np.hypot(*(b - a)[0]))
    assert abs(d_grid / d_enu - 1) < 1e-3
    back = FR.crs_to_enu_xy(xa, ya, "EPSG:5179")
    assert np.allclose(back, a, atol=1e-3)


def test_cesium_model_matrix_maps_enu_origin_to_ecef():
    m = np.array(FR.cesium_model_matrix()).reshape(4, 4).T  # column-major -> row-major
    p = m @ np.array([10.0, 20.0, 5.0, 1.0])
    assert np.allclose(p[:3], FR.enu_to_ecef([[10.0, 20.0, 5.0]])[0], atol=1e-6)
