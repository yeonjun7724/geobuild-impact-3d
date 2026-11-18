"""Runtime configuration. Values come from environment variables or backend/.env."""
from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


def _load_dotenv() -> None:
    env_file = BACKEND_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

DATA_DIR = Path(os.environ.get("GEOBUILD_DATA_DIR", BACKEND_DIR / "data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{(DATA_DIR / 'geobuild.db').as_posix()}")
REDIS_URL = os.environ.get("REDIS_URL", "")
# "rq" (Redis + RQ worker process) or "thread" (in-process fallback, no Redis)
JOB_BACKEND = os.environ.get("JOB_BACKEND", "rq" if REDIS_URL else "thread")
RQ_QUEUE = os.environ.get("RQ_QUEUE", "geobuild-analysis")

FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173")
API_PUBLIC_URL = os.environ.get("API_PUBLIC_URL", "http://localhost:8000")

ENGINE_NAME = "GeoBuild Impact 3D analysis engine"
ENGINE_VERSION = "0.1.0"
ALGORITHM_VERSION = "abc-2026.11.2"  # bump whenever numerical rules change (part of cache key)


def code_commit_hash() -> str | None:
    """Return the git HEAD commit (checkout) or the commit the deployment was built from (Railway env), else None."""
    env_sha = os.environ.get("RAILWAY_GIT_COMMIT_SHA") or os.environ.get("GIT_COMMIT_SHA")
    if env_sha:
        return env_sha
    head = REPO_DIR / ".git" / "HEAD"
    try:
        ref = head.read_text().strip()
        if ref.startswith("ref:"):
            ref_path = REPO_DIR / ".git" / ref.split(" ", 1)[1]
            if ref_path.exists():
                return ref_path.read_text().strip()
            packed = REPO_DIR / ".git" / "packed-refs"
            if packed.exists():
                for line in packed.read_text().splitlines():
                    if line.endswith(ref.split(" ", 1)[1]):
                        return line.split(" ")[0]
            return None
        return ref
    except OSError:
        return None
