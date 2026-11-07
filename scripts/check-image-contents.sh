#!/usr/bin/env bash
# The ingestion image ships the server and the worker only: the offline evaluation tooling lives
# in packages/evaluation (architecture step 7) and must not reach it. Run against the Compose stack.
set -euo pipefail
docker compose exec -T ingestion-service sh -ec '
  test -f /app/apps/ingestion-service/dist/server.js
  test -f /app/apps/ingestion-service/dist/workers/investigation-worker.js
  for path in /app/apps/ingestion-service/dist/benchmark /app/apps/ingestion-service/dist/scripts \
              /app/apps/ingestion-service/src/benchmark /app/apps/ingestion-service/src/scripts \
              /app/packages/evaluation; do
    if [ -e "$path" ]; then echo "unexpected in the image: $path"; exit 1; fi
  done
  echo "image contains the server and worker only"'
