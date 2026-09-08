from __future__ import annotations

from collections.abc import AsyncIterator
from functools import lru_cache
from typing import BinaryIO

import boto3
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError
from starlette.concurrency import run_in_threadpool

from api.core.errors import NotFound, StorageError
from api.core.settings import Settings, get_settings

_CHUNK_SIZE = 64 * 1024


class S3FileStorage:
    """`FileStorage` adapter backed by an S3-compatible bucket (MinIO)."""

    def __init__(self, settings: Settings) -> None:
        self._bucket = settings.s3_bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            config=Config(s3={"addressing_style": "path"}),
        )

    async def put(
        self,
        key: str,
        stream: BinaryIO,
        content_type: str,
        size_hint: int | None = None,
    ) -> None:
        extra_args = {"ContentType": content_type} if content_type else None
        try:
            await run_in_threadpool(
                self._client.upload_fileobj,
                stream,
                self._bucket,
                key,
                ExtraArgs=extra_args,
            )
        except (ClientError, BotoCoreError) as exc:
            # A MinIO outage (or misconfiguration) used to surface here as
            # a bare botocore exception - an unhandled 500 - instead of the
            # 503 StorageError the rest of the API uses for "a dependency
            # is unreachable" (matching what /ready reports for the same
            # failure, issue #59).
            raise StorageError(str(exc)) from exc

    async def open(self, key: str) -> AsyncIterator[bytes]:
        try:
            response = await run_in_threadpool(
                self._client.get_object, Bucket=self._bucket, Key=key
            )
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in ("NoSuchKey", "404"):
                raise NotFound(f"object {key!r} does not exist") from exc
            raise StorageError(str(exc)) from exc
        return self._stream_body(response["Body"])

    @staticmethod
    async def _stream_body(body) -> AsyncIterator[bytes]:
        try:
            while chunk := await run_in_threadpool(body.read, _CHUNK_SIZE):
                yield chunk
        finally:
            body.close()

    async def delete(self, key: str) -> None:
        try:
            await run_in_threadpool(self._client.delete_object, Bucket=self._bucket, Key=key)
        except (ClientError, BotoCoreError) as exc:
            raise StorageError(str(exc)) from exc

    async def exists(self, key: str) -> bool:
        try:
            await run_in_threadpool(
                self._client.head_object, Bucket=self._bucket, Key=key
            )
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in ("404", "NoSuchKey"):
                return False
            raise StorageError(str(exc)) from exc
        return True

    async def healthcheck(self) -> None:
        try:
            await run_in_threadpool(self._client.head_bucket, Bucket=self._bucket)
        except Exception as exc:  # noqa: BLE001 - any failure means "not ready"
            raise StorageError("object storage is not reachable") from exc


@lru_cache
def get_s3_file_storage() -> S3FileStorage:
    return S3FileStorage(get_settings())
