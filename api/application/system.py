"""`SystemService` backs `GET /api/v1/system/models` (issue #128): the model list the
configured LLM endpoint offers, for the project-settings/start-run model pickers."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from api.domain.models import LlmModelInfo
from api.domain.ports import ModelCatalog

logger = logging.getLogger("api.application.system")

# Matches an absolute filesystem path or an `http(s)://` URL - the shapes a raw
# `urllib`/network exception message tends to carry (the configured base URL, mirroring
# `api.application.runs._sanitize_run_error`'s reasoning for run errors, issue #82). A generic
# message is shown to clients instead; the real exception is always logged server-side.
_SENSITIVE_MESSAGE_RE = re.compile(r"https?://|/(?:[\w.\-]+/)+[\w.\-]*")
_GENERIC_WARNING = "could not reach the configured LLM endpoint's model list"


@dataclass
class ModelListResult:
    items: list[LlmModelInfo]
    warning: str | None


class SystemService:
    def __init__(self, catalog: ModelCatalog) -> None:
        self._catalog = catalog

    async def list_models(self) -> ModelListResult:
        try:
            items = await self._catalog.list_models()
        except Exception as exc:  # noqa: BLE001 - degrade gracefully, never a 5xx (issue #128)
            logger.warning("model discovery failed: %s", exc)
            message = str(exc)
            warning = _GENERIC_WARNING if _SENSITIVE_MESSAGE_RE.search(message) else message
            return ModelListResult(items=[], warning=warning)
        return ModelListResult(items=items, warning=None)
