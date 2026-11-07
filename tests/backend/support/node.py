"""Running Node.js tooling from tests (the benchmark CLI, n8n Code nodes)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from .settings import REPO_ROOT


def require(tool: str) -> str:
    path = shutil.which(tool)
    if path is None:
        pytest.skip(f"{tool} is required for this test")
    return path


def run_n8n_code_node(workflow: Path, node: str, payload: dict[str, Any]) -> Any:
    """Execute one Code node of an n8n workflow; returns its items or raises on a node error."""
    completed = subprocess.run(  # noqa: S603 - fixed command, repository files only
        [
            require("node"),
            str(Path(__file__).with_name("n8n_code_node.mjs")),
            str(workflow),
            node,
        ],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        cwd=REPO_ROOT,
    )
    out = json.loads(completed.stdout or "{}")
    if completed.returncode != 0:
        raise RuntimeError(out.get("error", completed.stderr))
    return out


_EVALUATE = """
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const { expression, json } = JSON.parse(input);
  const body = expression.replace(/^=\\{\\{/, '').replace(/\\}\\}$/, '');
  const value = new Function('$json', `return (${body});`)(json);
  process.stdout.write(JSON.stringify(value));
});
"""


def evaluate_n8n_expression(expression: str, json_context: Any) -> Any:
    """Evaluate an n8n `={{ ... }}` expression that only reads `$json`, as n8n would."""
    completed = subprocess.run(  # noqa: S603 - fixed command, repository expressions only
        [require("node"), "-e", _EVALUATE],
        input=json.dumps({"expression": expression, "json": json_context}),
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    return json.loads(completed.stdout)
