"""Layout drawings (DXF / PDF) -> building footprints + site boundary in project ENU metres.

DXF: closed polylines (and outlines polygonised from lines) on user-chosen layers become footprints; texts inside a
footprint give its 동 number ("101동") and floor count ("25층", "25F", "지상25층"). PDF/images are rendered to PNG and
traced in the browser; both end up as rings in drawing coordinates that are placed on the site either through a
projected CRS (e.g. EPSG:5186) or through two control points (similarity transform).
"""
from __future__ import annotations

import math
import re
from collections import Counter
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polygonize, unary_union

INSUNITS_M = {0: None, 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1.0, 14: 0.1}
RE_DONG = re.compile(r"(\d{2,4})\s*동")
RE_FLOORS = [re.compile(r"지상\s*(\d{1,3})\s*층"), re.compile(r"(\d{1,3})\s*층"), re.compile(r"(\d{1,3})\s*F\b", re.I)]
BLDG_HINT = re.compile(r"(동|BLDG|BUILD|건물|외곽|주동|APT|아파트|A-?WALL|OUTLINE)", re.I)
SITE_HINT = re.compile(r"(대지|경계|SITE|BOUND|부지|단지)", re.I)
MIN_AREA_M2 = 30.0


class CadError(ValueError):
    pass


def _read(path: Path):
    import ezdxf
    from ezdxf import recover
    try:
        return ezdxf.readfile(str(path))
    except Exception:  # noqa: BLE001 - damaged files: try recovery mode before giving up
        try:
            doc, _ = recover.readfile(str(path))
            return doc
        except Exception as exc:  # noqa: BLE001
            raise CadError(f"DXF를 읽을 수 없음: {exc}. DWG는 CAD에서 DXF(2013 이하)로 저장해 올려 주세요.") from exc


def _entities(doc):
    from ezdxf.disassemble import recursive_decompose
    return recursive_decompose(doc.modelspace())  # INSERT blocks exploded with their transforms


def _poly_points(e):
    t = e.dxftype()
    if t == "LWPOLYLINE":
        return [(p[0], p[1]) for p in e.get_points("xy")], bool(e.closed)
    if t == "POLYLINE" and not e.is_3d_polyline and not e.is_poly_face_mesh and not e.is_polygon_mesh:
        return [(v.dxf.location[0], v.dxf.location[1]) for v in e.vertices], bool(e.is_closed)
    if t == "LINE":
        return [(e.dxf.start[0], e.dxf.start[1]), (e.dxf.end[0], e.dxf.end[1])], False
    return None, False


def _text(e):
    t = e.dxftype()
    if t == "TEXT":
        return e.dxf.text, (e.dxf.insert[0], e.dxf.insert[1])
    if t == "MTEXT":
        return e.plain_text(), (e.dxf.insert[0], e.dxf.insert[1])
    if t == "ATTRIB":
        return e.dxf.text, (e.dxf.insert[0], e.dxf.insert[1])
    return None, None


def inspect(path: Path) -> dict:
    doc = _read(path)
    stats: dict[str, Counter] = {}
    xs, ys = [], []
    for e in _entities(doc):
        layer = e.dxf.layer
        c = stats.setdefault(layer, Counter())
        pts, closed = _poly_points(e)
        if pts:
            c["closed" if closed and len(pts) >= 3 else "lines"] += 1
            for x, y in pts[:4]:
                xs.append(x)
                ys.append(y)
        else:
            txt, _ = _text(e)
            if txt:
                c["texts"] += 1
    if not stats:
        raise CadError("모델 공간에 도형이 없음")
    ins = int(doc.header.get("$INSUNITS", 0) or 0)
    unit = INSUNITS_M.get(ins)
    span = max(np.ptp(xs), np.ptp(ys)) if xs else 0
    guess = unit if unit else (0.001 if span > 20000 else 1.0)  # a site drawing spanning >20 km in "m" is almost surely mm
    layers = [{"name": k, "closed": v["closed"], "lines": v["lines"], "texts": v["texts"],
               "hint": "BUILDING" if BLDG_HINT.search(k) else "SITE" if SITE_HINT.search(k) else None} for k, v in stats.items()]
    layers.sort(key=lambda l: (-(l["hint"] is not None), -l["closed"], l["name"]))
    return {"layers": layers, "insunits": ins, "unit_m": unit, "unit_guess_m": guess,
            "bbox": [float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))] if xs else None,
            "encoding": doc.encoding, "dxfversion": doc.dxfversion}


def _attrs(poly: Polygon, texts: list[tuple[str, Point]]) -> dict:
    inside = [t for t, p in texts if poly.buffer(1e-6).contains(p)]
    dong = floors = None
    for t in inside:
        m = RE_DONG.search(t)
        if m and dong is None:
            dong = m.group(1)
        for rx in RE_FLOORS:
            m = rx.search(t)
            if m and floors is None:
                floors = int(m.group(1))
                break
    return {"dong": dong, "floors": floors, "texts": inside[:8]}


def extract(path: Path, building_layers: list[str], boundary_layer: str | None, unit_m: float, text_layers: list[str] | None = None) -> dict:
    doc = _read(path)
    bl, tl = set(building_layers), set(text_layers or []) | set(building_layers)
    closed: list[Polygon] = []
    loose: list[LineString] = []
    bnd: list[Polygon] = []
    bnd_lines: list[LineString] = []
    texts: list[tuple[str, Point]] = []
    for e in _entities(doc):
        layer = e.dxf.layer
        pts, is_closed = _poly_points(e)
        if pts and len(pts) >= 2:
            arr = np.asarray(pts, dtype=float) * unit_m
            if layer in bl:
                if is_closed and len(arr) >= 3:
                    closed.append(Polygon(arr))
                else:
                    loose.append(LineString(arr))
            if boundary_layer and layer == boundary_layer:
                if is_closed and len(arr) >= 3:
                    bnd.append(Polygon(arr))
                else:
                    bnd_lines.append(LineString(arr))
            continue
        txt, at = _text(e)
        if txt and (not text_layers or layer in tl):
            texts.append((txt.strip(), Point(at[0] * unit_m, at[1] * unit_m)))
    if loose:
        closed.extend(polygonize(unary_union(loose)))
    polys = []
    for p in closed:
        p = p.buffer(0)
        if p.geom_type == "MultiPolygon":
            p = max(p.geoms, key=lambda g: g.area)
        if p.is_empty or p.area < MIN_AREA_M2:
            continue
        polys.append(Polygon(p.exterior))
    # drop exact duplicates and polygons fully containing another (e.g. a hatch frame around a building)
    polys.sort(key=lambda p: p.area)
    keep: list[Polygon] = []
    for p in polys:
        if any(abs(p.area - k.area) < 0.5 and p.symmetric_difference(k).area < 0.5 for k in keep):
            continue
        keep.append(p)
    keep = [p for p in keep if not any(k is not p and p.contains(k) and k.area < 0.9 * p.area for k in keep)]
    if bnd_lines:
        bnd.extend(polygonize(unary_union(bnd_lines)))
    boundary = max(bnd, key=lambda p: p.area) if bnd else None
    out = []
    used: set[str] = set()
    for i, p in enumerate(sorted(keep, key=lambda p: (-p.centroid.y, p.centroid.x))):
        a = _attrs(p, texts)
        bid = a["dong"] if a["dong"] and a["dong"] not in used else None
        if bid:
            used.add(bid)
        ring = [[round(x, 3), round(y, 3)] for x, y in p.simplify(0.05).exterior.coords]
        out.append({"idx": i, "id": bid, "floors": a["floors"], "texts": a["texts"], "ring": ring, "area_m2": round(p.area, 1)})
    return {"buildings": out, "boundary": [[round(x, 3), round(y, 3)] for x, y in boundary.exterior.coords] if boundary is not None else None,
            "n_texts": len(texts), "unit_m": unit_m}


def render_pdf(path: Path, page: int, out_png: Path, max_px: int = 3000) -> dict:
    import pymupdf
    doc = pymupdf.open(str(path))
    if not (0 <= page < len(doc)):
        raise CadError(f"페이지 {page + 1} 없음 (총 {len(doc)}쪽)")
    pg = doc[page]
    zoom = max_px / max(pg.rect.width, pg.rect.height)
    pix = pg.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    pix.save(str(out_png))
    return {"width": pix.width, "height": pix.height, "pages": len(doc), "page": page}


# ------------------------------------------------------------------------------------------------ placement
def similarity_from_points(src: list[list[float]], dst: list[list[float]], allow_scale: bool) -> dict:
    """2-point similarity src -> dst (rotation, translation, optional uniform scale)."""
    (x1, y1), (x2, y2) = src
    (u1, v1), (u2, v2) = dst
    ds = complex(x2 - x1, y2 - y1)
    dd = complex(u2 - u1, v2 - v1)
    if abs(ds) < 1e-9 or abs(dd) < 1e-9:
        raise CadError("기준점 두 개가 같은 위치임")
    z = dd / ds
    scale_found = abs(z)
    if not allow_scale:
        z = z / abs(z)
    t = complex(u1, v1) - z * complex(x1, y1)
    return {"a": z.real, "b": z.imag, "tx": t.real, "ty": t.imag, "scale": abs(z), "scale_from_points": scale_found,
            "rotation_deg": math.degrees(math.atan2(z.imag, z.real))}


def apply_similarity(ring, T: dict) -> list[list[float]]:
    a, b, tx, ty = T["a"], T["b"], T["tx"], T["ty"]
    return [[round(a * x - b * y + tx, 3), round(b * x + a * y + ty, 3)] for x, y in ring]
