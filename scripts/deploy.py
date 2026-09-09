#!/usr/bin/env python
"""Build, push, and roll out AutoGenBook's container images to the CERIT-SC k8s cluster.

There are exactly two images, shared across three Deployments:

  cerit.io/conerzyo/autogenbook       ("core")  -> api, worker Deployments
  cerit.io/conerzyo/autogenbook-web   ("web")   -> web Deployment

Images are tagged with the short git commit SHA they were built from, never a hand-picked
version number - `git show <tag>` always tells you exactly what's running. Each run compares
HEAD against whatever commit is *actually deployed* right now (read live from the cluster, not
from a local file that could go stale) and only rebuilds an image whose relevant source paths
changed since then.

Safe by default: with no flags this only prints the plan - nothing is built, pushed, or applied.
Pass --apply to actually do it. A failed rollout automatically rolls every Deployment touched in
that run back to its pre-run state (image tag *and* manifest file), so the cluster never sits
half-upgraded with an api/web pair that were never meant to run together - see --no-rollback to
opt out and leave a failure in place for debugging instead.

This does not replace docs/DEPLOY_GUIDE.md - that's still the runbook for first-time cluster
setup (Postgres, MinIO, ingress, etc). This script automates the day-to-day "I changed some code,
redeploy it" part of that guide.

Examples:
  python scripts/deploy.py
      Show what would be deployed, without touching anything.

  python scripts/deploy.py --apply
      Build/push/apply whatever changed since the live cluster's commit, with a confirmation
      prompt first.

  python scripts/deploy.py --apply --yes
      Same, no prompt (for scripting).

  python scripts/deploy.py --force web --apply
      Rebuild+redeploy the web image regardless of what git thinks changed.

  python scripts/deploy.py --sync-secrets
      Show which keys in .env.production differ from the live autogenbook-secrets Secret,
      without writing anything. Secret *values* are never printed, only which keys are
      new/changed/unchanged.

  python scripts/deploy.py --sync-secrets --apply
      Write .env.production's values into the live Secret.

See `python scripts/deploy.py --help` for every flag.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import shlex
import shutil
import subprocess
import sys
import textwrap
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

NAMESPACE_DEFAULT = "autogenbook"
REGISTRY_DEFAULT = "cerit.io/conerzyo"

SECRET_NAME = "autogenbook-secrets"
ENV_PRODUCTION_DEFAULT = ".env.production"
# Keeps in lockstep with docs/DEPLOY_GUIDE.md step 4's `kubectl create secret` command - update
# both together if the Secret's required keys ever change.
REQUIRED_SECRET_KEYS = (
    "POSTGRES_PASSWORD",
    "S3_SECRET_KEY",
    "DATABASE_URL",
    "OPENROUTER_API_KEY",
    "TAVILY_API_KEY",
    "AUTH_JWT_SECRET",
)
# TAVILY_API_KEY is the one key docs/DEPLOY_GUIDE.md documents as allowed to be blank (web
# retrieval is optional) - every other key must actually have a value, not just be present.
OPTIONAL_EMPTY_SECRET_KEYS = frozenset({"TAVILY_API_KEY"})

# Anything under app/ only ever affects the web image.
WEB_PREFIX = "app/"
# A short "this definitely doesn't affect either image" list is safer to maintain than an
# exhaustive "this is exactly what the core image needs" allowlist would be: the root
# Dockerfile's `COPY . .` really does pull in nearly everything at the repo root, so a new
# top-level file added later is correctly treated as core-relevant by default rather than
# silently ignored because nobody remembered to add it to an allowlist.
NO_REBUILD_PREFIXES = ("k8s/", "docs/", "tests/", ".github/", "scripts/", "examples/", "src/")
NO_REBUILD_FILES = frozenset({"README.md", "CLAUDE.md", ".gitignore", ".env.example"})


class DeployError(Exception):
    """A known, expected failure - caught in main() and printed as a clean one-liner, no
    traceback. Anything else propagating out of main() is a real bug in this script."""


@dataclass(frozen=True)
class ImageSpec:
    repo: str
    context: Path
    dockerfile: Path


@dataclass(frozen=True)
class DeploymentSpec:
    manifest: Path
    image_key: str  # "core" or "web"


IMAGES: dict[str, ImageSpec] = {
    "core": ImageSpec("autogenbook", REPO_ROOT, REPO_ROOT / "Dockerfile"),
    "web": ImageSpec("autogenbook-web", REPO_ROOT / "app", REPO_ROOT / "app" / "Dockerfile"),
}

DEPLOYMENTS: dict[str, DeploymentSpec] = {
    "api": DeploymentSpec(REPO_ROOT / "k8s" / "api.yaml", "core"),
    "worker": DeploymentSpec(REPO_ROOT / "k8s" / "worker.yaml", "core"),
    "web": DeploymentSpec(REPO_ROOT / "k8s" / "web.yaml", "web"),
}
DEPLOYMENT_ORDER = ("api", "worker", "web")


# --------------------------------------------------------------------------------------
# Subprocess helpers. `run()` never captures stdout/stderr - both stream live to the
# terminal exactly as if you'd typed the command yourself. Anything that needs to *read* a
# value (git/kubectl queries) captures only stdout, leaving stderr streaming so warnings are
# still visible.
# --------------------------------------------------------------------------------------


def run(cmd: list[str]) -> None:
    print(f"$ {shlex.join(cmd)}")
    subprocess.run(cmd, check=True)


def run_captured(cmd: list[str]) -> str:
    result = subprocess.run(cmd, stdout=subprocess.PIPE, text=True, check=True)
    return result.stdout.strip()


def git(*args: str) -> str:
    return run_captured(["git", "-C", str(REPO_ROOT), *args])


# --------------------------------------------------------------------------------------
# git helpers
# --------------------------------------------------------------------------------------


def git_head() -> tuple[str, str]:
    return git("rev-parse", "HEAD"), git("rev-parse", "--short", "HEAD")


def git_is_dirty() -> bool:
    return bool(git("status", "--porcelain"))


def git_sha_exists(sha: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "cat-file", "-e", f"{sha}^{{commit}}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def git_diff_names(a: str, b: str) -> list[str]:
    out = git("diff", "--name-only", a, b)
    return [line for line in out.splitlines() if line]


def diff_since(tag: str) -> tuple[list[str], bool]:
    """Returns (changed_files, unknown). unknown=True means the deployed tag's commit isn't
    reachable locally (shallow clone, rewritten history, ...), so no real diff is possible and
    the caller should treat a rebuild as necessary rather than guess."""
    if not git_sha_exists(tag):
        return [], True
    return git_diff_names(tag, "HEAD"), False


# --------------------------------------------------------------------------------------
# kubectl helpers
# --------------------------------------------------------------------------------------


def kubectl_get_image(deployment: str, namespace: str) -> str | None:
    result = subprocess.run(
        [
            "kubectl",
            "get",
            "deployment",
            deployment,
            "-n",
            namespace,
            "-o",
            "jsonpath={.spec.template.spec.containers[0].image}",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        if "NotFound" in result.stderr:
            return None
        raise DeployError(f"kubectl get deployment/{deployment} failed:\n{result.stderr.strip()}")
    return result.stdout.strip() or None


def kubectl_get_secret_data(name: str, namespace: str) -> dict[str, str] | None:
    result = subprocess.run(
        ["kubectl", "get", "secret", name, "-n", namespace, "-o", "json"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        if "NotFound" in result.stderr:
            return None
        raise DeployError(f"kubectl get secret/{name} failed:\n{result.stderr.strip()}")
    return json.loads(result.stdout).get("data", {})


def parse_tag(image_ref: str) -> str:
    return image_ref.rsplit(":", 1)[1]


def set_image_tag(manifest: Path, image_ref_prefix: str, new_tag: str) -> None:
    """Rewrites `image: <image_ref_prefix>:<old-tag>` to the new tag, in place, leaving every
    other line (including all the manifest's own comments) untouched. Deliberately a targeted
    regex rather than a YAML parse/dump round-trip - these manifests are heavily hand-commented,
    and PyYAML's dumper silently drops comments on a round-trip."""
    text = manifest.read_text()
    pattern = re.compile(rf"^(\s*image:\s*{re.escape(image_ref_prefix)}:)([^\s]+)(\s*)$", re.MULTILINE)
    new_text, count = pattern.subn(rf"\g<1>{new_tag}\3", text)
    if count != 1:
        raise DeployError(
            f"expected exactly one 'image: {image_ref_prefix}:...' line in {manifest}, found {count} - "
            "the manifest's format may have changed; update set_image_tag() in scripts/deploy.py"
        )
    manifest.write_text(new_text)


# --------------------------------------------------------------------------------------
# Path classification
# --------------------------------------------------------------------------------------


def classify_path(path: str) -> str:
    """Classifies a repo-relative changed path as "web", "core", or "none" (affects neither
    image). See the NO_REBUILD_* comment above for why this is a blocklist, not an allowlist."""
    if path.startswith(WEB_PREFIX):
        return "web"
    if path in NO_REBUILD_FILES:
        return "none"
    if any(path.startswith(prefix) for prefix in NO_REBUILD_PREFIXES):
        return "none"
    return "core"


# --------------------------------------------------------------------------------------
# Plan
# --------------------------------------------------------------------------------------


@dataclass
class DeploymentPlan:
    name: str
    manifest: Path
    image_key: str
    current_tag: str
    needs_build: bool
    needs_apply: bool
    reason: str


@dataclass
class Plan:
    head_full: str
    head_short: str
    deployments: dict[str, DeploymentPlan]
    images_to_build: set[str]
    notes: list[str]

    @property
    def anything_to_do(self) -> bool:
        return any(d.needs_apply for d in self.deployments.values())


def _describe_reason(*, forced: bool, needs_build: bool, manifest_touched: bool, relevant: list[str]) -> str:
    if not needs_build and not manifest_touched:
        return "up to date"
    if forced:
        base = "--force"
    elif relevant:
        shown = ", ".join(relevant[:4])
        more = f" (+{len(relevant) - 4} more)" if len(relevant) > 4 else ""
        base = f"changed: {shown}{more}"
    elif needs_build:
        base = "rebuild needed (see notes below)"
    else:
        base = "manifest only"
    if manifest_touched and not needs_build:
        base += " - k8s manifest changed, no image rebuild needed"
    return base


def build_plan(namespace: str, force: str | None) -> Plan:
    head_full, head_short = git_head()
    notes: list[str] = []

    live_images = {name: kubectl_get_image(name, namespace) for name in DEPLOYMENT_ORDER}
    missing = [name for name, ref in live_images.items() if ref is None]
    if missing:
        raise DeployError(
            f"deployment(s) not found in namespace '{namespace}': {', '.join(missing)} - "
            "has the cluster been bootstrapped per docs/DEPLOY_GUIDE.md?"
        )
    tags = {name: parse_tag(ref) for name, ref in live_images.items()}  # type: ignore[arg-type]

    core_tag = tags["api"]
    web_tag = tags["web"]
    core_drifted = tags["worker"] != core_tag
    if core_drifted:
        notes.append(
            f"worker is on tag {tags['worker']} but api is on {core_tag} - they share one image "
            "and should always match; forcing a core rebuild to realign them."
        )

    core_changed, core_unknown = diff_since(core_tag)
    web_changed, web_unknown = diff_since(web_tag)
    if core_unknown:
        notes.append(
            f"api/worker's deployed commit {core_tag} isn't reachable locally - rebuilding the core image to be safe."
        )
    if web_unknown:
        notes.append(f"web's deployed commit {web_tag} isn't reachable locally - rebuilding the web image to be safe.")

    core_forced = force in ("core", "all")
    web_forced = force in ("web", "all")

    core_relevant = [f for f in core_changed if classify_path(f) == "core"]
    web_relevant = [f for f in web_changed if classify_path(f) == "web"]

    core_needs_build = core_forced or core_drifted or core_unknown or bool(core_relevant)
    web_needs_build = web_forced or web_unknown or bool(web_relevant)

    if core_needs_build:
        notes.append(
            "rolling back the core image does not undo any Alembic migration it already ran on "
            "startup - migrations are forward-only. See docs/DEPLOY_GUIDE.md."
        )

    deployments: dict[str, DeploymentPlan] = {}
    for name in DEPLOYMENT_ORDER:
        spec = DEPLOYMENTS[name]
        is_core = spec.image_key == "core"
        needs_build = core_needs_build if is_core else web_needs_build
        forced = core_forced if is_core else web_forced
        relevant = core_relevant if is_core else web_relevant
        changed = core_changed if is_core else web_changed

        manifest_rel = str(spec.manifest.relative_to(REPO_ROOT))
        manifest_touched = manifest_rel in changed
        needs_apply = needs_build or manifest_touched

        deployments[name] = DeploymentPlan(
            name=name,
            manifest=spec.manifest,
            image_key=spec.image_key,
            current_tag=tags[name],
            needs_build=needs_build,
            needs_apply=needs_apply,
            reason=_describe_reason(
                forced=forced, needs_build=needs_build, manifest_touched=manifest_touched, relevant=relevant
            ),
        )

    images_to_build = {DEPLOYMENTS[n].image_key for n, d in deployments.items() if d.needs_build}
    return Plan(head_full, head_short, deployments, images_to_build, notes)


def print_plan(plan: Plan) -> None:
    print(f"HEAD is {plan.head_short} ({plan.head_full})\n")
    header = f"{'DEPLOYMENT':<10} {'IMAGE':<6} {'CURRENT':<10} {'NEW':<10} {'ACTION':<22} REASON"
    print(header)
    print("-" * len(header))
    for name in DEPLOYMENT_ORDER:
        d = plan.deployments[name]
        new_tag = plan.head_short if d.needs_build else d.current_tag
        if d.needs_build:
            action = "build+push+apply"
        elif d.needs_apply:
            action = "apply (manifest only)"
        else:
            action = "-"
        print(f"{name:<10} {d.image_key:<6} {d.current_tag:<10} {new_tag:<10} {action:<22} {d.reason}")
    if plan.notes:
        print()
        for note in plan.notes:
            print(f"note: {note}")


# --------------------------------------------------------------------------------------
# Confirmation
# --------------------------------------------------------------------------------------


def confirm(prompt: str) -> bool:
    if not sys.stdin.isatty():
        raise DeployError(
            "refusing to prompt for confirmation on a non-interactive stdin - pass -y/--yes to proceed non-interactively"
        )
    answer = input(f"{prompt} [y/N] ").strip().lower()
    return answer in ("y", "yes")


# --------------------------------------------------------------------------------------
# Build + apply
# --------------------------------------------------------------------------------------


def build_and_push(image_key: str, tag: str, registry: str) -> None:
    spec = IMAGES[image_key]
    ref = f"{registry}/{spec.repo}:{tag}"
    print(f"\n==> Building {ref}")
    run(["docker", "build", "-t", ref, "-f", str(spec.dockerfile), str(spec.context)])
    print(f"\n==> Pushing {ref}")
    run(["docker", "push", ref])


def _apply_and_wait(name: str, manifest: Path, namespace: str, rollout_timeout: str) -> None:
    print(f"\n==> Applying {manifest} (deployment/{name})")
    run(["kubectl", "apply", "-f", str(manifest), "-n", namespace])
    run(["kubectl", "rollout", "status", f"deployment/{name}", "-n", namespace, f"--timeout={rollout_timeout}"])


def apply_phase(plan: Plan, registry: str, namespace: str, rollout_timeout: str, no_rollback: bool) -> int:
    order = [name for name in DEPLOYMENT_ORDER if plan.deployments[name].needs_apply]
    if not order:
        print("\nNothing to apply.")
        return 0

    touched: list[tuple[str, Path, bytes]] = []
    failed_at: str | None = None

    for name in order:
        d = plan.deployments[name]
        original = d.manifest.read_bytes()
        touched.append((name, d.manifest, original))

        try:
            if d.needs_build:
                image_repo = IMAGES[d.image_key].repo
                set_image_tag(d.manifest, f"{registry}/{image_repo}", plan.head_short)
            _apply_and_wait(name, d.manifest, namespace, rollout_timeout)
        except (subprocess.CalledProcessError, DeployError) as exc:
            if isinstance(exc, DeployError):
                print(f"\n!! {exc}", file=sys.stderr)
            failed_at = name
            break

    if failed_at is None:
        print("\nAll deployments applied and healthy.")
        return 0

    print(f"\n!! deployment/{failed_at} failed to roll out.", file=sys.stderr)

    if no_rollback:
        print("!! --no-rollback set: leaving the cluster as-is for debugging.", file=sys.stderr)
        print(
            f"!! do not redeploy tag {plan.head_short} for {failed_at} until you've investigated why it failed.",
            file=sys.stderr,
        )
        return 1

    print("!! rolling back every deployment touched in this run to its pre-run state...", file=sys.stderr)
    rollback_failed: list[str] = []
    for name, manifest, original in touched:
        manifest.write_bytes(original)
        try:
            _apply_and_wait(name, manifest, namespace, rollout_timeout)
        except subprocess.CalledProcessError:
            rollback_failed.append(name)

    if rollback_failed:
        print(
            f"!! rollback ITSELF failed for: {', '.join(rollback_failed)} - the cluster is in a "
            "mixed state, investigate by hand immediately.",
            file=sys.stderr,
        )
    else:
        print("!! rollback complete - cluster restored to its pre-run state.", file=sys.stderr)

    print(
        f"!! the image that failed was pushed to the registry as tag {plan.head_short} - it was "
        "NOT deleted from Harbor (you may want it to debug the failure); do not redeploy it "
        "without investigating first.",
        file=sys.stderr,
    )
    return 1


def preflight(namespace: str) -> None:
    for binary in ("git", "docker", "kubectl"):
        if shutil.which(binary) is None:
            raise DeployError(f"'{binary}' not found on PATH")
    result = subprocess.run(
        ["kubectl", "get", "namespace", namespace], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True
    )
    if result.returncode != 0:
        raise DeployError(f"cannot reach namespace '{namespace}': {result.stderr.strip()}")


def run_deploy(args: argparse.Namespace) -> int:
    preflight(args.namespace)

    if args.apply and git_is_dirty():
        raise DeployError(
            "working tree has uncommitted changes - commit or stash them first. Building from a "
            "dirty tree would tag an image with a commit it doesn't actually match."
        )

    plan = build_plan(args.namespace, args.force)
    print_plan(plan)

    if not plan.anything_to_do:
        print("\nNothing to deploy - the cluster already matches HEAD for every relevant path.")
        return 0

    if not args.apply:
        print("\nDry run - pass --apply to build/push/apply this plan.")
        return 0

    if not args.yes and not confirm("\nProceed with this deploy?"):
        print("Aborted.")
        return 0

    for image_key in sorted(plan.images_to_build):
        build_and_push(image_key, plan.head_short, args.registry)

    return apply_phase(plan, args.registry, args.namespace, args.rollout_timeout, args.no_rollback)


# --------------------------------------------------------------------------------------
# Secret sync
# --------------------------------------------------------------------------------------


def ensure_ignored(path: Path) -> None:
    result = subprocess.run(["git", "-C", str(REPO_ROOT), "check-ignore", "-q", str(path)])
    if result.returncode != 0:
        raise DeployError(
            f"{path} is not covered by .gitignore - refusing to read it until it is, to avoid ever "
            "accidentally committing real secrets"
        )


def read_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        raise DeployError(f"{path} not found - create it with the keys listed in --help first")
    values: dict[str, str] = {}
    for lineno, raw in enumerate(path.read_text().splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise DeployError(f"{path}:{lineno}: expected KEY=VALUE, got: {raw!r}")
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def validate_secret_values(values: dict[str, str]) -> None:
    absent = [k for k in REQUIRED_SECRET_KEYS if k not in values]
    if absent:
        raise DeployError("missing required key(s): " + ", ".join(absent))
    empty = [
        k for k in REQUIRED_SECRET_KEYS if not values[k] and k not in OPTIONAL_EMPTY_SECRET_KEYS
    ]
    if empty:
        raise DeployError("required key(s) present but empty: " + ", ".join(empty))


def sync_secrets(args: argparse.Namespace) -> int:
    ensure_ignored(args.env_file)
    values = read_env_file(args.env_file)
    validate_secret_values(values)

    current = kubectl_get_secret_data(SECRET_NAME, args.namespace)
    print(f"Secret sync plan for secret/{SECRET_NAME} in namespace {args.namespace} (values never shown):\n")
    for key in REQUIRED_SECRET_KEYS:
        new_b64 = base64.b64encode(values[key].encode()).decode()
        if current is None:
            status = "NEW (secret doesn't exist yet)"
        elif key not in current:
            status = "NEW key"
        elif current[key] != new_b64:
            status = "CHANGED"
        else:
            status = "unchanged"
        print(f"  {key:<20} {status}")

    if not args.apply:
        print("\nDry run - pass --apply to write this to the cluster.")
        return 0

    if not args.yes and not confirm(f"\nWrite secret/{SECRET_NAME} in namespace {args.namespace}?"):
        print("Aborted.")
        return 0

    create_cmd = ["kubectl", "create", "secret", "generic", SECRET_NAME, "-n", args.namespace]
    for key in REQUIRED_SECRET_KEYS:
        create_cmd.append(f"--from-literal={key}={values[key]}")
    create_cmd += ["--dry-run=client", "-o", "yaml"]

    print(
        f"\n$ kubectl create secret generic {SECRET_NAME} -n {args.namespace} "
        f"--from-literal=<{len(REQUIRED_SECRET_KEYS)} keys, values redacted> --dry-run=client -o yaml | kubectl apply -f -"
    )
    manifest = subprocess.run(create_cmd, stdout=subprocess.PIPE, text=True, check=True).stdout
    subprocess.run(["kubectl", "apply", "-n", args.namespace, "-f", "-"], input=manifest, text=True, check=True)
    print(f"\nsecret/{SECRET_NAME} synced.")
    return 0


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="deploy.py",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=textwrap.dedent(
            """\
            Build, push, and roll out AutoGenBook's two container images to the CERIT-SC
            cluster, tagged by git commit SHA - only rebuilding the image(s) whose relevant
            source paths actually changed since what's live right now.

            Safe by default: with no flags this only PRINTS the plan. Pass --apply to actually
            build/push/apply it."""
        ),
        epilog=textwrap.dedent(
            """\
            examples:
              deploy.py                          show the plan, touch nothing
              deploy.py --apply                  build/push/apply, with a confirmation prompt
              deploy.py --apply --yes             same, no prompt (for scripting)
              deploy.py --force web --apply       rebuild+redeploy web regardless of the diff
              deploy.py --sync-secrets            show which .env.production keys differ live
              deploy.py --sync-secrets --apply    write .env.production into the live Secret

            required keys in --env-file for --sync-secrets:
              """
            + ", ".join(REQUIRED_SECRET_KEYS)
            + """

            See docs/DEPLOY_GUIDE.md for the full manual runbook this script automates the
            day-to-day incremental-redeploy part of."""
        ),
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually build/push/apply (or sync secrets). Default is dry-run: print the plan and exit.",
    )
    parser.add_argument(
        "--namespace", default=NAMESPACE_DEFAULT, help=f"Kubernetes namespace (default: {NAMESPACE_DEFAULT})."
    )
    parser.add_argument(
        "--registry",
        default=REGISTRY_DEFAULT,
        help=f"Container registry + project prefix images are pushed under (default: {REGISTRY_DEFAULT}).",
    )
    parser.add_argument(
        "--force",
        choices=("core", "web", "all"),
        default=None,
        help="Rebuild the given image(s) regardless of what changed since the deployed commit. "
        "'core' is the shared api/worker image.",
    )
    parser.add_argument(
        "--rollout-timeout",
        default="180s",
        metavar="DURATION",
        help="Passed to 'kubectl rollout status --timeout' for each deployment (default: 180s).",
    )
    parser.add_argument(
        "--no-rollback",
        action="store_true",
        help="On a failed rollout, leave the cluster as-is for debugging instead of automatically "
        "rolling every deployment touched in this run back to its previous state.",
    )
    parser.add_argument(
        "-y", "--yes", action="store_true", help="Skip the confirmation prompt before --apply takes action."
    )
    parser.add_argument(
        "--sync-secrets",
        action="store_true",
        help=f"Instead of a deploy, sync required keys from --env-file into the {SECRET_NAME} Secret. "
        "Combine with --apply to actually write it; without it, just shows what would change.",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        default=REPO_ROOT / ENV_PRODUCTION_DEFAULT,
        help=f"Source file for --sync-secrets (default: {ENV_PRODUCTION_DEFAULT} at repo root). "
        "Plain KEY=VALUE lines, '#' comments allowed. Must be gitignored.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    try:
        if args.sync_secrets:
            return sync_secrets(args)
        return run_deploy(args)
    except DeployError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"error: command failed (exit {exc.returncode}): {shlex.join(exc.cmd)}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\naborted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
