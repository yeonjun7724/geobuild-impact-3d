"""Review verdict for the LH design-change reviewer.

Turns the computed A/B/C results into the answer the reviewer has to give: "can this design-change request be
accepted as is?" Every item names the reference line it is checked against. None of the reference lines is a
legal judgement: the sunlight line is the winter-solstice line commonly cited in Korean sunlight disputes
(continuous 2 h within 09-15 or total 4 h within 08-16), applied here to facade proxy points, not to dwellings.
"""
from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path

import numpy as np

SUN_CONT_WINDOW = ("09:00", "15:00")
SUN_CONT_MIN = 120.0
SUN_TOTAL_WINDOW = ("08:00", "16:00")
SUN_TOTAL_MIN = 240.0
OPEN_SPACE_SHADE_MIN = 10.0
CLEARANCE_LOSS_M = 5.0

LEVELS = {"red": "보완 요청", "amber": "확인 필요", "green": "특이사항 없음"}


def _hm(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _mask(times_local: list[str], window: tuple[str, str]) -> np.ndarray:
    lo, hi = _hm(window[0]), _hm(window[1])
    mins = [datetime.fromisoformat(t).hour * 60 + datetime.fromisoformat(t).minute + datetime.fromisoformat(t).second / 60 for t in times_local]
    return np.array([lo <= m < hi for m in mins], dtype=bool)


def _max_run(s: np.ndarray) -> np.ndarray:
    best = np.zeros(len(s), dtype=np.int32)
    run = np.zeros(len(s), dtype=np.int32)
    for t in range(s.shape[1]):
        run = (run + 1) * s[:, t]
        best = np.maximum(best, run)
    return best


def sun_reference(sm: dict, result_dir: Path) -> dict | None:
    """Per receiver: does it meet the reference line in A and in B? Receivers that met it in A and miss it in B are
    the ones the change takes below the line."""
    npz = result_dir / "sunlight_timeseries.npz"
    if "A" not in sm or not npz.exists():
        return None
    times = sm["sun"]["times_local"]
    dt = float(sm["params"]["interval_min"])
    z = np.load(npz)
    ids_a, ids_b = [str(x) for x in z["ids_a"]], [str(x) for x in z["ids_b"]]
    ib = {r: i for i, r in enumerate(ids_b)}
    common = [r for r in ids_a if r in ib]
    xa = np.array([i for i, r in enumerate(ids_a) if r in ib], dtype=np.int64)
    xb = np.array([ib[r] for r in common], dtype=np.int64)
    m_cont, m_tot = _mask(times, SUN_CONT_WINDOW), _mask(times, SUN_TOTAL_WINDOW)
    t0, t1 = min(times)[11:16], max(times)[11:16]
    covers = _hm(t0) <= _hm(SUN_TOTAL_WINDOW[0]) + dt and _hm(t1) >= _hm(SUN_TOTAL_WINDOW[1]) - dt

    def meets(sun: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        cont = _max_run(sun[:, m_cont].astype(np.int8)) * dt
        tot = sun[:, m_tot].sum(axis=1) * dt
        return (cont >= SUN_CONT_MIN) | (tot >= SUN_TOTAL_MIN), cont, tot

    ok_a, cont_a, tot_a = meets(z["sun_a"][xa])
    ok_b, cont_b, tot_b = meets(z["sun_b"][xb])
    newly = ok_a & ~ok_b
    meta = {}
    p = result_dir / "sunlight_receivers.csv"
    if p.exists():
        with p.open(encoding="utf-8-sig") as f:
            meta = {r["receiver_id"]: r for r in csv.DictReader(f)}
    changed = set(sm.get("changed_buildings", []))
    groups: dict[str, dict] = {}
    for k in np.nonzero(newly)[0]:
        rid = common[k]
        r = meta.get(rid, {})
        bid = r.get("building_id") or rid.split("-")[0]
        g = groups.setdefault(bid, {"building_id": bid, "changed_in_b": bid in changed, "n": 0, "floors": set(), "facades": set(),
                                    "causes": {}, "receivers": []})
        g["n"] += 1
        if r.get("floor"):
            g["floors"].add(int(r["floor"]))
        if r.get("facade"):
            g["facades"].add(r["facade"])
        c = r.get("main_cause_b")
        if c:
            g["causes"][c] = g["causes"].get(c, 0) + 1
        if len(g["receivers"]) < 50:
            g["receivers"].append({"receiver_id": rid, "cont_a": float(cont_a[k]), "cont_b": float(cont_b[k]),
                                   "total_a": float(tot_a[k]), "total_b": float(tot_b[k])})
    out_groups = [{**g, "floors": [min(g["floors"]), max(g["floors"])] if g["floors"] else None, "facades": sorted(g["facades"]),
                   "causes": dict(sorted(g["causes"].items(), key=lambda kv: -kv[1]))} for g in groups.values()]
    out_groups.sort(key=lambda g: -g["n"])
    return {
        "rule": f"동지 {SUN_CONT_WINDOW[0]}~{SUN_CONT_WINDOW[1]} 연속 {SUN_CONT_MIN / 60:.0f}시간 이상 또는 "
                f"{SUN_TOTAL_WINDOW[0]}~{SUN_TOTAL_WINDOW[1]} 총 {SUN_TOTAL_MIN / 60:.0f}시간 이상",
        "applicable": bool(covers),
        "analysis_date": sm["params"].get("date"),
        "n_common": len(common),
        "n_meet_a": int(ok_a.sum()),
        "n_meet_b": int(ok_b.sum()),
        "n_newly_below": int(newly.sum()),
        "n_newly_above": int((~ok_a & ok_b).sum()),
        "n_newly_below_unchanged_buildings": int(sum(g["n"] for g in out_groups if not g["changed_in_b"])),
        "groups": out_groups,
    }


def _dir(v: float, pos: str, neg: str) -> str:
    return f"{pos if v > 0 else neg} {abs(v):g} m"


def design_changes(sm: dict) -> list[dict]:
    """What the B scenario changes relative to A, per building, in words."""
    sc = sm.get("scenarios", {})
    ta, tb = sc.get("A", {}).get("transforms", {}) or {}, sc.get("B", {}).get("transforms", {}) or {}
    fa = {b["id"]: b for b in sc.get("A", {}).get("buildings", [])}
    fb = {b["id"]: b for b in sc.get("B", {}).get("buildings", [])}
    out = []
    for bid in sorted(set(ta) | set(tb)):
        a, b = ta.get(bid, {}), tb.get(bid, {})
        d = {k: float(b.get(k) or 0) - float(a.get(k) or 0) for k in ("dx", "dy", "rot_deg", "floors_delta")}
        if not any(abs(v) > 1e-9 for v in d.values()):
            continue
        parts = []
        mv = [s for s, v in ((_dir(d["dx"], "동쪽", "서쪽"), d["dx"]), (_dir(d["dy"], "북쪽", "남쪽"), d["dy"])) if abs(v) > 1e-9]
        if mv:
            parts.append("·".join(mv) + " 이동")
        if abs(d["rot_deg"]) > 1e-9:
            parts.append(f"{abs(d['rot_deg']):g}° {'반시계' if d['rot_deg'] > 0 else '시계'} 방향 회전")
        if abs(d["floors_delta"]) > 1e-9:
            f0, f1 = fa.get(bid, {}).get("floors"), fb.get(bid, {}).get("floors")
            rng = f" ({f0}→{f1}층)" if f0 and f1 else ""
            parts.append(f"{abs(d['floors_delta']):g}개 층 {'증층' if d['floors_delta'] > 0 else '감층'}{rng}")
        out.append({"building_id": bid, "text": f"{bid}동: " + ", ".join(parts), **d})
    return out


def _legal_item(legal: dict) -> dict:
    if not legal or legal.get("error"):
        return {"key": "L", "level": "amber", "title": "법정 이격·일조 사선", "headline": "법정 검토를 계산하지 못했습니다",
                "detail": (legal or {}).get("error", ""), "tab": "L"}
    c, b = legal["compare"], legal["B"]
    ref = f"{b['north_rule']} · 동간 계수 {b['coefficient_k']:g} ({b['coefficient_source']})"
    viol = c["violations_b"]
    if not viol:
        n = len(b["findings"])
        return {"key": "L", "level": "green", "title": "법정 이격·일조 사선", "headline": f"검토한 {n}개 항목 모두 기준 충족",
                "detail": " · ".join(b["notes"][:1]) or "-", "reference": ref, "tab": "L"}
    new = [v for v in viol if v["status"] == "NEW"]
    top = (new or viol)[:3]
    det = "; ".join(f"{v['subject']} {v['title']} {v['actual_m']:.1f} m < 기준 {v['required_m']:.1f} m ({v['clause']})" for v in top)
    if new:
        return {"key": "L", "level": "red", "title": "법정 이격·일조 사선",
                "headline": f"변경안에서 새로 기준에 미달하는 항목 {len(new)}건" + (f" (기존안부터 미달 {c['n_existing']}건 별도)" if c["n_existing"] else ""),
                "detail": det + ".", "reference": ref, "tab": "L"}
    return {"key": "L", "level": "amber", "title": "법정 이격·일조 사선",
            "headline": f"기존안부터 미달이던 항목 {len(viol)}건이 변경안에도 남아 있음",
            "detail": det + ". 기존 승인 경위(완화 심의 등)를 확인하세요.", "reference": ref, "tab": "L"}


def _dwelling_item(u: dict) -> dict:
    def where(gs, key):
        parts = []
        for g in gs:
            hos = g["newly_below"]
            if not hos:
                continue
            fl = sorted({int(h[:-2]) for h in hos})
            parts.append(f"{g['building_id']}동 {len(hos)}세대 ({fl[0]}~{fl[-1]}층)" + ("" if g["changed_in_b"] else " · 변경 안 한 동"))
        return "; ".join(parts[:5])
    n_new = u["n_newly_below"] + u["n_only_b_below"]
    if n_new:
        det = where(u["by_building"], "newly_below")
        other = u["n_newly_below_unchanged_buildings"]
        tail = []
        if u["n_only_b_below"]:
            tail.append(f"증층 등으로 새로 생긴 세대 중 미달 {u['n_only_b_below']}세대 포함")
        if other:
            tail.append(f"변경하지 않은 동의 피해 {other}세대")
        if u["n_still_below"]:
            tail.append(f"기존안부터 미달 {u['n_still_below']}세대는 별도")
        return {"key": "A", "level": "red", "title": "세대별 일조 (동·호)",
                "headline": f"변경 후 일조 기준에 새로 미달하는 세대 {n_new}세대 (전체 {u['n_b']}세대 중)",
                "detail": det + (". " + ", ".join(tail) + "." if tail else "."), "reference": u["rule"] + " · " + u["receiver"], "tab": "A"}
    return {"key": "A", "level": "green" if not u["n_still_below"] else "amber", "title": "세대별 일조 (동·호)",
            "headline": "일조 기준에 새로 미달하는 세대 없음",
            "detail": f"변경안 {u['n_b']}세대 중 {u['n_meet_b']}세대 기준 충족" + (f", 기존안부터 미달 {u['n_still_below']}세대" if u["n_still_below"] else "") + ".",
            "reference": u["rule"] + " · " + u["receiver"], "tab": "A"}


def build_review(sm: dict, result_dir: Path, legal: dict | None = None) -> dict:
    items: list[dict] = []
    if legal is not None:
        items.append(_legal_item(legal))
    ref = None
    if "U" in sm:
        items.append(_dwelling_item(sm["U"]))
        if legal and not legal.get("error"):
            d_viol = [v for v in legal["compare"]["violations_b"] if v["check"] == "D"]
            if d_viol and sm["U"]["all_b_continuous_2h"] and items and items[0]["key"] == "L":
                items[0]["detail"] += (" 단, 변경안의 모든 세대가 동지 09~15시 연속 2시간 이상 일조를 확보하므로 "
                                       "영 86조③2호 단서(동간 거리 완화) 적용 여부를 검토할 수 있습니다.")
    try:
        ref = None if "U" in sm else sun_reference(sm, result_dir)
    except Exception as exc:  # noqa: BLE001 - the verdict must not break results; the error is shown instead
        items.append({"key": "A", "level": "amber", "title": "세대 일조", "headline": "일조 기준선 계산 실패", "detail": str(exc)[:160], "tab": "A"})
    if ref:
        n = ref["n_newly_below"]
        where = "; ".join(
            f"{g['building_id']}동{(' ' + str(g['floors'][0]) + '~' + str(g['floors'][1]) + '층') if g['floors'] else ''} "
            f"{'/'.join(g['facades'])}면 {g['n']}곳" + (f" (주 원인 {next(iter(g['causes']))}동)" if g["causes"] else "")
            for g in ref["groups"][:4])
        if n:
            other = ref["n_newly_below_unchanged_buildings"]
            items.append({"key": "A", "level": "red", "title": "세대 일조",
                          "headline": f"변경 후 일조 기준선 미달로 떨어지는 외벽 지점 {n:,}곳",
                          "detail": where + (f". 이 중 {other:,}곳은 변경하지 않은 동(타 동 피해)입니다." if other else "."),
                          "reference": ref["rule"], "tab": "A"})
        else:
            a = sm["A"]
            items.append({"key": "A", "level": "green", "title": "세대 일조", "headline": "기준선 아래로 새로 떨어지는 외벽 지점 없음",
                          "detail": f"일조시간이 줄어든 지점은 {a['n_decreased']:,}곳이지만 모두 기준선을 계속 충족합니다.",
                          "reference": ref["rule"], "tab": "A"})
        if not ref["applicable"]:
            items[-1]["detail"] += " 분석 시간대가 08~16시를 덮지 않아 기준선 비교가 불완전합니다."
    if "NB" in sm:
        nb = sm["NB"]
        hit = [g for g in nb["buildings"] if g["n_newly_below"]]
        if hit:
            det = "; ".join(f"{g['name']}({g['building_id']}) {g['n_newly_below']}개 지점" + (f" {g['floors'][0]}~{g['floors'][1]}층" if g["floors"] else "")
                            + (f", 원인 {next(iter(g['causes']))}동" if g["causes"] else "") + ("" if g["use_known"] else " · 용도 미상") for g in hit[:4])
            items.append({"key": "NB", "level": "red", "title": "주변 기존 건물 일조",
                          "headline": f"주변 건물 {len(hit)}동에서 일조 기준에 새로 미달하는 외벽 지점 {nb['n_points_newly_below']}곳",
                          "detail": det + ". 민원·분쟁 가능성이 있으므로 세대 위치를 확인해 정밀 검토하세요.", "reference": nb["rule"] + " · " + nb["receiver"], "tab": "A"})
        else:
            items.append({"key": "NB", "level": "green", "title": "주변 기존 건물 일조", "headline": f"검토한 주변 건물 {nb['n_buildings']}동에서 새로 미달하는 지점 없음",
                          "detail": f"외벽 {nb['n_points']}개 지점 검토.", "reference": nb["rule"] + " · " + nb["receiver"], "tab": "A"})
    if "B" in sm:
        hit = [o for o in sm["B"].get("open_spaces", []) if o.get("n_cells") and o.get("mean_delta_min", 0) >= OPEN_SPACE_SHADE_MIN]
        if hit:
            items.append({"key": "B", "level": "amber", "title": "놀이터·휴게공간 그늘",
                          "headline": ", ".join(f"{o['name']} 그늘 +{o['mean_delta_min']:.0f}분" for o in hit),
                          "detail": "평균 누적 음영시간 증가. 이용 시간대(오후)에 그늘이 늘어나는지 확인이 필요합니다.",
                          "reference": f"평균 +{OPEN_SPACE_SHADE_MIN:.0f}분 이상 증가", "tab": "B"})
        else:
            items.append({"key": "B", "level": "green", "title": "놀이터·휴게공간 그늘", "headline": "그늘 증가 폭이 작음",
                          "detail": "; ".join(f"{o['name']} {o['mean_delta_min']:+.0f}분" for o in sm["B"].get("open_spaces", []) if o.get("n_cells")) or "-",
                          "reference": f"평균 +{OPEN_SPACE_SHADE_MIN:.0f}분 이상 증가", "tab": "B"})
    if "C" in sm and sm["C"].get("min_pair_b"):
        c = sm["C"]
        bad = [r for r in c.get("worsened_top", []) if r["delta_m"] <= -CLEARANCE_LOSS_M]
        mp = f"최소 동간거리 {c['min_pair_a']['distance_m']:.1f} → {c['min_pair_b']['distance_m']:.1f} m"
        if c.get("n_contact_or_overlap_b"):
            items.append({"key": "C", "level": "red", "title": "동간 거리", "headline": f"건물이 맞닿거나 겹치는 쌍 {c['n_contact_or_overlap_b']}개",
                          "detail": mp + ". 형상 충돌입니다.", "reference": "접촉·중첩 0쌍", "tab": "C"})
        elif bad:
            items.append({"key": "C", "level": "amber", "title": "동간 거리",
                          "headline": ", ".join(f"{r['pair_id'].replace('|', '↔')} {r['distance_a_m']:.1f}→{r['distance_b_m']:.1f} m" for r in bad[:3]),
                          "detail": mp + ". 법정 이격 충족 여부는 별도 확인이 필요합니다.",
                          "reference": f"{CLEARANCE_LOSS_M:.0f} m 이상 감소", "tab": "C"})
        else:
            items.append({"key": "C", "level": "green", "title": "동간 거리", "headline": mp,
                          "detail": "5 m 이상 좁아진 동 쌍이 없습니다.", "reference": f"{CLEARANCE_LOSS_M:.0f} m 이상 감소", "tab": "C"})
    worst = "red" if any(i["level"] == "red" for i in items) else "amber" if any(i["level"] == "amber" for i in items) else "green"
    verdict = {
        "red": "보완 요청 권고: 이 변경안을 그대로 승인하기 어렵습니다",
        "amber": "조건부: 표시된 항목을 확인한 뒤 승인 여부를 판단하세요",
        "green": "특이사항 없음: 검토한 항목에서 두드러진 악화가 없습니다",
    }[worst]
    return {"level": worst, "verdict": verdict, "items": items, "changes": design_changes(sm), "sun_reference": ref,
            "caveat": "법정 항목은 입력된 배치·높이·대지경계로 계산한 1차 검토 결과이며, 옥탑·대지 높이차·돌출부 등은 반영하지 않습니다. "
                      "일조·그늘·동간거리 변화 항목의 기준선은 검토 우선순위용 참고선입니다."}
