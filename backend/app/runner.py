"""Analysis job: immutable snapshot in -> A/B/C results, sensitivity, QA, files and DB rows out."""
from __future__ import annotations

import csv
import json
import platform
import time
import traceback
from datetime import date, datetime, timezone
from importlib.metadata import version as pkg_version
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, Polygon
from sqlalchemy import delete, select

from .analysis import clearance as C
from .analysis import qa as QA
from .analysis.shadow import compare_shadow, compute_shadow, make_grid, snapshot_states
from .analysis.solar import ELEVATION_FIELD, SOLAR_METHOD, instants, sample_window
from .analysis.dwellings import compare_dwellings, make_dwellings
from .analysis.sunlight import compare_sunlight, compute_sunlight
from .config import ALGORITHM_VERSION, DATA_DIR, ENGINE_NAME, ENGINE_VERSION, code_commit_hash
from .db import (AnalysisRun, ClearancePair, Floor, Project, RaySample, SessionLocal, ShadowGridCell, WindowReceiver, utcnow)
from .geo.enu import LocalFrame
from .geo.terrain import build_ground, DemSampler, file_sha256, horizon_check
from .scene.builder import LAYOUT_KEY, build_scene, building_mesh, changed_ids, footprint_geojson, resolve_scenario, snapshot_json, stable_hash

DEPENDENCIES = ["numpy", "open3d", "pvlib", "shapely", "pyproj", "rasterio", "trimesh", "fastapi", "sqlalchemy", "rq", "playwright", "matplotlib"]


def dependency_versions() -> dict:
    out = {"python": platform.python_version()}
    for d in DEPENDENCIES:
        try:
            out[d] = pkg_version(d)
        except Exception:  # noqa: BLE001
            out[d] = None
    return out


def run_dir(run_id: str) -> Path:
    p = DATA_DIR / "runs" / run_id
    p.mkdir(parents=True, exist_ok=True)
    return p


class Progress:
    def __init__(self, run_id: str):
        self.run_id = run_id
        self.t0 = time.time()

    def __call__(self, pct: float, stage: str, msg: str | None = None) -> None:
        with SessionLocal() as s:
            r = s.get(AnalysisRun, self.run_id)
            r.progress = round(pct, 1)
            r.stage = stage
            logs = list(r.logs or [])
            logs.append({"t": datetime.now(timezone.utc).isoformat(timespec="seconds"), "elapsed_s": round(time.time() - self.t0, 2),
                         "pct": round(pct, 1), "stage": stage, "msg": msg or stage})
            r.logs = logs
            s.commit()


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    raise TypeError(type(o))


def write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1, default=_json_default), encoding="utf-8")


def write_csv(path: Path, rows: list[dict], fields: list[str] | None = None) -> None:
    fields = fields or (list(rows[0].keys()) if rows else ["empty"])
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v) for k, v in r.items()})


def _metrics_case(site, transforms_a, transforms_b, ground, gmesh, sun, params, open_spaces, rect, changed):
    A = resolve_scenario(site, transforms_a, ground)
    B = resolve_scenario(site, transforms_b, ground)
    sA, sB = build_scene(A, ground, ground_mesh=gmesh), build_scene(B, ground, ground_mesh=gmesh)
    out = {}
    if params["run_a"]:
        ca = compare_sunlight(compute_sunlight(sA, sun), compute_sunlight(sB, sun), changed)
        out.update({"A_mean_total_min_a": ca["mean_total_min_a"], "A_mean_total_min_b": ca["mean_total_min_b"],
                    "A_n_decreased": ca["n_decreased"], "A_delta_total_min_min": ca["delta_total_min_min"]})
    if params["run_b"]:
        grid = make_grid(gmesh, rect, params["grid_spacing_m"], [b.footprint for b in A + B])
        cb = compare_shadow(grid, compute_shadow(sA, grid, sun), compute_shadow(sB, grid, sun), sun, open_spaces)
        out.update({"B_mean_shade_min_a": cb["mean_shade_min_a"], "B_mean_shade_min_b": cb["mean_shade_min_b"],
                    "B_max_new_shade_area_m2": cb["max_new_shade_area_m2"], "B_area_more_shade_m2": cb["area_more_shade_m2"]})
    return out


def execute(run_id: str) -> None:
    prog = Progress(run_id)
    t_start = time.time()
    with SessionLocal() as s:
        run = s.get(AnalysisRun, run_id)
        run.status = "RUNNING"
        run.started_at = utcnow()
        s.commit()
        snap = dict(run.snapshot)
        params = dict(run.params)
        atype = run.analysis_type
    try:
        _execute(run_id, snap, params, atype, prog)
        with SessionLocal() as s:
            run = s.get(AnalysisRun, run_id)
            run.status = "SUCCEEDED"
            run.progress = 100.0
            run.stage = "완료"
            run.finished_at = utcnow()
            run.processing_seconds = round(time.time() - t_start, 2)
            s.commit()
        prog(100.0, "완료", f"총 처리시간 {time.time() - t_start:.1f}s")
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        with SessionLocal() as s:
            run = s.get(AnalysisRun, run_id)
            run.status = "FAILED"
            run.error = f"{type(exc).__name__}: {exc}"
            run.finished_at = utcnow()
            logs = list(run.logs or [])
            logs.append({"t": datetime.now(timezone.utc).isoformat(timespec="seconds"), "stage": "오류", "msg": tb[-2000:]})
            run.logs = logs
            s.commit()


def _execute(run_id: str, snap: dict, params: dict, atype: str, prog: Progress) -> None:
    out = run_dir(run_id)
    fr = LocalFrame(snap["frame"]["lat0"], snap["frame"]["lon0"], snap["frame"].get("h0", 0.0))
    terrain = snap["terrain"]
    tpath = Path(terrain["path"])
    prog(2, "입력 검증", "지형 파일 해시 확인")
    if file_sha256(tpath) != terrain["sha256"]:
        raise RuntimeError("지형 파일 해시가 스냅샷과 다름 - 입력 변경 감지")
    if terrain["vertical_datum_status"] == "UNRESOLVED" and not params.get("allow_unresolved_vertical_datum", True):
        raise RuntimeError("vertical_datum_unresolved: 수직기준 미해결 자료로 물리 분석이 제한됨")
    site = snap["site"]
    rect = tuple(site["site_rect"])
    prog(5, "지반 메쉬 생성", "30m DEM 샘플 + 가상 계획지반 접합")
    rhalf, rmesh = float(terrain.get("region_half_m", 1200.0)), float(terrain.get("mesh_spacing_m", 10.0))
    ground = build_ground(DemSampler(tpath, fr), rect, region_half_m=rhalf, mesh_spacing_m=rmesh)
    gmesh = ground.mesh()
    tr_a, tr_b = snap["scenarios"]["A"]["transforms"], snap["scenarios"]["B"]["transforms"]
    A = resolve_scenario(site, tr_a, ground)
    B = resolve_scenario(site, tr_b, ground)
    changed = changed_ids(A, B)
    sA = build_scene(A, ground, ground_mesh=gmesh)
    sB = build_scene(B, ground, ground_mesh=gmesh)
    day = date.fromisoformat(params["date"])
    sun = sample_window(day, params["start"], params["end"], params["interval_min"], fr.lat0, fr.lon0, params["timezone"])
    snaps = instants(day, params["snapshot_times"], fr.lat0, fr.lon0, params["timezone"])
    run_a = atype in ("A", "ALL")
    run_b = atype in ("B", "ALL")
    run_c = atype in ("C", "ALL")
    params.update({"run_a": run_a, "run_b": run_b, "run_c": run_c})
    hz = horizon_check(ground, float(sun.elevation_deg.min()))
    summary: dict = {
        "run_id": run_id, "analysis_type": atype, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "disclaimer": snap["site_meta"].get("disclaimer"),
        "params": {k: v for k, v in params.items()},
        "sun": {"method": f"pvlib.solarposition.get_solarposition(method='{SOLAR_METHOD}')", "elevation_field": ELEVATION_FIELD,
                "time_rule": "구간 중점 규칙(interval-midpoint): 각 구간 중점 시각의 태양위치로 Δt분을 대표. 전이(일조↔차폐)당 최대 ±Δt/2 오차",
                "n_intervals": len(sun.vectors), "elevation_min_deg": float(sun.elevation_deg.min()),
                "elevation_max_deg": float(sun.elevation_deg.max()),
                "times_local": [t.isoformat() for t in sun.times_local], "times_utc": sun.times_utc_iso,
                "azimuth_deg": sun.azimuth_deg.round(4).tolist(), "elevation_deg": sun.elevation_deg.round(4).tolist(),
                "snapshots": [{"time_local": t.isoformat(), "time_utc": u, "azimuth_deg": round(float(a), 4), "elevation_deg": round(float(e), 4)}
                              for t, u, a, e in zip(snaps.times_local, snaps.times_utc_iso, snaps.azimuth_deg, snaps.elevation_deg)]},
        "ground": {**ground.qa, "horizon": hz},
        "terrain": terrain,
        "scenarios": {"A": {**snap["scenarios"]["A"], **snapshot_json(A)}, "B": {**snap["scenarios"]["B"], **snapshot_json(B)}},
        "changed_buildings": sorted(changed),
        "counts": {"buildings": len(A), "main_buildings": sum(b.kind == "MAIN" for b in A), "receivers_a": len(sA.receivers),
                   "receivers_b": len(sB.receivers), "ground_vertices": int(len(gmesh[0])), "ground_triangles": int(len(gmesh[1]))},
        "coverage": {
            "modelled": f"가상 주동 + 주변 참고건물(가상) + {2 * rhalf / 1000:.1f} km × {2 * rhalf / 1000:.1f} km 지형({rmesh:.0f} m 메쉬, "
                        f"{'합성' if terrain['data_class'] == 'SYNTHETIC' else '업로드'} DEM 기반)",
            "not_modelled": f"실제 주변 건물·수목·옹벽·담장(DEM 표면에 섞인 부분 제외), {2 * rhalf / 1000:.1f} km 영역 밖 산지/건물, 발코니·돌출부 등 상세 형상",
            "flag": "MODELLED_OBSTRUCTIONS_ONLY",
        },
        "warnings": sorted({w for b in A + B for w in b.warnings} | set(ground.qa.get("warnings", []))
                           | ({"분석영역 경계 지형 고도각이 최소 태양고도에 근접 - 외곽 차폐 가능성"} if hz["outside_region_obstruction_possible"] else set())
                           | ({"vertical_datum_unresolved: 상대고도 통일기준으로만 분석"} if terrain["vertical_datum_status"] == "UNRESOLVED" else set())),
        "timing_s": {},
    }
    resolved = {"A": [b.to_json() for b in A], "B": [b.to_json() for b in B]}
    write_json(out / "scene_snapshot.json", {"frame": snap["frame"], "resolved": resolved, "ground_qa": ground.qa})
    for code, blds in (("A", A), ("B", B)):
        write_json(out / f"buildings_{code}.geojson", {"type": "FeatureCollection", "name": f"scenario_{code}",
                                                        "features": [footprint_geojson(b, fr) for b in blds]})
    qa_checks: list[dict] = []

    # ---------------- C clearance (first: cheap, geometry only)
    if run_c:
        t = time.time()
        prog(10, "C. 이격거리", "footprint 쌍별 최단거리·법선거리 계산")
        boundary = Polygon(site["site_boundary"]) if site.get("site_boundary") else None
        cc = C.compare_clearance(C.pairwise(A), C.pairwise(B), C.facade_normal_distances(A), C.facade_normal_distances(B),
                                 C.boundary_distances(A, boundary), C.boundary_distances(B, boundary))
        cc["boundary_class"] = site.get("site_boundary_class")
        write_csv(out / "clearance_pairs.csv", cc["pairs"])
        write_csv(out / "clearance_facade_normals.csv", cc["facade_normals"])
        write_csv(out / "clearance_boundary.csv", cc["boundary"])
        summary["C"] = cc
        summary["timing_s"]["C"] = round(time.time() - t, 3)
        aa = C.compare_clearance(C.pairwise(A), C.pairwise(A), [], [], [], [])
        qa_checks.append(QA.check("C: A==A 이격 delta 0", all(r["delta_m"] == 0 for r in aa["pairs"]), {"n_pairs": aa["n_pairs"]}))

    # ---------------- A sunlight
    if run_a:
        t = time.time()
        prog(20, "A. 직사일조", f"수광점 {len(sA.receivers)}/{len(sB.receivers)}개 × {len(sun.vectors)}구간 레이캐스팅")
        ra, rb = compute_sunlight(sA, sun), compute_sunlight(sB, sun)
        ca = compare_sunlight(ra, rb, changed)
        ca["rays_cast"] = ra.rays_cast + rb.rays_cast
        ca["offset_m"] = ra.offset_m
        ca["receiver_type"] = "facade_proxy (실제 창호·세대 위치 아님)"
        write_csv(out / "sunlight_receivers.csv", ca["rows"])
        write_csv(out / "sunlight_per_floor.csv", ca["per_floor"])
        write_csv(out / "sunlight_per_building.csv", ca["per_building"])
        np.savez_compressed(out / "sunlight_timeseries.npz", ids_a=np.array(ra.receiver_ids), ids_b=np.array(rb.receiver_ids),
                            sun_a=ra.sun, sun_b=rb.sun, blk_a=ra.blocker, blk_b=rb.blocker, labels=np.array(ra.labels))
        summary["A"] = {k: v for k, v in ca.items() if k not in ("rows",)}
        # per dwelling (동·호) on each main building's main window wall
        mf = ((snap.get("site_meta") or {}).get("legal") or {}).get("main_facade") or {}
        dA = [d for b in A if b.kind == "MAIN" for d in make_dwellings(b, mf.get(b.id))]
        dB = [d for b in B if b.kind == "MAIN" for d in make_dwellings(b, mf.get(b.id))]
        if dA and dB:
            cu = compare_dwellings(compute_sunlight(sA, sun, receivers=dA), compute_sunlight(sB, sun, receivers=dB),
                                   sun.times_local, sun.dt_min, changed)
            write_csv(out / "dwellings.csv", cu["rows"])
            summary["U"] = cu
        summary["timing_s"]["A"] = round(time.time() - t, 3)
        prog(38, "A. 직사일조 저장", "수광점 결과 DB 저장")
        with SessionLocal() as s:
            for code, rr in (("A", ra), ("B", rb)):
                lab = rr.labels
                for k, rid in enumerate(rr.receiver_ids):
                    bl = ",".join(lab[c] if c >= 0 else "" for c in rr.blocker[k])
                    s.add(RaySample(run_id=run_id, scenario=code, receiver_id=rid, sun_bits="".join("1" if v else "0" for v in rr.sun[k]),
                                    blockers=bl, total_min=float(rr.total_min[k]), max_cont_min=float(rr.max_continuous_min[k])))
                recs = sA.receivers if code == "A" else sB.receivers
                s.bulk_save_objects([WindowReceiver(run_id=run_id, scenario=code, receiver_id=r.receiver_id, building_id=r.building_id,
                                                    floor=r.floor, facade=r.facade, x=r.position[0], y=r.position[1], z=r.position[2],
                                                    nx=r.normal[0], ny=r.normal[1]) for r in recs])
                for b in (A if code == "A" else B):
                    if b.kind == "MAIN":
                        for f in range(1, b.floors + 1):
                            s.add(Floor(id=f"{run_id}-{code}-{b.id}-F{f:02d}", run_id=run_id, scenario=code, building_id=b.id, floor=f,
                                        base_z=b.base_z + (f - 1) * 2.9))
            s.commit()
        # QA - identity (B computed from A's snapshot must equal A), self-hit, engine cross-check
        prog(42, "A. QA", "A==B 동일조건, 자가교차 offset, 엔진 교차검증")
        sAA = build_scene(resolve_scenario(site, tr_a, ground), ground, ground_mesh=gmesh)
        idn = compare_sunlight(ra, compute_sunlight(sAA, sun), set())
        qa_checks.append(QA.check("A: A==B(동일 입력) 직사일조 delta 0", idn["n_decreased"] == 0 and idn["n_increased"] == 0 and idn["delta_total_min_min"] == 0,
                                  {"n_receivers": idn["n_common"], "n_decreased": idn["n_decreased"], "n_increased": idn["n_increased"]}))
        sh = QA.self_hit_check(sA, sun, sA.receivers)
        qa_checks.append(QA.check("A: 수광점 자가교차 방지 offset", sh["self_hits_managed"] == 0, sh))
        rng = np.random.default_rng(7)
        pick = rng.choice(len(sA.receivers), size=min(600, len(sA.receivers)), replace=False)
        ti = rng.integers(0, len(sun.vectors), size=len(pick))
        P = np.array([sA.receivers[i].position for i in pick]) + np.array([sA.receivers[i].normal for i in pick]) * ra.offset_m
        meshes = [(b.id, *building_mesh(b)) for b in A]
        xc = QA.engine_crosscheck(meshes, P, sun.vectors[ti])
        qa_checks.append(QA.check("A: Open3D vs 독립 Möller–Trumbore 교차검증(건물 메쉬)", xc["hit_agreement_ratio"] >= 0.995, xc))

    # ---------------- B shadow
    if run_b:
        t = time.time()
        prog(48, "B. 그림자 격자", f"{params['grid_spacing_m']} m 분석격자 생성 (지면 메쉬 수직 레이 샘플)")
        grid = make_grid(gmesh, rect, params["grid_spacing_m"], [b.footprint for b in A + B])
        prog(52, "B. 그림자 계산", f"유효 {int(grid.valid.sum())}셀 × {len(sun.vectors)}구간 × 2안")
        sha, shb = compute_shadow(sA, grid, sun), compute_shadow(sB, grid, sun)
        cb = compare_shadow(grid, sha, shb, sun, site["open_spaces"])
        arrs = cb.pop("_cell_arrays")
        cb["rays_cast"] = sha.rays_cast + shb.rays_cast
        # snapshot instants
        ssa, ssb = compute_shadow(sA, grid, snaps), compute_shadow(sB, grid, snaps)
        snap_rows = []
        for k, tl in enumerate(snaps.times_local):
            if snaps.elevation_deg[k] <= 0:
                snap_rows.append({"time_local": tl.strftime("%H:%M"), "status": "SUN_BELOW_HORIZON"})
                continue
            stt = snapshot_states(ssa.shade[:, k], ssb.shade[:, k])
            snap_rows.append({"time_local": tl.strftime("%H:%M"), "status": "OK",
                              "new_shade_area_m2": float((stt == 2).sum() * grid.cell_area),
                              "relieved_area_m2": float((stt == 3).sum() * grid.cell_area),
                              "shade_area_a_m2": float(ssa.shade[:, k].sum() * grid.cell_area),
                              "shade_area_b_m2": float(ssb.shade[:, k].sum() * grid.cell_area)})
        cb["snapshots"] = snap_rows
        vy, vx = np.nonzero(grid.valid)
        np.savez_compressed(out / "shadow_grid.npz", xs=grid.xs, ys=grid.ys, z=grid.z, exclusion=grid.exclusion, vy=vy, vx=vx,
                            shade_a=sha.shade, shade_b=shb.shade, snap_a=ssa.shade, snap_b=ssb.shade,
                            snap_times=np.array([t.strftime("%H:%M") for t in snaps.times_local]))
        cell_rows = [{"cell_index": int(i), "x_enu": round(float(arrs["x"][i]), 2), "y_enu": round(float(arrs["y"][i]), 2),
                      "z": round(float(grid.z[vy[i], vx[i]]), 3), "shade_min_a": float(arrs["shade_min_a"][i]),
                      "shade_min_b": float(arrs["shade_min_b"][i]), "delta_shade_min": float(arrs["delta"][i])} for i in range(len(vy))]
        write_csv(out / "shadow_grid_cells.csv", cell_rows)
        write_csv(out / "shadow_area_curve.csv", [dict(zip(cb["curve"].keys(), vals)) for vals in zip(*cb["curve"].values())])
        # GeoJSON cells (WGS84) - only cells with any change to keep the file manageable, plus full CSV above
        h = grid.spacing / 2
        feats = []
        changed_idx = np.nonzero(arrs["delta"] != 0)[0]
        corners = []
        for i in changed_idx:
            x, y = arrs["x"][i], arrs["y"][i]
            corners.append([[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h], [x - h, y - h]])
        if corners:
            flat = np.array(corners).reshape(-1, 2)
            lon, lat = fr.enu_xy_to_lonlat(flat)
            ll = np.column_stack([lon, lat]).reshape(-1, 5, 2)
            for k, i in enumerate(changed_idx):
                feats.append({"type": "Feature", "properties": {"cell_index": int(i), "shade_min_a": float(arrs["shade_min_a"][i]),
                                                                "shade_min_b": float(arrs["shade_min_b"][i]), "delta_shade_min": float(arrs["delta"][i])},
                              "geometry": {"type": "Polygon", "coordinates": [ll[k].round(8).tolist()]}})
        write_json(out / "shadow_grid_changed.geojson", {"type": "FeatureCollection", "name": "shadow_delta_cells_changed_only",
                                                         "note": "음영시간 변화가 있는 셀만 포함. 전체 셀은 shadow_grid_cells.csv", "features": feats})
        summary["B"] = cb
        summary["B"]["grid_meta"] = {"x0": float(grid.xs[0]), "y0": float(grid.ys[0]), "nx": len(grid.xs), "ny": len(grid.ys),
                                     "spacing": grid.spacing, "note": "2 m 격자는 분석 샘플링 간격이며 DEM 정확도가 아님"}
        summary["timing_s"]["B"] = round(time.time() - t, 3)
        prog(66, "B. 저장", "격자 결과 DB 저장")
        with SessionLocal() as s:
            s.bulk_save_objects([ShadowGridCell(run_id=run_id, cell_index=r["cell_index"], x=r["x_enu"], y=r["y_enu"], z=r["z"],
                                                shade_min_a=r["shade_min_a"], shade_min_b=r["shade_min_b"], delta_min=r["delta_shade_min"])
                                 for r in cell_rows])
            s.commit()
        sAA = build_scene(resolve_scenario(site, tr_a, ground), ground, ground_mesh=gmesh)
        idb = compare_shadow(grid, sha, compute_shadow(sAA, grid, sun), sun, site["open_spaces"])
        qa_checks.append(QA.check("B: A==B(동일 입력) 신규음영·해소 면적 0",
                                  max(idb["curve"]["new_shade_area_m2"] + [0]) == 0 and max(idb["curve"]["relieved_area_m2"] + [0]) == 0
                                  and idb["delta_min_max"] == 0 and idb["delta_min_min"] == 0,
                                  {"max_new": max(idb["curve"]["new_shade_area_m2"] + [0]), "max_relieved": max(idb["curve"]["relieved_area_m2"] + [0])}))
        qa_checks.append(QA.check("B: A/B 공통 분모(유효격자) 일치", sha.shade.shape == shb.shade.shape,
                                  {"cells": int(sha.shade.shape[0]), "valid_area_m2": cb["valid_area_m2"]}))

    if run_c and (run_a or run_b):
        prog(70, "통합", "A/B/C 교차표 작성")
    with SessionLocal() as s:
        if run_c:
            for r in summary["C"]["pairs"]:
                s.add(ClearancePair(run_id=run_id, pair_id=r["pair_id"], distance_a_m=r["distance_a_m"], distance_b_m=r["distance_b_m"],
                                    delta_m=r["delta_m"], status_a=r["status_a"], status_b=r["status_b"],
                                    geom_wkt_a=LineString([r["p_a_A"], r["p_b_A"]]).wkt, geom_wkt_b=LineString([r["p_a_B"], r["p_b_B"]]).wkt))
        s.commit()
    summary["integrated"] = integrate(summary)

    # ---------------- generic QA
    prog(72, "QA", "해석해·좌표 round-trip·태양벡터")
    noon = instants(day, ["12:00"], fr.lat0, fr.lon0, params["timezone"])
    pole = QA.pole_shadow_length(30.0, float(noon.elevation_deg[0]), float(noon.azimuth_deg[0]))
    qa_checks.append(QA.check("해석해: 기둥 그림자 L=H/tan(α) (정오)", pole["abs_error_m"] <= 0.05, pole))
    qa_checks.append(QA.check("그림자 방향: 북반구 겨울 정오 그림자는 북쪽(방위 0°±25°)",
                              pole["shadow_azimuth_deg"] < 25 or pole["shadow_azimuth_deg"] > 335, {"shadow_azimuth_deg": pole["shadow_azimuth_deg"]}))
    rt = QA.roundtrip(fr, rect)
    qa_checks.append(QA.check("좌표 ENU↔ECEF↔WGS84 round-trip", rt["max_error_geodetic_roundtrip_m"] < 1e-3, rt))
    vn = np.linalg.norm(sun.vectors, axis=1)
    noon_ok = 150 < float(noon.azimuth_deg[0]) < 210
    qa_checks.append(QA.check("태양벡터 단위길이·정오 남중 방위", bool(np.allclose(vn, 1.0)) and noon_ok,
                              {"max_norm_error": float(np.abs(vn - 1).max()), "noon_azimuth_deg": float(noon.azimuth_deg[0]),
                               "noon_elevation_deg": float(noon.elevation_deg[0])}))
    qa_checks.append(QA.check("수직기준 상태 기록", True, {"vertical_datum": terrain["vertical_datum"], "status": terrain["vertical_datum_status"]}, critical=False))
    jb = ground.qa
    qa_checks.append(QA.check("단지 접합부 경사 QA (≤20°)", (jb["blend_band_slope_max_deg"] or 0) <= 20, {"max_deg": jb["blend_band_slope_max_deg"]}, critical=False))
    qa_checks.append(QA.check("분석영역 밖 차폐 경고", not hz["outside_region_obstruction_possible"], hz, critical=False))

    # ---------------- sensitivity
    if params.get("include_sensitivity", True) and (run_a or run_b):
        sens = []
        base_case = _metrics_case(site, tr_a, tr_b, ground, gmesh, sun, params, site["open_spaces"], rect, changed)
        sens.append({"case": "기준(Δt=%g분, 계획지반 가정)" % params["interval_min"], **base_case})
        prog(76, "민감도", "Δt=1분 비교")
        sun1 = sample_window(day, params["start"], params["end"], 1.0, fr.lat0, fr.lon0, params["timezone"])
        sens.append({"case": "시간간격 Δt=1분", **_metrics_case(site, tr_a, tr_b, ground, gmesh, sun1, params, site["open_spaces"], rect, changed)})
        for k, off in enumerate((-3.0, -1.0, 1.0, 3.0)):
            prog(80 + k * 3, "민감도", f"가상 계획지반 {off:+.0f} m")
            g2 = build_ground(DemSampler(tpath, fr), rect, region_half_m=rhalf, mesh_spacing_m=rmesh, pad_offset_m=off)
            sens.append({"case": f"가상 계획지반고 {off:+.0f} m", **_metrics_case(site, tr_a, tr_b, g2, g2.mesh(), sun, params, site["open_spaces"], rect, changed)})
        prog(93, "민감도", "변경 건물 +0.5 m 동쪽 미세이동")
        if LAYOUT_KEY in tr_b:
            lay = tr_b[LAYOUT_KEY]
            tr_b2 = {LAYOUT_KEY: {**lay, "buildings": [{**bb, "footprint": [[x + 0.5, y] for x, y in bb["footprint"]]} if bb["id"] in changed else bb
                                                       for bb in lay["buildings"]]}}
        else:
            tr_b2 = {k: dict(v) for k, v in tr_b.items()}
            for bid in changed:
                tr_b2.setdefault(bid, {"dx": 0.0, "dy": 0.0, "rot_deg": 0.0, "floors_delta": 0})
                tr_b2[bid]["dx"] = float(tr_b2[bid].get("dx", 0)) + 0.5
        sens.append({"case": "변경 주동 +0.5 m 동쪽 미세이동", **_metrics_case(site, tr_a, tr_b2, ground, gmesh, sun, params, site["open_spaces"], rect, changed)})
        summary["sensitivity"] = {"cases": sens, "note": "가상 지반고 변화 시험은 실제 DEM 오차 통계가 아님. 각 사례는 동일 알고리즘으로 A/B 전체를 재계산."}
        write_csv(out / "sensitivity.csv", sens)

    quality = {
        "run_id": run_id, "checks": qa_checks,
        "n_pass": sum(c["status"] == "PASS" for c in qa_checks), "n_fail": sum(c["status"] == "FAIL" for c in qa_checks),
        "critical_fail": [c["name"] for c in qa_checks if c["status"] == "FAIL" and c["critical"]],
        "data_classes": {"terrain": terrain["data_class"], "buildings": sorted({b.data_class for b in A}), "location": "REAL_OFFICIAL (대표점만)",
                         "site_boundary": "SYNTHETIC", "open_spaces": "SYNTHETIC", "ground_pad": "DERIVED (가상 지반 가정)"},
        "verification_status": "VERIFIED_AUTOMATED_QA" if not [c for c in qa_checks if c["status"] == "FAIL" and c["critical"]] else "QA_FAILED",
    }
    write_json(out / "quality_check.json", quality)
    provenance = {
        "engine": ENGINE_NAME, "engine_version": ENGINE_VERSION, "algorithm_version": ALGORITHM_VERSION,
        "code_commit": code_commit_hash(), "dependencies": dependency_versions(),
        "raycast_engine": sA.engine.name, "input_hashes": {"terrain_sha256": terrain["sha256"],
                                                          "geometry_hash_a": summary["scenarios"]["A"]["geometry_hash"],
                                                          "geometry_hash_b": summary["scenarios"]["B"]["geometry_hash"],
                                                          "scenario_hash_a": snap["scenarios"]["A"]["content_hash"],
                                                          "scenario_hash_b": snap["scenarios"]["B"]["content_hash"]},
        "cache_key": snap.get("cache_key"),
    }
    summary["provenance"] = provenance
    summary["quality_overview"] = {k: quality[k] for k in ("n_pass", "n_fail", "critical_fail", "verification_status")}
    write_json(out / "analysis_summary.json", summary)
    with SessionLocal() as s:
        r = s.get(AnalysisRun, run_id)
        r.summary = {k: v for k, v in summary.items() if k not in ("sun",)} | {"sun": {k: v for k, v in summary["sun"].items()}}
        r.quality = quality
        r.provenance = provenance
        r.result_dir = str(out)
        s.commit()


def integrate(summary: dict) -> dict:
    """Per main building: list each metric separately (no weighted score)."""
    rows = {}
    if "A" in summary:
        for b in summary["A"]["per_building"]:
            rows.setdefault(b["building_id"], {})["A_mean_delta_min"] = b["mean_delta_min"]
            rows[b["building_id"]]["A_n_decreased"] = b["n_decreased"]
            rows[b["building_id"]]["A_min_delta_min"] = b["min_delta_min"]
    if "C" in summary:
        for p in summary["C"]["pairs"]:
            for bid in (p["a"], p["b"]):
                r = rows.setdefault(bid, {})
                if p["delta_m"] < 0:
                    r["C_min_pair_delta_m"] = min(r.get("C_min_pair_delta_m", 0.0), p["delta_m"])
                r["C_min_distance_b_m"] = min(r.get("C_min_distance_b_m", 1e9), p["distance_b_m"])
    if "B" in summary:
        for t in summary["B"]["top_cells"]:
            if t.get("main_cause_b"):
                r = rows.setdefault(t["main_cause_b"], {})
                r["B_top_cells_caused"] = r.get("B_top_cells_caused", 0) + 1
    out = []
    for bid, r in sorted(rows.items()):
        flags = []
        if r.get("A_n_decreased", 0) > 0:
            flags.append("일조 감소")
        if r.get("B_top_cells_caused", 0) > 0:
            flags.append("신규 음영 상위셀 원인")
        if r.get("C_min_pair_delta_m", 0) < 0:
            flags.append("이격 감소")
        out.append({"building_id": bid, **r, "flags": flags, "n_flags": len(flags)})
    return {"rows": out, "note": "서로 다른 단위의 지표를 가중합하지 않음. 동시 발생 여부만 표시."}


def make_cache_key(snapshot: dict, params: dict, atype: str) -> str:
    snap = {k: v for k, v in snapshot.items() if k not in ("cache_key",)}
    snap["scenarios"] = {c: {"transforms": v["transforms"], "content_hash": v["content_hash"]} for c, v in snapshot["scenarios"].items()}
    return stable_hash({"snapshot": snap, "params": params, "type": atype, "algo": ALGORITHM_VERSION})
