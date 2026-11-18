"""Create/upgrade the database schema (idempotent).  uv run python -m scripts.migrate

PoC schema management: SQLAlchemy metadata.create_all on SQLite (default) or PostgreSQL/PostGIS (DATABASE_URL).
Tables: project, dataset, terrain_source, site_pad, building, floor, window_receiver, open_space, scenario,
scenario_building_transform, analysis_run, ray_sample, shadow_grid_cell, clearance_pair, report, provenance_record.
"""
from sqlalchemy import inspect

from app.config import DATABASE_URL
from app.db import engine, init_db


def main() -> None:
    init_db()
    print(f"schema ready on {DATABASE_URL.split('://')[0]}: {sorted(inspect(engine).get_table_names())}")


if __name__ == "__main__":
    main()
