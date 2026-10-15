import tempfile
import unittest
from pathlib import Path
import sqlite3
import json
import os
import subprocess
import sys
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

    def test_monitor_registration_is_stable_and_project_scoped(self):
        self.inbox.register(worker='worker-hash',project='project-a',owner='oauth-client:client-a',account='acct-a',session='session-a',model='gpt-6-luna')
        self.inbox.register(worker='worker-hash',project='project-a',owner='oauth-client:client-a',account='acct-a',session='session-a',model='gpt-6-luna')
        self.assertEqual(self.inbox.registrations(),[{'id':'worker-hash','project':'project-a','owner':'oauth-client:client-a','account_id':'acct-a','session_id':'session-a','model':'gpt-6-luna'}])
        roster=self.inbox.project_workers(project='project-a',owners=['oauth-client:client-a'])
        self.assertEqual(roster[0]['state'],'unobserved')
        self.assertEqual(roster[0]['modelSource'],'registered')
        self.assertEqual(self.inbox.project_workers(project='project-a',owners=['oauth-client:other']),[])
        with self.assertRaisesRegex(ValueError,'worker_registration_conflict'):
            self.inbox.register(worker='worker-hash',project='project-b',owner='oauth-client:client-a',account='acct-a',session='session-a',model='gpt-6-luna')

    def test_project_sync_removes_sessions_no_longer_registered(self):
        self.inbox.sync_project('project-a',[{'worker':'worker-old','owner':'client-a','account':'acct-a','session':'session-old','model':'gpt-6-luna'}])
        self.inbox.sync_project('project-a',[{'worker':'worker-new','owner':'client-a','account':'acct-a','session':'session-new','model':'claude-opus-5-5'}])
        self.inbox.sync_project('project-b',[{'worker':'worker-b','owner':'client-a','account':'acct-b','session':'session-b','model':'qwen3.5:9b'}])
        self.assertEqual([row['id'] for row in self.inbox.registrations()],['worker-new','worker-b'])
        self.assertEqual(self.inbox.project_workers(project='project-a',owners=['client-a'])[0]['sessionId'],'session-new')

    def test_project_inbox_and_ack_cannot_cross_job_even_for_same_owner(self):
        self.inbox.observe('worker-a',{'state':'failed','model':'qwen3.5:9b'},owner='client-a',job='project-a')
        self.inbox.observe('worker-b',{'state':'failed','model':'qwen3.5:9b'},owner='client-a',job='project-b')
        self.assertEqual(len(self.inbox.inbox(owner='client-a',job='project-a')),1)
        with self.assertRaisesRegex(ValueError,'event_not_owned'):
            self.inbox.acknowledge(1,owner='client-a',job='project-b')
        self.inbox.acknowledge_project(1,owners=['client-b','client-a'],project='project-a')
        self.assertIsNotNone(self.inbox.inbox(owner='client-a',job='project-a')[0]['ack_at'])

    def test_question_is_bounded_redacted_deduplicated_and_cleared(self):
        self.inbox.register(worker='worker-a',project='job-a',owner='client-a',account='acct-a',session='session-a',model='qwen3.5:9b')
        first=self.inbox.observe('worker-a',{'state':'idle','needsInput':True,'promptCount':3,
            'question':{'text':'Please choose; api_key=never-store','choices':['Continue','Stop'],'kind':'approval'}},
            owner='client-a',job='job-a',now=10)
        self.assertEqual(first['state'],'needs_approval')
        self.assertEqual(first['question']['text'],'Please choose; [redacted]')
        unchanged=self.inbox.observe('worker-a',{'state':'idle','needsInput':True,'promptCount':3,
            'question':{'text':'Please choose; api_key=never-store','choices':['Continue','Stop'],'kind':'approval'}},
            owner='client-a',job='job-a',now=11)
        self.assertIsNone(unchanged['eventId'])
        workers=self.inbox.project_workers(project='job-a',owners=['client-a'])
        self.assertEqual(workers[0]['promptCount'],3)
        self.assertEqual(workers[0]['question']['kind'],'approval')
        self.assertEqual(self.inbox.project_workers(project='job-a',owners=['client-b']),[])
        self.assertEqual(self.inbox.inbox(owner='client-b',job='job-a'),[])
        self.assertEqual(self.inbox.inbox(owner='client-a',job='job-a')[0]['question']['text'],'Please choose; [redacted]')
        changed=self.inbox.observe('worker-a',{'state':'idle','needsInput':True,'promptCount':4,
            'question':{'text':'Provide the missing branch'}},owner='client-a',job='job-a',now=12)
        self.assertIsNotNone(changed['eventId'])
        self.assertEqual(self.inbox.inbox(owner='client-a',job='job-a')[-1]['question']['text'],'Provide the missing branch')
        self.inbox.observe('worker-a',{'state':'idle','needsInput':True,'question':{'unrecognized':'raw private payload'}},
                           owner='client-a',job='job-a',now=13)
        self.assertIsNone(self.inbox.project_workers(project='job-a',owners=['client-a'])[0]['question'])
        self.inbox.observe('worker-a',{'state':'idle','needsInput':False},owner='client-a',job='job-a',now=14)
        self.assertIsNone(self.inbox.project_workers(project='job-a',owners=['client-a'])[0]['question'])
        with self.inbox.connection() as db:
            stored=db.execute('SELECT question_json,heartbeat_at FROM watched_workers WHERE id=?',('worker-a',)).fetchone()
        self.assertIsNone(stored['question_json'])
        self.assertEqual(stored['heartbeat_at'],14)

    def test_oversized_question_is_omitted_but_needs_input_is_preserved(self):
        result=self.inbox.observe('worker-a',{'state':'idle','needsInput':True,'question':{'text':'x'*3000}},
                                  owner='client-a',job='job-a')
        self.assertEqual(result['state'],'needs_instructions')
        self.assertIsNone(result['question'])
        self.assertIsNone(self.inbox.inbox()[0]['question'])

    def test_existing_database_migrates_question_columns(self):
        path=Path(self.temp.name)/'legacy.sqlite'
        with sqlite3.connect(path) as db:
            db.executescript('''CREATE TABLE watched_workers(id TEXT PRIMARY KEY,status TEXT,fingerprint TEXT,progress_at REAL,heartbeat_at REAL,model TEXT,owner TEXT,job TEXT);
                CREATE TABLE monitor_registrations(id TEXT PRIMARY KEY,project TEXT NOT NULL,owner TEXT NOT NULL,account_id TEXT NOT NULL,session_id TEXT NOT NULL,model TEXT NOT NULL,registered_at REAL NOT NULL);
                CREATE TABLE guidance_events(id INTEGER PRIMARY KEY,worker TEXT,kind TEXT,model TEXT,at REAL,owner TEXT,job TEXT,ack_at REAL,guidance_state TEXT,guidance_job TEXT,submitted_at REAL);''')
        migrated=GuidanceInbox(path)
        with migrated.connection() as db:
            worker_cols={row[1] for row in db.execute('PRAGMA table_info(watched_workers)')}
            event_cols={row[1] for row in db.execute('PRAGMA table_info(guidance_events)')}
        self.assertTrue({'prompt_count','question_json'} <= worker_cols)
        self.assertTrue({'prompt_count','question_json'} <= event_cols)


    def test_provider_error_overrides_idle_and_survives_restart_without_duplicate(self):
        self.inbox.register(worker='worker-a',project='job-a',owner='client-a',
                            account='acct-a',session='session-a',model='gpt-6-luna')
        first = self.inbox.observe('worker-a', {'state':'idle','errorCode':'ACP_RELAY_DIED',
            'model':'claude-opus-5-5','promptCount':2},owner='client-a',job='job-a',now=10)
        self.assertEqual(first['state'], 'failed')
        reopened = GuidanceInbox(self.path)
        unchanged = reopened.observe('worker-a', {'state':'idle','errorCode':'ACP_RELAY_DIED',
            'model':'claude-opus-5-5','promptCount':2},owner='client-a',job='job-a',now=20)
        self.assertIsNone(unchanged['eventId'])
        snapshot = reopened.compact_summary(project='job-a',owners=['client-a'])
        self.assertEqual(snapshot['workers'][0]['errorCode'],'ACP_RELAY_DIED')
        self.assertTrue(snapshot['workers'][0]['needsAction'])
        self.assertEqual(snapshot['workers'][0]['accountId'],'acct-a')
        self.assertIsNone(snapshot['workers'][0]['registeredModel'])
        self.assertEqual(snapshot['workers'][0]['reportedModel'],'claude-opus-5-5')
        self.assertEqual(len(snapshot['events']),1)
        self.assertEqual(snapshot['events'][0]['errorCode'],'ACP_RELAY_DIED')
        self.assertNotIn('prompt', str(snapshot).lower())
        reopened.acknowledge(snapshot['events'][0]['id'],owner='client-a',job='job-a')
        self.assertIsNotNone(reopened.compact_summary(project='job-a',owners=['client-a'])['events'][0]['ackAt'])

    def test_native_approval_handoff_not_automatically_guided(self):
        event = self.observe('idle', now=1, needsInput=True,
                             question={'kind':'approval','text':'Allow a sensitive action?'})
        self.assertEqual(event['state'],'needs_approval')
        self.assertEqual(self.inbox.inbox()[0]['guidance_state'],'inbox_only')
        self.assertEqual(self.inbox.dispatch_guidance(Pool(),now=2),0)

    def test_error_code_only_stores_safe_class_and_summary_bounds(self):
        self.observe('idle',now=1,errorCode='api_key=private-value')
        self.assertEqual(self.inbox.inbox()[0]['errorCode'],'provider_execution_error')
        self.assertEqual(self.inbox.compact_summary(project='job-a',owners=['client-a'])['events'][0]['errorCode'],'provider_execution_error')



    def test_separate_monitor_cli_processes_recover_durable_events(self):
        env = {**os.environ, 'HOME':self.temp.name,
               'TOKEN2OAUTH_CONFIG_DIR':str(Path(self.temp.name)/'config')}
        def invoke(command, payload, *args):
            outcome = subprocess.run([sys.executable, '-m', 'snooze.guidance',
                '--db', str(self.path), command, *args], input=json.dumps(payload),
                text=True, capture_output=True, env=env, timeout=10)
            self.assertEqual(outcome.returncode, 0, outcome.stderr)
            return json.loads(outcome.stdout)
        first = invoke('observe', {'worker':'worker-restart', 'owner':'client-a', 'job':'job-a',
            'observation':{'state':'idle','errorCode':'ACP_RELAY_DIED'}})
        self.assertEqual(first['state'], 'failed')
        later = invoke('compact-summary', {'owners':['client-a']}, '--project','job-a')
        self.assertEqual(len(later['events']), 1)
        self.assertEqual(later['events'][0]['errorCode'], 'ACP_RELAY_DIED')
        duplicate = invoke('observe', {'worker':'worker-restart', 'owner':'client-a', 'job':'job-a',
            'observation':{'state':'idle','errorCode':'ACP_RELAY_DIED'}})
        self.assertIsNone(duplicate['eventId'])

if __name__=='__main__':unittest.main()
