# Skillware runner: real Skillware skills (Python) for Agent Console. Build context: repo root.
FROM python:3.12-slim
WORKDIR /opt/skillware
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/opt/models FASTEMBED_CACHE_PATH=/opt/models/fastembed
COPY skillware-runner/requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt
COPY vendor/skillware /opt/skillware
RUN pip install --no-deps /opt/skillware
# Download the embedding model once at build time (used by context_optimizer / novelty_extractor).
# Best effort: if Hugging Face is unreachable during the build, it downloads on first use instead.
RUN useradd --system --uid 10001 runner && mkdir -p /opt/models \
 && (python -c "from fastembed import TextEmbedding; TextEmbedding()" || echo "embedding model will download on first use") \
 && chown -R runner /opt/models
COPY skillware-runner/runner.py /app/runner.py
RUN chmod -R a+rX /opt/skillware /app
USER runner
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=4).status==200 else 1)"
CMD ["python", "/app/runner.py"]
