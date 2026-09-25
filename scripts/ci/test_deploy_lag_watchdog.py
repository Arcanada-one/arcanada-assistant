#!/usr/bin/env python3
"""A2-371 — the deploy-lag watchdog must go red on the situation itself and stay green without it.

A throwaway git repository stands in for main and a loopback HTTP server for production's /health.
The server reports whatever digest the case chooses; the digest is always COMPUTED by the deploy
gate over a real commit, never typed in, so these tests cannot agree with a wrong digest.

Run: python3 scripts/ci/test_deploy_lag_watchdog.py
"""

from __future__ import annotations

import contextlib
import http.server
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("deploy_lag_watchdog", HERE / "deploy-lag-watchdog.py")
watchdog = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(watchdog)  # type: ignore[union-attr]

HOUR = 3600
T0 = 1_790_000_000  # a fixed "now"; commit dates are set relative to it


class _Health(http.server.BaseHTTPRequestHandler):
    body: dict = {}
    status = 200

    def do_GET(self):  # noqa: N802
        raw = json.dumps(type(self).body).encode()
        self.send_response(type(self).status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_):
        pass


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="lag-watchdog-test-")
        self.root = Path(self._tmp.name)
        self._git("init", "-q", "-b", "main")
        for rel, text in {
            "package.json": "{}\n",
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            "pnpm-workspace.yaml": "packages: []\n",
            "tsconfig.base.json": "{}\n",
            "tsconfig.json": "{}\n",
            "apps/assistant/src/main.ts": "export const v = 1;\n",
            "packages/core/src/index.ts": "export const c = 1;\n",
        }.items():
            self._write(rel, text)
        self.v1 = self._commit("v1 image", T0 - 48 * HOUR)

        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Health)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/health"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self._tmp.cleanup()

    def _git(self, *args, env=None):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True,
                              text=True, env=env).stdout.strip()

    def _write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def _commit(self, message, epoch):
        env = {**os.environ, "GIT_AUTHOR_DATE": f"@{epoch} +0000", "GIT_COMMITTER_DATE": f"@{epoch} +0000",
               "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
               "GIT_COMMITTER_EMAIL": "t@t"}
        self._git("add", "-A", env=env)
        self._git("commit", "-q", "-m", message, env=env)
        return self._git("rev-parse", "HEAD")

    def _production_runs(self, sha):
        _Health.status = 200
        _Health.body = {"status": "ok", "buildFingerprint": {"digest": watchdog.digest_at(self.root, sha)}}

    def _verdict(self, max_lag=2 * HOUR):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = watchdog.run(self.root, "HEAD", self.url, max_lag, 50, 1, 0.0, now=T0)
        return rc, out.getvalue()

    # --- green ----------------------------------------------------------------------------------

    def test_match_is_green(self):
        self._production_runs(self.v1)
        rc, out = self._verdict()
        self.assertEqual(rc, 0, out)
        self.assertIn("PASS — production runs main's image inputs", out)

    def test_non_image_commit_on_top_is_still_green(self):
        # A docs-only merge changes no image input; production correctly did nothing.
        self._write("README.md", "docs\n")
        self._commit("docs", T0 - 47 * HOUR)
        self._production_runs(self.v1)
        rc, out = self._verdict()
        self.assertEqual(rc, 0, out)

    def test_young_gap_is_pending_not_red(self):
        self._write("apps/assistant/src/main.ts", "export const v = 2;\n")
        self._commit("v2", T0 - 30 * 60)
        self._production_runs(self.v1)
        rc, out = self._verdict()
        self.assertEqual(rc, 0, out)
        self.assertIn("deploy pending", out)

    # --- red: the situation itself ---------------------------------------------------------------

    def test_fingerprint_mismatch_older_than_limit_is_red(self):
        # The 2026-09-23 shape: an image change landed on main, the deploy was skipped, 2 days pass.
        self._write("apps/assistant/src/main.ts", "export const v = 2;\n")
        v2 = self._commit("v2", T0 - 46 * HOUR)
        self._production_runs(self.v1)
        rc, out = self._verdict()
        self.assertEqual(rc, 1, out)
        self.assertIn("main is NOT deployed", out)
        self.assertIn(v2[:12], out)

    def test_trickle_of_new_commits_does_not_reset_the_clock(self):
        # Lag is measured from the OLDEST undeployed image change, not the newest.
        self._write("apps/assistant/src/main.ts", "export const v = 2;\n")
        v2 = self._commit("v2 (undeployed)", T0 - 46 * HOUR)
        self._write("apps/assistant/src/main.ts", "export const v = 3;\n")
        self._commit("v3 (fresh)", T0 - 10 * 60)
        self._production_runs(self.v1)
        rc, out = self._verdict()
        self.assertEqual(rc, 1, out)
        self.assertIn(v2[:12], out)

    def test_build_never_on_main_is_red(self):
        _Health.body = {"buildFingerprint": {"digest": "sha256:" + "0" * 64}}
        rc, out = self._verdict()
        self.assertEqual(rc, 1, out)
        self.assertIn("matches none", out)

    # --- red: could not prove --------------------------------------------------------------------

    def test_missing_field_is_red_not_green(self):
        _Health.body = {"status": "ok"}
        rc, out = self._verdict()
        self.assertEqual(rc, 1, out)
        self.assertIn("could not prove", out)

    def test_unreachable_is_red_not_green(self):
        self.url = "http://127.0.0.1:9/health"
        rc, out = self._verdict()
        self.assertEqual(rc, 1, out)
        self.assertIn("could not prove", out)

    def test_503_body_is_read(self):
        self._production_runs(self.v1)
        _Health.status = 503
        rc, out = self._verdict()
        self.assertEqual(rc, 0, out)

    # --- the digest itself is the deploy gate's ---------------------------------------------------

    def test_digest_at_equals_gate_over_checkout(self):
        self.assertEqual(watchdog.digest_at(self.root, "HEAD"), watchdog.gate.fingerprint_of(self.root)["digest"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
