"""Dwelling receivers: 호 numbering (left->right seen from outside), heights, reference rule."""
from types import SimpleNamespace

import numpy as np
from shapely.geometry import Polygon

from app.analysis.dwellings import make_dwellings, reference


def bld(units=None, floors=3):
    fp = Polygon([(0, 0), (40, 0), (40, 12), (0, 12)])  # long walls face south / north
    return SimpleNamespace(id="105", footprint=fp, floors=floors, base_z=10.0, units_per_floor=units)


def test_numbering_and_positions():
    d = make_dwellings(bld(units=4))
    assert len(d) == 12 and d[0].receiver_id == "105-101" and d[-1].receiver_id == "105-304"
    f1 = [r for r in d if r.floor == 1]
    xs = [r.position[0] for r in f1]
    assert xs == sorted(xs) and abs(xs[0] - 5) < 1e-9  # 1호 = west end of the south wall
    assert all(abs(r.position[1]) < 1e-9 and r.normal[1] == -1.0 for r in f1)
    assert abs(d[-1].position[2] - (10 + 2 * 2.9 + 1.5)) < 1e-9


def test_unit_guess_from_wall_length():
    assert len([r for r in make_dwellings(bld()) if r.floor == 1]) == 4  # 40 m / ~10 m


def test_reference_rule():
    times = [f"2026-12-22T{(480 + 5 * i + 2) // 60:02d}:{(480 + 5 * i + 2) % 60:02d}:30+09:00" for i in range(96)]
    s = np.zeros((3, 96), bool)
    s[0, 24:48] = True                      # 10:00-12:00 continuous 2 h -> ok
    s[1, 0:12] = True; s[1, 84:96] = True   # 08-09 + 15-16 = 2 h, not inside 09-15 -> below
    s[2, ::2] = True                        # alternating: 4 h total, never 2 h continuous -> ok by total
    ok, cont, tot, c2 = reference(s, times, 5.0)
    assert ok.tolist() == [True, False, True] and c2.tolist() == [True, False, False]
    assert tot.tolist() == [120.0, 120.0, 240.0]
