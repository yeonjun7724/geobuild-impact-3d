# QA 결과 기록 (실제 실행 기준)

실행일 2026-11-18 · Windows 11 · Python 3.12.10(uv) · Node 24.19 · Chromium 159.0.8154.6 · 코드 commit `3d31383`.
실행하지 않은 시험은 "통과"로 적지 않았습니다.

## 1. 백엔드 단위·기하·API 테스트 — **45 passed** (초기 기록, 최신은 10장: 66 passed)

```
cd backend && uv run pytest -v --junitxml=../docs/qa/pytest-junit.xml
45 passed, 2 warnings in 92.65s
```
원본 출력: `docs/qa/pytest_output.txt`, `docs/qa/pytest-junit.xml`.

| 범주 | 테스트 | 결과 |
|---|---|---|
| A==B | A/B 동일 입력 → 일조 Δ·그림자 신규/해소 면적·이격 Δ·법선 Δ 모두 0 | PASS |
| 해석해 | 기둥 그림자 L=H/tan α, 고도 8/15/29/45°, 방위 150/180/200/230° (오차 ≤0.05 m) + 그림자 방향 | PASS |
| 해석해 | 박스 그림자 면적(볼록포 − footprint) vs 0.25 m 레이 격자 (오차 <1%) | PASS |
| 엔진 교차검증 | Open3D vs 독립 float64 Möller–Trumbore, 3,000 레이 (일치율 ≥99.9%) | PASS |
| 자가교차 | 관리 offset 0.048 m에서 외벽 자가충돌 0 | PASS |
| 태양 | 방위·고도→ENU 벡터, 동지 정오 남중·고도≈29°, KST 09:00 = UTC 00:00, 구간 중점, 잘못된 시간대/시간창 | PASS |
| 좌표 | ENU↔ECEF↔WGS84 round-trip (<1e-4 m), ENU vs EPSG:5179 거리 (<0.1%), Cesium 모델행렬 | PASS |
| 변형 | 이동 → 일조 회복·수광점 ID 유지, 높이 증가 → 감소·B 전용 수광점 분리, 회전 → 메쉬·결과 변화, 지평선 아래 0 | PASS |
| C 이격 | 30 m 사각형, 대각 5 m, 접촉 CONTACT 0 m, 중첩 OVERLAP 0 m(면적 25 m²), 법선 거리·교차 없음, 이동 Δ −10 m | PASS |
| 실패 경로 | GeometryCollection, 자기교차, 도 단위 좌표, CRS 없는 DEM, 전부 NoData, 부분 NoData 경고, DSM 파일명, 지리좌표 DEM, 범위 밖 NaN | PASS |
| 시간 민감도 | 5분 vs 1분 차이 기록 (같다고 가정하지 않음) | PASS |
| API E2E | 프로젝트·DEMO 시드·배지(SYNTHETIC), 지면 메쉬 공유, A 잠금·주변건물 편집 거부·범위 422, 미완료 run 보고서 거부(409), ALL 실행·드릴다운·CSV·캐시 재사용, 보고서 PDF/HTML/ZIP, 보고서 수치=analysis_summary.json, 3D 캡처 실패 시 정적지도 대체, 새 클라이언트 영속성, DEM 업로드 정상/깨진 파일(기존 지형 유지), GeoJSON 검증 | PASS |

## 2. 프론트엔드 빌드

```
cd frontend && npx tsc -b && npx vite build      → 성공 (JS 4.98 MB, Cesium 자산 /cesium 복사)
```

## 3. 브라우저 E2E (Playwright, 실제 API + Railway Redis RQ worker + Vite)

```
cd frontend && npx playwright test     → 1 passed (3.6m)
job backend line: 작업 백엔드: rq
E2E OK project=72ce9f7ec2eb run=0a80f90f9ca8 pdf_bytes=1205539 zip_bytes=2998455
```
과정: 프로젝트 생성 → Cesium WebGL 캔버스 렌더링(SwiftShader) → 합성 DEM·면책 표기 확인 → 101동 B 동쪽 8 m 이동 저장(A 잠금 유지 확인) → 분할 보기 → ALL 분석(RQ) SUCCEEDED → 비교 A/B/C·수광점 드릴다운 → 새로고침 영속성 → 보고서 생성 → PDF(`%PDF`, 1.2 MB)·ZIP 다운로드 200. 페이지 JS 오류 0건.
스크린샷: `docs/screenshots/01~08_*.png`, 결과 JSON: `docs/qa/playwright-results.json`.

첫 시도는 Cesium 정적 자산(`/cesium/...`)이 dev 서버에서 HTML로 응답되어 JSON 파싱 오류 2건으로 **실패**했고, 자산 서빙 플러그인을 교체한 후 통과했습니다. 두 번째 시도 중 API 프로세스가 외부 요인으로 종료(exit 127, 로그에 예외 없음)되어 중단했고, 재기동 후 통과했습니다.

## 4. 서버 재시작 영속성

API 프로세스 종료(pid 13912) → 재기동(pid 27636) 후: run `0a80f90f9ca8` SUCCEEDED 조회, 보고서 `5ea82c75795b` 조회, PDF 다운로드 200 (1,205,539 bytes). **PASS**

## 5. Railway Redis / RQ

`redis.ping()` True, Redis 8.2.11 (Railway TCP 프록시). worker 로그: `app.runner.execute(...)` 36 s/29 s, `app.report.builder.build_report(...)` 2 m 10 s 등 Job OK. `/api/health`: `redis.ok=true, workers=1, provider=Railway`.

## 6. 최종 분석 run `0a80f90f9ca8` 내부 QA — 12 PASS / 1 FAIL(참고 항목)

원본: `docs/qa/final_run_extract.txt`, `docs/sample_report/analysis_summary.json`.

| 항목 | 결과 | 값 |
|---|---|---|
| C A==A Δ0 | PASS | 21쌍 |
| A A==B Δ0 | PASS | 2,698 수광점 감소/증가 0 |
| 자가교차 offset | PASS | ε=0 일 때 1,349 레이 중 1,217 자가충돌 → ε=0.048 m 일 때 0 |
| Open3D vs 독립 엔진 | PASS | 600 레이 일치율 1.0 |
| B A==B 0 | PASS | 신규/해소 최대 0 m² |
| 공통 분모 | PASS | 20,742셀 / 82,968 m² |
| 기둥 해석해(정오) | PASS | 해석 55.55 m vs 레이 55.54 m |
| 그림자 방향 | PASS | 351.8° (북쪽) |
| 좌표 round-trip | PASS | 1.5e-9 m |
| 태양벡터·남중 | PASS | 정오 방위 171.8°, 고도 28.59° |
| 수직기준 기록 | PASS | SYNTHETIC_UNIFIED |
| 접합부 경사 | PASS | 최대 3.53° |
| **분석영역 밖 차폐 경고** | **FAIL (참고)** | 경계 지형 고도각 1.47°, 내부 지형 최대 2.62°, 08:02:30 최소 태양고도 2.53° → 일출 직후 외곽 차폐 가능성. 숨기지 않고 보고서에 경고로 기재 |

민감도(같은 run): Δt=1분은 B안 평균 직사일조 202.149분(5분: 202.118), 감소 수광점 686(5분: 673), 음영 증가 면적 24,328 m²(5분: 22,872). 가상 지반 ±1/±3 m에서 A 지표는 거의 불변(단지 내부 상대기하 동일), 평균 음영은 192.4~201.3분 범위로 변화.

## 7. PDF 산출물 검증 (보고서 `5ea82c75795b`)

| 항목 | 결과 |
|---|---|
| 파일 | `backend/data/reports/5ea82c75795b/GeoBuild_Impact_3D_Report_0a80f90f9ca8.pdf` (사본: `docs/sample_report/`) |
| 크기 / 쪽수 | 1,205,539 bytes / 37쪽 |
| 첫 쪽 제목 | 포함 |
| 한글 텍스트 추출 | 9,560자 (pypdf) |
| 장 제목 16개 누락 | 없음 |
| 목차 쪽번호 | 2회 렌더 후 안정 (재추출 일치) |
| 핵심 수치 대조 (analysis_summary.json) | 6/6 일치 |
| 포함 이미지 | 22 (SVG 지도·차트는 벡터 텍스트, 3D 캡처 PNG 1) |
| 3D WebGL 캡처 | 성공 (프런트 미기동 시 정적지도 대체 경로는 pytest로 검증) |
| HTML / ZIP | 955,567 bytes / 2,998,455 bytes (manifest SHA-256 포함) |

## 8. 실제 DEM (사용자 제공 SRTM 30 m) 분석

```
uv run python -m scripts.import_dem --path ".../srtm_dem_30.tif"   → project bc5c60cc2fe6, dataset 1cfd3e5d804a (WARN, 활성화)
```

| 항목 | 값 |
|---|---|
| 원본 | 2,334,048,408 bytes, SHA-256 `9a8aa71c…471003`, EPSG:5179, 24,784×23,542 셀, 셀 25.90 m, NoData 미정의, 수직기준 메타데이터 없음 |
| 추출 | 대상지 ±6 km 창(재표본화 없음) 0.19 MB · 원본 값 동일성은 pytest로 검증 |
| 검사 경고 | 수직기준 UNRESOLVED · SRTM 표면모델(DSM_POSSIBLE) · 급경사 최대 48.7° |
| 지형 모델 | ±4.8 km / 20 m 메쉬 (231,361 정점) — 계양산 포함 |
| 가상 계획지반 | pad 9.6 m, 절토 5.50 m / 성토 7.11 m (SRTM 대상지 내 2~14 m 변동) |
| 분석 run `32b18cb86cfd` (RQ) | SUCCEEDED 46.2 s, QA 12 PASS / 1 FAIL(참고: 외곽 차폐 경고 — 내부 지형 최대 고도각 6.04°, 최소 태양고도 2.53°) |
| 지형 차폐 결과 | 08–16시 수광점-구간 259,008개 중 지형(TERRAIN)이 차폐 원인인 구간 **0** (계양산은 해당 시간대 태양 방위·고도와 겹치지 않음) |
| A / B / C | 감소 수광점 657, 최대 −205분, 평균 212.19→202.57분 / 최대 신규 음영 3,708 m²(13:47:30), 음영 증가 22,556 m² / 최소 이격 30.00 m |
| 보고서 `1cab08f85ba8` | 37쪽, 1,375,824 bytes, 한글 9,733자, 핵심 수치 대조 일치, 목차 안정, 3D 캡처 포함 → `docs/sample_report_srtm/` |
| 화면 | `docs/screenshots/09_srtm_compare_B.png`, `10_srtm_data_quality.png` (페이지 오류 0) |

첫 보고서(`422ec45716b6`)는 ±4.8 km 메쉬 렌더링이 헤드리스 SwiftShader에서 25 s 안에 준비되지 않아 3D 캡처가 **빠졌고**(정적 지도로 대체, 보고서는 정상), 준비 프레임 10·제한 90 s로 조정한 뒤 캡처가 포함되었습니다.
pytest는 실제 DEM 경로 테스트 2건 추가 후 **47 passed**.

## 9. BLOCKED / 미검증

| 항목 | 사유 | 재현 명령 |
|---|---|---|
| `docker compose up --build` | 개발 PC에 Docker 미설치 | `docker compose up --build` |
| PostgreSQL/PostGIS 런타임 | 로컬 PostgreSQL 17 서비스는 실행 중이나 접속 비밀번호 없음(추측하지 않음). 기본 SQLite로 검증 | `DATABASE_URL=postgresql+psycopg2://... uv run python -m scripts.migrate` |
| PostGIS `ST_Distance` | 미사용 — 이격은 Shapely(ENU)로 계산 | — |
| 실제 DEM 정확도 | SRTM 파일로 분석은 수행했으나 수직기준·취득일·라이선스는 파일에 없어 미확보 | 원 제공처 메타데이터 확인 |
| 실제 GPU 렌더링 | 헤드리스 SwiftShader로만 확인 | `npm run dev` 후 브라우저 |
| 마스터 프롬프트 파일 | 프로젝트 루트가 빈 디렉터리였음(파일 부재). 대화에 첨부된 본문을 기준으로 구현 | — |

## 10. 심층 재검토 (2026-11-18, 2차) — 결함 11건 수정

실제 실패 경로를 탐침(probe)으로 재현한 뒤 수정했고, 각 결함에 회귀 테스트를 추가했습니다 (`tests/test_review_regressions.py`).

| # | 결함 | 재현 | 수정 | 회귀 테스트 |
|---|---|---|---|---|
| 1 | 대상지 안 DEM NoData가 있으면 가상 평탄 계획지반이 NaN (0×NaN) → 지면 구멍 | 81개 정점 NaN | pad 내부는 항상 pad_z | `test_pad_stays_flat_where_dem_has_nodata` |
| 2 | 잘못된 분석 조건(7분 간격, 시작>종료, 25:00, 알 수 없는 시간대, 1900년)이 200으로 접수되고 worker에서 실패 | 200 → FAILED | 요청 단계 422 검증 | `test_invalid_analysis_conditions_rejected_upfront` ×5 |
| 3 | 중정(hole) footprint가 경고 없이 외곽만 남아 건물로 채워짐 | 200 WARN | 명시적 거부 | `test_courtyard_hole_rejected_not_silently_filled` |
| 4 | 40자 ID(PostgreSQL 컬럼 초과), 중복 ID, 주변건물 ID 충돌, 500층 허용 | 200 WARN | ID 형식·중복·충돌·층수 검증 | `test_building_id_and_floor_validation` ×4 |
| 5 | 건물 GeoJSON 업로드가 클라이언트 파일명을 그대로 경로에 사용 (경로 이탈) | 코드 검토 | 정제된 파일명 공용 함수 사용 | `test_upload_filename_is_sanitised_and_never_overwrites` |
| 6 | 같은 이름 재업로드가 과거 분석 스냅샷이 참조하는 파일을 덮어씀 (불변성 훼손) | 코드 검토 | 업로드마다 고유 접두어 | 위 테스트 |
| 7 | 대용량 DEM 업로드를 메모리에 통째로 3회 적재 (요청 본문·검사·샘플러) | 2.3 GB 파일 기준 | 디스크 스트리밍 + 2,500만 셀 초과 시 대상지 ±6 km 자동 추출(원본 해시 기록) + 검사 통계 표본화 | `test_large_upload_is_clipped_with_provenance` |
| 8 | 죽은 RQ worker가 TTL 동안 "활성"으로 집계 → 작업이 영원히 PENDING | health에서 worker 2 (실제 1) | heartbeat 8분 이내만 집계 + 정체 감시(PENDING 10분/RUNNING 15분/보고서 20분 → FAILED, 사유 표시) | `test_stale_jobs_are_reported_as_failed` |
| 9 | 광선 시작점 offset이 지형 범위에 비례 → SRTM(±4.8 km)에서 창 수광점이 벽에서 0.19 m 이격 | offset 0.192 m | 분석 대상(건물·대상지) 범위 기준 → 0.02 m, 알고리즘 버전 `abc-2026.11.2` (캐시 무효화). 실행 내 자가충돌 검사 0건 유지 | `test_offset_follows_analysis_targets_not_terrain_extent` |
| 10 | 주동 1개(이격 쌍 없음)일 때 보고서·화면이 `min_pair` None으로 중단될 수 있음 | 코드 검토 | 보고서·KPI 가드 | `test_significant_loss_counts_all_receivers_and_c_without_pairs_reports` |
| 11 | 검토 권고(12장)가 감소 상위 20개만 보고 판단 → 다른 주동 누락 | SRTM run: 상위 20개는 105·102만 | 전체 수광점 기준 주동별 집계(`significant_loss`) | 위 테스트 (전체 행과 개수 일치) |

추가 소규모 수정: 분석 화면 시간대 입력을 Asia/Seoul 고정(3D 슬라이더와 동일 순간 보장), 비교 화면의 지면 메쉬 오류 표시, docker-compose의 `.env` 선택화, import 스크립트가 원본 전체 경로 대신 파일명만 저장(로컬 경로 비노출, SHA-256으로 식별).

### 독립 검증 추가

| 검증 | 결과 |
|---|---|
| pvlib NREL SPA vs 별도 구현 NOAA 태양위치 (1년, 주 1회 × 5시각, 고도>2°) | 고도·방위 최대 차이 < 0.05° — PASS |
| 동지 분석창 겉보기고도 − 기하고도 (대기굴절) | 모두 양수, 최대 < 0.6° — PASS |
| 전체 데모 장면(지형 115,200 삼각형 + 건물 12동)에서 Open3D vs 독립 float64 엔진, 수광점·지면 레이 > 500개 | 차폐 여부·차폐 객체 ID 일치율 100% — PASS |

### 재실행 결과

```
cd backend && uv run pytest -v        → 66 passed, 2 warnings in 159.97s
cd frontend && npx tsc -b              → 성공
cd frontend && npx playwright test     → 1 passed (3.8m), 작업 백엔드 rq, run b21e8d36dc9a, PDF 1,207,113 bytes
```

| 표본 보고서 | run | 쪽 | 크기 | QA |
|---|---|---|---|---|
| `docs/sample_report/` (합성 DEMO, 101동 +8 m) | b21e8d36dc9a | 37 | 1,207,113 B | 핵심수치 일치·목차 안정 |
| `docs/sample_report_srtm/` (SRTM) | 87dfd0b98dc0 | 37 | 1,376,584 B | 12 PASS / 1 참고 FAIL(외곽 차폐 경고), 3D 캡처 포함 |

결함 9 수정 전후 SRTM 결과: 일조 감소 수광점 657 → 648, 평균 직사일조 A 212.19 → 212.29분 / B 202.57 → 202.62분, 최대 신규 음영 3,708 → 3,732 m² (offset 0.192 → 0.02 m 영향). 권고 대상은 105·102동 → 105(91점)·102(33점)·101(26점)·103(14점)동으로 확장.
