"""Resolve a scenario (baseline geometry + per-building transforms) into an analysis scene.

The resolved snapshot (footprints, heights, base elevations, receivers) is what both the ray-casting
engine and the Cesium viewer consume, so visualisation and computation share one geometry.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

import numpy as np
from shapely.geometry import Polygon, box, mapping

from ..analysis.raycast import Engine, make_engine
from ..geo.terrain import GroundModel
from .geometry import (
    Receiver,
    building_height,
    extrude,
    make_receivers,
    polygons_of,
    transform_footprint,
    validate_footprint,
)


def stable_hash(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, default=float).encode()).hexdigest()


@dataclass
class ResolvedBuilding:
    id: str
    name: str
    kind: str  # MAIN | CONTEXT
    data_class: str
    footprint_baseline: Polygon
    footprint: Polygon
    floors: int
    height_m: float
    base_z: float
    transform: dict
    warnings: list[str] = field(default_factory=list)
    units_per_floor: int | None = None

    @property
    def top_z(self) -> float:
        return self.base_z + self.height_m

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "data_class": self.data_class,
            "footprint": [list(map(lambda v: round(v, 4), c)) for c in self.footprint.exterior.coords],
            "footprint_baseline": [list(map(lambda v: round(v, 4), c)) for c in self.footprint_baseline.exterior.coords],
            "floors": self.floors,
            "height_m": round(self.height_m, 3),
            "base_z": round(self.base_z, 3),
            "top_z": round(self.top_z, 3),
            "transform": self.transform,
            "centroid": [round(self.footprint.centroid.x, 3), round(self.footprint.centroid.y, 3)],
            "footprint_area_m2": round(self.footprint.area, 2),
            "warnings": self.warnings,
        }


def _base_z_on_ground(poly: Polygon, ground: GroundModel) -> float:
    pts = list(poly.exterior.coords) + [(poly.centroid.x, poly.centroid.y)]
    zs = [ground.height_at(x, y) for x, y in pts]
    return float(np.nanmin(zs))


LAYOUT_KEY = "__layout__"  # a scenario entered as its own drawing (DXF/PDF) instead of transforms of the baseline


def changed_ids(A: list[ResolvedBuilding], B: list[ResolvedBuilding]) -> set[str]:
    """Main buildings whose footprint or floor count differ between A and B (or exist in only one)."""
    ia = {b.id: b for b in A if b.kind == "MAIN"}
    ib = {b.id: b for b in B if b.kind == "MAIN"}
    out = set(ia) ^ set(ib)
    for k in set(ia) & set(ib):
        a, b = ia[k], ib[k]
        if a.floors != b.floors or a.footprint.symmetric_difference(b.footprint).area > 0.01:
            out.add(k)
    return out


def resolve_scenario(site: dict, transforms: dict, ground: GroundModel) -> list[ResolvedBuilding]:
    pad = box(*ground.pad_rect)
    out = []
    layout = (transforms or {}).get(LAYOUT_KEY)
    if layout:
        srcs = [{**b, "kind": "MAIN", "data_class": b.get("data_class", "USER_UPLOADED")} for b in layout["buildings"]] + \
               [b for b in site["buildings"] if b["kind"] != "MAIN"]
        transforms = {}
    else:
        srcs = site["buildings"]
    for b in srcs:
        fp0 = validate_footprint(Polygon(b["footprint"]))
        if len(polygons_of(fp0)) != 1:
            raise ValueError(f"{b['id']}: 멀티파트 건물은 부분별 건물로 분리하여 입력하세요")
        tr = {"dx": 0.0, "dy": 0.0, "rot_deg": 0.0, "floors_delta": 0}
        tr.update({k: v for k, v in (transforms.get(b["id"]) or {}).items() if k in tr})
        if b["kind"] != "MAIN" and any(tr[k] for k in tr):
            raise ValueError(f"{b['id']}: 주변 참고 건물은 편집할 수 없음")
        c = fp0.centroid
        fp = transform_footprint(fp0, float(tr["dx"]), float(tr["dy"]), float(tr["rot_deg"]), (c.x, c.y))
        floors = int(b["floors"]) + int(tr["floors_delta"])
        if floors < 1:
            raise ValueError(f"{b['id']}: 층수는 1 이상이어야 함")
        warns = []
        if b["kind"] == "MAIN":
            base = ground.pad_z
            if not pad.contains(fp):
                warns.append("footprint가 가상 계획지반(pad) 밖으로 벗어남 - 지반고 가정 부정확")
        else:
            base = _base_z_on_ground(fp, ground)
        out.append(
            ResolvedBuilding(
                id=b["id"], name=b.get("name", b["id"]), kind=b["kind"], data_class=b.get("data_class", "SYNTHETIC"),
                footprint_baseline=fp0, footprint=fp, floors=floors, height_m=building_height(floors),
                base_z=base, transform=tr, warnings=warns, units_per_floor=b.get("units_per_floor"),
            )
        )
    # overlap check between buildings
    for i, a in enumerate(out):
        for bb in out[i + 1:]:
            if a.footprint.intersects(bb.footprint) and a.footprint.intersection(bb.footprint).area > 1e-6:
                msg = f"{a.id}↔{bb.id} footprint 중첩"
                a.warnings.append(msg)
                bb.warnings.append(msg)
    return out


@dataclass
class Scene:
    engine: Engine
    buildings: list[ResolvedBuilding]
    receivers: list[Receiver]
    ground: GroundModel
    extent_m: float

    def building_index(self) -> dict[str, ResolvedBuilding]:
        return {b.id: b for b in self.buildings}


def building_mesh(b: ResolvedBuilding) -> tuple[np.ndarray, np.ndarray]:
    return extrude(b.footprint, b.base_z, b.top_z)


def build_scene(buildings: list[ResolvedBuilding], ground: GroundModel, engine_pref: str = "open3d",
                include_receivers: bool = True, ground_mesh=None) -> Scene:
    eng = make_engine(engine_pref)
    gv, gt = ground_mesh if ground_mesh is not None else ground.mesh()
    eng.add_mesh("TERRAIN", gv, gt)
    receivers: list[Receiver] = []
    for b in buildings:
        v, t = building_mesh(b)
        eng.add_mesh(b.id, v, t)
        if include_receivers and b.kind == "MAIN":
            receivers.extend(make_receivers(b.id, b.footprint_baseline, b.footprint, b.base_z, b.floors))
    # extent of the analysis targets (buildings / receivers / site grid), which sets float32 precision near the rays'
    # origins; the far terrain only acts as an occluder
    xy = np.concatenate([np.asarray(b.footprint.exterior.coords)[:, :2] for b in buildings]) if buildings else np.zeros((1, 2))
    extent = float(max(300.0, 2.0 * np.abs(xy).max()))
    return Scene(eng, buildings, receivers, ground, extent)


def snapshot_json(buildings: list[ResolvedBuilding]) -> dict:
    data = [b.to_json() for b in buildings]
    return {"buildings": data, "geometry_hash": stable_hash([{k: d[k] for k in ("id", "footprint", "height_m", "base_z")} for d in data])}


def footprint_geojson(b: ResolvedBuilding, frame) -> dict:
    """GeoJSON Feature in WGS84 lon/lat (for export / Cesium overlays)."""
    xy = np.asarray(b.footprint.exterior.coords)[:, :2]
    lon, lat = frame.enu_xy_to_lonlat(xy)
    return {
        "type": "Feature",
        "properties": {k: v for k, v in b.to_json().items() if k not in ("footprint", "footprint_baseline")},
        "geometry": {"type": "Polygon", "coordinates": [[[float(a), float(c)] for a, c in zip(lon, lat)]]},
    }


__all__ = ["resolve_scenario", "build_scene", "Scene", "ResolvedBuilding", "snapshot_json", "stable_hash", "mapping"]
