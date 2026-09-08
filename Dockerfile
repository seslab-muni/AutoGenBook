FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends pandoc texlive-luatex tesseract-ocr poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Non-root user the api/worker/migrate services all run as (docker-compose.yml
# builds all three from this image). `runs_data`/`kb_extract_cache` are named
# volumes mounted at /app/runs and /app/kb_cache; Docker seeds a new, empty
# named volume from the image directory it's mounted over, so chowning them
# here (before the volumes are attached) is what gives this user write access
# on first run. An already-existing (root-owned) volume from a prior root-run
# deployment needs a one-time `chown -R 1000:1000` on the host/volume to match.
RUN groupadd --system --gid 1000 app \
    && useradd --system --uid 1000 --gid app --home-dir /app --shell /usr/sbin/nologin app

WORKDIR /app
COPY requirements.txt ./requirements.txt
COPY api/requirements.txt ./api/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt -r api/requirements.txt
COPY . .
RUN mkdir -p /app/runs /app/kb_cache \
    && chown -R app:app /app

USER app

EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
