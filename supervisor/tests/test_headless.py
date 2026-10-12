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

    def runner(self, body, timeout=1):
        source = "#!/usr/bin/python3\nimport json,os,sys,time,subprocess\n" + body
        self.executable.write_text(source)
        self.executable.chmod(0o700)
        return HeadlessCodex(executable=self.executable, project_dir=self.project,
            codex_home=self.home, sessions=[("project-a", "owner-a", "session-a")], timeout_seconds=timeout)

    def context(self):
        return {"project": "project-a", "owner": "owner-a", "session": "session-a",
                "job": "project-a", "kind": "failed", "severity": "failed"}

    def test_resume_is_fixed_read_only_and_passes_bounded_metadata_on_stdin(self):
        runner = self.runner("open(%r,'w').write(json.dumps({'argv':sys.argv,'env':dict(os.environ),'stdin':sys.stdin.read()}))\nprint(json.dumps({'type':'turn.completed'}))\n" % str(self.capture))
        result = runner(self.context(), 2)
        self.assertEqual(result["state"], "accepted")
        captured = json.loads(self.capture.read_text())
        args = captured["argv"]
        self.assertEqual(args[1:4], ["exec", "resume", "session-a"])
        self.assertIn("read-only", args)
        self.assertIn("never", args)
        self.assertEqual(set(captured["env"]), {"HOME", "CODEX_HOME", "PATH", "LANG"})
        self.assertEqual(json.loads(captured["stdin"]), {"project": "project-a", "job": "project-a", "kind": "failed", "severity": "failed"})

    def test_unallowlisted_session_never_starts_process(self):
        runner = self.runner("open(%r,'w').write('started')" % str(self.capture))
        context = self.context() | {"session": "other-session"}
        result = runner(context, 2)
        self.assertEqual(result["state"], "rejected")
        self.assertFalse(self.capture.exists())

    def test_timeout_and_nonzero_exit_are_ambiguous(self):
        runner = self.runner("time.sleep(2)", timeout=0.1)
        self.assertEqual(runner(self.context(), 1)["state"], "ambiguous")
        runner = self.runner("sys.exit(3)")
        result = runner(self.context(), 1)
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
