"""DEMO site: virtual apartment complex near the Incheon Gyeyang public housing district A2 block.

Location provenance
-------------------
The ENU origin is the map-marker point published on the official LH Cheongyak Plus announcement page for
"인천계양 A2블록 공공분양주택" (address 인천광역시 계양구 동양동 413-2). That page gives a single marker point,
NOT the block boundary; the 300 m x 300 m site square, all buildings, open spaces and the boundary below are
VIRTUAL (SYNTHETIC) and must never be presented as the real LH design.

Separating geography (SITE_META) from the building scenario (demo_buildings) keeps the site swappable
(e.g. 부천대장 later).
"""
from __future__ import annotations

import math

DISCLAIMER = "인천계양 A2블록 주변을 배경으로 한 가상 공동주택 설계변경 검증 PoC. 실제 LH 설계안, 인허가 검토, 공식 성능평가 결과가 아님."

LH_URL = ("https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancInfo.do?aisTpCd=05&ccrCnntSysDsCd=02"
          "&mi=1027&panId=0000060706&uppAisTpCd=05")
KASI_URL = "https://astro.kasi.re.kr/kor/life/post/calendarData?search_year=2026"

SITE_META = {
    "key": "incheon-gyeyang-a2",
    "name": "인천계양 공공주택지구 A2블록 인근 (가상 단지)",
    "district": "인천계양 공공주택지구 (인천광역시 계양구 귤현동·동양동·박촌동·병방동·상야동 일원)",
    "official_address": "인천광역시 계양구 동양동 413-2",
    "lat0": 37.5559943,
    "lon0": 126.7545222,
    "location_source": {
        "type": "REAL_OFFICIAL",
        "method": "LH 청약플러스 A2블록 공고 페이지의 지도 마커 좌표(lat_0/lng_0) 추출",
        "url": LH_URL,
        "accessed": "2026-11-18",
        "point_only": True,
        "boundary_verified": False,
        "cross_check": {
            "source": "OpenStreetMap Nominatim (동양동 법정동 중심점, ODbL)",
            "lat": 37.5570452, "lon": 126.7591267, "accessed": "2026-11-18",
        },
    },
    "approximate_demo_location": False,
    "boundary_status": "UNVERIFIED - 실제 A2블록 경계 미확보, 가상 300m×300m 대상지 사용",
    "follow_up_candidate": "부천대장 공공주택지구 (후속 후보, 미구현)",
}

SITE_RECT = (-150.0, -150.0, 150.0, 150.0)


def _rect(cx: float, cy: float, L: float, D: float, rot_deg: float = 0.0) -> list[list[float]]:
    """Counter-clockwise rectangle; edge 0 is the south (long) facade when rot=0."""
    hx, hy = L / 2, D / 2
    pts = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
    c, s = math.cos(math.radians(rot_deg)), math.sin(math.radians(rot_deg))
    return [[round(cx + x * c - y * s, 4), round(cy + x * s + y * c, 4)] for x, y in pts]


def demo_buildings() -> list[dict]:
    main = [
        ("101", -80, 92, 60, 15, 25, 0),
        ("102", 10, 95, 60, 15, 25, 0),
        ("103", 95, 72, 46, 15, 22, 8),
        ("104", -88, 12, 55, 15, 20, 0),
        ("105", 5, 15, 60, 15, 20, 0),
        ("106", -62, -78, 55, 15, 15, 0),
        ("107", 48, -72, 60, 15, 18, 0),
    ]
    ctx = [
        ("C01", -60, -232, 50, 15, 15, 0),
        ("C02", 62, -236, 50, 15, 12, 0),
        ("C03", 232, 20, 40, 20, 8, 0),
        ("C04", 0, 245, 70, 15, 20, 0),
        ("C05", -232, -30, 30, 30, 5, 0),
    ]
    out = []
    for bid, cx, cy, L, D, fl, rot in main:
        out.append({"id": bid, "name": f"{bid}동 (가상)", "kind": "MAIN", "floors": fl,
                    "footprint": _rect(cx, cy, L, D, rot), "data_class": "SYNTHETIC"})
    for bid, cx, cy, L, D, fl, rot in ctx:
        out.append({"id": bid, "name": f"주변 참고건물 {bid} (가상)", "kind": "CONTEXT", "floors": fl,
                    "footprint": _rect(cx, cy, L, D, rot), "data_class": "SYNTHETIC"})
    return out


def demo_open_spaces() -> list[dict]:
    return [
        {"id": "OS-PLAY", "name": "어린이놀이터 (DEMO 가상)", "kind": "PLAYGROUND",
         "polygon": [[-40, -52], [-8, -52], [-8, -30], [-40, -30]], "data_class": "SYNTHETIC"},
        {"id": "OS-REST", "name": "휴게공간 (DEMO 가상)", "kind": "REST_AREA",
         "polygon": [[60, -22], [100, -22], [100, 8], [60, 8]], "data_class": "SYNTHETIC"},
    ]


def demo_site_boundary() -> list[list[float]]:
    x0, y0, x1, y1 = SITE_RECT
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


# Default variant B (virtual design change) used by the demo seed
DEMO_B_TRANSFORMS = {
    "105": {"dx": 10.0, "dy": -8.0, "rot_deg": 0.0, "floors_delta": 5},
    "107": {"dx": 0.0, "dy": 0.0, "rot_deg": 12.0, "floors_delta": 4},
    "104": {"dx": -6.0, "dy": 0.0, "rot_deg": 0.0, "floors_delta": 0},
}
