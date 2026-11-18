# 소개 영상 파이프라인 (JIRISO DATA STUDIO · GeoBuild Impact 3D)

실제 앱 화면 녹화 + 모션그래픽 + 한국어 내레이션 + 자막을 코드로 다시 만들 수 있게 구성했습니다.
모든 컷 길이는 내레이션 길이에서 계산됩니다.

| 단계 | 도구 | 파일 |
|---|---|---|
| 1. 앱 녹화 | Playwright + Chrome(GPU) DevTools screencast → FFmpeg 30 fps | `capture/record.mjs` |
| 2. 내레이션 | MeloTTS (KR) + g2pkk 발음 변환, 발음 사전 | `tts/script.json`, `tts/synth.py` |
| 3. 모션그래픽·편집 | HyperFrames (HTML + GSAP, 결정적 렌더) | `hf/build.mjs` → `hf/index.html`, `hf/compositions/*` |
| 4. 후반 | FFmpeg: libass 자막, 색 보정, BGM 더킹, 라우드니스(-16 LUFS) | `post/post.mjs` |

## 다시 만들기

```bash
# 0) 앱 실행: API :8000 (+ RQ worker), 프런트 :5173
# 1) 데모 프로젝트 2개 준비(분석·보고서 포함) 후 5개 장면 녹화
node video/capture/record.mjs --prepare
# 2) 보고서 PDF 일부 페이지 이미지 (backend venv의 PyMuPDF)
python -c "import fitz,json;c=json.load(open('video/hf/assets/rec/context.json'));import glob;p=glob.glob(f'backend/data/reports/{c[\"report\"]}/*.pdf')[0];d=fitz.open(p);[d[n-1].get_pixmap(dpi=130).save(f'video/hf/assets/pdf/p{n:02d}.png') for n in (1,2,6,17,21,25)]"
# 3) 내레이션 (MeloTTS venv, python-mecab-ko 경로를 KMECAB로)
KMECAB=<python-mecab-ko target dir> python video/tts/synth.py
# 4) 장면 생성 → 검사 → 렌더
node video/hf/build.mjs
cd video/hf && DO_NOT_TRACK=1 HYPERFRAMES_NO_TELEMETRY=1 npx hyperframes check && \
  DO_NOT_TRACK=1 HYPERFRAMES_NO_TELEMETRY=1 npx hyperframes render -o renders/base.mp4 -q delivery --video-frame-format png
# 5) 마감 (BGM을 지정하지 않으면 직접 합성한 잔잔한 패드 사용)
node video/post/post.mjs --bgm path/to/youtube_audio_library_track.mp3
```

결과: `video/out/GeoBuild_Impact_3D_JIRISO_DATA_STUDIO.mp4` (1920×1080, 30 fps).

## 메모

- Windows에서 g2pkk는 `eunjeon`만 찾는데 빌드되지 않으므로 `synth.py`가 python-mecab-ko로 연결합니다.
  python-mecab-ko(`mecab`)와 MeloTTS가 쓰는 mecab-python3(`MeCab`)는 대소문자만 다른 폴더라 같은 site-packages에 두면 충돌합니다 → `uv pip install --target <dir> python-mecab-ko` 후 `KMECAB=<dir>`.
- MeloTTS의 일본어 모듈이 import 시 MeCab 사전을 요구하므로 `unidic` 대신 `unidic-lite`를 설치합니다.
- 녹화 스크립트는 `window.__geobuild.viewers[i].toScreen(x, y, z)`(현장 ENU 좌표 → 페이지 픽셀)로 3D 건물 위치를 찾아 드래그합니다.
- 화면 속 수치는 모두 녹화한 실제 분석 실행(run)의 결과입니다. 가상 PoC이며 실제 LH 설계안이 아닙니다.
