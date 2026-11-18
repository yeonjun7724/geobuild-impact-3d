"""Import a large local DEM GeoTIFF (e.g. national 30 m SRTM mosaic) for a project by clipping around the AOI.

Uploading multi-GB rasters through the browser is impractical, so the source file is read in place with a windowed
read (no resampling, original CRS/grid kept), the clip is registered as USER_UPLOADED terrain and activated.
The source file path, size, modification time and SHA-256 are kept as provenance.

Usage:
  uv run python -m scripts.import_dem --path "C:/.../srtm_dem_30.tif"                 # new DEMO-layout project
  uv run python -m scripts.import_dem --path ... --project <id> --vertical-datum EGM96 # declared value -> still UNRESOLVED
"""
from __future__ import annotations

import argparse
import hashlib
from datetime import datetime, timezone
from pathlib import Path

from app import services
from app.db import Project, SessionLocal, init_db
from app.geo.terrain import USER_UPLOADED, clip_dem_to_aoi


def sha256_stream(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", required=True)
    ap.add_argument("--project")
    ap.add_argument("--name", default="인천계양 A2 인근 가상단지 설계변경 검토 (SRTM 30m DEM)")
    ap.add_argument("--half-extent", type=float, default=6000.0, help="clip half size around the site origin (m)")
    ap.add_argument("--vertical-datum", default=None, help="declared vertical datum (recorded as unverified)")
    ap.add_argument("--acquired", default=None)
    ap.add_argument("--license", default=None)
    ap.add_argument("--source-label", default="SRTM 기반 30 m급 DEM (EPSG:5179 모자이크, 사용자 제공 파일)")
    a = ap.parse_args()
    src = Path(a.path)
    if not src.exists():
        raise SystemExit(f"파일 없음: {src}")
    init_db()
    st = src.stat()
    print(f"[import] source {src} ({st.st_size / 1e9:.2f} GB) - hashing…")
    src_sha = sha256_stream(src)
    with SessionLocal() as s:
        if a.project:
            p = s.get(Project, a.project)
            if p is None:
                raise SystemExit("프로젝트 없음")
        else:
            p = services.create_project(s, a.name)
            services.demo_seed(s, p)  # virtual complex + synthetic DEM (kept as inactive fallback)
            s.flush()
        fr = services.frame_of(p)
        note = {"path": src.name, "size_bytes": st.st_size, "sha256": src_sha,
                "mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(timespec="seconds")}
        dst = services.project_dir(p.id) / "terrain" / f"{src.stem}_clip_{int(a.half_extent)}m.tif"
        clip_dem_to_aoi(src, dst, fr, a.half_extent, note)
        meta = {"source_path": src.name, "source_size_bytes": st.st_size, "source_sha256": src_sha, "source_mtime": note["mtime"],
                "source_label": a.source_label, "clip_half_extent_m": a.half_extent,
                "vertical_datum_note": "SRTM 원자료의 표준 수직기준은 EGM96 지오이드이나 이 파일(EPSG:5179 재투영본)에는 수직기준 메타데이터가 없어 확정하지 않음"}
        ds, ts = services.register_terrain(
            s, p, dst, USER_UPLOADED, src.name, declared_vertical_datum=a.vertical_datum,
            acquired=a.acquired or f"미확보 (파일 수정일 {note['mtime'][:10]})", license_=a.license or "미확보 (SRTM: USGS 공개자료로 추정, 확인 필요)",
            source_meta=meta, provenance_source=f"{a.source_label}: {src.name} 에서 대상지 ±{a.half_extent:.0f} m 창 추출 (재표본화 없음)")
        s.commit()
        print(f"project_id={p.id}")
        print(f"dataset={ds.id} status={ds.status} activated={ts is not None}")
        print(f"region={ds.meta.get('region_half_m')} m mesh={ds.meta.get('mesh_spacing_m')} m clip={dst} ({dst.stat().st_size / 1e6:.2f} MB)")
        for w in ds.qa.get("warnings", []):
            print("  warn:", w)
        for e in ds.qa.get("errors", []):
            print("  ERROR:", e)


if __name__ == "__main__":
    main()
