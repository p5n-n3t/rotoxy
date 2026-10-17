import json
import os
import tempfile
import unittest
from pathlib import Path
from snooze.runner_registry import apply

class RunnerRegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix="runner-registry-test-"); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name); self.cwd=self.root/"work"; self.cwd.mkdir()
        self.binary=self.root/"claude"; self.binary.write_text("#!/bin/sh\nexit 0\n"); self.binary.chmod(0o700)
        self.config=self.root/"state"/"runner-profiles.json"
        self.trusted={"claude":[str(self.binary)],"opencode":[],"hermes":[]}
    def invoke(self,request,runner=None): return apply(self.config,request,self.trusted,runner)
    def profile(self,**extra): return {"id":"runner_profile_0001","kind":"claude","label":"Local Claude","cwd":str(self.cwd),"binary":str(self.binary),"enabled":True,"allowedModels":[],**extra}
    def test_owner_private_crud_revision_backup_and_probe_only_fixed_args(self):
        initial=self.invoke({"action":"read"}); self.assertEqual(initial["profiles"],[])
        added=self.invoke({"action":"add","revision":initial["revision"],"profile":self.profile()})
        self.assertEqual(added["profiles"][0]["probeState"],"unverified")
        self.assertEqual(self.config.stat().st_mode & 0o777,0o600); self.assertEqual(self.config.parent.stat().st_mode & 0o777,0o700)
        backup=self.config.with_name(self.config.name+".backup."+initial["revision"]); self.assertFalse(backup.exists())
        before=self.config.read_bytes()
        calls=[]
        def probe(argv,cwd,timeout,limit): calls.append((argv,cwd,timeout,limit)); return {"state":"available","output":"Claude Code 1.2"}
        checked=self.invoke({"action":"probe","revision":added["revision"],"id":self.profile()["id"],"check":"version"},probe)
        self.assertEqual(calls[0],([str(self.binary),"--version"],str(self.cwd),5,16*1024)); self.assertEqual(checked["profiles"][0]["probeState"],"available")
        backup=self.config.with_name(self.config.name+".backup."+added["revision"]); self.assertEqual(backup.read_bytes(),before); self.assertEqual(backup.stat().st_mode & 0o777,0o600)
        with self.assertRaisesRegex(ValueError,"revision_conflict"): self.invoke({"action":"remove","revision":initial["revision"],"id":self.profile()["id"]})
        disabled=self.invoke({"action":"enable","revision":checked["revision"],"id":self.profile()["id"]}); self.assertFalse(disabled["profiles"][0]["enabled"])
    def test_http_cannot_select_untrusted_executable_or_inject_probe_arguments(self):
        snap=self.invoke({"action":"read"})
        bad=self.profile(binary="/tmp/attacker")
        with self.assertRaisesRegex(ValueError,"executable_not_trusted"): self.invoke({"action":"add","revision":snap["revision"],"profile":bad})
        self.assertFalse(self.config.exists())
        with self.assertRaisesRegex(ValueError,"invalid_probe"): self.invoke({"action":"probe","revision":snap["revision"],"id":self.profile()["id"],"check":"version; id"})
    def test_update_remove_and_unknown_models_remain_explicit(self):
        first=self.invoke({"action":"read"})
        added=self.invoke({"action":"add","revision":first["revision"],"profile":self.profile()})
        self.assertEqual(added["profiles"][0]["allowedModels"],[])
        replacement=self.profile(label="Changed profile",enabled=False,allowedModels=["claude-sonnet-4-6"])
        changed=self.invoke({"action":"update","revision":added["revision"],"profile":replacement})
        self.assertEqual(changed["profiles"][0]["label"],"Changed profile")
        self.assertEqual(changed["profiles"][0]["allowedModels"],["claude-sonnet-4-6"])
        removed=self.invoke({"action":"remove","revision":changed["revision"],"id":replacement["id"]})
        self.assertEqual(removed["profiles"],[])
    def test_probe_timeout_and_output_are_bounded(self):
        snap=self.invoke({"action":"read"}); added=self.invoke({"action":"add","revision":snap["revision"],"profile":self.profile()})
        def timed(*args): return {"state":"timeout","output":""}
        result=self.invoke({"action":"probe","revision":added["revision"],"id":self.profile()["id"],"check":"help"},timed)
        self.assertEqual(result["profiles"][0]["probeState"],"timeout")
        def noisy(*args): return {"state":"output_limited","output":"x"*2000}
        result=self.invoke({"action":"probe","revision":result["revision"],"id":self.profile()["id"],"check":"help"},noisy)
        self.assertLessEqual(len(result["profiles"][0]["probeOutput"].encode()),1024)

    def test_missing_installation_stays_visible_and_removable_without_execution(self):
        initial=self.invoke({"action":"read"})
        added=self.invoke({"action":"add","revision":initial["revision"],"profile":self.profile()})
        self.binary.unlink(); self.cwd.rmdir()
        read=self.invoke({"action":"read"})
        self.assertEqual(read["profiles"][0]["probeState"],"unavailable")
        with self.assertRaises(ValueError):
            self.invoke({"action":"probe","revision":read["revision"],"id":self.profile()["id"],"check":"version"})
        removed=self.invoke({"action":"remove","revision":read["revision"],"id":self.profile()["id"]})
        self.assertEqual(removed["profiles"],[])

if __name__=="__main__": unittest.main()
