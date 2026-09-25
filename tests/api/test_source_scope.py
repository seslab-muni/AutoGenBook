"""Issue #138: per-node knowledge-base source scoping (`sourceScope`/
`sourceIds` on outline nodes)."""

from __future__ import annotations

import uuid

from httpx import AsyncClient

from api.application.book_spec import StructureBuilder, kb_scope_fields, sync_kb_scopes_into_graph
from api.domain.models import SourceScope
from api.domain.outline import OutlineTree

from tests.api.test_book_spec import _make_node, _make_project

PROJECT = {
    "title": "Numerical Linear Algebra",
    "subtitle": "Direct and iterative methods",
    "authors": ["Ada Lovelace"],
    "topic": "linear systems",
}


async def _project(client: AsyncClient) -> str:
    response = await client.post("/api/v1/projects", json=PROJECT)
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def _source(client: AsyncClient, project_id: str, filename: str) -> str:
    upload = await client.post(
        "/api/v1/files", files={"file": (filename, b"content", "application/octet-stream")}
    )
    assert upload.status_code == 201, upload.text
    response = await client.post(
        f"/api/v1/projects/{project_id}/sources", json={"fileId": upload.json()["id"]}
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def _node(client: AsyncClient, project_id: str, **body) -> dict:
    response = await client.post(
        f"/api/v1/projects/{project_id}/outline", json={"title": "Chapter", **body}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _patch(client: AsyncClient, project_id: str, node_id: str, body: dict):
    return await client.patch(f"/api/v1/projects/{project_id}/outline/{node_id}", json=body)


async def test_new_node_defaults_to_inherit(authed_client: AsyncClient) -> None:
    project_id = await _project(authed_client)
    node = await _node(authed_client, project_id)
    assert node["sourceScope"] == "inherit"
    assert node["sourceIds"] == []


async def test_select_sources_round_trip_and_dedupe(authed_client: AsyncClient) -> None:
    project_id = await _project(authed_client)
    a = await _source(authed_client, project_id, "golub.pdf")
    b = await _source(authed_client, project_id, "notes.md")
    node = await _node(authed_client, project_id)

    response = await _patch(
        authed_client, project_id, node["id"],
        {"sourceScope": "selected", "sourceIds": [b, a, b]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["sourceScope"] == "selected"
    assert response.json()["sourceIds"] == [b, a]

    listed = await authed_client.get(f"/api/v1/projects/{project_id}/outline")
    assert listed.json()["items"][0]["sourceIds"] == [b, a]


async def test_ids_alone_imply_selected(authed_client: AsyncClient) -> None:
    project_id = await _project(authed_client)
    a = await _source(authed_client, project_id, "golub.pdf")
    node = await _node(authed_client, project_id)
    response = await _patch(authed_client, project_id, node["id"], {"sourceIds": [a]})
    assert response.status_code == 200, response.text
    assert response.json()["sourceScope"] == "selected"


async def test_switching_scope_clears_ids(authed_client: AsyncClient) -> None:
    project_id = await _project(authed_client)
    a = await _source(authed_client, project_id, "golub.pdf")
    node = await _node(authed_client, project_id)
    await _patch(authed_client, project_id, node["id"], {"sourceScope": "selected", "sourceIds": [a]})

    response = await _patch(authed_client, project_id, node["id"], {"sourceScope": "all"})
    assert response.status_code == 200, response.text
    assert response.json()["sourceScope"] == "all"
    assert response.json()["sourceIds"] == []


async def test_validation_errors(authed_client: AsyncClient) -> None:
    project_id = await _project(authed_client)
    a = await _source(authed_client, project_id, "golub.pdf")
    other_project = await _project(authed_client)
    foreign = await _source(authed_client, other_project, "other.pdf")
    node = await _node(authed_client, project_id)

    for body in (
        {"sourceScope": "selected", "sourceIds": []},
        {"sourceScope": "selected"},
        {"sourceScope": "selected", "sourceIds": [foreign]},
        {"sourceScope": "selected", "sourceIds": [str(uuid.uuid4())]},
        {"sourceScope": "all", "sourceIds": [a]},
        {"sourceScope": None},
        {"sourceScope": "bogus"},
    ):
        response = await _patch(authed_client, project_id, node["id"], body)
        assert response.status_code == 422, (body, response.text)


async def test_detached_source_is_pruned_from_nodes(authed_client: AsyncClient) -> None:
    project_id = await _project(authed_client)
    a = await _source(authed_client, project_id, "golub.pdf")
    b = await _source(authed_client, project_id, "notes.md")
    both = await _node(authed_client, project_id, title="Both")
    only_a = await _node(authed_client, project_id, title="Only A")
    await _patch(authed_client, project_id, both["id"], {"sourceScope": "selected", "sourceIds": [a, b]})
    await _patch(authed_client, project_id, only_a["id"], {"sourceScope": "selected", "sourceIds": [a]})

    response = await authed_client.delete(f"/api/v1/projects/{project_id}/sources/{a}")
    assert response.status_code == 204, response.text

    nodes = {
        n["title"]: n
        for n in (await authed_client.get(f"/api/v1/projects/{project_id}/outline")).json()["items"]
    }
    assert nodes["Both"]["sourceScope"] == "selected"
    assert nodes["Both"]["sourceIds"] == [b]
    assert nodes["Only A"]["sourceScope"] == "inherit"
    assert nodes["Only A"]["sourceIds"] == []


async def test_duplicate_project_remaps_source_ids(authed_client: AsyncClient) -> None:
    project_id = await _project(authed_client)
    a = await _source(authed_client, project_id, "golub.pdf")
    node = await _node(authed_client, project_id)
    await _patch(authed_client, project_id, node["id"], {"sourceScope": "selected", "sourceIds": [a]})

    response = await authed_client.post(f"/api/v1/projects/{project_id}/duplicate")
    assert response.status_code == 201, response.text
    copy = response.json()
    copy_source_ids = [s["id"] for s in copy["sources"]]
    assert len(copy_source_ids) == 1 and copy_source_ids[0] != a
    copy_nodes = (await authed_client.get(f"/api/v1/projects/{copy['id']}/outline")).json()["items"]
    assert copy_nodes[0]["sourceScope"] == "selected"
    assert copy_nodes[0]["sourceIds"] == copy_source_ids


async def test_spec_json_carries_kb_scope(authed_client: AsyncClient) -> None:
    project_id = await _project(authed_client)
    a = await _source(authed_client, project_id, "golub.pdf")
    chapter = await _node(authed_client, project_id, title="Direct methods")
    section = await _node(authed_client, project_id, title="QR", parentId=chapter["id"])
    other = await _node(authed_client, project_id, title="Iterative")
    await _patch(authed_client, project_id, chapter["id"], {"sourceScope": "selected", "sourceIds": [a]})
    await _patch(authed_client, project_id, section["id"], {"sourceScope": "all"})

    response = await authed_client.get(f"/api/v1/projects/{project_id}/spec?format=json")
    assert response.status_code == 200, response.text
    chapter_json, other_json = response.json()["childs"]
    assert chapter_json["kb_scope"] == "selected"
    assert chapter_json["kb_sources"] == [a]
    assert chapter_json["childs"][0]["kb_scope"] == "all"
    assert "kb_sources" not in chapter_json["childs"][0]
    assert "kb_scope" not in other_json
    assert other["sourceScope"] == "inherit"


def test_kb_scope_fields() -> None:
    sid = uuid.uuid4()
    assert kb_scope_fields(_make_node()) == {}
    assert kb_scope_fields(_make_node(source_scope=SourceScope.ALL)) == {"kb_scope": "all"}
    assert kb_scope_fields(
        _make_node(source_scope=SourceScope.SELECTED, source_ids=[sid])
    ) == {"kb_scope": "selected", "kb_sources": [str(sid)]}


def test_structure_builder_default_output_unchanged() -> None:
    tree = [OutlineTree(node=_make_node(), children=[])]
    node = StructureBuilder.build(_make_project(), tree, lock_nodes=False)["childs"][0]
    assert "kb_scope" not in node and "kb_sources" not in node


def test_sync_kb_scopes_into_graph() -> None:
    sid = uuid.uuid4()
    graph = {
        "nodes": {
            "1": {"title": "Ch", "kb_scope": "all"},
            "1-1": {"title": "Sec"},
            "2": {"title": "Other", "kb_scope": "selected", "kb_sources": ["x"]},
        }
    }
    nodes = [
        _make_node(cli_key="1"),
        _make_node(cli_key="1-1", source_scope=SourceScope.SELECTED, source_ids=[sid]),
        _make_node(cli_key="2", source_scope=SourceScope.SELECTED, source_ids=[sid]),
        _make_node(cli_key="9"),
        _make_node(cli_key=None),
    ]
    assert sync_kb_scopes_into_graph(graph, nodes) is True
    assert graph["nodes"]["1"] == {"title": "Ch"}
    assert graph["nodes"]["1-1"] == {"title": "Sec", "kb_scope": "selected", "kb_sources": [str(sid)]}
    assert graph["nodes"]["2"]["kb_sources"] == [str(sid)]
    assert sync_kb_scopes_into_graph(graph, nodes) is False
