#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 - << PY
import json
from pathlib import Path
wf = json.loads(Path("$ROOT/workflow/research-content-workflow.json").read_text())
Path("/tmp/wf-n8n-import.json").write_text(json.dumps([wf]))
print("wrote /tmp/wf-n8n-import.json")
PY
export N8N_BLOCK_ENV_ACCESS_IN_NODE="${N8N_BLOCK_ENV_ACCESS_IN_NODE:-false}"
n8n import:workflow --input=/tmp/wf-n8n-import.json
