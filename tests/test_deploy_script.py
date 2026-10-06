"""Unit tests for scripts/deploy.py's pure logic (path classification, tag parsing, env-file
parsing, secret validation, and the apply/rollback state machine). Deliberately does not touch
git/docker/kubectl - those are mocked or bypassed by constructing Plan objects directly - so this
suite runs anywhere, including CI, with none of the tools installed.

scripts/ isn't a package (matches tests/ itself having no __init__.py, see CI's
`python -m unittest discover` comment in .github/workflows/ci.yml), so the module is loaded
directly from its file path rather than imported by dotted name.
"""

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "scripts" / "deploy.py"

_spec = importlib.util.spec_from_file_location("deploy_script", SCRIPT_PATH)
deploy = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
# Registering in sys.modules *before* exec_module matters: with `from __future__ import
# annotations`, dataclasses resolves field type annotations by looking the defining module up in
# sys.modules (by __module__ name) - skip this and dataclass field processing crashes with an
# AttributeError on None.
sys.modules["deploy_script"] = deploy
_spec.loader.exec_module(deploy)

TIMEOUTS = {"api": "180s", "worker": "900s", "web": "180s"}


class ClassifyPathTests(unittest.TestCase):
    def test_app_prefix_is_web(self):
        self.assertEqual(deploy.classify_path("app/src/api/client.ts"), "web")

    def test_known_no_rebuild_prefixes_are_none(self):
        for path in (
            "k8s/api.yaml",
            "docs/DEPLOY_GUIDE.md",
            "tests/test_x.py",
            "scripts/deploy.py",
            "src/autogenbook/main.py",
            ".claude/skills/static-analysis/run-sonar-scan.sh",
            "output/book/some-run/manuscript.md",
        ):
            with self.subTest(path=path):
                self.assertEqual(deploy.classify_path(path), "none")

    def test_known_no_rebuild_files_are_none(self):
        for path in ("README.md", "CLAUDE.md", ".gitignore", ".env.example"):
            with self.subTest(path=path):
                self.assertEqual(deploy.classify_path(path), "none")

    def test_everything_else_defaults_to_core(self):
        # A blocklist, not an allowlist: a brand-new top-level file/dir this list has never seen
        # must still be treated as core-relevant by default, since the root Dockerfile's
        # `COPY . .` really does pull in nearly everything.
        for path in ("autogenbook/graph/doc_graph.py", "api/main.py", "prompts/book/leaf.md", "main.py", "requirements.txt", "some_brand_new_top_level_thing.py"):
            with self.subTest(path=path):
                self.assertEqual(deploy.classify_path(path), "core")


class ParseTagTests(unittest.TestCase):
    def test_parses_tag_after_last_colon(self):
        self.assertEqual(deploy.parse_tag("cerit.io/conerzyo/autogenbook:abc1234"), "abc1234")

    def test_registry_with_port_does_not_confuse_it(self):
        self.assertEqual(deploy.parse_tag("cerit.io:5000/conerzyo/autogenbook-web:1.2.3"), "1.2.3")

    def test_missing_tag_raises_clean_deploy_error_not_index_error(self):
        with self.assertRaises(deploy.DeployError):
            deploy.parse_tag("cerit.io/conerzyo/autogenbook")


class DockerignoreSyncTests(unittest.TestCase):
    """Regression guard for a class of bug caught in review: classify_path()'s blocklist had
    silently drifted out of sync with the root .dockerignore - .claude/ and output/ are both
    real, git-tracked, and excluded from the core image's build context, but were missing from
    the blocklist, so a change under either wastefully triggered a full core rebuild. This walks
    every simple (non-glob) .dockerignore entry and asserts classify_path() also treats it as
    core-irrelevant, so a *future* drift trips this test instead of silently wasting a rebuild."""

    def test_simple_dockerignore_entries_are_recognized_as_no_rebuild(self):
        lines = (deploy.REPO_ROOT / ".dockerignore").read_text().splitlines()
        for line in lines:
            entry = line.strip()
            if not entry or entry.startswith("#") or "*" in entry:
                continue  # glob entries (*.pyc) are reviewed by hand instead of reimplemented here
            if entry.startswith("app/"):
                continue  # governed by app/.dockerignore (a separate build context), not this one
            with self.subTest(entry=entry):
                as_file = deploy.classify_path(entry)
                as_dir_child = deploy.classify_path(f"{entry}/some_file.txt")
                self.assertTrue(
                    as_file == "none" or as_dir_child == "none",
                    f".dockerignore excludes {entry!r} from the core image's build context, but "
                    "classify_path() doesn't recognize it as core-irrelevant.",
                )


class SetImageTagTests(unittest.TestCase):
    def test_replaces_tag_leaves_rest_of_file_untouched(self, tmp_path=None):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "api.yaml"
            manifest.write_text(
                "spec:\n"
                "  containers:\n"
                "  - name: api\n"
                "    image: cerit.io/conerzyo/autogenbook:old-tag\n"
                "    # a comment that must survive\n"
            )
            deploy.set_image_tag(manifest, "cerit.io/conerzyo/autogenbook", "new-tag")
            text = manifest.read_text()
            self.assertIn("image: cerit.io/conerzyo/autogenbook:new-tag", text)
            self.assertIn("# a comment that must survive", text)
            self.assertNotIn("old-tag", text)

    def test_raises_if_image_line_not_found(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "web.yaml"
            manifest.write_text("spec:\n  containers:\n  - name: web\n")
            with self.assertRaises(deploy.DeployError):
                deploy.set_image_tag(manifest, "cerit.io/conerzyo/autogenbook-web", "new-tag")

    def test_raises_if_image_line_ambiguous(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "weird.yaml"
            manifest.write_text(
                "image: cerit.io/conerzyo/autogenbook:a\n"
                "image: cerit.io/conerzyo/autogenbook:b\n"
            )
            with self.assertRaises(deploy.DeployError):
                deploy.set_image_tag(manifest, "cerit.io/conerzyo/autogenbook", "new-tag")


class ReadEnvFileTests(unittest.TestCase):
    def test_parses_key_value_lines_and_skips_comments_and_blanks(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env.production"
            path.write_text("# a comment\n\nFOO=bar\nQUOTED=\"baz\"\nSINGLE='qux'\n")
            values = deploy.read_env_file(path)
            self.assertEqual(values, {"FOO": "bar", "QUOTED": "baz", "SINGLE": "qux"})

    def test_missing_file_raises_deploy_error(self):
        with self.assertRaises(deploy.DeployError):
            deploy.read_env_file(Path("/nonexistent/.env.production"))

    def test_malformed_line_raises_deploy_error(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env.production"
            path.write_text("NOT_A_KEY_VALUE_LINE\n")
            with self.assertRaises(deploy.DeployError):
                deploy.read_env_file(path)


class OptionalSecretKeysTests(unittest.TestCase):
    """Per-user LLM key: LLM_KEY_ENCRYPTION_KEY must not make existing env files fail, and a
    sync must never silently remove it from the live Secret."""

    KEY = "LLM_KEY_ENCRYPTION_KEY"

    def _base(self):
        values = {key: "x" for key in deploy.REQUIRED_SECRET_KEYS}
        values["TAVILY_API_KEY"] = ""
        return values

    @staticmethod
    def _live(**kv):
        import base64

        return {k: base64.b64encode(v.encode()).decode() for k, v in kv.items()}

    def test_env_file_without_the_key_still_validates(self):
        deploy.validate_secret_values(self._base())  # must not raise

    def test_absent_everywhere_is_omitted(self):
        to_write, notes = deploy.plan_secret_values(self._base(), None)
        self.assertNotIn(self.KEY, to_write)
        self.assertEqual(notes, {})

    def test_env_value_is_synced(self):
        to_write, _ = deploy.plan_secret_values({**self._base(), self.KEY: "abc"}, self._live(**{self.KEY: "old"}))
        self.assertEqual(to_write[self.KEY], "abc")

    def test_missing_from_env_file_keeps_the_live_value(self):
        for env_value in (None, ""):
            values = self._base()
            if env_value is not None:
                values[self.KEY] = env_value
            to_write, notes = deploy.plan_secret_values(values, self._live(**{self.KEY: "live-secret"}))
            self.assertEqual(to_write[self.KEY], "live-secret")
            self.assertIn("KEPT", notes[self.KEY])

    def test_explicit_drop_removes_it_and_says_so(self):
        to_write, notes = deploy.plan_secret_values(
            self._base(), self._live(**{self.KEY: "live-secret"}), drop=(self.KEY,)
        )
        self.assertNotIn(self.KEY, to_write)
        self.assertEqual(notes[self.KEY], "REMOVED")

    def test_drop_with_env_value_is_an_error(self):
        with self.assertRaises(deploy.DeployError):
            deploy.plan_secret_values({**self._base(), self.KEY: "abc"}, None, drop=(self.KEY,))


class DropOptionalSecretTests(unittest.TestCase):
    def test_flag_without_sync_secrets_is_rejected(self):
        import contextlib
        import io

        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = deploy.main(["--stage", "dev", "--drop-optional-secret", "LLM_KEY_ENCRYPTION_KEY"])
        self.assertEqual(code, 1)
        self.assertIn("--sync-secrets", err.getvalue())

    def test_dropped_key_still_in_the_live_secret_is_reported(self):
        live = {"LLM_KEY_ENCRYPTION_KEY": "eA==", "AUTH_JWT_SECRET": "eA=="}
        self.assertEqual(
            deploy.dropped_keys_still_present(live, ("LLM_KEY_ENCRYPTION_KEY",)), ["LLM_KEY_ENCRYPTION_KEY"]
        )
        self.assertEqual(deploy.dropped_keys_still_present({"AUTH_JWT_SECRET": "eA=="}, ("LLM_KEY_ENCRYPTION_KEY",)), [])
        self.assertEqual(deploy.dropped_keys_still_present(None, ("LLM_KEY_ENCRYPTION_KEY",)), [])

    def test_key_column_fits_the_longest_secret_name(self):
        longest = max(len(k) for k in deploy.REQUIRED_SECRET_KEYS + deploy.OPTIONAL_SECRET_KEYS)
        self.assertGreater(deploy.KEY_COL_WIDTH, longest)


class ValidateSecretValuesTests(unittest.TestCase):
    def _complete_values(self, **overrides):
        values = {key: "x" for key in deploy.REQUIRED_SECRET_KEYS}
        values["TAVILY_API_KEY"] = ""  # allowed to be blank
        values.update(overrides)
        return values

    def test_complete_values_pass(self):
        deploy.validate_secret_values(self._complete_values())  # must not raise

    def test_missing_key_raises(self):
        values = self._complete_values()
        del values["AUTH_JWT_SECRET"]
        with self.assertRaises(deploy.DeployError):
            deploy.validate_secret_values(values)

    def test_empty_required_key_raises(self):
        values = self._complete_values(POSTGRES_PASSWORD="")
        with self.assertRaises(deploy.DeployError):
            deploy.validate_secret_values(values)

    def test_empty_tavily_key_is_allowed(self):
        deploy.validate_secret_values(self._complete_values(TAVILY_API_KEY=""))  # must not raise


def _fake_plan(tmp_dir: Path, *, api_manifest: Path, worker_manifest: Path, web_manifest: Path) -> "deploy.Plan":
    def dplan(name, manifest, image_key, needs_build):
        return deploy.DeploymentPlan(
            name=name,
            manifest=manifest,
            image_key=image_key,
            current_tag="oldtag",
            needs_build=needs_build,
            needs_apply=needs_build,
            reason="test",
        )

    return deploy.Plan(
        head_full="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        head_short="deadbee",
        deployments={
            "api": dplan("api", api_manifest, "core", True),
            "worker": dplan("worker", worker_manifest, "core", True),
            "web": dplan("web", web_manifest, "web", True),
        },
        images_to_build={"core", "web"},
        notes=[],
    )


class ManifestAtRefTests(unittest.TestCase):
    """_manifest_at_ref is the rollback baseline: it must return the manifest's exact
    git-committed content at a resolvable ref, and None (triggering the caller's disk-bytes
    fallback) for one that isn't - never raise, and never confuse "not found" with "empty"."""

    def test_returns_historical_content_for_a_resolvable_ref(self):
        manifest = deploy.REPO_ROOT / "k8s" / "api.yaml"
        expected = subprocess.run(
            ["git", "-C", str(deploy.REPO_ROOT), "show", "HEAD:k8s/api.yaml"],
            stdout=subprocess.PIPE,
            check=True,
        ).stdout
        self.assertEqual(deploy._manifest_at_ref("HEAD", manifest), expected)

    def test_returns_none_for_an_unresolvable_ref(self):
        manifest = deploy.REPO_ROOT / "k8s" / "api.yaml"
        self.assertIsNone(deploy._manifest_at_ref("not-a-real-commit-or-tag", manifest))


class GitDirtyOutsideK8sTests(unittest.TestCase):
    """git_dirty_outside_k8s() deliberately excludes k8s/ - see its docstring for why (a
    successful --apply rewrites a manifest's tag without committing it, and that must not block
    the next run's dirty-tree gate)."""

    def test_only_k8s_dirty_is_not_dirty_outside_k8s(self):
        with patch.object(deploy, "git_dirty_paths", return_value=["k8s/api.yaml", "k8s/web.yaml"]):
            self.assertFalse(deploy.git_dirty_outside_k8s())

    def test_any_non_k8s_path_is_dirty_outside_k8s(self):
        with patch.object(deploy, "git_dirty_paths", return_value=["k8s/api.yaml", "autogenbook/main.py"]):
            self.assertTrue(deploy.git_dirty_outside_k8s())

    def test_clean_tree_is_not_dirty(self):
        with patch.object(deploy, "git_dirty_paths", return_value=[]):
            self.assertFalse(deploy.git_dirty_outside_k8s())


class ApplyPhaseRollbackTests(unittest.TestCase):
    """Exercises the rollback state machine without touching git/docker/kubectl: kubectl calls
    are faked via a patched subprocess.run that fails only for the deployment we choose, and
    manifests are throwaway temp files so we can assert their bytes are restored exactly."""

    def _make_manifests(self, tmp: Path):
        manifests = {}
        for name, repo in (("api", "autogenbook"), ("worker", "autogenbook"), ("web", "autogenbook-web")):
            path = tmp / f"{name}.yaml"
            path.write_text(f"image: cerit.io/conerzyo/{repo}:oldtag\n# keep-me\n")
            manifests[name] = path
        return manifests

    def test_failure_on_second_deployment_rolls_back_the_first_too(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            manifests = self._make_manifests(tmp)
            original_bytes = {name: path.read_bytes() for name, path in manifests.items()}
            plan = _fake_plan(tmp, api_manifest=manifests["api"], worker_manifest=manifests["worker"], web_manifest=manifests["web"])

            # api succeeds, worker fails, web is never reached.
            def fake_apply_and_wait(name, manifest, namespace, timeout):
                if name == "worker":
                    raise subprocess.CalledProcessError(1, ["kubectl", "rollout", "status"])
                # Simulate a successful `kubectl apply` having no other side effect we need here.

            with patch.object(deploy, "_apply_and_wait", side_effect=fake_apply_and_wait):
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", TIMEOUTS, no_rollback=False)

            self.assertEqual(exit_code, 1)
            # api's manifest had its tag rewritten to head_short by apply_phase, then must have
            # been restored to its exact original bytes by the rollback.
            self.assertEqual(manifests["api"].read_bytes(), original_bytes["api"])
            self.assertEqual(manifests["worker"].read_bytes(), original_bytes["worker"])
            # web was never touched (the loop broke at worker) - still untouched original.
            self.assertEqual(manifests["web"].read_bytes(), original_bytes["web"])

    def test_set_image_tag_failure_also_triggers_rollback_of_prior_deployments(self):
        # Regression test: set_image_tag() used to run outside apply_phase's try/except, so a
        # DeployError from it (e.g. the manifest's image line unexpectedly missing) would
        # propagate straight out of apply_phase without rolling back a deployment already
        # successfully applied earlier in the same run.
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            manifests = self._make_manifests(tmp)
            original_bytes = {name: path.read_bytes() for name, path in manifests.items()}
            plan = _fake_plan(tmp, api_manifest=manifests["api"], worker_manifest=manifests["worker"], web_manifest=manifests["web"])

            real_set_image_tag = deploy.set_image_tag

            def fake_set_image_tag(manifest, image_ref_prefix, new_tag):
                if manifest == manifests["worker"]:
                    raise deploy.DeployError("simulated: image line not found")
                real_set_image_tag(manifest, image_ref_prefix, new_tag)

            with patch.object(deploy, "set_image_tag", side_effect=fake_set_image_tag), patch.object(
                deploy, "_apply_and_wait", return_value=None
            ):
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", TIMEOUTS, no_rollback=False)

            self.assertEqual(exit_code, 1)
            self.assertEqual(manifests["api"].read_bytes(), original_bytes["api"])
            self.assertEqual(manifests["worker"].read_bytes(), original_bytes["worker"])
            self.assertEqual(manifests["web"].read_bytes(), original_bytes["web"])

    def test_no_rollback_flag_leaves_failure_in_place(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            manifests = self._make_manifests(tmp)
            plan = _fake_plan(tmp, api_manifest=manifests["api"], worker_manifest=manifests["worker"], web_manifest=manifests["web"])

            def fake_apply_and_wait(name, manifest, namespace, timeout):
                if name == "worker":
                    raise subprocess.CalledProcessError(1, ["kubectl", "rollout", "status"])

            with patch.object(deploy, "_apply_and_wait", side_effect=fake_apply_and_wait):
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", TIMEOUTS, no_rollback=True)

            self.assertEqual(exit_code, 1)
            # api's manifest was rewritten to the new tag and NOT rolled back.
            self.assertIn(b"deadbee", manifests["api"].read_bytes())

    def test_all_succeed_returns_zero_and_rewrites_tags(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            manifests = self._make_manifests(tmp)
            plan = _fake_plan(tmp, api_manifest=manifests["api"], worker_manifest=manifests["worker"], web_manifest=manifests["web"])

            with patch.object(deploy, "_apply_and_wait", return_value=None):
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", TIMEOUTS, no_rollback=False)

            self.assertEqual(exit_code, 0)
            for name in ("api", "worker", "web"):
                self.assertIn(b"deadbee", manifests[name].read_bytes())
                self.assertIn(b"keep-me", manifests[name].read_bytes())

    def test_rollback_uses_manifest_at_ref_baseline_not_raw_disk_bytes(self):
        # Regression test for a bug caught in review: the rollback baseline used to be whatever
        # bytes were on disk right before this run's own mutation - which, for a manifest whose
        # content HEAD's commit already changed beyond just the tag (e.g. a bad resource limit
        # bundled in the same commit), is already the new, broken content. Simulate exactly that:
        # the on-disk manifest is "corrupted" relative to what _manifest_at_ref (mocked here,
        # exercised for real in ManifestAtRefTests) says was actually last deployed.
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            api_manifest = tmp / "api.yaml"
            api_manifest.write_text("image: cerit.io/conerzyo/autogenbook:oldtag\n# corrupted-by-this-run\n")
            worker_manifest = tmp / "worker.yaml"
            worker_manifest.write_text("image: cerit.io/conerzyo/autogenbook:oldtag\n")
            web_manifest = tmp / "web.yaml"
            web_manifest.write_text("image: cerit.io/conerzyo/autogenbook-web:oldtag\n")

            plan = deploy.Plan(
                head_full="f" * 40,
                head_short="fffffff",
                deployments={
                    "api": deploy.DeploymentPlan("api", api_manifest, "core", "sometag", False, True, "test"),
                    "worker": deploy.DeploymentPlan("worker", worker_manifest, "core", "sometag", False, False, "test"),
                    "web": deploy.DeploymentPlan("web", web_manifest, "web", "sometag", False, False, "test"),
                },
                images_to_build=set(),
                notes=[],
            )

            historical_content = b"image: cerit.io/conerzyo/autogenbook:oldtag\n# this is what was actually last deployed\n"

            def fake_apply_and_wait(name, manifest_path, namespace, timeout):
                raise subprocess.CalledProcessError(1, ["kubectl", "rollout", "status"])

            with patch.object(deploy, "_manifest_at_ref", return_value=historical_content), patch.object(
                deploy, "_apply_and_wait", side_effect=fake_apply_and_wait
            ):
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", TIMEOUTS, no_rollback=False)

            self.assertEqual(exit_code, 1)
            # Historical non-tag content restored, image line pinned to the live tag ("sometag").
            self.assertEqual(
                api_manifest.read_bytes(),
                b"image: cerit.io/conerzyo/autogenbook:sometag\n# this is what was actually last deployed\n",
            )

    def test_rollback_pins_image_to_live_tag_not_the_committed_one(self):
        # Regression test for the incident that motivated the hardening: the committed manifest
        # at the live tag's commit still names the tag of the deploy *before* it (the tag only
        # lands in the follow-up "Deploy <tag>" commit), so restoring its bytes verbatim rolled
        # the cluster back two deploys, onto an image two Alembic migrations behind the database.
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            manifests = self._make_manifests(tmp)
            plan = _fake_plan(tmp, api_manifest=manifests["api"], worker_manifest=manifests["worker"], web_manifest=manifests["web"])
            committed_at_live_tag = b"image: cerit.io/conerzyo/autogenbook:twodeploysago\n# committed-comment\n"

            def fake_apply_and_wait(name, manifest, namespace, timeout):
                if name == "worker":
                    raise deploy.RolloutBroken("simulated crash loop")

            with patch.object(deploy, "_manifest_at_ref", return_value=committed_at_live_tag), patch.object(
                deploy, "_apply_and_wait", side_effect=fake_apply_and_wait
            ):
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", TIMEOUTS, no_rollback=False)

            self.assertEqual(exit_code, 1)
            self.assertEqual(manifests["api"].read_bytes(), b"image: cerit.io/conerzyo/autogenbook:oldtag\n# committed-comment\n")
            self.assertNotIn(b"twodeploysago", manifests["api"].read_bytes())

    def test_rollback_uses_the_rolled_back_deployments_own_timeout(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            manifests = self._make_manifests(tmp)
            plan = _fake_plan(tmp, api_manifest=manifests["api"], worker_manifest=manifests["worker"], web_manifest=manifests["web"])
            seen: list[tuple[str, str]] = []

            def fake_apply_and_wait(name, manifest, namespace, timeout):
                seen.append((name, timeout))
                if name == "web" and len(seen) == 3:
                    raise deploy.RolloutBroken("simulated")

            with patch.object(deploy, "_apply_and_wait", side_effect=fake_apply_and_wait):
                deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", TIMEOUTS, no_rollback=False)

            self.assertEqual(
                seen,
                [("api", "180s"), ("worker", "900s"), ("web", "180s"), ("api", "180s"), ("worker", "900s"), ("web", "180s")],
            )


class MigrationLockTests(unittest.TestCase):
    """Once a deploy that changes Alembic migrations has applied api, the database is at HEAD's
    revision and an older core image can only crash-loop on `alembic upgrade head` - so api and
    worker must stay on the new image while anything else touched still rolls back."""

    def _manifests(self, tmp: Path):
        manifests = {}
        for name, repo in (("api", "autogenbook"), ("worker", "autogenbook"), ("web", "autogenbook-web")):
            path = tmp / f"{name}.yaml"
            path.write_text(f"image: cerit.io/conerzyo/{repo}:oldtag\n")
            manifests[name] = path
        return manifests

    def test_core_stays_on_new_image_after_api_applied(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            manifests = self._manifests(tmp)
            plan = _fake_plan(tmp, api_manifest=manifests["api"], worker_manifest=manifests["worker"], web_manifest=manifests["web"])
            plan.migrations_changed = ["api/infrastructure/db/alembic/versions/0019_outline_source_scope.py"]
            rolled_back: list[str] = []

            def fake_apply_and_wait(name, manifest, namespace, timeout):
                if name == "web" and b"deadbee" in manifest.read_bytes():
                    raise deploy.RolloutBroken("simulated: web image unpullable")
                if b"oldtag" in manifest.read_bytes():
                    rolled_back.append(name)

            with patch.object(deploy, "_apply_and_wait", side_effect=fake_apply_and_wait):
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", TIMEOUTS, no_rollback=False)

            self.assertEqual(exit_code, 1)
            self.assertIn(b"deadbee", manifests["api"].read_bytes())
            self.assertIn(b"deadbee", manifests["worker"].read_bytes())
            self.assertIn(b"oldtag", manifests["web"].read_bytes())
            self.assertEqual(rolled_back, ["web"])

    def test_core_rolls_back_when_api_was_never_applied(self):
        # The lock is about the migration having *run*, which needs api to have been applied at
        # all - a failure before that (e.g. the manifest's image line missing) must still restore
        # api's manifest like any other failure.
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            manifests = self._manifests(tmp)
            plan = _fake_plan(tmp, api_manifest=manifests["api"], worker_manifest=manifests["worker"], web_manifest=manifests["web"])
            plan.migrations_changed = ["api/infrastructure/db/alembic/versions/0019_outline_source_scope.py"]

            with patch.object(deploy, "set_image_tag", side_effect=deploy.DeployError("simulated")), patch.object(
                deploy, "_apply_and_wait", return_value=None
            ):
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", TIMEOUTS, no_rollback=False)

            self.assertEqual(exit_code, 1)
            self.assertIn(b"oldtag", manifests["api"].read_bytes())

    def test_no_migrations_means_core_rolls_back_as_before(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            manifests = self._manifests(tmp)
            plan = _fake_plan(tmp, api_manifest=manifests["api"], worker_manifest=manifests["worker"], web_manifest=manifests["web"])

            def fake_apply_and_wait(name, manifest, namespace, timeout):
                if name == "worker" and b"deadbee" in manifest.read_bytes():
                    raise deploy.RolloutBroken("simulated")

            with patch.object(deploy, "_apply_and_wait", side_effect=fake_apply_and_wait):
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", TIMEOUTS, no_rollback=False)

            self.assertEqual(exit_code, 1)
            self.assertIn(b"oldtag", manifests["api"].read_bytes())
            self.assertIn(b"oldtag", manifests["worker"].read_bytes())


class SlowRolloutTests(unittest.TestCase):
    """A timeout with healthy pods is not a failure: nothing is rolled back and the operator is
    told to wait and re-run. (The worker's five one-at-a-time replicas were what tripped the old
    180s timeout and triggered the rollback in the real incident.)"""

    def test_slow_rollout_is_left_in_place(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            manifests = {}
            for name, repo in (("api", "autogenbook"), ("worker", "autogenbook"), ("web", "autogenbook-web")):
                manifests[name] = tmp / f"{name}.yaml"
                manifests[name].write_text(f"image: cerit.io/conerzyo/{repo}:oldtag\n")
            plan = _fake_plan(tmp, api_manifest=manifests["api"], worker_manifest=manifests["worker"], web_manifest=manifests["web"])
            calls: list[str] = []

            def fake_apply_and_wait(name, manifest, namespace, timeout):
                calls.append(name)
                if name == "worker":
                    raise deploy.RolloutSlow("simulated: healthy but slow")

            with patch.object(deploy, "_apply_and_wait", side_effect=fake_apply_and_wait):
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", TIMEOUTS, no_rollback=False)

            self.assertEqual(exit_code, 1)
            self.assertEqual(calls, ["api", "worker"])  # no rollback applies, web never reached
            self.assertIn(b"deadbee", manifests["api"].read_bytes())
            self.assertIn(b"deadbee", manifests["worker"].read_bytes())
            self.assertIn(b"oldtag", manifests["web"].read_bytes())


class ParseDurationTests(unittest.TestCase):
    def test_kubectl_style_durations(self):
        self.assertEqual(deploy.parse_duration("180s"), 180)
        self.assertEqual(deploy.parse_duration("15m"), 900)
        self.assertEqual(deploy.parse_duration("1h30m"), 5400)
        self.assertEqual(deploy.parse_duration("1h2m3s"), 3723)
        self.assertEqual(deploy.parse_duration("900"), 900)

    def test_invalid_durations_raise_deploy_error(self):
        for bad in ("", "abc", "5x", "1.5m", "-5s"):
            with self.subTest(bad=bad), self.assertRaises(deploy.DeployError):
                deploy.parse_duration(bad)


class BrokenPodsTests(unittest.TestCase):
    def _pod(self, name, *, waiting=None, restarts=0, phase="Running"):
        container = {"name": "c", "restartCount": restarts, "state": {}}
        if waiting:
            container["state"] = {"waiting": {"reason": waiting, "message": "boom"}}
        return {"metadata": {"name": name}, "status": {"phase": phase, "containerStatuses": [container]}}

    def test_healthy_or_still_starting_pods_are_not_broken(self):
        pods = [
            self._pod("a"),
            self._pod("b", waiting="ContainerCreating"),
            self._pod("c", waiting="PodInitializing"),
            self._pod("d", restarts=1),  # one restart tolerated (transient DB connection on boot)
        ]
        self.assertEqual(deploy._broken_pods(pods), [])

    def test_crash_loop_image_pull_and_repeated_restarts_are_broken(self):
        reasons = deploy._broken_pods(
            [
                self._pod("a", waiting="CrashLoopBackOff"),
                self._pod("b", waiting="ImagePullBackOff"),
                self._pod("c", restarts=2),
                self._pod("d", phase="Failed"),
            ]
        )
        self.assertEqual(len(reasons), 4)
        self.assertTrue(any("CrashLoopBackOff" in r for r in reasons))
        self.assertTrue(any("ImagePullBackOff" in r for r in reasons))
        self.assertTrue(any("restarted 2 times" in r for r in reasons))
        self.assertTrue(any("phase Failed" in r for r in reasons))


class WaitForRolloutTests(unittest.TestCase):
    """_wait_for_rollout with kubectl and the clock faked: it must return on success, raise
    RolloutBroken as soon as a poll sees failing pods, raise RolloutSlow only once the whole
    timeout has elapsed with healthy pods, and re-raise other kubectl errors untouched."""

    def _fake_clock(self, step=30):
        state = {"now": 0.0}

        def monotonic():
            state["now"] += step
            return state["now"]

        return monotonic

    def _run_result(self, returncode, stdout):
        return subprocess.CompletedProcess(args=["kubectl"], returncode=returncode, stdout=stdout, stderr="")

    def test_returns_on_success_after_a_timed_out_poll(self):
        results = iter(
            [
                self._run_result(1, "Waiting...\nerror: timed out waiting for the condition\n"),
                self._run_result(0, 'deployment "api" successfully rolled out\n'),
            ]
        )
        with patch.object(deploy.subprocess, "run", side_effect=lambda *a, **k: next(results)), patch.object(
            deploy, "_deployment_new_pods", return_value=[]
        ), patch.object(deploy.time, "monotonic", side_effect=self._fake_clock(1)):
            deploy._wait_for_rollout("api", "ns", "180s")  # no exception

    def test_broken_pods_fail_fast(self):
        timed_out = self._run_result(1, "error: timed out waiting for the condition\n")
        crash = {"metadata": {"name": "api-x"}, "status": {"containerStatuses": [{"name": "api", "restartCount": 3, "state": {"waiting": {"reason": "CrashLoopBackOff"}}}]}}
        with patch.object(deploy.subprocess, "run", return_value=timed_out) as run, patch.object(
            deploy, "_deployment_new_pods", return_value=[crash]
        ), patch.object(deploy.time, "monotonic", side_effect=self._fake_clock(1)):
            with self.assertRaises(deploy.RolloutBroken) as ctx:
                deploy._wait_for_rollout("api", "ns", "900s")
        self.assertIn("CrashLoopBackOff", str(ctx.exception))
        self.assertEqual(run.call_count, 1)

    def test_healthy_timeout_is_slow_not_broken(self):
        timed_out = self._run_result(1, "error: timed out waiting for the condition\n")
        with patch.object(deploy.subprocess, "run", return_value=timed_out) as run, patch.object(
            deploy, "_deployment_new_pods", return_value=[]
        ), patch.object(deploy.time, "monotonic", side_effect=self._fake_clock(30)):
            with self.assertRaises(deploy.RolloutSlow):
                deploy._wait_for_rollout("worker", "ns", "90s")
        self.assertGreaterEqual(run.call_count, 2)
        # Every poll asked kubectl for at most the poll interval, never the whole timeout.
        for call in run.call_args_list:
            self.assertIn("--timeout=30s", call.args[0])

    def test_other_kubectl_errors_propagate(self):
        err = self._run_result(1, 'Error from server (NotFound): deployments.apps "api" not found\n')
        with patch.object(deploy.subprocess, "run", return_value=err), patch.object(
            deploy.time, "monotonic", side_effect=self._fake_clock(1)
        ):
            with self.assertRaises(subprocess.CalledProcessError):
                deploy._wait_for_rollout("api", "ns", "180s")


class RolloutTimeoutsFromArgsTests(unittest.TestCase):
    def test_defaults_give_worker_its_own_longer_timeout(self):
        args = deploy.build_arg_parser().parse_args(["--stage", "prod"])
        self.assertEqual(
            deploy.rollout_timeouts_from_args(args),
            {"api": deploy.ROLLOUT_TIMEOUT_DEFAULT, "worker": deploy.WORKER_ROLLOUT_TIMEOUT_DEFAULT, "web": deploy.ROLLOUT_TIMEOUT_DEFAULT},
        )

    def test_invalid_duration_is_rejected_before_anything_runs(self):
        args = deploy.build_arg_parser().parse_args(["--stage", "prod", "--worker-rollout-timeout", "soon"])
        with self.assertRaises(deploy.DeployError):
            deploy.rollout_timeouts_from_args(args)


# --------------------------------------------------------------------------------------
# Stages (k8s/stages/*.toml): loading, rendering, promotion, --bootstrap
# --------------------------------------------------------------------------------------


def _stage(name="dev", **overrides):
    fields = {
        "name": name,
        "path": deploy.STAGES_DIR / f"{name}.toml",
        "namespace": f"ns-{name}",
        "host": f"{name}.example.org",
        "env_file": f".env.{name}",
    }
    fields.update(overrides)
    return deploy.Stage(**fields)


class RepoStageFilesTests(unittest.TestCase):
    """The stage files actually committed in k8s/stages/."""

    def test_every_stage_file_loads_and_renders_every_manifest(self):
        names = deploy.stage_names()
        self.assertIn("prod", names)
        self.assertIn("dev", names)
        for name in names:
            with self.subTest(stage=name):
                deploy.check_rendering(deploy.load_stage(name))

    def test_exactly_one_base_stage_and_it_is_prod(self):
        bases = [name for name in deploy.stage_names() if deploy.load_stage(name).base]
        self.assertEqual(bases, ["prod"])

    def test_base_stage_renders_every_k8s_manifest_unchanged(self):
        # The guarantee that introducing stages changed nothing about what prod runs: every
        # manifest a run can apply to prod is byte-for-byte the k8s/ file.
        prod = deploy.load_stage("prod")
        for path in sorted(deploy.K8S_DIR.glob("*.yaml")):
            with self.subTest(manifest=path.name):
                self.assertEqual(deploy.rendered(prod, path.stem), path.read_text())

    def test_prod_is_promoted_from_dev_and_dev_differs_where_it_must(self):
        prod, dev = deploy.load_stage("prod"), deploy.load_stage("dev")
        self.assertEqual(prod.promote_from, "dev")
        self.assertIsNone(dev.promote_from)
        self.assertNotEqual(dev.namespace, prod.namespace)
        self.assertNotEqual(dev.host, prod.host)
        self.assertNotEqual(dev.env_file, prod.env_file)
        ingress = deploy.rendered(dev, "ingress")
        self.assertNotIn(prod.host, ingress)
        self.assertIn(deploy.tls_secret_name(dev.host), ingress)

    def test_stage_env_files_are_gitignored(self):
        for name in deploy.stage_names():
            with self.subTest(stage=name):
                deploy.ensure_ignored(deploy.REPO_ROOT / deploy.load_stage(name).env_file)  # must not raise


class LoadStageTests(unittest.TestCase):
    VALID = 'namespace = "ns"\nhost = "a.example.org"\nenv_file = ".env.x"\n'

    def _load(self, text, name="x", others=("other",)):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            stages_dir = Path(tmp)
            (stages_dir / f"{name}.toml").write_text(text)
            for other in others:
                (stages_dir / f"{other}.toml").write_text(self.VALID)
            return deploy.load_stage(name, stages_dir)

    def test_minimal_stage(self):
        stage = self._load(self.VALID)
        self.assertEqual((stage.namespace, stage.host, stage.env_file), ("ns", "a.example.org", ".env.x"))
        self.assertFalse(stage.base)
        self.assertEqual((stage.replicas, stage.config, stage.promote_from), ({}, {}, None))

    def test_full_stage(self):
        stage = self._load(self.VALID + 'promote_from = "other"\n[replicas]\nworker = 0\n[config]\nFOO = "1"\n')
        self.assertEqual(stage.promote_from, "other")
        self.assertEqual(stage.replicas, {"worker": 0})
        self.assertEqual(stage.config, {"FOO": "1"})

    def test_invalid_stages_are_rejected_with_a_deploy_error(self):
        cases = {
            "unknown stage": None,
            "missing namespace": 'host = "a.example.org"\nenv_file = ".env.x"\n',
            "typo'd key": self.VALID + 'replica = 1\n',
            "not a TOML file": self.VALID + "[[[",
            "host with upper case": self.VALID.replace("a.example.org", "A.example.org"),
            "replicas of an unknown deployment": self.VALID + "[replicas]\ndb = 2\n",
            "negative replicas": self.VALID + "[replicas]\nworker = -1\n",
            "boolean replicas": self.VALID + "[replicas]\nworker = true\n",
            "unquoted config value": self.VALID + "[config]\nFOO = 1\n",
            "config key that isn't an env var name": self.VALID + '[config]\n"FOO BAR" = "1"\n',
            "base stage with replicas": self.VALID + "base = true\n[replicas]\nworker = 2\n",
            "promote from itself": self.VALID + 'promote_from = "x"\n',
            "promote from an unknown stage": self.VALID + 'promote_from = "nope"\n',
        }
        for label, text in cases.items():
            with self.subTest(label), self.assertRaises(deploy.DeployError):
                if text is None:
                    deploy.load_stage("nope", deploy.STAGES_DIR)
                else:
                    self._load(text)


class RenderManifestTests(unittest.TestCase):
    CONFIGMAP = (
        "apiVersion: v1\n"
        "kind: ConfigMap\n"
        "metadata:\n"
        "  name: autogenbook-config\n"
        "data:\n"
        '  A: "1"\n'
        "  B: plain  # comment\n"
        "  C: 'it''s'\n"
    )

    def test_configmap_data_reads_every_scalar_style(self):
        self.assertEqual(deploy.configmap_data(self.CONFIGMAP, "t"), {"A": "1", "B": "plain", "C": "it's"})

    def test_config_overrides_replace_and_append_inside_data_only(self):
        stage = _stage(config={"A": "new", "name": "not-metadata", "D": 'quo"te'})
        text = deploy.render_manifest(stage, "configmap", self.CONFIGMAP, where="t")
        self.assertIn("  name: autogenbook-config\n", text)  # metadata.name untouched
        self.assertEqual(
            deploy.configmap_data(text, "t"),
            {"A": "new", "B": "plain", "C": "it's", "name": "not-metadata", "D": 'quo"te'},
        )

    def test_real_configmap_round_trips_through_rendering(self):
        stage = _stage(config={"CLI_ENTRYPOINT": "run_engine.py", "WORKER_CONCURRENCY": "2"})
        base = (deploy.K8S_DIR / "configmap.yaml").read_text()
        text = deploy.render_manifest(stage, "configmap", base, where="t")
        self.assertEqual(deploy.configmap_data(text, "t"), {**deploy.configmap_data(base, "t"), **stage.config})
        self.assertEqual(deploy.stage_config(stage), deploy.configmap_data(text, "t"))

    def test_no_data_block_is_a_deploy_error(self):
        with self.assertRaises(deploy.DeployError):
            deploy.render_manifest(_stage(config={"A": "1"}), "configmap", "kind: ConfigMap\n", where="t")

    def test_replicas_override_changes_only_the_replicas_line(self):
        base = (deploy.K8S_DIR / "worker.yaml").read_text()
        text = deploy.render_manifest(_stage(replicas={"worker": 2}), "worker", base, where="t")
        changed = [(a, b) for a, b in zip(base.splitlines(), text.splitlines()) if a != b]
        self.assertEqual(changed, [("  replicas: 5", "  replicas: 2")])
        # Deployments without an override, and non-Deployments, are left alone.
        self.assertEqual(deploy.render_manifest(_stage(replicas={"worker": 2}), "api", "replicas: 1\n", where="t"), "replicas: 1\n")

    def test_replicas_override_without_a_replicas_line_is_a_deploy_error(self):
        with self.assertRaises(deploy.DeployError):
            deploy.render_manifest(_stage(replicas={"worker": 2}), "worker", "kind: Deployment\n", where="t")

    def test_ingress_gets_the_stage_host_and_its_own_tls_secret(self):
        base = (deploy.K8S_DIR / "ingress.yaml").read_text()
        text = deploy.render_manifest(_stage(host="x-dev.example.org"), "ingress", base, where="t")
        self.assertEqual(text.count("x-dev.example.org"), 2)  # tls hosts + rule host
        self.assertIn("secretName: x-dev-example-org-tls\n", text)
        self.assertIn("# Safe to `kubectl apply`", text)  # comments survive

    def test_ingress_without_exactly_one_host_is_a_deploy_error(self):
        with self.assertRaises(deploy.DeployError):
            deploy.render_manifest(_stage(), "ingress", "kind: Ingress\n", where="t")

    def test_without_image_tags_ignores_only_the_tag(self):
        a = "image: cerit.io/conerzyo/autogenbook:abc\nreplicas: 1\n"
        self.assertEqual(deploy.without_image_tags(a), deploy.without_image_tags(a.replace("abc", "def")))
        self.assertNotEqual(deploy.without_image_tags(a), deploy.without_image_tags(a.replace("1", "2")))
        self.assertNotEqual(deploy.without_image_tags(a), deploy.without_image_tags(a.replace("autogenbook:", "other:")))


class RenderDeploymentsTests(unittest.TestCase):
    def test_renders_temp_copies_pinned_to_the_live_tag_and_leaves_k8s_alone(self):
        import tempfile

        before = {name: spec.manifest.read_bytes() for name, spec in deploy.DEPLOYMENTS.items()}
        plan = deploy.Plan(
            head_full="h" * 40,
            head_short="hhhhhhh",
            deployments={
                name: deploy.DeploymentPlan(name, spec.manifest, spec.image_key, "live" + name, False, False, "t")
                for name, spec in deploy.DEPLOYMENTS.items()
            },
            images_to_build=set(),
            notes=[],
            in_place=False,
        )
        plan.deployments["web"].current_tag = ""  # not deployed yet: keeps the manifest's tag
        with tempfile.TemporaryDirectory() as tmp:
            deploy.render_deployments(plan, _stage(replicas={"worker": 2}), "cerit.io/conerzyo", Path(tmp))
            for name, d in plan.deployments.items():
                self.assertEqual(d.source, deploy.DEPLOYMENTS[name].manifest)
                self.assertEqual(d.manifest.parent, Path(tmp))
            self.assertIn("image: cerit.io/conerzyo/autogenbook:liveapi\n", plan.deployments["api"].manifest.read_text())
            worker = plan.deployments["worker"].manifest.read_text()
            self.assertIn("image: cerit.io/conerzyo/autogenbook:liveworker\n", worker)
            self.assertIn("  replicas: 2\n", worker)
            self.assertEqual(plan.deployments["web"].manifest.read_text(), before["web"].decode())
        self.assertEqual({name: spec.manifest.read_bytes() for name, spec in deploy.DEPLOYMENTS.items()}, before)


class StagedApplyPhaseTests(unittest.TestCase):
    """apply_phase() for promotions (a given tag, no build), non-base stages (no commit hint,
    rendered rollback baseline) and Deployments --bootstrap creates (nothing to roll back to)."""

    def _manifests(self, tmp: Path):
        manifests = {}
        for name, repo in (("api", "autogenbook"), ("worker", "autogenbook"), ("web", "autogenbook-web")):
            manifests[name] = tmp / f"{name}.yaml"
            manifests[name].write_text(f"replicas: 5\nimage: cerit.io/conerzyo/{repo}:oldtag\n")
        return manifests

    def _plan(self, manifests, *, new_tags, current="oldtag", **plan_fields):
        return deploy.Plan(
            head_full="h" * 40,
            head_short="hhhhhhh",
            deployments={
                name: deploy.DeploymentPlan(
                    name, manifests[name], "web" if name == "web" else "core", current, False, True, "t", new_tag=new_tags[name]
                )
                for name in deploy.DEPLOYMENT_ORDER
            },
            images_to_build=set(),
            notes=[],
            **plan_fields,
        )

    def test_promotion_retags_to_the_promoted_tags_and_hints_its_commit(self):
        import io
        import tempfile
        from contextlib import redirect_stdout

        with tempfile.TemporaryDirectory() as tmp_str:
            manifests = self._manifests(Path(tmp_str))
            plan = self._plan(manifests, new_tags={"api": "core111", "worker": "core111", "web": "web2222"}, commit_message="Promote dev release r to prod")
            out = io.StringIO()
            with patch.object(deploy, "_apply_and_wait", return_value=None), redirect_stdout(out):
                self.assertEqual(deploy.apply_phase(plan, "cerit.io/conerzyo", "ns", TIMEOUTS, no_rollback=False), 0)
            self.assertIn(b"autogenbook:core111", manifests["worker"].read_bytes())
            self.assertIn(b"autogenbook-web:web2222", manifests["web"].read_bytes())
            self.assertIn("git commit -m 'Promote dev release r to prod'", out.getvalue())

    def test_non_base_stage_has_nothing_to_commit(self):
        import io
        import tempfile
        from contextlib import redirect_stdout

        with tempfile.TemporaryDirectory() as tmp_str:
            manifests = self._manifests(Path(tmp_str))
            plan = self._plan(manifests, new_tags={"api": "n", "worker": "n", "web": "n"}, in_place=False)
            out = io.StringIO()
            with patch.object(deploy, "_apply_and_wait", return_value=None), redirect_stdout(out):
                self.assertEqual(deploy.apply_phase(plan, "cerit.io/conerzyo", "ns", TIMEOUTS, no_rollback=False), 0)
            self.assertNotIn("git commit", out.getvalue())

    def test_rollback_restores_the_rendered_baseline(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            manifests = self._manifests(Path(tmp_str))
            plan = self._plan(manifests, new_tags={"api": "n", "worker": "n", "web": "n"}, in_place=False)
            for d in plan.deployments.values():
                d.source = deploy.DEPLOYMENTS[d.name].manifest

            def fake_apply_and_wait(name, manifest, namespace, timeout):
                if name == "web" and b":n" in manifest.read_bytes():
                    raise deploy.RolloutBroken("simulated")

            def committed(ref, source):
                repo = "autogenbook-web" if source.name == "web.yaml" else "autogenbook"
                return f"replicas: 5\nimage: cerit.io/conerzyo/{repo}:twodeploysago\n".encode()

            render = lambda name, text: text.replace("replicas: 5", "replicas: 2")  # noqa: E731
            with patch.object(deploy, "_manifest_at_ref", side_effect=committed) as at_ref, patch.object(
                deploy, "_apply_and_wait", side_effect=fake_apply_and_wait
            ):
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "ns", TIMEOUTS, False, render)

            self.assertEqual(exit_code, 1)
            # Looked up by the k8s/ source, not the temp copy; rendered; pinned to the live tag.
            self.assertEqual(
                [call.args for call in at_ref.call_args_list],
                [("oldtag", deploy.DEPLOYMENTS[name].manifest) for name in deploy.DEPLOYMENT_ORDER],
            )
            for name, repo in (("api", "autogenbook"), ("worker", "autogenbook"), ("web", "autogenbook-web")):
                self.assertEqual(manifests[name].read_bytes(), f"replicas: 2\nimage: cerit.io/conerzyo/{repo}:oldtag\n".encode())

    def test_deployments_this_run_created_are_left_in_place_on_failure(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp_str:
            manifests = self._manifests(Path(tmp_str))
            plan = self._plan(manifests, new_tags={"api": "n", "worker": "n", "web": "n"}, current="")
            applied: list[str] = []

            def fake_apply_and_wait(name, manifest, namespace, timeout):
                applied.append(name)
                if name == "web":
                    raise deploy.RolloutBroken("simulated")

            with patch.object(deploy, "_apply_and_wait", side_effect=fake_apply_and_wait):
                self.assertEqual(deploy.apply_phase(plan, "cerit.io/conerzyo", "ns", TIMEOUTS, no_rollback=False), 1)
            self.assertEqual(applied, ["api", "worker", "web"])  # no rollback applies
            self.assertIn(b":n\n", manifests["api"].read_bytes())


class LiveTagsTests(unittest.TestCase):
    def test_missing_deployments(self):
        images = {"api": "r/autogenbook:a1", "worker": None, "web": None}
        with patch.object(deploy, "kubectl_get_image", side_effect=lambda name, ns: images[name]):
            with self.assertRaises(deploy.DeployError) as ctx:
                deploy.live_tags("ns")
            self.assertIn("--bootstrap", str(ctx.exception))
            self.assertEqual(deploy.live_tags("ns", allow_missing=True), {"api": "a1", "worker": "", "web": ""})


class BuildPlanStageTests(unittest.TestCase):
    def _build(self, stage, tags, *, changed=(), manifest_changed=False, allow_missing=False):
        with patch.object(deploy, "git_head", return_value=("h" * 40, "hhhhhhh")), patch.object(
            deploy, "live_tags", return_value=tags
        ), patch.object(deploy, "diff_since", return_value=(list(changed), False)), patch.object(
            deploy, "_manifest_changed", return_value=manifest_changed
        ):
            return deploy.build_plan(stage, None, allow_missing=allow_missing)

    def test_first_deploy_builds_both_images_and_creates_every_deployment(self):
        plan = self._build(_stage(), {"api": "", "worker": "", "web": ""}, allow_missing=True)
        self.assertEqual(plan.images_to_build, {"core", "web"})
        self.assertEqual(plan.migrations_changed, [])  # no older image to protect
        self.assertFalse(plan.in_place)
        self.assertEqual(plan.release_commit, "h" * 40)
        for d in plan.deployments.values():
            self.assertTrue(d.needs_apply)
            self.assertEqual(d.reason, "not deployed yet")
            self.assertEqual(d.target_tag(plan.head_short), "hhhhhhh")

    def test_a_missing_deployment_gets_the_tag_its_sibling_runs(self):
        plan = self._build(_stage(), {"api": "c1", "worker": "", "web": "w1"}, allow_missing=True)
        self.assertEqual(plan.images_to_build, set())
        self.assertEqual(plan.deployments["worker"].target_tag(plan.head_short), "c1")
        self.assertFalse(plan.deployments["api"].needs_apply)

    def test_image_tag_only_manifest_changes_are_not_applied(self):
        plan = self._build(_stage(), {"api": "c1", "worker": "c1", "web": "w1"}, changed=["k8s/api.yaml"])
        self.assertFalse(plan.anything_to_do)

    def test_a_changed_stage_file_reapplies_a_non_base_stage(self):
        stage = _stage()
        plan = self._build(stage, {"api": "c1", "worker": "c1", "web": "w1"}, changed=["k8s/stages/dev.toml"])
        self.assertTrue(all(d.needs_apply and not d.needs_build for d in plan.deployments.values()))
        base = self._build(_stage("prod", base=True), {"api": "c1", "worker": "c1", "web": "w1"}, changed=["k8s/stages/prod.toml"])
        self.assertFalse(base.anything_to_do)


class DeploymentHealthTests(unittest.TestCase):
    def _deployment(self, generation=3, observed=3, **status):
        full = {"replicas": 2, "updatedReplicas": 2, "readyReplicas": 2, "availableReplicas": 2, "observedGeneration": observed}
        full.update(status)
        return {"metadata": {"generation": generation}, "spec": {"replicas": 2}, "status": full}

    def test_healthy(self):
        self.assertIsNone(deploy.deployment_health_problem(self._deployment()))

    def test_unhealthy(self):
        for label, deployment in {
            "controller behind": self._deployment(generation=4),
            "old pods still around": self._deployment(replicas=3),
            "not updated": self._deployment(updatedReplicas=1),
            "not available": self._deployment(availableReplicas=1),
        }.items():
            with self.subTest(label):
                self.assertIsNotNone(deploy.deployment_health_problem(deployment))


class BuildPromotionPlanTests(unittest.TestCase):
    """build_promotion_plan() against a faked dev ("ns-dev") and prod ("ns-prod")."""

    RELEASE = "r" * 40

    def setUp(self):
        self.prod = _stage("prod", base=True, promote_from="dev")
        self.dev = _stage("dev")
        self.tags = {
            "ns-dev": {"api": "core222", "worker": "core222", "web": "web2222"},
            "ns-prod": {"api": "core111", "worker": "core111", "web": "web1111"},
        }
        self.healthy = {"metadata": {"generation": 1}, "spec": {"replicas": 1}, "status": {
            "observedGeneration": 1, "replicas": 1, "updatedReplicas": 1, "readyReplicas": 1, "availableReplicas": 1}}
        self.annotation = self.RELEASE
        self.diffs: dict[tuple[str, str], list[str]] = {}
        self.ancestors: dict[tuple[str, str], bool] = {}
        self.manifest_changed: set[tuple[str, str]] = set()

    def _deployment_json(self, resource, name, namespace):
        deployment = json.loads(json.dumps(self.healthy))
        if name == "api" and self.annotation:
            deployment["metadata"]["annotations"] = {deploy.RELEASE_ANNOTATION: self.annotation}
        return deployment

    def _git(self, *args):
        if args[:2] == ("rev-parse", "--short"):
            return "rrrrrrr"
        return self.RELEASE

    def _build(self):
        with patch.object(deploy, "git_head", return_value=("h" * 40, "hhhhhhh")), patch.object(
            deploy, "live_tags", side_effect=lambda ns, allow_missing=False: self.tags[ns]
        ), patch.object(deploy, "kubectl_get_json", side_effect=self._deployment_json), patch.object(
            deploy, "git_sha_exists", return_value=True
        ), patch.object(deploy, "git", side_effect=self._git), patch.object(
            deploy, "diff_since", side_effect=lambda a, b="HEAD": (self.diffs.get((a, b), []), False)
        ), patch.object(
            deploy, "git_is_ancestor", side_effect=lambda a, b: self.ancestors.get((a, b), True)
        ), patch.object(
            deploy, "_manifest_changed", side_effect=lambda ref, m: (ref, m.name) in self.manifest_changed
        ):
            return deploy.build_promotion_plan(self.prod, self.dev)

    def test_promotes_devs_tags_without_building(self):
        self.diffs[("core111", "core222")] = ["api/infrastructure/db/alembic/versions/0020_x.py", "api/main.py"]
        plan = self._build()
        self.assertEqual(plan.images_to_build, set())
        self.assertEqual(plan.release_commit, self.RELEASE)
        self.assertEqual(plan.promoted_from, "dev")
        self.assertTrue(plan.in_place)
        self.assertEqual(plan.commit_message, "Promote dev release rrrrrrr to prod")
        self.assertEqual(plan.migrations_changed, ["api/infrastructure/db/alembic/versions/0020_x.py"])
        self.assertEqual(
            {n: (d.needs_build, d.needs_apply, d.target_tag(plan.head_short)) for n, d in plan.deployments.items()},
            {"api": (False, True, "core222"), "worker": (False, True, "core222"), "web": (False, True, "web2222")},
        )

    def test_nothing_to_do_when_prod_already_runs_the_release(self):
        self.tags["ns-prod"] = dict(self.tags["ns-dev"])
        self.assertFalse(self._build().anything_to_do)

    def test_release_falls_back_to_the_core_tag_without_an_annotation(self):
        self.annotation = None
        plan = self._build()
        self.assertTrue(any("core222" in note for note in plan.notes))

    def _assert_refused(self, fragment):
        with self.assertRaises(deploy.DeployError) as ctx:
            self._build()
        self.assertIn(fragment, str(ctx.exception))

    def test_refuses_when_dev_api_and_worker_disagree(self):
        self.tags["ns-dev"]["worker"] = "core000"
        self._assert_refused("finish dev's deploy first")

    def test_refuses_an_unhealthy_dev(self):
        self.healthy["status"]["availableReplicas"] = 0
        self._assert_refused("isn't healthy")

    def test_refuses_images_that_dont_match_the_release(self):
        self.diffs[("web2222", self.RELEASE)] = ["app/src/main.tsx"]
        self._assert_refused("its last deploy didn't finish")

    def test_refuses_a_release_that_isnt_on_the_checked_out_branch(self):
        self.ancestors[(self.RELEASE, "h" * 40)] = False
        self._assert_refused("isn't on the checked-out branch")

    def test_refuses_when_k8s_manifests_differ_from_the_releases(self):
        self.manifest_changed.add((self.RELEASE, "worker.yaml"))
        self._assert_refused("k8s/worker.yaml")

    def test_refuses_to_take_prod_backwards(self):
        self.ancestors[("core111", self.RELEASE)] = False
        self._assert_refused("backwards")


class CheckEntrypointTests(unittest.TestCase):
    def _plan(self, *, needs_build, new_tag=None):
        d = deploy.DeploymentPlan("api", deploy.DEPLOYMENTS["api"].manifest, "core", "c1", needs_build, True, "t", new_tag=new_tag)
        return deploy.Plan("h" * 40, "hhhhhhh", {"api": d}, set(), [])

    def _check(self, plan, *, exists):
        seen = []

        def path_exists(commit, path):
            seen.append((commit, path))
            return exists

        stage = _stage(config={"CLI_ENTRYPOINT": "/app/run_engine.py"})
        with patch.object(deploy, "git_sha_exists", return_value=True), patch.object(deploy, "git_path_exists", side_effect=path_exists):
            deploy.check_entrypoint(plan, stage)
        return seen

    def test_checks_the_commit_the_core_image_comes_from(self):
        self.assertEqual(self._check(self._plan(needs_build=True), exists=True), [("h" * 40, "run_engine.py")])
        self.assertEqual(self._check(self._plan(needs_build=False, new_tag="p1"), exists=True), [("p1", "run_engine.py")])
        self.assertEqual(self._check(self._plan(needs_build=False), exists=True), [("c1", "run_engine.py")])

    def test_missing_entrypoint_is_refused(self):
        with self.assertRaises(deploy.DeployError):
            self._check(self._plan(needs_build=True), exists=False)

    def test_dev_runs_the_rewritten_engine(self):
        entrypoint = deploy.stage_config(deploy.load_stage("dev"))["CLI_ENTRYPOINT"]
        self.assertEqual(entrypoint, "run_engine.py")


class RunDeployStageTests(unittest.TestCase):
    """run_deploy()'s stage flow with every cluster/registry touchpoint faked."""

    def _args(self, *argv):
        return deploy.build_arg_parser().parse_args(list(argv))

    def test_stage_is_required_and_must_exist(self):
        from contextlib import redirect_stderr
        import io

        for argv in ([], ["--stage", "nope"]):
            with self.subTest(argv=argv), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self._args(*argv)

    def test_promote_needs_a_promote_from_stage_and_no_force(self):
        with patch.object(deploy, "preflight", side_effect=AssertionError("must fail before touching the cluster")):
            with self.assertRaises(deploy.DeployError):
                deploy.run_deploy(self._args("--stage", "dev", "--promote"), deploy.load_stage("dev"))
            with self.assertRaises(deploy.DeployError):
                deploy.run_deploy(self._args("--stage", "prod", "--promote", "--force", "web"), deploy.load_stage("prod"))

    def test_sync_secrets_does_not_combine_with_a_deploy(self):
        from contextlib import redirect_stderr
        import io

        with redirect_stderr(io.StringIO()):
            self.assertEqual(deploy.main(["--stage", "dev", "--sync-secrets", "--promote"]), 1)

    def test_bootstrap_needs_the_secret(self):
        with patch.object(deploy, "preflight"), patch.object(deploy, "kubectl_get_secret_data", return_value=None):
            with self.assertRaises(deploy.DeployError) as ctx:
                deploy.run_deploy(self._args("--stage", "dev", "--bootstrap"), deploy.load_stage("dev"))
        self.assertIn("--sync-secrets", str(ctx.exception))

    def _run(self, *argv, apply_result=0, config=None, anything_to_do=True):
        import io
        from contextlib import redirect_stdout

        calls: list[str] = []
        plan = deploy.Plan("h" * 40, "hhhhhhh", {
            name: deploy.DeploymentPlan(name, spec.manifest, spec.image_key, "c1", False, anything_to_do, "t")
            for name, spec in deploy.DEPLOYMENTS.items()
        }, set(), [], in_place=False, release_commit="h" * 40)

        def record(name, result=None):
            return lambda *a, **k: calls.append(name) or result

        stage = deploy.load_stage("dev")
        with patch.object(deploy, "preflight"), patch.object(deploy, "git_dirty_outside_k8s", return_value=False), patch.object(
            deploy, "kubectl_get_secret_data", return_value={}
        ), patch.object(deploy, "build_plan", return_value=plan), patch.object(deploy, "check_entrypoint"), patch.object(
            deploy, "live_config", return_value=config
        ), patch.object(deploy, "live_release", return_value=None), patch.object(
            deploy, "render_deployments", side_effect=record("render")
        ), patch.object(deploy, "bootstrap_before", side_effect=record("before")), patch.object(
            deploy, "apply_phase", side_effect=record("apply", apply_result)
        ), patch.object(deploy, "restart_for_config", side_effect=record("restart")), patch.object(
            deploy, "bootstrap_after", side_effect=record("after")
        ), patch.object(deploy, "annotate_release", side_effect=record("annotate")), redirect_stdout(io.StringIO()):
            code = deploy.run_deploy(self._args(*argv), stage)
        return code, calls

    def test_bootstrap_order(self):
        code, calls = self._run("--stage", "dev", "--bootstrap", "--apply", "--yes")
        self.assertEqual(code, 0)
        self.assertEqual(calls, ["render", "before", "apply", "restart", "after", "annotate"])

    def test_unchanged_config_restarts_nothing(self):
        config = deploy.stage_config(deploy.load_stage("dev"))
        _, calls = self._run("--stage", "dev", "--bootstrap", "--apply", "--yes", config=config)
        self.assertNotIn("restart", calls)

    def test_failed_apply_stops_before_the_rest(self):
        code, calls = self._run("--stage", "dev", "--bootstrap", "--apply", "--yes", apply_result=1)
        self.assertEqual(code, 1)
        self.assertEqual(calls, ["render", "before", "apply"])

    def test_plain_deploy_touches_no_supporting_resources(self):
        code, calls = self._run("--stage", "dev", "--apply", "--yes")
        self.assertEqual((code, calls), (0, ["render", "apply", "annotate"]))

    def test_dry_run_changes_nothing(self):
        self.assertEqual(self._run("--stage", "dev", "--bootstrap"), (0, []))

    def test_nothing_to_do_records_the_release_once_it_is_live(self):
        self.assertEqual(self._run("--stage", "dev", "--apply", anything_to_do=False), (0, ["annotate"]))
        self.assertEqual(self._run("--stage", "dev", anything_to_do=False), (0, []))


class BootstrapStepsTests(unittest.TestCase):
    def test_supporting_resources_are_applied_in_deploy_guide_order(self):
        calls: list[str] = []
        stage = deploy.load_stage("dev")
        with patch.object(deploy, "_apply_text", side_effect=lambda text, ns, label: calls.append(f"apply {label}")), patch.object(
            deploy, "_wait_for_rollout", side_effect=lambda name, ns, timeout: calls.append(f"wait {name}")
        ), patch.object(deploy, "run", side_effect=lambda cmd: calls.append(" ".join(cmd[:3]))):
            deploy.bootstrap_before(stage)
            deploy.bootstrap_after(stage)
        self.assertEqual(
            calls,
            [
                "apply k8s/configmap.yaml",
                "apply k8s/pvc.yaml",
                "apply k8s/networkpolicy.yaml",
                "apply k8s/db.yaml",
                "apply k8s/minio.yaml",
                "wait db",
                "wait minio",
                "kubectl delete job",
                "apply k8s/minio-init-job.yaml",
                "kubectl wait --for=condition=complete",
                "apply k8s/ingress.yaml",
            ],
        )

    def test_config_restart_skips_deployments_already_on_new_pods(self):
        plan = deploy.Plan("h" * 40, "hhhhhhh", {
            "api": deploy.DeploymentPlan("api", Path("a"), "core", "c1", True, True, "t"),  # rebuilt
            "worker": deploy.DeploymentPlan("worker", Path("w"), "core", "c1", False, False, "t"),  # untouched
            "web": deploy.DeploymentPlan("web", Path("x"), "web", "w1", False, False, "t"),
        }, set(), [])
        restarted: list[str] = []
        with patch.object(deploy, "run", side_effect=lambda cmd: restarted.append(cmd[3])), patch.object(deploy, "_wait_for_rollout"):
            deploy.restart_for_config(plan, "ns", TIMEOUTS)
        self.assertEqual(restarted, ["deployment/worker"])


if __name__ == "__main__":
    unittest.main()
