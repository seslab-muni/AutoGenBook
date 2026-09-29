"""The fake LLM itself: reachable through the real OpenAI SDK, deterministic,
schema-valid, and recording every call (issue #150)."""

from __future__ import annotations

import json

import httpx
import openai
import pytest

from fake_llm import Fault, FakeLLM

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "items": {"type": "array", "items": {"type": "integer", "minimum": 1, "maximum": 3}, "minItems": 2},
        "ok": {"type": "boolean"},
        "kind": {"enum": ["a", "b"]},
    },
    "required": ["title", "items", "ok", "kind"],
    "additionalProperties": False,
}


def _client(fake: FakeLLM) -> openai.AsyncOpenAI:
    return openai.AsyncOpenAI(
        api_key="test",
        base_url="http://fake.local/v1",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=fake.transport()),
    )


def _schema_format(name: str = "Thing") -> dict:
    return {"type": "json_schema", "json_schema": {"name": name, "schema": SCHEMA, "strict": True}}


async def test_json_schema_response_is_valid_and_recorded(fake_llm: FakeLLM) -> None:
    client = _client(fake_llm)
    resp = await client.chat.completions.create(
        model="fake-model",
        messages=[{"role": "user", "content": "hello"}],
        response_format=_schema_format(),
    )
    data = json.loads(resp.choices[0].message.content)
    assert set(data) == {"title", "items", "ok", "kind"}
    assert all(1 <= x <= 3 for x in data["items"]) and len(data["items"]) >= 2
    assert data["kind"] in {"a", "b"}
    assert resp.usage.total_tokens == resp.usage.prompt_tokens + resp.usage.completion_tokens
    [call] = fake_llm.calls
    assert call.schema_name == "Thing" and call.model == "fake-model"
    assert call.response_format_type == "json_schema"


async def test_deterministic_across_instances() -> None:
    outs = []
    for _ in range(2):
        fake = FakeLLM()
        resp = await _client(fake).chat.completions.create(
            model="m", messages=[{"role": "user", "content": "x"}], response_format=_schema_format()
        )
        outs.append(resp.choices[0].message.content)
    assert outs[0] == outs[1]


async def test_unsupported_response_format_is_rejected_with_400() -> None:
    fake = FakeLLM(supports=("json_object",))
    with pytest.raises(openai.BadRequestError):
        await _client(fake).chat.completions.create(
            model="m", messages=[{"role": "user", "content": "x"}], response_format=_schema_format()
        )
    resp = await _client(fake).chat.completions.create(
        model="m",
        messages=[
            {
                "role": "system",
                "content": "Schema name: Thing\n```json\n" + json.dumps(SCHEMA) + "\n```",
            },
            {"role": "user", "content": "x"},
        ],
        response_format={"type": "json_object"},
    )
    assert json.loads(resp.choices[0].message.content)["kind"] in {"a", "b"}


async def test_prompt_only_mode_wraps_json_in_a_fence() -> None:
    fake = FakeLLM(supports=())
    resp = await _client(fake).chat.completions.create(
        model="m",
        messages=[{"role": "system", "content": "Schema name: Thing\n```json\n" + json.dumps(SCHEMA) + "\n```"}],
    )
    text = resp.choices[0].message.content
    assert "```json" in text
    assert fake.calls[0].schema_name == "Thing"


async def test_streaming_returns_sse_chunks_with_usage(fake_llm: FakeLLM) -> None:
    stream = await _client(fake_llm).chat.completions.create(
        model="m",
        messages=[{"role": "user", "content": "Title: Streams"}],
        stream=True,
        stream_options={"include_usage": True},
    )
    text = ""
    usage = None
    async for chunk in stream:
        if chunk.choices:
            text += chunk.choices[0].delta.content or ""
        if chunk.usage is not None:
            usage = chunk.usage
    assert "Fake generated content" in text
    assert usage is not None and usage.total_tokens > 0


async def test_fault_injection_with_retry_after() -> None:
    fake = FakeLLM(faults=[Fault(status=429, retry_after=2.5, times=1)])
    client = _client(fake)
    with pytest.raises(openai.RateLimitError) as info:
        await client.chat.completions.create(model="m", messages=[{"role": "user", "content": "x"}])
    assert info.value.response.headers["retry-after"] == "2.5"
    ok = await client.chat.completions.create(model="m", messages=[{"role": "user", "content": "x"}])
    assert ok.choices[0].message.content
    assert [c.status for c in fake.calls] == [429, 200]


async def test_embeddings_and_rerank(fake_llm: FakeLLM) -> None:
    client = _client(fake_llm)
    emb = await client.embeddings.create(model="e", input=["cat sat", "dog ran"])
    assert len(emb.data) == 2 and len(emb.data[0].embedding) == 64
    async with httpx.AsyncClient(transport=fake_llm.transport()) as http:
        resp = await http.post(
            "http://fake.local/v1/rerank",
            json={"model": "r", "query": "cat", "documents": ["a dog", "the cat"], "top_n": 2},
        )
        assert resp.json()["results"][0]["index"] == 1
        score = await http.post("http://fake.local/v1/score", json={"text_1": "q", "text_2": ["a"]})
        assert score.status_code == 404


def test_http_server_mode_serves_the_same_fake() -> None:
    fake = FakeLLM()
    with fake.serve() as base_url:
        client = openai.OpenAI(api_key="k", base_url=base_url, max_retries=0)
        resp = client.chat.completions.create(
            model="m", messages=[{"role": "user", "content": "x"}], response_format=_schema_format()
        )
        assert json.loads(resp.choices[0].message.content)["title"]
    assert len(fake.calls) == 1


async def test_record_and_replay(tmp_path) -> None:
    rec = tmp_path / "rec.json"
    fake = FakeLLM(record_to=rec)
    resp = await _client(fake).chat.completions.create(
        model="m", messages=[{"role": "user", "content": "x"}], response_format=_schema_format()
    )
    fake.flush_recording()
    replay = FakeLLM(recorded=rec)
    again = await _client(replay).chat.completions.create(
        model="other-model", messages=[{"role": "user", "content": "x"}], response_format=_schema_format()
    )
    assert again.choices[0].message.content == resp.choices[0].message.content
    with pytest.raises(openai.InternalServerError, match="golden drift"):
        await _client(replay).chat.completions.create(
            model="m", messages=[{"role": "user", "content": "changed"}], response_format=_schema_format()
        )
