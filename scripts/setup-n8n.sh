#!/usr/bin/env bash
# Automates n8n first-time setup: creates the owner account and imports + activates the workflow.
# Run once after `docker compose up --build -d`.

set -e

N8N_URL="http://localhost:5678"
EMAIL="admin@orchestrator.local"
PASSWORD="Orchestrator123!"

# Resolve project root regardless of where the script is called from
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW_FILE="$PROJECT_ROOT/n8n/workflows/main-workflow.json"

echo "==> Waiting for n8n to be ready..."
until curl -sf "$N8N_URL/rest/settings" > /dev/null 2>&1; do sleep 2; done
echo "    n8n is up."

echo "==> Creating owner account..."
SETUP_RESP=$(curl -s -X POST "$N8N_URL/rest/owner/setup" \
  -H "Content-Type: application/json" \
  -d "{\"firstName\":\"Admin\",\"lastName\":\"User\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

if echo "$SETUP_RESP" | grep -q '"role":"global:owner"'; then
  echo "    Owner account created: $EMAIL"
elif echo "$SETUP_RESP" | grep -q "already"; then
  echo "    Owner account already exists."
else
  echo "    Note: $SETUP_RESP"
fi

echo "==> Logging in..."
TOKEN=$(curl -sv -X POST "$N8N_URL/rest/login" \
  -H "Content-Type: application/json" \
  -d "{\"emailOrLdapLoginId\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" 2>&1 \
  | grep "Set-Cookie: n8n-auth=" \
  | sed 's/.*n8n-auth=\([^;]*\).*/\1/')

if [ -z "$TOKEN" ]; then
  echo "ERROR: Could not extract auth token. Check credentials."
  exit 1
fi
echo "    Logged in successfully."

echo "==> Preparing workflow (stripping tags field)..."
# Convert POSIX path to a form Node.js on Windows can read
if command -v cygpath > /dev/null 2>&1; then
  NODE_PATH="$(cygpath -w "$WORKFLOW_FILE")"
else
  NODE_PATH="$WORKFLOW_FILE"
fi
CLEAN_WORKFLOW=$(node -e "
  const w = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  delete w.tags;
  w.active = false;
  process.stdout.write(JSON.stringify(w));
" "$NODE_PATH")

echo "==> Importing workflow via API..."
IMPORT_RESP=$(echo "$CLEAN_WORKFLOW" | curl -s -X POST "$N8N_URL/rest/workflows" \
  -H "Content-Type: application/json" \
  -H "Cookie: n8n-auth=$TOKEN" \
  -d @-)

WORKFLOW_ID=$(echo "$IMPORT_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{ try { const r=JSON.parse(d); console.log((r.data&&r.data.id)||''); } catch(e){} })")

if [ -z "$WORKFLOW_ID" ]; then
  # Workflow already exists — update it instead
  if echo "$IMPORT_RESP" | grep -q "exists already"; then
    echo "    Workflow already exists, updating..."
    WORKFLOW_ID="main-workflow"
    UPDATE_RESP=$(echo "$CLEAN_WORKFLOW" | curl -s -X PUT "$N8N_URL/rest/workflows/$WORKFLOW_ID" \
      -H "Content-Type: application/json" \
      -H "Cookie: n8n-auth=$TOKEN" \
      -d @-)
    WORKFLOW_ID=$(echo "$UPDATE_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{ try { const r=JSON.parse(d); console.log((r.data&&r.data.id)||'main-workflow'); } catch(e){ console.log('main-workflow'); } })")
  else
    echo "ERROR: Workflow import failed. Response: $IMPORT_RESP"
    exit 1
  fi
fi
echo "    Workflow ready: ID=$WORKFLOW_ID"

echo "==> Activating workflow..."
ACT_RESP=$(curl -s -X PATCH "$N8N_URL/rest/workflows/$WORKFLOW_ID" \
  -H "Content-Type: application/json" \
  -H "Cookie: n8n-auth=$TOKEN" \
  -d '{"active":true}')

ACTIVE=$(echo "$ACT_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{ try { const r=JSON.parse(d); console.log(r.data&&r.data.active); } catch(e){} })")

if [ "$ACTIVE" = "true" ]; then
  echo "    Workflow is active."
else
  echo "    Note: active=$ACTIVE — open http://localhost:5678 and activate manually if needed."
fi

echo ""
echo "==> Setup complete!"
echo "    n8n UI:        $N8N_URL"
echo "    Login email:   $EMAIL"
echo "    Login password: $PASSWORD"
echo "    Webhook URL:   $N8N_URL/webhook/test-results"
