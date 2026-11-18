# GeoBuild Impact 3D - single Railway service: React/Cesium build + FastAPI + RQ worker + Chromium (PDF)
# ---------- web build
FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npx tsc -b && npx vite build

# ---------- runtime
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
        fonts-noto-cjk libgl1 libgomp1 libglib2.0-0 libatomic1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11.17 /uv /usr/local/bin/uv
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
RUN playwright install --with-deps chromium && fc-list :lang=ko | head -2
COPY backend/app ./app
COPY backend/scripts ./scripts
COPY --from=web /web/dist ./web
COPY deploy/start.sh ./start.sh
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh
ENV WEB_DIST=/app/web GEOBUILD_DATA_DIR=/data JOB_BACKEND=rq
EXPOSE 8000
CMD ["./start.sh"]
