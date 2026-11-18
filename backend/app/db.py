"""Database models (SQLAlchemy 2). Portable across SQLite (local default) and PostgreSQL/PostGIS (docker).

Geometries are stored as GeoJSON-like coordinate arrays in local ENU metres (JSON columns) together with
the frame definition, so the same schema works on both engines. With PostgreSQL the `geom_wkt` columns can
be cast to PostGIS geometry; computation itself uses Shapely in the metric ENU frame.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, create_engine, event)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

from .config import DATABASE_URL


def _uuid() -> str:
    return uuid.uuid4().hex[:12]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "project"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200))
    site_key: Mapped[str] = mapped_column(String(64), default="incheon-gyeyang-a2")
    site_meta: Mapped[dict] = mapped_column(JSON, default=dict)
    frame: Mapped[dict] = mapped_column(JSON, default=dict)  # {lat0, lon0, h0, crs_projected}
    site_rect: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(32), default="EMPTY")  # EMPTY | READY
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    buildings: Mapped[list["Building"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    scenarios: Mapped[list["Scenario"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Dataset(Base):
    __tablename__ = "dataset"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"))
    kind: Mapped[str] = mapped_column(String(32))  # TERRAIN | BUILDINGS
    data_class: Mapped[str] = mapped_column(String(32))  # REAL_OFFICIAL | USER_UPLOADED | SYNTHETIC | DERIVED
    filename: Mapped[str] = mapped_column(String(300))
    path: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64))
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    qa: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="OK")  # OK | WARN | REJECTED
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class TerrainSource(Base):
    __tablename__ = "terrain_source"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"))
    dataset_id: Mapped[str] = mapped_column(ForeignKey("dataset.id"))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    data_class: Mapped[str] = mapped_column(String(32))
    native_cell_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    vertical_datum: Mapped[str] = mapped_column(String(200))
    vertical_datum_status: Mapped[str] = mapped_column(String(32))
    surface_type: Mapped[str] = mapped_column(String(32))
    sha256: Mapped[str] = mapped_column(String(64))
    acquired: Mapped[str | None] = mapped_column(String(64), nullable=True)
    license: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SitePad(Base):
    __tablename__ = "site_pad"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"))
    terrain_source_id: Mapped[str] = mapped_column(ForeignKey("terrain_source.id"))
    pad_z: Mapped[float] = mapped_column(Float)
    rect: Mapped[list] = mapped_column(JSON)
    blend_m: Mapped[float] = mapped_column(Float)
    assumption: Mapped[str] = mapped_column(Text)
    qa: Mapped[dict] = mapped_column(JSON, default=dict)


class Building(Base):
    __tablename__ = "building"
    pk: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"))
    building_id: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(16))  # MAIN | CONTEXT
    floors: Mapped[int] = mapped_column(Integer)
    footprint: Mapped[list] = mapped_column(JSON)  # ENU ring [[x,y],...]
    data_class: Mapped[str] = mapped_column(String(32), default="SYNTHETIC")
    source_dataset_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    project: Mapped[Project] = relationship(back_populates="buildings")


class Floor(Base):
    __tablename__ = "floor"
    id: Mapped[str] = mapped_column(String(48), primary_key=True)  # <run>-<scenario>-<building>-F<nn>
    run_id: Mapped[str] = mapped_column(ForeignKey("analysis_run.id"), index=True)
    scenario: Mapped[str] = mapped_column(String(1))
    building_id: Mapped[str] = mapped_column(String(32))
    floor: Mapped[int] = mapped_column(Integer)
    base_z: Mapped[float] = mapped_column(Float)


class WindowReceiver(Base):
    __tablename__ = "window_receiver"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("analysis_run.id"), index=True)
    scenario: Mapped[str] = mapped_column(String(1))
    receiver_id: Mapped[str] = mapped_column(String(64), index=True)
    building_id: Mapped[str] = mapped_column(String(32))
    floor: Mapped[int] = mapped_column(Integer)
    facade: Mapped[str] = mapped_column(String(4))
    receiver_type: Mapped[str] = mapped_column(String(32), default="facade_proxy")
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    z: Mapped[float] = mapped_column(Float)
    nx: Mapped[float] = mapped_column(Float)
    ny: Mapped[float] = mapped_column(Float)


class OpenSpacePolygon(Base):
    __tablename__ = "open_space"
    pk: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"))
    space_id: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(32))
    polygon: Mapped[list] = mapped_column(JSON)
    data_class: Mapped[str] = mapped_column(String(32), default="SYNTHETIC")


class Scenario(Base):
    __tablename__ = "scenario"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"))
    code: Mapped[str] = mapped_column(String(1))  # A | B
    name: Mapped[str] = mapped_column(String(200))
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    content_hash: Mapped[str] = mapped_column(String(64), default="")
    revision: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    project: Mapped[Project] = relationship(back_populates="scenarios")
    transforms: Mapped[list["ScenarioBuildingTransform"]] = relationship(back_populates="scenario", cascade="all, delete-orphan")


class ScenarioBuildingTransform(Base):
    __tablename__ = "scenario_building_transform"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    scenario_id: Mapped[str] = mapped_column(ForeignKey("scenario.id"))
    building_id: Mapped[str] = mapped_column(String(32))
    dx: Mapped[float] = mapped_column(Float, default=0.0)
    dy: Mapped[float] = mapped_column(Float, default=0.0)
    rot_deg: Mapped[float] = mapped_column(Float, default=0.0)
    floors_delta: Mapped[int] = mapped_column(Integer, default=0)
    scenario: Mapped[Scenario] = relationship(back_populates="transforms")


class AnalysisRun(Base):
    __tablename__ = "analysis_run"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), index=True)
    analysis_type: Mapped[str] = mapped_column(String(8))  # A | B | C | ALL
    status: Mapped[str] = mapped_column(String(16), default="PENDING")
    stage: Mapped[str] = mapped_column(String(100), default="")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    logs: Mapped[list] = mapped_column(JSON, default=list)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)  # immutable inputs (A/B geometry, terrain, frame)
    cache_key: Mapped[str] = mapped_column(String(64), index=True)
    summary: Mapped[dict] = mapped_column(JSON, default=dict)
    quality: Mapped[dict] = mapped_column(JSON, default=dict)
    provenance: Mapped[dict] = mapped_column(JSON, default=dict)
    result_dir: Mapped[str | None] = mapped_column(Text, nullable=True)
    job_backend: Mapped[str] = mapped_column(String(16), default="")
    job_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    processing_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RaySample(Base):
    """Per receiver & scenario direct-sun time series (bit string over the sampled intervals)."""
    __tablename__ = "ray_sample"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("analysis_run.id"), index=True)
    scenario: Mapped[str] = mapped_column(String(1))
    receiver_id: Mapped[str] = mapped_column(String(64), index=True)
    sun_bits: Mapped[str] = mapped_column(Text)  # '1' sun, '0' no direct sun
    blockers: Mapped[str] = mapped_column(Text)  # comma list of blocker labels per interval ('' = none)
    total_min: Mapped[float] = mapped_column(Float)
    max_cont_min: Mapped[float] = mapped_column(Float)


class ShadowGridCell(Base):
    __tablename__ = "shadow_grid_cell"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("analysis_run.id"), index=True)
    cell_index: Mapped[int] = mapped_column(Integer)
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    z: Mapped[float] = mapped_column(Float)
    shade_min_a: Mapped[float] = mapped_column(Float)
    shade_min_b: Mapped[float] = mapped_column(Float)
    delta_min: Mapped[float] = mapped_column(Float)


class ClearancePair(Base):
    __tablename__ = "clearance_pair"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("analysis_run.id"), index=True)
    pair_id: Mapped[str] = mapped_column(String(80))
    distance_a_m: Mapped[float] = mapped_column(Float)
    distance_b_m: Mapped[float] = mapped_column(Float)
    delta_m: Mapped[float] = mapped_column(Float)
    status_a: Mapped[str] = mapped_column(String(16))
    status_b: Mapped[str] = mapped_column(String(16))
    geom_wkt_a: Mapped[str] = mapped_column(Text)
    geom_wkt_b: Mapped[str] = mapped_column(Text)


class Report(Base):
    __tablename__ = "report"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(ForeignKey("analysis_run.id"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="PENDING")
    stage: Mapped[str] = mapped_column(String(100), default="")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    version: Mapped[str] = mapped_column(String(16), default="1.0")
    files: Mapped[dict] = mapped_column(JSON, default=dict)
    quality: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ProvenanceRecord(Base):
    __tablename__ = "provenance_record"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), index=True)
    subject: Mapped[str] = mapped_column(String(100))
    data_class: Mapped[str] = mapped_column(String(32))
    source: Mapped[str] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    accessed: Mapped[str | None] = mapped_column(String(32), nullable=True)
    license: Mapped[str | None] = mapped_column(String(200), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


engine = create_engine(DATABASE_URL, future=True, pool_pre_ping=True,
                       connect_args={"check_same_thread": False, "timeout": 30} if DATABASE_URL.startswith("sqlite") else {})

if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _):  # noqa: ANN001
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)


def init_db() -> None:
    """Create tables (idempotent). This is the schema migration for the PoC (see docs/ARCHITECTURE.md)."""
    Base.metadata.create_all(engine)


def get_session():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()
