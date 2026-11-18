"""Statutory distance checks on hand-checkable layouts (values from docs/law/LAW_TEXTS.md)."""
from app.legal import check_layout, compare_layouts, north_required
from datetime import date


def slab(bid, x0, y0, w=40.0, d=12.0, h=30.0, kind="MAIN"):
    return {"id": bid, "kind": kind, "height_m": h, "floors": int(h // 2.9),
            "footprint": [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d], [x0, y0 + d], [x0, y0]]}


SITE = [[-100, -100], [100, -100], [100, 100], [-100, 100]]


def find(res, check, contains=""):
    return [f for f in res["findings"] if f["check"] == check and contains in f["subject"]]


def test_north_rule_by_reference_date():
    assert north_required(9.0, date(2026, 11, 18)) == 1.5
    assert north_required(15.0, date(2026, 11, 18)) == 7.5
    assert north_required(15.0, date(2027, 2, 12)) == 5.0
    assert north_required(30.0, date(2027, 2, 12)) == 15.0


def test_north_setback_pass_fail():
    b = slab("101", -20, 100 - 12 - 10, h=30)  # 10 m from north boundary, needs 15 m
    r = check_layout([b], SITE, {"ref_date": "2026-11-18"})
    n = find(r, "N")[0]
    assert abs(n["actual_m"] - 10) < 1e-6 and n["required_m"] == 15 and not n["ok"]
    # a 20 m road beyond the north boundary: 공동주택은 도로 중심선 -> +10 m
    r = check_layout([b], SITE, {"boundary_beyond_m": {"2": 20}})
    assert find(r, "N")[0]["ok"]
    # not in a residential zone -> not checked
    r = check_layout([b], SITE, {"zoning": "SEMI_RES"})
    assert not find(r, "N")


def test_window_wall_to_boundary():
    b = slab("101", -20, -100 + 10, h=30)  # south window wall 10 m from boundary, H 30 -> needs 15 m
    w = find(check_layout([b], SITE, None), "W")
    south = min(w, key=lambda f: f["actual_m"])
    assert abs(south["actual_m"] - 10) < 1e-6 and south["required_m"] == 15 and not south["ok"]


def test_facing_slabs_incheon_and_relaxation():
    north = slab("101", -20, 30, h=30)
    south = slab("102", -20, 30 - 25 - 12, h=30)  # 25 m gap
    r = check_layout([north, south], SITE, {"preset": "INCHEON"})
    d = find(r, "D")[0]
    assert d["required_m"] == 30 and abs(d["actual_m"] - 25) < 1e-6 and not d["ok"] and "가목" in d["basis"]
    # statutory minimum 0.5 -> 15 m: pass
    assert all(f["ok"] for f in find(check_layout([north, south], SITE, {"preset": "STATUTORY"}), "D"))
    # lower building to the south of the higher one whose main openings face it -> 나목: max(10, 1 x 20) = 20
    south_low = slab("102", -20, 30 - 25 - 12, h=20)
    r = check_layout([north, south_low], SITE, {"preset": "INCHEON"})
    d = find(r, "D")[0]
    assert "나목" in d["basis"] and d["required_m"] == 20 and d["ok"]
    assert r["relaxed_pairs"] == ["101|102"]


def test_side_walls():
    a = slab("101", -45, 0, h=30)
    b = slab("102", -2, 0, h=30)  # 3 m between short (side) walls
    d = find(check_layout([a, b], SITE, None), "D")[0]
    assert d["required_m"] == 4 and abs(d["actual_m"] - 3) < 1e-6 and not d["ok"] and "마목" in d["basis"]


def test_compare_new_vs_existing():
    a1, a2 = slab("101", -45, 0), slab("102", 0, 0)    # 5 m side gap: ok
    b2 = slab("102", -2, 0)                            # moved: 3 m -> new violation
    ra, rb = check_layout([a1, a2], SITE, None), check_layout([a1, b2], SITE, None)
    c = compare_layouts(ra, rb)
    assert c["n_new"] == 1 and c["violations_b"][0]["status"] == "NEW" and c["violations_b"][0]["actual_a_m"] == 5.0
