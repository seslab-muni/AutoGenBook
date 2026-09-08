from __future__ import annotations

import dataclasses
import uuid
from datetime import datetime, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy.exc import InvalidRequestError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.infrastructure.db.models import ProjectRecord
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository

MINIMAL_PAYLOAD = {
    "title": "Intro to Widgets",
    "subtitle": "A Practical Guide",
    "authors": ["Ada Lovelace"],
    "topic": "widgets",
}


async def _create_project(client: AsyncClient, **overrides) -> dict:
    payload = {**MINIMAL_PAYLOAD, **overrides}
    response = await client.post("/api/v1/projects", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def test_create_project_applies_defaults(client: AsyncClient) -> None:
    body = await _create_project(client)

    assert uuid.UUID(body["id"])
    assert body["title"] == "Intro to Widgets"
    assert body["subtitle"] == "A Practical Guide"
    assert body["authors"] == ["Ada Lovelace"]
    assert body["topic"] == "widgets"
    assert body["targetAudience"] == "graduate"
    assert body["totalPagesBudget"] == 350
    assert body["equationFrequencyLevel"] == 4
    assert body["doConsiderOutline"] is True
    assert body["doConsiderPreviousSections"] is True
    assert body["outputFormat"] == "markdown"
    assert body["maxOutlineLevels"] == 3
    assert body["additionalRequirements"] is None
    assert body["sources"] == []
    assert body["outline"] == []
    assert body["lastRunId"] is None
    assert body["createdAt"]
    assert body["updatedAt"]


async def test_create_project_accepts_full_wizard_payload(client: AsyncClient) -> None:
    body = await _create_project(
        client,
        targetAudience="phd_researcher",
        totalPagesBudget=120,
        equationFrequencyLevel=2,
        doConsiderOutline=False,
        doConsiderPreviousSections=False,
        outputFormat="latex",
        maxOutlineLevels=5,
        additionalRequirements="Focus on chapter 3.",
    )

    assert body["targetAudience"] == "phd_researcher"
    assert body["totalPagesBudget"] == 120
    assert body["equationFrequencyLevel"] == 2
    assert body["doConsiderOutline"] is False
    assert body["doConsiderPreviousSections"] is False
    assert body["outputFormat"] == "latex"
    assert body["maxOutlineLevels"] == 5
    assert body["additionalRequirements"] == "Focus on chapter 3."


async def test_get_project_round_trips_created_project(client: AsyncClient) -> None:
    created = await _create_project(client)

    response = await client.get(f"/api/v1/projects/{created['id']}")

    assert response.status_code == 200
    assert response.json() == created


async def test_get_project_404_is_problem_json(client: AsyncClient) -> None:
    missing_id = uuid.uuid4()

    response = await client.get(f"/api/v1/projects/{missing_id}")

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["title"] == "Not Found"
    assert body["status"] == 404
    assert body["instance"] == f"/api/v1/projects/{missing_id}"


async def test_list_projects_returns_summaries_sorted_by_updated_at_desc(
    client: AsyncClient,
) -> None:
    first = await _create_project(client, title="First")
    second = await _create_project(client, title="Second")

    response = await client.get("/api/v1/projects")

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert body["limit"] == 50
    assert body["offset"] == 0
    ids_in_order = [item["id"] for item in body["items"]]
    assert ids_in_order == [second["id"], first["id"]]
    summary = body["items"][0]
    assert summary["sourcesCount"] == 0
    assert summary["outlineNodeCount"] == 0
    assert "sources" not in summary
    assert "outline" not in summary


async def test_list_projects_honors_limit_and_offset(client: AsyncClient) -> None:
    for i in range(3):
        await _create_project(client, title=f"Project {i}")

    response = await client.get("/api/v1/projects", params={"limit": 1, "offset": 1})

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 3
    assert body["limit"] == 1
    assert body["offset"] == 1
    assert len(body["items"]) == 1


async def test_update_project_patches_metadata_and_bumps_updated_at(
    client: AsyncClient,
) -> None:
    created = await _create_project(client)

    response = await client.patch(
        f"/api/v1/projects/{created['id']}",
        json={"title": "Renamed", "totalPagesBudget": 500},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Renamed"
    assert body["totalPagesBudget"] == 500
    assert body["subtitle"] == created["subtitle"]
    assert body["updatedAt"] != created["updatedAt"]
    assert body["createdAt"] == created["createdAt"]


async def test_concurrent_project_update_and_last_run_id_bump_do_not_clobber_each_other(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Regression for issue #56: `PATCH /projects/{id}` and `RunService.
    create`/`GenerationService._import_graph` bumping `last_run_id` both
    used to `get -> mutate -> write the whole row` - whichever committed
    last silently reverted the other's change. Simulates the interleaving:
    both writes are built from the same baseline row."""
    created = await _create_project(client)
    project_id = uuid.UUID(created["id"])

    async with session_factory() as session:
        baseline = await SqlAlchemyProjectRepository(session).get(project_id)
    assert baseline is not None

    patch = dataclasses.replace(
        baseline, title="Retitled", updated_at=datetime.now(timezone.utc)
    )
    run_created = dataclasses.replace(
        baseline, last_run_id=uuid.uuid4(), updated_at=datetime.now(timezone.utc)
    )

    async with session_factory() as session:
        repo = SqlAlchemyProjectRepository(session)
        await repo.update(patch, fields=("title",))
        await repo.update(run_created, fields=("last_run_id",))
        final = await repo.get(project_id)

    assert final is not None
    assert final.title == "Retitled"
    assert final.last_run_id == run_created.last_run_id


async def test_update_project_404(client: AsyncClient) -> None:
    response = await client.patch(
        f"/api/v1/projects/{uuid.uuid4()}", json={"title": "Nope"}
    )

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"


async def test_update_project_rejects_sources_key(client: AsyncClient) -> None:
    created = await _create_project(client)

    response = await client.patch(
        f"/api/v1/projects/{created['id']}", json={"sources": []}
    )

    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["title"] == "Validation Failed"


async def test_update_project_rejects_outline_key(client: AsyncClient) -> None:
    created = await _create_project(client)

    response = await client.patch(
        f"/api/v1/projects/{created['id']}", json={"outline": []}
    )

    assert response.status_code == 422


async def test_delete_project_then_404s(client: AsyncClient) -> None:
    created = await _create_project(client)

    delete_response = await client.delete(f"/api/v1/projects/{created['id']}")
    assert delete_response.status_code == 204
    assert delete_response.content == b""

    get_response = await client.get(f"/api/v1/projects/{created['id']}")
    assert get_response.status_code == 404


async def test_delete_project_404(client: AsyncClient) -> None:
    response = await client.delete(f"/api/v1/projects/{uuid.uuid4()}")

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"


async def test_delete_project_409_while_a_run_is_active(client: AsyncClient) -> None:
    """issue #57: `DELETE /projects/{id}` used to succeed (204) even with an
    active run, hard-cascading the run row away out from under the
    worker's still-running CLI subprocess - the next `append_batch`/
    `_finalize` would then hit an FK violation or an `assert record is not
    None` against a row that no longer existed. It must refuse instead,
    leaving the project (and its active run) untouched."""
    created = await _create_project(client)

    run_response = await client.post(f"/api/v1/projects/{created['id']}/runs", json={})
    assert run_response.status_code == 202, run_response.text

    delete_response = await client.delete(f"/api/v1/projects/{created['id']}")
    assert delete_response.status_code == 409
    assert delete_response.headers["content-type"] == "application/problem+json"

    get_response = await client.get(f"/api/v1/projects/{created['id']}")
    assert get_response.status_code == 200


async def test_duplicate_project_creates_new_id_and_fresh_timestamps(
    client: AsyncClient,
) -> None:
    created = await _create_project(client, title="Original")

    response = await client.post(f"/api/v1/projects/{created['id']}/duplicate")

    assert response.status_code == 201
    body = response.json()
    assert body["id"] != created["id"]
    assert body["title"] == "Original (Copy)"
    assert body["subtitle"] == created["subtitle"]
    assert body["createdAt"] != created["createdAt"]
    assert body["updatedAt"] != created["updatedAt"]
    assert body["lastRunId"] is None

    listing = await client.get("/api/v1/projects")
    assert listing.json()["total"] == 2


async def test_duplicate_project_404(client: AsyncClient) -> None:
    response = await client.post(f"/api/v1/projects/{uuid.uuid4()}/duplicate")

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"


async def test_list_projects_query_count_stays_flat_as_projects_grow(
    client: AsyncClient, count_statements
) -> None:
    """Regression for issue #51: `ProjectService.list` used to run two
    `count(*)` queries per project (`sources_count`, `outline_node_count`)
    on top of the page's own query, so `GET /projects` cost grew linearly
    with the number of projects returned. `list_with_counts` folds both
    counts into the page query via a grouped-count subquery join instead,
    so the statement count for one page must stay flat regardless of how
    many projects are on it."""
    await _create_project(client, title="First")

    with count_statements() as statements:
        response = await client.get("/api/v1/projects")
    assert response.status_code == 200
    assert response.json()["total"] == 1
    first_page_statement_count = len(statements)

    for i in range(9):
        await _create_project(client, title=f"Project {i}")

    with count_statements() as statements:
        response = await client.get("/api/v1/projects")
    assert response.status_code == 200
    assert response.json()["total"] == 10
    assert len(statements) == first_page_statement_count


async def test_get_project_record_does_not_eagerly_load_sources_relationship(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    count_statements,
) -> None:
    """Regression for issue #51: `ProjectRecord.sources` was `lazy="selectin"`,
    so every `session.get(ProjectRecord, ...)` - which `_require_project` in
    the sources/outline/runs services calls on every request - issued an
    extra `SELECT ... FROM project_sources` to eagerly load a relationship
    nothing reads as an ORM attribute. `lazy="raise"` means a plain `get`
    costs exactly one statement, and any accidental future access raises
    loudly instead of silently costing a query."""
    created = await _create_project(client)
    project_id = uuid.UUID(created["id"])

    async with session_factory() as session:
        with count_statements() as statements:
            record = await session.get(ProjectRecord, project_id)
        assert record is not None
        assert len(statements) == 1
        assert all("project_sources" not in statement for statement in statements)

        with pytest.raises(InvalidRequestError):
            _ = record.sources


async def test_create_project_rejects_total_pages_budget_out_of_bounds(
    client: AsyncClient,
) -> None:
    too_low = await client.post(
        "/api/v1/projects", json={**MINIMAL_PAYLOAD, "totalPagesBudget": 4}
    )
    too_high = await client.post(
        "/api/v1/projects", json={**MINIMAL_PAYLOAD, "totalPagesBudget": 2001}
    )

    assert too_low.status_code == 422
    assert too_high.status_code == 422


async def test_create_project_rejects_equation_frequency_level_out_of_bounds(
    client: AsyncClient,
) -> None:
    too_low = await client.post(
        "/api/v1/projects", json={**MINIMAL_PAYLOAD, "equationFrequencyLevel": 0}
    )
    too_high = await client.post(
        "/api/v1/projects", json={**MINIMAL_PAYLOAD, "equationFrequencyLevel": 6}
    )

    assert too_low.status_code == 422
    assert too_high.status_code == 422


async def test_create_project_rejects_max_outline_levels_out_of_bounds(
    client: AsyncClient,
) -> None:
    too_low = await client.post(
        "/api/v1/projects", json={**MINIMAL_PAYLOAD, "maxOutlineLevels": 0}
    )
    too_high = await client.post(
        "/api/v1/projects", json={**MINIMAL_PAYLOAD, "maxOutlineLevels": 6}
    )

    assert too_low.status_code == 422
    assert too_high.status_code == 422


async def test_create_project_with_too_deep_wizard_outline_leaves_no_orphaned_project(
    client: AsyncClient,
) -> None:
    # `maxOutlineLevels=1` but the outline nests two levels deep - rejected by
    # `OutlineService.replace` as `ValidationFailed` (422), after the project
    # row itself has already been committed by `ProjectService.create`. The
    # 422 must not leave that project (or its sources) behind (issue #49).
    too_deep_outline = [
        {
            "title": "Chapter 1",
            "children": [{"title": "Section 1.1", "children": []}],
        }
    ]
    response = await client.post(
        "/api/v1/projects",
        json={**MINIMAL_PAYLOAD, "maxOutlineLevels": 1, "outline": too_deep_outline},
    )
    assert response.status_code == 422, response.text

    list_response = await client.get("/api/v1/projects")
    assert list_response.json()["total"] == 0


async def test_update_project_rejects_bounds_violations(client: AsyncClient) -> None:
    created = await _create_project(client)

    response = await client.patch(
        f"/api/v1/projects/{created['id']}", json={"totalPagesBudget": 1}
    )

    assert response.status_code == 422
