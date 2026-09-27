"""Async LLM client: structured-output ladder, retries, adaptive concurrency,
streaming, usage ledger and cost (#151)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import openai
import pytest
from pydantic import BaseModel, Field

from engine.config import LLMSettings
from engine.errors import EngineError, SchemaError
from engine.events import MemorySink
from engine.llm.client import LLMClient
from engine.llm.limiter import AdaptiveLimiter
from engine.llm.retry import backoff_seconds, is_transient, retry_after_seconds
from engine.llm.structured import Level, extract_json, json_schema_for
from engine.llm.usage import UsageLedger
from fake_llm import Fault, FakeLLM


class Answer(BaseModel):
    title: str
    points: list[str] = Field(default_factory=list)
    ok: bool = True


def _client(fake: FakeLLM, tmp_path: Path, **overrides) -> LLMClient:
    params = {"base_url": "http://fake.local/v1", "api_key": "k", "model": "m-main", "mini_model": "m-mini", "max_retries": 3}
    params.update(overrides)
    settings = LLMSettings(**params)
    return LLMClient(
        settings, ledger=UsageLedger(tmp_path / "llm_usage.jsonl"), sink=MemorySink(), concurrency=4,
        transport=fake.transport(),
    )


MESSAGES = [{"role": "system", "content": "You are terse."}, {"role": "user", "content": "Give an answer."}]


async def test_json_schema_level_when_supported(tmp_path: Path) -> None:
    fake = FakeLLM()
    client = _client(fake, tmp_path)
    out = await client.structured(MESSAGES, Answer, label="t")
    assert isinstance(out, Answer)
    assert fake.calls[0].response_format_type == "json_schema" and fake.calls[0].schema_name == "Answer"
    assert client.level_for("m-main") == Level.JSON_SCHEMA
    await client.aclose()


@pytest.mark.parametrize("supports,expected", [(("json_object",), Level.JSON_OBJECT), ((), Level.PROMPT)])
async def test_ladder_is_probed_once_per_model(tmp_path: Path, supports, expected) -> None:
    fake = FakeLLM(supports=supports)
    client = _client(fake, tmp_path)
    results = await asyncio.gather(*[client.structured(MESSAGES, Answer, label=f"t{i}") for i in range(6)])
    assert all(isinstance(r, Answer) for r in results)
    rejected = [c for c in fake.calls if c.status == 400]
    assert len(rejected) == int(expected)  # one rejection per unsupported level, not per call
    assert client.level_for("m-main") == expected
    # The mini model is a different model: probed on its own.
    await client.structured(MESSAGES, Answer, label="mini", role="mini")
    assert len([c for c in fake.calls if c.status == 400]) == 2 * int(expected)
    if expected != Level.JSON_SCHEMA:
        assert "Schema name: Answer" in fake.calls[-1].system  # schema embedded in the prompt
    await client.aclose()


async def test_single_repair_call_then_schema_error(tmp_path: Path) -> None:
    replies = iter(['{"title": 5, "points": "nope"}', '{"title": "fixed", "points": ["a"]}'])
    fake = FakeLLM(overrides={"Answer": lambda call: next(replies)})
    client = _client(fake, tmp_path)
    out = await client.structured(MESSAGES, Answer, label="write", node_key="1-2")
    assert out.title == "fixed"
    labels = [e.label for e in client.ledger.entries]
    assert labels == ["write", "write.repair"]  # the repair is itemised like any call
    assert client.ledger.entries[1].node_key == "1-2"

    bad = FakeLLM(overrides={"Answer": lambda call: "not json at all"})
    client2 = _client(bad, tmp_path / "b")
    with pytest.raises(SchemaError):
        await client2.structured(MESSAGES, Answer, label="write")
    assert len(bad.calls) == 2
    await client.aclose()
    await client2.aclose()


async def test_transient_errors_are_retried_honouring_retry_after(tmp_path: Path, monkeypatch) -> None:
    sleeps: list[float] = []
    real_sleep = asyncio.sleep

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)
        await real_sleep(0)

    monkeypatch.setattr("engine.llm.client.asyncio.sleep", fake_sleep)
    fake = FakeLLM(faults=[Fault(status=429, retry_after=7, times=1), Fault(status=503, times=1)])
    client = _client(fake, tmp_path)
    result = await client.complete_text(MESSAGES, label="x")
    assert result.text
    assert [c.status for c in fake.calls] == [429, 503, 200]
    assert 7.0 <= sleeps[0] <= 7.7  # Retry-After honoured (+ <=10 % jitter)
    statuses = [e.status for e in client.ledger.entries]
    assert statuses == [429, 503, "ok"]  # failures itemised too
    assert client.limiter.limit < 4  # throttled
    await client.aclose()


async def test_non_transient_errors_are_not_retried(tmp_path: Path) -> None:
    fake = FakeLLM(faults=[Fault(status=401, times=None, message="bad key")])
    client = _client(fake, tmp_path)
    with pytest.raises(openai.AuthenticationError) as info:
        await client.complete_text(MESSAGES, label="x")
    assert "Error code: 401" in str(info.value)  # the text the API's error mapper recognises
    assert len(fake.calls) == 1
    await client.aclose()


async def test_retries_are_bounded(tmp_path: Path, monkeypatch) -> None:
    async def no_sleep(_d: float) -> None:
        return None

    monkeypatch.setattr("engine.llm.client.asyncio.sleep", no_sleep)
    fake = FakeLLM(faults=[Fault(status=500, times=None)])
    client = _client(fake, tmp_path, max_retries=2)
    with pytest.raises(openai.InternalServerError):
        await client.complete_text(MESSAGES, label="x")
    assert len(fake.calls) == 3
    await client.aclose()


async def test_streaming_reports_deltas_and_usage(tmp_path: Path) -> None:
    fake = FakeLLM()
    client = _client(fake, tmp_path)
    deltas: list[str] = []
    result = await client.complete_text(MESSAGES, label="stream", stream=True, on_delta=deltas.append)
    assert "".join(deltas) == result.text and len(deltas) > 1
    assert result.total_tokens > 0
    assert client.ledger.entries[-1].kind == "chat_stream" and client.ledger.entries[-1].total_tokens > 0
    await client.aclose()


async def test_usage_totals_and_costs(tmp_path: Path) -> None:
    fake = FakeLLM()
    client = _client(fake, tmp_path)
    await client.complete_text(MESSAGES, label="a")
    await client.complete_text(MESSAGES, label="b", role="mini")
    await client.embed(["x", "y", "z"], model="emb")
    totals = client.ledger.totals()
    assert totals["requests"] == 3
    assert sum(totals["token_totals"].values()) == totals["total_tokens"]
    assert set(totals["token_totals"]) == {"m-main", "m-mini", "emb"}
    # Not OpenRouter and no provider cost: unknown, never invented.
    assert totals["total_cost_usd"] is None and all(v is None for v in totals["cost_totals_usd"].values())
    lines = [json.loads(l) for l in (tmp_path / "llm_usage.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(lines) == 3 and lines[0]["usage"]["total_tokens"] == lines[0]["total_tokens"]

    priced = FakeLLM(report_cost=True)
    client2 = _client(priced, tmp_path / "p")
    await client2.complete_text(MESSAGES, label="a")
    entry = client2.ledger.entries[0]
    assert entry.cost_source == "provider" and entry.cost_usd and entry.cost_usd > 0
    await client.aclose()
    await client2.aclose()


async def test_temperature_rejection_is_remembered(tmp_path: Path) -> None:
    seen: list[bool] = []

    def reject_temperature(call):
        seen.append("temperature" in call.body)
        return "temperature" in call.body

    fake = FakeLLM(faults=[Fault(status=400, match=reject_temperature, times=None, message="Unsupported value: 'temperature'")])
    client = _client(fake, tmp_path)
    await client.complete_text(MESSAGES, label="a")
    await client.complete_text(MESSAGES, label="b")
    assert seen == [True, False, False]
    await client.aclose()


async def test_missing_key_for_openrouter_is_a_clean_error(tmp_path: Path) -> None:
    settings = LLMSettings(base_url="https://openrouter.ai/api/v1", api_key=None)
    client = LLMClient(settings, ledger=UsageLedger(None), sink=MemorySink(), concurrency=1, transport=FakeLLM().transport())
    with pytest.raises(EngineError, match="OPENROUTER_API_KEY"):
        await client.complete_text(MESSAGES, label="x")
    await client.aclose()


async def test_adaptive_limiter_halves_and_recovers() -> None:
    now = [0.0]
    limiter = AdaptiveLimiter(8, cooldown_s=10, recover_after=2, clock=lambda: now[0])
    limiter.on_throttle()
    assert limiter.limit == 4
    limiter.on_throttle()  # same burst (< 1 s): counted once
    assert limiter.limit == 4
    now[0] = 2.0
    limiter.on_throttle()
    assert limiter.limit == 2
    limiter.on_success()
    limiter.on_success()
    assert limiter.limit == 2  # still cooling down
    now[0] = 20.0
    for _ in range(4):
        limiter.on_success()
    assert limiter.limit == 4
    for _ in range(20):
        limiter.on_success()
    assert limiter.limit == 8


async def test_limiter_bounds_in_flight_requests(tmp_path: Path) -> None:
    fake = FakeLLM(latency_s=0.05)
    client = _client(fake, tmp_path)
    await asyncio.gather(*[client.complete_text(MESSAGES, label=f"c{i}") for i in range(12)])
    assert fake.max_in_flight <= 4 and client.limiter.peak_in_flight == 4
    await client.aclose()


def test_retry_helpers() -> None:
    import httpx

    class E(Exception):
        def __init__(self, headers):
            self.response = httpx.Response(429, headers=headers)
            self.status_code = 429

    assert retry_after_seconds(E({"retry-after": "3"})) == 3
    assert retry_after_seconds(E({"retry-after-ms": "1500"})) == 1.5
    assert retry_after_seconds(E({"retry-after": "9999"})) == 120
    assert retry_after_seconds(E({})) is None
    assert is_transient(E({}))
    for attempt in range(6):
        delay = backoff_seconds(attempt)
        assert 0 < delay <= 60


def test_json_extraction_and_strict_schema() -> None:
    assert extract_json('<think>{"no": 1}</think> Sure! ```json\n{"a": [1, 2]}\n``` done') == {"a": [1, 2]}
    assert extract_json('prefix {"a": {"b": 1}} suffix') == {"a": {"b": 1}}
    with pytest.raises(ValueError):
        extract_json("nothing here")
    schema = json_schema_for(Answer)
    assert schema["additionalProperties"] is False and set(schema["required"]) == {"title", "points", "ok"}
    assert "default" not in json.dumps(schema)
