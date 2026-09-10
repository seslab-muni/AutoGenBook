FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    # texlive-luatex alone only ships LuaTeX-specific style packages; the actual
    # lualatex format (and the /usr/bin/lualatex binary) is built from the fmtutil.cnf
    # stanza that texlive-latex-base provides, so both are required.
    && apt-get install -y --no-install-recommends pandoc texlive-luatex texlive-latex-base tesseract-ocr poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && which lualatex

WORKDIR /app
COPY requirements.txt ./requirements.txt
COPY api/requirements.txt ./api/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt -r api/requirements.txt
COPY . .

RUN groupadd -g 1000 app \
    && useradd -u 1000 -g app -d /app -M app \
    && mkdir -p /app/runs /app/kb_cache \
    && chown -R app:app /app

ENV HOME=/app
USER 1000

EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
