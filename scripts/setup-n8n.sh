#!/usr/bin/env bash
# Automates n8n first-time setup: creates the owner account and imports + activates every
# workflow in n8n/workflows (CI failure workflow and multi-SIEM SOC workflow).
# Run once after `docker compose up --build -d`.

set -e

N8N_URL="http://localhost:5678"
EMAIL="admin@orchestrator.local"
PASSWORD="Orchestrator123!"

# Resolve project root regardless of where the script is called from
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW_DIR="$PROJECT_ROOT/n8n/workflows"

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

# Import, update and activate one workflow file. The workflow id comes from the file's "id".
import_workflow() {
  local file="$1"
  local node_path="$file"
  # Convert POSIX path to a form Node.js on Windows can read
  if command -v cygpath > /dev/null 2>&1; then
    node_path="$(cygpath -w "$file")"
  fi
  local default_id
  default_id=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).id || '')" "$node_path")

  echo "==> Preparing $(basename "$file") (stripping tags field)..."
  local clean
  clean=$(node -e "
    const w = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    delete w.tags;
    w.active = false;
    process.stdout.write(JSON.stringify(w));
  " "$node_path")

  echo "==> Importing workflow via API..."
  local import_resp workflow_id
  import_resp=$(echo "$clean" | curl -s -X POST "$N8N_URL/rest/workflows" \
    -H "Content-Type: application/json" \
    -H "Cookie: n8n-auth=$TOKEN" \
    -d @-)
  workflow_id=$(echo "$import_resp" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{ try { const r=JSON.parse(d); console.log((r.data&&r.data.id)||''); } catch(e){} })")

  if [ -z "$workflow_id" ]; then
    # Workflow already exists — update it instead
    if echo "$import_resp" | grep -q "exists already"; then
      echo "    Workflow already exists, updating..."
      local update_resp
      update_resp=$(echo "$clean" | curl -s -X PUT "$N8N_URL/rest/workflows/$default_id" \
        -H "Content-Type: application/json" \
        -H "Cookie: n8n-auth=$TOKEN" \
        -d @-)
      workflow_id=$(echo "$update_resp" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{ try { const r=JSON.parse(d); console.log((r.data&&r.data.id)||process.argv[1]); } catch(e){ console.log(process.argv[1]); } })" "$default_id")
    else
      echo "ERROR: Workflow import failed. Response: $import_resp"
      exit 1
    fi
  fi
  echo "    Workflow ready: ID=$workflow_id"

  echo "==> Activating workflow..."
  local act_resp active
  act_resp=$(curl -s -X PATCH "$N8N_URL/rest/workflows/$workflow_id" \
    -H "Content-Type: application/json" \
    -H "Cookie: n8n-auth=$TOKEN" \
    -d '{"active":true}')
  active=$(echo "$act_resp" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{ try { const r=JSON.parse(d); console.log(r.data&&r.data.active); } catch(e){} })")

  if [ "$active" = "true" ]; then
    echo "    Workflow is active."
  else
    echo "    Note: active=$active — open http://localhost:5678 and activate manually if needed."
  fi
}

for workflow_file in "$WORKFLOW_DIR"/*.json; do
  import_workflow "$workflow_file"
done

echo ""
echo "==> Setup complete!"
echo "    n8n UI:        $N8N_URL"
echo "    Login email:   $EMAIL"
echo "    Login password: $PASSWORD"
echo "    CI webhook:    $N8N_URL/webhook/test-results"
echo "    SOC webhook:   $N8N_URL/webhook/soc-alerts   (Splunk, Sentinel or Wazuh payloads)"
