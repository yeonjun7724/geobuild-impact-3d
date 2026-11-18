"""Create the DEMO project (Incheon Gyeyang A2 background, synthetic 30 m DEM, virtual complex).

Usage:  uv run python -m scripts.seed_demo [--name NAME]
"""
from __future__ import annotations

import argparse

from app.db import SessionLocal, init_db
from app import services


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="인천계양 A2 인근 가상단지 설계변경 검토 (DEMO)")
    a = ap.parse_args()
    init_db()
    with SessionLocal() as s:
        p = services.create_project(s, a.name)
        services.demo_seed(s, p)
        s.commit()
        print(f"project_id={p.id}")
        for sc in p.scenarios:
            print(f"  scenario {sc.code}: {sc.id} hash={sc.content_hash[:12]} locked={sc.locked}")


if __name__ == "__main__":
    main()
