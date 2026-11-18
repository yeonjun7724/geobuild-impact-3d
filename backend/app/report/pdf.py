"""HTML -> A4 PDF via Playwright Chromium, plus independent PDF verification with pypdf."""
from __future__ import annotations

from pathlib import Path

HEADER = """<div style="width:100%;font-size:7px;color:#898781;padding:0 14mm;display:flex;justify-content:space-between;
font-family:'Noto Sans KR','Noto Sans CJK KR','Malgun Gothic',sans-serif;"><span>JIRISO DATA STUDIO · GeoBuild Impact 3D 기술보고서</span>
<span>가상 PoC · 실제 LH 설계안/인허가 검토 아님</span></div>"""

FOOTER_TMPL = """<div style="width:100%;font-size:7px;color:#52514e;padding:0 14mm;display:flex;justify-content:space-between;
font-family:'Noto Sans KR','Noto Sans CJK KR','Malgun Gothic',sans-serif;"><span>{report_id} · run {run_id} · v{version}</span>
<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>"""


_CHROMIUM_CACHE: dict = {}


def _exe() -> dict:
    """Optional override for hosts whose pre-installed Chromium differs from the pinned Playwright build."""
    import os
    path = os.environ.get("PLAYWRIGHT_CHROMIUM_PATH")
    return {"executable_path": path} if path else {}


def chromium_status() -> dict:
    import time as _t
    if _CHROMIUM_CACHE and _t.time() - _CHROMIUM_CACHE["at"] < 600:
        return _CHROMIUM_CACHE["v"]
    v = _chromium_status()
    _CHROMIUM_CACHE.update({"at": _t.time(), "v": v})
    return v


def _chromium_status() -> dict:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            b = p.chromium.launch(**_exe())
            v = b.version
            b.close()
        return {"ok": True, "version": v}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:300]}


def render_pdf(html_path: Path, pdf_path: Path, report_id: str, run_id: str, version: str) -> dict:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(**_exe())
        page = browser.new_page()
        page.goto(html_path.resolve().as_uri(), wait_until="load")
        page.wait_for_timeout(300)
        page.emulate_media(media="print")
        page.pdf(path=str(pdf_path), format="A4", print_background=True, display_header_footer=True,
                 header_template=HEADER, footer_template=FOOTER_TMPL.format(report_id=report_id, run_id=run_id, version=version),
                 margin={"top": "16mm", "bottom": "16mm", "left": "14mm", "right": "14mm"}, prefer_css_page_size=True)
        ver = browser.version
        browser.close()
    return {"chromium": ver}


def try_capture_3d(url: str, png_path: Path, timeout_ms: int = 90000) -> dict:
    """Optional Cesium WebGL screenshot from the running frontend. Failure never fails the report."""
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"], **_exe())
            page = b.new_page(viewport={"width": 1400, "height": 860})
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_selector("[data-capture-ready='1']", timeout=timeout_ms)
            page.wait_for_timeout(1500)
            el = page.query_selector("[data-capture-root]")
            (el or page).screenshot(path=str(png_path))
            b.close()
        ok = png_path.exists() and png_path.stat().st_size > 5000
        return {"ok": ok, "path": str(png_path) if ok else None, "reason": None if ok else "빈 화면"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "path": None, "reason": f"{type(exc).__name__}: {str(exc)[:160]}"}


def verify_pdf(pdf_path: Path, expect_title: str, must_contain: list[str]) -> dict:
    from pypdf import PdfReader

    out = {"exists": pdf_path.exists(), "size_bytes": pdf_path.stat().st_size if pdf_path.exists() else 0}
    if not out["exists"] or out["size_bytes"] == 0:
        return {**out, "ok": False}
    r = PdfReader(str(pdf_path))
    texts = [(pg.extract_text() or "") for pg in r.pages]
    full = "\n".join(texts)
    n_img = 0
    for pg in r.pages:
        try:
            n_img += len(pg.images)
        except Exception:  # noqa: BLE001
            pass
    hangul = sum(1 for ch in full if "가" <= ch <= "힣")
    missing = [m for m in must_contain if m.replace(" ", "") not in full.replace(" ", "").replace("\n", "")]
    out.update({
        "pages": len(r.pages),
        "first_page_has_title": expect_title.replace(" ", "") in texts[0].replace(" ", "").replace("\n", "") if texts else False,
        "hangul_chars_extracted": hangul,
        "korean_text_extractable": hangul > 500,
        "embedded_images": n_img,
        "missing_markers": missing,
        "page_texts": texts,
    })
    out["ok"] = bool(out["first_page_has_title"] and out["korean_text_extractable"] and not missing and out["pages"] >= 10)
    return out
