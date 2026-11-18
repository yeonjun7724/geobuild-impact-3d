"""Review verdict: sunlight reference line, design-change wording, overall level."""
import csv

import numpy as np

from app.review import build_review, design_changes, sun_reference


def _times(dt=5):
    # 08:00-16:00 midpoints, KST
    return [f"2026-12-22T{(8 * 60 + i * dt + dt // 2) // 60:02d}:{(8 * 60 + i * dt + dt // 2) % 60:02d}:30+09:00" for i in range(480 // dt)]


def _summary(times, **extra):
    sm = {"params": {"interval_min": 5, "date": "2026-12-22"}, "sun": {"times_local": times}, "changed_buildings": ["105"],
          "A": {"n_decreased": 1},
          "scenarios": {"A": {"transforms": {}, "buildings": [{"id": "105", "floors": 20}]},
                        "B": {"transforms": {"105": {"dx": 10, "dy": -8, "rot_deg": 0, "floors_delta": 5}},
                              "buildings": [{"id": "105", "floors": 25}]}}}
    sm.update(extra)
    return sm


def _write(tmp_path, sun_a, sun_b, ids):
    np.savez_compressed(tmp_path / "sunlight_timeseries.npz", ids_a=np.array(ids), ids_b=np.array(ids), sun_a=sun_a, sun_b=sun_b)
    with (tmp_path / "sunlight_receivers.csv").open("w", encoding="utf-8", newline="") as f:
        f.write("\ufeff")
        w = csv.DictWriter(f, fieldnames=["receiver_id", "building_id", "floor", "facade", "main_cause_b"])
        w.writeheader()
        for rid in ids:
            w.writerow({"receiver_id": rid, "building_id": rid.split("-")[0], "floor": 3, "facade": "S", "main_cause_b": "105"})


def test_reference_line_continuous_and_total(tmp_path):
    t = _times()
    T = len(t)
    idx = {s[11:16]: i for i, s in enumerate(t)}
    a = np.zeros((3, T), bool)
    b = np.zeros((3, T), bool)
    # r0: 3 h continuous 10-13 in A -> 1 h in B => drops below the line
    a[0, idx["10:02"]:idx["13:02"]] = True
    b[0, idx["10:02"]:idx["11:02"]] = True
    # r1: 2 h continuous only outside 09-15 (08-09 and 15-16) but total 2 h -> below in both
    a[1, :idx["09:02"]] = True
    a[1, idx["15:02"]:] = True
    b[1] = a[1]
    # r2: 4.5 h total in pieces of 1 h 30 -> meets via total in A and B
    for h in ("08:02", "11:02", "14:32"):
        a[2, idx[h]:idx[h] + 18] = True
    b[2] = a[2]
    _write(tmp_path, a, b, ["101-F03-S0-00", "102-F03-S0-00", "103-F03-S0-00"])
    ref = sun_reference(_summary(t), tmp_path)
    assert ref["applicable"]
    assert ref["n_meet_a"] == 2 and ref["n_meet_b"] == 1 and ref["n_newly_below"] == 1
    assert ref["groups"][0]["building_id"] == "101" and not ref["groups"][0]["changed_in_b"]
    assert ref["n_newly_below_unchanged_buildings"] == 1


def test_verdict_levels_and_change_text(tmp_path):
    t = _times()
    T = len(t)
    a = np.ones((1, T), bool)
    _write(tmp_path, a, a.copy(), ["101-F01-S0-00"])
    sm = _summary(t, C={"min_pair_a": {"distance_m": 30.0, "pair_id": "101|102"}, "min_pair_b": {"distance_m": 22.0, "pair_id": "101|102"},
                        "n_contact_or_overlap_b": 0, "worsened_top": [{"pair_id": "101|102", "distance_a_m": 30.0, "distance_b_m": 22.0, "delta_m": -8.0}]})
    rv = build_review(sm, tmp_path)
    lv = {i["key"]: i["level"] for i in rv["items"]}
    assert lv == {"A": "green", "C": "amber"} and rv["level"] == "amber"
    ch = design_changes(sm)
    assert ch[0]["text"] == "105동: 동쪽 10 m·남쪽 8 m 이동, 5개 층 증층 (20→25층)"
    sm["C"]["n_contact_or_overlap_b"] = 1
    assert build_review(sm, tmp_path)["level"] == "red"
