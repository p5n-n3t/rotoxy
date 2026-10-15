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

MAX_QUESTION_BYTES = 2048
QUESTION_KINDS = {'question', 'review', 'approval', 'unknown'}
QUESTION_ID = re.compile(r'[A-Za-z0-9_.:-]{1,128}')
SECRET_PATTERNS = (
    re.compile(r'\bBearer\s+[^\s,;]+', re.I),
    re.compile(r'\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)\s*[:=]\s*["\']?[^\s,;"\']+', re.I),
    re.compile(r'\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b'),
)


def _safe_question_text(value):
    if not isinstance(value, str) or not value.strip():
        return None
    for pattern in SECRET_PATTERNS:
        value = pattern.sub('[redacted]', value)
    return value


def normalize_question(value):
    """Accept only the small normalized projection; unknown provider data is omitted."""
    if not isinstance(value, dict):
        return None
    text = _safe_question_text(value.get('text'))
    if text is None:
        return None
    raw_kind = value.get('kind')
    result = {'text': text, 'source': 'provider',
              'kind': raw_kind if isinstance(raw_kind, str) and raw_kind in QUESTION_KINDS else 'question'}
    if isinstance(value.get('id'), str) and QUESTION_ID.fullmatch(value['id']):
        result['id'] = value['id']
    if 'choices' in value:
        choices = value['choices']
        if not isinstance(choices, list) or len(choices) > 12:
            return None
        safe_choices = [_safe_question_text(item) for item in choices]
        if any(item is None for item in safe_choices):
            return None
        result['choices'] = safe_choices
    if len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > MAX_QUESTION_BYTES:
        return None
    return result


def normalized_error_code(value):
    if value is None or value == '':
        return None
    if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', value):
        return value
    # Never persist raw provider error text: it can include private URLs or tokens.
    return 'provider_execution_error'


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
                heartbeat_at REAL, model TEXT, owner TEXT, job TEXT,
                prompt_count INTEGER, question_json TEXT);
              CREATE TABLE IF NOT EXISTS monitor_registrations(
                id TEXT PRIMARY KEY, project TEXT NOT NULL, owner TEXT NOT NULL,
                account_id TEXT NOT NULL, session_id TEXT NOT NULL,
                model TEXT NOT NULL, registered_at REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS guidance_events(
                id INTEGER PRIMARY KEY, worker TEXT, kind TEXT, model TEXT, at REAL,
                owner TEXT, job TEXT, ack_at REAL, guidance_state TEXT, guidance_job TEXT,
                submitted_at REAL, prompt_count INTEGER, question_json TEXT);
            ''')
            db.execute('BEGIN IMMEDIATE')
            for table, columns in {
                'watched_workers': {'prompt_count': 'INTEGER', 'question_json': 'TEXT', 'error_code': 'TEXT'},
                'guidance_events': {'prompt_count': 'INTEGER', 'question_json': 'TEXT', 'account_id':'TEXT', 'session_id':'TEXT', 'error_code':'TEXT'},
            }.items():
                present = {row[1] for row in db.execute(f'PRAGMA table_info({table})')}
                for name, kind in columns.items():
                    if name not in present:
                        db.execute(f'ALTER TABLE {table} ADD COLUMN {name} {kind}')
            db.commit()
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
        states = {'running', 'idle', 'failed', 'unavailable', 'unknown', 'completed', 'cancelled', 'timed_out', 'ambiguous'}
        status = raw if raw in states else 'unknown'
        error_code = normalized_error_code(observation.get('errorCode'))
        question = normalize_question(observation.get('question'))
        if error_code is not None: status = 'failed'
        elif status not in {'failed', 'cancelled', 'timed_out', 'ambiguous'} and observation.get('needsInput') is True:
            status = 'needs_approval' if question and question['kind'] == 'approval' else 'needs_instructions'
        elif status == 'completed' and observation.get('verifiedOutput') is not True: status = 'idle'
        model = observation.get('model')
        if model is not None: model = identity(model)
        count = observation.get('promptCount')
        if type(count) is not int or count < 0: count = None
        question_json = json.dumps(question, ensure_ascii=False, sort_keys=True, separators=(',', ':')) if question else None
        fingerprint = json.dumps([status, model, count, question_json, error_code], separators=(',', ':'))
        db = self.connection()
        try:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT * FROM watched_workers WHERE id=?', (worker,)).fetchone()
            if previous and (previous['owner'] != owner or previous['job'] != job):
                raise ValueError('worker_ownership_conflict')
            progress = previous['progress_at'] if previous and previous['fingerprint'] == fingerprint else now
            if status == 'running' and now - progress >= stall_seconds: status = 'stalled'
            db.execute('INSERT INTO watched_workers(id,status,fingerprint,progress_at,heartbeat_at,model,owner,job,prompt_count,question_json,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET '
                       'status=excluded.status,fingerprint=excluded.fingerprint,progress_at=excluded.progress_at,'
                       'heartbeat_at=excluded.heartbeat_at,model=excluded.model,prompt_count=excluded.prompt_count,question_json=excluded.question_json,error_code=excluded.error_code',
                       (worker, status, fingerprint, progress, now, model, owner, job, count, question_json, error_code))
            event = None
            if not previous or previous['status'] != status or previous['model'] != model or previous['question_json'] != question_json or previous['error_code'] != error_code:
                kind = 'idle_needs_review' if status == 'idle' else status
                guidance = 'queued' if status in {'failed', 'stalled', 'needs_instructions', 'timed_out', 'ambiguous'} else 'inbox_only'
                binding = db.execute('SELECT account_id,session_id FROM monitor_registrations WHERE id=? AND project=? AND owner=?', (worker,job,owner)).fetchone()
                event = db.execute('INSERT INTO guidance_events(worker,kind,model,at,owner,job,guidance_state,prompt_count,question_json,account_id,session_id,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                                   (worker, kind, model, now, owner, job, guidance, count, question_json, binding['account_id'] if binding else None, binding['session_id'] if binding else None, error_code)).lastrowid
            db.commit()
            return {'eventId': event, 'state': status, 'model': model, 'promptCount': count,
                    'question': question, 'errorCode': error_code, 'heartbeatAt': now}
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
                'w.heartbeat_at,w.progress_at,w.prompt_count,w.question_json,w.error_code FROM monitor_registrations r LEFT JOIN watched_workers w '
                'ON w.id=r.id AND w.owner=r.owner AND w.job=r.project '
                f'WHERE r.project=? AND r.owner IN ({placeholders}) ORDER BY r.id',
                (project, *safe_owners),
            )
            return [{'id':row['id'],'accountId':row['account_id'],'sessionId':row['session_id'],
                     'model':row['reported_model'] or row['registered_model'],
                     'modelSource':'observed' if row['reported_model'] else 'registered',
                     'state':row['status'] or 'unobserved','heartbeatAt':row['heartbeat_at'],
                     'lastProgressAt':row['progress_at'],'promptCount':row['prompt_count'],
                     'question':json.loads(row['question_json']) if row['question_json'] else None,
                     'errorCode':row['error_code']} for row in rows]
        finally:
            db.close()

    def inbox(self, *, after=0, owner=None, job=None, limit=100):
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 100: raise ValueError('invalid_page')
        db = self.connection()
        try:
            query, args = 'SELECT * FROM guidance_events WHERE id>?', [after]
            if owner is not None: query += ' AND owner=?'; args.append(identity(owner))
            if job is not None: query += ' AND job=?'; args.append(identity(job))
            output = []
            for row in db.execute(query+' ORDER BY id LIMIT ?', (*args, limit)):
                item = dict(row)
                encoded = item.pop('question_json', None)
                item['question'] = json.loads(encoded) if encoded else None
                item['accountId'] = item.pop('account_id', None)
                item['sessionId'] = item.pop('session_id', None)
                item['errorCode'] = item.pop('error_code', None)
                output.append(item)
            return output
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


    def compact_summary(self, *, project, owners, after=0, limit=20):
        """Private bounded projection. No transcripts, prompts, credentials, or guessed capacity."""
        project = identity(project)
        if not isinstance(owners, list) or not 1 <= len(owners) <= 50:
            raise ValueError('invalid_owners')
        owners = list(dict.fromkeys(identity(owner) for owner in owners))
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError('invalid_page')
        roster = self.project_workers(project=project, owners=owners)[:100]
        events = []
        for owner in owners:
            events.extend(self.inbox(after=after, owner=owner, job=project, limit=limit + 1 if limit < 100 else limit))
        events.sort(key=lambda row: row['id'])
        page = events[:limit]
        terminal = {'failed', 'cancelled', 'timed_out', 'ambiguous', 'completed'}
        needs_action = {'failed', 'stalled', 'timed_out', 'ambiguous', 'needs_instructions', 'needs_approval', 'idle'}
        summarized = []
        with closing(self.connection()) as db:
            for worker in roster:
                latest = db.execute(
                    'SELECT id,kind,at,ack_at FROM guidance_events WHERE worker=? AND job=? AND owner IN (' +
                    ','.join('?' for _ in owners) + ') ORDER BY id DESC LIMIT 1',
                    (worker['id'], project, *owners)).fetchone()
                state = worker['state']
                summarized.append({
                    'id': worker['id'], 'accountId': worker['accountId'], 'sessionId': worker['sessionId'],
                    'reportedModel': worker['model'] if worker['modelSource'] == 'observed' else None,
                    'registeredModel': worker['model'] if worker['modelSource'] == 'registered' else None,
                    'state': state, 'terminal': state in terminal, 'needsAction': state in needs_action,
                    'actionOwner': 'operator' if state in needs_action else None,
                    'errorCode': worker['errorCode'], 'heartbeatAt': worker['heartbeatAt'],
                    'lastTransition': ({'eventId': latest['id'], 'kind': latest['kind'], 'at': latest['at'],
                                        'ackAt': latest['ack_at']} if latest else None),
                    'approvalKind': (worker['question'] or {}).get('kind'),
                    'artifactRefs': [], 'usage': {'known': False}, 'capacity': {'known': False},
                })
        return {'project': project, 'workers': summarized,
                'events': [{'id': row['id'], 'worker': row['worker'], 'kind': row['kind'],
                            'at': row['at'], 'errorCode': row['errorCode'],
                            'ackAt': row['ack_at']} for row in page],
                'cursor': page[-1]['id'] if page else after, 'hasMore': len(events) > limit,
                'truncatedWorkers': len(self.project_workers(project=project, owners=owners)) > 100}

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('command', choices=['observe','inbox','guide','ack','ack-project','register','sync-project','registrations','project-snapshot','compact-summary'])
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
    elif args.command == 'compact-summary':
        if not args.project: raise ValueError('invalid_project')
        import sys
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384: raise ValueError('input_too_large')
        payload = json.loads(raw or b'{}')
        result = inbox.compact_summary(project=args.project, owners=payload.get('owners'),
                                       after=args.after, limit=args.limit)
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
            item={k:row[k] for k in ('id','worker','kind','model','at','job','ack_at','guidance_state','guidance_job','submitted_at','prompt_count')}
            item['promptCount'] = item.pop('prompt_count')
            item['question'] = row.get('question')
            item['accountId'], item['sessionId'] = row.get('accountId'), row.get('sessionId')
            item['errorCode'] = row.get('errorCode')
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
