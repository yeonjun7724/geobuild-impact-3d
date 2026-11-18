"""Project, dataset and scenario services (shared by API and worker)."""
from __future__ import annotations

import json
import shutil
from dataclasses import asdict
from functools import lru_cache
from pathlib import Path

import numpy as np
from pyproj import CRS as PCRS
from shapely.geometry import Polygon, shape
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import DATA_DIR
from .db import (Building, Dataset, OpenSpacePolygon, Project, ProvenanceRecord, Scenario,
                 ScenarioBuildingTransform, SitePad, TerrainSource)
from .geo.enu import LocalFrame, PROJECTED_CRS
from .geo.terrain import SYNTHETIC, USER_UPLOADED, DemSampler, GroundModel, build_ground, inspect_dem, write_synthetic_dem
from .scene import demo
from .scene.builder import stable_hash
from .scene.geometry import GeometryError, validate_footprint


class ServiceError(ValueError):
    pass


def project_dir(pid: str) -> Path:
    p = DATA_DIR / "projects" / pid
    p.mkdir(parents=True, exist_ok=True)
    return p


def frame_of(p: Project) -> LocalFrame:
    return LocalFrame(p.frame["lat0"], p.frame["lon0"], p.frame.get("h0", 0.0))


def create_project(s: Session, name: str, site_key: str = "incheon-gyeyang-a2") -> Project:
    if site_key != demo.SITE_META["key"]:
        raise ServiceError("현재 PoC는 인천계양(incheon-gyeyang-a2) 대상지만 지원 (부천대장은 후속 후보)")
    meta = dict(demo.SITE_META)
    p = Project(name=name, site_key=site_key, site_meta=meta,
                frame={"lat0": meta["lat0"], "lon0": meta["lon0"], "h0": 0.0, "crs_projected": PROJECTED_CRS,
                       "frame_type": "LOCAL_ENU", "origin_source": "LH 공고 페이지 지도 마커 좌표 (경계 아님)"},
                site_rect=list(demo.SITE_RECT), status="EMPTY")
    s.add(p)
    s.flush()
    s.add(ProvenanceRecord(project_id=p.id, subject="site_location", data_class="REAL_OFFICIAL",
                           source="LH 청약플러스 인천계양 A2블록 공공분양주택 입주자모집공고 페이지 (소재지·지도 마커)",
                           url=demo.LH_URL, accessed="2026-11-18", license="공개 웹페이지 (사실정보 인용)",
                           note="대표점 좌표만 확인. 블록 경계·단지배치·창호 좌표·실제 설계변경 정보는 확보하지 않음."))
    s.add(ProvenanceRecord(project_id=p.id, subject="location_cross_check", data_class="REAL_OFFICIAL",
                           source="OpenStreetMap Nominatim - 동양동 법정동 중심점", url="https://nominatim.openstreetmap.org/",
                           accessed="2026-11-18", license="ODbL 1.0 © OpenStreetMap contributors",
                           note="LH 마커와 약 420 m 차이 (법정동 중심점이므로 블록 위치 아님)"))
    s.add(ProvenanceRecord(project_id=p.id, subject="analysis_date", data_class="REAL_OFFICIAL",
                           source="한국천문연구원 천문우주지식정보 2026 월력요항 - 동지 12월 22일", url=demo.KASI_URL,
                           accessed="2026-11-18", license="공공누리", note="기본 분석일 2026-12-22 (변경 가능)"))
    return p


def _active_terrain(s: Session, pid: str) -> TerrainSource | None:
    return s.scalars(select(TerrainSource).where(TerrainSource.project_id == pid, TerrainSource.active.is_(True))).first()


def register_terrain(s: Session, p: Project, path: Path, data_class: str, filename: str,
                     declared_vertical_datum: str | None = None, acquired: str | None = None,
                     license_: str | None = None, source_meta: dict | None = None,
                     provenance_source: str | None = None) -> tuple[Dataset, TerrainSource | None]:
    info = inspect_dem(path, data_class, declared_vertical_datum, name_hint=filename)
    fr = frame_of(p)
    region_half, mesh_m = ground_region_for(path, fr, data_class)
    # coverage of the terrain model region
    if info.ok:
        try:
            sampler = DemSampler(path, fr)
            xs = np.linspace(-region_half, region_half, 49)
            X, Y = np.meshgrid(xs, xs)
            z = sampler.sample_xy(X, Y)
            info.coverage_ratio = float(np.isfinite(z).mean())
            info.covers_region = info.coverage_ratio > 0.999
            site = sampler.sample_xy(np.linspace(-150, 150, 31)[None, :].repeat(31, 0), np.linspace(-150, 150, 31)[:, None].repeat(31, 1))
            if not np.isfinite(site).any():
                info.errors.append("DEM이 대상지(인천계양 A2 인근 300 m 사각형)를 덮지 않음")
            elif not np.isfinite(site).all():
                info.warnings.append("대상지 내부에 NoData 존재")
            if not info.covers_region:
                info.warnings.append(f"분석 지형영역(±{region_half/1000:.1f} km) 커버리지 {info.coverage_ratio*100:.1f}% - 범위 밖 지형 미반영")
        except Exception as exc:  # noqa: BLE001
            info.errors.append(f"좌표 변환/샘플링 실패: {exc}")
    ds = Dataset(project_id=p.id, kind="TERRAIN", data_class=data_class, filename=filename, path=str(path),
                 sha256=info.sha256, meta={"declared_vertical_datum": declared_vertical_datum, "acquired": acquired,
                                           "license": license_, "region_half_m": region_half, "mesh_spacing_m": mesh_m,
                                           **(source_meta or {})}, qa=asdict(info),
                 status="REJECTED" if info.errors else ("WARN" if info.warnings else "OK"))
    s.add(ds)
    s.flush()
    if info.errors:
        return ds, None
    for t in s.scalars(select(TerrainSource).where(TerrainSource.project_id == p.id)):
        t.active = False
    ts = TerrainSource(project_id=p.id, dataset_id=ds.id, active=True, data_class=data_class,
                       native_cell_m=info.cell_size_x, vertical_datum=info.vertical_datum,
                       vertical_datum_status=info.vertical_datum_status, surface_type=info.surface_type,
                       sha256=info.sha256, acquired=acquired or ("생성일 2026-11-18 (합성)" if data_class == SYNTHETIC else None),
                       license=license_ or ("자체 생성 합성자료" if data_class == SYNTHETIC else None))
    s.add(ts)
    s.flush()
    g = ground_for(str(path), info.sha256, fr.lat0, fr.lon0, tuple(p.site_rect), 0.0, region_half, mesh_m)
    s.add(SitePad(project_id=p.id, terrain_source_id=ts.id, pad_z=g.pad_z, rect=list(g.pad_rect), blend_m=g.blend_m,
                  assumption="가상 지반 가정: 대상지 내 DEM 중앙값 고도의 평탄 계획지반 + 60 m 접합대 (실측/설계 계획지반고 아님)",
                  qa=g.qa))
    s.add(ProvenanceRecord(project_id=p.id, subject="terrain", data_class=data_class,
                           source=provenance_source or ("자체 생성 합성 30 m DEM (실제 인천계양 지형 아님)" if data_class == SYNTHETIC else f"사용자 업로드 DEM: {filename}"),
                           accessed="2026-11-18" if data_class == SYNTHETIC else acquired, license=ts.license,
                           note=f"CRS {info.crs}, 셀 {info.cell_size_x:.1f} m, 수직기준 {info.vertical_datum}, 지형 모델 ±{region_half:.0f} m / {mesh_m:.0f} m 메쉬"))
    return ds, ts


@lru_cache(maxsize=8)
def ground_for(path: str, sha: str, lat0: float, lon0: float, site_rect: tuple, pad_offset: float,
               region_half: float = 1200.0, mesh_m: float = 10.0) -> GroundModel:  # noqa: ARG001 - sha in cache key
    return build_ground(DemSampler(Path(path), LocalFrame(lat0, lon0)), site_rect, region_half_m=region_half,
                        mesh_spacing_m=mesh_m, pad_offset_m=pad_offset)


def ground_region_for(path: Path, fr: LocalFrame, data_class: str) -> tuple[float, float]:
    """Terrain model extent. Synthetic DEMO keeps ±1.2 km / 10 m (reproducible). A real DEM covering ±4.8 km is
    modelled to ±4.8 km at 20 m so that distant hills (e.g. 계양산 ~4 km WSW of the site) can cast shadows."""
    if data_class == SYNTHETIC:
        return 1200.0, 10.0
    try:
        smp = DemSampler(path, fr)
        xs = np.linspace(-4800, 4800, 25)
        X, Y = np.meshgrid(xs, xs)
        if np.isfinite(smp.sample_xy(X, Y)).all():
            return 4800.0, 20.0
    except Exception:  # noqa: BLE001
        pass
    return 1200.0, 10.0


def dataset_region(ds: Dataset) -> tuple[float, float]:
    m = ds.meta or {}
    return float(m.get("region_half_m", 1200.0)), float(m.get("mesh_spacing_m", 10.0))


def demo_seed(s: Session, p: Project) -> Project:
    if p.status == "READY":
        raise ServiceError("이미 시드된 프로젝트")
    fr = frame_of(p)
    path = write_synthetic_dem(project_dir(p.id) / "terrain" / "synthetic_dem_30m_epsg5179.tif", fr)
    _, ts = register_terrain(s, p, path, SYNTHETIC, path.name)
    if ts is None:
        raise ServiceError("합성 DEM 등록 실패")
    for b in demo.demo_buildings():
        s.add(Building(project_id=p.id, building_id=b["id"], name=b["name"], kind=b["kind"], floors=b["floors"],
                       footprint=b["footprint"], data_class="SYNTHETIC"))
    for o in demo.demo_open_spaces():
        s.add(OpenSpacePolygon(project_id=p.id, space_id=o["id"], name=o["name"], kind=o["kind"], polygon=o["polygon"]))
    s.add(ProvenanceRecord(project_id=p.id, subject="buildings", data_class="SYNTHETIC",
                           source="자체 생성 가상 주동 7개(101~107동) + 주변 참고건물 5개", note="실제 LH 단지배치·동호배치가 아님"))
    s.add(ProvenanceRecord(project_id=p.id, subject="open_spaces", data_class="SYNTHETIC",
                           source="DEMO 가상 어린이놀이터·휴게공간 폴리곤", note="실제 LH 시설 위치가 아님"))
    a = Scenario(project_id=p.id, code="A", name="기준안 A (가상 기준 배치)", locked=True)
    b = Scenario(project_id=p.id, code="B", name="변경안 B (가상 설계변경)", locked=False)
    s.add_all([a, b])
    s.flush()
    for bid, tr in demo.DEMO_B_TRANSFORMS.items():
        s.add(ScenarioBuildingTransform(scenario_id=b.id, building_id=bid, **tr))
    s.flush()
    refresh_hash(s, a)
    refresh_hash(s, b)
    p.status = "READY"
    return p


def transforms_of(sc: Scenario) -> dict:
    return {t.building_id: {"dx": t.dx, "dy": t.dy, "rot_deg": t.rot_deg, "floors_delta": t.floors_delta} for t in sc.transforms
            if (t.dx or t.dy or t.rot_deg or t.floors_delta)}


def refresh_hash(s: Session, sc: Scenario) -> None:
    s.refresh(sc)
    sc.content_hash = stable_hash({"code": sc.code, "transforms": transforms_of(sc)})


def site_dict(s: Session, p: Project) -> dict:
    blds = s.scalars(select(Building).where(Building.project_id == p.id).order_by(Building.kind.desc(), Building.building_id)).all()
    oss = s.scalars(select(OpenSpacePolygon).where(OpenSpacePolygon.project_id == p.id)).all()
    return {
        "buildings": [{"id": b.building_id, "name": b.name, "kind": b.kind, "floors": b.floors, "footprint": b.footprint,
                       "data_class": b.data_class} for b in blds],
        "open_spaces": [{"id": o.space_id, "name": o.name, "kind": o.kind, "polygon": o.polygon, "data_class": o.data_class} for o in oss],
        "site_rect": p.site_rect,
        "site_boundary": demo.demo_site_boundary(),
        "site_boundary_class": "SYNTHETIC (가상 대지경계)",
    }


def patch_building(s: Session, sc: Scenario, building_id: str, values: dict) -> Scenario:
    if sc.locked:
        raise ServiceError("기준안 A는 불변(잠금) - 변경안 B에서만 편집할 수 있음")
    b = s.scalars(select(Building).where(Building.project_id == sc.project_id, Building.building_id == building_id)).first()
    if b is None:
        raise ServiceError(f"건물 {building_id} 없음")
    if b.kind != "MAIN":
        raise ServiceError("주변 참고건물은 편집 대상이 아님")
    lim = {"dx": (-60, 60), "dy": (-60, 60), "rot_deg": (-45, 45), "floors_delta": (-10, 10)}
    for k, (lo, hi) in lim.items():
        if k in values and values[k] is not None and not (lo <= float(values[k]) <= hi):
            raise ServiceError(f"{k}={values[k]} 허용범위 [{lo}, {hi}] 밖")
    if "floors_delta" in values and values["floors_delta"] is not None and b.floors + int(values["floors_delta"]) < 1:
        raise ServiceError("층수는 1 이상")
    t = next((t for t in sc.transforms if t.building_id == building_id), None)
    if t is None:
        t = ScenarioBuildingTransform(scenario_id=sc.id, building_id=building_id)
        s.add(t)
        sc.transforms.append(t)
    for k in lim:
        if k in values and values[k] is not None:
            setattr(t, k, int(values[k]) if k == "floors_delta" else float(values[k]))
    sc.revision += 1
    s.flush()
    refresh_hash(s, sc)
    return sc


def upload_buildings(s: Session, p: Project, raw: bytes, filename: str) -> Dataset:
    """GeoJSON FeatureCollection of footprints. CRS: RFC7946 WGS84 lon/lat unless a legacy `crs` member names one."""
    errors, warnings = [], []
    try:
        gj = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ServiceError(f"GeoJSON 파싱 실패: {exc}") from exc
    crs_name = (((gj.get("crs") or {}).get("properties") or {}).get("name"))
    if crs_name:
        try:
            crs = PCRS.from_user_input(crs_name.replace("urn:ogc:def:crs:", "").replace("::", ":"))
        except Exception:  # noqa: BLE001
            raise ServiceError(f"알 수 없는 CRS: {crs_name}")
    else:
        crs = PCRS.from_epsg(4326)
        warnings.append("crs 멤버 없음 - RFC 7946에 따라 WGS84 경위도로 해석")
    fr = frame_of(p)
    feats = gj.get("features") or []
    if not feats:
        raise ServiceError("feature가 없음")
    rows = []
    seen: set[str] = set()
    reserved = {b.building_id for b in p.buildings if b.kind == "CONTEXT"}
    for i, f in enumerate(feats):
        props = f.get("properties") or {}
        bid = str(props.get("id") or props.get("building_id") or f"U{i + 1:02d}").strip()
        if not bid or len(bid) > 32 or not all(ch.isalnum() or ch in "-_" for ch in bid):
            errors.append(f"{bid[:40]}: 건물 ID는 1~32자 영문/숫자/-/_ 만 허용")
            continue
        if bid in seen:
            errors.append(f"{bid}: 중복 ID")
            continue
        seen.add(bid)
        kind_in = str(props.get("kind", "MAIN")).upper()
        if kind_in != "CONTEXT" and bid in reserved:
            errors.append(f"{bid}: 기존 주변 참고건물 ID와 충돌")
            continue
        try:
            g = shape(f["geometry"])
            if g.geom_type == "MultiPolygon":
                if len(g.geoms) != 1:
                    errors.append(f"{bid}: 멀티파트 건물({len(g.geoms)}개 부분) - 부분별 feature로 분리 필요")
                    continue
                g = g.geoms[0]
            if g.geom_type != "Polygon":
                errors.append(f"{bid}: {g.geom_type}는 footprint로 사용할 수 없음")
                continue
            if len(g.interiors):
                errors.append(f"{bid}: 중정(hole)이 있는 footprint는 미지원 - 무시하면 중정이 건물로 채워지므로 거부 (외곽·내부를 별도 건물로 분리 필요)")
                continue
            xy = np.asarray(g.exterior.coords)[:, :2]
            if crs.is_geographic:
                if np.abs(xy[:, 0]).max() > 180 or np.abs(xy[:, 1]).max() > 90:
                    errors.append(f"{bid}: 경위도 범위를 벗어남 - 투영좌표를 WGS84로 잘못 표기한 것으로 의심")
                    continue
            elif np.abs(xy).max() < 400:
                errors.append(f"{bid}: 투영 CRS({crs.to_string()})인데 좌표값이 경위도처럼 작음 - 단위 오류 의심")
                continue
            enu = fr.crs_to_enu_xy(xy[:, 0], xy[:, 1], crs.to_string())
            poly = validate_footprint(Polygon(enu))
            floors = props.get("floors")
            if floors is None and props.get("height_m") is not None:
                floors = max(1, int(round((float(props["height_m"]) - 1.2) / 2.9)))
            if floors is None:
                errors.append(f"{bid}: floors 또는 height_m 속성 필요")
                continue
            if not (1 <= int(floors) <= 80):
                errors.append(f"{bid}: 층수 {floors} 범위(1~80) 밖")
                continue
            rows.append((bid, str(props.get("name", bid))[:200], kind_in, int(floors),
                         [[round(x, 4), round(y, 4)] for x, y in list(poly.exterior.coords)[:-1]]))
        except GeometryError as exc:
            errors.append(f"{bid}: {exc}")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{bid}: 처리 실패 {exc}")
    path = save_upload(p.id, "buildings", filename, raw)  # sanitised file name (no path traversal)
    import hashlib
    ds = Dataset(project_id=p.id, kind="BUILDINGS", data_class=USER_UPLOADED, filename=filename, path=str(path),
                 sha256=hashlib.sha256(raw).hexdigest(), meta={"crs": crs.to_string(), "n_features": len(feats)},
                 qa={"errors": errors, "warnings": warnings, "accepted": len(rows)},
                 status="REJECTED" if errors or not rows else ("WARN" if warnings else "OK"))
    s.add(ds)
    s.flush()
    if errors or not rows:
        return ds
    for b in s.scalars(select(Building).where(Building.project_id == p.id, Building.kind == "MAIN")):
        s.delete(b)
    for bid, name, kind, floors, fp in rows:
        s.add(Building(project_id=p.id, building_id=bid, name=name, kind="CONTEXT" if kind == "CONTEXT" else "MAIN",
                       floors=floors, footprint=fp, data_class=USER_UPLOADED, source_dataset_id=ds.id))
    for sc in p.scenarios:
        for t in list(sc.transforms):
            s.delete(t)
        sc.revision += 1
    s.flush()
    for sc in p.scenarios:
        refresh_hash(s, sc)
    s.add(ProvenanceRecord(project_id=p.id, subject="buildings", data_class=USER_UPLOADED, source=f"사용자 업로드 GeoJSON {filename}",
                           note=f"CRS {crs.to_string()} → local ENU 변환"))
    return ds


def save_upload(pid: str, kind: str, filename: str, data: bytes) -> Path:
    """Store an upload under a unique, sanitised name. Never overwrite: earlier runs reference their input files by
    path + SHA-256 in immutable snapshots."""
    import uuid
    safe = "".join(c for c in filename if c.isalnum() or c in "._-").lstrip(".")[:120] or "upload.bin"
    path = project_dir(pid) / kind / f"{uuid.uuid4().hex[:8]}_{safe}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


LARGE_RASTER_CELLS = 25_000_000


def save_upload_stream(pid: str, kind: str, filename: str, fileobj) -> Path:
    import shutil
    import os
    limit = int(float(os.environ.get("MAX_UPLOAD_MB", "0")) * 1024 * 1024)  # 0 = unlimited (local)
    path = save_upload(pid, kind, filename, b"")
    written = 0
    with open(path, "wb") as out:
        while chunk := fileobj.read(8 << 20):
            written += len(chunk)
            if limit and written > limit:
                out.close()
                path.unlink(missing_ok=True)
                raise ServiceError(f"업로드 크기 제한 {limit // (1024 * 1024)} MB 초과 - 대용량 DEM은 scripts/import_dem.py 사용")
            out.write(chunk)
    return path


def clip_if_large(p: Project, path: Path, half_extent_m: float = 6000.0) -> tuple[Path, dict]:
    """Return (path_to_register, source_meta). Large rasters are clipped to ±half_extent around the site origin."""
    import hashlib
    import rasterio
    from datetime import datetime, timezone
    from .geo.terrain import clip_dem_to_aoi
    with rasterio.open(path) as ds:
        cells = ds.width * ds.height
    if cells <= LARGE_RASTER_CELLS:
        return path, {}
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    st = path.stat()
    meta = {"source_path": path.name, "source_size_bytes": st.st_size, "source_sha256": h.hexdigest(),
            "source_mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(timespec="seconds"),
            "source_cells": cells, "clip_half_extent_m": half_extent_m}
    out = path.with_name(f"{path.stem}_clip_{int(half_extent_m)}m.tif")
    clip_dem_to_aoi(path, out, frame_of(p), half_extent_m, {k[7:]: v for k, v in meta.items() if k.startswith("source_")})
    return out, meta


def delete_project_files(pid: str) -> None:
    shutil.rmtree(DATA_DIR / "projects" / pid, ignore_errors=True)
