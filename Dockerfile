FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    # texlive-luatex alone only ships LuaTeX-specific style packages; the actual
    # lualatex format (and the /usr/bin/lualatex binary) is built from the fmtutil.cnf
    # stanza that texlive-latex-base provides, so both are required.
    #
    # The preamble the CLI emits (book_builder.py:build_latex_document and the
    # paper/scientist pipelines) pulls in packages spread over several Debian
    # bundles - without them `lualatex` dies at the first `\usepackage` it can't
    # resolve ("File `lastpage.sty' not found") and every PDF export fails:
    #   texlive-latex-recommended  mathtools, microtype, listings, xcolor,
    #                              booktabs, underscore, fontspec, unicode-math, ...
    #   texlive-latex-extra        lastpage, xurl, listingsutf8, ...
    #   texlive-science            physics (book mode only)
    #   texlive-lang-czechslovak   babel's `czech` option (`czech.ldf`)
    && apt-get install -y --no-install-recommends \
        pandoc \
        texlive-luatex \
        texlive-latex-base \
        texlive-latex-recommended \
        texlive-latex-extra \
        texlive-science \
        texlive-lang-czechslovak \
        tesseract-ocr \
        poppler-utils \
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
