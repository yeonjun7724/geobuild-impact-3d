"""Building footprint validation, rigid transforms, triangulation, extrusion and facade receivers.

Coordinates are local ENU metres (x = East, y = North, z = Up).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from shapely import affinity
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
from shapely.geometry.polygon import orient
from shapely.validation import explain_validity

FLOOR_HEIGHT_M = 2.9
PARAPET_M = 1.2
WINDOW_CENTER_ABOVE_FLOOR_M = 1.5
RECEIVER_SPACING_M = 7.5


class GeometryError(ValueError):
    pass


def validate_footprint(geom, *, expect_metric: bool = True) -> Polygon | MultiPolygon:
    """Validate a footprint. Rejects GeometryCollection, empty, invalid and unit-suspicious geometry."""
    if isinstance(geom, dict):
        geom = shape(geom)
    if isinstance(geom, GeometryCollection) and not isinstance(geom, MultiPolygon):
        raise GeometryError("GeometryCollection은 건물 footprint로 사용할 수 없음 (Polygon/MultiPolygon만 허용)")
    if not isinstance(geom, (Polygon, MultiPolygon)):
        raise GeometryError(f"지원하지 않는 도형 유형: {geom.geom_type}")
    if geom.is_empty:
        raise GeometryError("빈 도형")
    if not geom.is_valid:
        raise GeometryError(f"무효 도형: {explain_validity(geom)}")
    if expect_metric:
        if geom.area < 4.0:
            raise GeometryError(f"면적 {geom.area:.6f} m² - 좌표 단위 오류(도 단위 경위도?) 의심")
        if geom.area > 1e6:
            raise GeometryError(f"면적 {geom.area:.0f} m² - 단일 건물로 비정상적으로 큼 (단위 오류 의심)")
    return geom


def polygons_of(geom) -> list[Polygon]:
    return list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]


def transform_footprint(geom, dx: float, dy: float, rot_deg: float, pivot: tuple[float, float]):
    """Rotate counter-clockwise (positive = CCW seen from above) about pivot, then translate."""
    g = affinity.rotate(geom, rot_deg, origin=pivot, use_radians=False)
    return affinity.translate(g, dx, dy)


# ---------------------------------------------------------------------------------------------
# triangulation (ear clipping, holes not supported for extrusion - validated upstream)
# ---------------------------------------------------------------------------------------------
def _ear_clip(pts: np.ndarray) -> list[tuple[int, int, int]]:
    n = len(pts)
    idx = list(range(n))
    tris: list[tuple[int, int, int]] = []

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def inside(p, a, b, c):
        return cross(a, b, p) >= -1e-12 and cross(b, c, p) >= -1e-12 and cross(c, a, p) >= -1e-12

    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        found = False
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = pts[i0], pts[i1], pts[i2]
            if cross(a, b, c) <= 1e-12:
                continue
            if any(inside(pts[j], a, b, c) for j in idx if j not in (i0, i1, i2)):
                continue
            tris.append((i0, i1, i2))
            idx.pop(k)
            found = True
            break
        if not found:
            raise GeometryError("다각형 삼각분할 실패 (자기교차 의심)")
    tris.append((idx[0], idx[1], idx[2]))
    return tris


def extrude(poly: Polygon, z0: float, z1: float) -> tuple[np.ndarray, np.ndarray]:
    """Closed prism mesh with outward-facing triangle winding."""
    if len(poly.interiors):
        raise GeometryError("중정(hole)이 있는 footprint는 PoC 메쉬 빌더에서 미지원")
    poly = orient(poly, sign=1.0)  # CCW exterior
    ring = np.asarray(poly.exterior.coords)[:-1, :2]
    n = len(ring)
    bottom = np.column_stack([ring, np.full(n, z0)])
    top = np.column_stack([ring, np.full(n, z1)])
    verts = np.vstack([bottom, top])
    tris: list[tuple[int, int, int]] = []
    for a, b, c in _ear_clip(ring):
        tris.append((n + a, n + b, n + c))  # top, CCW from above -> normal +z
        tris.append((a, c, b))  # bottom, normal -z
    for i in range(n):
        j = (i + 1) % n
        tris.append((i, j, n + j))
        tris.append((i, n + j, n + i))
    return verts, np.asarray(tris, dtype=np.int32)


def facade_label(nx: float, ny: float) -> str:
    az = (math.degrees(math.atan2(nx, ny)) + 360) % 360  # 0 = north, 90 = east
    return ["N", "E", "S", "W"][int(((az + 45) % 360) // 90)]


@dataclass
class Receiver:
    receiver_id: str
    building_id: str
    floor: int
    edge: int
    facade: str  # orientation label computed from the *baseline* geometry
    position: tuple[float, float, float]
    normal: tuple[float, float, float]


def make_receivers(
    building_id: str,
    poly_baseline: Polygon,
    poly_current: Polygon,
    base_z: float,
    floors: int,
    spacing: float = RECEIVER_SPACING_M,
) -> list[Receiver]:
    """Facade proxy receivers. IDs depend only on baseline edge order -> stable across A/B transforms.

    poly_current must be a rigid transform of poly_baseline (same vertex order)."""
    pb = orient(poly_baseline, sign=1.0)
    pc = orient(poly_current, sign=1.0)
    rb = np.asarray(pb.exterior.coords)[:-1, :2]
    rc = np.asarray(pc.exterior.coords)[:-1, :2]
    if len(rb) != len(rc):
        raise GeometryError("기준안/변경안 footprint 정점 수 불일치")
    out: list[Receiver] = []
    for e in range(len(rb)):
        a_b, b_b = rb[e], rb[(e + 1) % len(rb)]
        a, b = rc[e], rc[(e + 1) % len(rc)]
        L = float(np.hypot(*(b_b - a_b)))
        if L < 2.0:
            continue
        cnt = max(1, int(L // spacing))
        tb = (b_b - a_b) / L
        lab = facade_label(tb[1], -tb[0])  # CCW exterior -> outward normal = (ty, -tx)
        t = (b - a) / np.hypot(*(b - a))
        nrm = np.array([t[1], -t[0], 0.0])
        for k in range(cnt):
            s = (k + 0.5) / cnt
            p = a + (b - a) * s
            for f in range(1, floors + 1):
                z = base_z + (f - 1) * FLOOR_HEIGHT_M + WINDOW_CENTER_ABOVE_FLOOR_M
                out.append(
                    Receiver(
                        receiver_id=f"{building_id}-F{f:02d}-{lab}{e}-{k + 1:02d}",
                        building_id=building_id,
                        floor=f,
                        edge=e,
                        facade=lab,
                        position=(float(p[0]), float(p[1]), float(z)),
                        normal=(float(nrm[0]), float(nrm[1]), 0.0),
                    )
                )
    return out


def building_height(floors: int) -> float:
    return floors * FLOOR_HEIGHT_M + PARAPET_M


def to_geojson(geom) -> dict:
    return mapping(geom)
