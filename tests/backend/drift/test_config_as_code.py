"""Configuration as code: response playbooks, the triage policy and runbooks are validated
against the exported schemas and against each other, before they can reach a running system."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
import yaml

from support.clients import IngestionClient
from support.contracts import errors
from support.settings import REPO_ROOT

pytestmark = pytest.mark.drift

PLAYBOOKS = sorted((REPO_ROOT / "config" / "playbooks").glob("*.yaml"))
RUNBOOKS = REPO_ROOT / "docs" / "runbooks"
POLICY: dict[str, Any] = json.loads((REPO_ROOT / "config" / "soc-triage-policy.json").read_text())
CONTAINMENT = {"firewall.block_ip", "edr.isolate_host", "edr.kill_process"}


def _load(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = yaml.safe_load(path.read_text())
    return data


@pytest.mark.parametrize("path", PLAYBOOKS, ids=lambda p: p.stem)
def test_playbook_matches_the_schema(path: Path) -> None:
    assert errors("playbook", _load(path)) == []


@pytest.mark.parametrize("path", PLAYBOOKS, ids=lambda p: p.stem)
def test_every_containment_step_requires_human_approval(path: Path) -> None:
    for step in _load(path)["steps"]:
        if step["action"] in CONTAINMENT:
            assert step["approval"] == "required", f"{path.stem}/{step['id']}"


@pytest.mark.parametrize("path", PLAYBOOKS, ids=lambda p: p.stem)
def test_runbooks_named_by_a_playbook_exist(path: Path) -> None:
    for name in re.findall(r"runbook ([a-z0-9-]+\.md)", path.read_text()):
        assert (RUNBOOKS / name).is_file(), f"{path.stem} references missing {name}"


def test_playbook_ids_are_unique_and_match_file_names() -> None:
    ids = [_load(p)["id"] for p in PLAYBOOKS]
    assert len(set(ids)) == len(ids)
    assert ids == [p.stem for p in PLAYBOOKS]


@pytest.mark.parametrize(
    "path", sorted(p for p in RUNBOOKS.glob("*.md") if p.name != "README.md"), ids=lambda p: p.stem
)
def test_runbook_declares_the_techniques_used_to_select_it(path: Path) -> None:
    match = re.search(r"^Techniques:\s*(.+)$", path.read_text(), re.MULTILINE)
    assert match, f"{path.name} has no 'Techniques:' line"
    techniques = [t.strip() for t in match.group(1).split(",")]
    # MITRE ATT&CK IDs, or the selector's `fallback` sentinel (soc-runbooks.ts).
    assert all(re.fullmatch(r"T\d{4}(\.\d{3})?|fallback", t) for t in techniques), techniques


def test_exactly_one_runbook_is_the_fallback() -> None:
    fallbacks = [
        p.name
        for p in RUNBOOKS.glob("*.md")
        if re.search(r"^Techniques:\s*fallback\s*$", p.read_text(), re.MULTILINE)
    ]
    assert fallbacks == ["generic-alert-triage.md"]


def test_triage_policy_matches_the_schema() -> None:
    assert errors("triage-policy", POLICY) == []


def test_triage_policy_entries_are_owned_and_unexpired() -> None:
    now = datetime.now(UTC)
    for entry in POLICY["allowlist"] + POLICY["knownBenign"]:
        assert entry["owner"], entry["id"]
        expires = datetime.fromisoformat(entry["expiresAt"].replace("Z", "+00:00"))
        assert expires > now, f"{entry['id']} expired on {entry['expiresAt']}: renew or remove it"


def test_running_service_loaded_every_playbook(ingestion: IngestionClient) -> None:
    body = ingestion.get("/api/responses/playbooks").raise_for_status().json()
    loaded = {p["id"] for p in body["playbooks"]}
    assert loaded == {_load(p)["id"] for p in PLAYBOOKS}


# --- service configuration: every variable the code validates is documented ---------------


def test_every_ingestion_setting_is_documented_in_env_example() -> None:
    schema = (REPO_ROOT / "apps/ingestion-service/src/config.ts").read_text()
    body = schema[schema.index("const ConfigSchema") : schema.index(".superRefine")]
    settings = set(re.findall(r"^\s{4}([A-Z][A-Z0-9_]+):", body, flags=re.M))
    documented = set(
        re.findall(
            r"^#?\s?([A-Z][A-Z0-9_]+)=",
            (REPO_ROOT / ".env.example").read_text(),
            flags=re.M,
        )
    )

    assert len(settings) > 25, "the schema parser found too few settings"
    assert sorted(settings - documented) == []
