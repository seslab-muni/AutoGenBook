"""Tests for `Project.llmModel` (issue #128): a project always has a concrete model id -
initialized from the deployment default when a caller doesn't supply one, echoed back verbatim
when they do, updatable via `PATCH`, and copied (not re-resolved) by `duplicate`.
"""

from __future__ import annotations

from httpx import AsyncClient

from api.core.settings import default_llm_model, get_settings

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


async def test_create_project_without_llm_model_uses_deployment_default(
    authed_client: AsyncClient,
) -> None:
    project = await _create_project(authed_client)
    assert project["llmModel"] == default_llm_model(get_settings())


async def test_create_project_with_explicit_llm_model_is_echoed_back(
    authed_client: AsyncClient,
) -> None:
    project = await _create_project(authed_client, llmModel="anthropic/claude-3.5-sonnet")
    assert project["llmModel"] == "anthropic/claude-3.5-sonnet"


async def test_get_project_round_trips_llm_model(authed_client: AsyncClient) -> None:
    created = await _create_project(authed_client, llmModel="anthropic/claude-3.5-sonnet")
    response = await authed_client.get(f"/api/v1/projects/{created['id']}")
    assert response.status_code == 200, response.text
    assert response.json()["llmModel"] == "anthropic/claude-3.5-sonnet"


async def test_patch_project_updates_llm_model(authed_client: AsyncClient) -> None:
    created = await _create_project(authed_client)
    response = await authed_client.patch(
        f"/api/v1/projects/{created['id']}", json={"llmModel": "openai/gpt-4o"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["llmModel"] == "openai/gpt-4o"


async def test_patch_project_with_null_llm_model_leaves_it_unchanged(
    authed_client: AsyncClient,
) -> None:
    # Issue #128 review, fix 9: `PATCH {"llmModel": null}` used to 500 - `ProjectUpdate.llm_model`
    # accepts `None` (so the field can be genuinely omitted), but that `None` reaching `ProjectService.
    # update` unconditionally applied `setattr(project, "llm_model", None)` against a `NOT NULL`
    # column. It should instead be treated the same as not sending the field at all.
    created = await _create_project(authed_client, llmModel="anthropic/claude-3.5-sonnet")
    response = await authed_client.patch(
        f"/api/v1/projects/{created['id']}", json={"llmModel": None}
    )
    assert response.status_code == 200, response.text
    assert response.json()["llmModel"] == "anthropic/claude-3.5-sonnet"


async def test_patch_project_with_null_llm_model_alongside_other_fields_still_applies_them(
    authed_client: AsyncClient,
) -> None:
    created = await _create_project(authed_client, llmModel="anthropic/claude-3.5-sonnet")
    response = await authed_client.patch(
        f"/api/v1/projects/{created['id']}",
        json={"llmModel": None, "title": "Retitled Widgets"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["llmModel"] == "anthropic/claude-3.5-sonnet"
    assert body["title"] == "Retitled Widgets"


async def test_duplicate_project_copies_llm_model_rather_than_resolving_default_again(
    authed_client: AsyncClient,
) -> None:
    source = await _create_project(authed_client, llmModel="anthropic/claude-3.5-sonnet")
    assert source["llmModel"] != default_llm_model(get_settings())

    response = await authed_client.post(f"/api/v1/projects/{source['id']}/duplicate")

    assert response.status_code == 201, response.text
    assert response.json()["llmModel"] == "anthropic/claude-3.5-sonnet"
