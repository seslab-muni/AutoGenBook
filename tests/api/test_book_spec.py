from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from httpx import AsyncClient

from api.application.book_spec import (
    SpecRenderer,
    StructureBuilder,
    audience_phrase,
)
from api.domain.models import (
    MathLevel,
    NodeStatus,
    OutlineNode,
    OutputFormat,
    Project,
    TargetAudience,
)
from api.domain.outline import OutlineTree

REPO_ROOT = Path(__file__).resolve().parents[2]
GOLDEN_STRUCTURE = REPO_ROOT / "book_structure.json"

# Mirrors `book_builder.py:_PAGE_COUNT_RE` / the heading regex in
# `_extract_explicit_outline_from_txt` - what the CLI actually parses.
_HEADING_RE = re.compile(r"^(#{2,6}) (.+) \((\d+(?:\.\d+)?) pages\)$")


def _make_project(**overrides) -> Project:
    now = datetime.now(timezone.utc)
    defaults = dict(
        id=uuid.uuid4(),
        owner_id=None,
        title="AI in Teaching",
        subtitle="A practical guide",
        authors=["Ada Lovelace"],
        topic="using AI tools in university courses",
        target_audience=TargetAudience.GRADUATE,
        total_pages_budget=120,
        equation_frequency_level=2,
        do_consider_outline=True,
        do_consider_previous_sections=True,
        output_format=OutputFormat.MARKDOWN,
        max_outline_levels=3,
        additional_requirements=None,
        last_run_id=None,
        created_at=now,
        updated_at=now,
    )
    defaults.update(overrides)
    return Project(**defaults)


def _make_node(**overrides) -> OutlineNode:
    now = datetime.now(timezone.utc)
    defaults = dict(
        id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        parent_id=None,
        order_index=0,
        title="Introduction",
        summary="Sets the scene for the rest of the book.",
        status=NodeStatus.NOT_STARTED,
        target_pages=5.0,
        word_budget=1750,
        actual_words=0,
        equation_density_level=2,
        math_level=MathLevel.RIGOROUS,
        sub_prompt=None,
        content_markdown="",
        content_latex="",
        rag_citations=[],
        reviewer_score=None,
        reviewer_notes=None,
        structure_locked=True,
        created_at=now,
        updated_at=now,
        level=1,
        section_number="1",
        cli_key="1",
    )
    defaults.update(overrides)
    return OutlineNode(**defaults)


def _tree() -> list[OutlineTree]:
    chapter = _make_node(title="Practical Examples", level=1, section_number="1", cli_key="1")
    section = _make_node(
        title="Automated Feedback",
        level=2,
        section_number="1.1",
        cli_key="1-1",
        target_pages=2.5,
        sub_prompt="Cover autograders for programming courses specifically.",
    )
    return [OutlineTree(node=chapter, children=[OutlineTree(node=section, children=[])])]


# ---------------------------------------------------------------------------
# audience_phrase
# ---------------------------------------------------------------------------


def test_audience_phrase_covers_every_enum_member() -> None:
    for audience in TargetAudience:
        phrase = audience_phrase(audience)
        assert isinstance(phrase, str) and phrase


# ---------------------------------------------------------------------------
# SpecRenderer
# ---------------------------------------------------------------------------


def test_render_without_outline_has_header_blocks_and_no_headings() -> None:
    project = _make_project(additional_requirements="Focus on chapter 3.")

    text = SpecRenderer.render(project, [], include_outline=True)

    assert text.startswith("Title: AI in Teaching\n")
    assert "Summary: A practical guide. using AI tools in university courses" in text
    assert "Target readers: graduate students" in text
    assert "Total pages: 120" in text
    assert "Additional requirements: Focus on chapter 3." in text
    assert "#" not in text


def test_render_with_outline_produces_headings_the_cli_parser_accepts() -> None:
    project = _make_project()

    text = SpecRenderer.render(project, _tree(), include_outline=True)
    headings = [line for line in text.splitlines() if line.startswith("#")]

    assert len(headings) == 2
    chapter_match = _HEADING_RE.match(headings[0])
    section_match = _HEADING_RE.match(headings[1])
    assert chapter_match is not None
    assert chapter_match.group(1) == "##"
    assert chapter_match.group(2) == "Practical Examples"
    assert chapter_match.group(3) == "5"
    assert section_match is not None
    assert section_match.group(1) == "###"
    assert section_match.group(3) == "2.5"


def test_render_include_outline_false_omits_headings_even_with_a_tree() -> None:
    project = _make_project()

    text = SpecRenderer.render(project, _tree(), include_outline=False)

    assert "#" not in text
    assert "Practical Examples" not in text


def test_render_is_byte_identical_across_calls() -> None:
    project = _make_project()
    tree = _tree()

    first = SpecRenderer.render(project, tree, include_outline=True)
    second = SpecRenderer.render(project, tree, include_outline=True)

    assert first == second


def test_render_node_summary_with_sub_prompt_has_one_writing_instructions_paragraph() -> None:
    project = _make_project()

    text = SpecRenderer.render(project, _tree(), include_outline=True)

    assert text.count("Writing instructions:") == 2  # one per node in the tree
    assert "Cover autograders for programming courses specifically." in text


# ---------------------------------------------------------------------------
# StructureBuilder
# ---------------------------------------------------------------------------


def test_build_matches_the_golden_fixture_key_set_and_types() -> None:
    golden = json.loads(GOLDEN_STRUCTURE.read_text(encoding="utf-8"))
    project = _make_project()

    built = StructureBuilder.build(project, _tree(), lock_nodes=True)

    assert set(built.keys()) == set(golden.keys())
    for key, value in golden.items():
        assert type(built[key]) is type(value) or (
            isinstance(built[key], (int, float)) and isinstance(value, (int, float))
        )

    built_chapter = built["childs"][0]
    assert {"title", "summary", "n_pages", "needsSubdivision"} <= set(built_chapter.keys())
    assert built_chapter["needsSubdivision"] is True
    assert built_chapter["structure_locked"] is True
    assert built_chapter["childs"][0]["needsSubdivision"] is False
    assert "childs" not in built_chapter["childs"][0]


def test_build_node_summary_with_sub_prompt_has_one_writing_instructions_paragraph() -> None:
    project = _make_project()

    built = StructureBuilder.build(project, _tree(), lock_nodes=True)
    section_summary = built["childs"][0]["childs"][0]["summary"]

    assert section_summary.count("Writing instructions:") == 1
    assert "Cover autograders for programming courses specifically." in section_summary


def test_build_is_deterministic_across_calls() -> None:
    project = _make_project()
    tree = _tree()

    first = StructureBuilder.build(project, tree, lock_nodes=True)
    second = StructureBuilder.build(project, tree, lock_nodes=True)

    assert first == second


# ---------------------------------------------------------------------------
# GET /projects/{id}/spec
# ---------------------------------------------------------------------------

MINIMAL_PROJECT = {
    "title": "Intro to Widgets",
    "subtitle": "A Practical Guide",
    "authors": ["Ada Lovelace"],
    "topic": "widgets",
}


async def _create_project(authed_client: AsyncClient, **overrides) -> dict:
    payload = {**MINIMAL_PROJECT, **overrides}
    response = await authed_client.post("/api/v1/projects", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _create_node(authed_client: AsyncClient, project_id: str, **overrides) -> dict:
    payload = {"title": "Chapter One", "parentId": None, **overrides}
    response = await authed_client.post(f"/api/v1/projects/{project_id}/outline", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def test_get_spec_json_returns_structure_matching_golden_shape(
    authed_client: AsyncClient,
) -> None:
    golden = json.loads(GOLDEN_STRUCTURE.read_text(encoding="utf-8"))
    project = await _create_project(authed_client)
    await _create_node(authed_client, project["id"], title="Chapter One", targetPages=3)

    response = await authed_client.get(f"/api/v1/projects/{project['id']}/spec?format=json")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert set(body.keys()) == set(golden.keys())
    assert body["childs"][0]["title"] == "Chapter One"
    assert body["childs"][0]["structure_locked"] is True


async def test_get_spec_txt_default_returns_plain_text_with_outline(
    authed_client: AsyncClient,
) -> None:
    project = await _create_project(authed_client)
    await _create_node(authed_client, project["id"], title="Chapter One")

    response = await authed_client.get(f"/api/v1/projects/{project['id']}/spec")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert "Title: Intro to Widgets" in response.text
    assert "## Chapter One (1 pages)" in response.text


async def test_get_spec_txt_include_outline_false_omits_headings(
    authed_client: AsyncClient,
) -> None:
    project = await _create_project(authed_client)
    await _create_node(authed_client, project["id"], title="Chapter One")

    response = await authed_client.get(
        f"/api/v1/projects/{project['id']}/spec?includeOutline=false"
    )

    assert response.status_code == 200
    assert "Chapter One" not in response.text


async def test_get_spec_404_for_unknown_project(authed_client: AsyncClient) -> None:
    response = await authed_client.get(f"/api/v1/projects/{uuid.uuid4()}/spec")

    assert response.status_code == 404
