import json
import os
from pathlib import Path
import tempfile
import time
import unittest

from snooze.headless import HeadlessCodex


class HeadlessCodexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.project = self.root / "project"
        self.project.mkdir()
        self.capture = self.root / "capture.json"
        self.executable = self.root / "fake-codex"

    def runner(self, body, timeout=2):
        source = "#!/usr/bin/python3\nimport json,os,sys,time,subprocess\n" + body
        self.executable.write_text(source)
        self.executable.chmod(0o700)
        return HeadlessCodex(executable=self.executable, project_dir=self.project,
            codex_home=self.home, sessions={("project-a", "owner-a", "remote-session-a"): "0199a213-81c0-7800-8aa1-bbab2a035a53"}, timeout_seconds=timeout)

    def context(self):
        return {"event_id": "guidance-23", "project": "project-a", "owner": "owner-a",
                "session": "remote-session-a", "job": "job-a", "kind": "failed", "severity": "failed"}

    def test_resume_is_fixed_read_only_and_passes_bounded_metadata_on_stdin(self):
        runner = self.runner("open(%r,'w').write(json.dumps({'argv':sys.argv,'env':dict(os.environ),'stdin':sys.stdin.read()}))\nprint(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'Check the durable inbox and assign a reviewer.'}}))\nprint(json.dumps({'type':'turn.completed'}))\n" % str(self.capture))
        result = runner(self.context(), 2)
        self.assertEqual(result["state"], "accepted")
        self.assertEqual(result["receipt"]["advisory"], "Check the durable inbox and assign a reviewer.")
        captured = json.loads(self.capture.read_text())
        args = captured["argv"]
        self.assertEqual(args, [str(self.executable), "--ask-for-approval", "never", "exec",
            "--sandbox", "read-only", "resume", "0199a213-81c0-7800-8aa1-bbab2a035a53",
            "--json", "--ignore-user-config", "-"])
        self.assertEqual(set(captured["env"]), {"HOME", "CODEX_HOME", "PATH", "LANG"})
        self.assertIn("Do not modify files", captured["stdin"])
        self.assertIn('"event_id":"guidance-23"', captured["stdin"])
        self.assertIn('"job":"job-a"', captured["stdin"])

    def test_final_completed_agent_message_is_retained_as_bounded_advisory(self):
        runner = self.runner("print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'First advisory.'}}))\nprint(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'Final advisory: inspect the durable event ledger.'}}))\nprint(json.dumps({'type':'turn.completed'}))")
        result = runner(self.context(), 2)
        self.assertEqual(result["state"], "accepted")
        self.assertEqual(result["receipt"]["advisory"], "Final advisory: inspect the durable event ledger.")
        self.assertTrue(result["receipt"]["advisoryOnly"])

    def test_malformed_agent_message_is_ambiguous_and_not_retained(self):
        runner = self.runner("print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':23}}))\nprint(json.dumps({'type':'turn.completed'}))")
        result = runner(self.context(), 2)
        self.assertEqual(result["state"], "ambiguous")
        self.assertNotIn("advisory", result["receipt"])

    def test_advisory_is_redacted_and_bounded_before_receipt(self):
        text = "Bearer secret-value api_key=topsecret password: hidden " + ("x" * 5000)
        runner = self.runner("print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':%r}}))\nprint(json.dumps({'type':'turn.completed'}))" % text)
        result = runner(self.context(), 2)
        self.assertEqual(result["state"], "accepted")
        advisory = result["receipt"]["advisory"]
        self.assertLessEqual(len(advisory), 1200)
        self.assertIn("Bearer [REDACTED]", advisory)
        self.assertIn("api_key=[REDACTED]", advisory)
        self.assertIn("password: [REDACTED]", advisory)
        self.assertNotIn("secret-value", advisory)
        self.assertNotIn("topsecret", advisory)
        self.assertNotIn("hidden", advisory)
        self.assertTrue(result["receipt"]["advisoryTruncated"])

    def test_unallowlisted_session_never_starts_process(self):
        runner = self.runner("open(%r,'w').write('started')" % str(self.capture))
        for changes in ({"session": "other-session"}, {"owner": "owner-b"}, {"project": "project-b"}):
            with self.subTest(changes=changes):
                result = runner(self.context() | changes, 2)
                self.assertEqual(result["state"], "rejected")
                self.assertFalse(self.capture.exists())

    def test_timeout_is_ambiguous(self):
        runner = self.runner("time.sleep(2)", timeout=0.1)
        self.assertEqual(runner(self.context(), 1)["state"], "ambiguous")

    def test_nonzero_exit_is_ambiguous_without_hitting_the_timeout_boundary(self):
        runner = self.runner("sys.exit(3)", timeout=5)
        result = runner(self.context(), 5)
        self.assertEqual(result["state"], "ambiguous")
        self.assertEqual(result["receipt"]["exit_code"], 3)

    def test_timeout_kills_the_process_group(self):
        marker = self.root / "late-child-output"
        body = "subprocess.Popen([sys.executable,'-c',%r]); time.sleep(5)" % (
            "import time; time.sleep(.4); open(%r,'w').write('late')" % str(marker))
        runner = self.runner(body, timeout=0.1)
        self.assertEqual(runner(self.context(), 1)["state"], "ambiguous")
        time.sleep(0.5)
        self.assertFalse(marker.exists())

    def test_output_is_capped_and_never_copied_to_receipt(self):
        runner = self.runner("sys.stdout.write('x'*70000); sys.stdout.flush()")
        result = runner(self.context(), 1)
        self.assertEqual(result["state"], "ambiguous")
        self.assertLessEqual(result["receipt"]["bytes"], 65536)
        self.assertNotIn("x" * 100, json.dumps(result))


if __name__ == "__main__":
    unittest.main()
