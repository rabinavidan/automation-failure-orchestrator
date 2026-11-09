"""The ingestion image ships the server and the worker only: the offline evaluation tooling lives
in packages/evaluation (architecture step 7) and must never reach it. Runs against the image the
Compose stack built; the container smoke job requires it with REQUIRE_STACKS=image."""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from support.settings import REPO_ROOT

pytestmark = pytest.mark.system

SERVICE = "ingestion-service"
SHIPPED = [
    "/app/apps/ingestion-service/dist/server.js",
    "/app/apps/ingestion-service/dist/workers/investigation-worker.js",
]
NOT_SHIPPED = [
    "/app/apps/ingestion-service/dist/benchmark",
    "/app/apps/ingestion-service/dist/scripts",
    "/app/apps/ingestion-service/src/benchmark",
    "/app/apps/ingestion-service/src/scripts",
    "/app/packages/evaluation",
]


def _required() -> bool:
    return "image" in {s.strip() for s in os.environ.get("REQUIRE_STACKS", "").split(",")}


def _unavailable(reason: str) -> None:
    if _required():
        pytest.fail(f"the ingestion image is required (REQUIRE_STACKS=image) but {reason}")
    pytest.skip(reason)


@pytest.fixture(scope="module")
def container_exec() -> list[str]:
    docker = shutil.which("docker")
    if docker is None:
        _unavailable("docker is not installed")
    assert docker is not None
    running = subprocess.run(  # noqa: S603 - fixed command
        [docker, "compose", "ps", "--status", "running", "--quiet", SERVICE],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if running.returncode != 0 or not running.stdout.strip():
        _unavailable(f"the Compose service {SERVICE} is not running")
    return [docker, "compose", "exec", "-T", SERVICE]


def _exists(container_exec: list[str], path: str) -> bool:
    completed = subprocess.run(  # noqa: S603 - fixed command, repository paths only
        [*container_exec, "test", "-e", path],
        cwd=REPO_ROOT,
        capture_output=True,
        timeout=30,
        check=False,
    )
    return completed.returncode == 0


@pytest.mark.parametrize("path", SHIPPED)
def test_the_image_ships_the_server_and_the_worker(container_exec: list[str], path: str) -> None:
    assert _exists(container_exec, path), f"{path} is missing from the image"


@pytest.mark.parametrize("path", NOT_SHIPPED)
def test_the_image_does_not_ship_offline_tooling(container_exec: list[str], path: str) -> None:
    assert not _exists(container_exec, path), f"{path} must not be in the image"
