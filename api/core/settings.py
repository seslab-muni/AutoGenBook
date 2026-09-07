from __future__ import annotations

import sys
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_repo_root() -> str:
    # api/core/settings.py -> api/core -> api -> repo root
    return str(Path(__file__).resolve().parents[2])


class Settings(BaseSettings):
    """Runtime configuration for the API and worker processes.

    Values come from environment variables injected by docker-compose;
    `.env` files are not read here since containers only ever see the
    variables compose explicitly passes through.
    """

    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    database_url: str = Field(
        default="postgresql://autogenbook:autogenbook@db:5432/autogenbook",
        alias="DATABASE_URL",
    )

    s3_endpoint_url: str = Field(default="http://minio:9000", alias="S3_ENDPOINT_URL")
    s3_access_key: str = Field(default="autogenbook", alias="S3_ACCESS_KEY")
    s3_secret_key: str = Field(default="change-this-secret", alias="S3_SECRET_KEY")
    s3_bucket: str = Field(default="autogenbook", alias="S3_BUCKET")

    runs_dir: str = Field(default="/app/runs", alias="RUNS_DIR")
    max_upload_mb: int = Field(default=200, alias="MAX_UPLOAD_MB")

    worker_concurrency: int = Field(default=1, alias="WORKER_CONCURRENCY")
    worker_poll_interval_s: float = Field(default=2.0, alias="WORKER_POLL_INTERVAL_S")
    worker_stale_s: int = Field(default=300, alias="WORKER_STALE_S")
    runs_retention_days: int = Field(default=30, alias="RUNS_RETENTION_DAYS")
    rewrite_author_line: bool = Field(default=True, alias="REWRITE_AUTHOR_LINE")

    cli_entrypoint: str = Field(default="main.py", alias="CLI_ENTRYPOINT")
    cli_python: str = Field(default_factory=lambda: sys.executable, alias="CLI_PYTHON")
    repo_root: str = Field(default_factory=_default_repo_root, alias="REPO_ROOT")
    cli_cancel_grace_s: float = Field(default=15.0, alias="CLI_CANCEL_GRACE_S")
    # 3600s (1h) SIGKILLed any realistically-sized book run: the wizard's
    # default `totalPagesBudget` of 350 pages at `max_output_pages: 1.5`
    # subdivides into ~230 leaf sections, each needing several LLM calls
    # (write, review, revise) - easily several hours end to end. 21600s (6h)
    # gives that generous headroom while still bounding a truly stuck run
    # (issue #80). Still overridable via `CLI_RUN_TIMEOUT_S`.
    cli_run_timeout_s: float = Field(default=21600.0, alias="CLI_RUN_TIMEOUT_S")


@lru_cache
def get_settings() -> Settings:
    return Settings()
