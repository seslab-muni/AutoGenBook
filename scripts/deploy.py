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
Pass --apply to actually do it. A *broken* rollout (new pods crash-looping, image unpullable, ...)
automatically rolls every Deployment touched in that run back to its pre-run state (image tag
*and* manifest file), so the cluster never sits half-upgraded with an api/web pair that were never
meant to run together - see --no-rollback to opt out and leave a failure in place for debugging
instead. Two deliberate exceptions, both learned from a real incident:

  * A rollout that is merely *slow* (its timeout elapsed but every new pod is healthy - the
    worker's five replicas roll one at a time and take ~2 min each) is left running, not rolled
    back: the script exits 1 and tells you to wait and re-run --apply to finish the remaining
    Deployments.
  * Once a deploy that changes Alembic migrations has applied api, api and worker are never
    auto-rolled back: api runs `alembic upgrade head` on startup, so the database is already at
    HEAD's revision and any older image would just crash-loop on "Can't locate revision".

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
import math
import re
import shlex
import shutil
import subprocess
import sys
import textwrap
import time
from dataclasses import dataclass, field
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
#
# Kept in sync with the root .dockerignore by tests/test_deploy_script.py's
# DockerignoreSyncTests - caught missing ".claude/" and "output/" (both real, git-tracked, and
# dockerignored, but absent from an earlier version of this list) during review.
NO_REBUILD_PREFIXES = (
    "k8s/",
    "docs/",
    "tests/",
    ".github/",
    "scripts/",
    "examples/",
    "src/",
    ".claude/",
    ".git/",
    ".venv/",
    "__pycache__/",
    "output/",
)
NO_REBUILD_FILES = frozenset({"README.md", "CLAUDE.md", ".gitignore", ".env.example", ".env"})


class DeployError(Exception):
    """A known, expected failure - caught in main() and printed as a clean one-liner, no
    traceback. Anything else propagating out of main() is a real bug in this script."""


class RolloutBroken(DeployError):
    """A rollout whose new pods are failing (crash loop, unpullable image, ...) - it will never
    complete on its own, so apply_phase() gives up early and rolls back."""


class RolloutSlow(DeployError):
    """A rollout whose timeout elapsed while every new pod still looked healthy. It is most
    likely just slow (the worker's one-at-a-time replica turnover), so apply_phase() leaves it
    running instead of rolling back - rolling back a healthy rollout is how the incident described
    at MIGRATIONS_PREFIX happened."""


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

# Alembic migration files. api's container entrypoint (k8s/api.yaml) runs `alembic upgrade head`
# on every start, so the moment a new core image's api pod has started the database is at that
# image's head revision - and any *older* core image's `alembic upgrade head` then fails with
# "Can't locate revision identified by '<new revision>'" and crash-loops. That is why
# apply_phase() refuses to auto-roll api/worker back once a deploy that touched this directory has
# applied api. Learned the hard way: a worker rollout *timeout* rolled api back to an image two
# migrations behind and took the API down until it was re-applied by hand.
MIGRATIONS_PREFIX = "api/infrastructure/db/alembic/versions/"

# Per-Deployment `kubectl rollout status --timeout` defaults. worker is five single-slot replicas
# rolling one at a time with maxSurge: 0 (see k8s/worker.yaml) and each replacement takes ~2 min
# (old pod drains, new pod schedules and attaches two PVCs), so its rollout legitimately needs
# ~10 min; api and web are single-replica and up in well under a minute. A genuinely broken
# rollout (crash loop, bad image) is detected within one poll interval regardless of the timeout
# - see _wait_for_rollout() - so these only bound how long a *healthy but slow* rollout may take.
ROLLOUT_TIMEOUT_DEFAULT = "180s"
WORKER_ROLLOUT_TIMEOUT_DEFAULT = "900s"
ROLLOUT_POLL_INTERVAL_S = 30
# Container waiting-state reasons that mean a new pod will never become ready on its own.
BROKEN_WAITING_REASONS = frozenset(
    {
        "CrashLoopBackOff",
        "ImagePullBackOff",
        "ErrImagePull",
        "InvalidImageName",
        "CreateContainerConfigError",
        "CreateContainerError",
        "RunContainerError",
    }
)
# A new pod that has already restarted this many times is crashing, even if kubelet hasn't got
# round to labelling it CrashLoopBackOff yet. One restart is tolerated: api's entrypoint can lose
# its first DB connection while Postgres is still warming up and come good on the second try.
BROKEN_RESTART_COUNT = 2


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


def git_dirty_paths() -> list[str]:
    """Repo-relative paths with uncommitted changes (porcelain status, renames resolved to their
    new path)."""
    out = git("status", "--porcelain")
    paths = []
    for line in out.splitlines():
        if not line:
            continue
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        paths.append(path.strip('"'))
    return paths


def git_dirty_outside_k8s() -> bool:
    """True if anything *other than* k8s/*.yaml is uncommitted. k8s/ is excluded deliberately: a
    successful --apply itself rewrites the image tag in the manifest it just applied (see
    apply_phase()) without committing it, so if k8s/ counted here, a successful deploy would
    permanently block the next one until a human noticed and committed the bump by hand - exactly
    the "adds more work instead of easing it" failure this script exists to avoid. Any other
    uncommitted path still blocks --apply: that's the real guarantee (an image is only ever built
    from exactly the commit it's tagged with)."""
    return any(not path.startswith("k8s/") for path in git_dirty_paths())


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


def _kubectl_get(resource: str, name: str, namespace: str, *, output: str) -> str | None:
    """Runs `kubectl get <resource> <name> -o <output>`, returning stdout, or None if the
    resource doesn't exist. Shared by every read-only kubectl lookup so "how do we detect
    NotFound" only has one implementation to keep correct."""
    result = subprocess.run(
        ["kubectl", "get", resource, name, "-n", namespace, "-o", output],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        if "NotFound" in result.stderr:
            return None
        raise DeployError(f"kubectl get {resource}/{name} failed:\n{result.stderr.strip()}")
    return result.stdout


def kubectl_get_image(deployment: str, namespace: str) -> str | None:
    out = _kubectl_get(
        "deployment", deployment, namespace, output="jsonpath={.spec.template.spec.containers[0].image}"
    )
    return out.strip() or None if out is not None else None


def kubectl_get_secret_data(name: str, namespace: str) -> dict[str, str] | None:
    out = _kubectl_get("secret", name, namespace, output="json")
    return json.loads(out).get("data", {}) if out is not None else None


def _kubectl_list_json(resource: str, namespace: str, selector: str) -> list[dict]:
    """`kubectl get <resource> -l <selector> -o json` -> the list's items."""
    result = subprocess.run(
        ["kubectl", "get", resource, "-n", namespace, "-l", selector, "-o", "json"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise DeployError(f"kubectl get {resource} -l {selector} failed:\n{result.stderr.strip()}")
    return json.loads(result.stdout).get("items", [])


def _deployment_new_pods(name: str, namespace: str) -> list[dict]:
    """The pods belonging to `name`'s *current* ReplicaSet (the one this rollout is bringing up),
    excluding pods already being deleted. Old-ReplicaSet pods are deliberately left out: a
    14-day-old worker pod's historical restart count says nothing about whether the new image
    works. Returns [] when the new ReplicaSet can't be identified yet (kubectl has not observed
    the spec update), which callers treat as "nothing known to be wrong"."""
    raw = _kubectl_get("deployment", name, namespace, output="json")
    if raw is None:
        return []
    deployment = json.loads(raw)
    revision = deployment.get("metadata", {}).get("annotations", {}).get("deployment.kubernetes.io/revision")
    match_labels = deployment.get("spec", {}).get("selector", {}).get("matchLabels", {})
    if not revision or not match_labels:
        return []
    selector = ",".join(f"{k}={v}" for k, v in sorted(match_labels.items()))
    template_hash = None
    for rs in _kubectl_list_json("replicasets", namespace, selector):
        if rs.get("metadata", {}).get("annotations", {}).get("deployment.kubernetes.io/revision") == revision:
            template_hash = rs.get("spec", {}).get("selector", {}).get("matchLabels", {}).get("pod-template-hash")
            break
    if not template_hash:
        return []
    pods = _kubectl_list_json("pods", namespace, f"{selector},pod-template-hash={template_hash}")
    return [pod for pod in pods if not pod.get("metadata", {}).get("deletionTimestamp")]


def _broken_pods(pods: list[dict]) -> list[str]:
    """Human-readable reasons for every pod in `pods` that will never become ready on its own
    (see BROKEN_WAITING_REASONS / BROKEN_RESTART_COUNT). Empty means all of them still look like
    they're merely starting up."""
    reasons: list[str] = []
    for pod in pods:
        pod_name = pod.get("metadata", {}).get("name", "?")
        status = pod.get("status", {})
        if status.get("phase") == "Failed":
            reasons.append(f"pod/{pod_name}: phase Failed ({status.get('reason') or status.get('message') or 'no reason'})")
            continue
        for cs in status.get("initContainerStatuses", []) + status.get("containerStatuses", []):
            container = cs.get("name", "?")
            waiting = (cs.get("state") or {}).get("waiting") or {}
            if waiting.get("reason") in BROKEN_WAITING_REASONS:
                detail = f": {waiting['message']}" if waiting.get("message") else ""
                reasons.append(f"pod/{pod_name} container {container}: {waiting['reason']}{detail}")
            elif cs.get("restartCount", 0) >= BROKEN_RESTART_COUNT:
                last = ((cs.get("lastState") or {}).get("terminated") or {})
                detail = f" (last exit: {last.get('reason', '?')}, code {last.get('exitCode', '?')})" if last else ""
                reasons.append(f"pod/{pod_name} container {container}: restarted {cs['restartCount']} times{detail}")
    return reasons


_DURATION_RE = re.compile(r"^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$")


def parse_duration(text: str) -> int:
    """'900s' / '15m' / '1h30m' / bare '900' -> seconds. Same grammar kubectl accepts for
    --timeout (minus sub-second units, which make no sense for a rollout)."""
    text = text.strip()
    if text.isdigit():
        return int(text)
    match = _DURATION_RE.match(text)
    if not match or not text:
        raise DeployError(f"invalid duration {text!r} - expected e.g. '180s', '15m' or '1h30m'")
    hours, minutes, seconds = (int(part) if part else 0 for part in match.groups())
    return hours * 3600 + minutes * 60 + seconds


def parse_tag(image_ref: str) -> str:
    if ":" not in image_ref:
        raise DeployError(
            f"deployed image reference {image_ref!r} has no tag - expected 'repo:tag'. "
            "Was it set with a bare 'kubectl set image ...=repo' (no tag) or by digest?"
        )
    return image_ref.rsplit(":", 1)[1]


def replace_image_tag(text: str, image_ref_prefix: str, new_tag: str, *, where: str) -> str:
    """Returns `text` with its single `image: <image_ref_prefix>:<old-tag>` line pointed at
    `new_tag`, every other line (including all the manifest's own comments) untouched.
    Deliberately a targeted regex rather than a YAML parse/dump round-trip - these manifests are
    heavily hand-commented, and PyYAML's dumper silently drops comments on a round-trip. `where`
    names the text's origin for the error message."""
    pattern = re.compile(rf"^(\s*image:\s*{re.escape(image_ref_prefix)}:)([^\s]+)(\s*)$", re.MULTILINE)
    new_text, count = pattern.subn(rf"\g<1>{new_tag}\3", text)
    if count != 1:
        raise DeployError(
            f"expected exactly one 'image: {image_ref_prefix}:...' line in {where}, found {count} - "
            "the manifest's format may have changed; update replace_image_tag() in scripts/deploy.py"
        )
    return new_text


def set_image_tag(manifest: Path, image_ref_prefix: str, new_tag: str) -> None:
    """Rewrites the manifest's image tag in place - see replace_image_tag()."""
    manifest.write_text(replace_image_tag(manifest.read_text(), image_ref_prefix, new_tag, where=str(manifest)))


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
    # Alembic migration files (MIGRATIONS_PREFIX) that differ between the live core image's
    # commit and HEAD. Non-empty means "once api has been applied, api/worker cannot be rolled
    # back" - see apply_phase(). Conservatively non-empty when the live commit isn't reachable
    # locally and no diff was possible.
    migrations_changed: list[str] = field(default_factory=list)

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


@dataclass
class _ImageDecision:
    tag: str
    changed: list[str]
    relevant: list[str]
    forced: bool
    needs_build: bool


def _decide_image(image_key: str, tag: str, force: str | None, *, drifted: bool, notes: list[str]) -> _ImageDecision:
    changed, unknown = diff_since(tag)
    if unknown:
        notes.append(f"{image_key}'s deployed commit {tag} isn't reachable locally - rebuilding to be safe.")
    forced = force in (image_key, "all")
    relevant = [f for f in changed if classify_path(f) == image_key]
    needs_build = forced or drifted or unknown or bool(relevant)
    return _ImageDecision(tag=tag, changed=changed, relevant=relevant, forced=forced, needs_build=needs_build)


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

    # api and worker share one image and must always agree; api is the reference tag if they don't.
    core_drifted = tags["worker"] != tags["api"]
    if core_drifted:
        notes.append(
            f"worker is on tag {tags['worker']} but api is on {tags['api']} - they share one image "
            "and should always match; forcing a core rebuild to realign them."
        )

    image_tags = {"core": tags["api"], "web": tags["web"]}
    decisions = {
        image_key: _decide_image(image_key, tag, force, drifted=(image_key == "core" and core_drifted), notes=notes)
        for image_key, tag in image_tags.items()
    }

    migrations_changed: list[str] = []
    if decisions["core"].needs_build:
        _, core_unknown = diff_since(tags["api"])
        if core_unknown:
            migrations_changed = [f"(unknown - {tags['api']} isn't reachable locally, assuming migrations changed)"]
        else:
            migrations_changed = [f for f in decisions["core"].changed if f.startswith(MIGRATIONS_PREFIX)]
        if migrations_changed:
            notes.append(
                "this deploy changes Alembic migration(s): "
                + ", ".join(migrations_changed)
                + ". api runs `alembic upgrade head` on startup, so once api has been applied "
                "api/worker will NOT be auto-rolled back on a later failure - the database would "
                "already be ahead of the old image. See docs/DEPLOY_GUIDE.md section 16."
            )

    deployments: dict[str, DeploymentPlan] = {}
    for name in DEPLOYMENT_ORDER:
        spec = DEPLOYMENTS[name]
        decision = decisions[spec.image_key]

        manifest_rel = str(spec.manifest.relative_to(REPO_ROOT))
        manifest_touched = manifest_rel in decision.changed
        needs_apply = decision.needs_build or manifest_touched

        deployments[name] = DeploymentPlan(
            name=name,
            manifest=spec.manifest,
            image_key=spec.image_key,
            current_tag=tags[name],
            needs_build=decision.needs_build,
            needs_apply=needs_apply,
            reason=_describe_reason(
                forced=decision.forced,
                needs_build=decision.needs_build,
                manifest_touched=manifest_touched,
                relevant=decision.relevant,
            ),
        )

    images_to_build = {image_key for image_key, decision in decisions.items() if decision.needs_build}
    return Plan(head_full, head_short, deployments, images_to_build, notes, migrations_changed)


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


def _display_path(path: Path) -> str:
    """Repo-relative for display when possible, falling back to the absolute path otherwise -
    e.g. in tests, which deliberately use manifests outside REPO_ROOT for isolation."""
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def _manifest_at_ref(ref: str, manifest: Path) -> bytes | None:
    """Returns the manifest's exact git-committed content at `ref`, or None if `ref` isn't a
    resolvable commit (e.g. a legacy semver tag predating this script). Used as the rollback
    baseline: restoring *this*, rather than whatever happened to be on disk right before this run
    started, is what actually undoes every change this run made to the manifest - not just an
    image-tag rewrite, but any other content change HEAD's commit(s) also carried for it."""
    if not git_sha_exists(ref):
        return None
    rel = manifest.relative_to(REPO_ROOT).as_posix()
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "show", f"{ref}:{rel}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout if result.returncode == 0 else None


def _wait_for_rollout(name: str, namespace: str, rollout_timeout: str) -> None:
    """Waits for deployment/`name` to finish rolling out, for at most `rollout_timeout`.

    Polls `kubectl rollout status` in ROLLOUT_POLL_INTERVAL_S slices rather than one long call so
    that between slices the new ReplicaSet's pods can be inspected: a crash-looping or unpullable
    image is reported as RolloutBroken within one interval instead of after the full timeout, and
    a timeout with every new pod still healthy is reported as RolloutSlow rather than as a
    failure. Any other kubectl error propagates as CalledProcessError, as before."""
    deadline = time.monotonic() + parse_duration(rollout_timeout)
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RolloutSlow(
                f"deployment/{name} has not finished rolling out after {rollout_timeout}, but every new pod "
                "looks healthy - it is most likely just slow (the worker replaces its replicas one at a time). "
                f"Watch it with `kubectl rollout status deployment/{name} -n {namespace}`; if it does complete, "
                "re-run `deploy.py --apply` to carry on with the remaining deployments, otherwise investigate "
                "with `kubectl describe pods -n " + namespace + "`."
            )
        step = max(1, min(ROLLOUT_POLL_INTERVAL_S, math.ceil(remaining)))
        cmd = ["kubectl", "rollout", "status", f"deployment/{name}", "-n", namespace, f"--timeout={step}s"]
        print(f"$ {shlex.join(cmd)}")
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if result.stdout:
            print(result.stdout.rstrip())
        if result.returncode == 0:
            return
        if "timed out" not in result.stdout:
            raise subprocess.CalledProcessError(result.returncode, cmd)
        broken = _broken_pods(_deployment_new_pods(name, namespace))
        if broken:
            raise RolloutBroken(
                f"deployment/{name}'s new pods are failing - giving up on this rollout early:\n  " + "\n  ".join(broken)
            )


def _apply_and_wait(name: str, manifest: Path, namespace: str, rollout_timeout: str) -> None:
    print(f"\n==> Applying {manifest} (deployment/{name})")
    run(["kubectl", "apply", "-f", str(manifest), "-n", namespace])
    _wait_for_rollout(name, namespace, rollout_timeout)


def _rollback_baseline(d: DeploymentPlan, image_ref_prefix: str) -> bytes:
    """The manifest content a rollback of `d` restores: the git-committed manifest at the live
    tag's commit (so any non-tag manifest change HEAD carried - a resource limit, say - is undone
    too), with its image line pinned to the tag the cluster is *actually* running.

    The pin matters: the commit that the live tag names still contains the tag of the deploy
    *before* it, because a tag only lands in a manifest in the follow-up "Deploy <tag>" commit.
    Restoring that commit's bytes verbatim therefore rolled the cluster back two deploys, not one
    (the real incident: api landed on an image two migrations behind the database)."""
    committed = _manifest_at_ref(d.current_tag, d.manifest)
    if committed is not None:
        text, where = committed.decode(), f"{_display_path(d.manifest)} at {d.current_tag}"
    else:
        # Best effort: d.current_tag isn't a resolvable commit (legacy semver tag, shallow clone).
        text, where = d.manifest.read_text(), str(d.manifest)
    return replace_image_tag(text, image_ref_prefix, d.current_tag, where=where).encode()


def _commit_hint(plan: Plan, manifests: list[Path]) -> str:
    shown = sorted({_display_path(m) for m in manifests})
    return (
        "\n  ".join(shown)
        + f"\n\n  git add {' '.join(shown)} && git commit -m 'Deploy {plan.head_short}'"
    )


def apply_phase(plan: Plan, registry: str, namespace: str, rollout_timeouts: dict[str, str], no_rollback: bool) -> int:
    """Applies every Deployment the plan says needs it, in DEPLOYMENT_ORDER, and decides what to
    do when one fails:

      * RolloutSlow (timeout elapsed, new pods healthy): leave everything as it is, exit 1. The
        rollout will most likely complete by itself; re-running --apply then finishes the rest.
      * anything else (RolloutBroken, kubectl error, manifest error): roll every touched
        Deployment back to its pre-run state - EXCEPT api and worker when this deploy changes
        Alembic migrations and api was already applied (see MIGRATIONS_PREFIX): the database is
        then ahead of the old image and rolling back could only crash-loop, so they stay on the
        new image and the operator is told exactly what to check.
    """
    order = [name for name in DEPLOYMENT_ORDER if plan.deployments[name].needs_apply]
    if not order:
        print("\nNothing to apply.")
        return 0

    touched: list[tuple[str, Path, bytes]] = []
    applied: set[str] = set()  # kubectl apply was at least *attempted* for these
    failed_at: str | None = None
    failure: BaseException | None = None

    for name in order:
        d = plan.deployments[name]
        image_ref_prefix = f"{registry}/{IMAGES[d.image_key].repo}"
        try:
            touched.append((name, d.manifest, _rollback_baseline(d, image_ref_prefix)))
            if d.needs_build:
                set_image_tag(d.manifest, image_ref_prefix, plan.head_short)
            applied.add(name)
            _apply_and_wait(name, d.manifest, namespace, rollout_timeouts[name])
        except (subprocess.CalledProcessError, DeployError) as exc:
            if isinstance(exc, DeployError):
                print(f"\n!! {exc}", file=sys.stderr)
            failed_at, failure = name, exc
            break

    retagged = [m for n, m, _ in touched if plan.deployments[n].needs_build]

    if failed_at is None:
        print("\nAll deployments applied and healthy.")
        if retagged:
            print(
                "\nThe following manifest(s) were updated with the new image tag on disk and "
                "still need to be committed to keep git in sync with the cluster:\n  "
                + _commit_hint(plan, retagged)
            )
        return 0

    if isinstance(failure, RolloutSlow):
        print(f"\n!! deployment/{failed_at} is still rolling out - NOT rolling back a healthy rollout.", file=sys.stderr)
        pending = [n for n in order if n not in applied]
        if pending:
            print(
                f"!! not yet applied in this run: {', '.join(pending)} - once deployment/{failed_at} completes, "
                "re-run `deploy.py --apply` and it will pick up where this run stopped.",
                file=sys.stderr,
            )
        if retagged:
            print(
                "!! the manifest(s) below already carry the new tag on disk, matching the cluster; commit them "
                "once the rollout has completed:\n  " + _commit_hint(plan, retagged),
                file=sys.stderr,
            )
        return 1

    print(f"\n!! deployment/{failed_at} failed to roll out.", file=sys.stderr)

    if no_rollback:
        print("!! --no-rollback set: leaving the cluster as-is for debugging.", file=sys.stderr)
        print(
            f"!! do not redeploy tag {plan.head_short} for {failed_at} until you've investigated why it failed.",
            file=sys.stderr,
        )
        return 1

    locked: set[str] = set()
    if plan.migrations_changed and "api" in applied:
        locked = {n for n, _, _ in touched if plan.deployments[n].image_key == "core"}
        print(
            "!! NOT rolling back "
            + "/".join(n for n in DEPLOYMENT_ORDER if n in locked)
            + ": this deploy changes Alembic migration(s)\n!!   "
            + "\n!!   ".join(plan.migrations_changed)
            + "\n!! and api has already been applied, so the database is (or may be) at HEAD's schema revision. An older\n"
            "!! core image's `alembic upgrade head` would fail with \"Can't locate revision\" and crash-loop. Kubernetes\n"
            "!! keeps the previous api ReplicaSet serving until a new pod is ready, so this alone is not an outage.\n"
            f"!!   - if api's new pod failed BEFORE running the migration (`kubectl logs deployment/api -n {namespace}`),\n"
            f"!!     `kubectl rollout undo deployment/api -n {namespace}` is safe;\n"
            "!!   - otherwise fix forward: commit a fix and re-run `deploy.py --apply`.",
            file=sys.stderr,
        )

    to_roll_back = [(n, m, o) for n, m, o in touched if n not in locked]
    if to_roll_back:
        print(
            "!! rolling back " + ", ".join(n for n, _, _ in to_roll_back) + " to the pre-run state...",
            file=sys.stderr,
        )
    rollback_failed: list[str] = []
    for name, manifest, original in to_roll_back:
        manifest.write_bytes(original)
        try:
            _apply_and_wait(name, manifest, namespace, rollout_timeouts[name])
        except (subprocess.CalledProcessError, DeployError) as exc:
            if isinstance(exc, DeployError):
                print(f"\n!! {exc}", file=sys.stderr)
            rollback_failed.append(name)

    if rollback_failed:
        print(
            f"!! rollback ITSELF failed for: {', '.join(rollback_failed)} - the cluster is in a "
            "mixed state, investigate by hand immediately.",
            file=sys.stderr,
        )
    elif locked:
        print("!! rollback complete for everything that could be rolled back (see above).", file=sys.stderr)
    else:
        print("!! rollback complete - cluster restored to its pre-run state.", file=sys.stderr)

    kept = [m for n, m, _ in touched if n in locked and plan.deployments[n].needs_build]
    if kept:
        print(
            "!! the manifest(s) below stay on the new tag on disk, matching the cluster; commit them once "
            "the situation is resolved:\n  " + _commit_hint(plan, kept),
            file=sys.stderr,
        )

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


def rollout_timeouts_from_args(args: argparse.Namespace) -> dict[str, str]:
    """One `kubectl rollout status --timeout` value per Deployment: --worker-rollout-timeout for
    worker, --rollout-timeout for the rest. Validated here so a typo fails before anything is
    built or pushed."""
    timeouts = {name: (args.worker_rollout_timeout if name == "worker" else args.rollout_timeout) for name in DEPLOYMENT_ORDER}
    for value in timeouts.values():
        parse_duration(value)
    return timeouts


def run_deploy(args: argparse.Namespace) -> int:
    rollout_timeouts = rollout_timeouts_from_args(args)
    preflight(args.namespace)

    if args.apply and git_dirty_outside_k8s():
        raise DeployError(
            "working tree has uncommitted changes outside k8s/ - commit or stash them first. "
            "Building from a dirty tree would tag an image with a commit it doesn't actually match."
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

    return apply_phase(plan, args.registry, args.namespace, rollout_timeouts, args.no_rollback)


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
        default=ROLLOUT_TIMEOUT_DEFAULT,
        metavar="DURATION",
        help="How long a *healthy* api/web rollout may take before the run stops and asks you to wait "
        f"(kubectl duration syntax; default: {ROLLOUT_TIMEOUT_DEFAULT}). A broken rollout (crash loop, "
        "unpullable image) is detected and rolled back within ~30s regardless.",
    )
    parser.add_argument(
        "--worker-rollout-timeout",
        default=WORKER_ROLLOUT_TIMEOUT_DEFAULT,
        metavar="DURATION",
        help="Same, for worker, whose replicas roll one at a time and take ~2 min each "
        f"(default: {WORKER_ROLLOUT_TIMEOUT_DEFAULT}).",
    )
    parser.add_argument(
        "--no-rollback",
        action="store_true",
        help="On a broken rollout, leave the cluster as-is for debugging instead of automatically "
        "rolling every deployment touched in this run back to its previous state. (api/worker are "
        "never rolled back once a migration-changing deploy has applied api - see --help's notes.)",
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
