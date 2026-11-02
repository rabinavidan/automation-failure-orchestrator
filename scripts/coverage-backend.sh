#!/usr/bin/env bash
# Backend coverage gate: how much of the TypeScript backend the black-box pytest suite exercises.
#
# Starts the services natively (no Docker), the three API instances under NODE_V8_COVERAGE,
# runs the whole pytest suite against them, shuts them down gracefully so V8 writes its
# coverage, and maps it back to TypeScript through source maps with c8.
#
#   npm run build && pip install "./tests/backend[dev]" "./apps/enrichment-service"
#   npm run coverage:backend            # needs PostgreSQL on localhost:5432 (orchestrator/orchestrator)
#
# Thresholds: COVERAGE_LINES (default 80) and COVERAGE_BRANCHES (default 70).
# Report: coverage/backend/index.html (and coverage-summary.json).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/coverage/backend"
V8="$OUT/v8"
LOGS="$OUT/logs"
rm -rf "$OUT" && mkdir -p "$V8" "$LOGS"

DATABASE_URL="${DATABASE_URL:-postgresql://orchestrator:orchestrator@localhost:5432/orchestrator}"
REVIEWER_TOKENS='demo-soc-responder:soc_responder:demo-soc-responder-token-0001;demo-ci-reviewer:ci_reviewer:demo-ci-reviewer-token-00001;demo-admin:admin:demo-admin-token-0000000001'
PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

wait_for() {
  for _ in $(seq 1 60); do
    curl -sf "$1" >/dev/null && return 0
    sleep 1
  done
  echo "timed out waiting for $1" >&2
  return 1
}

PORT=3002 node apps/mock-integrations/dist/server.js >"$LOGS/mock.log" 2>&1 &
PIDS+=($!)
PORT=11434 node scripts/ollama-demo-stub.mjs >"$LOGS/stub.log" 2>&1 &
PIDS+=($!)
(cd apps/enrichment-service && PORT=3003 ENRICHMENT_MODE=mock WEBHOOK_SECRET=local-dev-secret \
  exec uvicorn enrichment_service.main:app --port 3003) >"$LOGS/enrichment.log" 2>&1 &
PIDS+=($!)

# start_api <port> <log name> [extra env assignments...]
API_PIDS=()
start_api() {
  local port=$1 name=$2
  shift 2
  (cd apps/ingestion-service && exec env PORT="$port" DATABASE_URL="$DATABASE_URL" \
    INTEGRATION_MODE=mock JIRA_BASE_URL=http://localhost:3002 JIRA_PROJECT_KEY=AUTO \
    JIRA_EMAIL=test@example.com JIRA_API_TOKEN=mock-token \
    SLACK_WEBHOOK_URL=http://localhost:3002/slack/services/T00/B00/xxx \
    WEBHOOK_SECRET=local-dev-secret REVIEWER_TOKENS="$REVIEWER_TOKENS" \
    RECOVERY_PASS_THRESHOLD=3 FLAKY_HISTORY_WINDOW=5 SOC_ACTIONS_BASE_URL=http://localhost:3002 \
    SOC_PROTECTED_HOSTS=dc-01,dc-02 ENRICHMENT_URL=http://localhost:3003 RAG_ENABLED=false \
    OLLAMA_HOST=http://localhost:11434 OLLAMA_MODEL=demo-stub OLLAMA_TIMEOUT_MS=10000 \
    MULTI_AGENT_ENABLED=true NODE_V8_COVERAGE="$V8" "$@" node dist/server.js) \
    >"$LOGS/$name.log" 2>&1 &
  API_PIDS+=($!)
}

wait_for http://localhost:3002/health
wait_for http://localhost:3003/health
start_api 3001 ingestion AI_ENABLED=false
wait_for http://localhost:3001/health # migrations run once, before the other instances start
start_api 3011 ingestion-ai AI_ENABLED=true EVIDENCE_TRANSPORT=mcp \
  MCP_SCOPE_SECRET=pytest-mcp-scope-secret-0001
start_api 3012 ingestion-single-agent AI_ENABLED=true MULTI_AGENT_ENABLED=false
wait_for http://localhost:3011/health
wait_for http://localhost:3012/health

status=0
# System tests need their own stacks (dashboard, LGTM, moto, Shuffle) and run in their own jobs.
# NODE_V8_COVERAGE is inherited by the Node CLIs the evaluation layer runs (benchmark,
# compare:versions, sample:failure-modes through tsx), so offline tooling counts too.
(cd tests/backend && TEST_DATABASE_URL="${TEST_DATABASE_URL:-$DATABASE_URL}" NODE_V8_COVERAGE="$V8" pytest -m "not system" --junitxml="$OUT/junit.xml") || status=$?

# Graceful shutdown: V8 writes coverage when the process exits.
for pid in "${API_PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
for pid in "${API_PIDS[@]}"; do
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
done

# --all with --src on the compiled output: modules that no test loads count as 0%, instead of
# silently dropping out of the denominator. TypeScript run directly by tsx is included too.
npx c8 report \
  --temp-directory="$V8" --reports-dir="$OUT" \
  --reporter=text-summary --reporter=json-summary --reporter=html \
  --all --src=apps/ingestion-service/dist --src=packages/shared-types/dist \
  --src=packages/fingerprint-engine/dist --src=packages/failure-classifier/dist \
  --include='apps/ingestion-service/dist/**' --include='apps/ingestion-service/src/**' \
  --include='packages/shared-types/dist/**' --include='packages/fingerprint-engine/dist/**' \
  --include='packages/failure-classifier/dist/**' \
  --exclude='**/__tests__/**' --exclude='apps/ingestion-service/*/scripts/**' \
  --check-coverage --lines "${COVERAGE_LINES:-80}" --branches "${COVERAGE_BRANCHES:-70}" ||
  status=$((status == 0 ? 1 : status))

exit "$status"
