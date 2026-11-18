"""RQ worker entry point:  uv run python -m app.worker

On Windows os.fork() is unavailable, so SimpleWorker (runs jobs in the worker process) with the
timer-based death penalty is used. On Linux (docker) the regular forking Worker is used.
"""
from __future__ import annotations

import os
import sys

from redis import from_url
from rq import Queue
from rq.timeouts import TimerDeathPenalty
from rq.worker import SimpleWorker, Worker

from .config import REDIS_URL, RQ_QUEUE
from .db import init_db


class WindowsWorker(SimpleWorker):
    death_penalty_class = TimerDeathPenalty


def main() -> None:
    if not REDIS_URL:
        print("REDIS_URL 미설정 - worker를 시작할 수 없음 (JOB_BACKEND=thread 로 API 단독 실행 가능)")
        sys.exit(2)
    init_db()
    conn = from_url(REDIS_URL)
    q = Queue(RQ_QUEUE, connection=conn)
    cls = WindowsWorker if os.name == "nt" else Worker
    w = cls([q], connection=conn)
    print(f"[worker] {cls.__name__} listening on '{RQ_QUEUE}' @ {conn.connection_pool.connection_kwargs.get('host')}")
    w.work(with_scheduler=False)


if __name__ == "__main__":
    main()
