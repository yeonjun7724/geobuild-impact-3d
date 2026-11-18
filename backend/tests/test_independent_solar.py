"""Independent cross-check of pvlib NREL SPA against a separately implemented NOAA solar-position algorithm.

The NOAA (Meeus-based) algorithm is accurate to ~0.01-0.02 degree for these years; agreement within 0.05 degree in
geometric elevation and azimuth over a full year of samples at the site validates the sun vectors used by A/B.
"""
import math
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pvlib

LAT, LON = 37.5559943, 126.7545222


def noaa(dt_utc: datetime, lat: float, lon: float) -> tuple[float, float]:
    jd = dt_utc.timestamp() / 86400.0 + 2440587.5
    T = (jd - 2451545.0) / 36525.0
    L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360
    M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
    e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
    Mr = math.radians(M)
    C = math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) + math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + math.sin(3 * Mr) * 0.000289
    true_long = L0 + C
    omega = 125.04 - 1934.136 * T
    lam = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))
    eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
    eps = eps0 + 0.00256 * math.cos(math.radians(omega))
    decl = math.degrees(math.asin(math.sin(math.radians(eps)) * math.sin(math.radians(lam))))
    y = math.tan(math.radians(eps / 2)) ** 2
    L0r = math.radians(L0)
    eot = 4 * math.degrees(y * math.sin(2 * L0r) - 2 * e * math.sin(Mr) + 4 * e * y * math.sin(Mr) * math.cos(2 * L0r)
                           - 0.5 * y * y * math.sin(4 * L0r) - 1.25 * e * e * math.sin(2 * Mr))
    minutes = dt_utc.hour * 60 + dt_utc.minute + dt_utc.second / 60
    tst = (minutes + eot + 4 * lon) % 1440
    ha = tst / 4 - 180
    latr, dr, har = math.radians(lat), math.radians(decl), math.radians(ha)
    cosz = math.sin(latr) * math.sin(dr) + math.cos(latr) * math.cos(dr) * math.cos(har)
    zen = math.degrees(math.acos(max(-1, min(1, cosz))))
    az = math.degrees(math.atan2(math.sin(har), math.cos(har) * math.sin(latr) - math.tan(dr) * math.cos(latr))) + 180
    return 90 - zen, az % 360


def test_pvlib_matches_independent_noaa_over_a_year():
    times = []
    t0 = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
    for d in range(0, 365, 7):
        for h in (0, 2, 4, 6, 8):  # 09-17 KST daytime
            times.append(t0 + timedelta(days=d, hours=h, minutes=17))
    sp = pvlib.solarposition.get_solarposition(pd.DatetimeIndex(times), LAT, LON, method="nrel_numpy")
    el_err, az_err = [], []
    for t, el_p, az_p in zip(times, sp["elevation"], sp["azimuth"]):
        el_n, az_n = noaa(t, LAT, LON)
        if el_n > 2:
            el_err.append(abs(el_p - el_n))
            az_err.append(abs((az_p - az_n + 180) % 360 - 180))
    assert len(el_err) > 150
    assert max(el_err) < 0.05, max(el_err)
    assert max(az_err) < 0.05, max(az_err)


def test_solstice_day_noaa_vs_analysis_window():
    from app.analysis.solar import sample_window
    s = sample_window(date(2026, 12, 22), "08:00", "16:00", 30, LAT, LON)
    for t, az in zip(s.times_local, s.azimuth_deg):
        _, az_n = noaa(t.astimezone(timezone.utc), LAT, LON)
        assert abs((az - az_n + 180) % 360 - 180) < 0.05
    # apparent elevation (used for direct sun) exceeds geometric by the refraction term, never by more than ~0.6 deg
    geo = np.array([noaa(t.astimezone(timezone.utc), LAT, LON)[0] for t in s.times_local])
    diff = s.elevation_deg - geo
    assert (diff > 0).all() and diff.max() < 0.6
