from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest

from api.domain.models import RunEvent
from api.infrastructure.cli import subprocess_runner

REPO_ROOT = Path(__file__).resolve().parents[2]
FAKE_CLI = Path(__file__).resolve().with_name("fake_cli.py")


def _base_env(**overrides: str) -> dict[str, str]:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONUNBUFFERED": "1",
        "PYTHONUTF8": "1",
    }
    env.update(overrides)
    return env


def _make_work_dir(tmp_path: Path, input_text: str = "Test Book\n") -> Path:
    work_dir = tmp_path / "run"
    work_dir.mkdir()
    (work_dir / "book_input.txt").write_text(input_text, encoding="utf-8")
    return work_dir


def _argv(work_dir: Path, *extra: str) -> list[str]:
    return [
        sys.executable,
        str(FAKE_CLI),
        "--mode",
        "book",
        "-i",
        str(work_dir / "book_input.txt"),
        "-o",
        str(work_dir / "out"),
        *extra,
    ]


class _Collector:
    def __init__(self) -> None:
        self.events: list[RunEvent] = []
        self._lock = threading.Lock()

    def __call__(self, event: RunEvent) -> None:
        with self._lock:
            self.events.append(event)


def test_run_streams_events_in_order_and_exits_zero(tmp_path):
    work_dir = _make_work_dir(tmp_path)
    argv = _argv(work_dir, "--use-txt")
    collector = _Collector()

    exit_code = subprocess_runner.run(
        argv=argv,
        env=_base_env(),
        cwd=str(REPO_ROOT),
        work_dir=work_dir,
        on_event=collector,
    )

    assert exit_code == 0
    assert len(collector.events) > 0
    seqs = [e.seq for e in collector.events]
    assert seqs == sorted(seqs)
    assert seqs == list(range(1, len(seqs) + 1))


def test_run_emits_at_least_one_section_event(tmp_path):
    work_dir = _make_work_dir(tmp_path)
    argv = _argv(work_dir, "--use-txt")
    collector = _Collector()

    exit_code = subprocess_runner.run(
        argv=argv,
        env=_base_env(),
        cwd=str(REPO_ROOT),
        work_dir=work_dir,
        on_event=collector,
    )

    assert exit_code == 0
    section_events = [e for e in collector.events if e.stage == "section"]
    assert len(section_events) >= 1
    for event in section_events:
        assert event.payload is not None
        assert "node_key" in event.payload
        assert "content_file_path" in event.payload
        assert Path(event.payload["content_file_path"]).exists()


def test_run_propagates_nonzero_exit_code_on_missing_input(tmp_path):
    work_dir = tmp_path / "run"
    work_dir.mkdir()
    # No book_input.txt written -> fake_cli exits 2.
    argv = _argv(work_dir, "--use-txt")
    collector = _Collector()

    exit_code = subprocess_runner.run(
        argv=argv,
        env=_base_env(),
        cwd=str(REPO_ROOT),
        work_dir=work_dir,
        on_event=collector,
    )

    assert exit_code == 2


def test_run_generates_structure_graph_with_content_paths(tmp_path):
    work_dir = _make_work_dir(tmp_path)
    argv = _argv(work_dir, "--use-txt")

    exit_code = subprocess_runner.run(
        argv=argv,
        env=_base_env(),
        cwd=str(REPO_ROOT),
        work_dir=work_dir,
        on_event=lambda e: None,
    )

    assert exit_code == 0
    graph_path = work_dir / "out" / "structure_graph.json"
    assert graph_path.exists()
    data = json.loads(graph_path.read_text(encoding="utf-8"))
    leaf_nodes = {k: v for k, v in data["nodes"].items() if k != "book"}
    assert len(leaf_nodes) >= 1
    for attrs in leaf_nodes.values():
        assert attrs.get("content_file_path")


def test_cancel_mid_run_kills_process_within_grace_period(tmp_path):
    work_dir = _make_work_dir(tmp_path)
    argv = _argv(work_dir, "--use-txt")
    collector = _Collector()

    cancel_flag = threading.Event()

    def should_cancel() -> bool:
        return cancel_flag.is_set()

    # Slow the fake CLI down so there's a real window to cancel inside.
    env = _base_env(FAKE_CLI_STEP_SLEEP_S="1.0")

    result: dict[str, int] = {}

    def run_target() -> None:
        result["exit_code"] = subprocess_runner.run(
            argv=argv,
            env=env,
            cwd=str(REPO_ROOT),
            work_dir=work_dir,
            on_event=collector,
            should_cancel=should_cancel,
            cancel_grace_s=2.0,
        )

    thread = threading.Thread(target=run_target)
    start = time.monotonic()
    thread.start()

    # Wait for the run to actually produce output, then cancel it.
    deadline = time.monotonic() + 10
    while not collector.events and time.monotonic() < deadline:
        time.sleep(0.05)
    assert collector.events, "fake CLI never produced any output before deadline"

    cancel_flag.set()
    thread.join(timeout=15)
    elapsed = time.monotonic() - start

    assert not thread.is_alive(), "subprocess_runner.run() did not return after cancellation"
    assert result["exit_code"] != 0
    # SIGTERM sent immediately on cancel, SIGKILL after cancel_grace_s=2s if
    # still alive; generous upper bound to absorb scheduling jitter in CI.
    assert elapsed < 10


def test_run_respects_timeout(tmp_path):
    work_dir = _make_work_dir(tmp_path)
    argv = _argv(work_dir, "--use-txt")
    env = _base_env(FAKE_CLI_STEP_SLEEP_S="5.0")

    start = time.monotonic()
    exit_code = subprocess_runner.run(
        argv=argv,
        env=env,
        cwd=str(REPO_ROOT),
        work_dir=work_dir,
        on_event=lambda e: None,
        timeout_s=0.5,
    )
    elapsed = time.monotonic() - start

    assert exit_code != 0
    assert elapsed < 5
