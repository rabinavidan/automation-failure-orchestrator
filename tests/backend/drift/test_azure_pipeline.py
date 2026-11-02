"""azure-pipelines.yml must run the same gates as GitHub Actions with the same tool versions."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

from support.settings import REPO_ROOT

pytestmark = pytest.mark.drift

GH: dict[str, Any] = yaml.safe_load((REPO_ROOT / ".github/workflows/ci.yml").read_text())
ADO: dict[str, Any] = yaml.safe_load((REPO_ROOT / "azure-pipelines.yml").read_text())
ADO_JOBS = [job for stage in ADO["stages"] for job in stage["jobs"]]


def _expand(steps: list[dict[str, Any]], base: Path = REPO_ROOT) -> list[dict[str, Any]]:
    """Inline step templates so commands inside templates count."""
    out: list[dict[str, Any]] = []
    for step in steps:
        if "template" in step:
            path = base / step["template"]
            out += _expand(yaml.safe_load(path.read_text())["steps"], path.parent)
        else:
            out.append(step)
    return out


def _lines(script: str) -> list[str]:
    return [re.sub(r"\s+", " ", line.strip()) for line in script.splitlines() if line.strip()]


ADO_COMMANDS = {
    line
    for job in ADO_JOBS
    for step in _expand(job["steps"])
    for line in _lines(step.get("script", ""))
}


def _gh_step(job: str, predicate: Any) -> dict[str, Any]:
    [step] = [s for s in GH["jobs"][job]["steps"] if predicate(s)][:1]
    return dict(step)


def _uses(prefix: str) -> Any:
    return lambda step: str(step.get("uses", "")).startswith(prefix)


def test_tool_versions_match_github_actions() -> None:
    uses = _uses
    node = _gh_step("quality", uses("actions/setup-node"))
    python = _gh_step("python-quality", uses("actions/setup-python"))
    terraform = _gh_step("terraform", uses("hashicorp/setup-terraform"))
    checkov = _gh_step("terraform", lambda s: "checkov==" in s.get("run", ""))

    variables = ADO["variables"]
    assert variables["nodeVersion"] == str(node["with"]["node-version"])
    assert variables["pythonVersion"] == str(python["with"]["python-version"])
    assert variables["terraformVersion"] == str(terraform["with"]["terraform_version"])
    assert f"checkov=={variables['checkovVersion']}" in checkov["run"]


@pytest.mark.parametrize(
    "job", ["quality", "python-quality", "terraform", "production-dependencies", "container-smoke"]
)
def test_azure_runs_every_command_of_the_github_job(job: str) -> None:
    for step in GH["jobs"][job]["steps"]:
        for command in _lines(step.get("run", "")):
            if command.startswith("pip install --quiet checkov"):
                continue  # version pinned through a pipeline variable
            normalized = re.sub(r"\$\{\{[^}]+\}\}", "", command).strip()
            assert any(normalized in ado for ado in ADO_COMMANDS), f"missing in Azure: {command}"


def test_images_are_scanned_with_the_same_trivy_gate() -> None:
    gate = _gh_step("image-security", lambda s: "trivy" in str(s.get("uses", "")))
    assert gate["with"]["exit-code"] == "1"
    assert gate["with"]["severity"] == "CRITICAL"
    [image_job] = [j for j in ADO_JOBS if j["job"] == "image_security"]
    scanned = sorted(
        s["parameters"]["image"].split(":")[0]
        for s in image_job["steps"]
        if str(s.get("template", "")).endswith("image-scan.yml")
    )
    assert scanned == [
        "orchestrator-dashboard",
        "orchestrator-enrichment",
        "orchestrator-ingestion",
    ]
    scan = _expand([next(s for s in image_job["steps"] if "template" in s)])[0]["script"]
    for flag in ["--exit-code 1", "--ignore-unfixed", "--severity CRITICAL"]:
        assert flag in scan


def test_containers_stage_is_gated_and_artifacts_publish_only_from_main() -> None:
    [containers] = [s for s in ADO["stages"] if s["stage"] == "Containers"]
    assert containers["dependsOn"] == "Quality"
    [publish] = [
        s for j in ADO_JOBS for s in j["steps"] if s.get("task") == "PublishPipelineArtifact@1"
    ]
    assert publish["inputs"]["artifact"] == "images-$(imageTag)"
    assert "'refs/heads/main'" in publish["condition"]


def test_templates_exist_and_nothing_deploys_or_needs_secrets() -> None:
    for job in ADO_JOBS:
        for step in job["steps"]:
            if "template" in step:
                assert (REPO_ROOT / step["template"]).is_file(), step["template"]
    raw = (REPO_ROOT / "azure-pipelines.yml").read_text()
    assert not re.search(r"deployment:|AzureCLI@|AzureWebApp@|variableGroup|group:", raw)
