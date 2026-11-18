"""Pydantic request/response models (units: metres, degrees, minutes, m²; times ISO-8601)."""
from __future__ import annotations

import datetime as dt
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class ProjectCreate(BaseModel):
    name: str = Field("인천계양 A2 인근 가상단지 설계변경 검토", max_length=200)
    site_key: Literal["incheon-gyeyang-a2"] = "incheon-gyeyang-a2"
    seed_demo: bool = True


class ProjectOut(BaseModel):
    id: str
    name: str
    site_key: str
    status: str
    site_meta: dict
    frame: dict
    site_rect: list[float]
    created_at: datetime
    data_badges: dict = {}
    scenarios: list[dict] = []
    latest_run: dict | None = None


class ScenarioCreate(BaseModel):
    code: Literal["B"] = "B"
    name: str = "변경안 B"
    copy_from: Literal["A", "B"] = "A"


class TransformPatch(BaseModel):
    dx: float | None = Field(None, ge=-60, le=60, description="동(+)/서(-) 이동 m")
    dy: float | None = Field(None, ge=-60, le=60, description="북(+)/남(-) 이동 m")
    rot_deg: float | None = Field(None, ge=-45, le=45, description="반시계(+) 회전 °")
    floors_delta: int | None = Field(None, ge=-10, le=10, description="층수 증감 (1층 = 2.9 m)")


class AnalysisRequest(BaseModel):
    analysis_type: Literal["A", "B", "C", "ALL"] = "ALL"
    date: dt.date = dt.date(2026, 12, 22)
    start: str = "08:00"
    end: str = "16:00"
    interval_min: float = Field(5.0, gt=0, le=60)
    timezone: str = "Asia/Seoul"
    grid_spacing_m: float = Field(2.0, ge=1.0, le=10.0)
    snapshot_times: list[str] = ["09:00", "12:00", "15:00"]
    include_sensitivity: bool = True
    allow_unresolved_vertical_datum: bool = True
    reuse_cache: bool = True

    @field_validator("start", "end")
    @classmethod
    def _hhmm(cls, v: str) -> str:
        h, m = v.split(":")
        if not (0 <= int(h) <= 23 and 0 <= int(m) <= 59):
            raise ValueError("HH:MM 형식")
        return f"{int(h):02d}:{int(m):02d}"

    @field_validator("snapshot_times")
    @classmethod
    def _snaps(cls, v: list[str]) -> list[str]:
        out = []
        for t in v[:12]:
            h, m = t.split(":")
            if not (0 <= int(h) <= 23 and 0 <= int(m) <= 59):
                raise ValueError(f"대표 시각 {t}: HH:MM 형식")
            out.append(f"{int(h):02d}:{int(m):02d}")
        return out

    @model_validator(mode="after")
    def _window(self):
        h0, m0 = map(int, self.start.split(":"))
        h1, m1 = map(int, self.end.split(":"))
        total = (h1 * 60 + m1) - (h0 * 60 + m0)
        if total <= 0:
            raise ValueError("분석 종료 시각은 시작 시각보다 늦어야 함")
        n = total / self.interval_min
        if abs(n - round(n)) > 1e-9:
            raise ValueError(f"분석 시간 {total}분이 간격 {self.interval_min}분으로 나누어 떨어지지 않음")
        if round(n) > 2000:
            raise ValueError("시간 구간 수가 너무 많음 (최대 2000)")
        if not (dt.date(2000, 1, 1) <= self.date <= dt.date(2100, 12, 31)):
            raise ValueError("분석일 범위 밖")
        return self

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        from zoneinfo import ZoneInfo

        try:
            ZoneInfo(v)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"알 수 없는 시간대 {v}") from exc
        return v


class RunOut(BaseModel):
    id: str
    project_id: str
    analysis_type: str
    status: Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]
    stage: str
    progress: float
    logs: list[dict]
    error: str | None
    params: dict
    cache_key: str
    job_backend: str
    job_id: str | None
    processing_seconds: float | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    reused: bool = False
    quality_overview: dict | None = None


class ReportOut(BaseModel):
    id: str
    run_id: str
    status: str
    stage: str
    error: str | None
    version: str
    files: dict[str, Any]
    quality: dict
    created_at: datetime
    finished_at: datetime | None
