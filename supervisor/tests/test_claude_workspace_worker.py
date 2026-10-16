import contextlib
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from snooze.agent_workspace import AgentWorkspace, WorkspaceError
from snooze import claude_workspace_worker as worker


class ClaudeWorkspaceWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._old_env = {key: os.environ.get(key) for key in ("HOME", "TOKEN2OAUTH_CONFIG_DIR")}
        cls._isolated_home = tempfile.TemporaryDirectory(prefix="claude-worker-home-")
        os.environ["HOME"] = cls._isolated_home.name
        os.environ["TOKEN2OAUTH_CONFIG_DIR"] = str(Path(cls._isolated_home.name) / "config")

    @classmethod
    def tearDownClass(cls):
        for key, value in cls._old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls._isolated_home.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / "private" / "workspace.sqlite3"
        self.project = "project-a"
        self.task = "task-a"
        self.ws = AgentWorkspace(self.db)
        self.ws.update(self.project, "admin:local", {
            "action": "task_create", "taskId": self.task, "title": "Bounded task",
            "description": "Use stdin and return a reviewed artifact.",
            "idempotencyKey": "create-task-a", "expectedRevision": 0,
        })
        self.binary = self.root / "claude"
        self.binary.write_text("#!/bin/sh\nexit 0\n")
        self.binary.chmod(0o700)
        self.args = SimpleNamespace(db=str(self.db), project=self.project, task=self.task,
            claude_binary=str(self.binary), model="claude-sonnet-4-6", max_budget_usd=0.2,
            timeout_seconds=30)

    def tearDown(self):
        self.temp.cleanup()

    def attempt(self):
        with sqlite3.connect(self.db) as db:
            return db.execute("SELECT status,model_requested,model_reported,total_cost_usd,result FROM claude_workspace_attempts WHERE project_id=? AND task_id=?",
                              (self.project, self.task)).fetchone()

    def test_dry_run_does_not_create_database_or_invoke_cli(self):
        missing = self.root / "not-created" / "workspace.sqlite3"
        argv = ["claude-worker", "--db", str(missing), "--project", self.project,
                "--task", self.task, "--claude-binary", str(self.binary), "--model", "claude-sonnet-4-6",
                "--max-budget-usd", "0.2", "--timeout-seconds", "30"]
        output = io.StringIO()
        with patch.object(sys, "argv", argv), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as exit_info:
                worker.main()
        self.assertEqual(exit_info.exception.code, 0)
        self.assertIn("DRY RUN", output.getvalue())
        self.assertFalse(missing.exists())

    def test_claims_runs_once_records_actual_model_and_cost_then_leaves_review_artifact(self):
        calls = []
        raw = json.dumps({"result": "Bearer secret-result\n" + "x" * 1200,
                          "modelUsage": {"claude-sonnet-4-6": {"inputTokens": 3}},
                          "total_cost_usd": 0, "cost_usd": 0.8,
                          "usage": {"private-key": "must-not-leak"}})
        def fake(argv, stdin_text, timeout):
            calls.append((argv, stdin_text, timeout))
            return raw, None
        first = worker.run_task(self.args, runner=fake)
        self.assertEqual(first["status"], "success")
        self.assertEqual(first["model_reported"], "claude-sonnet-4-6")
        self.assertEqual(first["total_cost_usd"], 0.0)
        argv, prompt, timeout = calls[0]
        self.assertNotIn(prompt, argv)
        self.assertNotIn(prompt, os.environ.values())
        self.assertEqual(argv[argv.index("--model") + 1], "claude-sonnet-4-6")
        snapshot = self.ws.snapshot(self.project, "admin:local")
        self.assertEqual(snapshot["tasks"][0]["state"], "review")
        self.assertEqual(snapshot["artifacts"][0]["state"], "pending")
        self.assertLessEqual(len(snapshot["artifacts"][0]["reference"]), 900)
        self.assertIn("Bearer [REDACTED]", snapshot["artifacts"][0]["reference"])
        self.assertEqual(self.attempt()[0:4], ("success", "claude-sonnet-4-6", "claude-sonnet-4-6", 0.0))
        self.assertNotIn("secret-result", self.attempt()[4])
        # A fresh worker process sees the durable receipt and never invokes the CLI again.
        second = worker.run_task(self.args, runner=fake)
        self.assertEqual(second["status"], "skipped")
        self.assertEqual(len(calls), 1)

    def test_unknown_model_and_nonfinite_cost_are_not_fabricated_or_exposed(self):
        parsed, error = worker.parse_cli_result(json.dumps({
            "result": "done", "modelUsage": {"sk-secret-value": {"inputTokens": 9}},
            "total_cost_usd": 10**1000, "cost_usd": 0.5,
        }))
        self.assertIsNone(error)
        self.assertIsNone(parsed["model_reported"])
        self.assertIsNone(parsed["total_cost"])

    def test_timeout_and_stdout_overflow_are_ambiguous_and_never_replayed(self):
        for error in ("timeout", "overflow"):
            with self.subTest(error=error):
                if self.db.exists():
                    self.temp.cleanup()
                    self.setUp()
                calls = []
                def fake(argv, prompt, timeout):
                    calls.append((argv, prompt))
                    return None, error
                result = worker.run_task(self.args, runner=fake)
                self.assertEqual(result["status"], "ambiguous")
                self.assertEqual(self.ws.snapshot(self.project, "admin:local")["tasks"][0]["state"], "blocked")
                again = worker.run_task(self.args, runner=fake)
                self.assertEqual(again["status"], "skipped")
                self.assertEqual(len(calls), 1)

    def test_stale_revision_never_reaches_the_cli(self):
        real_workspace = self.ws
        class RacingWorkspace:
            raced = False
            def __init__(self, _db_path):
                pass
            def snapshot(self, *args, **kwargs):
                return real_workspace.snapshot(*args, **kwargs)
            def update(self, project, actor, value):
                if value["action"] == "participant_upsert" and not self.raced:
                    self.raced = True
                    current = real_workspace.snapshot(project, "admin:local")["revision"]
                    real_workspace.update(project, "admin:local", {
                        "action": "participant_upsert", "label": "revision racer", "provider": "test",
                        "idempotencyKey": "revision-race", "expectedRevision": current,
                    })
                return real_workspace.update(project, actor, value)
        calls = []
        with patch.object(worker, "AgentWorkspace", RacingWorkspace):
            result = worker.run_task(self.args, runner=lambda *a: calls.append(a))
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["message"], "workspace error: revision_conflict")
        self.assertEqual(calls, [])
        self.assertEqual(self.attempt()[0], "error")

    def test_runner_uses_stdin_and_fixed_bounded_environment_without_provider_key_inheritance(self):
        capture = self.root / "capture.py"
        capture.write_text("#!/usr/bin/python3\nimport json,os,sys\nprint(json.dumps({'stdin':sys.stdin.read(),'argv':sys.argv[1:],'output':os.getenv('CLAUDE_CODE_MAX_OUTPUT_TOKENS'),'thinking':os.getenv('MAX_THINKING_TOKENS'),'key':os.getenv('ANTHROPIC_API_KEY')}))\n")
        capture.chmod(0o700)
        saved = {name: os.environ.get(name) for name in ("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "MAX_THINKING_TOKENS", "ANTHROPIC_API_KEY")}
        os.environ.update({"CLAUDE_CODE_MAX_OUTPUT_TOKENS": "8192", "MAX_THINKING_TOKENS": "9000", "ANTHROPIC_API_KEY": "sentinel-provider-key"})
        prompt = "task prompt sentinel"
        try:
            output, error = worker.default_runner([str(capture)], prompt, 5)
        finally:
            for name, value in saved.items():
                if value is None: os.environ.pop(name, None)
                else: os.environ[name] = value
        self.assertIsNone(error)
        value = json.loads(output)
        self.assertEqual(value["stdin"], prompt)
        self.assertNotIn(prompt, value["argv"])
        self.assertEqual(value["output"], "2048")
        self.assertEqual(value["thinking"], "1024")
        self.assertIsNone(value["key"])

    def test_default_runner_timeout_and_stdout_overflow_fail_closed(self):
        timeout, timeout_error = worker.default_runner([sys.executable, "-c", "import time; time.sleep(3)"], "", 0.05)
        self.assertIsNone(timeout)
        self.assertEqual(timeout_error, "timeout")
        overflow, overflow_error = worker.default_runner([sys.executable, "-c", "import sys; sys.stdout.write('x' * 270000)"], "", 5)
        self.assertIsNone(overflow)
        self.assertEqual(overflow_error, "overflow")


if __name__ == "__main__":
    unittest.main()
