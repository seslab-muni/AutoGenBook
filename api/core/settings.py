from __future__ import annotations

import sys
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# HS256 with a secret shorter than this is trivially brute-forceable; PyJWT
# itself doesn't enforce a minimum length, so the check is ours.
_MIN_JWT_SECRET_BYTES = 32


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

    # No default: a hardcoded default bakes a guessable password into every
    # checkout. It's never actually relied on - `docker-compose.yml`'s
    # `x-app-env` anchor (used by both `api` and `worker`) always passes
    # `DATABASE_URL` explicitly, and `docs/DEVELOPER_GUIDE.md`'s documented
    # Alembic invocation always passes it explicitly on the command line too.
    database_url: str = Field(alias="DATABASE_URL")

    s3_endpoint_url: str = Field(default="http://minio:9000", alias="S3_ENDPOINT_URL")
    s3_access_key: str = Field(default="autogenbook", alias="S3_ACCESS_KEY")
    s3_secret_key: str = Field(default="change-this-secret", alias="S3_SECRET_KEY")
    s3_bucket: str = Field(default="autogenbook", alias="S3_BUCKET")

    # Not read by the API for anything functional - `docker-compose.yml`'s
    # `web` service alone binds this host (nginx is the only container
    # exposed to the host network; see its `ports:` comment for issue #50),
    # and forwards it here only so `default_credentials_warning` below can
    # tell whether this deployment is reachable beyond localhost.
    web_bind_host: str = Field(default="127.0.0.1", alias="WEB_BIND_HOST")

    runs_dir: str = Field(default="/app/runs", alias="RUNS_DIR")
    max_upload_mb: int = Field(default=200, alias="MAX_UPLOAD_MB")

    # Deliberately outside `runs_dir`: entries here are keyed by uploaded-file content
    # hash, not by run id, so they must survive `sweep_stale_work_dirs` deleting
    # individual runs' work directories and must be shared across every project/run
    # that happens to attach the same source file (see `rag_kb.py`'s extraction cache).
    kb_extract_cache_dir: str = Field(default="/app/kb_cache", alias="KB_EXTRACT_CACHE_DIR")

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

    # No default: a stack that boots without a real secret would silently
    # accept every JWT signed with an empty/well-known key. Fails fast at
    # `Settings()` construction (a required field) rather than at the first
    # login attempt.
    auth_jwt_secret: str = Field(alias="AUTH_JWT_SECRET")
    # 24h, not the usual short-lived-access-token default (issue #96): a live
    # run view can hold `GET /runs/{id}/events/stream` open for up to
    # `CLI_RUN_TIMEOUT_S` (6h default), and with 4 trusted users a
    # refresh-token flow buys nothing over just living with a longer TTL.
    auth_token_ttl_h: float = Field(default=24.0, alias="AUTH_TOKEN_TTL_H")
    auth_cookie_name: str = Field(default="autogenbook_session", alias="AUTH_COOKIE_NAME")
    # `0` only for plain-http LAN dev - `localhost` counts as a secure
    # context in every browser, so compose on `127.0.0.1` keeps this `1`.
    auth_cookie_secure: bool = Field(default=True, alias="AUTH_COOKIE_SECURE")

    @field_validator("auth_jwt_secret")
    @classmethod
    def _validate_jwt_secret_length(cls, value: str) -> str:
        if len(value.encode("utf-8")) < _MIN_JWT_SECRET_BYTES:
            raise ValueError(
                f"AUTH_JWT_SECRET must be at least {_MIN_JWT_SECRET_BYTES} bytes long "
                f"(got {len(value.encode('utf-8'))}); generate one with `openssl rand -hex 32`"
            )
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()


DEFAULT_S3_SECRET_KEY = "change-this-secret"
# Loopback forms nginx's own `WEB_BIND_HOST` default/docs treat as "not
# exposed to the network" (docker-compose.yml's `web.ports` comment, issue
# #50) - kept in sync with that, not an exhaustive list of every way a host
# can mean "local only" (e.g. it doesn't special-case IPv6-mapped IPv4).
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def default_credentials_warning(settings: Settings) -> str | None:
    """Return a human-readable warning if `settings` still has the baked-in
    default S3/MinIO secret *and* the stack is bound beyond loopback (i.e.
    actually reachable from a network), or `None` if the deployment looks
    safe. A separate, explicitly-called function (not a validator) so it can
    be unit-tested directly and so the API can log rather than fail to boot -
    the default is intentionally fine for local dev.
    """
    if settings.s3_secret_key != DEFAULT_S3_SECRET_KEY:
        return None
    bind_host = settings.web_bind_host.strip().lower()
    if bind_host in _LOOPBACK_HOSTS:
        return None
    return (
        "SECURITY WARNING: S3_SECRET_KEY is still the default "
        f"({DEFAULT_S3_SECRET_KEY!r}) and WEB_BIND_HOST="
        f"{settings.web_bind_host!r} exposes this stack beyond localhost. "
        "Set a real S3_ACCESS_KEY/S3_SECRET_KEY (and MinIO's matching "
        "MINIO_ROOT_USER/MINIO_ROOT_PASSWORD) before exposing this "
        "deployment to a network."
    )
