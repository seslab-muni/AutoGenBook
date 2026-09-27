"""Deterministic, in-process fake of an OpenAI-compatible LLM endpoint.

How the engine is pointed at it (the "injectable transport" choice from issue
#150): every outbound HTTP request the engine makes goes through one
`httpx.AsyncClient`, and `engine.run(config, sink, transport=...)` accepts an
optional `httpx.AsyncBaseTransport` for it. `FakeLLM.transport()` returns such
a transport, so a test exercises the *real* client stack end to end
(`openai.AsyncOpenAI` -> httpx -> request/response JSON, SSE streaming, HTTP
status codes and `Retry-After` headers) without any network and without
monkeypatching engine internals.

For subprocess runs (`run_engine.py`, `scripts/bench_engines.py`, the API's own
`subprocess_runner`) the same fake is served over a loopback socket:
`with FakeLLM().serve() as base_url:` and export
`AUTOGENBOOK_LLM_BASE_URL=<base_url>`. `python tests/engine/fake_llm.py serve`
runs it standalone (used by `docker-compose.engine.yml` for the Playwright
suite).

What it answers:

- `POST .../chat/completions`: a JSON object valid against the requested
  schema. The schema is taken from `response_format.json_schema` when the
  engine asks for it, or from the `Schema name: <Name>` + fenced JSON schema
  block the engine appends to the system prompt in `json_object`/prompt-only
  mode. Registered responders (`responders.py`) produce plausible content per
  schema name; anything else falls back to a generic schema-driven generator.
  `stream=true` is answered as SSE chunks.
- `POST .../embeddings`: deterministic hashed bag-of-words vectors.
- `POST .../rerank` and `.../score`: lexical-overlap scores (either endpoint
  can be switched off to test the client's fallback).
- `POST .../audio/speech`: an MP3 of silent frames, 0.4 s per input word.
- `GET .../models`, Tavily search, and HEAD/GET for DOI/URL verification.

Every request is recorded in `FakeLLM.calls`. Faults (429/503/500 with
`Retry-After`, 400 for unsupported `response_format`) are injected with
`Fault`. `recorded=`/`record_to=` turn it into a record/replay LLM for golden
runs.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import re
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterator

import httpx

try:  # imported as a module from tests/engine (pytest rootdir insertion) ...
    import responders as _responders
except ImportError:  # ... or loaded by path from scripts/
    import importlib.util as _ilu

    _spec = _ilu.spec_from_file_location(
        "fake_llm_responders", Path(__file__).with_name("responders.py")
    )
    _responders = _ilu.module_from_spec(_spec)  # type: ignore[arg-type]
    assert _spec and _spec.loader
    _spec.loader.exec_module(_responders)  # type: ignore[union-attr]

SCHEMA_NAME_RE = re.compile(r"Schema name:\s*([A-Za-z0-9_\-]+)")
SCHEMA_BLOCK_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)
_WORD_RE = re.compile(r"\w+", re.UNICODE)


@dataclass
class Fault:
    """Answer matching requests with an HTTP error instead of a completion.

    `match` receives the parsed call (`FakeCall`) and decides; `times` limits
    how many requests it hits (None = forever)."""

    status: int
    match: Callable[["FakeCall"], bool] = lambda call: True
    times: int | None = 1
    retry_after: float | None = None
    message: str = "injected fault"
    hits: int = 0

    def applies(self, call: "FakeCall") -> bool:
        if self.times is not None and self.hits >= self.times:
            return False
        return bool(self.match(call))


@dataclass
class ChatReply:
    """An override's reply with non-default message fields (e.g. a reasoning
    model that spent its output budget thinking: empty content, reasoning
    text, finish_reason "length")."""

    content: str
    finish_reason: str = "stop"
    reasoning: str | None = None


@dataclass
class FakeCall:
    method: str
    path: str
    host: str
    body: dict[str, Any]
    model: str = ""
    messages: list[dict[str, Any]] = field(default_factory=list)
    response_format: dict[str, Any] | None = None
    response_format_type: str = "none"
    schema_name: str | None = None
    schema: dict[str, Any] | None = None
    stream: bool = False
    status: int = 200
    started: float = 0.0
    finished: float = 0.0
    finish_reason: str = "stop"
    reasoning: str | None = None

    @property
    def system(self) -> str:
        return "\n".join(
            str(m.get("content") or "") for m in self.messages if m.get("role") == "system"
        )

    @property
    def user(self) -> str:
        return "\n".join(
            str(m.get("content") or "") for m in self.messages if m.get("role") == "user"
        )

    @property
    def prompt(self) -> str:
        return "\n".join(str(m.get("content") or "") for m in self.messages)


@dataclass
class FakeResponse:
    status: int
    body: bytes | list[bytes]
    headers: dict[str, str] = field(default_factory=dict)


def _estimate_tokens(text: str) -> int:
    return max(1, math.ceil(len(text) / 4))


class FakeLLM:
    def __init__(
        self,
        *,
        supports: tuple[str, ...] = ("json_schema", "json_object"),
        latency_s: float = 0.0,
        faults: list[Fault] | None = None,
        rerank_endpoint: str | None = "rerank",
        embeddings_enabled: bool = True,
        embed_dim: int = 64,
        report_cost: bool = False,
        wrap_prompt_json_in_fence: bool = True,
        recorded: str | Path | None = None,
        record_to: str | Path | None = None,
        tavily_results: list[dict[str, Any]] | None = None,
        resolvable_urls: set[str] | None = None,
        overrides: dict[str, Callable[[FakeCall], Any]] | None = None,
    ) -> None:
        self.supports = tuple(supports)
        self.latency_s = latency_s
        self.faults = list(faults or [])
        self.rerank_endpoint = rerank_endpoint
        self.embeddings_enabled = embeddings_enabled
        self.embed_dim = embed_dim
        self.report_cost = report_cost
        self.wrap_prompt_json_in_fence = wrap_prompt_json_in_fence
        self.tavily_results = tavily_results or []
        self.resolvable_urls = set(resolvable_urls or set())
        self.overrides = dict(overrides or {})
        self.calls: list[FakeCall] = []
        self._lock = threading.Lock()
        self._in_flight = 0
        self.max_in_flight = 0
        self._recorded: dict[str, Any] | None = None
        if recorded is not None:
            self._recorded = json.loads(Path(recorded).read_text(encoding="utf-8"))
        self._record_to = Path(record_to) if record_to is not None else None
        self._recording: dict[str, Any] = {}

    # ------------------------------------------------------------------ views
    def chat_calls(self, schema_name: str | None = None) -> list[FakeCall]:
        out = [c for c in self.calls if c.path.endswith("/chat/completions")]
        if schema_name is not None:
            out = [c for c in out if c.schema_name == schema_name]
        return out

    def schema_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for call in self.chat_calls():
            key = call.schema_name or "(text)"
            counts[key] = counts.get(key, 0) + 1
        return counts

    # -------------------------------------------------------------- transport
    def transport(self) -> httpx.AsyncBaseTransport:
        fake = self

        class _Transport(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
                import asyncio

                body = await request.aread()
                resp = await asyncio.to_thread(
                    fake.handle, request.method, request.url, dict(request.headers), body
                )
                return _to_httpx(resp, request)

        return _Transport()

    def sync_transport(self) -> httpx.BaseTransport:
        fake = self

        class _Transport(httpx.BaseTransport):
            def handle_request(self, request: httpx.Request) -> httpx.Response:
                body = request.read()
                resp = fake.handle(request.method, request.url, dict(request.headers), body)
                return _to_httpx(resp, request)

        return _Transport()

    @contextlib.contextmanager
    def serve(self, host: str = "127.0.0.1", port: int = 0) -> Iterator[str]:
        server = _make_server(self, host, port)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://{host}:{server.server_address[1]}/v1"
        finally:
            server.shutdown()
            server.server_close()
            self.flush_recording()

    def flush_recording(self) -> None:
        if self._record_to is not None and self._recording:
            self._record_to.parent.mkdir(parents=True, exist_ok=True)
            merged = dict(sorted(self._recording.items()))
            self._record_to.write_text(
                json.dumps(merged, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                encoding="utf-8",
            )

    # ---------------------------------------------------------------- dispatch
    def handle(
        self, method: str, url: httpx.URL | str, headers: dict[str, str], body: bytes
    ) -> FakeResponse:
        url = httpx.URL(str(url))
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except ValueError:
            payload = {}
        call = self._parse_call(method, url, payload)
        with self._lock:
            self.calls.append(call)
            self._in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self._in_flight)
        call.started = time.monotonic()
        try:
            if self.latency_s:
                time.sleep(self.latency_s)
            for fault in self.faults:
                if fault.applies(call):
                    fault.hits += 1
                    call.status = fault.status
                    hdrs = {"content-type": "application/json"}
                    if fault.retry_after is not None:
                        hdrs["retry-after"] = f"{fault.retry_after:g}"
                    return FakeResponse(
                        fault.status,
                        json.dumps({"error": {"message": fault.message, "code": fault.status}}).encode(),
                        hdrs,
                    )
            resp = self._route(call, url)
            call.status = resp.status
            return resp
        finally:
            call.finished = time.monotonic()
            with self._lock:
                self._in_flight -= 1

    def _parse_call(self, method: str, url: httpx.URL, payload: dict[str, Any]) -> FakeCall:
        call = FakeCall(method=method, path=url.path, host=url.host, body=payload)
        call.model = str(payload.get("model") or "")
        call.messages = list(payload.get("messages") or [])
        call.stream = bool(payload.get("stream"))
        rf = payload.get("response_format")
        if isinstance(rf, dict):
            call.response_format = rf
            call.response_format_type = str(rf.get("type") or "none")
            if rf.get("type") == "json_schema":
                js = rf.get("json_schema") or {}
                call.schema_name = str(js.get("name") or "") or None
                call.schema = js.get("schema")
        if call.schema_name is None and call.messages:
            text = call.prompt
            match = SCHEMA_NAME_RE.search(text)
            if match:
                call.schema_name = match.group(1)
                block = SCHEMA_BLOCK_RE.search(text[match.end():])
                if block:
                    try:
                        call.schema = json.loads(block.group(1))
                    except ValueError:
                        call.schema = None
        return call

    def _route(self, call: FakeCall, url: httpx.URL) -> FakeResponse:
        path = url.path.rstrip("/")
        if "tavily" in url.host:
            return _json(200, {"results": list(self.tavily_results)})
        if path.endswith("/chat/completions"):
            return self._chat(call)
        if path.endswith("/embeddings"):
            if not self.embeddings_enabled:
                return _json(404, {"error": {"message": "embeddings not available"}})
            return self._embeddings(call)
        if path.endswith("/rerank"):
            if self.rerank_endpoint != "rerank":
                return _json(404, {"error": {"message": "not found"}})
            return self._rerank(call)
        if path.endswith("/score"):
            if self.rerank_endpoint != "score":
                return _json(404, {"error": {"message": "not found"}})
            return self._score(call)
        if path.endswith("/audio/speech"):
            return self._speech(call)
        if path.endswith("/models"):
            return _json(200, {"data": [{"id": "fake-model"}, {"id": "fake-mini"}]})
        if call.method in {"HEAD", "GET"}:
            full = str(url)
            ok = any(full.startswith(prefix) for prefix in self.resolvable_urls)
            return FakeResponse(200 if ok else 404, b"", {})
        return _json(404, {"error": {"message": f"no fake route for {url}"}})

    # ------------------------------------------------------------------ audio
    def _speech(self, call: FakeCall) -> FakeResponse:
        """OpenAI-style TTS: an MP3 whose length follows the input (0.4 s per
        word), built from valid MPEG-1 Layer III frames."""
        payload = call.body or {}
        text = str(payload.get("input") or "")
        if not text.strip() or not payload.get("model"):
            return _json(400, {"error": {"message": "input and model are required"}})
        frame = bytes([0xFF, 0xFB, 0x90, 0x00]) + bytes(413)  # 128 kbit/s, 44.1 kHz, 1152 samples
        seconds = max(0.5, 0.4 * len(text.split()))
        return FakeResponse(200, frame * max(1, round(seconds * 44100 / 1152)), {"content-type": "audio/mpeg"})

    # ------------------------------------------------------------------- chat
    def _chat(self, call: FakeCall) -> FakeResponse:
        if call.response_format_type not in {"none", "text"} and call.response_format_type not in self.supports:
            return _json(
                400,
                {
                    "error": {
                        "message": f"response_format type '{call.response_format_type}' is not supported by this model",
                        "type": "invalid_request_error",
                    }
                },
            )
        fingerprint = request_fingerprint(call)
        if self._recorded is not None:
            if fingerprint not in self._recorded:
                return _json(
                    500,
                    {
                        "error": {
                            "message": (
                                f"golden drift: no recorded response for schema={call.schema_name} "
                                f"fingerprint={fingerprint}; re-record with ENGINE_UPDATE_GOLDEN=1"
                            )
                        }
                    },
                )
            content = self._recorded[fingerprint]["content"]
        else:
            content = self._generate_content(call)
            if self._record_to is not None:
                self._recording[fingerprint] = {
                    "schema": call.schema_name,
                    "node": _responders.node_key_of(call.prompt),
                    "content": content,
                }
        prompt_tokens = _estimate_tokens(json.dumps(call.messages, ensure_ascii=False))
        completion_tokens = _estimate_tokens(content)
        usage: dict[str, Any] = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }
        if self.report_cost:
            usage["cost"] = round((prompt_tokens * 0.1 + completion_tokens * 0.4) / 1_000_000, 8)
        created = 1_700_000_000
        cid = "chatcmpl-" + fingerprint
        if call.stream:
            chunks: list[bytes] = []
            pieces = _split_for_stream(content)
            for i, piece in enumerate(pieces):
                delta: dict[str, Any] = {"content": piece}
                if i == 0:
                    delta["role"] = "assistant"
                chunk = {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": call.model,
                    "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                }
                chunks.append(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
            final = {
                "id": cid,
                "object": "chat.completion.chunk",
                "created": created,
                "model": call.model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            chunks.append(f"data: {json.dumps(final)}\n\n".encode())
            if (call.body.get("stream_options") or {}).get("include_usage"):
                usage_chunk = {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": call.model,
                    "choices": [],
                    "usage": usage,
                }
                chunks.append(f"data: {json.dumps(usage_chunk)}\n\n".encode())
            chunks.append(b"data: [DONE]\n\n")
            return FakeResponse(200, chunks, {"content-type": "text/event-stream"})
        return _json(
            200,
            {
                "id": cid,
                "object": "chat.completion",
                "created": created,
                "model": call.model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content,
                                    **({"reasoning_content": call.reasoning} if call.reasoning else {})},
                        "finish_reason": call.finish_reason,
                    }
                ],
                "usage": usage,
            },
        )

    def _generate_content(self, call: FakeCall) -> str:
        if call.schema_name is None:
            override = self.overrides.get("(text)")
            if override is not None:
                reply = override(call)
                if isinstance(reply, ChatReply):
                    call.finish_reason, call.reasoning = reply.finish_reason, reply.reasoning
                    return reply.content
                return str(reply)
            return _responders.plain_text(call)
        override = self.overrides.get(call.schema_name)
        obj = override(call) if override is not None else _responders.respond(call)
        if isinstance(obj, ChatReply):
            call.finish_reason, call.reasoning = obj.finish_reason, obj.reasoning
            return obj.content
        if isinstance(obj, str):
            return obj
        text = json.dumps(obj, ensure_ascii=False)
        if call.response_format_type == "none" and self.wrap_prompt_json_in_fence:
            # Prompt-only JSON mode: wrap it the way chatty models do, so the
            # engine's extraction path is exercised.
            return "Here is the JSON:\n```json\n" + text + "\n```"
        return text

    # ------------------------------------------------------------- embeddings
    def _embeddings(self, call: FakeCall) -> FakeResponse:
        inputs = call.body.get("input")
        if isinstance(inputs, str):
            inputs = [inputs]
        inputs = [str(x) for x in (inputs or [])]
        data = [
            {"object": "embedding", "index": i, "embedding": embed_text(text, self.embed_dim)}
            for i, text in enumerate(inputs)
        ]
        tokens = sum(_estimate_tokens(t) for t in inputs)
        return _json(
            200,
            {
                "object": "list",
                "data": data,
                "model": call.model,
                "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
            },
        )

    def _rerank(self, call: FakeCall) -> FakeResponse:
        query = str(call.body.get("query") or "")
        docs = [str(d if not isinstance(d, dict) else d.get("text", "")) for d in call.body.get("documents") or []]
        scores = [overlap_score(query, d) for d in docs]
        order = sorted(range(len(docs)), key=lambda i: (-scores[i], i))
        top_n = int(call.body.get("top_n") or len(docs))
        results = [{"index": i, "relevance_score": scores[i]} for i in order[:top_n]]
        tokens = _estimate_tokens(query) * max(1, len(docs)) + sum(_estimate_tokens(d) for d in docs)
        return _json(200, {"id": "rerank-fake", "model": call.model, "results": results, "usage": {"total_tokens": tokens}})

    def _score(self, call: FakeCall) -> FakeResponse:
        query = str(call.body.get("text_1") or "")
        docs = call.body.get("text_2") or []
        if isinstance(docs, str):
            docs = [docs]
        data = [{"index": i, "object": "score", "score": overlap_score(query, str(d))} for i, d in enumerate(docs)]
        tokens = sum(_estimate_tokens(str(d)) for d in docs)
        return _json(200, {"id": "score-fake", "model": call.model, "data": data, "usage": {"total_tokens": tokens}})


def request_fingerprint(call: FakeCall) -> str:
    """Stable key of a chat request for record/replay (model excluded, so a
    recording survives a model rename; prompts included, so prompt drift is
    caught)."""
    payload = {
        "messages": call.messages,
        "schema": call.schema_name,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]


def _tokens(text: str) -> list[str]:
    return [t.casefold() for t in _WORD_RE.findall(text)]


def embed_text(text: str, dim: int = 64) -> list[float]:
    vec = [0.0] * dim
    for tok in _tokens(text):
        h = int(hashlib.md5(tok.encode("utf-8")).hexdigest(), 16)
        vec[h % dim] += 1.0 if (h >> 8) % 2 == 0 else -1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [round(v / norm, 6) for v in vec]


def overlap_score(query: str, doc: str) -> float:
    q = set(_tokens(query))
    d = set(_tokens(doc))
    if not q or not d:
        return 0.0
    return round(len(q & d) / math.sqrt(len(q) * len(d)), 6)


def _split_for_stream(content: str, size: int = 40) -> list[str]:
    if not content:
        return [""]
    return [content[i : i + size] for i in range(0, len(content), size)]


def _json(status: int, obj: Any) -> FakeResponse:
    return FakeResponse(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"), {"content-type": "application/json"})


def _to_httpx(resp: FakeResponse, request: httpx.Request) -> httpx.Response:
    if isinstance(resp.body, list):
        return httpx.Response(resp.status, headers=resp.headers, content=b"".join(resp.body), request=request)
    return httpx.Response(resp.status, headers=resp.headers, content=resp.body, request=request)


def _make_server(fake: FakeLLM, host: str, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:  # silence
            return

        def _serve(self, method: str) -> None:
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length) if length else b""
            host_header = self.headers.get("host") or f"{host}:{port}"
            url = f"http://{host_header}{self.path}"
            resp = fake.handle(method, url, dict(self.headers), body)
            payload = b"".join(resp.body) if isinstance(resp.body, list) else resp.body
            self.send_response(resp.status)
            for key, value in resp.headers.items():
                self.send_header(key, value)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            if method != "HEAD":
                self.wfile.write(payload)

        def do_POST(self) -> None:  # noqa: N802
            self._serve("POST")

        def do_GET(self) -> None:  # noqa: N802
            self._serve("GET")

        def do_HEAD(self) -> None:  # noqa: N802
            self._serve("HEAD")

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve the deterministic fake LLM over HTTP.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    serve = sub.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8099)
    serve.add_argument("--latency", type=float, default=0.0)
    args = parser.parse_args(argv)
    fake = FakeLLM(latency_s=args.latency)
    server = _make_server(fake, args.host, args.port)
    print(f"fake LLM listening on http://{args.host}:{server.server_address[1]}/v1", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
