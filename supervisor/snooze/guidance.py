"""Durable incident handoff to bounded local reasoning. Never sends paid instructions.

Observers supply normalized status metadata, never prompts or provider payloads.
Completion needs a verified output receipt; idle is only a request for review.
"""
import argparse
from contextlib import closing
from hashlib import sha256
import json
import os
import re
import sqlite3
import time
from pathlib import Path


def identity(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', value):
        raise ValueError('invalid_identity')
    return value


class GuidanceInbox:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with closing(self.connection()) as db:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS watched_workers(
                id TEXT PRIMARY KEY, status TEXT, fingerprint TEXT, progress_at REAL,
                heartbeat_at REAL, model TEXT, owner TEXT, job TEXT);
              CREATE TABLE IF NOT EXISTS monitor_registrations(
                id TEXT PRIMARY KEY, project TEXT NOT NULL, owner TEXT NOT NULL,
                account_id TEXT NOT NULL, session_id TEXT NOT NULL,
                model TEXT NOT NULL, registered_at REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS guidance_events(
                id INTEGER PRIMARY KEY, worker TEXT, kind TEXT, model TEXT, at REAL,
                owner TEXT, job TEXT, ack_at REAL, guidance_state TEXT, guidance_job TEXT,
                submitted_at REAL);
            ''')
        self.path.chmod(0o600)

    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def observe(self, worker, observation, *, owner, job, now=None, stall_seconds=900):
        worker, owner, job = map(identity, (worker, owner, job))
        now = time.time() if now is None else now
        if type(stall_seconds) is not int or not 30 <= stall_seconds <= 86400: raise ValueError('invalid_stall_interval')
        if not isinstance(observation, dict): raise ValueError('invalid_observation')
        raw = observation.get('state', 'unknown')
        states = {'running', 'idle', 'failed', 'unavailable', 'unknown', 'completed', 'cancelled'}
        status = raw if raw in states else 'unknown'
        if observation.get('needsInput') is True: status = 'needs_instructions'
        elif status == 'completed' and observation.get('verifiedOutput') is not True: status = 'idle'
        model = observation.get('model')
        if model is not None: model = identity(model)
        count = observation.get('promptCount')
        if type(count) is not int or count < 0: count = None
        fingerprint = json.dumps([status, model, count])
        db = self.connection()
        try:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT * FROM watched_workers WHERE id=?', (worker,)).fetchone()
            if previous and (previous['owner'] != owner or previous['job'] != job):
                raise ValueError('worker_ownership_conflict')
            progress = previous['progress_at'] if previous and previous['fingerprint'] == fingerprint else now
            if status == 'running' and now - progress >= stall_seconds: status = 'stalled'
            db.execute('INSERT INTO watched_workers VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET '
                       'status=excluded.status,fingerprint=excluded.fingerprint,progress_at=excluded.progress_at,'
                       'heartbeat_at=excluded.heartbeat_at,model=excluded.model',
                       (worker, status, fingerprint, progress, now, model, owner, job))
            event = None
            if not previous or previous['status'] != status or previous['model'] != model:
                kind = 'idle_needs_review' if status == 'idle' else status
                guidance = 'queued' if status in {'failed', 'stalled', 'needs_instructions'} else 'inbox_only'
                event = db.execute('INSERT INTO guidance_events(worker,kind,model,at,owner,job,guidance_state) VALUES(?,?,?,?,?,?,?)',
                                   (worker, kind, model, now, owner, job, guidance)).lastrowid
            db.commit()
            return {'eventId': event, 'state': status, 'model': model, 'heartbeatAt': now}
        except BaseException:
            db.rollback()
            raise
        finally: db.close()

    def register(self, *, worker, project, owner, account, session, model):
        worker, project, owner, account, session, model = map(identity, (worker, project, owner, account, session, model))
        now = time.time()
        db = self.connection()
        try:
            with db:
                previous = db.execute('SELECT project,owner,account_id,session_id,model FROM monitor_registrations WHERE id=?', (worker,)).fetchone()
                binding = (project, owner, account, session, model)
                if previous and tuple(previous) != binding:
                    raise ValueError('worker_registration_conflict')
                db.execute('INSERT OR IGNORE INTO monitor_registrations VALUES(?,?,?,?,?,?,?)',
                           (worker, project, owner, account, session, model, now))
            return {'registered': True, 'worker': worker}
        finally:
            db.close()

    def sync_project(self, project, workers):
        project = identity(project)
        if not isinstance(workers, list) or len(workers) > 1000: raise ValueError('invalid_registration_list')
        normalized = []
        seen = set()
        for item in workers:
            if not isinstance(item, dict) or set(item) != {'worker','owner','account','session','model'}: raise ValueError('invalid_registration')
            row = {key:identity(item[key]) for key in ('worker','owner','account','session','model')}
            if row['worker'] in seen: raise ValueError('duplicate_registration')
            seen.add(row['worker']); normalized.append(row)
        now = time.time()
        db = self.connection()
        try:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM monitor_registrations WHERE project=?', (project,))
            db.executemany('INSERT INTO monitor_registrations VALUES(?,?,?,?,?,?,?)',
                           [(row['worker'],project,row['owner'],row['account'],row['session'],row['model'],now) for row in normalized])
            db.commit()
            return {'project':project,'registered':len(normalized)}
        except BaseException:
            db.rollback(); raise
        finally: db.close()

    def registrations(self):
        db = self.connection()
        try:
            return [dict(row) for row in db.execute('SELECT id,project,owner,account_id,session_id,model FROM monitor_registrations ORDER BY project,owner,id')]
        finally:
            db.close()

    def project_workers(self, *, project, owners):
        project = identity(project)
        if not isinstance(owners, list) or len(owners) > 50: raise ValueError('invalid_owners')
        safe_owners = list(dict.fromkeys(identity(owner) for owner in owners))
        if not safe_owners: return []
        placeholders = ','.join('?' for _ in safe_owners)
        db = self.connection()
        try:
            rows = db.execute(
                'SELECT r.id,r.account_id,r.session_id,r.model AS registered_model,w.status,w.model AS reported_model,'
                'w.heartbeat_at,w.progress_at FROM monitor_registrations r LEFT JOIN watched_workers w '
                'ON w.id=r.id AND w.owner=r.owner AND w.job=r.project '
                f'WHERE r.project=? AND r.owner IN ({placeholders}) ORDER BY r.id',
                (project, *safe_owners),
            )
            return [{'id':row['id'],'accountId':row['account_id'],'sessionId':row['session_id'],
                     'model':row['reported_model'] or row['registered_model'],
                     'modelSource':'observed' if row['reported_model'] else 'registered',
                     'state':row['status'] or 'unobserved','heartbeatAt':row['heartbeat_at'],
                     'lastProgressAt':row['progress_at']} for row in rows]
        finally:
            db.close()

    def inbox(self, *, after=0, owner=None, job=None, limit=100):
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 100: raise ValueError('invalid_page')
        db = self.connection()
        try:
            query, args = 'SELECT * FROM guidance_events WHERE id>?', [after]
            if owner is not None: query += ' AND owner=?'; args.append(identity(owner))
            if job is not None: query += ' AND job=?'; args.append(identity(job))
            return [dict(r) for r in db.execute(query+' ORDER BY id LIMIT ?', (*args, limit))]
        finally: db.close()

    def acknowledge(self, event_id, *, owner, job=None):
        if type(event_id) is not int or event_id < 1: raise ValueError('invalid_event')
        db = self.connection()
        try:
            with db:
                query = 'UPDATE guidance_events SET ack_at=COALESCE(ack_at,?) WHERE id=? AND owner=?'
                args = [time.time(), event_id, identity(owner)]
                if job is not None: query += ' AND job=?'; args.append(identity(job))
                n = db.execute(query, args).rowcount
            if not n: raise ValueError('event_not_owned')
        finally: db.close()

    def acknowledge_project(self, event_id, *, owners, project):
        if type(event_id) is not int or event_id < 1: raise ValueError('invalid_event')
        if not isinstance(owners, list) or not owners or len(owners) > 50: raise ValueError('invalid_owners')
        safe_owners = list(dict.fromkeys(identity(owner) for owner in owners))
        placeholders = ','.join('?' for _ in safe_owners)
        db = self.connection()
        try:
            with db:
                n = db.execute(f'UPDATE guidance_events SET ack_at=COALESCE(ack_at,?) WHERE id=? AND job=? AND owner IN ({placeholders})',
                               (time.time(), event_id, identity(project), *safe_owners)).rowcount
            if not n: raise ValueError('event_not_owned')
        finally: db.close()

    def dispatch_guidance(self, pool, *, now=None, hourly_limit=5):
        """Unique stable local job IDs make cross-database handoff restart-safe."""
        now = time.time() if now is None else now
        if type(hourly_limit) is not int or not 1 <= hourly_limit <= 10: raise ValueError('invalid_limit')
        db = self.connection()
        try:
            db.execute('BEGIN IMMEDIATE')
            used = db.execute('SELECT count(*) FROM guidance_events WHERE guidance_state="submitted" AND submitted_at>?', (now-3600,)).fetchone()[0]
            rows = db.execute('SELECT * FROM guidance_events WHERE guidance_state="queued" ORDER BY id LIMIT ?', (max(0,hourly_limit-used),)).fetchall()
            for row in rows:
                reference = 'guidance-'+sha256(str(self.path.resolve()).encode()).hexdigest()[:12]+'-'+str(row['id'])
                prompt = ('Review this sanitized worker incident. Return at most five concise diagnostic or recovery recommendations. '
                          'You cannot execute actions. Never recommend blind retries, spending without a verified ceiling, merging, deleting, '
                          'or assuming idle means success. Escalate missing information. '
                          + json.dumps({k:row[k] for k in ('worker','kind','model','job')}))
                pool.submit(prompt, model='qwen3.5:9b', job_id=reference, source='worker-incident:'+str(row['id']))
                db.execute('UPDATE guidance_events SET guidance_state="submitted",guidance_job=?,submitted_at=? WHERE id=?', (reference,now,row['id']))
            db.commit()
            return len(rows)
        except BaseException:
            db.rollback()
            raise
        finally: db.close()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('command', choices=['observe','inbox','guide','ack','ack-project','register','sync-project','registrations','project-snapshot'])
    parser.add_argument('--pool-config', type=Path)
    parser.add_argument('--pool-db', type=Path)
    parser.add_argument('--project')
    parser.add_argument('--after', type=int, default=0)
    parser.add_argument('--limit', type=int, default=20)
    args = parser.parse_args()
    inbox = GuidanceInbox(args.db)
    if args.command == 'observe':
        import sys
        raw = sys.stdin.buffer.read(16385)
        if len(raw)>16384: raise ValueError('input_too_large')
        item = json.loads(raw)
        result = inbox.observe(item['worker'],item['observation'],owner=item['owner'],job=item['job'])
    elif args.command == 'guide':
        from snooze.oracle_pool import OraclePool
        result = {'submitted':inbox.dispatch_guidance(OraclePool(config_path=args.pool_config,db_path=args.pool_db))}
    elif args.command == 'ack':
        import sys
        item=json.loads(sys.stdin.buffer.read(4096));inbox.acknowledge(item['eventId'],owner=item['owner'],job=item.get('project'));result={'acknowledged':True}
    elif args.command == 'ack-project':
        import sys
        item=json.loads(sys.stdin.buffer.read(8192));inbox.acknowledge_project(item['eventId'],owners=item['owners'],project=item['project']);result={'acknowledged':True,'eventId':item['eventId']}
    elif args.command == 'register':
        import sys
        item=json.loads(sys.stdin.buffer.read(8192))
        result=inbox.register(worker=item['worker'],project=item['project'],owner=item['owner'],account=item['account'],session=item['session'],model=item['model'])
    elif args.command == 'sync-project':
        import sys
        item=json.loads(sys.stdin.buffer.read(1_048_577))
        if len(json.dumps(item,separators=(',',':')).encode('utf-8'))>1_048_576: raise ValueError('input_too_large')
        result=inbox.sync_project(item['project'],item['workers'])
    elif args.command == 'registrations':
        result={'workers':inbox.registrations()}
    elif args.command == 'project-snapshot':
        if not args.project or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}',args.project): raise ValueError('invalid_project')
        if not 0 <= args.after <= 2**63-1 or not 1 <= args.limit <= 20: raise ValueError('invalid_page')
        import sys
        payload=json.loads(sys.stdin.buffer.read(16384) or b'{}')
        owners=payload.get('owners')
        if not isinstance(owners,list) or len(owners)>50 or not all(isinstance(x,str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}',x) for x in owners): raise ValueError('invalid_owners')
        events=[]
        for owner in owners: events.extend(inbox.inbox(after=args.after,owner=owner,job=args.project,limit=args.limit))
        events=sorted(events,key=lambda row:row['id'])[:args.limit]
        from snooze.oracle_pool import OraclePool
        pool=OraclePool(config_path=args.pool_config,db_path=args.pool_db)
        enriched=[]
        for row in events:
            item={k:row[k] for k in ('id','worker','kind','model','at','job','ack_at','guidance_state','guidance_job','submitted_at')}
            task=None; result_text=None
            if row['guidance_job']:
                try:
                    task=pool.status(row['guidance_job'])
                    if task.get('status')=='complete':
                        result_text=pool.results(row['guidance_job']).get('result')
                except KeyError:
                    pass
            item['oracle']={k:task.get(k) for k in ('status','model','actual_model','assigned_host','attempts','error_code','prompt_tokens','eval_tokens','remote_seconds','elapsed_seconds') if task and task.get(k) is not None}
            if isinstance(result_text,str): item['oracle']['result']=result_text[:16000]
            enriched.append(item)
        catalog=pool.catalog(refresh=False)
        models=[{'host':h['id'],'models':h['models'],'updated':h['updated'],'error':h['error_code']} for h in catalog.get('hosts',[])]
        result={'available':True,'project':args.project,'workers':inbox.project_workers(project=args.project,owners=owners),
                'events':enriched,'models':models,'cursor':events[-1]['id'] if events else args.after,'hasMore':len(events)==args.limit}
    else: result = inbox.inbox()
    print(json.dumps(result))


if __name__ == '__main__': main()
