"""Sun position (pvlib NREL SPA) and time sampling rules.

Time rule (midpoint rule): the window [start, end) is split into intervals of dt minutes. Each interval is
represented by the sun position at its midpoint and contributes dt minutes. Total direct-sun time therefore has
a discretisation error of at most dt/2 per sun/shade transition.

Cesium and pvlib must use the same instant: local Asia/Seoul wall time -> timezone-aware -> UTC ISO strings.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pvlib

TZ_NAME = "Asia/Seoul"
SOLAR_METHOD = "nrel_numpy"
ELEVATION_FIELD = "apparent_elevation"  # refraction-corrected (pvlib default atmosphere: 1013.25 hPa, 12 °C)


@dataclass
class SunSeries:
    times_local: list[datetime]
    times_utc_iso: list[str]
    azimuth_deg: np.ndarray
    elevation_deg: np.ndarray
    vectors: np.ndarray  # (T, 3) ENU unit vectors pointing to the sun
    dt_min: float
    rule: str


def sun_vector(azimuth_deg, elevation_deg) -> np.ndarray:
    """ENU unit vector toward the sun. Azimuth: 0 = north, 90 = east (clockwise)."""
    az = np.radians(np.asarray(azimuth_deg, dtype=float))
    el = np.radians(np.asarray(elevation_deg, dtype=float))
    return np.stack([np.cos(el) * np.sin(az), np.cos(el) * np.cos(az), np.sin(el)], axis=-1)


def parse_local_window(day: date, start_hhmm: str, end_hhmm: str, tz_name: str = TZ_NAME) -> tuple[datetime, datetime]:
    try:
        tz = ZoneInfo(tz_name)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"알 수 없는 시간대: {tz_name}") from exc
    h0, m0 = (int(v) for v in start_hhmm.split(":"))
    h1, m1 = (int(v) for v in end_hhmm.split(":"))
    start = datetime(day.year, day.month, day.day, h0, m0, tzinfo=tz)
    end = datetime(day.year, day.month, day.day, h1, m1, tzinfo=tz)
    if end <= start:
        raise ValueError("분석 종료 시각이 시작 시각보다 같거나 빠름")
    return start, end


def solar_positions(times_local: list[datetime], lat: float, lon: float, altitude_m: float = 0.0):
    idx = pd.DatetimeIndex(times_local)
    sp = pvlib.solarposition.get_solarposition(idx, lat, lon, altitude=altitude_m, method=SOLAR_METHOD)
    return sp["azimuth"].to_numpy(dtype=float), sp[ELEVATION_FIELD].to_numpy(dtype=float)


def sample_window(day: date, start_hhmm: str, end_hhmm: str, dt_min: float, lat: float, lon: float,
                  tz_name: str = TZ_NAME) -> SunSeries:
    start, end = parse_local_window(day, start_hhmm, end_hhmm, tz_name)
    total = (end - start).total_seconds() / 60.0
    n = int(round(total / dt_min))
    if abs(n * dt_min - total) > 1e-6:
        raise ValueError(f"분석 시간({total}분)이 간격 {dt_min}분으로 나누어 떨어지지 않음")
    times = [start + timedelta(minutes=(i + 0.5) * dt_min) for i in range(n)]
    az, el = solar_positions(times, lat, lon)
    return SunSeries(
        times_local=times,
        times_utc_iso=[t.astimezone(ZoneInfo("UTC")).isoformat().replace("+00:00", "Z") for t in times],
        azimuth_deg=az,
        elevation_deg=el,
        vectors=sun_vector(az, el),
        dt_min=dt_min,
        rule="interval-midpoint",
    )


def instants(day: date, hhmm_list: list[str], lat: float, lon: float, tz_name: str = TZ_NAME) -> SunSeries:
    tz = ZoneInfo(tz_name)
    times = []
    for s in hhmm_list:
        h, m = (int(v) for v in s.split(":"))
        times.append(datetime(day.year, day.month, day.day, h, m, tzinfo=tz))
    az, el = solar_positions(times, lat, lon)
    return SunSeries(times, [t.astimezone(ZoneInfo("UTC")).isoformat().replace("+00:00", "Z") for t in times],
                     az, el, sun_vector(az, el), 0.0, "instant")
