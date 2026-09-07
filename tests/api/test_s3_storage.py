from __future__ import annotations

import io
import os
from collections.abc import Iterator

import boto3
import pytest
from moto import mock_aws

from api.core.errors import NotFound, StorageError
from api.core.settings import Settings
from api.infrastructure.storage.s3 import S3FileStorage

# `moto` intercepts every botocore HTTP call regardless of the configured
# endpoint/region, but boto3 still refuses to build a client with no region
# at all, so pin one for the duration of this module.
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


def _settings(bucket: str = "test-bucket") -> Settings:
    return Settings(
        s3_endpoint_url="https://s3.amazonaws.com",
        s3_access_key="testing",
        s3_secret_key="testing",
        s3_bucket=bucket,
    )


@pytest.fixture
def s3_storage() -> Iterator[S3FileStorage]:
    with mock_aws():
        settings = _settings()
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=settings.s3_bucket)
        yield S3FileStorage(settings)


async def test_put_and_open_round_trip(s3_storage: S3FileStorage) -> None:
    await s3_storage.put("dir/key1.txt", io.BytesIO(b"hello world"), "text/plain")

    chunks = [chunk async for chunk in await s3_storage.open("dir/key1.txt")]

    assert b"".join(chunks) == b"hello world"


async def test_open_missing_key_raises_not_found(s3_storage: S3FileStorage) -> None:
    with pytest.raises(NotFound):
        await s3_storage.open("does-not-exist.txt")


async def test_exists_is_false_before_put_and_true_after(s3_storage: S3FileStorage) -> None:
    assert await s3_storage.exists("k") is False

    await s3_storage.put("k", io.BytesIO(b"x"), "text/plain")

    assert await s3_storage.exists("k") is True


async def test_delete_then_open_raises_not_found(s3_storage: S3FileStorage) -> None:
    await s3_storage.put("k", io.BytesIO(b"x"), "text/plain")

    await s3_storage.delete("k")

    with pytest.raises(NotFound):
        await s3_storage.open("k")


async def test_healthcheck_succeeds_when_bucket_exists(s3_storage: S3FileStorage) -> None:
    await s3_storage.healthcheck()


async def test_healthcheck_raises_storage_error_when_bucket_missing() -> None:
    with mock_aws():
        # No `create_bucket` call this time - the bucket the storage is
        # configured for doesn't exist, the same failure mode as MinIO being
        # unreachable or misconfigured.
        storage = S3FileStorage(_settings("missing-bucket"))

        with pytest.raises(StorageError):
            await storage.healthcheck()
