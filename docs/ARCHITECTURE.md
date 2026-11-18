# GeoBuild Impact 3D — 구조와 계산 규칙

## 구성도

```
 Browser (React 19 + TS + Vite 8 + CesiumJS 1.147 + Tailwind 4 + Recharts 3)
   │  /projects · /projects/:id · /projects/:id/analysis · /projects/:id/compare/:runId · /projects/:id/data · /reports/:runId
   │  /api/* (Vite proxy / nginx)
   ▼
 FastAPI (app/main.py) ── SQLAlchemy ── SQLite (기본) | PostgreSQL/PostGIS (docker)
   │  enqueue (app/jobs.py)
   ▼
 Redis (Railway, TCP proxy) ── RQ worker (app/worker.py)        ※ 장애 시 API 내 스레드 대체, 사용 백엔드 기록
   │  app.runner.execute(run_id)          → data/runs/<run>/        (결과 JSON/CSV/GeoJSON/NPZ)
   │  app.report.builder.build_report(id) → data/reports/<report>/  (HTML/PDF/ZIP/figures/manifest)
   ▼
 계산 엔진: pyproj · rasterio · Shapely · NumPy · pvlib(nrel_numpy) · Open3D RaycastingScene · matplotlib(SVG) · Playwright Chromium(PDF)
```

## 백엔드 모듈

| 모듈 | 역할 |
|---|---|
| `geo/enu.py` | LH 대표점 원점 local ENU ↔ ECEF ↔ WGS84, EPSG:5179 교환, Cesium 모델행렬 |
| `geo/terrain.py` | 합성 30 m DEM 생성, DEM 검사(CRS·NoData·셀·고도·경사·수직기준·DSM), 쌍선형 샘플러, 가상 계획지반 접합, 지면 메쉬, 지평 경고 |
| `scene/geometry.py` | footprint 검증(GeometryCollection·무효·단위오류), 강체 변환, ear-clipping 압출, 외벽 수광점(ID는 기준안 변 순서로 고정) |
| `scene/builder.py` | 시나리오(기준 형상 + 변환) → 해석 장면(메쉬·수광점), 스냅샷/해시 |
| `analysis/solar.py` | 시간창·구간 중점 규칙, pvlib 태양위치, ENU 태양벡터 |
| `analysis/raycast.py` | Open3D 엔진 + 독립 float64 Möller–Trumbore 엔진(교차검증), 자가교차 offset |
| `analysis/sunlight.py` | A 계산·비교(동일 ID, A/B 전용 수광점 분리, 원인 건물, 층·동 집계) |
| `analysis/shadow.py` | B 격자(지면 메쉬 수직 레이로 지반고), 공통 분모 마스킹, 4상태, 면적곡선, 공간별 영향 |
| `analysis/clearance.py` | C 쌍별 최단거리·최근접점, 접촉/중첩, 법선 거리, 대지경계 |
| `analysis/qa.py` | 실행 내 QA: 기둥 해석해, round-trip, 엔진 교차검증, 자가교차 |
| `runner.py` | 작업 오케스트레이션, 민감도, DB 저장(RaySample·ShadowGridCell·ClearancePair 등), 파일 출력 |
| `report/*` | 정적 지도·차트(SVG+PNG), Jinja2 템플릿, Chromium PDF, PDF 검증, ZIP/manifest |

## 데이터 모델

`project, dataset, terrain_source, site_pad, building, floor, window_receiver, open_space(OpenSpacePolygon), scenario,
scenario_building_transform, analysis_run, ray_sample, shadow_grid_cell, clearance_pair, report, provenance_record`.
기하는 ENU 좌표 배열(JSON)로 저장해 SQLite/PostgreSQL 모두에서 동작합니다. `clearance_pair`는 연결선 WKT를 함께 저장합니다.
현재 공간 연산은 Shapely(ENU 미터 평면)로 수행하며 PostGIS `ST_Distance`는 사용하지 않습니다.

`analysis_run.snapshot`에 기준안·변경안 변환, 시나리오 해시·revision, 지형 파일 경로·SHA-256·분류·수직기준, 대상지, 프레임을 고정 저장합니다.
작업 시작 시 지형 파일 해시를 다시 확인하고, 결과에 형상 해시, 의존성 버전, 코드 commit, 처리시간, QA 결과를 기록합니다.

## 좌표·높이

* 수평: 경위도 도 단위 계산 없음. ENU(접평면) 미터. EPSG:5179와의 거리 차이는 TM 축척계수 수준(<0.1%, 테스트).
* 수직: `absolute elevation(z)`, `terrain_height`, `building_base_elevation(base_z)`, `building_relative_height(height_m)`, `vertical_datum`을 분리.
  지오이드/타원체 상수 환산을 하지 않으며, 수직기준을 확인할 수 없는 업로드 DEM은 `UNRESOLVED`로 표시하고 상대고도 통일기준으로만 분석합니다.
* 화면: Cesium에는 계산과 같은 메쉬를 `z − pad_z + 0.5 m`로 일괄 이동해 표시(상대 기하 동일). 모델행렬은 백엔드가 계산한 ENU→ECEF 행렬.

## 시간

`Asia/Seoul` 벽시계 → timezone-aware → UTC. pvlib와 Cesium Clock(`JulianDate.fromIso8601`)이 같은 UTC 순간을 사용합니다.
A/B 집계는 구간 중점 규칙(Δt분 구간의 중점 태양위치)이며 대표 시각 지도(09/12/15시)는 정시 순간으로 계산합니다.

## 재현성

cache key = sha256(스냅샷[프레임·대상지·건물·지형 해시·시나리오 변환/해시] + 파라미터 + 분석유형 + 알고리즘 버전).
같은 키의 성공 결과는 재사용하고(`reused=true`), 보고서는 결과 파일만으로 결정론적으로 생성됩니다.
