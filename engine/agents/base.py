"""Typed agents: `Agent[In, Out]` renders one prompt from the pack with a
typed input and returns a validated pydantic output through the LLM
client's structured-output ladder."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, Mapping, TypeVar

from pydantic import BaseModel

from engine.llm.client import LLMClient
from engine.prompts import render

Out = TypeVar("Out", bound=BaseModel)


@dataclass(frozen=True)
class Agent(Generic[Out]):
    """`prompt_id` names the pack file, `output` the schema, `role` the model
    role (`main` or `mini`), `label` the ledger label."""

    prompt_id: str
    output: type[Out]
    label: str
    role: str = "main"
    temperature: float | None = None

    def messages(self, values: Mapping[str, Any]) -> list[dict[str, str]]:
        return render(self.prompt_id, values)

    async def run(self, llm: LLMClient, values: Mapping[str, Any], *, node_key: str | None = None, model: str | None = None) -> Out:
        return await llm.structured(
            self.messages(values), self.output, label=self.label, role=self.role, model=model,
            node_key=node_key, temperature=self.temperature,
        )
