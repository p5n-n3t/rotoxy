import json
import os
import tempfile
import unittest
from pathlib import Path

from snooze.controlled_batch_admin import approve_request, snapshot, _safe_db
from snooze.jobs import JobRegistry


def spec():
    return {"schemaVersion":1,"assignmentId":"batch-a","idempotencyKey":"key-a","projectId":"project-a","eligibleAccountIds":["account-a"],"maxWorkers":1,"tasks":[{"taskId":"task-a","dependsOn":[],"scopeKeys":["path:src/a.py"],"instructions":"PRIVATE prompt must not appear","execution":{"mode":"existing-session","sessionId":"session-a","accountId":"account-a"},"output":{"kind":"text","maxBytes":512,"format":"plain","expectedMarker":"DONE"}}]}

class ControlledBatchAdminTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.state=Path(self.temp.name)/"state"; self.state.mkdir(mode=0o700); os.chmod(self.state,0o700)
        self.path=self.state/"snooze.sqlite3"; self.registry=JobRegistry(self.path)
        self.registry.register_account({"accountId":"account-a","enabled":True,"authorized":True,"allowUnknownQuota":False,"health":"healthy","quota":"available","localCapacity":1,"registeredSessions":[{"id":"session-a","model":"model-a","workspace":"ws"}]})
        self.registry.submit(spec(),now=10)
        with self.registry.connection(write=True) as db: self.op=self.registry._queue_one_ready(db,11)
        # State used by the production bridge is private and owner-only.
        os.chmod(self.path,0o600)
    def tearDown(self): self.temp.cleanup()

    def payload(self, **overrides):
        view=snapshot(self.registry,now=20); binding=next(x["bindingHash"] for x in view["operations"] if x["operationId"]==self.op)
        value={"assignmentId":"batch-a","operationIds":[self.op],"accountIds":["account-a"],"maxLaunches":1,"ttlSeconds":30,"ackUnknownCreditCost":True,"expectedBindings":{self.op:binding}}; value.update(overrides); return value

    def test_read_is_metadata_only_and_exact_approval_uses_registry(self):
        view=snapshot(self.registry,now=20)
        self.assertEqual(view["operations"][0]["operationId"],self.op)
        self.assertEqual(view["operations"][0]["model"],"model-a")
        self.assertNotIn("PRIVATE prompt",json.dumps(view))
        grant=approve_request(self.registry,self.payload(),now=20)
        self.assertEqual(grant["operationIds"],[self.op])
        self.assertEqual(snapshot(self.registry,now=51)["grants"][0]["expired"],True)

    def test_unknown_cost_amount_bounds_and_stale_binding_rejected(self):
        with self.assertRaisesRegex(ValueError,"invalid_request"):
            approve_request(self.registry,self.payload(ackUnknownCreditCost=False),now=20)
        with self.assertRaisesRegex(ValueError,"30..600"):
            approve_request(self.registry,self.payload(ttlSeconds=29),now=20)
        with self.assertRaisesRegex(ValueError,"max launches"):
            approve_request(self.registry,self.payload(maxLaunches=4),now=20)
        stale=self.payload()
        with self.registry.connection(write=True) as db:
            db.execute("UPDATE operations SET input=? WHERE id=?",(json.dumps({"sessionId":"changed","instructions":"never reveal"}),self.op))
        with self.assertRaisesRegex(ValueError,"operation binding changed"):
            approve_request(self.registry,stale,now=20)

    def test_ambiguous_operations_and_untrusted_database_paths_are_denied(self):
        stale=self.payload()
        with self.registry.connection(write=True) as db:
            db.execute("UPDATE operations SET state='ambiguous' WHERE id=?",(self.op,))
        with self.assertRaisesRegex(ValueError,"safely grantable"):
            approve_request(self.registry,stale,now=20)
        with self.assertRaisesRegex(ValueError,"jobs_database_unavailable"):
            _safe_db(Path(self.temp.name)/"missing.sqlite3")

if __name__=="__main__": unittest.main()
