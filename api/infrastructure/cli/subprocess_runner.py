"""Run the book-mode CLI as a subprocess and stream structured `RunEvent`s.

Owns the process lifecycle only: starting it, turning its stdout into
events via `stdout_parser`, watching `structure_graph.json` for newly
completed sections, and tearing the process (and its children, e.g.
`lualatex`) down on cancellation or timeout. Building the command itself is
`book_command.py`'s job.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from api.domain.models import RunEvent
from api.infrastructure.cli.stdout_parser import parse_line

# Default grace period between SIGTERM and SIGKILL on cancellation.
# Overridable per call (e.g. from `settings.cli_cancel_grace_s`).
CANCEL_GRACE_S = 15.0

# How often the watcher thread checks structure_graph.json's mtime.
GRAPH_POLL_INTERVAL_S = 1.0

# How often the main loop polls the process/cancellation state.
_WAIT_POLL_INTERVAL_S = 0.2

STRUCTURE_GRAPH_FILENAME = "structure_graph.json"
OUT_DIRNAME = "out"

OnEvent = Callable[[RunEvent], None]
ShouldCancel = Callable[[], bool]


def _kill_process_group(proc: subprocess.Popen, sig: int) -> None:
    try:
        if os.name == "posix":
            os.killpg(os.getpgid(proc.pid), sig)
        else:  # pragma: no cover - Windows fallback, not exercised in CI
            proc.send_signal(sig)
    except (ProcessLookupError, PermissionError):
        pass


def _initial_content_keys(graph_path: Path) -> set[str]:
    """Node keys that already have `content_file_path` set before this
    subprocess even starts - a `--resume` run (issue #11's `regenerate_
    section`/`export`) reuses a `structure_graph.json` most of whose nodes
    were completed by an earlier run. Seeding `_watch_structure_graph`'s
    `seen_keys` with these keeps it from re-announcing every already-done
    section as a fresh `"section"` event the moment it takes its first
    poll; a `full` run's graph doesn't exist yet at this point, so this is
    an empty set there and behavior is unchanged."""
    try:
        data = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    nodes = data.get("nodes") or {}
    return {
        key
        for key, attrs in nodes.items()
        if isinstance(attrs, dict) and attrs.get("content_file_path")
    }


def _watch_structure_graph(
    graph_path: Path,
    emit: Callable[[str, str, str, dict | None], None],
    stop_event: threading.Event,
    poll_interval_s: float,
    initial_seen_keys: set[str] | None = None,
) -> None:
    seen_keys: set[str] = set(initial_seen_keys) if initial_seen_keys else set()
    last_mtime: float | None = None

    def poll_once() -> None:
        nonlocal last_mtime
        try:
            mtime = graph_path.stat().st_mtime
        except OSError:
            return
        if mtime == last_mtime:
            return
        last_mtime = mtime
        try:
            data = json.loads(graph_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        nodes = data.get("nodes") or {}
        for key, attrs in nodes.items():
            if key in seen_keys:
                continue
            content_path = attrs.get("content_file_path") if isinstance(attrs, dict) else None
            if not content_path:
                continue
            seen_keys.add(key)
            title = attrs.get("title") or key
            emit(
                "info",
                "section",
                f"Section '{title}' generated",
                {"node_key": key, "content_file_path": content_path},
            )

    while not stop_event.is_set():
        poll_once()
        stop_event.wait(poll_interval_s)
    # Catch a final write that landed after the last wait but before the
    # process actually exited.
    poll_once()


def run(
    argv: list[str],
    env: dict[str, str],
    cwd: str | Path,
    work_dir: str | Path,
    on_event: OnEvent,
    should_cancel: ShouldCancel | None = None,
    *,
    cancel_grace_s: float = CANCEL_GRACE_S,
    poll_interval_s: float = GRAPH_POLL_INTERVAL_S,
    timeout_s: float | None = None,
    start_seq: int = 0,
    timed_out: threading.Event | None = None,
) -> int:
    """Run `argv` as a subprocess, streaming events via `on_event`.

    Returns the child's exit code (or a negative signal-derived code, per
    `subprocess.Popen.returncode` conventions, if it was killed).

    `should_cancel`, if given, is polled periodically; once it returns
    True the process group is sent SIGTERM, then SIGKILL after
    `cancel_grace_s` seconds if it hasn't exited. `timeout_s`, if given,
    triggers the same SIGKILL directly once the wall-clock budget is spent.

    `timed_out`, if given, is set the moment the `timeout_s` deadline
    actually fires - the caller can check it afterwards to tell "the API
    killed this after its timeout" (issue #80) apart from an ordinary
    nonzero exit or a `should_cancel`-driven cancellation, and report a
    clearer error than the bare exit code.

    `start_seq` seeds the emitted sequence numbers (the first event is
    `start_seq + 1`) - it must be the run's current max persisted `seq`
    (0 for a run's first attempt), so a re-claimed/retried run's events
    don't collide with `uq_run_events_run_id_seq` on rows a previous,
    interrupted attempt already committed.
    """

    work_dir = Path(work_dir)
    graph_path = work_dir / OUT_DIRNAME / STRUCTURE_GRAPH_FILENAME

    # `emit` is called from both the stdout-reader thread and the graph
    # watcher thread. The lock must cover both the sequence-number bump and
    # the `on_event` dispatch as one atomic step, so that events are
    # delivered to `on_event` in strictly increasing `seq` order even when
    # both threads race to emit at the same time.
    emit_lock = threading.Lock()
    seq_holder = [start_seq]

    def emit(level: str, stage: str, message: str, payload: dict | None = None) -> None:
        with emit_lock:
            seq_holder[0] += 1
            on_event(
                RunEvent(
                    seq=seq_holder[0],
                    ts=datetime.now(timezone.utc),
                    level=level,
                    stage=stage,
                    message=message,
                    payload=payload,
                )
            )

    popen_kwargs: dict = dict(
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True

    proc = subprocess.Popen(argv, **popen_kwargs)  # noqa: S603 - argv built by book_command

    stop_event = threading.Event()
    reader_failed = threading.Event()

    def read_stdout() -> None:
        assert proc.stdout is not None
        try:
            for raw_line in proc.stdout:
                stage, level, message = parse_line(raw_line)
                emit(level, stage, message)
        except Exception as exc:  # noqa: BLE001 - any decode/read error must not
            # silently kill this thread: with `errors="replace"` above a bad
            # byte no longer raises here, but this is the last line of
            # defense against anything else going wrong mid-read (the pipe
            # itself erroring out, etc). Emit an event and flip a flag the
            # main loop checks so the process is terminated proactively
            # instead of hanging until `timeout_s` with the pipe undrained
            # (issue #76).
            reader_failed.set()
            emit(
                "error",
                "log",
                f"stdout reader thread crashed: {exc!r}; terminating the process",
            )

    reader_thread = threading.Thread(target=read_stdout, daemon=True)
    watcher_thread = threading.Thread(
        target=_watch_structure_graph,
        args=(graph_path, emit, stop_event, poll_interval_s, _initial_content_keys(graph_path)),
        daemon=True,
    )
    reader_thread.start()
    watcher_thread.start()

    started_at = time.monotonic()
    cancel_requested_at: float | None = None
    exit_code: int | None = None

    try:
        while True:
            exit_code = proc.poll()
            if exit_code is not None:
                break

            if (
                (should_cancel is not None and should_cancel()) or reader_failed.is_set()
            ) and cancel_requested_at is None:
                cancel_requested_at = time.monotonic()
                _kill_process_group(proc, signal.SIGTERM)

            if (
                cancel_requested_at is not None
                and (time.monotonic() - cancel_requested_at) >= cancel_grace_s
            ):
                _kill_process_group(proc, signal.SIGKILL)

            if timeout_s is not None and (time.monotonic() - started_at) >= timeout_s:
                if timed_out is not None and not timed_out.is_set():
                    timed_out.set()
                    emit(
                        "warning",
                        "timeout",
                        f"CLI exceeded its {timeout_s:g}s timeout; terminating",
                    )
                _kill_process_group(proc, signal.SIGKILL)

            time.sleep(_WAIT_POLL_INTERVAL_S)

        # Make sure the OS has actually reaped the process before we stop
        # reading its output.
        proc.wait()
    finally:
        stop_event.set()
        reader_thread.join(timeout=5)
        watcher_thread.join(timeout=poll_interval_s + 5)

    return exit_code if exit_code is not None else (proc.returncode or -1)
