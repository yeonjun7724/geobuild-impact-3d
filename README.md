# GeoBuild Impact 3D

**JIRISO DATA STUDIO** · CesiumJS 기반 공동주택 설계변경 전후 **(A) 직사일조시간 · (B) 그림자 변화 · (C) 건축물 이격거리** 분석 및 상세 기술보고서 생성 웹 애플리케이션

> ⚠ **인천계양 A2블록 주변을 배경으로 한 가상 공동주택 설계변경 검증 PoC. 실제 LH 설계안, 인허가 검토, 공식 성능평가 결과가 아님.**
> 기본 지형은 **합성(SYNTHETIC) 30 m DEM**이며 실제 인천계양 지형이 아닙니다. 실제 30 m DEM GeoTIFF는 [데이터] 탭에서 업로드할 수 있습니다.

## 라이브 데모 (Railway)

**https://app-production-4fadbb17.up.railway.app**

| 예시 | 결과 비교 화면 | 기술보고서 |
|---|---|---|
| DEMO · 합성 30 m DEM | [/projects/f899e2de5dfd/compare/9887c3fa81a0](https://app-production-4fadbb17.up.railway.app/projects/f899e2de5dfd/compare/9887c3fa81a0) | [/reports/9887c3fa81a0](https://app-production-4fadbb17.up.railway.app/reports/9887c3fa81a0) |
| SRTM 30 m DEM (계양산 포함 ±4.8 km) | [/projects/b8f984491b32/compare/6f71cdf84ebb](https://app-production-4fadbb17.up.railway.app/projects/b8f984491b32/compare/6f71cdf84ebb) | [/reports/6f71cdf84ebb](https://app-production-4fadbb17.up.railway.app/reports/6f71cdf84ebb) |

API 문서: [/docs](https://app-production-4fadbb17.up.railway.app/docs) · 상태: [/api/health](https://app-production-4fadbb17.up.railway.app/api/health)

배포 구성: 단일 Railway 서비스(루트 `Dockerfile`: React/Cesium 빌드 + FastAPI + RQ worker + Chromium) + 영구 볼륨 `/data`(SQLite·결과·보고서) + Railway Redis(사설망 `redis.railway.internal`, 큐 `geobuild-analysis-prod`). `main` 브랜치 push 시 자동 재배포. 로그인 없는 공개 PoC이므로 업로드는 300 MB로 제한됩니다.

## 무엇을 하는가

| 단계 | 내용 |
|---|---|
| 편집 | 기준안 A(잠금) / 변경안 B — 주동별 동서·남북 이동(m), 회전(°), 층수(1층=2.9 m) 슬라이더. 저장 시 시나리오 해시·revision 갱신 |
| 계산 | 서버 작업(Redis+RQ, Railway Redis)에서 A/B/C 계산. 입력은 불변 스냅샷, cache key = 입력 해시+시나리오+시간/격자/알고리즘 |
| A 직사일조 | pvlib NREL SPA 태양위치 + Open3D `RaycastingScene` 3D 광선교차. 외벽 대리지점(facade_proxy) 수광점별 총/최대연속 직사일조, A/B 동일 ID 비교, 차폐 원인 건물 |
| B 그림자 | 2 m 지표 격자(공통 분모) × 5분 간격 광선교차. 신규 음영/음영 해소 면적-시간 곡선, 누적 음영시간 증감, 대표시각 4상태, 가상 놀이터·휴게공간 |
| C 이격 | ENU 평면 Shapely 최단거리·최근접점, 접촉/중첩 0 m 플래그, 외벽 법선 방향 거리, 가상 대지경계 이격 |
| 검토 | Cesium 3D (A/B/오버레이/좌우 분할 카메라 동기화), 시간 슬라이더(KST→UTC 동일 순간), 수광점/격자 클릭 드릴다운, 최단 연결선, 표 CSV |
| 보고서 | 결과 JSON에서 결정론적으로 생성한 16장(+표지) 상세 HTML/PDF(A4, 목차 쪽번호, 그림·표 번호), 증거 ZIP(CSV/GeoJSON/JSON/SVG/PNG/manifest) |

## 빠른 시작 (로컬, Windows/macOS/Linux)

필요: Python 3.12 + [uv](https://docs.astral.sh/uv/), Node 20+ (검증: Node 24.19), (선택) Railway Redis.

```bash
# 1) backend
cd backend
uv sync                                  # uv.lock 고정 버전 설치
uv run playwright install chromium       # PDF 렌더러
cp .env.example .env                     # REDIS_URL 입력 (비우면 JOB_BACKEND=thread 로컬 모드)
uv run python -m scripts.migrate         # DB 스키마 생성 (SQLite 기본, DATABASE_URL로 PostgreSQL)
uv run python -m scripts.seed_demo       # (선택) DEMO 프로젝트 생성
uv run uvicorn app.main:app --port 8000  # API  → http://127.0.0.1:8000/docs (OpenAPI)
uv run python -m app.worker              # RQ worker (다른 터미널, REDIS_URL 필요)

# 2) frontend
cd ../frontend
npm ci
npm run dev                              # → http://127.0.0.1:5173/projects
```

Windows에서는 `scripts/dev.ps1`이 API·worker·frontend를 한 번에 띄웁니다.

### 대용량 실제 DEM 가져오기 (예: 전국 SRTM 30 m 모자이크)

수 GB 파일은 브라우저 업로드 대신 원본을 그대로 두고 대상지 주변만 잘라 등록합니다(재표본화 없음, 원본 경로·크기·SHA-256 기록).

```bash
cd backend
uv run python -m scripts.import_dem --path "C:/.../srtm_dem_30.tif"              # 새 프로젝트(가상 단지) + DEM 활성화
uv run python -m scripts.import_dem --path "..." --project <project_id>          # 기존 프로젝트에 등록
```

전체 ±4.8 km를 덮는 실제 DEM은 지형 모델을 ±4.8 km / 20 m 메쉬로 넓혀(계양산 등 원거리 산지 차폐 반영) 분석합니다. 합성 DEMO는 ±1.2 km / 10 m를 유지합니다.
수직기준 메타데이터가 없는 파일은 `UNRESOLVED`로 표시되며 지오이드/타원체 상수 환산을 하지 않습니다.
로그인은 없습니다(로컬 PoC).

### Docker (미검증 — 이 개발 환경에 Docker 없음)

```bash
docker compose up --build                                       # frontend:5173, api:8000, worker, postgres(PostGIS)
REDIS_URL=redis://redis:6379/0 docker compose --profile local-redis up --build   # Redis까지 로컬
```

API 이미지에서 `fonts-noto-cjk`와 `playwright install --with-deps chromium`를 설치합니다. 이 저장소의 개발 PC에서는 Docker를 사용할 수 없어 compose 실행을 **검증하지 못했습니다**(docs/QA_RESULTS.md BLOCKED 항목).

## Redis (Railway)

작업큐는 Railway에 프로비저닝한 Redis(프로젝트 `geobuild-impact-3d`, 서비스 `Redis`, 공개 TCP 프록시)를 사용합니다. 접속 URL은 `backend/.env`의 `REDIS_URL`에만 있고 git에서 제외됩니다. Windows에서는 fork가 없어 `SimpleWorker`+`TimerDeathPenalty`, Linux에서는 일반 RQ `Worker`를 사용합니다. Redis가 끊기거나 활성 worker가 없으면 API 프로세스 내 스레드로 대체 실행하며, 실제 사용된 백엔드가 실행 기록과 UI에 표시됩니다.

## 테스트

```bash
cd backend && uv run pytest -v              # 66개: 해석해·독립 태양위치·전체 장면 엔진 교차검증·A==B·좌표·DEM 실패경로·API E2E·PDF 검증·리뷰 회귀
cd frontend && npx playwright test          # 실제 브라우저 E2E (API·worker·dev 서버 실행 상태에서)
```

결과 기록: [docs/QA_RESULTS.md](docs/QA_RESULTS.md). 설계: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). 단계 계획: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## 데이터와 출처

| 자료 | 분류 | 출처 |
|---|---|---|
| 대상지 대표점 37.5559943N, 126.7545222E (동양동 413-2) | REAL_OFFICIAL (점만) | [LH 청약플러스 인천계양 A2 공고](https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancInfo.do?aisTpCd=05&ccrCnntSysDsCd=02&mi=1027&panId=0000060706&uppAisTpCd=05) 지도 마커, 2026-11-18 접근. 블록 경계 미검증 |
| 교차확인 (동양동 법정동 중심점) | REAL_OFFICIAL | OpenStreetMap Nominatim, ODbL |
| 기본 분석일 2026-12-22 (동지) | REAL_OFFICIAL | [한국천문연구원 2026 월력요항](https://astro.kasi.re.kr/kor/life/post/calendarData?search_year=2026) |
| 30 m DEM | **SYNTHETIC** (DEMO) / USER_UPLOADED | 자체 생성 GeoTIFF(EPSG:5179, 실제 지형 아님) / 사용자 제공 `srtm_dem_30.tif`(EPSG:5179, 25.9 m 셀, 수직기준 미기재 → UNRESOLVED, SRTM 표면모델 성격) |
| 주동 7개·주변건물 5개·대지경계·놀이터·휴게공간 | SYNTHETIC | 자체 생성 가상 형상 |
| 계획지반 | DERIVED | 대상지 내 DEM 중앙값 평탄 pad + 60 m 접합대 (가상 지반 가정) |
| 배경지도 (선택) | — | © OpenStreetMap contributors (타일 실패 시에도 3D·분석 정상) |

Cesium ion 토큰, Esri, 비공개 LH BIM은 사용하지 않습니다. Cesium 정적 자산은 자체 호스팅(`/cesium`)합니다.

## 한계 (요약)

기하학적 직사일조 가능 시간(일사량·실내조도·기상 아님) · 외벽 대리지점(세대별 일조 아님) · 30 m DEM 정확도 · 분석영역(2.4 km) 밖 차폐 미반영 · 법정 일조/이격 적합성 판정 없음(건축법 제61조·시행령 제86조는 참고만).
