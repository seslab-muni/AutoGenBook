"""Async LLM client: one `httpx.AsyncClient` + `openai.AsyncOpenAI` per run.

- Structured output ladder, probed once per model per run: `json_schema`
  (generated from the pydantic model) -> `json_object` -> prompt-only JSON.
  A provider that rejects a level (HTTP 400/422 on the first call, or a
  format-related message later) is downgraded and the request re-sent; the
  chosen level is cached so later calls pay nothing. A reply that does not
  validate gets exactly one repair call.
- Retries on transient errors only (timeouts, connection errors, 408/409/425/
  429/5xx) with jittered exponential backoff that honours `Retry-After`.
- Adaptive concurrency (`AdaptiveLimiter`): 429/503 halve the in-flight limit.
- Streaming (`complete_text(stream=True, on_delta=...)`).
- Every HTTP request, successful or not, is one ledger line.

All outbound HTTP of a run (chat, embeddings, rerank, TTS, pricing, web
checks) goes through `self.http`, whose transport can be injected
(`engine.run(..., transport=...)`); that is how tests use the fake LLM.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, TypeVar

import httpx
import openai
from pydantic import BaseModel, ValidationError

from engine.config import LLMSettings, is_openrouter
from engine.errors import EngineError, SchemaError
from engine.events import EventSink
from engine.llm.limiter import AdaptiveLimiter
from engine.llm.pricing import Pricing
from engine.llm.retry import THROTTLE_STATUS, backoff_seconds, is_transient, retry_after_seconds, status_of
from engine.llm.structured import Level, extract_json, json_schema_for, looks_unrelated_to_format, names_response_format, schema_instructions
from engine.llm.usage import UsageEntry, UsageLedger

T = TypeVar("T")
_BARE_JSON_RE = re.compile(r"(?:```(?:json)?\s*)?\{.*\}(?:\s*```)?", re.DOTALL)
M = TypeVar("M", bound=BaseModel)


@dataclass
class ChatResult:
    text: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    finish_reason: str | None = None
    level: str | None = None


@dataclass
class _StreamOutcome:
    text: str
    usage: Any
    finish_reason: str | None


def _usage_numbers(usage: Any) -> tuple[int, int, int, Any]:
    if usage is None:
        return 0, 0, 0, None
    data = usage.model_dump() if hasattr(usage, "model_dump") else dict(usage)
    prompt = int(data.get("prompt_tokens") or data.get("input_tokens") or 0)
    completion = int(data.get("completion_tokens") or data.get("output_tokens") or 0)
    total = int(data.get("total_tokens") or (prompt + completion))
    return prompt, completion, total, data.get("cost")


class LLMClient:
    def __init__(
        self,
        settings: LLMSettings,
        *,
        ledger: UsageLedger,
        sink: EventSink,
        concurrency: int,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self.ledger = ledger
        self.sink = sink
        timeout = httpx.Timeout(settings.timeout_s, connect=min(30.0, settings.timeout_s))
        self.http = httpx.AsyncClient(transport=transport, timeout=timeout, follow_redirects=True)
        self.limiter = AdaptiveLimiter(concurrency, on_change=self._on_limit_change)
        self.pricing = Pricing(
            base_url=settings.base_url,
            enabled=settings.is_openrouter and not settings.pricing_disabled,
            http=self.http,
            api_key=settings.api_key,
            cache_path=settings.pricing_cache_path,
            timeout_s=settings.pricing_timeout_s,
        )
        self._clients: dict[tuple[str, str], openai.AsyncOpenAI] = {}
        self._levels: dict[str, Level] = {}
        self._settled: set[str] = set()
        self._probe_locks: dict[str, asyncio.Lock] = {}
        self._no_temperature: set[str] = set()
        self._no_stream_options: set[str] = set()

    # ------------------------------------------------------------ plumbing
    def _on_limit_change(self, old: int, new: int, reason: str) -> None:
        if reason == "throttled":
            self.sink.emit("info", f"LLM endpoint is throttling (429/503): concurrency {old} -> {new}", level="warning")
        else:
            self.sink.emit("info", f"LLM concurrency recovered: {old} -> {new}")

    def openai_for(self, base_url: str | None = None, api_key: str | None = None) -> openai.AsyncOpenAI:
        base = (base_url or self.settings.base_url).rstrip("/")
        key = api_key or self.settings.api_key
        if not key:
            if is_openrouter(base):
                raise EngineError(
                    "Missing OPENROUTER_API_KEY. Set it (or AUTOGENBOOK_LLM_BASE_URL and "
                    "AUTOGENBOOK_LLM_API_KEY for another OpenAI-compatible endpoint) before running."
                )
            key = "local"
        cache_key = (base, key)
        client = self._clients.get(cache_key)
        if client is None:
            headers: dict[str, str] = {}
            if self.settings.http_referer:
                headers["HTTP-Referer"] = self.settings.http_referer
            if self.settings.x_title:
                headers["X-Title"] = self.settings.x_title
            client = openai.AsyncOpenAI(
                base_url=base,
                api_key=key,
                max_retries=0,
                timeout=self.settings.timeout_s,
                http_client=self.http,
                default_headers=headers or None,
            )
            self._clients[cache_key] = client
        return client

    async def _call(
        self,
        fn: Callable[[], Awaitable[T]],
        *,
        label: str,
        kind: str,
        model: str,
        node_key: str | None = None,
        response_format: str | None = None,
        usage_of: Callable[[T], tuple[int, int, int, Any]] = lambda _r: (0, 0, 0, None),
        limited: bool = True,
    ) -> T:
        """One logical request with transient retries and a ledger entry per
        attempt. `limited=False` (media such as TTS) bypasses the adaptive
        LLM limiter: those requests do not compete for chat concurrency."""
        attempt = 0
        while True:
            attempt += 1
            started = time.perf_counter()
            try:
                if limited:
                    async with self.limiter.slot():
                        result = await fn()
                else:
                    result = await fn()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - classified below, re-raised when fatal
                status = status_of(exc)
                self.ledger.record(
                    UsageEntry(
                        label=label, kind=kind, model=model, node_key=node_key, attempt=attempt,
                        status=status if status is not None else type(exc).__name__,
                        response_format=response_format, latency_s=round(time.perf_counter() - started, 3),
                        error=str(exc)[:500],
                    )
                )
                if status in THROTTLE_STATUS and limited:
                    self.limiter.on_throttle()
                if is_transient(exc) and attempt <= self.settings.max_retries:
                    delay = backoff_seconds(attempt - 1, retry_after=retry_after_seconds(exc))
                    self.sink.emit(
                        "info", f"{label}: transient error ({status or type(exc).__name__}); retry {attempt}/{self.settings.max_retries} in {delay:.1f}s",
                        level="debug", node_key=node_key,
                    )
                    await asyncio.sleep(delay)
                    continue
                raise
            prompt, completion, total, provider_cost = usage_of(result)
            if kind == "tts":  # priced per character/second, not per token: provider-reported or unknown
                cost, source = (float(provider_cost), "provider") if provider_cost is not None else (None, None)
            else:
                cost, source = await self.pricing.cost(model, prompt, completion, provider_cost)
            self.ledger.record(
                UsageEntry(
                    label=label, kind=kind, model=model, node_key=node_key, attempt=attempt, status="ok",
                    response_format=response_format, prompt_tokens=prompt, completion_tokens=completion,
                    total_tokens=total, cost_usd=cost, cost_source=source,
                    latency_s=round(time.perf_counter() - started, 3),
                )
            )
            if limited:
                self.limiter.on_success()
            return result

    # ------------------------------------------------------------------ chat
    async def complete_text(
        self,
        messages: list[dict[str, Any]],
        *,
        label: str,
        role: str = "main",
        model: str | None = None,
        node_key: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_format: dict[str, Any] | None = None,
        stream: bool = False,
        on_delta: Callable[[str], None] | None = None,
    ) -> ChatResult:
        model = model or self.settings.resolve(role)
        client = self.openai_for()
        rf_label = (response_format or {}).get("type") if response_format else None

        while True:
            kwargs: dict[str, Any] = {"model": model, "messages": messages}
            temp = self.settings.temperature if temperature is None else temperature
            if model not in self._no_temperature:
                kwargs["temperature"] = temp
            if max_tokens:
                kwargs["max_tokens"] = max_tokens
            if response_format:
                kwargs["response_format"] = response_format
            if self.settings.is_openrouter:
                kwargs["extra_body"] = {"usage": {"include": True}}
            try:
                if not stream:
                    completion = await self._call(
                        lambda: client.chat.completions.create(**kwargs),
                        label=label, kind="chat", model=model, node_key=node_key,
                        response_format=rf_label or "text", usage_of=lambda r: _usage_numbers(getattr(r, "usage", None)),
                    )
                    choice = completion.choices[0] if completion.choices else None
                    message = choice.message if choice else None
                    text = (message.content if message else None) or ""
                    finish = choice.finish_reason if choice else None
                    if not text and message is not None and finish == "stop":
                        # Some reasoning parsers (vLLM without think tags) file a finished
                        # answer under reasoning_content. Only a bare JSON answer is taken
                        # from there - never scratch work that merely contains a draft,
                        # and never a reply cut off by the output limit.
                        extra = message.model_dump() if hasattr(message, "model_dump") else {}
                        reasoning = str(extra.get("reasoning_content") or extra.get("reasoning") or "").strip()
                        if _BARE_JSON_RE.fullmatch(reasoning):
                            text = reasoning
                    p, c, t, _ = _usage_numbers(getattr(completion, "usage", None))
                    return ChatResult(text, model, p, c, t, choice.finish_reason if choice else None, rf_label)
                outcome = await self._call(
                    lambda: self._consume_stream(client, kwargs, model, on_delta),
                    label=label, kind="chat_stream", model=model, node_key=node_key,
                    response_format=rf_label or "text", usage_of=lambda r: _usage_numbers(r.usage),
                )
                p, c, t, _ = _usage_numbers(outcome.usage)
                return ChatResult(outcome.text, model, p, c, t, outcome.finish_reason, rf_label)
            except openai.BadRequestError as exc:
                message = str(exc).lower()
                if "temperature" in message and model not in self._no_temperature:
                    self._no_temperature.add(model)
                    continue
                if stream and "stream_options" in message and model not in self._no_stream_options:
                    self._no_stream_options.add(model)
                    continue
                raise

    async def _consume_stream(
        self, client: openai.AsyncOpenAI, kwargs: dict[str, Any], model: str, on_delta: Callable[[str], None] | None
    ) -> _StreamOutcome:
        extra: dict[str, Any] = {"stream": True}
        if model not in self._no_stream_options:
            extra["stream_options"] = {"include_usage": True}
        stream = await client.chat.completions.create(**kwargs, **extra)
        parts: list[str] = []
        usage = None
        finish = None
        async for chunk in stream:
            if chunk.choices:
                delta = chunk.choices[0].delta.content or ""
                if delta:
                    parts.append(delta)
                    if on_delta is not None:
                        on_delta(delta)
                finish = chunk.choices[0].finish_reason or finish
            if getattr(chunk, "usage", None) is not None:
                usage = chunk.usage
        return _StreamOutcome("".join(parts), usage, finish)

    # ------------------------------------------------------------ structured
    def level_for(self, model: str) -> Level:
        return self._levels.get(model, Level.JSON_SCHEMA)

    async def structured(
        self,
        messages: list[dict[str, Any]],
        output: type[M],
        *,
        label: str,
        role: str = "main",
        model: str | None = None,
        node_key: str | None = None,
        temperature: float | None = None,
    ) -> M:
        model = model or self.settings.resolve(role)
        name = output.__name__
        schema = json_schema_for(output)
        lock = self._probe_locks.setdefault(model, asyncio.Lock())
        probing = model not in self._settled
        if probing:
            await lock.acquire()
            probing = model not in self._settled
            if not probing:
                lock.release()
        try:
            level = self.level_for(model)
            while True:
                msgs = self._json_messages(messages, name, schema, level)
                try:
                    result = await self.complete_text(
                        msgs, label=label, model=model, node_key=node_key, temperature=temperature,
                        response_format=self._response_format(level, name, schema),
                    )
                    break
                except (openai.BadRequestError, openai.UnprocessableEntityError, openai.NotFoundError) as exc:
                    message = str(exc)
                    # Settled models downgrade only on an explicit response_format
                    # rejection; while probing, anything not clearly unrelated counts
                    # (and is recorded only if the weaker level then succeeds).
                    explicit = getattr(exc, "param", None) == "response_format" or names_response_format(message)
                    downgrade = explicit or (probing and not looks_unrelated_to_format(message))
                    if level < Level.PROMPT and downgrade:
                        new_level = Level(level + 1)
                        self.sink.emit("info", f"Model {model} rejected response_format={level.label}; trying {new_level.label}", level="debug")
                        level = new_level
                        continue
                    # Not a format problem (e.g. context length), or no weaker level
                    # left: this attempt's own error is the one to report; the
                    # recorded level is unchanged.
                    raise
            # A downgrade is recorded only once a call at the weaker level
            # succeeded, and never undone by a concurrent call that started
            # at the stronger level.
            if level > self.level_for(model):
                self._levels[model] = level
                self.sink.emit("info", f"Model {model}: structured output via {level.label}", level="warning")
            if probing:
                self._settled.add(model)
        finally:
            if probing and lock.locked():
                lock.release()

        if not (result.text or "").strip() and result.finish_reason == "length":
            raise SchemaError(label, "the model returned no content before reaching its output limit (finish_reason=length)")

        try:
            return output.model_validate(extract_json(result.text))
        except (ValueError, ValidationError) as first_error:
            detail = _short_error(first_error)
        repair = self._json_messages(messages, name, schema, level) + [
            {"role": "assistant", "content": (result.text or "")[:30000]},
            {
                "role": "user",
                "content": (
                    f"That reply cannot be used: {detail}. Reply again with only the corrected JSON "
                    f"object for schema {name}, keeping all content that was valid."
                ),
            },
        ]
        fixed = await self.complete_text(
            repair, label=f"{label}.repair", model=model, node_key=node_key, temperature=temperature,
            response_format=self._response_format(level, name, schema),
        )
        try:
            return output.model_validate(extract_json(fixed.text))
        except (ValueError, ValidationError) as second_error:
            raise SchemaError(label, _short_error(second_error)) from second_error

    @staticmethod
    def _response_format(level: Level, name: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        if level == Level.JSON_SCHEMA:
            return {"type": "json_schema", "json_schema": {"name": name, "schema": schema, "strict": True}}
        if level == Level.JSON_OBJECT:
            return {"type": "json_object"}
        return None

    @staticmethod
    def _json_messages(messages: list[dict[str, Any]], name: str, schema: dict[str, Any], level: Level) -> list[dict[str, Any]]:
        if level == Level.JSON_SCHEMA:
            note = f"Respond with a JSON object (schema {name})."
        else:
            note = schema_instructions(name, schema)
        out = [dict(m) for m in messages]
        for message in out:
            if message.get("role") == "system":
                message["content"] = f"{message.get('content', '')}\n\n{note}".strip()
                return out
        return [{"role": "system", "content": note}] + out

    # ------------------------------------------------------- other endpoints
    async def embed(
        self,
        texts: list[str],
        *,
        model: str,
        base_url: str | None = None,
        api_key: str | None = None,
        label: str = "embed",
        batch_size: int = 64,
    ) -> list[list[float]]:
        client = self.openai_for(base_url, api_key)
        vectors: list[list[float]] = []
        for start in range(0, len(texts), batch_size):
            batch = texts[start : start + batch_size]
            resp = await self._call(
                lambda batch=batch: client.embeddings.create(model=model, input=batch),
                label=label, kind="embeddings", model=model,
                usage_of=lambda r: _usage_numbers(getattr(r, "usage", None)),
            )
            ordered = sorted(resp.data, key=lambda d: d.index)
            vectors.extend([list(map(float, d.embedding)) for d in ordered])
        return vectors

    async def post_json(
        self, url: str, payload: dict[str, Any], *, label: str, kind: str, model: str, api_key: str | None = None
    ) -> Any:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

        async def fn() -> Any:
            resp = await self.http.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            return resp.json()

        def usage_of(data: Any) -> tuple[int, int, int, Any]:
            usage = (data or {}).get("usage") if isinstance(data, dict) else None
            return _usage_numbers(usage) if isinstance(usage, dict) else (0, 0, 0, None)

        return await self._call(fn, label=label, kind=kind, model=model, usage_of=usage_of)

    async def post_bytes(
        self, url: str, payload: dict[str, Any], *, label: str, kind: str, model: str, api_key: str | None = None,
        node_key: str | None = None, limited: bool = True, timeout: float | None = None,
    ) -> bytes:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        cost: dict[str, float | None] = {"value": None}

        async def fn() -> bytes:
            resp = await self.http.post(url, json=payload, headers=headers, **({"timeout": timeout} if timeout else {}))
            resp.raise_for_status()
            reported = resp.headers.get("x-openrouter-cost") or resp.headers.get("x-cost-usd")
            try:
                cost["value"] = float(reported) if reported else None
            except ValueError:
                cost["value"] = None
            return resp.content

        return await self._call(fn, label=label, kind=kind, model=model, node_key=node_key, limited=limited,
                                usage_of=lambda _data: (0, 0, 0, cost["value"]))

    async def aclose(self) -> None:
        for client in self._clients.values():
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                pass
        await self.http.aclose()


def _short_error(exc: BaseException) -> str:
    text = str(exc).replace("\n", " ")
    return text[:400]
