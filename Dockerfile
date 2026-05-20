FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app app

WORKDIR /app

COPY pyproject.toml README.md README.zh-CN.md ./
COPY src ./src

RUN pip install --no-cache-dir -e . \
    && mkdir -p /data /workspaces \
    && chown -R app:app /app /data /workspaces

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5).read()"

CMD ["uvicorn", "code_review_agent.api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
