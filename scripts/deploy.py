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

Stages. Every run targets one stage (`--stage`, k8s/stages/<name>.toml): its own namespace, with
its own database, object storage, volumes and Secret, running the manifests in k8s/ with the few
differences the stage file declares (host name, replica counts, ConfigMap entries). The images
are shared: a stage runs the same commit-SHA-tagged images from the same registry, so a release
- the vector {core image tag, web image tag, commit they came from} - that has proven itself on
dev is promoted to prod as-is, with `--promote`, without rebuilding anything:

  dev   any commit can be deployed (`--stage dev --apply`); its manifests are rendered into
        temp files, so a dev deploy never modifies anything in git.
  prod  the base stage: k8s/*.yaml are its manifests exactly as they are, and every deploy
        writes the new image tags into them, to be committed. Normally reached only with
        `--stage prod --promote`, which requires dev to be healthy, the release to be on the
        checked-out branch, and prod's own release to be part of it.

Safe by default: with no flags this only prints the plan - nothing is built, pushed, or applied.
Pass --apply to actually do it. A *broken* rollout (new pods crash-looping, image unpullable, ...)
automatically rolls every Deployment touched in that run back to its pre-run state (image tag
*and* manifest file), so the cluster never sits half-upgraded with an api/web pair that were never
meant to run together - see --no-rollback to opt out and leave a failure in place for debugging
instead. Two deliberate exceptions, both learned from a real incident:

  * A rollout that is merely *slow* (its timeout elapsed but every new pod is healthy - the
    worker's replicas roll one at a time and take ~2 min each) is left running, not rolled
    back: the script exits 1 and tells you to wait and re-run --apply to finish the remaining
    Deployments.
  * Once a deploy that changes Alembic migrations has applied api, api and worker are never
    auto-rolled back: api runs `alembic upgrade head` on startup, so the database is already at
    HEAD's revision and any older image would just crash-loop on "Can't locate revision".

docs/DEPLOY_GUIDE.md is the runbook behind this (section 18 covers stages). `--bootstrap` sets a
stage's supporting resources up (ConfigMap, volumes, Postgres, MinIO and its bucket, network
policies, Ingress) and is safe to re-run; it is also how a changed ConfigMap reaches a stage.

Examples:
  python scripts/deploy.py --stage dev
      Show what deploying the checked-out commit to dev would do, without touching anything.

  python scripts/deploy.py --stage dev --apply
      Build/push/apply whatever changed since dev's live commit, with a confirmation prompt
      first. Add --yes to skip the prompt (for scripting).

  python scripts/deploy.py --stage prod --promote --apply
      Promote the release dev runs to prod: no build, just dev's image tags.

  python scripts/deploy.py --stage dev --bootstrap --apply
      First deploy to a new stage: supporting resources, then the images.

  python scripts/deploy.py --stage dev --force web --apply
      Rebuild+redeploy the web image regardless of what git thinks changed.

  python scripts/deploy.py --stage dev --sync-secrets [--apply]
      Show which keys in the stage's env file (.env.dev) differ from the live
      autogenbook-secrets Secret, or write them with --apply. Secret *values* are never
      printed, only which keys are new/changed/unchanged.

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
import tempfile
import textwrap
import time
import tomllib
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
K8S_DIR = REPO_ROOT / "k8s"
STAGES_DIR = K8S_DIR / "stages"

REGISTRY_DEFAULT = "cerit.io/conerzyo"

SECRET_NAME = "autogenbook-secrets"
CONFIGMAP_NAME = "autogenbook-config"
# Set on api/worker/web after every successful apply: the full SHA of the commit the stage's
# images and manifests came from - the "release" `--promote` hands on to the next stage.
RELEASE_ANNOTATION = "autogenbook.io/release-commit"
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
    "api": DeploymentSpec(K8S_DIR / "api.yaml", "core"),
    "worker": DeploymentSpec(K8S_DIR / "worker.yaml", "core"),
    "web": DeploymentSpec(K8S_DIR / "web.yaml", "web"),
}
DEPLOYMENT_ORDER = ("api", "worker", "web")

# `--bootstrap`'s supporting resources, by k8s/<name>.yaml, in the order docs/DEPLOY_GUIDE.md
# section 14 applies them: these before the Deployments (db and minio then waited for, and the
# minio-init Job run to completion), the ones in BOOTSTRAP_AFTER once the Deployments are up.
BOOTSTRAP_BEFORE = ("configmap", "pvc", "db", "minio")
BOOTSTRAP_WAIT = ("db", "minio")
BOOTSTRAP_JOB_MANIFEST, BOOTSTRAP_JOB_NAME = "minio-init-job", "minio-init"
BOOTSTRAP_AFTER = ("networkpolicy", "ingress")
BOOTSTRAP_TIMEOUT = "300s"  # db/minio: a fresh PVC is provisioned and attached on first start
# The deployments that read autogenbook-config (envFrom) and so need a restart when it changes.
CONFIG_CONSUMERS = ("api", "worker")

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


def git_is_ancestor(ancestor: str, descendant: str) -> bool:
    """True if `ancestor` is `descendant` or one of its ancestors."""
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "merge-base", "--is-ancestor", ancestor, descendant],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode > 1:
        raise DeployError(f"git merge-base --is-ancestor {ancestor} {descendant} failed:\n{result.stderr.strip()}")
    return result.returncode == 0


def git_path_exists(commit: str, path: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "cat-file", "-e", f"{commit}:{path}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def diff_since(tag: str, target: str = "HEAD") -> tuple[list[str], bool]:
    """Returns (changed_files, unknown) between `tag` and `target`. unknown=True means the
    deployed tag's commit isn't reachable locally (shallow clone, rewritten history, ...), so no
    real diff is possible and the caller should treat a rebuild as necessary rather than guess."""
    if not git_sha_exists(tag):
        return [], True
    return git_diff_names(tag, target), False


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


def kubectl_get_json(resource: str, name: str, namespace: str) -> dict | None:
    out = _kubectl_get(resource, name, namespace, output="json")
    return json.loads(out) if out is not None else None


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
# Stages
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Stage:
    """One deployment stage, from k8s/stages/<name>.toml - see the module docstring."""

    name: str
    path: Path
    namespace: str
    host: str
    env_file: str  # repo-relative source of --sync-secrets
    # k8s/*.yaml are this stage's manifests exactly as they are: it is deployed from them and
    # every deploy records its new image tags in them. Any other stage is rendered into temp
    # files (see render_manifest()) and leaves git alone.
    base: bool = False
    promote_from: str | None = None
    replicas: dict[str, int] = field(default_factory=dict)
    config: dict[str, str] = field(default_factory=dict)


_STAGE_KEYS = frozenset({"namespace", "host", "env_file", "base", "promote_from", "replicas", "config"})
_HOSTNAME_RE = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+")
_ENV_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def stage_names(stages_dir: Path = STAGES_DIR) -> list[str]:
    return sorted(path.stem for path in stages_dir.glob("*.toml"))


def load_stage(name: str, stages_dir: Path = STAGES_DIR) -> Stage:
    path = stages_dir / f"{name}.toml"
    if not path.is_file():
        raise DeployError(f"unknown stage {name!r}: no {_display_path(path)} (stages: {', '.join(stage_names(stages_dir))})")
    where = _display_path(path)
    try:
        data = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as exc:
        raise DeployError(f"{where}: {exc}") from None

    unknown = sorted(set(data) - _STAGE_KEYS)
    if unknown:
        raise DeployError(f"{where}: unknown key(s) {', '.join(unknown)} (expected {', '.join(sorted(_STAGE_KEYS))})")
    for key in ("namespace", "host", "env_file"):
        if not isinstance(data.get(key), str) or not data[key]:
            raise DeployError(f"{where}: '{key}' must be a non-empty string")
    if not _HOSTNAME_RE.fullmatch(data["host"]):
        raise DeployError(f"{where}: host {data['host']!r} is not a lower-case DNS name")
    base = data.get("base", False)
    if not isinstance(base, bool):
        raise DeployError(f"{where}: 'base' must be true or false")

    replicas = data.get("replicas", {})
    if not isinstance(replicas, dict) or any(
        name not in DEPLOYMENTS or isinstance(count, bool) or not isinstance(count, int) or count < 0
        for name, count in replicas.items()
    ):
        raise DeployError(f"{where}: [replicas] maps {'/'.join(DEPLOYMENT_ORDER)} to a replica count >= 0")
    if base and replicas:
        raise DeployError(f"{where}: a base stage runs k8s/*.yaml as they are - set replicas there, not in [replicas]")

    config = data.get("config", {})
    if not isinstance(config, dict):
        raise DeployError(f"{where}: [config] must be a table")
    for key, value in config.items():
        if not _ENV_NAME_RE.fullmatch(key) or not isinstance(value, str):
            raise DeployError(
                f"{where}: [config] {key} must be an environment variable name with a quoted string value "
                "(ConfigMap data is always text)"
            )

    promote_from = data.get("promote_from")
    if promote_from is not None and (
        not isinstance(promote_from, str) or promote_from == name or not (stages_dir / f"{promote_from}.toml").is_file()
    ):
        raise DeployError(f"{where}: promote_from must name another stage in {_display_path(stages_dir)}")

    return Stage(
        name=name,
        path=path,
        namespace=data["namespace"],
        host=data["host"],
        env_file=data["env_file"],
        base=base,
        promote_from=promote_from,
        replicas=dict(replicas),
        config=dict(config),
    )


# Rendering: the stage's differences applied to a base manifest's text. Line-based, like
# replace_image_tag() and for the same reason - the manifests' comments survive - and each
# transform fails loudly rather than silently leaving a manifest unrendered when the base
# manifest's format changes. The base stage renders every manifest unchanged
# (tests/test_deploy_script.py guards that).

_REPLICAS_RE = re.compile(r"^(\s*replicas:[ \t]*)(\d+)", re.MULTILINE)
_INGRESS_HOST_RE = re.compile(r"^\s*(?:-\s*)?host:\s*\"?([^\"\s]+)\"?\s*$", re.MULTILINE)
_TLS_SECRET_RE = re.compile(r"^(\s*secretName:[ \t]*)(\S+)", re.MULTILINE)
_DATA_KEY_RE = re.compile(r"^data:[ \t]*\n", re.MULTILINE)
_TOP_LEVEL_LINE_RE = re.compile(r"^[^\s#]", re.MULTILINE)
_DATA_ENTRY_RE = re.compile(r"^([ \t]+)([A-Za-z_][A-Za-z0-9_.-]*):[ \t]*(.*?)[ \t]*$", re.MULTILINE)


def tls_secret_name(host: str) -> str:
    """cert-manager's Secret for `host` - the naming k8s/ingress.yaml already uses."""
    return host.replace(".", "-") + "-tls"


def _data_block(text: str, where: str) -> tuple[int, int]:
    """(start, end) of a ConfigMap manifest's top-level `data:` block contents."""
    match = _DATA_KEY_RE.search(text)
    if match is None:
        raise DeployError(f"no top-level 'data:' block in {where} - update _data_block() in scripts/deploy.py")
    end = _TOP_LEVEL_LINE_RE.search(text, match.end())
    return match.end(), end.start() if end else len(text)


def _yaml_scalar(raw: str) -> str:
    """The value of a plain, single- or double-quoted one-line YAML scalar - all a ConfigMap
    manifest here uses."""
    if raw.startswith('"'):
        return json.JSONDecoder().raw_decode(raw)[0]  # ignores a trailing comment
    if raw.startswith("'"):
        return raw[1:-1].replace("''", "'")
    return raw.split(" #", 1)[0].strip()


def configmap_data(text: str, where: str) -> dict[str, str]:
    start, end = _data_block(text, where)
    return {m.group(2): _yaml_scalar(m.group(3)) for m in _DATA_ENTRY_RE.finditer(text[start:end])}


def _render_config(text: str, overrides: dict[str, str], where: str) -> str:
    if not overrides:
        return text
    start, end = _data_block(text, where)
    block = text[start:end]
    first = _DATA_ENTRY_RE.search(block)
    indent = first.group(1) if first else "  "
    for key, value in overrides.items():
        entry = f"{indent}{key}: {json.dumps(value)}"  # a JSON string is a valid YAML double-quoted scalar
        block, count = re.subn(rf"^{re.escape(indent)}{re.escape(key)}:.*$", lambda _m: entry, block, flags=re.MULTILINE)
        if count == 0:
            block += ("\n" if block and not block.endswith("\n") else "") + entry + "\n"
    return text[:start] + block + text[end:]


def _render_host(text: str, host: str, where: str) -> str:
    hosts = set(_INGRESS_HOST_RE.findall(text))
    if len(hosts) != 1:
        raise DeployError(f"expected exactly one 'host:' in {where}, found {sorted(hosts) or 'none'}")
    (base_host,) = hosts
    if host == base_host:
        return text
    text = text.replace(base_host, host)
    text, count = _TLS_SECRET_RE.subn(lambda m: m.group(1) + tls_secret_name(host), text)
    if count != 1:
        raise DeployError(f"expected exactly one 'secretName:' in {where}, found {count}")
    return text


def _render_replicas(text: str, replicas: int, where: str) -> str:
    text, count = _REPLICAS_RE.subn(lambda m: f"{m.group(1)}{replicas}", text, count=1)
    if count != 1:
        raise DeployError(f"no 'replicas:' line in {where}")
    return text


def render_manifest(stage: Stage, name: str, text: str, *, where: str) -> str:
    """`text`, the manifest k8s/<name>.yaml (or its content at some commit), as `stage` runs it."""
    if name == "configmap":
        return _render_config(text, stage.config, where)
    if name == "ingress":
        return _render_host(text, stage.host, where)
    if name in stage.replicas:
        return _render_replicas(text, stage.replicas[name], where)
    return text


def rendered(stage: Stage, name: str) -> str:
    path = K8S_DIR / f"{name}.yaml"
    return render_manifest(stage, name, path.read_text(), where=_display_path(path))


def stage_config(stage: Stage) -> dict[str, str]:
    """The ConfigMap data `stage` runs with: k8s/configmap.yaml plus the stage's [config]."""
    return {**configmap_data((K8S_DIR / "configmap.yaml").read_text(), "k8s/configmap.yaml"), **stage.config}


def image_ref_prefix(registry: str, image_key: str) -> str:
    return f"{registry}/{IMAGES[image_key].repo}"


# --------------------------------------------------------------------------------------
# Plan
# --------------------------------------------------------------------------------------


@dataclass
class DeploymentPlan:
    name: str
    manifest: Path
    image_key: str
    current_tag: str  # "" when the Deployment doesn't exist in the stage yet (--bootstrap)
    needs_build: bool
    needs_apply: bool
    reason: str
    # The tag to roll out when it isn't a fresh build of HEAD: the promoted release's, or - for
    # a Deployment --bootstrap creates without a rebuild - the one its sibling already runs.
    new_tag: str | None = None
    # For a non-base stage, `manifest` is a rendered temp copy and this is the k8s/ file it was
    # rendered from (what git knows about); None when `manifest` is the k8s/ file itself.
    source: Path | None = None

    def target_tag(self, head_short: str) -> str | None:
        """The image tag this run points the manifest at, or None to leave its tag alone."""
        return self.new_tag or (head_short if self.needs_build else None)


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
    # True when the manifests are the k8s/ files themselves (the base stage): retagging them leaves
    # a change to commit. False for a non-base stage, whose manifests are temp renders.
    in_place: bool = True
    # The commit the rolled-out images and manifests come from, recorded as RELEASE_ANNOTATION
    # once they are live: HEAD for a deploy, the source stage's release for a promotion.
    release_commit: str = ""
    commit_message: str = ""  # of the "commit the retagged manifests" hint; "Deploy <HEAD>" if empty
    promoted_from: str | None = None

    @property
    def anything_to_do(self) -> bool:
        return any(d.needs_apply for d in self.deployments.values())


def live_tags(namespace: str, *, allow_missing: bool = False) -> dict[str, str]:
    """The image tag each Deployment in `namespace` runs - "" for one that doesn't exist, which is
    an error unless `allow_missing` (--bootstrap creates it)."""
    live_images = {name: kubectl_get_image(name, namespace) for name in DEPLOYMENT_ORDER}
    missing = [name for name, ref in live_images.items() if ref is None]
    if missing and not allow_missing:
        raise DeployError(
            f"deployment(s) not found in namespace '{namespace}': {', '.join(missing)} - "
            "set the stage up first with --bootstrap (see docs/DEPLOY_GUIDE.md section 18)"
        )
    return {name: parse_tag(ref) if ref else "" for name, ref in live_images.items()}


_IMAGE_TAG_LINE_RE = re.compile(r"^(\s*image:\s*\S+):[^\s:/]+(\s*)$", re.MULTILINE)


def without_image_tags(text: str) -> str:
    """`text` with every image line's tag blanked out, to compare manifests by everything else."""
    return _IMAGE_TAG_LINE_RE.sub(r"\1:<tag>\2", text)


def _manifest_changed(ref: str, manifest: Path) -> bool:
    """Whether `manifest` on disk (what an apply would use) differs from the one committed at
    `ref` in anything but its image tag. Image tags alone don't count: the base stage's manifests
    change tag in every "Deploy <sha>" commit, and the tag an apply uses is decided separately."""
    committed = _manifest_at_ref(ref, manifest)
    return committed is None or without_image_tags(committed.decode()) != without_image_tags(manifest.read_text())


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
    forced = force in (image_key, "all")
    if not tag:  # not deployed in this stage yet
        return _ImageDecision(tag="", changed=[], relevant=[], forced=forced, needs_build=True)
    changed, unknown = diff_since(tag)
    if unknown:
        notes.append(f"{image_key}'s deployed commit {tag} isn't reachable locally - rebuilding to be safe.")
    relevant = [f for f in changed if classify_path(f) == image_key]
    needs_build = forced or drifted or unknown or bool(relevant)
    return _ImageDecision(tag=tag, changed=changed, relevant=relevant, forced=forced, needs_build=needs_build)


def _migration_note(migrations_changed: list[str]) -> str:
    return (
        "this deploy changes Alembic migration(s): "
        + ", ".join(migrations_changed)
        + ". api runs `alembic upgrade head` on startup, so once api has been applied "
        "api/worker will NOT be auto-rolled back on a later failure - the database would "
        "already be ahead of the old image. See docs/DEPLOY_GUIDE.md section 16."
    )


def _migrations_between(old: str, new: str) -> list[str]:
    changed, unknown = diff_since(old, new)
    if unknown:
        return [f"(unknown - {old} isn't reachable locally, assuming migrations changed)"]
    return [f for f in changed if f.startswith(MIGRATIONS_PREFIX)]


def build_plan(stage: Stage, force: str | None, *, allow_missing: bool = False) -> Plan:
    """Plan to roll the checked-out commit out on `stage`, rebuilding only what changed since the
    commit(s) it runs."""
    head_full, head_short = git_head()
    notes: list[str] = []
    tags = live_tags(stage.namespace, allow_missing=allow_missing)

    # api and worker share one image and must always agree; api is the reference tag if they don't.
    core_drifted = bool(tags["api"] and tags["worker"]) and tags["worker"] != tags["api"]
    if core_drifted:
        notes.append(
            f"worker is on tag {tags['worker']} but api is on {tags['api']} - they share one image "
            "and should always match; forcing a core rebuild to realign them."
        )

    image_tags = {"core": tags["api"] or tags["worker"], "web": tags["web"]}
    decisions = {
        image_key: _decide_image(image_key, tag, force, drifted=(image_key == "core" and core_drifted), notes=notes)
        for image_key, tag in image_tags.items()
    }

    # With no core image deployed yet there is no older one to protect (nor roll back to).
    migrations_changed: list[str] = []
    if decisions["core"].needs_build and image_tags["core"]:
        migrations_changed = _migrations_between(image_tags["core"], "HEAD")
        if migrations_changed:
            notes.append(_migration_note(migrations_changed))

    # [replicas] in a non-base stage's file shapes its Deployments, so a change to it re-applies them.
    stage_rel = _display_path(stage.path)
    deployments: dict[str, DeploymentPlan] = {}
    for name in DEPLOYMENT_ORDER:
        spec = DEPLOYMENTS[name]
        decision = decisions[spec.image_key]
        missing = not tags[name]
        manifest_touched = not missing and (
            _manifest_changed(tags[name], spec.manifest) or (not stage.base and stage_rel in decision.changed)
        )

        deployments[name] = DeploymentPlan(
            name=name,
            manifest=spec.manifest,
            image_key=spec.image_key,
            current_tag=tags[name],
            needs_build=decision.needs_build,
            needs_apply=missing or decision.needs_build or manifest_touched,
            reason="not deployed yet"
            if missing
            else _describe_reason(
                forced=decision.forced,
                needs_build=decision.needs_build,
                manifest_touched=manifest_touched,
                relevant=decision.relevant,
            ),
            new_tag=decision.tag if missing and not decision.needs_build else None,
        )

    images_to_build = {image_key for image_key, decision in decisions.items() if decision.needs_build}
    return Plan(
        head_full,
        head_short,
        deployments,
        images_to_build,
        notes,
        migrations_changed,
        in_place=stage.base,
        release_commit=head_full,
    )


def deployment_health_problem(deployment: dict) -> str | None:
    """Why a Deployment (`kubectl get deployment -o json`) isn't completely rolled out with every
    replica available, or None if it is."""
    want = deployment.get("spec", {}).get("replicas", 1)
    status = deployment.get("status", {})
    if status.get("observedGeneration", 0) < deployment.get("metadata", {}).get("generation", 0):
        return "its latest change hasn't been picked up by the deployment controller yet"
    for key in ("replicas", "updatedReplicas", "readyReplicas", "availableReplicas"):
        have = status.get(key, 0)
        if have != want:
            return f"{key} is {have}, want {want} - still rolling out, or pods failing"
    return None


def build_promotion_plan(stage: Stage, source: Stage, *, allow_missing: bool = False) -> Plan:
    """Plan to roll out on `stage` exactly the release `source` runs - its image tags, nothing
    rebuilt - once it has checked that it really is one release worth promoting:

      * `source` is healthy, and api and worker run the same image;
      * both images match the release commit (RELEASE_ANNOTATION), i.e. `source`'s last deploy
        finished;
      * that commit is on the checked-out branch, and contains what `stage` runs now (so the
        promotion never takes `stage` backwards, past a fix deployed to it directly);
      * the k8s/ manifests on disk - which this applies - are the release's own, image tags aside.
    """
    head_full, head_short = git_head()
    notes: list[str] = []

    src = live_tags(source.namespace)
    if src["api"] != src["worker"]:
        raise DeployError(
            f"{source.name}'s api runs {src['api']} but its worker runs {src['worker']} - finish "
            f"{source.name}'s deploy first (`deploy.py --stage {source.name} --apply`)"
        )
    src_deployments = {name: kubectl_get_json("deployment", name, source.namespace) or {} for name in DEPLOYMENT_ORDER}
    problems = [
        f"{name}: {problem}"
        for name, deployment in src_deployments.items()
        if (problem := deployment_health_problem(deployment))
    ]
    if problems:
        raise DeployError(f"{source.name} isn't healthy, refusing to promote what it runs:\n  " + "\n  ".join(problems))

    release_ref = src_deployments["api"].get("metadata", {}).get("annotations", {}).get(RELEASE_ANNOTATION)
    if not release_ref:
        release_ref = src["api"]
        notes.append(f"{source.name} has no {RELEASE_ANNOTATION} annotation yet - taking its core tag {release_ref} as the release.")
    if not git_sha_exists(release_ref):
        raise DeployError(f"{source.name}'s release commit {release_ref} isn't in this clone - `git fetch` first")
    release = git("rev-parse", f"{release_ref}^{{commit}}")
    release_short = git("rev-parse", "--short", release)

    image_tags = {"core": src["api"], "web": src["web"]}
    for image_key, tag in image_tags.items():
        changed, unknown = diff_since(tag, release)
        if unknown:
            raise DeployError(f"{source.name}'s {image_key} tag {tag} isn't a commit in this clone - `git fetch` first")
        stale = [f for f in changed if classify_path(f) == image_key]
        if stale:
            raise DeployError(
                f"{source.name}'s {image_key} image ({tag}) doesn't match its release {release_short} "
                f"({', '.join(stale[:4])}{' ...' if len(stale) > 4 else ''} differ) - its last deploy didn't "
                f"finish; re-run `deploy.py --stage {source.name} --apply` first"
            )

    if not git_is_ancestor(release, head_full):
        raise DeployError(
            f"{source.name}'s release {release_short} isn't on the checked-out branch - {stage.name} only gets "
            "releases that are part of the branch it is promoted from; merge it (or check that branch out) first"
        )
    diverged = [
        _display_path(DEPLOYMENTS[name].manifest)
        for name in DEPLOYMENT_ORDER
        if _manifest_changed(release, DEPLOYMENTS[name].manifest)
    ]
    if diverged:
        raise DeployError(
            f"{', '.join(diverged)} on disk differ from release {release_short}'s (image tags aside), and a promotion "
            f"applies them - deploy HEAD to {source.name} first, so the release it runs includes them"
        )

    dst = live_tags(stage.namespace, allow_missing=allow_missing)
    dst_images = {"core": dst["api"] or dst["worker"], "web": dst["web"]}
    for image_key, tag in dst_images.items():
        if not tag:
            continue
        if not git_sha_exists(tag):
            notes.append(f"{stage.name}'s {image_key} tag {tag} isn't a commit in this clone - can't check the release contains it.")
        elif not git_is_ancestor(tag, release):
            raise DeployError(
                f"{stage.name} runs {image_key} {tag}, which {source.name}'s release {release_short} doesn't contain - "
                f"promoting it would take {stage.name} backwards. Deploy a commit that contains {tag} to "
                f"{source.name} first."
            )

    migrations_changed: list[str] = []
    if dst_images["core"] and dst_images["core"] != image_tags["core"]:
        migrations_changed = _migrations_between(dst_images["core"], image_tags["core"])
        if migrations_changed:
            notes.append(_migration_note(migrations_changed))

    source_config, stage_config_now = stage_config(source), stage_config(stage)
    config_diff = sorted(k for k in source_config.keys() | stage_config_now.keys() if source_config.get(k) != stage_config_now.get(k))
    if config_diff:
        notes.append(
            f"{source.name} runs with different config for {', '.join(config_diff)} ([config] in "
            f"{_display_path(source.path)}). A promotion moves images, not config: if the release needs "
            f"{source.name}'s values, put them in k8s/configmap.yaml (or {_display_path(stage.path)}) and "
            "apply them with --bootstrap."
        )

    deployments: dict[str, DeploymentPlan] = {}
    for name in DEPLOYMENT_ORDER:
        spec = DEPLOYMENTS[name]
        current, new = dst[name], image_tags[spec.image_key]
        manifest_touched = bool(current) and _manifest_changed(current, spec.manifest)
        if not current:
            reason = "not deployed yet"
        elif new != current:
            reason = f"{source.name} release {release_short}" + (" (+ manifest changes)" if manifest_touched else "")
        elif manifest_touched:
            reason = "manifest only - k8s manifest changed"
        else:
            reason = "up to date"
        deployments[name] = DeploymentPlan(
            name=name,
            manifest=spec.manifest,
            image_key=spec.image_key,
            current_tag=current,
            needs_build=False,
            needs_apply=not current or new != current or manifest_touched,
            reason=reason,
            new_tag=new,
        )

    return Plan(
        head_full,
        head_short,
        deployments,
        set(),
        notes,
        migrations_changed,
        in_place=stage.base,
        release_commit=release,
        commit_message=f"Promote {source.name} release {release_short} to {stage.name}",
        promoted_from=source.name,
    )


def check_entrypoint(plan: Plan, stage: Stage) -> None:
    """Refuses a plan that would leave the worker's CLI_ENTRYPOINT (the stage's config) pointing
    at a file the core image it runs afterwards doesn't have - e.g. dev's run_engine.py with an
    image built before the engine rewrite was merged."""
    entrypoint = stage_config(stage).get("CLI_ENTRYPOINT", "")
    path = entrypoint.removeprefix("/app/")  # the images' WORKDIR, and the CLI's cwd
    if not path or path.startswith("/"):
        return
    api = plan.deployments["api"]
    commit = plan.head_full if api.needs_build else (api.new_tag or api.current_tag)
    if not git_sha_exists(commit):
        plan.notes.append(f"core image {commit} isn't a commit in this clone - can't check it has CLI_ENTRYPOINT {entrypoint}.")
    elif not git_path_exists(commit, path):
        raise DeployError(
            f"{stage.name}'s CLI_ENTRYPOINT is {entrypoint} ({_display_path(stage.path)} / k8s/configmap.yaml), but the "
            f"core image it would run ({commit[:12]}) has no such file - deploy a commit that has it, or change the setting"
        )


def print_plan(plan: Plan) -> None:
    if plan.promoted_from:
        print(f"Promoting {plan.promoted_from}'s release {plan.release_commit} (HEAD is {plan.head_short})\n")
    else:
        print(f"HEAD is {plan.head_short} ({plan.head_full})\n")
    header = f"{'DEPLOYMENT':<10} {'IMAGE':<6} {'CURRENT':<10} {'NEW':<10} {'ACTION':<22} REASON"
    print(header)
    print("-" * len(header))
    for name in DEPLOYMENT_ORDER:
        d = plan.deployments[name]
        new_tag = d.target_tag(plan.head_short) or d.current_tag
        if d.needs_build:
            action = "build+push+apply"
        elif d.needs_apply and new_tag != d.current_tag:
            action = "apply"
        elif d.needs_apply:
            action = "apply (manifest only)"
        else:
            action = "-"
        print(f"{name:<10} {d.image_key:<6} {d.current_tag or '-':<10} {new_tag:<10} {action:<22} {d.reason}")
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
                "re-run the same `deploy.py ... --apply` to carry on with the remaining deployments, otherwise investigate "
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


Render = Callable[[str, str], str]  # (deployment name, base manifest text) -> the stage's manifest text


def _rollback_baseline(d: DeploymentPlan, image_ref_prefix: str, render: Render | None = None) -> bytes | None:
    """The manifest content a rollback of `d` restores: the git-committed manifest at the live
    tag's commit (so any non-tag manifest change HEAD carried - a resource limit, say - is undone
    too), rendered for the stage when `render` is given, with its image line pinned to the tag the
    cluster is *actually* running. None when `d` doesn't exist yet: there is nothing to go back to.

    The pin matters: the commit that the live tag names still contains the tag of the deploy
    *before* it, because a tag only lands in a manifest in the follow-up "Deploy <tag>" commit.
    Restoring that commit's bytes verbatim therefore rolled the cluster back two deploys, not one
    (the real incident: api landed on an image two migrations behind the database)."""
    if not d.current_tag:
        return None
    source = d.source or d.manifest
    committed = _manifest_at_ref(d.current_tag, source)
    if committed is not None:
        text, where = committed.decode(), f"{_display_path(source)} at {d.current_tag}"
    else:
        # Best effort: d.current_tag isn't a resolvable commit (legacy semver tag, shallow clone).
        text, where = source.read_text(), str(source)
    if render is not None:
        text = render(d.name, text)
    return replace_image_tag(text, image_ref_prefix, d.current_tag, where=where).encode()


def _commit_hint(plan: Plan, manifests: list[Path]) -> str:
    shown = sorted({_display_path(m) for m in manifests})
    message = plan.commit_message or f"Deploy {plan.head_short}"
    return "\n  ".join(shown) + f"\n\n  git add {' '.join(shown)} && git commit -m '{message}'"


def apply_phase(
    plan: Plan,
    registry: str,
    namespace: str,
    rollout_timeouts: dict[str, str],
    no_rollback: bool,
    render: Render | None = None,
) -> int:
    """Applies every Deployment the plan says needs it, in DEPLOYMENT_ORDER, and decides what to
    do when one fails:

      * RolloutSlow (timeout elapsed, new pods healthy): leave everything as it is, exit 1. The
        rollout will most likely complete by itself; re-running --apply then finishes the rest.
      * anything else (RolloutBroken, kubectl error, manifest error): roll every touched
        Deployment back to its pre-run state - EXCEPT api and worker when this deploy changes
        Alembic migrations and api was already applied (see MIGRATIONS_PREFIX): the database is
        then ahead of the old image and rolling back could only crash-loop, so they stay on the
        new image and the operator is told exactly what to check. A Deployment this run created
        has nothing to go back to and is left in place.

    `render` renders a base manifest for a non-base stage (see render_deployments()), so that a
    rollback of such a stage restores its rendered manifest, not the base one.
    """
    order = [name for name in DEPLOYMENT_ORDER if plan.deployments[name].needs_apply]
    if not order:
        print("\nNothing to apply.")
        return 0

    touched: list[tuple[str, Path, bytes | None]] = []
    applied: set[str] = set()  # kubectl apply was at least *attempted* for these
    failed_at: str | None = None
    failure: BaseException | None = None

    for name in order:
        d = plan.deployments[name]
        prefix = image_ref_prefix(registry, d.image_key)
        try:
            touched.append((name, d.manifest, _rollback_baseline(d, prefix, render)))
            target = d.target_tag(plan.head_short)
            if target:
                set_image_tag(d.manifest, prefix, target)
            applied.add(name)
            _apply_and_wait(name, d.manifest, namespace, rollout_timeouts[name])
        except (subprocess.CalledProcessError, DeployError) as exc:
            if isinstance(exc, DeployError):
                print(f"\n!! {exc}", file=sys.stderr)
            failed_at, failure = name, exc
            break

    def _retagged(names: set[str] | None = None) -> list[Path]:
        """Manifests this run moved to a new tag - to commit, for the base stage."""
        if not plan.in_place:
            return []
        return [
            m
            for n, m, _ in touched
            if (names is None or n in names)
            and plan.deployments[n].target_tag(plan.head_short) not in (None, plan.deployments[n].current_tag)
        ]

    retagged = _retagged()

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
                "re-run the same `deploy.py ... --apply` and it will pick up where this run stopped.",
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
    failed = plan.deployments[failed_at]
    failed_tag = failed.target_tag(plan.head_short) or failed.current_tag

    if no_rollback:
        print("!! --no-rollback set: leaving the cluster as-is for debugging.", file=sys.stderr)
        print(
            f"!! do not redeploy tag {failed_tag} for {failed_at} until you've investigated why it failed.",
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
            "!!   - otherwise fix forward: commit a fix and deploy it.",
            file=sys.stderr,
        )

    created = [n for n, _, o in touched if o is None and n not in locked]
    if created:
        print(
            f"!! leaving {', '.join(created)} in place: created by this run, so there's no previous state to go back to "
            f"(`kubectl delete deployment/<name> -n {namespace}` removes one).",
            file=sys.stderr,
        )
    to_roll_back = [(n, m, o) for n, m, o in touched if n not in locked and o is not None]
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
    elif locked or created:
        print("!! rollback complete for everything that could be rolled back (see above).", file=sys.stderr)
    else:
        print("!! rollback complete - cluster restored to its pre-run state.", file=sys.stderr)

    kept = _retagged(locked)
    if kept:
        print(
            "!! the manifest(s) below stay on the new tag on disk, matching the cluster; commit them once "
            "the situation is resolved:\n  " + _commit_hint(plan, kept),
            file=sys.stderr,
        )

    if failed.needs_build:
        print(
            f"!! the image that failed was pushed to the registry as tag {failed_tag} - it was "
            "NOT deleted from Harbor (you may want it to debug the failure); do not redeploy it "
            "without investigating first.",
            file=sys.stderr,
        )
    else:
        print(f"!! do not deploy tag {failed_tag} for {failed_at} again without investigating first.", file=sys.stderr)
    return 1


def preflight(namespace: str) -> None:
    for binary in ("git", "kubectl"):
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


# --------------------------------------------------------------------------------------
# Stage-specific steps: rendering, --bootstrap, the release annotation
# --------------------------------------------------------------------------------------


def stage_renderer(stage: Stage) -> Render | None:
    """apply_phase()'s `render` for `stage` - None for the base stage, which applies k8s/ as is."""
    if stage.base:
        return None
    return lambda name, text: render_manifest(stage, name, text, where=f"k8s/{name}.yaml")


def check_rendering(stage: Stage) -> None:
    """Renders every manifest a run may apply for `stage`, so a manifest the renderer no longer
    understands fails the plan - dry run included - instead of halfway through an --apply."""
    for name in (*DEPLOYMENT_ORDER, *BOOTSTRAP_BEFORE, BOOTSTRAP_JOB_MANIFEST, *BOOTSTRAP_AFTER):
        rendered(stage, name)


def render_deployments(plan: Plan, stage: Stage, registry: str, out_dir: Path) -> None:
    """Points each DeploymentPlan of a non-base stage at a rendered copy of its manifest in
    `out_dir`, image pinned to the tag the stage runs now (so a manifest-only apply keeps it).
    apply_phase() then retags and rolls back those copies: k8s/ itself is never modified."""
    for d in plan.deployments.values():
        source = d.source or d.manifest
        text = render_manifest(stage, d.name, source.read_text(), where=_display_path(source))
        if d.current_tag:
            text = replace_image_tag(text, image_ref_prefix(registry, d.image_key), d.current_tag, where=_display_path(source))
        d.source, d.manifest = source, out_dir / source.name
        d.manifest.write_text(text)


def live_config(namespace: str) -> dict[str, str] | None:
    configmap = kubectl_get_json("configmap", CONFIGMAP_NAME, namespace)
    return configmap.get("data", {}) if configmap is not None else None


def live_release(namespace: str) -> str | None:
    deployment = kubectl_get_json("deployment", "api", namespace)
    return (deployment or {}).get("metadata", {}).get("annotations", {}).get(RELEASE_ANNOTATION)


def _apply_text(text: str, namespace: str, label: str) -> None:
    cmd = ["kubectl", "apply", "-n", namespace, "-f", "-"]
    print(f"$ {shlex.join(cmd)} < {label}")
    subprocess.run(cmd, input=text, text=True, check=True)


def bootstrap_before(stage: Stage) -> None:
    """--bootstrap's first half: everything api/worker/web need to start (DEPLOY_GUIDE section 14)."""
    print(f"\n==> Supporting resources of stage {stage.name} (namespace {stage.namespace})")
    for name in BOOTSTRAP_BEFORE:
        _apply_text(rendered(stage, name), stage.namespace, f"k8s/{name}.yaml")
    for name in BOOTSTRAP_WAIT:
        _wait_for_rollout(name, stage.namespace, BOOTSTRAP_TIMEOUT)
    # A finished Job never runs again and its pod template can't be changed, so it is replaced.
    # Creating the bucket is idempotent (`mc mb --ignore-existing`).
    run(["kubectl", "delete", "job", BOOTSTRAP_JOB_NAME, "-n", stage.namespace, "--ignore-not-found"])
    _apply_text(rendered(stage, BOOTSTRAP_JOB_MANIFEST), stage.namespace, f"k8s/{BOOTSTRAP_JOB_MANIFEST}.yaml")
    run(
        [
            "kubectl",
            "wait",
            "--for=condition=complete",
            f"job/{BOOTSTRAP_JOB_NAME}",
            "-n",
            stage.namespace,
            f"--timeout={BOOTSTRAP_TIMEOUT}",
        ]
    )


def bootstrap_after(stage: Stage) -> None:
    """--bootstrap's second half, once the Deployments are up: network policies, then the Ingress."""
    print(f"\n==> Network policies and Ingress of stage {stage.name} (https://{stage.host})")
    for name in BOOTSTRAP_AFTER:
        _apply_text(rendered(stage, name), stage.namespace, f"k8s/{name}.yaml")


def restart_for_config(plan: Plan, namespace: str, rollout_timeouts: dict[str, str]) -> None:
    """After a ConfigMap change, restarts the Deployments that read it (envFrom is only read at
    container start) - except any this run already moved to a new image, or created, whose pods
    started with the new config anyway."""
    for name in CONFIG_CONSUMERS:
        d = plan.deployments[name]
        if d.current_tag and d.target_tag(plan.head_short) in (None, d.current_tag):
            print(f"\n==> Restarting deployment/{name} for the changed ConfigMap")
            run(["kubectl", "rollout", "restart", f"deployment/{name}", "-n", namespace])
            _wait_for_rollout(name, namespace, rollout_timeouts[name])


def annotate_release(namespace: str, commit: str) -> None:
    run(["kubectl", "annotate", "deployment", *DEPLOYMENT_ORDER, "-n", namespace, f"{RELEASE_ANNOTATION}={commit}", "--overwrite"])


def run_deploy(args: argparse.Namespace, stage: Stage) -> int:
    rollout_timeouts = rollout_timeouts_from_args(args)
    source: Stage | None = None
    if args.promote:
        if not stage.promote_from:
            raise DeployError(f"stage {stage.name} has no promote_from in {_display_path(stage.path)} - nothing to promote from")
        if args.force:
            raise DeployError("--force rebuilds images, and a promotion never builds anything")
        source = load_stage(stage.promote_from)
    check_rendering(stage)
    preflight(stage.namespace)
    if source is not None:
        preflight(source.namespace)

    # A promotion builds nothing, so only a deploy needs the tree to match the commit it tags images with.
    if args.apply and source is None and git_dirty_outside_k8s():
        raise DeployError(
            "working tree has uncommitted changes outside k8s/ - commit or stash them first. "
            "Building from a dirty tree would tag an image with a commit it doesn't actually match."
        )
    if args.bootstrap and kubectl_get_secret_data(SECRET_NAME, stage.namespace) is None:
        raise DeployError(
            f"secret/{SECRET_NAME} doesn't exist in namespace {stage.namespace} yet - create it from "
            f"{stage.env_file} first: `deploy.py --stage {stage.name} --sync-secrets --apply`"
        )

    print(f"Stage {stage.name}: namespace {stage.namespace}, https://{stage.host}\n")
    if source is not None:
        plan = build_promotion_plan(stage, source, allow_missing=args.bootstrap)
    else:
        plan = build_plan(stage, args.force, allow_missing=args.bootstrap)
    check_entrypoint(plan, stage)

    config, current_config = stage_config(stage), live_config(stage.namespace)
    config_changed = config != current_config
    if config_changed and not args.bootstrap:
        differing = sorted(k for k in config.keys() | (current_config or {}).keys() if config.get(k) != (current_config or {}).get(k))
        plan.notes.append(
            f"the live {CONFIGMAP_NAME} differs from k8s/configmap.yaml + {_display_path(stage.path)} "
            f"({', '.join(differing) if current_config is not None else 'it does not exist'}) - add --bootstrap to apply it."
        )
    print_plan(plan)
    if args.bootstrap:
        print(
            f"\n--bootstrap: before the deployments, apply {', '.join(f'k8s/{n}.yaml' for n in BOOTSTRAP_BEFORE)} "
            f"(ConfigMap {'changes' if config_changed else 'unchanged'}), wait for {' and '.join(BOOTSTRAP_WAIT)}, "
            f"re-run job/{BOOTSTRAP_JOB_NAME}; after them, apply {', '.join(f'k8s/{n}.yaml' for n in BOOTSTRAP_AFTER)}"
            + (f" and restart {'/'.join(CONFIG_CONSUMERS)} unless already rolled." if config_changed else ".")
        )

    if not plan.anything_to_do and not args.bootstrap:
        if source is not None:
            print(f"\nNothing to promote - {stage.name} already runs {source.name}'s release.")
        else:
            print(f"\nNothing to deploy - {stage.name} already matches HEAD for every relevant path.")
        # E.g. a re-run after a slow rollout finished: the release is fully live now, record it.
        if args.apply and live_release(stage.namespace) != plan.release_commit:
            annotate_release(stage.namespace, plan.release_commit)
        return 0

    if not args.apply:
        print("\nDry run - pass --apply to carry this plan out.")
        return 0

    if plan.images_to_build and shutil.which("docker") is None:
        raise DeployError("'docker' not found on PATH - needed to build the images above")
    what = f"promotion of {source.name}'s release to {stage.name}" if source is not None else f"deploy to {stage.name}"
    if not args.yes and not confirm(f"\nProceed with this {what}?"):
        print("Aborted.")
        return 0

    for image_key in sorted(plan.images_to_build):
        build_and_push(image_key, plan.head_short, args.registry)

    with tempfile.TemporaryDirectory(prefix=f"autogenbook-{stage.name}-") as tmp:
        if not plan.in_place:
            render_deployments(plan, stage, args.registry, Path(tmp))
        if args.bootstrap:
            bootstrap_before(stage)
        code = apply_phase(plan, args.registry, stage.namespace, rollout_timeouts, args.no_rollback, stage_renderer(stage))
    if code != 0:
        return code
    if args.bootstrap:
        if config_changed:
            restart_for_config(plan, stage.namespace, rollout_timeouts)
        bootstrap_after(stage)
    annotate_release(stage.namespace, plan.release_commit)
    return 0


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


def sync_secrets(args: argparse.Namespace, stage: Stage) -> int:
    env_file = args.env_file or REPO_ROOT / stage.env_file
    ensure_ignored(env_file)
    values = read_env_file(env_file)
    validate_secret_values(values)

    current = kubectl_get_secret_data(SECRET_NAME, stage.namespace)
    print(f"Secret sync plan for secret/{SECRET_NAME} in namespace {stage.namespace} (values never shown):\n")
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

    if not args.yes and not confirm(f"\nWrite secret/{SECRET_NAME} in namespace {stage.namespace}?"):
        print("Aborted.")
        return 0

    create_cmd = ["kubectl", "create", "secret", "generic", SECRET_NAME, "-n", stage.namespace]
    for key in REQUIRED_SECRET_KEYS:
        create_cmd.append(f"--from-literal={key}={values[key]}")
    create_cmd += ["--dry-run=client", "-o", "yaml"]

    print(
        f"\n$ kubectl create secret generic {SECRET_NAME} -n {stage.namespace} "
        f"--from-literal=<{len(REQUIRED_SECRET_KEYS)} keys, values redacted> --dry-run=client -o yaml | kubectl apply -f -"
    )
    manifest = subprocess.run(create_cmd, stdout=subprocess.PIPE, text=True, check=True).stdout
    subprocess.run(["kubectl", "apply", "-n", stage.namespace, "-f", "-"], input=manifest, text=True, check=True)
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
            Build, push, and roll out AutoGenBook's two container images to one stage of the
            CERIT-SC cluster (k8s/stages/<stage>.toml), tagged by git commit SHA - only
            rebuilding the image(s) whose relevant source paths actually changed since what the
            stage runs right now - or promote the release one stage runs to the next.

            Safe by default: with no flags this only PRINTS the plan. Pass --apply to actually
            build/push/apply it."""
        ),
        epilog=textwrap.dedent(
            """\
            examples:
              deploy.py --stage dev                          show the plan, touch nothing
              deploy.py --stage dev --apply                  build/push/apply HEAD to dev, with a prompt
              deploy.py --stage dev --apply --yes            same, no prompt (for scripting)
              deploy.py --stage prod --promote               show what promoting dev's release would do
              deploy.py --stage prod --promote --apply       promote it: dev's images, no rebuild
              deploy.py --stage dev --bootstrap --apply      first deploy: storage, db, minio, ... too
              deploy.py --stage dev --force web --apply      rebuild+redeploy web regardless of the diff
              deploy.py --stage dev --sync-secrets           show which .env.dev keys differ live
              deploy.py --stage dev --sync-secrets --apply   write .env.dev into the live Secret

            required keys in the env file for --sync-secrets:
              """
            + ", ".join(REQUIRED_SECRET_KEYS)
            + """

            See docs/DEPLOY_GUIDE.md (section 18 for stages) for the runbook this automates."""
        ),
    )
    parser.add_argument(
        "--stage",
        required=True,
        choices=stage_names(),
        help="The stage to deploy to - k8s/stages/<stage>.toml, which also names its namespace.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually build/push/apply (or sync secrets). Default is dry-run: print the plan and exit.",
    )
    parser.add_argument(
        "--promote",
        action="store_true",
        help="Instead of building HEAD, roll out exactly the release the stage's promote_from stage runs "
        "(its image tags; nothing is built). Refused unless that stage is healthy, its release is on the "
        "checked-out branch and contains what this stage runs, and k8s/ matches the release's manifests.",
    )
    parser.add_argument(
        "--bootstrap",
        action="store_true",
        help="Also apply the stage's supporting resources - ConfigMap, volumes, Postgres, MinIO and its "
        "bucket job before the deployments, network policies and Ingress after them - and create "
        "deployments that don't exist yet. Needed the first time; safe to repeat, e.g. to apply a changed "
        "ConfigMap (api/worker are restarted for it).",
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
        help=f"Instead of a deploy, sync required keys from the env file into the stage's {SECRET_NAME} "
        "Secret. Combine with --apply to actually write it; without it, just shows what would change.",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        default=None,
        help="Source file for --sync-secrets (default: the stage's env_file, e.g. .env.production for prod "
        "and .env.dev for dev, at repo root). Plain KEY=VALUE lines, '#' comments allowed. Must be gitignored.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    try:
        stage = load_stage(args.stage)
        if args.sync_secrets:
            if args.promote or args.bootstrap or args.force:
                raise DeployError("--sync-secrets only syncs the Secret - run --promote/--bootstrap/--force separately")
            return sync_secrets(args, stage)
        return run_deploy(args, stage)
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
