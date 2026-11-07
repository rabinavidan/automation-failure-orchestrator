"""Every relative link in the repository's Markdown resolves: the file exists and, for a link
into a Markdown file, the #anchor names one of its headings. Moving or merging a document
(architecture step 9) must not leave dead links behind."""

from __future__ import annotations

import re
from functools import cache
from pathlib import Path

import pytest

from support.settings import REPO_ROOT

pytestmark = pytest.mark.drift

SKIP_DIRS = {
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "dist",
    "test-results",
    "coverage",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    ".terraform",
}
LINK = re.compile(r"!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
FENCE = re.compile(r"^\s*(```|~~~)")
HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*#*\s*$")


def _markdown_files() -> list[Path]:
    return sorted(
        path
        for path in REPO_ROOT.rglob("*.md")
        if not SKIP_DIRS.intersection(path.relative_to(REPO_ROOT).parts)
    )


def _prose_lines(path: Path) -> list[str]:
    """The file's lines outside fenced code blocks."""
    lines, in_fence = [], False
    for line in path.read_text(encoding="utf-8").splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if not in_fence:
            lines.append(line)
    return lines


def _slug(heading: str) -> str:
    """GitHub's heading anchor: markup dropped, lowercase, punctuation removed, spaces to '-'."""
    text = re.sub(r"`([^`]*)`", r"\1", heading)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[^\w\- ]", "", text.lower())
    return text.replace(" ", "-")


@cache
def _anchors(path: Path) -> frozenset[str]:
    seen: dict[str, int] = {}
    anchors = set()
    for line in _prose_lines(path):
        match = HEADING.match(line)
        if not match:
            continue
        slug = _slug(match.group(1))
        count = seen.get(slug, 0)
        anchors.add(slug if count == 0 else f"{slug}-{count}")
        seen[slug] = count + 1
    return frozenset(anchors)


def _broken_links(path: Path) -> list[str]:
    broken = []
    for line in _prose_lines(path):
        for target in LINK.findall(line):
            if re.match(r"^[a-zA-Z][a-zA-Z+.-]*:", target):
                continue  # http:, https:, mailto: and the like
            file_part, _, anchor = target.partition("#")
            resolved = (path.parent / file_part).resolve() if file_part else path
            if not resolved.exists():
                broken.append(f"{target} (no such file)")
            elif anchor and resolved.suffix == ".md" and anchor not in _anchors(resolved):
                broken.append(f"{target} (no heading #{anchor})")
    return broken


def test_the_documentation_is_found() -> None:
    files = {path.relative_to(REPO_ROOT).as_posix() for path in _markdown_files()}
    assert {"README.md", "docs/README.md", "docs/reference/platform-reference.md"} <= files


@pytest.mark.parametrize(
    "path", _markdown_files(), ids=lambda path: path.relative_to(REPO_ROOT).as_posix()
)
def test_relative_links_resolve(path: Path) -> None:
    assert _broken_links(path) == []
