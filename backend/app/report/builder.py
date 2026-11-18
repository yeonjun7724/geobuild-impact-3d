"""Report job: analysis results -> figures -> HTML (Jinja2) -> PDF (Chromium) -> verification -> evidence ZIP.

All report text is generated deterministically from analysis_summary.json / quality_check.json. No LLM or network
is needed; identical inputs produce identical numbers.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import json
import re
import shutil
import time
import traceback
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
from jinja2 import Environment, FileSystemLoader, select_autoescape

from .. import config
from ..db import AnalysisRun, Project, ProvenanceRecord, Report, SessionLocal, utcnow
from ..scene import demo
from ..services import frame_of
from . import figures as F
from .pdf import render_pdf, try_capture_3d, verify_pdf

TEMPLATES = Path(__file__).parent / "templates"
REPORT_TITLE = "GeoBuild Impact 3D 설계변경 영향 기술보고서"

SECTIONS = [
    ("s01", "1. 문서관리"),
    ("s02", "2. 요약 (Executive Summary)"),
    ("s03", "3. 분석 배경과 목적"),
    ("s04", "4. 대상 지역 및 대상 주동"),
    ("s05", "5. 데이터 인벤토리 및 품질"),
    ("s06", "6. 설계 시나리오 정의"),
    ("s07", "7. 공통 분석 방법론"),
    ("s08", "8. A. 직사일조 상세 결과"),
    ("s09", "9. B. 그림자 변화 상세 결과"),
    ("s10", "10. C. 이격거리 상세 결과"),
    ("s11", "11. 세 분석 통합 비교"),
    ("s12", "12. 검토 우선순위 및 권고"),
    ("s13", "13. 민감도·불확실성"),
    ("s14", "14. 검증 및 품질보증(QA)"),
    ("s15", "15. 제약과 면책"),
    ("s16", "16. 출처 및 부록"),
]

# thresholds used ONLY to rank review priority inside this PoC (not legal criteria)
from ..analysis.sunlight import SIGNIFICANT_LOSS_MIN as TH_SUN_LOSS_MIN  # single source of truth
TH_OPEN_SPACE_SHADE_MIN = 10.0
TH_CLEARANCE_LOSS_M = 5.0


def _set(rid: str, **kw) -> None:
    with SessionLocal() as s:
        r = s.get(Report, rid)
        for k, v in kw.items():
            setattr(r, k, v)
        s.commit()


def build_report(report_id: str) -> None:
    try:
        _set(report_id, status="RUNNING", stage="입력 로드")
        _build(report_id)
    except Exception as exc:  # noqa: BLE001
        _set(report_id, status="FAILED", error=f"{type(exc).__name__}: {exc}\n{traceback.format_exc()[-1500:]}", finished_at=utcnow())


def _fmt(v, nd=1, unit=""):
    if v is None:
        return "미확보"
    if isinstance(v, (int, np.integer)):
        return f"{v:,}{unit}"
    if isinstance(v, float):
        return f"{v:,.{nd}f}{unit}"
    return f"{v}{unit}"


def _inline_svg(path: Path) -> str:
    svg = path.read_text(encoding="utf-8")
    svg = re.sub(r"<\?xml[^>]*\?>", "", svg)
    svg = re.sub(r"<!DOCTYPE[^>]*>", "", svg, flags=re.S)
    svg = re.sub(r"<svg ", '<svg preserveAspectRatio="xMidYMid meet" ', svg, count=1)
    # make width responsive inside the page
    svg = re.sub(r'(<svg[^>]*?) width="([\d.]+)pt" height="([\d.]+)pt"', r'\1 style="max-width:100%;height:auto" width="\2pt" height="\3pt"', svg, count=1)
    return svg


def _read_csv(p: Path) -> list[dict]:
    if not p.exists():
        return []
    with open(p, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _sha(p: Path) -> str:
    h = hashlib.sha256()
    h.update(p.read_bytes())
    return h.hexdigest()


def _recommendations(sm: dict) -> list[dict]:
    recs = []
    if "A" in sm:
        a = sm["A"]
        for g in a.get("significant_loss", []):  # computed over ALL compared receivers
            if g["n_loss_ge_threshold"]:
                recs.append({"level": "설계자 재검토 권고", "target": f"{g['building_id']}동 {g['floors'][0]}~{g['floors'][1]}층 ({', '.join(g['facades'])}면)",
                             "basis": f"수광점 {g['n_loss_ge_threshold']}개가 {TH_SUN_LOSS_MIN:.0f}분 이상 감소 (최대 {g['min_delta_min']:.0f}분)",
                             "cause": ", ".join(f"{c}동 {n}점" for c, n in g["causes"].items()) or "-"})
        n_zero = sum(g["n_to_zero"] for g in a.get("significant_loss", []))
        if n_zero:
            recs.append({"level": "정밀 검토 필요", "target": ", ".join(f"{g['building_id']}동 {g['n_to_zero']}점" for g in a["significant_loss"] if g["n_to_zero"]),
                         "basis": f"B안에서 분석시간 내 직사일조가 0분이 된 수광점 총 {n_zero}개", "cause": "-"})
    if "B" in sm:
        for o in sm["B"]["open_spaces"]:
            if o.get("mean_delta_min", 0) >= TH_OPEN_SPACE_SHADE_MIN:
                recs.append({"level": "설계자 재검토 권고", "target": o["name"],
                             "basis": f"평균 누적 음영시간 {o['mean_delta_min']:+.1f}분, 최대 신규 음영면적 {o['peak_new_shade_area_m2']:.0f} m²",
                             "cause": "그림자 격자 분석"})
    if "C" in sm:
        for r in sm["C"]["worsened_top"]:
            if r["delta_m"] <= -TH_CLEARANCE_LOSS_M:
                recs.append({"level": "정밀 검토 필요", "target": r["pair_id"].replace("|", "↔"),
                             "basis": f"최단 이격 {r['distance_a_m']:.2f} → {r['distance_b_m']:.2f} m (Δ{r['delta_m']:+.2f} m)",
                             "cause": "법정 이격 적합성은 별도 법령·조례 검토 필요"})
        if sm["C"]["n_contact_or_overlap_b"]:
            recs.append({"level": "정밀 검토 필요", "target": "접촉/중첩 건물 쌍", "basis": f"{sm['C']['n_contact_or_overlap_b']}쌍 접촉·중첩", "cause": "형상 충돌"})
    recs.append({"level": "자료 추가 확보 필요", "target": "지형·계획지반",
                 "basis": "현재 지형은 " + ("합성 30 m DEM" if sm["terrain"]["data_class"] == "SYNTHETIC" else "업로드 30 m DEM") +
                 ", 계획지반은 가상 평탄 pad 가정", "cause": "실측/설계 계획지반고, 수직기준 확인된 DEM 필요"})
    recs.append({"level": "자료 추가 확보 필요", "target": "창호·세대 위치", "basis": "수광점은 외벽 대리지점(facade_proxy)",
                 "cause": "실제 창호 좌표·세대 배치 확보 시 세대별 일조로 전환 가능"})
    recs.append({"level": "자료 추가 확보 필요", "target": "주변 차폐물", "basis": "분석영역 외곽·실제 주변건물·수목 미반영",
                 "cause": "3D 건물/수목 자료 및 확장 지형"})
    return recs


def _exec_summary(sm: dict) -> list[str]:
    out = []
    if "A" in sm:
        a = sm["A"]
        w = a["worst_receivers"][0] if a["worst_receivers"] else None
        if w:
            out.append(f"[A 직사일조] 가장 큰 감소는 수광점 {w['receiver_id']} ({w['building_id']}동 {w['floor']}층 {w['facade']}면)으로 "
                       f"{w['sun_total_min_a']:.0f}분 → {w['sun_total_min_b']:.0f}분 (Δ{w['delta_total_min']:+.0f}분)이며, B안의 주 차폐 원인은 "
                       f"{(w['main_cause_b'] + '동') if w['main_cause_b'] else '확인 불가'}입니다.")
        else:
            out.append("[A 직사일조] 직사일조가 감소한 수광점이 없습니다.")
        out.append(f"[A 직사일조] 비교 가능한 수광점 {a['n_common']:,}개 중 감소 {a['n_decreased']:,}개, 증가 {a['n_increased']:,}개, 변화 없음 "
                   f"{a['n_unchanged']:,}개. 평균 총 직사일조는 {a['mean_total_min_a']:.1f}분 → {a['mean_total_min_b']:.1f}분입니다. "
                   f"감소 수광점 중 변경되지 않은 다른 주동의 수광점은 {a['n_decreased_other_buildings']:,}개입니다.")
        if a["n_only_b"] or a["n_only_a"]:
            out.append(f"[A 직사일조] 층수 변경으로 한 안에만 존재하는 수광점(B 전용 {a['n_only_b']}개, A 전용 {a['n_only_a']}개)은 비교에서 제외했습니다.")
    if "B" in sm:
        b = sm["B"]
        out.append(f"[B 그림자] 유효격자 {b['valid_area_m2']:,.0f} m²에서 최대 신규 음영면적은 {b['max_new_shade_time']} KST의 "
                   f"{b['max_new_shade_area_m2']:,.0f} m², 누적 음영시간이 늘어난 면적은 {b['area_more_shade_m2']:,.0f} m², 줄어든 면적은 "
                   f"{b['area_less_shade_m2']:,.0f} m²입니다.")
        for o in b["open_spaces"]:
            if o.get("n_cells"):
                out.append(f"[B 그림자] {o['name']}: 평균 누적 음영 {o['mean_shade_min_a']:.1f}분 → {o['mean_shade_min_b']:.1f}분 "
                           f"(Δ{o['mean_delta_min']:+.1f}분), 최대 신규 음영면적 {o['peak_new_shade_area_m2']:.0f} m².")
    if "C" in sm and not sm["C"].get("min_pair_a"):
        out.append("[C 이격] 비교할 주동 쌍이 없음 (주동 1개 이하).")
    if "C" in sm and sm["C"].get("min_pair_a"):
        c = sm["C"]
        out.append(f"[C 이격] 주동 쌍 최소 최단 이격은 A {c['min_pair_a']['distance_m']:.2f} m ({c['min_pair_a']['pair_id'].replace('|', '↔')}) → "
                   f"B {c['min_pair_b']['distance_m']:.2f} m ({c['min_pair_b']['pair_id'].replace('|', '↔')}). 이격이 감소한 쌍 {c['n_worsened']}개, "
                   f"증가 {c['n_improved']}개, 접촉/중첩 {c['n_contact_or_overlap_b']}쌍입니다.")
        if c["worsened_top"]:
            w = c["worsened_top"][0]
            out.append(f"[C 이격] 가장 크게 감소한 쌍은 {w['pair_id'].replace('|', '↔')} ({w['distance_a_m']:.2f} → {w['distance_b_m']:.2f} m, Δ{w['delta_m']:+.2f} m)입니다.")
    q = sm["quality_overview"]
    out.append(f"[QA] 자동 검증 {q['n_pass']}건 통과, {q['n_fail']}건 실패" + (f" (치명 실패: {', '.join(q['critical_fail'])})" if q["critical_fail"] else "") + ".")
    return out


def _build(report_id: str) -> None:
    t0 = time.time()
    with SessionLocal() as s:
        rp = s.get(Report, report_id)
        run = s.get(AnalysisRun, rp.run_id)
        if run is None or run.status != "SUCCEEDED":
            raise RuntimeError("성공한 분석 실행이 아님 - 보고서 생성 거부")
        proj = s.get(Project, run.project_id)
        prov = [{"subject": p.subject, "data_class": p.data_class, "source": p.source, "url": p.url, "accessed": p.accessed,
                 "license": p.license, "note": p.note} for p in s.query(ProvenanceRecord).filter_by(project_id=proj.id).all()]
        run_id, rdir, version = run.id, Path(run.result_dir), rp.version
        n_prev = s.query(Report).filter(Report.run_id == run_id, Report.status == "SUCCEEDED").count()
        proj_name, created = proj.name, rp.created_at
        frame = frame_of(proj)
        run_logs = run.logs
        processing = run.processing_seconds
    version = f"1.{n_prev}"
    sm = json.loads((rdir / "analysis_summary.json").read_text(encoding="utf-8"))
    qa = json.loads((rdir / "quality_check.json").read_text(encoding="utf-8"))
    out = config.DATA_DIR / "reports" / report_id
    figd = out / "figures"
    if out.exists():
        shutil.rmtree(out)
    figd.mkdir(parents=True)
    _set(report_id, stage="정적 분석지도·차트 생성")
    font = F.setup_fonts()
    fn = f"Local ENU (원점 {frame.lat0:.7f}N, {frame.lon0:.7f}E, LH 공고 대표점) · 단위 m · 교환용 EPSG:5179"
    snap = run_snapshot_site(run_id)
    sm["_open_spaces"] = snap["open_spaces"]
    cc = demo.SITE_META["location_source"]["cross_check"]
    sm["_cross_check_enu"] = frame.geodetic_to_enu([cc["lon"]], [cc["lat"]], [0.0])[0][:2].tolist()
    figs: dict[str, str] = {}
    figs["location"] = F.fig_location(figd / "f04_location.svg", sm, fn)
    figs["layout"] = F.fig_layout_ab(figd / "f06_layout_ab.svg", sm, fn)
    # terrain figure from re-sampled ground (same function as analysis)
    from ..geo.terrain import DemSampler, build_ground
    g = build_ground(DemSampler(Path(sm["terrain"]["path"]), frame), tuple(snap["site_rect"]),
                     region_half_m=float(sm["terrain"].get("region_half_m", 1200.0)),
                     mesh_spacing_m=float(sm["terrain"].get("mesh_spacing_m", 10.0)))
    figs["terrain"] = F.fig_terrain(figd / "f05_terrain.svg", g.z, g.xs, g.ys, g.pad_rect, fn,
                                    "지형·가상 계획지반 (" + ("합성 30 m DEM, 실제 지형 아님" if sm["terrain"]["data_class"] == "SYNTHETIC" else "업로드 DEM") + ")")
    figs["sunpath"] = F.fig_sunpath(figd / "f07_sunpath.svg", sm["sun"])
    a_rows = []
    if "A" in sm:
        a_rows = _read_csv(rdir / "sunlight_receivers.csv")
        for r in a_rows:
            for k in ("x_a", "y_a", "z_a", "x_b", "y_b", "z_b", "sun_total_min_a", "sun_total_min_b", "delta_total_min", "max_cont_min_a", "max_cont_min_b", "delta_max_cont_min"):
                r[k] = float(r[k])
            r["floor"] = int(r["floor"])
        figs["sun_map"] = F.fig_sun_receivers_map(figd / "f08_sun_map.svg", sm, a_rows, fn)
        figs["sun_bars"] = F.fig_building_bars(figd / "f08_sun_bars.svg", sm["A"]["per_building"])
        figs["sun_hist"] = F.fig_delta_hist(figd / "f08_sun_hist.svg", a_rows)
        ts = dict(np.load(rdir / "sunlight_timeseries.npz"))
        times = [t[11:16] for t in sm["sun"]["times_local"]]
        figs["sun_time"] = F.fig_time_heatmap(figd / "f08_sun_timeheat.svg", ts, [r["receiver_id"] for r in sm["A"]["worst_receivers"][:15]], times)
        # facade matrices for the two most affected (building, facade)
        agg: dict[tuple, float] = {}
        for r in a_rows:
            agg[(r["building_id"], r["facade"])] = agg.get((r["building_id"], r["facade"]), 0.0) + r["delta_total_min"]
        worst_bf = sorted(agg.items(), key=lambda kv: kv[1])[:2]
        figs["facades"] = []
        for k, ((bid, fac), _) in enumerate(worst_bf):
            nm = F.fig_facade_matrix(figd / f"f08_facade_{k}.svg", a_rows, bid, fac)
            if nm:
                figs["facades"].append({"file": nm, "building": bid, "facade": fac})
    if "B" in sm:
        grid = dict(np.load(rdir / "shadow_grid.npz"))
        figs["shadow_states"] = F.fig_shadow_states(figd / "f09_shadow_states.svg", sm, grid, fn)
        figs["shadow_delta"] = F.fig_shadow_delta(figd / "f09_shadow_delta.svg", sm, grid, fn)
        figs["shadow_cum"] = F.fig_shadow_cumulative(figd / "f09_shadow_cum.svg", sm, grid, fn)
        figs["shadow_curve"] = F.fig_shadow_curve(figd / "f09_shadow_curve.svg", sm["B"]["curve"])
    if "C" in sm:
        figs["clear_map"] = F.fig_clearance_map(figd / "f10_clearance_map.svg", sm, fn)
        figs["clear_bars"] = F.fig_clearance_bars(figd / "f10_clearance_bars.svg", sm["C"]["pairs"])
    if "integrated" in sm and sm["integrated"]["rows"]:
        figs["integrated"] = F.fig_integrated(figd / "f11_integrated.svg", sm, fn)
    if sm.get("sensitivity"):
        figs["sens"] = F.fig_sensitivity(figd / "f13_sensitivity.svg", sm["sensitivity"]["cases"])

    _set(report_id, stage="3D 장면 캡처 시도 (실패 시 정적지도로 대체)")
    cap = try_capture_3d(f"{config.FRONTEND_URL}/capture/{run_id}", figd / "f00_cesium_capture.png")
    cap_b64 = base64.b64encode(Path(cap["path"]).read_bytes()).decode() if cap["ok"] else None

    inline = {}
    for k, v in figs.items():
        if isinstance(v, list):
            inline[k] = [{**x, "svg": _inline_svg(figd / x["file"])} for x in v]
        elif v:
            inline[k] = _inline_svg(figd / v)

    per_floor = _read_csv(rdir / "sunlight_per_floor.csv") if "A" in sm else []
    focus = {b["building_id"] for b in sm.get("A", {}).get("per_building", []) if b["n_decreased"] > 0 or b["changed_in_b"]}
    per_floor = [r for r in per_floor if r["building_id"] in focus]
    gen_local = datetime.now(ZoneInfo("Asia/Seoul"))
    meta = {
        "title": REPORT_TITLE, "report_id": report_id, "run_id": run_id, "version": version,
        "generated_at": gen_local.strftime("%Y-%m-%d %H:%M:%S KST"), "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "engine": config.ENGINE_NAME, "engine_version": config.ENGINE_VERSION, "algorithm_version": config.ALGORITHM_VERSION,
        "commit": sm["provenance"].get("code_commit") or "미확보 (git 저장소 아님 또는 커밋 없음)",
        "project_name": proj_name, "publisher": "JIRISO DATA STUDIO", "font": font, "processing_s": processing,
        "report_created": created.isoformat() if created else None,
    }
    ctx = {
        "meta": meta, "sm": sm, "qa": qa, "figs": inline, "sections": SECTIONS, "toc_pages": {}, "prov": prov,
        "exec": _exec_summary(sm), "recs": _recommendations(sm), "per_floor": per_floor, "site": demo.SITE_META, "disclaimer": demo.DISCLAIMER,
        "lh_url": demo.LH_URL, "kasi_url": demo.KASI_URL, "capture": cap, "capture_b64": cap_b64, "fmt": _fmt,
        "th": {"sun": TH_SUN_LOSS_MIN, "os": TH_OPEN_SPACE_SHADE_MIN, "cl": TH_CLEARANCE_LOSS_M},
        "pdf_check_prev": None, "run_logs": run_logs, "files_expected": EXPORT_FILES,
    }
    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html", "j2"]))
    env.filters["n"] = lambda v, nd=1: _fmt(v, nd)
    tmpl = env.get_template("report.html.j2")
    html_path = out / f"GeoBuild_Impact_3D_Report_{run_id}.html"
    pdf_path = out / f"GeoBuild_Impact_3D_Report_{run_id}.pdf"

    _set(report_id, stage="HTML/PDF 렌더링 (목차 쪽번호가 안정될 때까지 반복)")
    markers = [t for _, t in SECTIONS]
    passes = 0
    v2: dict = {}
    for passes in range(1, 5):
        html_path.write_text(tmpl.render(**ctx), encoding="utf-8")
        chrom = render_pdf(html_path, pdf_path, report_id, run_id, version)
        v2 = verify_pdf(pdf_path, REPORT_TITLE, markers)
        new_toc = _toc_pages(v2.get("page_texts", []), markers)
        prev = ctx["pdf_check_prev"]
        if new_toc == ctx["toc_pages"] and prev is not None and prev.get("pages") == v2.get("pages"):
            break
        ctx["toc_pages"] = new_toc
        ctx["pdf_check_prev"] = {k: v for k, v in v2.items() if k != "page_texts"}
    toc = ctx["toc_pages"]
    toc2 = _toc_pages(v2.get("page_texts", []), markers)
    # number cross-check: key figures from summary must appear in the PDF text
    full = "".join(v2.get("page_texts", [])).replace("\n", "").replace(" ", "")
    nums = _key_numbers(sm)
    num_check = {k: (v.replace(" ", "") in full) for k, v in nums.items()}
    pdf_quality = {k: v for k, v in v2.items() if k != "page_texts"}
    pdf_quality.update({"toc_consistent_after_rerender": toc == toc2, "render_passes": passes, "toc_pages": toc2, "key_numbers_found": num_check,
                        "all_key_numbers_found": all(num_check.values()), "chromium": chrom["chromium"], "cesium_capture": cap})
    pdf_quality["ok"] = bool(pdf_quality["ok"] and pdf_quality["all_key_numbers_found"])

    _set(report_id, stage="증거 패키지(ZIP) 생성")
    manifest = {
        "report_id": report_id, "run_id": run_id, "version": version, "generated_at": meta["generated_at_utc"], "title": REPORT_TITLE,
        "disclaimer": demo.DISCLAIMER, "engine": {k: meta[k] for k in ("engine", "engine_version", "algorithm_version", "commit")},
        "dependencies": sm["provenance"]["dependencies"], "input_hashes": sm["provenance"]["input_hashes"], "cache_key": sm["provenance"]["cache_key"],
        "pdf": {"pages": pdf_quality.get("pages"), "size_bytes": pdf_quality.get("size_bytes")},
        "reproduce": REPRODUCE, "files": [],
    }
    zip_path = out / f"GeoBuild_Impact_3D_Evidence_{run_id}.zip"
    qc = {"analysis_qa": qa, "report_pdf_qa": pdf_quality, "previous_pass_pdf_qa": ctx["pdf_check_prev"]}
    (out / "quality_check.json").write_text(json.dumps(qc, ensure_ascii=False, indent=1), encoding="utf-8")
    entries: list[tuple[Path, str]] = [(pdf_path, pdf_path.name), (html_path, html_path.name), (rdir / "analysis_summary.json", "analysis_summary.json"),
                                       (out / "quality_check.json", "quality_check.json")]
    for f in EXPORT_FILES:
        p = rdir / f
        if p.exists() and p.stat().st_size > 0:
            entries.append((p, f"data/{f}"))
    for p in sorted(figd.iterdir()):
        entries.append((p, f"figures/{p.name}"))
    for p, arc in entries:
        manifest["files"].append({"path": arc, "size_bytes": p.stat().st_size, "sha256": _sha(p)})
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p, arc in entries:
            z.write(p, arc)
        z.write(out / "manifest.json", "manifest.json")
    files = {
        "pdf": {"path": str(pdf_path), "name": pdf_path.name, "size_bytes": pdf_path.stat().st_size, "pages": pdf_quality.get("pages")},
        "html": {"path": str(html_path), "name": html_path.name, "size_bytes": html_path.stat().st_size},
        "zip": {"path": str(zip_path), "name": zip_path.name, "size_bytes": zip_path.stat().st_size},
        "manifest": {"path": str(out / "manifest.json")},
        "figures": sorted(p.name for p in figd.iterdir()),
        "elapsed_s": round(time.time() - t0, 1),
    }
    _set(report_id, status="SUCCEEDED", stage="완료" if pdf_quality["ok"] else "완료 (PDF 검증 경고)",
         files=files, quality=pdf_quality, version=version, finished_at=utcnow())


def run_snapshot_site(run_id: str) -> dict:
    with SessionLocal() as s:
        return dict(s.get(AnalysisRun, run_id).snapshot["site"])


def _toc_pages(page_texts: list[str], markers: list[str]) -> dict:
    out = {}
    start = 2  # skip cover + TOC pages (TOC lists every heading)
    norm = [[ln.strip().replace(" ", "") for ln in t.splitlines()] for t in page_texts]
    for m in markers:
        mm = m.replace(" ", "")
        for i in range(start, len(norm)):
            if mm in norm[i]:
                out[m] = i + 1
                break
    return out


def _key_numbers(sm: dict) -> dict:
    nums = {}
    if "A" in sm:
        a = sm["A"]
        nums["A.n_decreased"] = f"{a['n_decreased']:,}"
        nums["A.mean_b"] = f"{a['mean_total_min_b']:.1f}"
        if a["worst_receivers"]:
            nums["A.worst_id"] = a["worst_receivers"][0]["receiver_id"]
    if "B" in sm:
        nums["B.max_new"] = f"{sm['B']['max_new_shade_area_m2']:,.0f}"
        nums["B.valid_area"] = f"{sm['B']['valid_area_m2']:,.0f}"
    if "C" in sm and sm["C"].get("min_pair_b"):
        nums["C.min_b"] = f"{sm['C']['min_pair_b']['distance_m']:.2f}"
    return nums


EXPORT_FILES = ["sunlight_receivers.csv", "sunlight_per_floor.csv", "sunlight_per_building.csv", "shadow_grid_cells.csv",
                "shadow_grid_changed.geojson", "shadow_area_curve.csv", "clearance_pairs.csv", "clearance_facade_normals.csv",
                "clearance_boundary.csv", "buildings_A.geojson", "buildings_B.geojson", "sensitivity.csv", "scene_snapshot.json"]

REPRODUCE = [
    "cd backend && uv sync",
    "uv run python -m scripts.seed_demo   # 프로젝트 생성 + 합성 DEM + 가상 단지",
    "uv run uvicorn app.main:app --port 8000  &  uv run python -m app.worker",
    "POST /api/projects/{id}/analyses {analysis_type:'ALL', date:'2026-12-22', start:'08:00', end:'16:00', interval_min:5, grid_spacing_m:2}",
    "POST /api/analyses/{run_id}/reports  →  GET /api/reports/{report_id}/download?format=pdf|html|zip",
    "동일 입력은 동일 cache_key·동일 수치를 산출 (analysis_summary.json 대조)",
]
