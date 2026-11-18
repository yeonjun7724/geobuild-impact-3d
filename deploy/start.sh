#!/bin/sh
# API + RQ worker in one container (they share the /data volume: results written by the worker are served by the API).
set -e
PORT="${PORT:-8000}"
export FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:${PORT}}"   # used by the report job for the optional 3D capture
mkdir -p "${GEOBUILD_DATA_DIR:-/data}"
python -m scripts.migrate
if [ -n "$REDIS_URL" ]; then
  ( while true; do python -m app.worker || true; echo "[start] worker exited, restarting in 5s"; sleep 5; done ) &
fi
exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT" --proxy-headers --forwarded-allow-ips="*"
