"""Job dispatch: Redis + RQ (Railway-hosted Redis by default) with an explicit in-process thread fallback.

The fallback is used only when Redis is unreachable or no RQ worker is alive; the backend actually used is
stored on the AnalysisRun/Report row and shown in the UI so it is never hidden.
"""
from __future__ import annotations

import threading
from urllib.parse import urlparse

from .config import JOB_BACKEND, REDIS_URL, RQ_QUEUE

TASKS = {"analysis": "app.runner.execute", "report": "app.report.builder.build_report"}


def _redis():
    import redis

    return redis.from_url(REDIS_URL, socket_connect_timeout=5, socket_timeout=30, health_check_interval=30)


def redis_status() -> dict:
    if not REDIS_URL:
        return {"configured": False, "ok": False, "workers": 0, "host": None}
    host = urlparse(REDIS_URL).hostname
    try:
        from rq import Worker

        r = _redis()
        r.ping()
        workers = Worker.all(connection=r)
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)

        def fresh(w) -> bool:  # killed workers stay registered until their TTL expires
            hb = w.last_heartbeat
            return hb is not None and (now - hb.replace(tzinfo=timezone.utc)).total_seconds() < 480

        alive = [w for w in workers if RQ_QUEUE in w.queue_names() and fresh(w)]
        return {"configured": True, "ok": True, "workers": len(alive), "host": host, "provider": "Railway" if host and ("rlwy" in host or host.endswith(".railway.internal")) else "custom",
                "queue": RQ_QUEUE,
                "version": r.info().get("redis_version")}
    except Exception as exc:  # noqa: BLE001
        return {"configured": True, "ok": False, "workers": 0, "host": host, "error": str(exc)[:200]}


def _run_local(kind: str, obj_id: str) -> None:
    import importlib

    mod, fn = TASKS[kind].rsplit(".", 1)
    getattr(importlib.import_module(mod), fn)(obj_id)


def enqueue(kind: str, obj_id: str) -> tuple[str, str | None, str | None]:
    """Return (backend, job_id, note)."""
    if JOB_BACKEND == "rq":
        st = redis_status()
        if st["ok"] and st["workers"] > 0:
            from rq import Queue

            q = Queue(RQ_QUEUE, connection=_redis())
            job = q.enqueue(TASKS[kind], obj_id, job_timeout=3600, result_ttl=86400, failure_ttl=86400 * 7)
            return "rq", job.id, f"Redis({st.get('provider')}) 큐 '{RQ_QUEUE}' 등록"
        note = "Redis 연결 실패" if not st["ok"] else "활성 RQ worker 없음"
        threading.Thread(target=_run_local, args=(kind, obj_id), daemon=True).start()
        return "thread-fallback", None, f"{note} → API 프로세스 내 스레드로 대체 실행"
    threading.Thread(target=_run_local, args=(kind, obj_id), daemon=True).start()
    return "thread", None, "JOB_BACKEND=thread (Redis 미사용 로컬 모드)"
