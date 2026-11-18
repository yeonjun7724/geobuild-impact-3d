"""Verification routines executed inside every analysis run (results go to quality_check.json & report §15)."""
from __future__ import annotations

import numpy as np

from ..geo.enu import LocalFrame
from ..scene.geometry import extrude
from .raycast import INVALID, NumpyEngine, Open3DEngine, make_engine, self_offset
from .solar import sun_vector
from shapely.geometry import box


def check(name: str, passed: bool, detail: dict | str, critical: bool = True) -> dict:
    return {"name": name, "status": "PASS" if passed else "FAIL", "critical": critical, "detail": detail}


def pole_shadow_length(height: float, elev_deg: float, az_deg: float, engine_pref: str = "open3d") -> dict:
    """Box 'pole' 1x1 m, height H on a flat plane. Measure the shadow tip along the anti-sun direction by
    ray casting and compare with the analytic L = H / tan(alpha) (+0.5 m half-width offset of the pole face)."""
    eng = make_engine(engine_pref)
    plane_v = np.array([[-500, -500, 0], [500, -500, 0], [500, 500, 0], [-500, 500, 0]], dtype=float)
    plane_t = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int32)
    eng.add_mesh("GROUND", plane_v, plane_t)
    v, t = extrude(box(-0.5, -0.5, 0.5, 0.5), 0.0, height)
    eng.add_mesh("POLE", v, t)
    s = sun_vector(az_deg, elev_deg)
    horiz = -s[:2] / np.linalg.norm(s[:2])  # shadow direction on the ground
    d = np.arange(0.0, 4 * height / np.tan(np.radians(elev_deg)) + 5, 0.01)
    pts = np.column_stack([horiz[0] * d, horiz[1] * d, np.full(len(d), 1e-3)])
    keep = np.hypot(pts[:, 0], pts[:, 1]) > 0.75  # outside the pole footprint
    pts, d = pts[keep], d[keep]
    _, lab = eng.first_hit(pts, np.tile(s, (len(pts), 1)))
    shaded = lab != INVALID
    measured = float(d[shaded].max()) if shaded.any() else 0.0
    # analytic: the shadow of the top edge of the face opposite the sun; along the axis through the centre the
    # far top corner/edge lies at distance r (0.5 .. 0.707 m) from the centre depending on azimuth
    ax = np.abs(horiz)
    r = 0.5 / max(ax.max(), 1e-9) if min(ax) < 1e-9 else min(0.5 / ax[0], 0.5 / ax[1])
    analytic = height / np.tan(np.radians(elev_deg)) + r
    # shadow direction check: shadow must point away from the sun azimuth
    shadow_az = (np.degrees(np.arctan2(horiz[0], horiz[1])) + 360) % 360
    return {"height_m": height, "sun_elevation_deg": round(elev_deg, 4), "sun_azimuth_deg": round(az_deg, 4),
            "analytic_tip_m": round(float(analytic), 3), "raycast_tip_m": round(measured, 3),
            "abs_error_m": round(abs(measured - analytic), 3), "shadow_azimuth_deg": round(float(shadow_az), 3),
            "engine": eng.name}


def roundtrip(frame: LocalFrame, rect) -> dict:
    xmin, ymin, xmax, ymax = rect
    pts = np.array([[xmin, ymin, 0], [xmax, ymin, 30], [xmax, ymax, 80], [xmin, ymax, 5], [0, 0, 0], [1200, -1200, 60]], dtype=float)
    lon, lat, h = frame.enu_to_geodetic(pts)
    back = frame.geodetic_to_enu(lon, lat, h)
    ecef = frame.enu_to_ecef(pts)
    back2 = frame.ecef_to_enu(ecef)
    return {"max_error_geodetic_roundtrip_m": float(np.abs(back - pts).max()),
            "max_error_ecef_roundtrip_m": float(np.abs(back2 - pts).max()),
            "n_points": len(pts)}


def engine_crosscheck(buildings_meshes: list[tuple[str, np.ndarray, np.ndarray]], origins: np.ndarray, dirs: np.ndarray) -> dict:
    """Open3D vs independent float64 Möller–Trumbore on the same building meshes."""
    o3 = Open3DEngine()
    nb = NumpyEngine()
    for lab, v, t in buildings_meshes:
        o3.add_mesh(lab, v, t)
        nb.add_mesh(lab, v, t)
    _, la = o3.first_hit(origins, dirs)
    _, lb = nb.first_hit(origins, dirs, chunk=64)
    hit_a = la != INVALID
    hit_b = lb != INVALID
    agree = hit_a == hit_b
    same_obj = (la == lb) | ~hit_a
    return {"n_rays": int(len(origins)), "hit_agreement_ratio": float(agree.mean()),
            "label_agreement_ratio": float((agree & same_obj).mean()), "n_disagree": int((~agree).sum()),
            "engines": [o3.name, nb.name]}


def self_hit_check(scene, sun, receivers, max_rays: int = 20000) -> dict:
    """Rays leaving a receiver must never hit their own wall within a few cm. Compare eps=0 vs managed eps."""
    if not receivers:
        return {"n_rays": 0}
    eps = self_offset(scene.extent_m)
    P = np.array([r.position for r in receivers])
    N = np.array([r.normal for r in receivers])
    bid = [r.building_id for r in receivers]
    t_idx = int(np.argmax(sun.elevation_deg))
    s = sun.vectors[t_idx]
    facing = (N @ s) > 1e-9
    sel = np.nonzero(facing)[0][:max_rays]
    labels = scene.engine.labels
    res = {}
    for name, e in (("eps_0", 0.0), ("eps_managed", eps)):
        t, lab = scene.engine.first_hit(P[sel] + N[sel] * e, np.tile(s, (len(sel), 1)))
        own = np.array([lab[k] != INVALID and labels[lab[k]] == bid[sel[k]] and t[k] < 0.5 for k in range(len(sel))])
        res[name] = int(own.sum())
    return {"n_rays": int(len(sel)), "offset_m": eps, "self_hits_eps0": res["eps_0"], "self_hits_managed": res["eps_managed"],
            "sun_time_index": t_idx}
