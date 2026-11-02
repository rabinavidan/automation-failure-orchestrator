"""Regression gate: deterministic decisions on the labeled benchmark must not get worse.

Runs `npm run benchmark -- --configs=deterministic` (no model) and compares it with the
committed baseline in benchmark/results/baseline-deterministic. Improvements pass; a lower
accuracy or any case that flips from right to wrong fails, naming the cases.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from support.node import require
from support.settings import REPO_ROOT

pytestmark = pytest.mark.evaluation

BASELINE = REPO_ROOT / "benchmark" / "results" / "baseline-deterministic"


def _outcomes(directory: Path) -> dict[str, dict[str, Any]]:
    rows = (json.loads(line) for line in (directory / "outcomes.jsonl").read_text().splitlines())
    return {row["caseId"]: row["decision"] for row in rows if row}


@pytest.fixture(scope="module")
def current(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("benchmark")
    completed = subprocess.run(  # noqa: S603 - fixed command
        [require("npm"), "run", "benchmark", "--", "--configs=deterministic", f"--out={out}"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout[-2000:] + completed.stderr[-2000:]
    return out


def _decision(directory: Path) -> dict[str, Any]:
    summary = json.loads((directory / "summary.json").read_text())
    [deterministic] = [s for s in summary["summaries"] if s["config"] == "deterministic"]
    decision: dict[str, Any] = deterministic["decision"]
    return decision


def test_baseline_uses_the_current_dataset(current: Path) -> None:
    meta_now = json.loads((current / "summary.json").read_text())["meta"]
    meta_base = json.loads((BASELINE / "summary.json").read_text())["meta"]
    assert meta_now["dataset"] == meta_base["dataset"], (
        "dataset changed: regenerate the baseline with npm run benchmark -- "
        "--configs=deterministic --out=benchmark/results/baseline-deterministic"
    )


@pytest.mark.parametrize("track", ["ci", "soc"])
def test_accuracy_does_not_regress(current: Path, track: str) -> None:
    now = _decision(current)["byTrack"][track]
    base = _decision(BASELINE)["byTrack"][track]
    assert now["n"] == base["n"]
    assert now["accuracy"] >= base["accuracy"], f"{track} accuracy {now} < baseline {base}"
    assert now["macroF1"] >= base["macroF1"]


def test_no_case_flips_from_right_to_wrong(current: Path) -> None:
    now, base = _outcomes(current), _outcomes(BASELINE)
    regressed = [
        f"{case}: expected {base[case]['expected']}, now {now[case]['predicted']}"
        for case in base
        if base[case]["expected"] == base[case]["predicted"]
        and now[case]["predicted"] != now[case]["expected"]
    ]
    assert regressed == []
