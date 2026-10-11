import tempfile
import unittest
from pathlib import Path
from snooze.guidance import GuidanceInbox


class Pool:
    def __init__(self): self.jobs={}
    def submit(self,text,**kw):
        key=kw['job_id']; payload=(text,kw)
        if key in self.jobs and self.jobs[key]!=payload: raise ValueError('idempotency_conflict')
        self.jobs[key]=payload


class GuidanceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'inbox.sqlite';self.inbox=GuidanceInbox(self.path)

    def observe(self,state,now=0,worker='worker-a',**extras):
        return self.inbox.observe(worker,{'state':state,'model':'qwen3.5:9b',**extras},owner='client-a',job='job-a',now=now,stall_seconds=60)

    def test_heartbeat_dedup_stall_and_recovery(self):
        self.observe('running');self.observe('running',now=20)
        self.assertEqual(len(self.inbox.inbox()),1)
        self.assertEqual(self.observe('running',now=61)['state'],'stalled')
        self.observe('running',now=62)
        self.assertEqual(len(self.inbox.inbox()),2)
        self.observe('running',now=63,promptCount=1)
        self.assertEqual(self.inbox.inbox()[-1]['kind'],'running')

    def test_idle_never_proves_completion_and_model_persists(self):
        self.observe('completed')
        self.assertEqual(self.inbox.inbox()[0]['kind'],'idle_needs_review')
        self.assertEqual(GuidanceInbox(self.path).inbox()[0]['model'],'qwen3.5:9b')
        self.observe('completed',now=1,verifiedOutput=True)
        self.assertEqual(self.inbox.inbox()[-1]['kind'],'completed')

    def test_ownership_and_ack(self):
        self.observe('failed')
        with self.assertRaises(ValueError):self.inbox.observe('worker-a',{'state':'idle'},owner='client-b',job='job-a')
        self.assertEqual(self.inbox.inbox(owner='client-b'),[])
        with self.assertRaises(ValueError):self.inbox.acknowledge(1,owner='client-b')
        self.inbox.acknowledge(1,owner='client-a')
        self.assertIsNotNone(self.inbox.inbox()[0]['ack_at'])

    def test_durable_guidance_handoff_rate_limit_and_no_idle_inference(self):
        self.observe('idle');pool=Pool()
        self.assertEqual(self.inbox.dispatch_guidance(pool,now=1),0)
        for n in range(7):self.observe('failed',worker='worker-'+str(n))
        self.assertEqual(self.inbox.dispatch_guidance(pool,now=10000),5)
        self.assertEqual(GuidanceInbox(self.path).dispatch_guidance(pool,now=10001),0)
        self.assertEqual(self.inbox.dispatch_guidance(pool,now=13601),2)
        self.assertEqual(len(pool.jobs),7)

    def test_ambiguous_local_queue_receipt_reuses_job_id(self):
        self.observe('failed');pool=Pool();original=pool.submit
        def submit(text,**kw):
            original(text,**kw)
            raise TimeoutError('receipt lost')
        pool.submit=submit
        with self.assertRaises(TimeoutError):self.inbox.dispatch_guidance(pool)
        pool.submit=original
        self.assertEqual(GuidanceInbox(self.path).dispatch_guidance(pool),1)
        self.assertEqual(len(pool.jobs),1)


if __name__=='__main__':unittest.main()
