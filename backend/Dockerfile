# GeoBuild Impact 3D - API / worker image (Python 3.12, Open3D, Playwright Chromium, Korean fonts)
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv PATH=/opt/venv/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
        fonts-noto-cjk libgl1 libgomp1 libglib2.0-0 libatomic1 libegl1 libx11-6 libxext6 libxrender1 libsm6 libusb-1.0-0 libxi6 libxrandr2 libxxf86vm1 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11.17 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
# Chromium + its system libraries for the PDF renderer
RUN playwright install --with-deps chromium && fc-list :lang=ko | head -3
COPY app ./app
COPY scripts ./scripts
ENV GEOBUILD_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
