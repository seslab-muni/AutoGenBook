"""User management CLI for the web stack's account table (issue #96).

There is deliberately no self-service signup or password reset (no SMTP in
this stack) - accounts are seeded and rotated entirely through this script,
run as `python -m api.scripts.users ...` (locally / `docker compose run
--rm api ...`) or `kubectl exec deploy/api -- python -m api.scripts.users
...` on the cluster.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import os
import sys
import uuid
from datetime import datetime, timezone

from api.application.auth import AuthService
from api.core.db import get_sessionmaker
from api.domain.models import User
from api.infrastructure.db.user_repository import SqlAlchemyUserRepository

# Never read from argv (issue #96): a CLI argument ends up verbatim in shell
# history and in `ps`/`docker top` output for the process's whole lifetime.
_PASSWORD_ENV_VAR = "AUTOGENBOOK_USER_PASSWORD"


def _read_password() -> str:
    env_password = os.environ.get(_PASSWORD_ENV_VAR)
    if env_password:
        return env_password
    password = getpass.getpass("Password: ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("passwords did not match", file=sys.stderr)
        raise SystemExit(1)
    if not password:
        print("password must not be empty", file=sys.stderr)
        raise SystemExit(1)
    return password


async def _create(email: str, name: str) -> None:
    password = _read_password()
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        repo = SqlAlchemyUserRepository(session)
        if await repo.get_by_email(email) is not None:
            print(f"a user with email {email!r} already exists", file=sys.stderr)
            raise SystemExit(1)
        now = datetime.now(timezone.utc)
        user = User(
            id=uuid.uuid4(),
            email=email,
            display_name=name,
            password_hash=AuthService.hash_password(password),
            is_active=True,
            password_changed_at=now,
            created_at=now,
            updated_at=now,
        )
        created = await repo.add(user)
        print(f"created user {created.email} ({created.id})")


async def _set_password(email: str) -> None:
    password = _read_password()
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        repo = SqlAlchemyUserRepository(session)
        user = await repo.get_by_email(email)
        if user is None:
            print(f"no user with email {email!r}", file=sys.stderr)
            raise SystemExit(1)
        # Bumps `password_changed_at`, which invalidates every token issued
        # before now on its next request (`AuthService.verify_token`'s `pca`
        # check) - the only revocation story #96 needs.
        await repo.update_password(user.id, AuthService.hash_password(password))
        print(f"password updated for {email}; existing sessions are now invalid")


async def _set_active(email: str, is_active: bool) -> None:
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        repo = SqlAlchemyUserRepository(session)
        user = await repo.get_by_email(email)
        if user is None:
            print(f"no user with email {email!r}", file=sys.stderr)
            raise SystemExit(1)
        await repo.set_active(user.id, is_active)
        print(f"{email} is now {'active' if is_active else 'inactive'}")


async def _list_users() -> None:
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        users = await SqlAlchemyUserRepository(session).list()
        if not users:
            print("no users")
            return
        for user in users:
            status = "active" if user.is_active else "inactive"
            print(f"{user.email}\t{user.display_name}\t{status}\t{user.id}")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m api.scripts.users",
        description="Manage AutoGenBook web accounts.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="create a new user")
    create.add_argument("--email", required=True)
    create.add_argument("--name", required=True)

    set_password = subparsers.add_parser("set-password", help="rotate a user's password")
    set_password.add_argument("--email", required=True)

    deactivate = subparsers.add_parser("deactivate", help="deactivate a user")
    deactivate.add_argument("--email", required=True)

    activate = subparsers.add_parser("activate", help="reactivate a deactivated user")
    activate.add_argument("--email", required=True)

    subparsers.add_parser("list", help="list all users")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "create":
        asyncio.run(_create(args.email, args.name))
    elif args.command == "set-password":
        asyncio.run(_set_password(args.email))
    elif args.command == "deactivate":
        asyncio.run(_set_active(args.email, False))
    elif args.command == "activate":
        asyncio.run(_set_active(args.email, True))
    elif args.command == "list":
        asyncio.run(_list_users())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
