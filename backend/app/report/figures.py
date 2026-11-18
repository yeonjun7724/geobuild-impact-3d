"""Static, reproducible report figures (SVG, text kept as text) generated from run results only.

Map conventions: local ENU metres, north up, north arrow, scale bar, legend, CRS note on every map.
Colour roles (reference data-viz palette): A = blue #2a78d6, B = orange #eb6834; deltas use a diverging
blue <-> red ramp with a neutral grey midpoint (red = worse: less sun / more shade / smaller clearance).
"""
from __future__ import annotations

import io
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap, ListedColormap, TwoSlopeNorm  # noqa: E402
from matplotlib.patches import FancyArrow, Polygon as MPoly, Rectangle  # noqa: E402

INK = "#0b0b0b"
INK2 = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"
SURF = "#fcfcfb"
COL_A = "#2a78d6"
COL_B = "#eb6834"
COL_C3 = "#1baf7a"
DIV = LinearSegmentedColormap.from_list("div", ["#104281", "#3987e5", "#9ec5f4", "#f0efec", "#f3a5a4", "#e34948", "#8f1d1d"])
DIV_R = DIV.reversed()  # negative = red: for quantities where a decrease is worse (sun minutes)
STATE_CMAP = ListedColormap(["#f7f1d4", "#b9b7af", "#e34948", "#2a78d6"])  # sun→sun, shade→shade, new shade, relieved
STATE_LABELS = ["SUN→SUN (변화 없음)", "SHADE→SHADE (변화 없음)", "SUN→SHADE 신규 음영", "SHADE→SUN 음영 해소"]

_FONT_CANDIDATES = ["Noto Sans KR", "Noto Sans CJK KR", "Malgun Gothic", "NanumGothic", "Apple SD Gothic Neo"]


def setup_fonts() -> str:
    available = {f.name for f in font_manager.fontManager.ttflist}
    family = next((f for f in _FONT_CANDIDATES if f in available), None)
    if family is None:
        for p in [Path("C:/Windows/Fonts/malgun.ttf"), Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")]:
            if p.exists():
                font_manager.fontManager.addfont(str(p))
                family = font_manager.FontProperties(fname=str(p)).get_name()
                break
    plt.rcParams.update({
        "font.family": [family or "DejaVu Sans", "DejaVu Sans"],
        "svg.fonttype": "none",  # keep text as text -> searchable/copyable in PDF
        "axes.unicode_minus": False,
        "font.size": 8.5,
        "axes.edgecolor": AXIS, "axes.labelcolor": INK2, "xtick.color": MUTED, "ytick.color": MUTED,
        "axes.titlesize": 9.5, "axes.titleweight": "bold", "axes.titlecolor": INK,
        "axes.grid": False, "grid.color": GRID, "grid.linewidth": 0.6,
        "figure.facecolor": "white", "axes.facecolor": "white", "savefig.facecolor": "white",
        "legend.frameon": False, "legend.fontsize": 7.5,
        "axes.spines.top": False, "axes.spines.right": False,
    })
    return family or "DejaVu Sans"


def _save(fig, path: Path) -> str:
    plt.rcParams["svg.hashsalt"] = path.stem  # deterministic, unique element ids per inlined SVG
    buf = io.StringIO()
    fig.savefig(buf, format="svg", bbox_inches="tight", pad_inches=0.06)
    fig.savefig(path.with_suffix(".png"), format="png", dpi=150, bbox_inches="tight", pad_inches=0.06)
    plt.close(fig)
    svg = buf.getvalue()
    path.write_text(svg, encoding="utf-8")
    return path.name


def _map_furniture(ax, frame_note: str, scale_m: float = 50.0) -> None:
    ax.set_aspect("equal")
    x0, x1 = ax.get_xlim()
    y0, y1 = ax.get_ylim()
    w, h = x1 - x0, y1 - y0
    # north arrow
    ax.add_patch(FancyArrow(x1 - 0.06 * w, y1 - 0.17 * h, 0, 0.09 * h, width=0.012 * w, head_width=0.035 * w, head_length=0.04 * h,
                            color=INK, zorder=20, length_includes_head=True))
    ax.text(x1 - 0.06 * w, y1 - 0.05 * h, "N", ha="center", va="bottom", fontsize=8, fontweight="bold", color=INK, zorder=20)
    # scale bar
    sx, sy = x0 + 0.04 * w, y0 + 0.05 * h
    ax.add_patch(Rectangle((sx, sy), scale_m, 0.012 * h, color=INK, zorder=20))
    ax.add_patch(Rectangle((sx + scale_m / 2, sy), scale_m / 2, 0.012 * h, facecolor="white", edgecolor=INK, lw=0.6, zorder=21))
    ax.text(sx + scale_m / 2, sy + 0.025 * h, f"{scale_m:g} m", ha="center", va="bottom", fontsize=7, color=INK, zorder=20)
    if frame_note:
        ax.annotate(frame_note, (0, 0), xytext=(0, -26), xycoords="axes fraction", textcoords="offset points", fontsize=6.0,
                    color=MUTED, ha="left", va="top", annotation_clip=False)
    ax.set_xlabel("East (m)")
    ax.set_ylabel("North (m)")
    ax.tick_params(labelsize=7)


def _draw_buildings(ax, blds, color=INK2, face="#ecebe6", lw=0.8, label=True, alpha=1.0, ls="-", z=5, highlight: set | None = None):
    for b in blds:
        fp = np.asarray(b["footprint"])
        hl = highlight is not None and b["id"] in highlight
        ax.add_patch(MPoly(fp[:, :2], closed=True, facecolor=face, edgecolor=COL_B if hl else color, lw=lw * (1.8 if hl else 1),
                           alpha=alpha, ls=ls, zorder=z))
        if label:
            c = fp[:-1, :2].mean(axis=0)
            ax.text(c[0], c[1], f"{b['id']}\n{b['floors']}F", ha="center", va="center", fontsize=6.2, color=INK, zorder=z + 1, linespacing=0.95, clip_on=True)


def fig_location(out: Path, summary: dict, frame_note: str) -> str:
    fig, ax = plt.subplots(figsize=(6.4, 4.6))
    g = summary["ground"]
    half = g["region_half_extent_m"]
    ax.add_patch(Rectangle((-half, -half), 2 * half, 2 * half, fill=False, ec=MUTED, lw=0.8, ls="--"))
    k = half / 1200.0
    ax.text(-half + 30 * k, half - 30 * k, f"지형 모델 영역 {2 * half / 1000:.1f} km × {2 * half / 1000:.1f} km\n(DEM 기반 {g['mesh_spacing_m']:.0f} m 메쉬)",
            fontsize=7, color=INK2, va="top")
    pr = g["pad_rect_enu"]
    ax.add_patch(Rectangle((pr[0], pr[1]), pr[2] - pr[0], pr[3] - pr[1], fill=False, ec=COL_C3, lw=1))
    ax.add_patch(Rectangle((-150, -150), 300, 300, facecolor="#f0efec", ec=INK, lw=1))
    ax.plot([0], [0], marker="o", ms=6, color="#e34948", zorder=10)
    ax.annotate("LH 공고 지도 마커 (ENU 원점)\n동양동 413-2 · 대표점, 경계 아님", (0, 0), (180 * k, 260 * k), fontsize=7, color=INK,
                arrowprops=dict(arrowstyle="-", color=INK2, lw=0.6))
    cc = summary.get("_cross_check_enu")
    if cc:
        ax.plot([cc[0]], [cc[1]], marker="s", ms=5, color=MUTED, zorder=10)
        ax.annotate("OSM 동양동 법정동 중심점(참고)", (cc[0], cc[1]), (cc[0] - 50 * k, cc[1] + 330 * k), fontsize=6.8, color=INK2,
                    arrowprops=dict(arrowstyle="-", color=MUTED, lw=0.6))
    ax.text(-140, -185 * k, "가상 대상지 300 m × 300 m (SYNTHETIC)", fontsize=7, color=INK)
    ax.set_xlim(-half - 50, half + 50)
    ax.set_ylim(-half - 50, half + 50)
    _map_furniture(ax, frame_note, scale_m=500 if half <= 2000 else 2000)
    ax.set_title("대상지 위치 및 분석 범위")
    return _save(fig, out)


def fig_layout_ab(out: Path, summary: dict, frame_note: str) -> str:
    A = summary["scenarios"]["A"]["buildings"]
    B = summary["scenarios"]["B"]["buildings"]
    changed = set(summary["changed_buildings"])
    fig, axes = plt.subplots(1, 2, figsize=(7.2, 3.9), sharey=True)
    for ax, blds, title in ((axes[0], A, "기준안 A"), (axes[1], B, "변경안 B (변경 주동 주황 테두리)")):
        ax.add_patch(Rectangle((-150, -150), 300, 300, fill=False, ec=MUTED, lw=0.7, ls="--"))
        if ax is axes[1]:
            _draw_buildings(ax, [b for b in A if b["id"] in changed], color=COL_A, face="none", lw=0.8, label=False, ls="--", z=4)
        _draw_buildings(ax, blds, highlight=changed if ax is axes[1] else None)
        for osp in summary.get("_open_spaces", []):
            ax.add_patch(MPoly(np.asarray(osp["polygon"]), closed=True, facecolor="#d9f2e6", ec=COL_C3, lw=0.6, zorder=3))
        ax.set_xlim(-270, 270)
        ax.set_ylim(-270, 270)
        ax.set_title(title)
        _map_furniture(ax, frame_note if ax is axes[0] else "파란 점선 = A 위치(변경 주동)", scale_m=50)
    return _save(fig, out)


def fig_terrain(out: Path, ground_z: np.ndarray, xs: np.ndarray, ys: np.ndarray, pad_rect, frame_note: str, title: str) -> str:
    fig, ax = plt.subplots(figsize=(6.0, 4.6))
    dzdy, dzdx = np.gradient(ground_z, ys[1] - ys[0], xs[1] - xs[0])
    az, alt = np.radians(315), np.radians(45)
    slope = np.arctan(np.hypot(dzdx, dzdy))
    aspect = np.arctan2(-dzdx, dzdy)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    ext = [xs[0], xs[-1], ys[0], ys[-1]]
    im = ax.imshow(ground_z, origin="lower", extent=ext, cmap="Greys", alpha=0.0)
    ax.imshow(hs, origin="lower", extent=ext, cmap="Greys_r", alpha=0.35, vmin=0, vmax=1)
    im = ax.imshow(ground_z, origin="lower", extent=ext, cmap=LinearSegmentedColormap.from_list("t", ["#cde2fb", "#6da7ec", "#256abf", "#0d366b"]), alpha=0.55)
    rng = float(np.nanmax(ground_z) - np.nanmin(ground_z))
    step = next(v for v in (5, 10, 25, 50, 100) if rng / v <= 25)
    cs = ax.contour(xs, ys, ground_z, levels=np.arange(np.floor(np.nanmin(ground_z) / step) * step, np.nanmax(ground_z) + step, step),
                    colors=INK2, linewidths=0.35)
    ax.clabel(cs, fontsize=5.5, fmt="%d")
    ax.add_patch(Rectangle((pad_rect[0], pad_rect[1]), pad_rect[2] - pad_rect[0], pad_rect[3] - pad_rect[1], fill=False, ec="#e34948", lw=1))
    cb = fig.colorbar(im, ax=ax, shrink=0.75, pad=0.02)
    cb.set_label("지반고 z (m, 통일기준)")
    ax.set_title(title)
    _map_furniture(ax, frame_note, scale_m=500 if xs[-1] <= 2000 else 2000)
    return _save(fig, out)


def fig_sunpath(out: Path, sun: dict) -> str:
    t = [s[11:16] for s in sun["times_local"]]
    fig, ax = plt.subplots(figsize=(6.6, 2.4))
    ax.plot(range(len(t)), sun["elevation_deg"], color=COL_A, lw=2, label="태양 고도각 (°)")
    ax.set_ylabel("고도각 (°)")
    ax2_vals = sun["azimuth_deg"]
    ax.set_xticks(range(0, len(t), max(1, len(t) // 8)))
    ax.set_xticklabels([t[i] for i in range(0, len(t), max(1, len(t) // 8))])
    ax.grid(axis="y")
    for i in range(0, len(t), max(1, len(t) // 8)):
        ax.text(i, sun["elevation_deg"][i] + 1.2, f"방위 {ax2_vals[i]:.0f}°", fontsize=6, color=INK2, ha="center")
    ax.set_ylim(0, max(sun["elevation_deg"]) + 8)
    ax.set_xlabel("시각 (KST, 구간 중점)")
    ax.set_title("태양 고도각·방위각 (pvlib NREL SPA)")
    return _save(fig, out)


def fig_sun_receivers_map(out: Path, summary: dict, rows: list[dict], frame_note: str) -> str:
    """Plan view: each facade column coloured by the worst delta over its floors (B positions)."""
    cols: dict[tuple, list] = {}
    for r in rows:
        key = (round(r["x_b"], 1), round(r["y_b"], 1))
        cols.setdefault(key, []).append(r["delta_total_min"])
    xy = np.array(list(cols.keys()))
    worst = np.array([min(v) for v in cols.values()])
    best = np.array([max(v) for v in cols.values()])
    val = np.where(np.abs(worst) >= np.abs(best), worst, best)
    lim = max(30.0, float(np.abs(val).max()))
    fig, ax = plt.subplots(figsize=(6.4, 5.0))
    _draw_buildings(ax, summary["scenarios"]["B"]["buildings"], highlight=set(summary["changed_buildings"]))
    order = np.argsort(np.abs(val))
    sc = ax.scatter(xy[order, 0], xy[order, 1], c=val[order], cmap=DIV_R, norm=TwoSlopeNorm(0, -lim, lim), s=14,
                    edgecolors="white", linewidths=0.4, zorder=10)
    cb = fig.colorbar(sc, ax=ax, shrink=0.7, pad=0.02)
    cb.set_label("Δ 직사일조 (분, B−A) · 층 중 절댓값 최대")
    ax.set_xlim(-170, 170)
    ax.set_ylim(-150, 150)
    ax.set_title("A. 수광점(외벽 대리지점) 직사일조 변화 공간분포")
    _map_furniture(ax, frame_note, scale_m=50)
    return _save(fig, out)


def fig_facade_matrix(out: Path, rows: list[dict], building_id: str, facade: str) -> str:
    sel = [r for r in rows if r["building_id"] == building_id and r["facade"] == facade]
    if not sel:
        return ""
    floors = sorted({r["floor"] for r in sel})
    cols = sorted({r["receiver_id"].split("-")[-1] for r in sel})
    M = {k: np.full((len(floors), len(cols)), np.nan) for k in ("a", "b", "d")}
    for r in sel:
        i = floors.index(r["floor"])
        j = cols.index(r["receiver_id"].split("-")[-1])
        M["a"][i, j], M["b"][i, j], M["d"][i, j] = r["sun_total_min_a"], r["sun_total_min_b"], r["delta_total_min"]
    fig, axes = plt.subplots(1, 3, figsize=(7.2, 3.6), sharey=True)
    vmax = np.nanmax([M["a"], M["b"]])
    seq = LinearSegmentedColormap.from_list("s", ["#f0efec", "#fbe3a0", "#eda100", "#a86f00"])
    for ax, k, ttl in ((axes[0], "a", "A 총 직사일조(분)"), (axes[1], "b", "B 총 직사일조(분)")):
        im = ax.imshow(M[k], origin="lower", cmap=seq, vmin=0, vmax=vmax, aspect="auto")
        ax.set_title(ttl)
    fig.colorbar(im, ax=axes[:2], shrink=0.8, pad=0.02, label="분")
    lim = max(15, np.nanmax(np.abs(M["d"])))
    im2 = axes[2].imshow(M["d"], origin="lower", cmap=DIV_R, norm=TwoSlopeNorm(0, -lim, lim), aspect="auto")
    axes[2].set_title("Δ (B−A, 분)")
    fig.colorbar(im2, ax=axes[2], shrink=0.8, pad=0.02, label="분")
    for ax in axes:
        ax.set_xticks(range(len(cols)))
        ax.set_xticklabels(cols, fontsize=6)
        ax.set_xlabel("수광점 열")
    axes[0].set_yticks(range(0, len(floors), 2))
    axes[0].set_yticklabels([floors[i] for i in range(0, len(floors), 2)], fontsize=6)
    axes[0].set_ylabel("층")
    fig.suptitle(f"{building_id}동 {facade}면 입면 직사일조 행렬 (facade proxy)", fontsize=9.5, fontweight="bold", color=INK)
    return _save(fig, out)


def fig_building_bars(out: Path, per_building: list[dict]) -> str:
    ids = [b["building_id"] for b in per_building]
    a = [b["mean_total_min_a"] for b in per_building]
    bb = [b["mean_total_min_b"] for b in per_building]
    x = np.arange(len(ids))
    fig, axes = plt.subplots(1, 2, figsize=(7.2, 2.8))
    w = 0.38
    axes[0].bar(x - w / 2 - 0.01, a, w, color=COL_A, label="A")
    axes[0].bar(x + w / 2 + 0.01, bb, w, color=COL_B, label="B")
    axes[0].set_xticks(x)
    axes[0].set_xticklabels(ids)
    axes[0].set_ylabel("평균 총 직사일조 (분)")
    axes[0].legend(loc="upper right", ncols=2)
    axes[0].grid(axis="y")
    axes[0].set_title("주동별 평균 총 직사일조")
    dec = [b["n_decreased"] for b in per_building]
    inc = [b["n_increased"] for b in per_building]
    axes[1].bar(x, [-d for d in dec], 0.6, color="#e34948", label="감소 수광점")
    axes[1].bar(x, inc, 0.6, color=COL_A, label="증가 수광점")
    axes[1].axhline(0, color=AXIS, lw=0.8)
    axes[1].set_xticks(x)
    axes[1].set_xticklabels(ids)
    axes[1].set_ylabel("수광점 수 (감소는 음수 표시)")
    axes[1].legend(loc="lower right", ncols=2)
    axes[1].grid(axis="y")
    axes[1].set_title("주동별 일조 감소/증가 수광점 수")
    for i, (d, n) in enumerate(zip(dec, inc)):
        if d:
            axes[1].text(i, -d, str(d), ha="center", va="top", fontsize=6.5, color=INK)
        if n:
            axes[1].text(i, n, str(n), ha="center", va="bottom", fontsize=6.5, color=INK)
    fig.tight_layout()
    return _save(fig, out)


def fig_delta_hist(out: Path, rows: list[dict]) -> str:
    d = np.array([r["delta_total_min"] for r in rows])
    fig, ax = plt.subplots(figsize=(6.4, 2.4))
    bins = np.arange(np.floor(d.min() / 10) * 10 - 5, np.ceil(d.max() / 10) * 10 + 10, 10)
    n, edges = np.histogram(d, bins=bins)
    ctr = (edges[:-1] + edges[1:]) / 2
    ax.bar(ctr, n, width=9, color=["#e34948" if c < -0.01 else (COL_A if c > 0.01 else MUTED) for c in ctr])
    ax.set_yscale("log")
    ax.set_xlabel("Δ 총 직사일조 (분, B−A)")
    ax.set_ylabel("수광점 수 (로그)")
    ax.grid(axis="y")
    ax.set_title("수광점별 직사일조 변화 분포")
    return _save(fig, out)


def fig_time_heatmap(out: Path, ts: dict, worst_ids: list[str], times: list[str]) -> str:
    if not worst_ids:
        return ""
    ida, idb = list(ts["ids_a"]), list(ts["ids_b"])
    A = np.array([ts["sun_a"][ida.index(r)] for r in worst_ids]).astype(float)
    B = np.array([ts["sun_b"][idb.index(r)] for r in worst_ids]).astype(float)
    fig, axes = plt.subplots(1, 2, figsize=(7.2, 0.28 * len(worst_ids) + 1.2), sharey=True)
    cm = ListedColormap(["#d9d8d2", "#eda100"])
    for ax, M, ttl in ((axes[0], A, "A: 직사일조 0/1"), (axes[1], B, "B: 직사일조 0/1")):
        ax.imshow(M, aspect="auto", cmap=cm, vmin=0, vmax=1, interpolation="nearest")
        step = max(1, len(times) // 8)
        ax.set_xticks(range(0, len(times), step))
        ax.set_xticklabels([times[i] for i in range(0, len(times), step)], fontsize=6)
        ax.set_title(ttl)
    axes[0].set_yticks(range(len(worst_ids)))
    axes[0].set_yticklabels(worst_ids, fontsize=6)
    fig.text(0.5, -0.02, "노랑 = 직사일조 가능(1), 회색 = 차폐/비입사(0) · 시각 = KST 구간 중점", ha="center", fontsize=7, color=INK2)
    return _save(fig, out)


def _grid_image(meta: dict, vy, vx, vals, fill=np.nan):
    G = np.full((meta["ny"], meta["nx"]), fill, dtype=float)
    G[vy, vx] = vals
    return G


def fig_shadow_states(out: Path, summary: dict, grid: dict, frame_note: str) -> str:
    meta = summary["B"]["grid_meta"]
    times = list(grid["snap_times"])
    n = len(times)
    fig, axes = plt.subplots(1, n, figsize=(7.4, 3.1), sharey=True)
    axes = np.atleast_1d(axes)
    h = meta["spacing"] / 2
    ext = [meta["x0"] - h, meta["x0"] - h + meta["nx"] * meta["spacing"], meta["y0"] - h, meta["y0"] - h + meta["ny"] * meta["spacing"]]
    for k, ax in enumerate(axes):
        a, b = grid["snap_a"][:, k], grid["snap_b"][:, k]
        st = np.where(a & b, 1, 0)
        st = np.where(~a & b, 2, st)
        st = np.where(a & ~b, 3, st)
        G = _grid_image(meta, grid["vy"], grid["vx"], st)
        ax.imshow(np.ma.masked_invalid(G), origin="lower", extent=ext, cmap=STATE_CMAP, vmin=-0.5, vmax=3.5, interpolation="nearest")
        _draw_buildings(ax, summary["scenarios"]["B"]["buildings"], label=False, face="#6b6a66", color=INK, lw=0.4)
        ax.set_xlim(ext[0], ext[1])
        ax.set_ylim(ext[2], ext[3])
        row = summary["B"]["snapshots"][k]
        ax.set_title(f"{times[k]} KST · 신규 {row.get('new_shade_area_m2', 0):,.0f} m²")
        _map_furniture(ax, frame_note if k == 0 else "", scale_m=50)
        if k:
            ax.set_ylabel("")
    handles = [Rectangle((0, 0), 1, 1, color=STATE_CMAP(i)) for i in range(4)] + [Rectangle((0, 0), 1, 1, color="#6b6a66")]
    fig.legend(handles, STATE_LABELS + ["건물(B) · 격자 제외"], loc="lower center", ncols=5, fontsize=6.5, bbox_to_anchor=(0.5, -0.06))
    return _save(fig, out)


def fig_shadow_delta(out: Path, summary: dict, grid: dict, frame_note: str) -> str:
    meta = summary["B"]["grid_meta"]
    dt = summary["params"]["interval_min"]
    d = (grid["shade_b"].sum(axis=1) - grid["shade_a"].sum(axis=1)) * dt
    G = _grid_image(meta, grid["vy"], grid["vx"], d)
    h = meta["spacing"] / 2
    ext = [meta["x0"] - h, meta["x0"] - h + meta["nx"] * meta["spacing"], meta["y0"] - h, meta["y0"] - h + meta["ny"] * meta["spacing"]]
    lim = max(10.0, float(np.nanmax(np.abs(G))))
    fig, ax = plt.subplots(figsize=(6.4, 5.0))
    ax.add_patch(Rectangle((ext[0], ext[2]), ext[1] - ext[0], ext[3] - ext[2], facecolor="#ffffff", hatch="////", ec=AXIS, lw=0.3, zorder=0))
    im = ax.imshow(np.ma.masked_invalid(G), origin="lower", extent=ext, cmap=DIV, norm=TwoSlopeNorm(0, -lim, lim), interpolation="nearest", zorder=1)
    _draw_buildings(ax, summary["scenarios"]["B"]["buildings"], highlight=set(summary["changed_buildings"]))
    for osp in summary.get("_open_spaces", []):
        ax.add_patch(MPoly(np.asarray(osp["polygon"]), closed=True, fill=False, ec=COL_C3, lw=1.2, zorder=8))
        p = np.asarray(osp["polygon"])
        ax.text(p[:, 0].mean(), p[:, 1].max() + 3, osp["name"].split(" (")[0], fontsize=6, color="#0b6b48", ha="center", zorder=9, clip_on=True)
    for i, t in enumerate(summary["B"]["top_cells"][:5]):
        ax.plot(t["x"], t["y"], marker="o", ms=5, mfc="none", mec=INK, mew=0.8, zorder=12)
        ax.text(t["x"] + 3, t["y"] + 3, f"T{i + 1}", fontsize=6, color=INK, zorder=12)
    cb = fig.colorbar(im, ax=ax, shrink=0.7, pad=0.02)
    cb.set_label("Δ 누적 음영시간 (분, B−A) · 빨강 = 음영 증가")
    ax.set_xlim(ext[0], ext[1])
    ax.set_ylim(ext[2], ext[3])
    ax.set_title(f"B. 누적 음영시간 증감 지도 ({summary['params']['start']}~{summary['params']['end']} KST)")
    _map_furniture(ax, frame_note + " · 빗금 = 제외 셀(건물 내부/NoData)", scale_m=50)
    return _save(fig, out)


def fig_shadow_cumulative(out: Path, summary: dict, grid: dict, frame_note: str) -> str:
    meta = summary["B"]["grid_meta"]
    dt = summary["params"]["interval_min"]
    h = meta["spacing"] / 2
    ext = [meta["x0"] - h, meta["x0"] - h + meta["nx"] * meta["spacing"], meta["y0"] - h, meta["y0"] - h + meta["ny"] * meta["spacing"]]
    seq = LinearSegmentedColormap.from_list("sq", ["#f7f6f2", "#b7d3f6", "#5598e7", "#1c5cab", "#0d366b"])
    vmax = summary["B"]["analysed_minutes"]
    fig, axes = plt.subplots(1, 2, figsize=(7.4, 3.6), sharey=True)
    for ax, key, code in ((axes[0], "shade_a", "A"), (axes[1], "shade_b", "B")):
        G = _grid_image(meta, grid["vy"], grid["vx"], grid[key].sum(axis=1) * dt)
        im = ax.imshow(np.ma.masked_invalid(G), origin="lower", extent=ext, cmap=seq, vmin=0, vmax=vmax, interpolation="nearest")
        _draw_buildings(ax, summary["scenarios"][code]["buildings"], label=False, face="#6b6a66", color=INK, lw=0.4)
        ax.set_xlim(ext[0], ext[1])
        ax.set_ylim(ext[2], ext[3])
        ax.set_title(f"{code}: 누적 음영시간 (분)")
        _map_furniture(ax, frame_note if code == "A" else "", scale_m=50)
    fig.colorbar(im, ax=axes, shrink=0.75, pad=0.02, label="음영 (분)")
    return _save(fig, out)


def fig_shadow_curve(out: Path, curve: dict) -> str:
    t = curve["time_local"]
    x = np.arange(len(t))
    fig, axes = plt.subplots(1, 2, figsize=(7.2, 2.7))
    axes[0].plot(x, curve["new_shade_area_m2"], color="#e34948", lw=2, label="신규 음영")
    axes[0].plot(x, curve["relieved_area_m2"], color=COL_A, lw=2, label="음영 해소")
    axes[0].set_ylabel("면적 (m²)")
    axes[0].set_title("시각별 신규 음영 / 음영 해소 면적")
    axes[1].plot(x, curve["shade_area_a_m2"], color=COL_A, lw=2, label="A 음영면적")
    axes[1].plot(x, curve["shade_area_b_m2"], color=COL_B, lw=2, label="B 음영면적")
    axes[1].set_title("시각별 총 음영 면적 (유효격자 내)")
    step = max(1, len(t) // 6)
    for ax in axes:
        ax.set_xticks(x[::step])
        ax.set_xticklabels([s[:5] for s in t[::step]], fontsize=6.5)
        ax.grid(axis="y")
        ax.legend(loc="upper left")
        ax.set_xlabel("KST (구간 중점)")
    fig.tight_layout()
    return _save(fig, out)


def fig_clearance_map(out: Path, summary: dict, frame_note: str) -> str:
    cc = summary["C"]
    fig, axes = plt.subplots(1, 2, figsize=(7.4, 3.9), sharey=True)
    pairs_sorted = sorted(cc["pairs"], key=lambda r: r["distance_b_m"])
    keep = {r["pair_id"] for r in pairs_sorted[:8]} | {r["pair_id"] for r in cc["worsened_top"][:5]}
    for ax, code in ((axes[0], "A"), (axes[1], "B")):
        _draw_buildings(ax, summary["scenarios"][code]["buildings"], highlight=set(summary["changed_buildings"]) if code == "B" else None)
        for r in cc["pairs"]:
            if r["pair_id"] not in keep:
                continue
            pa, pb = r[f"p_a_{code}"], r[f"p_b_{code}"]
            d = r[f"distance_{code.lower()}_m"]
            worse = code == "B" and r["delta_m"] < 0
            ax.plot([pa[0], pb[0]], [pa[1], pb[1]], color="#e34948" if worse else INK2, lw=1.4 if worse else 0.8, zorder=12)
            ax.plot([pa[0], pb[0]], [pa[1], pb[1]], "o", ms=2.4, color=INK, zorder=13)
            mx, my = (pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2
            lab = f"{d:.1f}" + (f" ({r['delta_m']:+.1f})" if code == "B" and abs(r["delta_m"]) > 1e-6 else "")
            ax.text(mx + 2, my, lab, fontsize=5.8, color="#8f1d1d" if worse else INK, zorder=14,
                    bbox=dict(boxstyle="round,pad=0.12", fc="white", ec="none", alpha=0.85))
        ax.set_xlim(-170, 170)
        ax.set_ylim(-150, 150)
        ax.set_title(f"{code}: 최단 수평 이격 연결선 (m)")
        _map_furniture(ax, frame_note if code == "A" else "빨강 = 이격 감소 쌍 (괄호: Δm)", scale_m=50)
    return _save(fig, out)


def fig_clearance_bars(out: Path, pairs: list[dict]) -> str:
    rows = sorted(pairs, key=lambda r: r["delta_m"])
    rows = [r for r in rows if abs(r["delta_m"]) > 1e-6][:14] or rows[:10]
    fig, ax = plt.subplots(figsize=(6.4, 0.24 * len(rows) + 1.0))
    y = np.arange(len(rows))
    ax.barh(y, [r["delta_m"] for r in rows], color=["#e34948" if r["delta_m"] < 0 else COL_A for r in rows], height=0.6)
    ax.set_yticks(y)
    ax.set_yticklabels([r["pair_id"].replace("|", "↔") for r in rows], fontsize=6.5)
    ax.axvline(0, color=AXIS, lw=0.8)
    for i, r in enumerate(rows):
        ax.text(r["delta_m"], i, f" {r['delta_m']:+.2f}", va="center", ha="left" if r["delta_m"] >= 0 else "right", fontsize=6.3, color=INK)
    ax.invert_yaxis()
    ax.set_xlabel("Δ 최단 이격거리 (m, B−A)")
    ax.grid(axis="x")
    ax.set_title("건물 쌍별 이격거리 변화 (변화가 있는 쌍)")
    return _save(fig, out)


def fig_sensitivity(out: Path, cases: list[dict]) -> str:
    keys = [("A_mean_total_min_b", "A: B안 평균 총 직사일조(분)"), ("A_n_decreased", "A: 일조 감소 수광점 수"),
            ("B_max_new_shade_area_m2", "B: 최대 신규 음영면적(m²)"), ("B_area_more_shade_m2", "B: 음영 증가 면적(m²)")]
    keys = [k for k in keys if any(k[0] in c for c in cases)]
    fig, axes = plt.subplots(1, len(keys), figsize=(7.4, 2.9), sharey=True)
    axes = np.atleast_1d(axes)
    labels = [c["case"] for c in cases]
    y = np.arange(len(cases))
    for ax, (k, ttl) in zip(axes, keys):
        v = [c.get(k, np.nan) for c in cases]
        ax.barh(y, v, color=[COL_A if i == 0 else "#86b6ef" for i in range(len(cases))], height=0.6)
        ax.set_title(ttl, fontsize=7.5)
        ax.tick_params(axis="x", labelsize=6)
        for i, val in enumerate(v):
            ax.text(val, i, f" {val:,.1f}" if isinstance(val, float) else f" {val}", va="center", fontsize=5.8, color=INK)
        ax.grid(axis="x")
    axes[0].set_yticks(y)
    axes[0].set_yticklabels(labels, fontsize=6.3)
    axes[0].invert_yaxis()
    fig.tight_layout()
    return _save(fig, out)


def fig_integrated(out: Path, summary: dict, frame_note: str) -> str:
    rows = {r["building_id"]: r for r in summary["integrated"]["rows"]}
    fig, ax = plt.subplots(figsize=(6.2, 4.6))
    for b in summary["scenarios"]["B"]["buildings"]:
        r = rows.get(b["id"], {})
        n = r.get("n_flags", 0)
        face = ["#f0efec", "#fbe3a0", "#f3a5a4", "#e34948"][min(n, 3)]
        fp = np.asarray(b["footprint"])
        ax.add_patch(MPoly(fp[:, :2], closed=True, facecolor=face, edgecolor=INK2, lw=0.8, zorder=5))
        c = fp[:-1, :2].mean(axis=0)
        flags = r.get("flags", [])
        ax.text(c[0], c[1], b["id"] + ("\n" + "·".join(f[:2] for f in flags) if flags else ""), ha="center", va="center", fontsize=6, color=INK, zorder=6, clip_on=True)
    handles = [Rectangle((0, 0), 1, 1, color=c) for c in ["#f0efec", "#fbe3a0", "#f3a5a4", "#e34948"]]
    ax.legend(handles, ["해당 없음", "1개 지표", "2개 지표", "3개 지표 동시"], loc="lower right", fontsize=6.5, title="동시 발생 지표 수", title_fontsize=6.5)
    ax.set_xlim(-170, 170)
    ax.set_ylim(-150, 150)
    ax.set_title("통합: 일조 감소 / 신규 음영 원인 / 이격 감소 동시 발생 주동")
    _map_furniture(ax, frame_note + " · 가중합 순위 아님", scale_m=50)
    return _save(fig, out)
