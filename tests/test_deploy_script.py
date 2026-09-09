"""Unit tests for scripts/deploy.py's pure logic (path classification, tag parsing, env-file
parsing, secret validation, and the apply/rollback state machine). Deliberately does not touch
git/docker/kubectl - those are mocked or bypassed by constructing Plan objects directly - so this
suite runs anywhere, including CI, with none of the tools installed.

scripts/ isn't a package (matches tests/ itself having no __init__.py, see CI's
`python -m unittest discover` comment in .github/workflows/ci.yml), so the module is loaded
directly from its file path rather than imported by dotted name.
"""

import importlib.util
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


class ClassifyPathTests(unittest.TestCase):
    def test_app_prefix_is_web(self):
        self.assertEqual(deploy.classify_path("app/src/api/client.ts"), "web")

    def test_known_no_rebuild_prefixes_are_none(self):
        for path in ("k8s/api.yaml", "docs/DEPLOY_GUIDE.md", "tests/test_x.py", "scripts/deploy.py", "src/autogenbook/main.py"):
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
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", "180s", no_rollback=False)

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
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", "180s", no_rollback=False)

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
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", "180s", no_rollback=True)

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
                exit_code = deploy.apply_phase(plan, "cerit.io/conerzyo", "autogenbook", "180s", no_rollback=False)

            self.assertEqual(exit_code, 0)
            for name in ("api", "worker", "web"):
                self.assertIn(b"deadbee", manifests[name].read_bytes())
                self.assertIn(b"keep-me", manifests[name].read_bytes())


if __name__ == "__main__":
    unittest.main()
