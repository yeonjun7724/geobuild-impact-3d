"""Statutory distance checks for apartment layouts (건축법 제61조, 시행령 제86조, 지자체 건축조례).

Source texts (verbatim, with fetch date) are in docs/law/LAW_TEXTS.md. What is checked, per scenario:

  N  정북방향 일조 (법 61조①, 영 86조① / 2027.2.12.부터 법 61조① 각 호)
     each part of a building keeps a distance from the true-north adjacent site boundary:
       ~2027.2.11:  height <= 10 m -> 1.5 m,  > 10 m -> height / 2
       2027.2.12~:  height <= 10 m -> 1.5 m,  10-17 m -> 5 m,  > 17 m -> height / 2
  W  채광 이격 (영 86조③1호)  height of each part <= 2x (근린상업·준주거 4x) the perpendicular distance from a
     window wall to the adjacent site boundary
  D  동간 이격 (영 86조③2호 가~마목, 조례 계수)
       가  window wall -> facing building: k x height
       나  higher building's main openings face a lower building lying on its south side (east..south..west):
           max(10 m, k x height of the lower building)
       다  building <-> 부대·복리시설: 1 x height of the facility
       라  wall without daylight windows <-> side wall: 8 m
       마  side wall <-> side wall: 4 m

Interpretation choices (shown in the output so a reviewer can disagree with them):
  - flat roofs: "each part" is the full building height at that footprint point (no setback forms)
  - 가목 height = the taller of the two facing buildings (conservative; the decree says "건축물 각 부분 높이")
  - 영 86조⑥: a road/park/river beyond a site boundary edge moves that boundary to the centre line of the strip
    (공동주택), entered per boundary edge as the strip width
  - facade roles (채광창 벽면 / 창 없는 벽면 / 측벽) default to: long walls = 채광창, short walls = 측벽, main
    openings = the window wall facing most to the south; every role can be overridden per building and edge
"""
from __future__ import annotations

import math
from datetime import date

import numpy as np
from shapely.geometry import LineString, Point, Polygon

WINDOW, BLANK, SIDE = "WINDOW", "BLANK", "SIDE"
FACADE_LABEL = {WINDOW: "채광창 벽면", BLANK: "창 없는 벽면", SIDE: "측벽"}
NEW_NORTH_RULE_FROM = date(2027, 2, 12)
RAY_M = 600.0
SAMPLE_M = 2.0

# k for 가목 / 나목 by preset and project type. Statutory = 영 86조③2호 minimum, Incheon = 조례 제32조⑤⑥
PRESETS = {
    "STATUTORY": {"label": "건축법 시행령 최소기준", "source": "영 86조③2호",
                  "k": {"GENERAL": 0.5, "REDEVELOPMENT": 0.5, "STATION_REDEVELOPMENT": 0.5, "URBAN_HOUSING": 0.25}},
    "INCHEON": {"label": "인천광역시 건축 조례", "source": "인천광역시 건축 조례 제32조⑤⑥ (2026.7.13. 시행)",
                "k": {"GENERAL": 1.0, "REDEVELOPMENT": 0.8, "STATION_REDEVELOPMENT": 0.5, "URBAN_HOUSING": 0.5}},
}
PROJECT_TYPES = {"GENERAL": "일반 공동주택", "REDEVELOPMENT": "정비사업(도시정비법 등)",
                 "STATION_REDEVELOPMENT": "역세권 정비사업", "URBAN_HOUSING": "도시형 생활주택"}
ZONINGS = {"EXCLUSIVE_RES": "전용주거지역", "GENERAL_RES": "일반주거지역", "SEMI_RES": "준주거지역",
           "NEIGHBORHOOD_COMMERCIAL": "근린상업지역", "OTHER": "기타"}

DEFAULT_PARAMS = {
    "ref_date": "2026-11-18",        # 허가(변경) 신청일 등 적용 기준일
    "zoning": "GENERAL_RES",
    "north_mode": "APPLY",            # APPLY | EXEMPT (영 86조② 각 호, 정북 인접대지가 주거지역 아님 등) | NOTICE (법 61조③ 고시)
    "preset": "INCHEON",
    "project_type": "GENERAL",
    "k_override": None,               # 지구단위계획 등으로 계수가 따로 정해진 경우
    "boundary_beyond_m": {},          # {edge_index: width of road/park/river beyond that boundary edge}
    "facades": {},                    # {building_id: [WINDOW|BLANK|SIDE per footprint edge]}
    "main_facade": {},                # {building_id: edge_index}
    "facility_ids": [],               # buildings that are 부대시설·복리시설 (다목)
}


def merged_params(p: dict | None) -> dict:
    out = {**DEFAULT_PARAMS, **{k: v for k, v in (p or {}).items() if k in DEFAULT_PARAMS and v is not None}}
    if (p or {}).get("k_override") is None:
        out["k_override"] = None
    return out


def coefficient(params: dict) -> float:
    if params.get("k_override"):
        return float(params["k_override"])
    return float(PRESETS[params["preset"]]["k"][params["project_type"]])


# ------------------------------------------------------------------------------------------------ geometry
def _ring(fp) -> np.ndarray:
    a = np.asarray(fp, dtype=float)[:, :2]
    if np.allclose(a[0], a[-1]):
        a = a[:-1]
    return a


def edges_of(ring: np.ndarray):
    """(p0, p1, outward unit normal, length) per edge, in ring order."""
    ccw = Polygon(ring).exterior.is_ccw
    out = []
    for i in range(len(ring)):
        p0, p1 = ring[i], ring[(i + 1) % len(ring)]
        d = p1 - p0
        L = float(np.hypot(*d))
        if L < 1e-6:
            out.append((p0, p1, np.array([0.0, 0.0]), 0.0))
            continue
        n = np.array([d[1], -d[0]]) / L if ccw else np.array([-d[1], d[0]]) / L
        out.append((p0, p1, n, L))
    return out


def default_facades(ring: np.ndarray) -> tuple[list[str], int]:
    es = edges_of(ring)
    longest = max(e[3] for e in es) if es else 0
    roles = [WINDOW if e[3] >= 0.4 * longest else SIDE for e in es]
    win = [i for i, r in enumerate(roles) if r == WINDOW]
    main = min(win, key=lambda i: es[i][2][1]) if win else 0  # most southward outward normal
    return roles, main


def _samples(p0, p1, L):
    n = max(2, int(math.ceil(L / SAMPLE_M)) + 1)
    ts = np.linspace(0.02, 0.98, n)
    return [p0 + (p1 - p0) * t for t in ts]


def _first_hit(origin, direction, geom_boundary) -> tuple[float, np.ndarray] | None:
    end = origin + direction * RAY_M
    inter = LineString([origin, end]).intersection(geom_boundary)
    if inter.is_empty:
        return None
    pts = []
    for g in getattr(inter, "geoms", [inter]):
        if g.geom_type == "Point":
            pts.append(np.array(g.coords[0]))
        elif g.geom_type == "LineString":
            pts.extend(np.array(c) for c in g.coords)
    best = None
    for q in pts:
        d = float(np.dot(q - origin, direction))
        if d > 1e-6 and (best is None or d < best[0]):
            best = (d, q)
    return best


def _edge_index_near(ring: np.ndarray, q: np.ndarray) -> int:
    best, bi = 1e18, 0
    for i, (p0, p1, _, L) in enumerate(edges_of(ring)):
        if L == 0:
            continue
        t = float(np.clip(np.dot(q - p0, p1 - p0) / (L * L), 0, 1))
        d = float(np.hypot(*(p0 + (p1 - p0) * t - q)))
        if d < best:
            best, bi = d, i
    return bi


def _bearing(a, b) -> float:
    """Clockwise from true north, degrees."""
    return (math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) + 360.0) % 360.0


def north_required(h: float, ref: date) -> float:
    if h <= 10.0:
        return 1.5
    if ref >= NEW_NORTH_RULE_FROM and h <= 17.0:
        return 5.0
    return h / 2.0


def north_rule_text(ref: date) -> str:
    if ref >= NEW_NORTH_RULE_FROM:
        return "법 61조① (2027.2.12. 시행): 높이 10 m 이하 1.5 m, 10~17 m 5 m, 17 m 초과 높이의 1/2"
    return "영 86조① (2023.9.12. 개정): 높이 10 m 이하 1.5 m, 10 m 초과 높이의 1/2"


# ------------------------------------------------------------------------------------------------ checks
def check_layout(buildings: list[dict], boundary, params: dict | None, z_ref: float = 0.0) -> dict:
    """buildings: [{id, kind, footprint, height_m, floors}] (ENU metres). boundary: site boundary ring or None."""
    P = merged_params(params)
    ref = date.fromisoformat(P["ref_date"])
    k = coefficient(P)
    mains = [b for b in buildings if b["kind"] == "MAIN"]
    facilities = set(P["facility_ids"])
    rings = {b["id"]: _ring(b["footprint"]) for b in mains}
    polys = {bid: Polygon(r) for bid, r in rings.items()}
    H = {b["id"]: float(b["height_m"]) for b in mains}
    roles, mainface = {}, {}
    for bid, r in rings.items():
        dr, dm = default_facades(r)
        ov = P["facades"].get(bid)
        roles[bid] = ov if ov and len(ov) == len(dr) else dr
        mainface[bid] = int(P["main_facade"].get(bid, dm))
    findings: list[dict] = []
    notes: list[str] = []

    bpoly = Polygon(_ring(boundary)) if boundary is not None and len(boundary) >= 3 else None
    bring = _ring(boundary) if bpoly is not None else None
    beyond = {int(i): float(v) for i, v in (P["boundary_beyond_m"] or {}).items()}

    def boundary_dist(o, d):
        hit = _first_hit(o, d, bpoly.exterior)
        if hit is None:
            return None
        dist, q = hit
        ei = _edge_index_near(bring, q)
        extra = beyond.get(ei, 0.0) / 2.0  # 영 86조⑥: 공동주택은 중심선
        return dist + extra, q, ei, extra

    # ---- N: 정북방향 일조
    if bpoly is None:
        notes.append("대지경계선이 없어 정북 일조·채광 이격을 검토하지 않음")
    elif P["north_mode"] == "APPLY" and P["zoning"] in ("EXCLUSIVE_RES", "GENERAL_RES"):
        north = np.array([0.0, 1.0])
        for bid, r in rings.items():
            req = north_required(H[bid], ref)
            worst = None
            pts = [p for p0, p1, _, L in edges_of(r) if L > 0 for p in _samples(p0, p1, L)] + list(r)
            for o in pts:
                res = boundary_dist(np.asarray(o), north)
                if res is None:
                    continue
                d, q, ei, extra = res
                if worst is None or d < worst["actual_m"]:
                    worst = {"actual_m": round(d, 2), "from": [round(float(o[0]), 2), round(float(o[1]), 2)],
                             "to": [round(float(q[0]), 2), round(float(q[1]), 2)], "boundary_edge": ei, "beyond_half_m": extra}
            if worst:
                findings.append({"check": "N", "clause": "건축법 61조① · " + ("법 61조① 각 호" if ref >= NEW_NORTH_RULE_FROM else "영 86조①"),
                                 "title": "정북방향 일조", "subject": f"{bid}동", "buildings": [bid],
                                 "height_m": round(H[bid], 2), "required_m": round(req, 2), **worst,
                                 "ok": worst["actual_m"] + 1e-6 >= req, "margin_m": round(worst["actual_m"] - req, 2),
                                 "basis": f"높이 {H[bid]:.1f} m → 정북 대지경계선에서 {req:.2f} m 이상"})
    elif P["north_mode"] == "EXEMPT":
        notes.append("정북방향 일조: 영 86조② 각 호 해당(적용 제외)으로 설정됨")
    elif P["north_mode"] == "NOTICE":
        notes.append("정북방향 일조: 법 61조③ 정남방향 기준 고시 높이 적용 대상으로 설정됨 - 고시 높이로 별도 확인 필요")
    else:
        notes.append(f"정북방향 일조: {ZONINGS.get(P['zoning'], P['zoning'])}은 적용 대상(전용·일반주거) 아님")

    # ---- W: 채광창 벽면 -> 인접 대지경계선 (영 86조③1호)
    mult = 4.0 if P["zoning"] in ("SEMI_RES", "NEIGHBORHOOD_COMMERCIAL") else 2.0
    if bpoly is not None:
        for bid, r in rings.items():
            for ei, (p0, p1, n, L) in enumerate(edges_of(r)):
                if L == 0 or roles[bid][ei] != WINDOW:
                    continue
                worst = None
                for o in _samples(p0, p1, L):
                    res = boundary_dist(o + n * 1e-3, n)
                    if res is None:
                        continue
                    d, q, bei, extra = res
                    if worst is None or d < worst["actual_m"]:
                        worst = {"actual_m": round(d, 2), "from": [round(float(o[0]), 2), round(float(o[1]), 2)],
                                 "to": [round(float(q[0]), 2), round(float(q[1]), 2)], "boundary_edge": bei}
                if worst:
                    req = H[bid] / mult
                    findings.append({"check": "W", "clause": "영 86조③1호", "title": "채광창 → 인접 대지경계선",
                                     "subject": f"{bid}동 {ei + 1}번 벽면", "buildings": [bid], "edge": ei,
                                     "height_m": round(H[bid], 2), "required_m": round(req, 2), **worst,
                                     "ok": worst["actual_m"] + 1e-6 >= req, "margin_m": round(worst["actual_m"] - req, 2),
                                     "basis": f"높이 {H[bid]:.1f} m ≤ 거리 × {mult:g} → {req:.2f} m 이상"})

    # ---- D: 동간 이격 (영 86조③2호)
    # pairs relaxed by 나목: higher building's main openings face the lower one, lower lies E..S..W of the higher
    relaxed: set[tuple[str, str]] = set()
    for hb, r in rings.items():
        p0, p1, n, L = edges_of(r)[mainface[hb]]
        if L == 0 or roles[hb][mainface[hb]] != WINDOW:
            continue
        for o in _samples(p0, p1, L):
            best = None
            for lb, pl in polys.items():
                if lb == hb:
                    continue
                hit = _first_hit(o + n * 1e-3, n, pl.exterior)
                if hit and (best is None or hit[0] < best[0]):
                    best = (hit[0], lb)
            if best:
                lb = best[1]
                brg = _bearing(polys[hb].centroid.coords[0], polys[lb].centroid.coords[0])
                if H[lb] < H[hb] - 1e-6 and 90.0 <= brg <= 270.0:
                    relaxed.add(tuple(sorted((hb, lb))))
    pair_worst: dict[tuple, dict] = {}
    for bi, r in rings.items():
        for ei, (p0, p1, n, L) in enumerate(edges_of(r)):
            if L == 0:
                continue
            ti = roles[bi][ei]
            for o in _samples(p0, p1, L):
                best = None
                for bj, pj in polys.items():
                    hit = _first_hit(o + n * 1e-3, n, pj.exterior)
                    if hit is None:
                        continue
                    if bj == bi:
                        ej = _edge_index_near(r, hit[1])
                        if ej in (ei, (ei - 1) % len(r), (ei + 1) % len(r)):
                            continue
                    if best is None or hit[0] < best[0]:
                        best = (hit[0], hit[1], bj)
                if best is None:
                    continue
                d, q, bj = best
                tj = roles[bj][_edge_index_near(rings[bj], q)]
                pair = tuple(sorted((bi, bj)))
                if bi in facilities or bj in facilities:
                    fac = bi if bi in facilities else bj
                    if WINDOW not in (ti, tj):
                        continue
                    req, rule = H[fac], "다목: 부대·복리시설 높이 × 1"
                elif WINDOW in (ti, tj):
                    if ti != WINDOW:
                        continue  # measured perpendicular to the window wall: the other side's rays cover it
                    if pair in relaxed:
                        lo = min(H[bi], H[bj])
                        req, rule = max(10.0, k * lo), f"나목: max(10 m, 낮은 동 높이 {lo:.1f} m × {k:g})"
                    else:
                        hi = max(H[bi], H[bj])
                        req, rule = k * hi, f"가목: 높은 동 높이 {hi:.1f} m × {k:g}"
                elif ti == SIDE and tj == SIDE:
                    req, rule = 4.0, "마목: 측벽 ↔ 측벽 4 m"
                else:
                    req, rule = 8.0, "라목: 창 없는 벽면 ↔ 측벽 8 m"
                key = pair + (rule.split(":")[0],)
                margin = d - req
                cur = pair_worst.get(key)
                if cur is None or margin < cur["margin_m"]:
                    pair_worst[key] = {"check": "D", "clause": "영 86조③2호 " + rule.split(":")[0], "title": "동간 이격",
                                       "subject": f"{bi}동 {FACADE_LABEL[ti]} ↔ {bj}동 {FACADE_LABEL[tj]}" if bi != bj else f"{bi}동 내부 마주봄",
                                       "buildings": sorted({bi, bj}), "pair": "|".join(pair), "required_m": round(req, 2),
                                       "actual_m": round(d, 2), "margin_m": round(margin, 2), "ok": margin >= -1e-6,
                                       "from": [round(float(o[0]), 2), round(float(o[1]), 2)], "to": [round(float(q[0]), 2), round(float(q[1]), 2)],
                                       "basis": rule}
    findings.extend(sorted(pair_worst.values(), key=lambda f: f["margin_m"]))
    for f in findings:
        f["z"] = z_ref
    return {
        "params": P,
        "coefficient_k": k,
        "coefficient_source": ("사용자 지정(지구단위계획 등)" if P["k_override"] else PRESETS[P["preset"]]["source"]) + f" · {PROJECT_TYPES[P['project_type']]}",
        "north_rule": north_rule_text(ref),
        "window_multiplier": mult,
        "facade_roles": {bid: {"roles": roles[bid], "main": mainface[bid]} for bid in rings},
        "relaxed_pairs": sorted("|".join(p) for p in relaxed),
        "findings": findings,
        "n_fail": sum(not f["ok"] for f in findings),
        "notes": notes + ["옥탑·계단실 등 높이 산입 제외 부분, 대지 높이차(영 119조), 발코니 등 돌출부는 반영하지 않음",
                          "가목은 마주보는 두 동 중 높은 동의 높이로 계산(보수적 해석)"],
    }


def compare_layouts(a: dict, b: dict) -> dict:
    """New violations in B that are not violations in A (same check + subject)."""
    key = lambda f: (f["check"], f["subject"], f.get("basis", "").split(":")[0])  # noqa: E731
    fa = {key(f): f for f in a["findings"]}
    out = []
    for f in b["findings"]:
        if f["ok"]:
            continue
        prev = fa.get(key(f))
        out.append({**f, "status": "EXISTING" if prev is not None and not prev["ok"] else "NEW",
                    "actual_a_m": prev["actual_m"] if prev else None})
    return {"violations_b": out, "n_new": sum(v["status"] == "NEW" for v in out), "n_existing": sum(v["status"] == "EXISTING" for v in out),
            "n_fail_a": a["n_fail"], "n_fail_b": b["n_fail"]}


def check_run(sm: dict, site: dict, params: dict | None) -> dict:
    sc = sm["scenarios"]
    pad_z = (sm.get("ground") or {}).get("pad_z", 0.0)
    boundary = site.get("site_boundary")
    a = check_layout(sc["A"]["buildings"], boundary, params, pad_z)
    b = check_layout(sc["B"]["buildings"], boundary, params, pad_z)
    return {"A": a, "B": b, "compare": compare_layouts(a, b), "boundary": boundary, "boundary_class": site.get("site_boundary_class")}
