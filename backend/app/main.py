"""FastAPI application - GeoBuild Impact 3D (JIRISO DATA STUDIO)."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import jobs, services
from .config import DATA_DIR, ENGINE_VERSION, JOB_BACKEND, REDIS_URL, code_commit_hash
from .db import AnalysisRun, Dataset, Project, ProvenanceRecord, Report, Scenario, SitePad, TerrainSource, get_session, init_db
from .runner import make_cache_key
from .scene import demo
from .scene.builder import LAYOUT_KEY, building_mesh, resolve_scenario, stable_hash
from .scene.geometry import GeometryError, make_receivers
from .schemas import AnalysisRequest, ProjectCreate, ProjectOut, ReportOut, RunOut, ScenarioCreate, TransformPatch

@asynccontextmanager
async def lifespan(_app):
    init_db()
    yield


app = FastAPI(title="GeoBuild Impact 3D API", version=ENGINE_VERSION, lifespan=lifespan,
              description="CesiumJS 기반 공동주택 설계변경 전후 직사일조(A)·그림자 변화(B)·이격거리(C) 분석 API. " + demo.DISCLAIMER)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _project(s: Session, pid: str) -> Project:
    p = s.get(Project, pid)
    if p is None:
        raise HTTPException(404, "프로젝트 없음")
    return p


def _run(s: Session, rid: str) -> AnalysisRun:
    r = s.get(AnalysisRun, rid)
    if r is None:
        raise HTTPException(404, "분석 실행 없음")
    return r


def _bad(exc: Exception):
    raise HTTPException(400, str(exc))


def _badges(s: Session, p: Project) -> dict:
    ts = s.scalars(select(TerrainSource).where(TerrainSource.project_id == p.id, TerrainSource.active.is_(True))).first()
    pad = s.scalars(select(SitePad).where(SitePad.project_id == p.id).order_by(SitePad.id.desc())).first()
    if ts is not None:
        pad = s.scalars(select(SitePad).where(SitePad.terrain_source_id == ts.id)).first()
    blds = {b.data_class for b in p.buildings}
    return {
        "location": {"class": "REAL_OFFICIAL", "label": "LH 공고 대표점 (경계 미검증)", "approximate": p.site_meta.get("approximate_demo_location", False),
                     "boundary_verified": False},
        "terrain": None if ts is None else {"class": ts.data_class, "label": "합성 30m DEM (실제 지형 아님)" if ts.data_class == "SYNTHETIC" else "업로드 30m DEM",
                                             "native_cell_m": ts.native_cell_m, "vertical_datum": ts.vertical_datum,
                                             "vertical_datum_status": ts.vertical_datum_status, "surface_type": ts.surface_type,
                                             "sha256": ts.sha256, "acquired": ts.acquired, "license": ts.license, "dataset_id": ts.dataset_id},
        "ground": None if pad is None else {"class": "DERIVED", "label": "가상 지반 가정", "pad_z": pad.pad_z, "assumption": pad.assumption, "qa": pad.qa},
        "buildings": {"classes": sorted(blds), "label": "가상 주동" if blds == {"SYNTHETIC"} else "업로드 footprint 포함"},
        "mode": "DEMO" if (ts is None or ts.data_class == "SYNTHETIC") else "UPLOADED",
        "disclaimer": demo.DISCLAIMER,
    }


def _scen_out(sc: Scenario) -> dict:
    return {"id": sc.id, "code": sc.code, "name": sc.name, "locked": sc.locked, "revision": sc.revision, "content_hash": sc.content_hash,
            "transforms": {k: v for k, v in services.transforms_of(sc).items() if k != LAYOUT_KEY},
            "layout": (lambda l: None if not l else {"n_buildings": len(l["buildings"]), "source": l.get("source"),
                                                     "buildings": [{"id": b["id"], "floors": b["floors"]} for b in l["buildings"]]})(services.layout_of(sc)),
            "updated_at": sc.updated_at.isoformat() if sc.updated_at else None}


def _project_out(s: Session, p: Project) -> dict:
    last = s.scalars(select(AnalysisRun).where(AnalysisRun.project_id == p.id).order_by(AnalysisRun.created_at.desc())).first()
    if last is not None:
        _reap_run(s, last)  # surface dead jobs on project cards too
    thumb = None
    rp = s.scalars(select(Report).join(AnalysisRun, Report.run_id == AnalysisRun.id)
                   .where(AnalysisRun.project_id == p.id, Report.status == "SUCCEEDED").order_by(Report.created_at.desc())).first()
    if rp and rp.files:
        figs = rp.files.get("figures", [])
        name = "f00_cesium_capture.png" if "f00_cesium_capture.png" in figs else ("f06_layout_ab.png" if "f06_layout_ab.png" in figs else None)
        if name:
            thumb = {"url": f"/api/reports/{rp.id}/assets/{name}", "run_id": rp.run_id, "report_id": rp.id}
    return ProjectOut(id=p.id, name=p.name, site_key=p.site_key, status=p.status, site_meta={**p.site_meta, "disclaimer": demo.DISCLAIMER},
                      frame=p.frame, site_rect=p.site_rect, created_at=p.created_at, data_badges=_badges(s, p),
                      scenarios=[_scen_out(sc) for sc in sorted(p.scenarios, key=lambda x: x.code)],
                      thumbnail=thumb,
                      latest_run=None if last is None else {"id": last.id, "status": last.status, "analysis_type": last.analysis_type,
                                                            "created_at": last.created_at.isoformat()}).model_dump(mode="json")


# ------------------------------------------------------------------------------------------- health
@app.get("/api/health")
def health(s: Session = Depends(get_session)):
    import open3d  # noqa: F401
    db_ok = True
    try:
        s.execute(select(1))
    except Exception:  # noqa: BLE001
        db_ok = False
    rs = jobs.redis_status() if REDIS_URL else {"configured": False}
    from .report.pdf import chromium_status
    return {"status": "ok" if db_ok else "degraded", "engine_version": ENGINE_VERSION, "commit": code_commit_hash(),
            "database": {"ok": db_ok, "url_scheme": str(s.get_bind().url).split(":")[0]},
            "job_backend": JOB_BACKEND, "redis": rs, "chromium": chromium_status(), "data_dir": str(DATA_DIR)}


# ------------------------------------------------------------------------------------------- projects
@app.post("/api/projects")
def create_project(body: ProjectCreate, s: Session = Depends(get_session)):
    try:
        p = services.create_project(s, body.name, body.site_key)
        if body.seed_demo:
            services.demo_seed(s, p)
        s.commit()
    except services.ServiceError as exc:
        _bad(exc)
    return _project_out(s, p)


@app.get("/api/projects")
def list_projects(s: Session = Depends(get_session)):
    return [_project_out(s, p) for p in s.scalars(select(Project).order_by(Project.created_at.desc()))]


@app.get("/api/projects/{pid}")
def get_project(pid: str, s: Session = Depends(get_session)):
    return _project_out(s, _project(s, pid))


@app.delete("/api/projects/{pid}")
def delete_project(pid: str, s: Session = Depends(get_session)):
    p = _project(s, pid)
    if s.scalars(select(AnalysisRun).where(AnalysisRun.project_id == pid)).first():
        raise HTTPException(409, "분석 이력이 있는 프로젝트는 삭제하지 않음 (보고서 재현성 보존)")
    s.delete(p)
    s.commit()
    services.delete_project_files(pid)
    return {"deleted": pid}


@app.post("/api/projects/{pid}/demo-seed")
def demo_seed(pid: str, s: Session = Depends(get_session)):
    p = _project(s, pid)
    try:
        services.demo_seed(s, p)
        s.commit()
    except services.ServiceError as exc:
        _bad(exc)
    return _project_out(s, p)


# ------------------------------------------------------------------------------------------- layout drawings (DXF / PDF / image)
KOREAN_CRS = ["EPSG:5186", "EPSG:5187", "EPSG:5185", "EPSG:5188", "EPSG:5179", "EPSG:5174", "EPSG:2097"]
DRAWING_MAX_BYTES = 80 * 1024 * 1024


def _drawing_path(pid: str, did: str) -> Path:
    if not did.isalnum():
        raise HTTPException(400, "잘못된 도면 ID")
    d = services.project_dir(pid) / "drawings"
    hits = list(d.glob(f"{did}.*")) if d.exists() else []
    src = [h for h in hits if not h.name.endswith(".png") or h.stem == did]
    if not src:
        raise HTTPException(404, "도면 없음")
    return src[0]


def _crs_guess(p: Project, bbox, unit_m: float) -> list[dict]:
    if not bbox:
        return []
    fr = services.frame_of(p)
    cx, cy = (bbox[0] + bbox[2]) / 2 * unit_m, (bbox[1] + bbox[3]) / 2 * unit_m
    out = []
    for crs in KOREAN_CRS:
        try:
            e = fr.crs_to_enu_xy([cx], [cy], crs)[0]
        except Exception:  # noqa: BLE001
            continue
        d = float(np.hypot(*e))
        if np.isfinite(d) and d < 5000:
            out.append({"crs": crs, "distance_to_site_m": round(d, 1)})
    return sorted(out, key=lambda r: r["distance_to_site_m"])


@app.post("/api/projects/{pid}/drawings")
async def upload_drawing(pid: str, file: UploadFile = File(...), page: int = 0, s: Session = Depends(get_session)):
    from . import cad
    import uuid
    p = _project(s, pid)
    raw = await file.read()
    if len(raw) > DRAWING_MAX_BYTES:
        raise HTTPException(413, "도면 파일은 80 MB 이하")
    name = (file.filename or "drawing").lower()
    ext = name.rsplit(".", 1)[-1] if "." in name else ""
    if ext not in ("dxf", "pdf", "png", "jpg", "jpeg"):
        raise HTTPException(400, "DXF, PDF, PNG, JPG만 지원 (DWG는 CAD에서 DXF로 저장)")
    did = uuid.uuid4().hex[:12]
    d = services.project_dir(pid) / "drawings"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{did}.{ext}"
    path.write_bytes(raw)
    out = {"drawing_id": did, "filename": file.filename, "kind": "DXF" if ext == "dxf" else "PDF" if ext == "pdf" else "IMAGE",
           "sha256": hashlib.sha256(raw).hexdigest()}
    try:
        if ext == "dxf":
            info = cad.inspect(path)
            out.update(info)
            out["crs_candidates"] = _crs_guess(p, info["bbox"], info["unit_guess_m"])
        elif ext == "pdf":
            out.update(cad.render_pdf(path, page, d / f"{did}_p{page}.png"))
            out["image_url"] = f"/api/projects/{pid}/drawings/{did}/image?page={page}"
        else:
            from PIL import Image
            with Image.open(path) as im:
                out.update({"width": im.width, "height": im.height, "pages": 1, "page": 0})
            out["image_url"] = f"/api/projects/{pid}/drawings/{did}/image"
    except cad.CadError as exc:
        path.unlink(missing_ok=True)
        raise HTTPException(400, str(exc)) from exc
    return out


@app.get("/api/projects/{pid}/drawings/{did}/image")
def drawing_image(pid: str, did: str, page: int = 0, s: Session = Depends(get_session)):
    from . import cad
    _project(s, pid)
    src = _drawing_path(pid, did)
    if src.suffix == ".pdf":
        png = src.with_name(f"{did}_p{page}.png")
        if not png.exists():
            try:
                cad.render_pdf(src, page, png)
            except cad.CadError as exc:
                raise HTTPException(400, str(exc)) from exc
        return FileResponse(png, media_type="image/png")
    return FileResponse(src)


@app.post("/api/projects/{pid}/drawings/{did}/extract")
def drawing_extract(pid: str, did: str, body: dict, s: Session = Depends(get_session)):
    from . import cad
    p = _project(s, pid)
    src = _drawing_path(pid, did)
    if src.suffix != ".dxf":
        raise HTTPException(400, "자동 추출은 DXF만 가능 - PDF/이미지는 화면에서 외곽선을 따라 그려 주세요")
    layers = body.get("building_layers") or []
    if not layers:
        raise HTTPException(422, "건물 외곽선 레이어를 하나 이상 선택")
    unit = float(body.get("unit_m") or 1.0)
    try:
        out = cad.extract(src, layers, body.get("boundary_layer"), unit, body.get("text_layers"))
    except cad.CadError as exc:
        raise HTTPException(400, str(exc)) from exc
    xs = [x for b in out["buildings"] for x, _ in b["ring"]]
    ys = [y for b in out["buildings"] for _, y in b["ring"]]
    if xs:
        out["crs_candidates"] = _crs_guess(p, [min(xs), min(ys), max(xs), max(ys)], 1.0)
    return out


@app.put("/api/projects/{pid}/scenarios/{code}/layout")
def put_layout(pid: str, code: str, body: dict, s: Session = Depends(get_session)):
    """Store a drawn layout for scenario A or B. Rings come in drawing metres (DXF) or pixels (PDF/image) and are
    placed with a projected CRS or a 2-point similarity transform."""
    from . import cad
    p = _project(s, pid)
    if code not in ("A", "B"):
        raise HTTPException(404, "시나리오는 A 또는 B")
    pl = body.get("placement") or {}
    fr = services.frame_of(p)
    try:
        if pl.get("mode") == "crs":
            crs = pl.get("crs")
            if crs not in KOREAN_CRS:
                raise HTTPException(422, f"지원 좌표계: {', '.join(KOREAN_CRS)}")
            conv = lambda ring: [[round(float(x), 3), round(float(y), 3)] for x, y in fr.crs_to_enu_xy([q[0] for q in ring], [q[1] for q in ring], crs)]  # noqa: E731
            info = {"mode": "crs", "crs": crs}
        elif pl.get("mode") == "points":
            T = cad.similarity_from_points(pl["src"], pl["dst"], bool(pl.get("allow_scale")))
            conv = lambda ring: cad.apply_similarity(ring, T)  # noqa: E731
            info = {"mode": "points", **T, "src": pl["src"], "dst": pl["dst"]}
        else:
            raise HTTPException(422, "placement.mode는 crs 또는 points")
        blds = []
        for b in body.get("buildings") or []:
            if b.get("include") is False:
                continue
            if b.get("floors") in (None, ""):
                raise HTTPException(422, f"{b.get('id') or '이름 없는'} 동: 층수 입력 필요")
            ring = conv(b["ring"])
            blds.append({"id": str(b["id"]).strip(), "name": f"{str(b['id']).strip()}동", "floors": int(b["floors"]), "footprint": ring,
                         **({"units_per_floor": int(b["units_per_floor"])} if b.get("units_per_floor") else {})})
        if not blds:
            raise HTTPException(422, "건물이 없음")
        boundary = conv(body["boundary"]) if body.get("boundary") else None
        src = {**(body.get("source") or {}), "placement": info}
        sc = services.set_layout(s, p, code, {"buildings": blds, "source": src}, boundary, (body.get("source") or {}).get("filename"))
        s.commit()
    except services.ServiceError as exc:
        _bad(exc)
    except cad.CadError as exc:
        raise HTTPException(400, str(exc)) from exc
    except GeometryError as exc:
        raise HTTPException(400, f"외곽선 오류: {exc}") from exc
    return {"scenario": _scen_out(sc), "placement": info, "buildings": blds, "boundary": boundary}


@app.delete("/api/projects/{pid}/scenarios/{code}/layout")
def delete_layout(pid: str, code: str, s: Session = Depends(get_session)):
    p = _project(s, pid)
    try:
        sc = services.set_layout(s, p, code, None, None, None)
        s.commit()
    except services.ServiceError as exc:
        _bad(exc)
    return {"scenario": _scen_out(sc)}


@app.get("/api/legal/options")
def legal_options():
    from . import legal
    return {"presets": {k: {"label": v["label"], "source": v["source"], "k": v["k"]} for k, v in legal.PRESETS.items()},
            "project_types": legal.PROJECT_TYPES, "zonings": legal.ZONINGS, "defaults": legal.DEFAULT_PARAMS,
            "facade_roles": legal.FACADE_LABEL, "north_rule_change": legal.NEW_NORTH_RULE_FROM.isoformat()}


@app.get("/api/projects/{pid}/legal-params")
def get_legal_params(pid: str, s: Session = Depends(get_session)):
    from . import legal
    return legal.merged_params((_project(s, pid).site_meta or {}).get("legal"))


@app.put("/api/projects/{pid}/legal-params")
def put_legal_params(pid: str, body: dict, s: Session = Depends(get_session)):
    from datetime import date as _date
    from . import legal
    p = _project(s, pid)
    P = legal.merged_params({**((p.site_meta or {}).get("legal") or {}), **body})
    if "k_override" in body:
        P["k_override"] = body["k_override"]
    try:
        _date.fromisoformat(P["ref_date"])
    except ValueError:
        raise HTTPException(422, "기준일 형식 오류 (YYYY-MM-DD)")
    if P["preset"] not in legal.PRESETS or P["project_type"] not in legal.PROJECT_TYPES or P["zoning"] not in legal.ZONINGS:
        raise HTTPException(422, "알 수 없는 조례 프리셋/사업유형/용도지역")
    if P["north_mode"] not in ("APPLY", "EXEMPT", "NOTICE"):
        raise HTTPException(422, "north_mode는 APPLY|EXEMPT|NOTICE")
    if P["k_override"] is not None and not (0 < float(P["k_override"]) <= 3):
        raise HTTPException(422, "계수는 0~3 범위")
    for bid, roles in (P["facades"] or {}).items():
        if any(r not in legal.FACADE_LABEL for r in roles):
            raise HTTPException(422, f"{bid}: 벽면 유형은 WINDOW|BLANK|SIDE")
    p.site_meta = {**(p.site_meta or {}), "legal": P}
    s.commit()
    return P


@app.get("/api/projects/{pid}/provenance")
def provenance(pid: str, s: Session = Depends(get_session)):
    _project(s, pid)
    rows = s.scalars(select(ProvenanceRecord).where(ProvenanceRecord.project_id == pid)).all()
    return [{"subject": r.subject, "data_class": r.data_class, "source": r.source, "url": r.url, "accessed": r.accessed,
             "license": r.license, "note": r.note} for r in rows]


@app.get("/api/projects/{pid}/datasets")
def list_datasets(pid: str, s: Session = Depends(get_session)):
    _project(s, pid)
    return [{"id": d.id, "kind": d.kind, "data_class": d.data_class, "filename": d.filename, "sha256": d.sha256, "status": d.status,
             "qa": d.qa, "meta": d.meta, "created_at": d.created_at.isoformat()}
            for d in s.scalars(select(Dataset).where(Dataset.project_id == pid).order_by(Dataset.created_at.desc()))]


@app.post("/api/projects/{pid}/datasets/terrain")
def upload_terrain(pid: str, file: UploadFile = File(...), vertical_datum: str | None = Form(None),
                   acquired: str | None = Form(None), license: str | None = Form(None), s: Session = Depends(get_session)):  # noqa: A002
    """Streamed to disk (no full in-memory copy). Rasters larger than 25 M cells are clipped around the site
    (no resampling) and the clip is registered, with the uploaded file's hash kept as provenance."""
    p = _project(s, pid)
    try:
        path = services.save_upload_stream(pid, "terrain", file.filename or "dem.tif", file.file)
    except services.ServiceError as exc:
        raise HTTPException(413, str(exc)) from exc
    if path.stat().st_size == 0:
        path.unlink(missing_ok=True)
        raise HTTPException(400, "빈 파일")
    try:
        path, source_meta = services.clip_if_large(p, path)
    except Exception as exc:  # noqa: BLE001 - unreadable raster -> normal QA rejection below
        source_meta = {"clip_error": str(exc)[:200]}
    ds, ts = services.register_terrain(s, p, path, "USER_UPLOADED", file.filename or path.name, vertical_datum, acquired, license,
                                       source_meta=source_meta)
    s.commit()
    return {"dataset_id": ds.id, "status": ds.status, "activated": ts is not None, "qa": ds.qa, "clipped": bool(source_meta.get("source_sha256")),
            "message": "업로드 DEM이 활성 지형으로 설정됨" if ts else "검사 실패 - 기존 지형 유지 (DEMO fallback)"}


@app.post("/api/projects/{pid}/datasets/terrain/activate/{dataset_id}")
def activate_terrain(pid: str, dataset_id: str, s: Session = Depends(get_session)):
    _project(s, pid)
    ts = s.scalars(select(TerrainSource).where(TerrainSource.project_id == pid, TerrainSource.dataset_id == dataset_id)).first()
    if ts is None:
        raise HTTPException(404, "등록된 지형 아님")
    for t in s.scalars(select(TerrainSource).where(TerrainSource.project_id == pid)):
        t.active = t.id == ts.id
    s.commit()
    return {"active": dataset_id}


@app.post("/api/projects/{pid}/datasets/buildings")
async def upload_buildings(pid: str, file: UploadFile = File(...), s: Session = Depends(get_session)):
    p = _project(s, pid)
    data = await file.read()
    try:
        ds = services.upload_buildings(s, p, data, file.filename or "buildings.geojson")
        s.commit()
    except services.ServiceError as exc:
        _bad(exc)
    return {"dataset_id": ds.id, "status": ds.status, "qa": ds.qa}


# ------------------------------------------------------------------------------------------- scene for viewer
def _ground(s: Session, p: Project):
    ts = s.scalars(select(TerrainSource).where(TerrainSource.project_id == p.id, TerrainSource.active.is_(True))).first()
    if ts is None:
        raise HTTPException(409, "활성 지형 없음 - demo-seed 또는 DEM 업로드 필요")
    ds = s.get(Dataset, ts.dataset_id)
    fr = services.frame_of(p)
    return services.ground_for(ds.path, ds.sha256, fr.lat0, fr.lon0, tuple(p.site_rect), 0.0, *services.dataset_region(ds)), ts, ds


def _b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


@app.get("/api/projects/{pid}/ground-mesh")
def ground_mesh(pid: str, s: Session = Depends(get_session)):
    p = _project(s, pid)
    g, ts, _ = _ground(s, p)
    v, t = g.mesh()
    return {"vertices_f32_b64": _b64(v.astype(np.float32)), "indices_u32_b64": _b64(t.astype(np.uint32)), "n_vertices": len(v),
            "n_triangles": len(t), "pad_z": g.pad_z, "pad_rect": g.pad_rect, "z_min": float(np.nanmin(g.z)), "z_max": float(np.nanmax(g.z)),
            "mesh_spacing_m": g.mesh_spacing_m, "region_half_m": float(g.xs.max()), "terrain_class": ts.data_class, "terrain_sha256": ts.sha256,
            "note": "분석 레이캐스팅과 동일한 지면 메쉬 (local ENU, m)"}


def _scene_payload(p: Project, site: dict, transforms: dict, g) -> dict:
    blds = resolve_scenario(site, transforms, g)
    out = []
    for b in blds:
        v, t = building_mesh(b)
        d = b.to_json()
        d["mesh"] = {"vertices": v.round(4).ravel().tolist(), "indices": t.ravel().tolist()}
        if b.kind == "MAIN":
            d["n_receivers"] = len(make_receivers(b.id, b.footprint_baseline, b.footprint, b.base_z, b.floors))
        out.append(d)
    return {"buildings": out}


@app.get("/api/projects/{pid}/scene")
def project_scene(pid: str, scenario: str = Query("B", pattern="^[AB]$"), s: Session = Depends(get_session)):
    p = _project(s, pid)
    g, ts, _ = _ground(s, p)
    sc = next((x for x in p.scenarios if x.code == scenario), None)
    if sc is None:
        raise HTTPException(404, "시나리오 없음")
    site = services.site_dict(s, p)
    try:
        payload = _scene_payload(p, site, services.transforms_of(sc), g)
    except ValueError as exc:
        _bad(exc)
    fr = services.frame_of(p)
    return {"scenario": _scen_out(sc), "frame": p.frame, "model_matrix": fr.cesium_model_matrix(), "pad_z": g.pad_z,
            "site_rect": p.site_rect, "site_boundary": site["site_boundary"], "open_spaces": site["open_spaces"], **payload}


# ------------------------------------------------------------------------------------------- scenarios
@app.post("/api/projects/{pid}/scenarios")
def create_scenario(pid: str, body: ScenarioCreate, s: Session = Depends(get_session)):
    """Reset variant B to a copy of A (or keep B). A is immutable."""
    p = _project(s, pid)
    b = next((x for x in p.scenarios if x.code == "B"), None)
    if b is None:
        b = Scenario(project_id=p.id, code="B", name=body.name, locked=False)
        s.add(b)
        s.flush()
    if body.copy_from == "A":
        for t in list(b.transforms):
            s.delete(t)
        b.transforms.clear()
        b.revision += 1
    b.name = body.name
    s.flush()
    services.refresh_hash(s, b)
    s.commit()
    return _scen_out(b)


@app.patch("/api/scenarios/{sid}/buildings/{building_id}")
def patch_scenario_building(sid: str, building_id: str, body: TransformPatch, s: Session = Depends(get_session)):
    sc = s.get(Scenario, sid)
    if sc is None:
        raise HTTPException(404, "시나리오 없음")
    try:
        services.patch_building(s, sc, building_id, body.model_dump())
        # validate resulting geometry (overlap etc. are warnings; invalid -> error)
        p = s.get(Project, sc.project_id)
        g, _, _ = _ground(s, p)
        blds = resolve_scenario(services.site_dict(s, p), services.transforms_of(sc), g)
        s.commit()
    except (services.ServiceError, ValueError) as exc:
        s.rollback()
        _bad(exc)
    return {**_scen_out(sc), "warnings": sorted({w for b in blds for w in b.warnings})}


# ------------------------------------------------------------------------------------------- analyses
def _run_out(r: AnalysisRun, reused: bool = False) -> dict:
    return RunOut(id=r.id, project_id=r.project_id, analysis_type=r.analysis_type, status=r.status, stage=r.stage, progress=r.progress,
                  logs=r.logs or [], error=r.error, params=r.params, cache_key=r.cache_key, job_backend=r.job_backend, job_id=r.job_id,
                  processing_seconds=r.processing_seconds, created_at=r.created_at, started_at=r.started_at, finished_at=r.finished_at,
                  reused=reused, quality_overview=(r.summary or {}).get("quality_overview")).model_dump(mode="json")


@app.post("/api/projects/{pid}/analyses")
def start_analysis(pid: str, body: AnalysisRequest, s: Session = Depends(get_session)):
    p = _project(s, pid)
    if p.status != "READY":
        raise HTTPException(409, "프로젝트 데이터 미준비 (demo-seed 필요)")
    g, ts, ds = _ground(s, p)
    scs = {x.code: x for x in p.scenarios}
    if "A" not in scs or "B" not in scs:
        raise HTTPException(409, "기준안 A/변경안 B가 모두 필요")
    params = body.model_dump(mode="json")
    reuse = params.pop("reuse_cache")
    site = services.site_dict(s, p)
    snapshot = {
        "frame": p.frame, "site_meta": {**p.site_meta, "disclaimer": demo.DISCLAIMER}, "site": site,
        "terrain": {"dataset_id": ds.id, "path": ds.path, "filename": ds.filename, "sha256": ds.sha256, "data_class": ts.data_class,
                    "native_cell_m": ts.native_cell_m, "vertical_datum": ts.vertical_datum, "vertical_datum_status": ts.vertical_datum_status,
                    "surface_type": ts.surface_type, "acquired": ts.acquired, "license": ts.license, "dem_qa": ds.qa,
                    "region_half_m": services.dataset_region(ds)[0], "mesh_spacing_m": services.dataset_region(ds)[1],
                    "source_meta": {k: v for k, v in (ds.meta or {}).items() if k.startswith("source_")}},
        "scenarios": {c: {"id": scs[c].id, "name": scs[c].name, "revision": scs[c].revision, "content_hash": scs[c].content_hash,
                          "transforms": services.transforms_of(scs[c])} for c in ("A", "B")},
    }
    key = make_cache_key(snapshot, params, body.analysis_type)
    snapshot["cache_key"] = key
    if reuse:
        prev = s.scalars(select(AnalysisRun).where(AnalysisRun.cache_key == key, AnalysisRun.status == "SUCCEEDED")
                         .order_by(AnalysisRun.created_at.desc())).first()
        if prev is not None:
            return _run_out(prev, reused=True)
    run = AnalysisRun(project_id=pid, analysis_type=body.analysis_type, params=params, snapshot=snapshot, cache_key=key, status="PENDING",
                      stage="대기", logs=[])
    s.add(run)
    s.commit()
    backend, job_id, note = jobs.enqueue("analysis", run.id)
    run = s.get(AnalysisRun, run.id)
    run.job_backend, run.job_id = backend, job_id
    run.logs = list(run.logs or []) + [{"stage": "큐 등록", "msg": note}]
    s.commit()
    return _run_out(run)


@app.get("/api/projects/{pid}/analyses")
def list_analyses(pid: str, s: Session = Depends(get_session)):
    _project(s, pid)
    runs = s.scalars(select(AnalysisRun).where(AnalysisRun.project_id == pid).order_by(AnalysisRun.created_at.desc())).all()
    for r in runs:
        _reap_run(s, r)
    return [_run_out(r) for r in runs]


STALE_PENDING_S, STALE_RUNNING_S, STALE_REPORT_S = 600, 900, 1200


def _age_s(t) -> float:
    from datetime import datetime, timezone
    if t is None:
        return 0.0
    if isinstance(t, str):
        t = datetime.fromisoformat(t)
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - t).total_seconds()


def _reap_run(s: Session, r: AnalysisRun) -> None:
    """Watchdog: a job whose worker died never finishes; surface it as FAILED instead of PENDING forever."""
    if r.status not in ("PENDING", "RUNNING"):
        return
    last = next((l.get("t") for l in reversed(r.logs or []) if l.get("t")), None) or r.started_at or r.created_at
    limit = STALE_PENDING_S if r.status == "PENDING" else STALE_RUNNING_S
    if _age_s(last) > limit:
        r.status = "FAILED"
        r.error = (f"작업 응답 없음 ({limit // 60}분 이상 진행 없음, backend={r.job_backend}). "
                   "worker 프로세스가 실행 중인지 확인 후 다시 실행하세요.")
        s.commit()


def _reap_report(s: Session, rp: Report) -> None:
    if rp.status in ("PENDING", "RUNNING") and _age_s(rp.created_at) > STALE_REPORT_S:
        rp.status, rp.error = "FAILED", f"보고서 작업 응답 없음 ({STALE_REPORT_S // 60}분 초과). worker 확인 후 다시 생성하세요."
        s.commit()


@app.get("/api/analyses/{rid}")
def get_analysis(rid: str, s: Session = Depends(get_session)):
    s.expire_all()
    r = _run(s, rid)
    _reap_run(s, r)
    return _run_out(r)


def _summary(r: AnalysisRun) -> dict:
    if r.status != "SUCCEEDED":
        raise HTTPException(409, f"분석이 완료되지 않음 (status={r.status})")
    return json.loads((Path(r.result_dir) / "analysis_summary.json").read_text(encoding="utf-8"))


@app.get("/api/analyses/{rid}/results")
def get_results(rid: str, s: Session = Depends(get_session)):
    r = _run(s, rid)
    sm = _summary(r)
    sm.pop("sun", None)
    for k in ("A",):
        if k in sm:
            sm[k] = {kk: vv for kk, vv in sm[k].items() if kk not in ("per_floor",)}
    from .report.builder import _exec_summary, _recommendations
    full = _summary(r)
    try:
        insights = {"exec": _exec_summary(full), "recs": _recommendations(full)}
    except Exception as exc:  # noqa: BLE001 - insights are a convenience; never block results
        insights = {"exec": [], "recs": [], "error": str(exc)[:200]}
    from .legal import check_run
    from .review import build_review
    try:
        legal = check_run(full, r.snapshot["site"], (_project(s, r.project_id).site_meta or {}).get("legal"))
    except Exception as exc:  # noqa: BLE001
        legal = {"error": str(exc)[:200]}
    try:
        review = build_review(full, Path(r.result_dir), legal)
    except Exception as exc:  # noqa: BLE001 - the verdict is derived; never block results
        review = {"level": "amber", "verdict": "검토 판정을 만들지 못했습니다", "items": [], "changes": [], "error": str(exc)[:200]}
    return {"run": _run_out(r), "summary": sm, "quality": r.quality, "files": _file_list(r), "insights": insights, "review": review, "legal": legal}


@app.get("/api/analyses/{rid}/scene")
def run_scene(rid: str, s: Session = Depends(get_session)):
    r = _run(s, rid)
    if r.status != "SUCCEEDED":
        raise HTTPException(409, "분석 미완료")
    snap = json.loads((Path(r.result_dir) / "scene_snapshot.json").read_text(encoding="utf-8"))
    p = s.get(Project, r.project_id)
    fr = services.frame_of(p)
    out = {"frame": snap["frame"], "model_matrix": fr.cesium_model_matrix(), "site": r.snapshot["site"], "scenarios": {}}
    from .scene.builder import ResolvedBuilding  # noqa: F401
    from shapely.geometry import Polygon
    from .scene.geometry import extrude
    for code, blds in snap["resolved"].items():
        lst = []
        for b in blds:
            v, t = extrude(Polygon(b["footprint"]), b["base_z"], b["top_z"])
            lst.append({**b, "mesh": {"vertices": v.round(4).ravel().tolist(), "indices": t.ravel().tolist()}})
        out["scenarios"][code] = lst
    out["pad_z"] = snap["ground_qa"]["pad_z_m"]
    return out


@app.get("/api/analyses/{rid}/ground-mesh")
def run_ground_mesh(rid: str, s: Session = Depends(get_session)):
    """Ground mesh rebuilt from the run's immutable terrain snapshot (hash-checked), not the currently active terrain."""
    r = _run(s, rid)
    t = r.snapshot["terrain"]
    from .geo.terrain import file_sha256
    if file_sha256(Path(t["path"])) != t["sha256"]:
        raise HTTPException(409, "스냅샷 지형 파일이 변경됨")
    fr = services.frame_of(s.get(Project, r.project_id))
    g = services.ground_for(t["path"], t["sha256"], fr.lat0, fr.lon0, tuple(r.snapshot["site"]["site_rect"]), 0.0,
                            t.get("region_half_m", 1200.0), t.get("mesh_spacing_m", 10.0))
    v, tri = g.mesh()
    return {"vertices_f32_b64": _b64(v.astype(np.float32)), "indices_u32_b64": _b64(tri.astype(np.uint32)), "n_vertices": len(v),
            "n_triangles": len(tri), "pad_z": g.pad_z, "pad_rect": g.pad_rect, "z_min": float(np.nanmin(g.z)), "z_max": float(np.nanmax(g.z)),
            "mesh_spacing_m": g.mesh_spacing_m, "region_half_m": float(g.xs.max()), "terrain_class": t["data_class"], "terrain_sha256": t["sha256"]}


@app.get("/api/analyses/{rid}/sunlight")
def sunlight(rid: str, building: str | None = None, s: Session = Depends(get_session)):
    r = _run(s, rid)
    sm = _summary(r)
    if "A" not in sm:
        raise HTTPException(404, "이 실행에 A 분석 없음")
    import csv
    rows = list(csv.DictReader(open(Path(r.result_dir) / "sunlight_receivers.csv", encoding="utf-8-sig")))
    if building:
        rows = [x for x in rows if x["building_id"] == building]
    num = ("x_a", "y_a", "z_a", "x_b", "y_b", "z_b", "nx_a", "ny_a", "nx_b", "ny_b", "sun_total_min_a", "sun_total_min_b", "delta_total_min", "max_cont_min_a",
           "max_cont_min_b", "delta_max_cont_min")
    for x in rows:
        for k in num:
            if k in x:
                x[k] = float(x[k])
        x["floor"] = int(x["floor"])
    return {"summary": {k: v for k, v in sm["A"].items()}, "receivers": rows, "sun": sm["sun"]}


@app.get("/api/analyses/{rid}/sunlight/receivers/{receiver_id}")
def receiver_series(rid: str, receiver_id: str, s: Session = Depends(get_session)):
    r = _run(s, rid)
    sm = _summary(r)
    z = np.load(Path(r.result_dir) / "sunlight_timeseries.npz")
    labels = [str(x) for x in z["labels"]]
    out = {"receiver_id": receiver_id, "times_local": sm["sun"]["times_local"], "azimuth_deg": sm["sun"]["azimuth_deg"],
           "elevation_deg": sm["sun"]["elevation_deg"], "dt_min": sm["params"]["interval_min"]}
    for code, ids, sun, blk in (("A", z["ids_a"], z["sun_a"], z["blk_a"]), ("B", z["ids_b"], z["sun_b"], z["blk_b"])):
        idx = np.nonzero(ids == receiver_id)[0]
        if len(idx) == 0:
            out[code] = None
            continue
        i = int(idx[0])
        out[code] = {"sun": sun[i].astype(int).tolist(),
                     "blocker": [labels[c] if c >= 0 else {-1: None, -2: "SUN_BELOW_HORIZON", -3: "BACK_FACING"}[int(c)] for c in blk[i]],
                     "total_min": float(sun[i].sum() * sm["params"]["interval_min"])}
    if out["A"] is None and out["B"] is None:
        raise HTTPException(404, "수광점 없음")
    return out


@app.get("/api/analyses/{rid}/shadow")
def shadow(rid: str, s: Session = Depends(get_session)):
    r = _run(s, rid)
    sm = _summary(r)
    if "B" not in sm:
        raise HTTPException(404, "이 실행에 B 분석 없음")
    z = np.load(Path(r.result_dir) / "shadow_grid.npz")
    ny, nx = len(z["ys"]), len(z["xs"])
    dt = sm["params"]["interval_min"]
    full = lambda vals: _grid_fill(ny, nx, z["vy"], z["vx"], vals)  # noqa: E731
    shade_a = z["shade_a"].sum(axis=1) * dt
    shade_b = z["shade_b"].sum(axis=1) * dt
    snaps = {}
    for k, t in enumerate(z["snap_times"]):
        a, b = z["snap_a"][:, k], z["snap_b"][:, k]
        st = np.where(a & b, 1, 0)
        st = np.where(~a & b, 2, st)
        st = np.where(a & ~b, 3, st)
        snaps[str(t)] = full(st.astype(float))
    return {"summary": sm["B"], "grid": {**sm["B"]["grid_meta"], "exclusion": z["exclusion"].ravel().tolist(),
                                          "shade_min_a": full(shade_a), "shade_min_b": full(shade_b), "delta_min": full(shade_b - shade_a),
                                          "snapshot_states": snaps},
            "state_names": {"0": "SUN→SUN", "1": "SHADE→SHADE", "2": "SUN→SHADE 신규 음영", "3": "SHADE→SUN 음영 해소"}}


def _grid_fill(ny, nx, vy, vx, vals) -> list:
    g = np.full((ny, nx), np.nan)
    g[vy, vx] = vals
    return [None if not np.isfinite(v) else round(float(v), 2) for v in g.ravel()]


@app.get("/api/analyses/{rid}/shadow/cell")
def shadow_cell(rid: str, x: float, y: float, s: Session = Depends(get_session)):
    r = _run(s, rid)
    sm = _summary(r)
    z = np.load(Path(r.result_dir) / "shadow_grid.npz")
    sp = sm["B"]["grid_meta"]["spacing"]
    ix = int(np.floor((x - (z["xs"][0] - sp / 2)) / sp))
    iy = int(np.floor((y - (z["ys"][0] - sp / 2)) / sp))
    if not (0 <= ix < len(z["xs"]) and 0 <= iy < len(z["ys"])):
        raise HTTPException(404, "격자 범위 밖")
    m = np.nonzero((z["vy"] == iy) & (z["vx"] == ix))[0]
    excl = int(z["exclusion"][iy, ix])
    if len(m) == 0:
        return {"x": float(z["xs"][ix]), "y": float(z["ys"][iy]), "excluded": True,
                "reason": {1: "건물 footprint 내부(A 또는 B)", 2: "NoData"}.get(excl, "제외")}
    i = int(m[0])
    dt = sm["params"]["interval_min"]
    return {"x": float(z["xs"][ix]), "y": float(z["ys"][iy]), "z": float(z["z"][iy, ix]), "excluded": False,
            "times_local": sm["sun"]["times_local"], "shade_a": z["shade_a"][i].astype(int).tolist(), "shade_b": z["shade_b"][i].astype(int).tolist(),
            "shade_min_a": float(z["shade_a"][i].sum() * dt), "shade_min_b": float(z["shade_b"][i].sum() * dt),
            "delta_min": float((z["shade_b"][i].sum() - z["shade_a"][i].sum()) * dt)}


@app.get("/api/analyses/{rid}/clearance")
def clearance(rid: str, s: Session = Depends(get_session)):
    r = _run(s, rid)
    sm = _summary(r)
    if "C" not in sm:
        raise HTTPException(404, "이 실행에 C 분석 없음")
    return sm["C"]


RUN_FILES = ["analysis_summary.json", "quality_check.json", "sunlight_receivers.csv", "sunlight_per_floor.csv", "sunlight_per_building.csv",
             "shadow_grid_cells.csv", "shadow_grid_changed.geojson", "shadow_area_curve.csv", "clearance_pairs.csv",
             "clearance_facade_normals.csv", "clearance_boundary.csv", "buildings_A.geojson", "buildings_B.geojson", "sensitivity.csv",
             "scene_snapshot.json"]


def _file_list(r: AnalysisRun) -> list[dict]:
    if not r.result_dir:
        return []
    d = Path(r.result_dir)
    return [{"name": f, "size": (d / f).stat().st_size, "url": f"/api/analyses/{r.id}/files/{f}"} for f in RUN_FILES if (d / f).exists()]


@app.get("/api/analyses/{rid}/files/{name}")
def run_file(rid: str, name: str, s: Session = Depends(get_session)):
    r = _run(s, rid)
    if name not in RUN_FILES or not r.result_dir:
        raise HTTPException(404, "파일 없음")
    f = Path(r.result_dir) / name
    if not f.exists() or f.stat().st_size == 0:
        raise HTTPException(404, "파일 없음")
    return FileResponse(f, filename=f"{rid}_{name}")


# ------------------------------------------------------------------------------------------- reports
def _report_out(rp: Report) -> dict:
    files = {k: {**v, "url": f"/api/reports/{rp.id}/download?format={k}"} for k, v in (rp.files or {}).items() if k in ("pdf", "html", "zip")}
    files.update({k: v for k, v in (rp.files or {}).items() if k not in ("pdf", "html", "zip")})
    return ReportOut(id=rp.id, run_id=rp.run_id, status=rp.status, stage=rp.stage, error=rp.error, version=rp.version, files=files,
                     quality=rp.quality or {}, created_at=rp.created_at, finished_at=rp.finished_at).model_dump(mode="json")


@app.post("/api/analyses/{rid}/reports")
def create_report(rid: str, s: Session = Depends(get_session)):
    r = _run(s, rid)
    if r.status != "SUCCEEDED":
        raise HTTPException(409, "분석이 성공적으로 완료된 실행만 보고서를 생성할 수 있음 (가짜 수치 보고서 방지)")
    rp = Report(run_id=rid, status="PENDING", stage="대기")
    s.add(rp)
    s.commit()
    backend, job_id, note = jobs.enqueue("report", rp.id)
    rp = s.get(Report, rp.id)
    rp.stage = f"큐 등록: {note}"
    s.commit()
    return _report_out(rp)


@app.get("/api/analyses/{rid}/reports")
def list_reports(rid: str, s: Session = Depends(get_session)):
    _run(s, rid)
    reps = s.scalars(select(Report).where(Report.run_id == rid).order_by(Report.created_at.desc())).all()
    for x in reps:
        _reap_report(s, x)
    return [_report_out(x) for x in reps]


@app.get("/api/reports/{report_id}")
def get_report(report_id: str, s: Session = Depends(get_session)):
    s.expire_all()
    rp = s.get(Report, report_id)
    if rp is None:
        raise HTTPException(404, "보고서 없음")
    _reap_report(s, rp)
    return _report_out(rp)


@app.get("/api/reports/{report_id}/download")
def download_report(report_id: str, format: str = Query("pdf", pattern="^(pdf|html|zip)$"), s: Session = Depends(get_session)):  # noqa: A002
    rp = s.get(Report, report_id)
    if rp is None or rp.status != "SUCCEEDED":
        raise HTTPException(404, "생성 완료된 보고서 없음")
    info = (rp.files or {}).get(format)
    if not info:
        raise HTTPException(404, f"{format} 파일 없음")
    f = Path(info["path"])
    if not f.exists() or f.stat().st_size == 0:
        raise HTTPException(404, "파일 없음")
    media = {"pdf": "application/pdf", "html": "text/html; charset=utf-8", "zip": "application/zip"}[format]
    return FileResponse(f, filename=f.name, media_type=media)


@app.get("/api/reports/{report_id}/view", response_class=HTMLResponse)
def view_report(report_id: str, s: Session = Depends(get_session)):
    rp = s.get(Report, report_id)
    if rp is None or rp.status != "SUCCEEDED":
        raise HTTPException(404, "생성 완료된 보고서 없음")
    return HTMLResponse(Path(rp.files["html"]["path"]).read_text(encoding="utf-8"))


@app.get("/api/reports/{report_id}/assets/{name}")
def report_asset(report_id: str, name: str, s: Session = Depends(get_session)):
    rp = s.get(Report, report_id)
    if rp is None:
        raise HTTPException(404)
    d = Path(rp.files.get("html", {}).get("path", "")).parent / "figures"
    f = d / name
    if not f.exists() or "/" in name or "\\" in name:
        raise HTTPException(404)
    return FileResponse(f)


# ------------------------------------------------------------------------------------------- interactive UX endpoints
class PreviewRequest(BaseModel):
    transforms: dict[str, dict] | None = None  # draft transforms for B (unsaved); default = saved B
    date: str = "2026-12-22"


@app.post("/api/projects/{pid}/preview")
def preview(pid: str, body: PreviewRequest, s: Session = Depends(get_session)):
    """Coarse live impact preview of a (possibly unsaved) variant B. Not persisted, not used in reports."""
    from datetime import date as _date
    from .preview import quick_preview
    p = _project(s, pid)
    g, _, _ = _ground(s, p)
    sc = next((x for x in p.scenarios if x.code == "B"), None)
    tr = body.transforms if body.transforms is not None else (services.transforms_of(sc) if sc else {})
    if sc is not None and services.layout_of(sc):
        tr = services.transforms_of(sc)
    sa = next((x for x in p.scenarios if x.code == "A"), None)
    tr_a = services.transforms_of(sa) if sa else {}
    lim = {"dx": 60, "dy": 60, "rot_deg": 45, "floors_delta": 10}
    for bid, t in tr.items():
        if bid == LAYOUT_KEY:
            continue
        for k, v in t.items():
            if k in lim and abs(float(v)) > lim[k]:
                raise HTTPException(422, f"{bid}.{k}={v} 허용범위 밖")
    fr = services.frame_of(p)
    try:
        return quick_preview(services.site_dict(s, p), g, tr, _date.fromisoformat(body.date), fr.lat0, fr.lon0, tr_a)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/projects/{pid}/terrain-grid")
def terrain_grid(pid: str, s: Session = Depends(get_session)):
    from .preview import grid_payload
    g, _, _ = _ground(s, _project(s, pid))
    return grid_payload(g)


@app.get("/api/analyses/{rid}/terrain-grid")
def run_terrain_grid(rid: str, s: Session = Depends(get_session)):
    from .preview import grid_payload
    from .geo.terrain import file_sha256
    r = _run(s, rid)
    t = r.snapshot["terrain"]
    if file_sha256(Path(t["path"])) != t["sha256"]:
        raise HTTPException(409, "스냅샷 지형 파일이 변경됨")
    fr = services.frame_of(s.get(Project, r.project_id))
    g = services.ground_for(t["path"], t["sha256"], fr.lat0, fr.lon0, tuple(r.snapshot["site"]["site_rect"]), 0.0,
                            t.get("region_half_m", 1200.0), t.get("mesh_spacing_m", 10.0))
    return grid_payload(g)


@app.get("/api/sun")
def sun_path(date: str = "2026-12-22", lat: float = 37.5559943, lon: float = 126.7545222):  # noqa: A002
    """Sun azimuth/elevation (pvlib NREL SPA) for the day + solstice/equinox reference curves (KST)."""
    from datetime import date as _date
    from .analysis.solar import sample_window
    d = _date.fromisoformat(date)
    def curve(day):
        sw = sample_window(day, "05:00", "20:00", 5, lat, lon)
        return {"time": [t.strftime("%H:%M") for t in sw.times_local], "utc": sw.times_utc_iso,
                "az": sw.azimuth_deg.round(3).tolist(), "el": sw.elevation_deg.round(3).tolist()}
    main = curve(d)
    el = np.array(main["el"])
    up = np.nonzero(el > 0)[0]
    return {"date": date, "timezone": "Asia/Seoul", "day": main,
            "sunrise_approx": main["time"][up[0]] if len(up) else None, "sunset_approx": main["time"][up[-1]] if len(up) else None,
            "noon_elevation_max": float(el.max()),
            "reference": {k: curve(_date(d.year, m, dd)) for k, (m, dd) in {"동지": (12, 22), "춘·추분": (3, 20), "하지": (6, 21)}.items()}}


@app.get("/api/analyses/{rid}/shadow/timeline")
def shadow_timeline(rid: str, s: Session = Depends(get_session)):
    """Per-interval shade bits of every valid cell for A and B (row-major order of valid cells) for time-lapse maps."""
    r = _run(s, rid)
    sm = _summary(r)
    if "B" not in sm:
        raise HTTPException(404, "이 실행에 B 분석 없음")
    z = np.load(Path(r.result_dir) / "shadow_grid.npz")
    a = np.packbits(z["shade_a"].T.astype(np.uint8), axis=1)  # (T, ceil(C/8))
    b = np.packbits(z["shade_b"].T.astype(np.uint8), axis=1)
    return {"n_cells": int(z["shade_a"].shape[0]), "times_local": [t[11:19] for t in sm["sun"]["times_local"]],
            "times_utc": sm["sun"]["times_utc"], "bytes_per_time": int(a.shape[1]),
            "shade_a_b64": _b64(a), "shade_b_b64": _b64(b), "bit_order": "numpy packbits big-endian, cells in row-major valid order"}


# ------------------------------------------------------------------------------------------- single-service deploy
@app.get("/api/ping")
def ping():
    """Lightweight liveness probe (no Redis / Chromium calls)."""
    return {"ok": True, "engine_version": ENGINE_VERSION}


_WEB = Path(os.environ.get("WEB_DIST", "")) if os.environ.get("WEB_DIST") else None
if _WEB is not None and (_WEB / "index.html").exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/assets", StaticFiles(directory=_WEB / "assets"), name="assets")
    app.mount("/cesium", StaticFiles(directory=_WEB / "cesium"), name="cesium")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        """Serve the built React app (client-side routes fall back to index.html)."""
        if full_path.startswith("api/"):
            raise HTTPException(404)
        f = (_WEB / full_path).resolve()
        if full_path and f.is_file() and str(f).startswith(str(_WEB.resolve())):
            return FileResponse(f)
        return FileResponse(_WEB / "index.html")
