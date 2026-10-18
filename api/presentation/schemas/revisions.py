from __future__ import annotations

import uuid
from typing import Annotated, Literal, Union

from pydantic import ConfigDict, Field

from api.presentation.schemas.comments import Comment, CommentAnchorIn
from api.presentation.schemas.common import BaseSchema
from api.presentation.schemas.outline import OutlineNode
from api.presentation.schemas.runs import Run

MAX_INSTRUCTION_LEN = 20_000  # schema-level hard stop; the service enforces REVISION_MAX_INSTRUCTION_CHARS


class RevisionParams(BaseSchema):
    """The copilot's parameter chips. `fixIssueIds` are `kind=review` card ids,
    `addressCommentIds` are comment-thread root ids, both of this section."""

    model_config = ConfigDict(extra="forbid")

    more_proofs: bool = False
    more_examples: bool = False
    more_rigorous: bool = False
    shorter: bool = False
    longer: bool = False
    cite_sources: bool = False
    fix_issue_ids: list[uuid.UUID] = Field(default_factory=list, max_length=25)
    address_comment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=25)


class RevisionCreate(BaseSchema):
    """`POST /projects/{id}/outline/{nodeId}/revisions`.

    `verb: "revise"` starts an in-process copilot job and answers with the
    `running` suggestion. `verb: "rewrite"` starts a regenerate run of the
    section (instruction = its prompt modifier; no scope/anchor/params/threadId)
    and answers with the run."""

    model_config = ConfigDict(extra="forbid")

    verb: Literal["revise", "rewrite"] = "revise"
    scope: Literal["section", "range"] = "section"
    # The selected range (`scope: "range"`); optional when `threadId` names a
    # thread that has one. Offsets are Unicode code points; the server resolves it.
    anchor: CommentAnchorIn | None = None
    instruction: str = Field(default="", max_length=MAX_INSTRUCTION_LEN)
    params: RevisionParams = Field(default_factory=RevisionParams)
    # Create the suggestion inside this comment/review thread (and settle that
    # thread when the suggestion is accepted).
    thread_id: uuid.UUID | None = None


class SuggestionStarted(BaseSchema):
    kind: Literal["suggestion"] = "suggestion"
    suggestion: Comment


class RunStarted(BaseSchema):
    kind: Literal["run"] = "run"
    run_id: uuid.UUID
    run: Run


RevisionStarted = Annotated[Union[SuggestionStarted, RunStarted], Field(discriminator="kind")]


class SuggestionAccept(BaseSchema):
    """Optional body of `POST /suggestions/{id}/accept`."""

    model_config = ConfigDict(extra="forbid")

    # Apply only these hunks (indexes into `payload.hunks`); section scope only.
    hunk_indexes: list[int] | None = Field(default=None, max_length=10_000)
    # The `contentHash` of the section text the client is showing (flush any
    # pending autosave first); 409 `content_conflict` if the text is different.
    expected_content_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class SuggestionAccepted(BaseSchema):
    """The accepted suggestion and the node as it is now."""

    suggestion: Comment
    node: OutlineNode


class SuggestionProgress(BaseSchema):
    """`data` of a `progress` event of `GET /suggestions/{id}/events/stream`."""

    seq: int
    ts: str
    stage: str
    level: str
    message: str
    payload: dict | None = None


class SuggestionTerminal(BaseSchema):
    """`data` of the terminal `done` / `failed` / `cancelled` event."""

    status: str
    suggestion: Comment | None = None
