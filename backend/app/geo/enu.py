"""Local East-North-Up frame anchored at the AOI reference point.

All horizontal distances / areas and all 3D ray casting are done in this metric frame.
WGS84 geodetic <-> ECEF uses pyproj (EPSG:4979 -> EPSG:4978). Heights passed to
`to_ecef` are *ellipsoidal* heights of the frame; the project vertical datum handling
(see terrain.py) decides what the local z means.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import cached_property

import numpy as np
from pyproj import Transformer

_GEOD_TO_ECEF = Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)
_ECEF_TO_GEOD = Transformer.from_crs("EPSG:4978", "EPSG:4979", always_xy=True)

PROJECTED_CRS = "EPSG:5179"  # Korea 2000 / Unified CS, used for exchange & DEM handling


@dataclass(frozen=True)
class LocalFrame:
    lat0: float
    lon0: float
    h0: float = 0.0  # ellipsoidal height of the ENU origin

    @cached_property
    def ecef0(self) -> np.ndarray:
        x, y, z = _GEOD_TO_ECEF.transform(self.lon0, self.lat0, self.h0)
        return np.array([x, y, z], dtype=np.float64)

    @cached_property
    def rot(self) -> np.ndarray:
        """Rotation matrix ECEF-delta -> ENU."""
        phi = np.radians(self.lat0)
        lam = np.radians(self.lon0)
        sp, cp, sl, cl = np.sin(phi), np.cos(phi), np.sin(lam), np.cos(lam)
        return np.array(
            [
                [-sl, cl, 0.0],
                [-sp * cl, -sp * sl, cp],
                [cp * cl, cp * sl, sp],
            ]
        )

    # --- ECEF <-> ENU ---------------------------------------------------
    def ecef_to_enu(self, xyz: np.ndarray) -> np.ndarray:
        xyz = np.atleast_2d(np.asarray(xyz, dtype=np.float64))
        return (xyz - self.ecef0) @ self.rot.T

    def enu_to_ecef(self, enu: np.ndarray) -> np.ndarray:
        enu = np.atleast_2d(np.asarray(enu, dtype=np.float64))
        return enu @ self.rot + self.ecef0

    # --- geodetic <-> ENU -----------------------------------------------
    def geodetic_to_enu(self, lon, lat, h) -> np.ndarray:
        x, y, z = _GEOD_TO_ECEF.transform(np.asarray(lon), np.asarray(lat), np.asarray(h))
        return self.ecef_to_enu(np.column_stack([np.ravel(x), np.ravel(y), np.ravel(z)]))

    def enu_to_geodetic(self, enu: np.ndarray):
        ecef = self.enu_to_ecef(enu)
        lon, lat, h = _ECEF_TO_GEOD.transform(ecef[:, 0], ecef[:, 1], ecef[:, 2])
        return np.asarray(lon), np.asarray(lat), np.asarray(h)

    # --- horizontal helpers (2D, z ignored) -------------------------------
    def enu_xy_to_lonlat(self, xy: np.ndarray):
        xy = np.atleast_2d(np.asarray(xy, dtype=np.float64))
        enu = np.column_stack([xy[:, 0], xy[:, 1], np.zeros(len(xy))])
        lon, lat, _ = self.enu_to_geodetic(enu)
        return lon, lat

    def enu_xy_to_crs(self, xy: np.ndarray, crs: str = PROJECTED_CRS):
        lon, lat = self.enu_xy_to_lonlat(xy)
        t = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        return t.transform(lon, lat)

    def crs_to_enu_xy(self, x, y, crs: str) -> np.ndarray:
        t = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        lon, lat = t.transform(np.asarray(x, dtype=float), np.asarray(y, dtype=float))
        enu = self.geodetic_to_enu(np.ravel(lon), np.ravel(lat), np.zeros(np.size(lon)))
        return enu[:, :2]

    def cesium_model_matrix(self) -> list[float]:
        """Column-major 4x4 ENU->ECEF matrix (identical to Cesium Transforms.eastNorthUpToFixedFrame)."""
        m = np.eye(4)
        m[:3, :3] = self.rot.T
        m[:3, 3] = self.ecef0
        return m.T.reshape(-1).tolist()
