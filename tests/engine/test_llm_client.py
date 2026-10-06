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


async def test_unrelated_400_does_not_downgrade_the_level(tmp_path: Path) -> None:
    """A context-length 400 during the first (probing) call is raised as is;
    the structured-output level is only recorded after a successful call."""
    fake = FakeLLM(faults=[Fault(status=400, match=lambda c: "/chat/" in c.path, times=1,
                                 message="This model's maximum context length is 8192 tokens.")])
    client = _client(fake, tmp_path)
    with pytest.raises(openai.BadRequestError):
        await client.structured(MESSAGES, Answer, label="t")
    assert len(fake.chat_calls()) == 1 and client.level_for("m-main") == Level.JSON_SCHEMA
    out = await client.structured(MESSAGES, Answer, label="t")
    assert isinstance(out, Answer) and fake.chat_calls()[-1].response_format_type == "json_schema"
    await client.aclose()


async def test_reasoning_is_never_the_answer(tmp_path: Path) -> None:
    from fake_llm import ChatReply

    leaked = '{"title": "from the reasoning", "points": []}'
    thinking = lambda call: ChatReply("", finish_reason="length", reasoning=f"Let me think... {leaked}")  # noqa: E731
    fake = FakeLLM(overrides={"Answer": thinking, "(text)": thinking})
    client = _client(fake, tmp_path)
    with pytest.raises(SchemaError, match="finish_reason=length"):
        await client.structured(MESSAGES, Answer, label="t")
    assert len(fake.chat_calls()) == 1  # no repair round for an exhausted output budget
    text = await client.complete_text(MESSAGES, label="t")
    assert text.text == "" and text.finish_reason == "length"
    await client.aclose()


async def test_reasoning_effort_is_sent_only_when_configured(tmp_path: Path) -> None:
    fake = FakeLLM()
    plain = _client(fake, tmp_path)
    await plain.complete_text(MESSAGES, label="a")
    assert "reasoning_effort" not in fake.calls[-1].body
    await plain.aclose()
    low = _client(fake, tmp_path, reasoning_effort="low")
    await low.complete_text(MESSAGES, label="b")
    await low.complete_text(MESSAGES, label="c", role="mini")
    assert [c.body.get("reasoning_effort") for c in fake.calls[-2:]] == ["low", "low"]
    await low.aclose()


async def test_reasoning_effort_rejection_is_remembered_per_model(tmp_path: Path) -> None:
    seen: list[tuple[str, bool]] = []

    def reject(call):
        has = "reasoning_effort" in call.body
        seen.append((call.body["model"], has))
        return has and call.body["model"] == "m-mini"

    fake = FakeLLM(faults=[Fault(status=400, match=reject, times=None, message="Unknown parameter: 'reasoning_effort'")])
    client = _client(fake, tmp_path, reasoning_effort="low")
    await client.complete_text(MESSAGES, label="a", role="mini")
    await client.complete_text(MESSAGES, label="b", role="mini")
    await client.complete_text(MESSAGES, label="c")
    assert seen == [("m-mini", True), ("m-mini", False), ("m-mini", False), ("m-main", True)]
    await client.aclose()


class _SpyLimiter:
    def __init__(self) -> None:
        self.slots = 0
        self.throttles = 0
        self.successes = 0

    def slot(self):
        import contextlib

        @contextlib.asynccontextmanager
        async def cm():
            self.slots += 1
            yield

        return cm()

    def on_throttle(self) -> None:
        self.throttles += 1

    def on_success(self) -> None:
        self.successes += 1


def _stub_embedding_client(client: LLMClient, delays: dict[str, float] | None = None, in_flight: list[int] | None = None):
    from types import SimpleNamespace

    state = {"now": 0}

    async def create(*, model, input):  # noqa: A002
        state["now"] += 1
        if in_flight is not None:
            in_flight.append(state["now"])
        await asyncio.sleep((delays or {}).get(input[0], 0.0))
        state["now"] -= 1
        data = [SimpleNamespace(index=i, embedding=[float(t)]) for i, t in enumerate(input)]
        return SimpleNamespace(data=list(reversed(data)), usage=None)

    stub = SimpleNamespace(embeddings=SimpleNamespace(create=create))
    client.openai_for = lambda *_a, **_k: stub  # type: ignore[method-assign]


async def test_parallel_embed_keeps_input_order_and_bounds_concurrency(tmp_path: Path) -> None:
    client = _client(FakeLLM(), tmp_path)
    texts = [str(i) for i in range(10)]
    # Earlier batches finish later.
    delays = {str(i): (10 - i) * 0.01 for i in range(10)}
    peaks: list[int] = []
    _stub_embedding_client(client, delays, peaks)
    out = await client.embed(texts, model="e", batch_size=1, parallel=4)
    assert [v[0] for v in out] == [float(i) for i in range(10)]
    assert max(peaks) == 4
    await client.aclose()


async def test_sequential_embed_is_unchanged(tmp_path: Path) -> None:
    client = _client(FakeLLM(), tmp_path)
    peaks: list[int] = []
    _stub_embedding_client(client, None, peaks)
    out = await client.embed([str(i) for i in range(5)], model="e", batch_size=2)
    assert [v[0] for v in out] == [0.0, 1.0, 2.0, 3.0, 4.0]
    assert max(peaks) == 1
    await client.aclose()


@pytest.mark.parametrize("limited", [True, False])
async def test_unlimited_embed_never_touches_the_limiter(tmp_path: Path, limited: bool) -> None:
    client = _client(FakeLLM(), tmp_path)
    spy = _SpyLimiter()
    client.limiter = spy  # type: ignore[assignment]
    _stub_embedding_client(client)
    await client.embed(["1", "2", "3"], model="e", batch_size=1, limited=limited, parallel=2)
    assert (spy.slots, spy.successes) == ((3, 3) if limited else (0, 0))
    await client.aclose()


@pytest.mark.parametrize("limited", [True, False])
async def test_throttle_on_unlimited_call_leaves_the_limiter_alone(tmp_path: Path, limited: bool) -> None:
    fake = FakeLLM(faults=[Fault(status=429, match=lambda c: c.path.endswith("/embeddings"), times=1, retry_after=0)])
    client = _client(fake, tmp_path)
    spy = _SpyLimiter()
    client.limiter = spy  # type: ignore[assignment]
    out = await client.embed(["hello"], model="e", limited=limited)
    assert len(out) == 1
    assert spy.throttles == (1 if limited else 0)
    await client.aclose()


async def test_parallel_embed_failure_cancels_the_rest(tmp_path: Path) -> None:
    from types import SimpleNamespace

    client = _client(FakeLLM(), tmp_path, max_retries=0)
    started: list[str] = []

    async def create(*, model, input):  # noqa: A002
        started.append(input[0])
        if input[0] == "0":
            await asyncio.sleep(0.01)
            raise RuntimeError("boom")
        await asyncio.sleep(0.5)
        return SimpleNamespace(data=[SimpleNamespace(index=0, embedding=[1.0])], usage=None)

    client.openai_for = lambda *_a, **_k: SimpleNamespace(embeddings=SimpleNamespace(create=create))  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="boom"):
        await client.embed([str(i) for i in range(6)], model="e", batch_size=1, parallel=3)
    assert sorted(started) == ["0", "1", "2"]  # batches 3..5 never started
    await asyncio.sleep(0.6)
    assert sorted(started) == ["0", "1", "2"]
    assert [t for t in asyncio.all_tasks() if t is not asyncio.current_task()] == []
    await client.aclose()


async def test_parallel_embed_cancellation_cancels_every_batch(tmp_path: Path) -> None:
    from types import SimpleNamespace

    client = _client(FakeLLM(), tmp_path)
    started: list[str] = []
    cancelled: list[str] = []

    async def create(*, model, input):  # noqa: A002
        started.append(input[0])
        try:
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            cancelled.append(input[0])
            raise

    client.openai_for = lambda *_a, **_k: SimpleNamespace(embeddings=SimpleNamespace(create=create))  # type: ignore[method-assign]
    task = asyncio.ensure_future(client.embed([str(i) for i in range(6)], model="e", batch_size=1, parallel=3))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert sorted(cancelled) == sorted(started) == ["0", "1", "2"]
    assert [t for t in asyncio.all_tasks() if t is not asyncio.current_task()] == []
    await client.aclose()
