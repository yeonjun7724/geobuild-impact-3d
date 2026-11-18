"""Regional terrain (30 m DEM) + site design ground (virtual pad) handling.

Design rules
------------
* `RegionalTerrain` = a 30 m-class DEM raster (SYNTHETIC generated GeoTIFF or a USER_UPLOADED GeoTIFF).
  Both go through the *same* reader / QA / sampler so the pipeline is identical.
* `SiteDesignGround` = a flat virtual pad over the site (assumption, not survey data) blended into the
  regional terrain over a transition band. The blended height field is meshed ONCE; that single mesh
  is used both for ray casting and for Cesium visualisation.
* Interpolating 30 m DEM to a 10 m mesh / 2 m analysis grid does not improve accuracy. The native
  DEM spacing and the analysis spacings are recorded separately.
"""
from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin
from pyproj import Transformer

from .enu import LocalFrame, PROJECTED_CRS

SYNTHETIC = "SYNTHETIC"
USER_UPLOADED = "USER_UPLOADED"


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ----------------------------------------------------------------------------------------------
# Synthetic DEM (clearly labelled; NOT the real terrain of Incheon Gyeyang)
# ----------------------------------------------------------------------------------------------
def write_synthetic_dem(path: Path, frame: LocalFrame, half_extent_m: float = 1800.0, cell_m: float = 30.0) -> Path:
    """Generate a deterministic synthetic 30 m DEM GeoTIFF in EPSG:5179 around the frame origin."""
    to_5179 = Transformer.from_crs("EPSG:4326", PROJECTED_CRS, always_xy=True)
    cx, cy = to_5179.transform(frame.lon0, frame.lat0)
    x0 = math.floor((cx - half_extent_m) / cell_m) * cell_m
    y1 = math.ceil((cy + half_extent_m) / cell_m) * cell_m
    n = int(round(2 * half_extent_m / cell_m)) + 2
    xs = x0 + (np.arange(n) + 0.5) * cell_m
    ys = y1 - (np.arange(n) + 0.5) * cell_m
    X, Y = np.meshgrid(xs - cx, ys - cy)
    # gentle regional trend + one synthetic hill to the south-east + low-amplitude undulation
    z = (
        14.0
        + 0.004 * X
        - 0.003 * Y
        + 48.0 * np.exp(-(((X - 750.0) ** 2 + (Y + 950.0) ** 2) / (2 * 260.0**2)))
        + 1.6 * np.sin(X / 210.0) * np.cos(Y / 260.0)
    ).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=n,
        height=n,
        count=1,
        dtype="float32",
        crs=CRS.from_string(PROJECTED_CRS),
        transform=from_origin(x0, y1, cell_m, cell_m),
        nodata=-9999.0,
    ) as dst:
        dst.write(z, 1)
        dst.update_tags(
            DATA_CLASS=SYNTHETIC,
            DESCRIPTION="GeoBuild Impact 3D synthetic 30m DEM - NOT real terrain",
            VERTICAL_DATUM="SYNTHETIC_UNIFIED",
        )
    return path


# ----------------------------------------------------------------------------------------------
# DEM reading + QA
# ----------------------------------------------------------------------------------------------
@dataclass
class DemInfo:
    path: str
    data_class: str
    sha256: str
    crs: str | None
    crs_is_projected: bool | None
    cell_size_x: float | None
    cell_size_y: float | None
    width: int
    height: int
    nodata_value: float | None
    nodata_ratio: float
    elev_min: float | None
    elev_max: float | None
    slope_max_deg: float | None
    slope_p99_deg: float | None
    bounds: list[float]
    vertical_datum: str
    vertical_datum_status: str  # RESOLVED | UNRESOLVED | SYNTHETIC_UNIFIED
    surface_type: str  # DTM | DSM_POSSIBLE | UNKNOWN
    covers_region: bool | None = None
    coverage_ratio: float | None = None
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def inspect_dem(path: Path, data_class: str, declared_vertical_datum: str | None = None, name_hint: str = "") -> DemInfo:
    warnings: list[str] = []
    errors: list[str] = []
    sha = file_sha256(path)
    try:
        ds = rasterio.open(path)
    except Exception as exc:  # noqa: BLE001 - surfaced to user
        return DemInfo(str(path), data_class, sha, None, None, None, None, 0, 0, None, 1.0, None, None, None, None,
                       [], "UNKNOWN", "UNRESOLVED", "UNKNOWN", errors=[f"GeoTIFF를 열 수 없음: {exc}"])
    with ds:
        crs = ds.crs
        tags = ds.tags()
        resx, resy = abs(ds.transform.a), abs(ds.transform.e)
        decim = 1
        if ds.width * ds.height > 25_000_000:  # statistics on a decimated read; never load multi-GB rasters fully
            decim = int(np.ceil(np.sqrt(ds.width * ds.height / 25_000_000)))
            warnings.append(f"대용량 래스터 - 통계·경사는 1/{decim} 간격 표본으로 산출")
        arr = ds.read(1, masked=True, out_shape=(max(1, ds.height // decim), max(1, ds.width // decim))).astype(np.float64)
        if crs is None:
            errors.append("투영정보(CRS)가 없음 - 좌표계를 추정하여 확정하지 않습니다. CRS가 있는 GeoTIFF를 업로드하세요.")
        projected = bool(crs.is_projected) if crs is not None else None
        if crs is not None and not crs.is_projected:
            # geographic DEM (e.g. SRTM/COP in EPSG:4326): convert arc cell size to metres for reporting
            lat_c = (ds.bounds.top + ds.bounds.bottom) / 2
            resx_m = resx * 111320.0 * math.cos(math.radians(lat_c))
            resy_m = resy * 110540.0
        else:
            resx_m, resy_m = resx, resy
        if resx_m > 35 or resy_m > 35:
            warnings.append(f"셀 크기 {resx_m:.1f}×{resy_m:.1f} m 로 30 m보다 거침")
        mask = np.ma.getmaskarray(arr)
        valid = arr.compressed()
        nodata_ratio = float(mask.mean()) if mask.size else 1.0
        if valid.size == 0:
            errors.append("유효한 고도값이 없음 (전부 NoData)")
        if nodata_ratio > 0:
            warnings.append(f"NoData 비율 {nodata_ratio*100:.2f}%")
        emin = float(valid.min()) if valid.size else None
        emax = float(valid.max()) if valid.size else None
        if emin is not None and (emin < -100 or emax > 2000):
            warnings.append(f"고도 범위 비정상 의심 ({emin:.1f}~{emax:.1f} m)")
        slope_max = slope_p99 = None
        if valid.size and arr.shape[0] > 2 and arr.shape[1] > 2:
            filled = arr.filled(np.nan)
            gy, gx = np.gradient(filled, resy_m * decim, resx_m * decim)
            slope = np.degrees(np.arctan(np.hypot(gx, gy)))
            s = slope[np.isfinite(slope)]
            if s.size:
                slope_max = float(s.max())
                slope_p99 = float(np.percentile(s, 99))
                if slope_max > 45:
                    warnings.append(f"급경사 셀 존재 (최대 {slope_max:.1f}°) - 자료 오류 또는 절벽/구조물 가능성")
        # vertical datum
        vd_tag = tags.get("VERTICAL_DATUM")
        wkt = crs.to_wkt() if crs is not None else ""
        if data_class == SYNTHETIC or vd_tag == "SYNTHETIC_UNIFIED":
            vdatum, vstatus = "SYNTHETIC_UNIFIED (가상 통일기준)", "SYNTHETIC_UNIFIED"
        elif declared_vertical_datum:
            vdatum, vstatus = f"{declared_vertical_datum} (사용자 신고, 파일 내 검증 불가)", "UNRESOLVED"
            warnings.append("vertical_datum_unresolved: 수직기준이 사용자 신고값일 뿐 파일 메타데이터로 검증되지 않음")
        elif "VERT" in wkt.upper():
            vdatum, vstatus = "파일 CRS에 수직기준 포함", "RESOLVED"
        else:
            vdatum, vstatus = "미확인", "UNRESOLVED"
            warnings.append("vertical_datum_unresolved: 파일에 수직기준 정보가 없음. 지오이드/타원체고 변환을 임의 상수로 수행하지 않고 상대고도 통일기준으로만 분석합니다.")
        hint = (name_hint + " " + " ".join(f"{k}={v}" for k, v in tags.items())).upper()
        if any(k in hint for k in ("COP", "GLO-30", "GLO30", "DSM", "AW3D", "ALOS")):
            surface = "DSM_POSSIBLE"
            warnings.append("DSM 가능성: Copernicus GLO-30/AW3D30 등은 건물·수목 높이를 포함할 수 있어 별도 건물 모형과 이중 모델링될 수 있음")
        elif "SRTM" in hint:
            surface = "DSM_POSSIBLE"
            warnings.append("SRTM(C-band 레이더)은 수목·건물 상부를 일부 포함하는 표면모델 성격 - 단지 내 기존 구조물이 지반고에 섞였을 수 있음 (계획지반은 가상 pad로 대체)")
        elif data_class == SYNTHETIC:
            surface = "DTM"
        else:
            surface = "UNKNOWN"
        b = ds.bounds
        return DemInfo(
            str(path), data_class, sha, crs.to_string() if crs else None, projected, resx_m, resy_m,
            ds.width, ds.height, float(ds.nodata) if ds.nodata is not None else None, nodata_ratio,
            emin, emax, slope_max, slope_p99, [b.left, b.bottom, b.right, b.top], vdatum, vstatus, surface,
            warnings=warnings, errors=errors,
        )


def clip_dem_to_aoi(src: Path, dst: Path, frame: LocalFrame, half_extent_m: float, source_note: dict) -> Path:
    """Windowed clip of a (possibly very large) DEM around the AOI, keeping the source CRS and cell grid (no resampling)."""
    from rasterio.windows import Window, from_bounds
    with rasterio.open(src) as ds:
        if ds.crs is None:
            raise ValueError("원본 DEM에 CRS 없음")
        to_src = Transformer.from_crs("EPSG:4326", ds.crs.to_string(), always_xy=True)
        corners = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], dtype=float) * half_extent_m
        lon, lat = frame.enu_xy_to_lonlat(corners)
        xs, ys = to_src.transform(lon, lat)
        win = from_bounds(min(xs), min(ys), max(xs), max(ys), ds.transform).round_offsets().round_lengths()
        win = win.intersection(Window(0, 0, ds.width, ds.height))
        arr = ds.read(1, window=win)
        prof = {"driver": "GTiff", "width": int(win.width), "height": int(win.height), "count": 1, "dtype": arr.dtype.name,
                "crs": ds.crs, "transform": ds.window_transform(win), "nodata": ds.nodata, "compress": "deflate"}
        dst.parent.mkdir(parents=True, exist_ok=True)
        with rasterio.open(dst, "w", **prof) as out:
            out.write(arr, 1)
            out.update_tags(DATA_CLASS=USER_UPLOADED, CLIP_HALF_EXTENT_M=str(half_extent_m),
                            **{f"SOURCE_{k.upper()}": str(v) for k, v in source_note.items()})
    return dst


class DemSampler:
    """Bilinear sampler of a DEM at ENU xy positions (via geodetic -> DEM CRS)."""

    def __init__(self, path: Path, frame: LocalFrame):
        self.frame = frame
        with rasterio.open(path) as ds:
            if ds.crs is None:
                raise ValueError("DEM CRS missing")
            self.arr = ds.read(1, masked=True).astype(np.float64).filled(np.nan)
            self.inv = ~ds.transform
            self.crs = ds.crs.to_string()
        self.to_dem = Transformer.from_crs("EPSG:4326", self.crs, always_xy=True)

    def sample_xy(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        shape = np.shape(x)
        lon, lat = self.frame.enu_xy_to_lonlat(np.column_stack([np.ravel(x), np.ravel(y)]))
        dx, dy = self.to_dem.transform(lon, lat)
        t = self.inv
        dx, dy = np.asarray(dx), np.asarray(dy)
        col = t.a * dx + t.b * dy + t.c
        row = t.d * dx + t.e * dy + t.f
        col = np.asarray(col) - 0.5
        row = np.asarray(row) - 0.5
        h, w = self.arr.shape
        c0 = np.floor(col).astype(int)
        r0 = np.floor(row).astype(int)
        fc = col - c0
        fr = row - r0
        out = np.full(c0.shape, np.nan)
        ok = (c0 >= 0) & (r0 >= 0) & (c0 + 1 < w) & (r0 + 1 < h)
        c, r, a, b = c0[ok], r0[ok], fc[ok], fr[ok]
        z00, z01 = self.arr[r, c], self.arr[r, c + 1]
        z10, z11 = self.arr[r + 1, c], self.arr[r + 1, c + 1]
        out[ok] = (z00 * (1 - a) + z01 * a) * (1 - b) + (z10 * (1 - a) + z11 * a) * b  # NaN propagates (NoData)
        return out.reshape(shape)


# ----------------------------------------------------------------------------------------------
# Site design ground (virtual pad) + ground mesh
# ----------------------------------------------------------------------------------------------
@dataclass
class GroundModel:
    xs: np.ndarray  # mesh vertex x (1D)
    ys: np.ndarray
    z: np.ndarray  # (ny, nx) blended heights, NaN = NoData
    regional: np.ndarray  # (ny, nx) raw regional DEM samples
    pad_z: float
    pad_rect: tuple[float, float, float, float]  # xmin, ymin, xmax, ymax
    blend_m: float
    mesh_spacing_m: float
    qa: dict

    def mesh(self) -> tuple[np.ndarray, np.ndarray]:
        """Triangulated height field. Triangles touching NoData vertices are dropped."""
        X, Y = np.meshgrid(self.xs, self.ys)
        verts = np.column_stack([X.ravel(), Y.ravel(), self.z.ravel()])
        ny, nx = self.z.shape
        idx = np.arange(nx * ny).reshape(ny, nx)
        a = idx[:-1, :-1].ravel()
        b = idx[:-1, 1:].ravel()
        c = idx[1:, :-1].ravel()
        d = idx[1:, 1:].ravel()
        # ys ascending -> counter-clockwise seen from +z: (a, b, d), (a, d, c)
        tris = np.concatenate([np.column_stack([a, b, d]), np.column_stack([a, d, c])])
        good = np.isfinite(verts[:, 2])
        tris = tris[good[tris].all(axis=1)]
        verts = verts.copy()
        verts[~good, 2] = 0.0
        return verts, tris.astype(np.int32)

    def height_at(self, x: float, y: float) -> float:
        """Bilinear height on the mesh grid (used only for informational lookups)."""
        i = np.clip(np.searchsorted(self.xs, x) - 1, 0, len(self.xs) - 2)
        j = np.clip(np.searchsorted(self.ys, y) - 1, 0, len(self.ys) - 2)
        tx = (x - self.xs[i]) / (self.xs[i + 1] - self.xs[i])
        ty = (y - self.ys[j]) / (self.ys[j + 1] - self.ys[j])
        z = self.z
        return float((z[j, i] * (1 - tx) + z[j, i + 1] * tx) * (1 - ty) + (z[j + 1, i] * (1 - tx) + z[j + 1, i + 1] * tx) * ty)


def _smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def build_ground(
    sampler: DemSampler,
    site_rect: tuple[float, float, float, float],
    region_half_m: float = 1200.0,
    mesh_spacing_m: float = 10.0,
    pad_margin_m: float = 20.0,
    blend_m: float = 60.0,
    pad_offset_m: float = 0.0,
) -> GroundModel:
    n = int(round(2 * region_half_m / mesh_spacing_m)) + 1
    xs = np.linspace(-region_half_m, region_half_m, n)
    ys = xs.copy()
    X, Y = np.meshgrid(xs, ys)
    regional = sampler.sample_xy(X, Y)
    xmin, ymin, xmax, ymax = site_rect
    inside_site = (X >= xmin) & (X <= xmax) & (Y >= ymin) & (Y <= ymax)
    site_vals = regional[inside_site & np.isfinite(regional)]
    if site_vals.size == 0:
        raise ValueError("대상지 내부 DEM 값이 없음 (NoData 또는 DEM 범위 밖)")
    pad_z = round(float(np.median(site_vals)), 1) + pad_offset_m
    pxmin, pymin, pxmax, pymax = xmin - pad_margin_m, ymin - pad_margin_m, xmax + pad_margin_m, ymax + pad_margin_m
    ddx = np.maximum(np.maximum(pxmin - X, X - pxmax), 0.0)
    ddy = np.maximum(np.maximum(pymin - Y, Y - pymax), 0.0)
    dist = np.hypot(ddx, ddy)
    w = _smoothstep(dist / blend_m)
    # inside the pad the planned ground is the pad itself (also where the DEM has NoData: 0*NaN would give NaN)
    z = np.where(w <= 0.0, pad_z, pad_z * (1 - w) + regional * w)
    # QA of the pad / terrain joint
    band = (dist > 0) & (dist <= blend_m)
    gy, gx = np.gradient(z, mesh_spacing_m, mesh_spacing_m)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    step_x = np.abs(np.diff(z, axis=1))
    step_y = np.abs(np.diff(z, axis=0))
    in_pad = dist == 0
    cut_fill = (pad_z - regional)[in_pad & np.isfinite(regional)]
    qa = {
        "pad_z_m": pad_z,
        "pad_offset_m": pad_offset_m,
        "pad_rect_enu": [pxmin, pymin, pxmax, pymax],
        "blend_band_m": blend_m,
        "blend_band_slope_max_deg": float(np.nanmax(slope[band])) if band.any() else None,
        "blend_band_slope_p95_deg": float(np.nanpercentile(slope[band], 95)) if band.any() else None,
        "max_vertex_step_m": float(np.nanmax([np.nanmax(step_x), np.nanmax(step_y)])),
        "pad_cut_fill_max_m": float(np.max(np.abs(cut_fill))) if cut_fill.size else None,
        "pad_fill_max_m": float(cut_fill.max()) if cut_fill.size else None,
        "pad_cut_max_m": float(-cut_fill.min()) if cut_fill.size else None,
        "nodata_vertex_ratio": float(np.mean(~np.isfinite(z))),
        "region_half_extent_m": region_half_m,
        "mesh_spacing_m": mesh_spacing_m,
    }
    warns = []
    if qa["blend_band_slope_max_deg"] and qa["blend_band_slope_max_deg"] > 20:
        warns.append(f"단지 접합부 최대 경사 {qa['blend_band_slope_max_deg']:.1f}° (>20°) - 비자연 단차 가능성")
    if qa["pad_cut_fill_max_m"] and qa["pad_cut_fill_max_m"] > 8:
        warns.append(f"가상 계획지반 절성토 최대 {qa['pad_cut_fill_max_m']:.1f} m - 계획지반고 자료 필요")
    qa["warnings"] = warns
    return GroundModel(xs, ys, z, regional, pad_z, (pxmin, pymin, pxmax, pymax), blend_m, mesh_spacing_m, qa)


def horizon_check(ground: GroundModel, min_sun_elev_deg: float) -> dict:
    """Max elevation angle of the modelled terrain edge seen from the pad centre vs. minimum sun elevation.

    Terrain *outside* the modelled region is unknown; this only tells whether the modelled edge is already
    close to the sun path (in which case un-modelled far terrain could matter)."""
    z = ground.z
    edge = np.concatenate([z[0, :], z[-1, :], z[:, 0], z[:, -1]])
    X, Y = np.meshgrid(ground.xs, ground.ys)
    ex = np.concatenate([X[0, :], X[-1, :], X[:, 0], X[:, -1]])
    ey = np.concatenate([Y[0, :], Y[-1, :], Y[:, 0], Y[:, -1]])
    d = np.hypot(ex, ey)
    ang = np.degrees(np.arctan2(edge - ground.pad_z, d))
    max_edge = float(np.nanmax(ang))
    # interior terrain max angle
    dd = np.hypot(X, Y)
    interior = np.degrees(np.arctan2(z - ground.pad_z, np.maximum(dd, 1.0)))
    interior[dd < 200] = -90
    return {
        "region_edge_max_elevation_angle_deg": round(max_edge, 3),
        "interior_terrain_max_elevation_angle_deg": round(float(np.nanmax(interior)), 3),
        "min_sun_elevation_in_window_deg": round(min_sun_elev_deg, 3),
        "outside_region_obstruction_possible": bool(max_edge > min_sun_elev_deg - 2.0),
        "note": "모델 경계 밖 지형·건물은 미반영. 경계 고도각이 최소 태양고도에 근접하면 외곽 차폐 가능성이 있음.",
    }
