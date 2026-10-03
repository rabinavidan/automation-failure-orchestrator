FROM python:3.12-slim AS builder

WORKDIR /build
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir --upgrade pip \
 && pip wheel --no-cache-dir --wheel-dir /wheels .

FROM python:3.12-slim AS runtime

# Patch OS packages, then run as an unprivileged user.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home enrichment

COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir /wheels/* && rm -rf /wheels

USER enrichment
ENV PYTHONUNBUFFERED=1 PORT=3003
EXPOSE 3003

CMD ["sh", "-c", "exec uvicorn enrichment_service.main:app --host 0.0.0.0 --port ${PORT}"]
