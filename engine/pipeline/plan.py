"""The task DAG of a book run, as pure data (no I/O, unit-testable).

Structure phase (only when there is no resumable graph):
    kb.build -> [kb.embed] ; outline (TXT) or structure (JSON) -> subdivide
Generation phase, planned once the leaves are known:
    glossary -> draft(leaf) -> review(leaf) -> revise(leaf) -> length(leaf)
             -> consistency
In `parallel` context mode drafts depend on nothing but the glossary and the
KB; in `chained` mode draft(leaf N) also waits for leaf N-1's final text.

Resume marking: a leaf whose section file exists (or whose content lock is
honoured) gets no task; a leaf with a valid intermediate result from an
interrupted run starts after the last stage that finished (`LeafStatus`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

STAGES = ("draft", "review", "revise", "length")
# Later stages first, so a started section is finished before a new one starts.
PRIORITY = {"kb.build": 100, "kb.embed": 90, "outline": 95, "subdivide": 94, "glossary": 80,
            "length": 40, "revise": 30, "review": 20, "draft": 10, "consistency": 5}


@dataclass(frozen=True)
class TaskSpec:
    id: str
    kind: str
    deps: tuple[str, ...] = ()
    node_key: str | None = None
    priority: int = 0
    order: int = 0


@dataclass(frozen=True)
class LeafStatus:
    key: str
    done: bool = False  # section file exists / lock honoured
    resume_after: str | None = None  # last finished stage of an interrupted chain


@dataclass
class GenerationPlan:
    tasks: list[TaskSpec] = field(default_factory=list)
    generated: list[str] = field(default_factory=list)  # leaves this run writes
    skipped: list[str] = field(default_factory=list)  # leaves already done

    def ids(self) -> list[str]:
        return [t.id for t in self.tasks]


def task_id(kind: str, key: str | None = None) -> str:
    return f"{kind}:{key}" if key else kind


def plan_kb(*, has_kb: bool, need_dense: bool) -> list[TaskSpec]:
    tasks: list[TaskSpec] = []
    if has_kb:
        tasks.append(TaskSpec("kb.build", "kb.build", priority=PRIORITY["kb.build"]))
        if need_dense:
            tasks.append(TaskSpec("kb.embed", "kb.embed", ("kb.build",), priority=PRIORITY["kb.embed"]))
    return tasks


def plan_structure(*, has_kb: bool, need_dense: bool, from_txt: bool) -> list[TaskSpec]:
    tasks = plan_kb(has_kb=has_kb, need_dense=need_dense)
    deps = ("kb.build",) if has_kb else ()
    tasks.append(TaskSpec("outline" if from_txt else "structure", "outline" if from_txt else "structure", deps, priority=PRIORITY["outline"]))
    tasks.append(TaskSpec("subdivide", "subdivide", (tasks[-1].id,) + deps, priority=PRIORITY["subdivide"]))
    return tasks


def plan_subdivision_resume(*, has_kb: bool, need_dense: bool) -> list[TaskSpec]:
    """A resumed structure whose subdivision was interrupted: KB, then
    subdivide (the outline exists)."""
    tasks = plan_kb(has_kb=has_kb, need_dense=need_dense)
    deps = ("kb.build",) if has_kb else ()
    tasks.append(TaskSpec("subdivide", "subdivide", deps, priority=PRIORITY["subdivide"]))
    return tasks


def plan_generation(
    leaves: Sequence[LeafStatus],
    *,
    context_mode: str = "parallel",
    need_glossary: bool = True,
    kb_deps: Sequence[str] = (),
    after: Sequence[str] = (),
    consistency: bool = True,
) -> GenerationPlan:
    """`leaves` in document order. `kb_deps` are the KB tasks drafts wait for
    (`kb.build`, `kb.embed` when planned in the same run); `after` are tasks
    the whole generation waits for (e.g. `subdivide`)."""
    plan = GenerationPlan()
    todo = [leaf for leaf in leaves if not leaf.done]
    plan.skipped = [leaf.key for leaf in leaves if leaf.done]
    if not todo:
        return plan
    base = tuple(after)
    if need_glossary:
        plan.tasks.append(TaskSpec("glossary", "glossary", base + tuple(kb_deps), priority=PRIORITY["glossary"]))
        base = base + ("glossary",)
    finals: list[str] = []
    previous_final: str | None = None
    order = {leaf.key: i for i, leaf in enumerate(leaves)}
    for leaf in leaves:
        if leaf.done:
            previous_final = None  # chained: the previous leaf's text already exists
            continue
        start = 0 if leaf.resume_after is None else STAGES.index(leaf.resume_after) + 1
        start = min(start, len(STAGES) - 1)
        prev_id: str | None = None
        for stage in STAGES[start:]:
            deps = list(base) + list(kb_deps if stage in {"draft", "revise"} else ())
            if prev_id is not None:
                deps.append(prev_id)
            if context_mode == "chained" and stage == STAGES[start] and previous_final is not None:
                deps.append(previous_final)
            spec = TaskSpec(task_id(stage, leaf.key), stage, tuple(dict.fromkeys(deps)), leaf.key, PRIORITY[stage], order[leaf.key])
            plan.tasks.append(spec)
            prev_id = spec.id
        assert prev_id is not None
        finals.append(prev_id)
        previous_final = prev_id
        plan.generated.append(leaf.key)
    if consistency and len(leaves) > 1:
        plan.tasks.append(TaskSpec("consistency", "consistency", tuple(finals), priority=PRIORITY["consistency"], order=len(leaves)))
    return plan
