"""Offline teaching lab: deterministic workers, SQLite progress, no paid APIs.

Run: python learning/coordination_lab.py demo
This reproduces engineering mechanisms, not a paper's benchmark results.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


PLAN = [
    {'id': 'collect', 'deps': [], 'capability': 'research'},
    {'id': 'calculate', 'deps': ['collect'], 'capability': 'analysis'},
    {'id': 'write', 'deps': ['calculate'], 'capability': 'writing'},
    {'id': 'review', 'deps': ['write'], 'capability': 'review'},
]
AGENTS = {'researcher': {'research'}, 'analyst': {'analysis'},
          'writer': {'writing'}, 'reviewer': {'review'}}


def validate_plan(plan):
    ids = [t['id'] for t in plan]
    if len(set(ids)) != len(ids):
        raise ValueError('duplicate task id')
    for task in plan:
        if set(task['deps']) - set(ids):
            raise ValueError('unknown dependency')
    done = set()
    while len(done) < len(plan):
        ready = {t['id'] for t in plan if t['id'] not in done
                 and set(t['deps']) <= done}
        if not ready:
            raise ValueError('dependency cycle')
        done |= ready


def route(capability, agents=AGENTS):
    eligible = sorted(a for a, capabilities in agents.items() if capability in capabilities)
    if not eligible:
        raise ValueError(f'no capable agent: {capability}')
    return eligible[0]


def connect(path):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript('''
        CREATE TABLE IF NOT EXISTS task (
            id TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            artifact TEXT);
        CREATE TABLE IF NOT EXISTS event (
            seq INTEGER PRIMARY KEY, task_id TEXT, kind TEXT, data TEXT);
        CREATE TABLE IF NOT EXISTS inbox (message_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS delivery (
            operation_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
    ''')
    with db:
        db.executemany('INSERT OR IGNORE INTO task(id,state) VALUES (?,?)',
                       [(t['id'], 'pending') for t in PLAN])
    return db


def log(db, task, kind, data):
    db.execute('INSERT INTO event(task_id,kind,data) VALUES (?,?,?)',
               (task, kind, json.dumps(data, ensure_ascii=False)))


def worker(task_id, inputs, attempt, scenario):
    # Scripted outputs isolate coordination behavior from LLM randomness.
    if task_id == 'collect':
        return {'source': 'fictional-quarterly-sales-v1', 'sales': [100, 120, 140]}
    if task_id == 'calculate':
        if scenario == 'retry' and attempt == 1:
            raise TimeoutError('injected transient timeout')
        return {'total': sum(inputs['collect']['sales'])}
    if task_id == 'write':
        total = inputs['calculate']['total']
        if scenario == 'repair' and attempt == 1:
            total = 999  # verifier catches this semantic error
        return {'total': total, 'text': f'模拟季度销售总计：{total}。'}
    return {'accepted': True, 'total': inputs['write']['total']}


def check_artifact(task_id, result, inputs):
    if task_id == 'collect':
        valid = (result.get('source') == 'fictional-quarterly-sales-v1'
                 and result.get('sales') == [100, 120, 140])
    elif task_id == 'calculate':
        valid = result.get('total') == sum(inputs['collect']['sales'])
    elif task_id == 'write':
        valid = (result.get('total') == inputs['calculate']['total']
                 and result.get('text') == f"模拟季度销售总计：{result['total']}。")
    else:
        valid = result.get('accepted') is True and result.get('total') == inputs['write']['total']
    if not valid:
        raise ValueError('artifact failed independent deterministic acceptance check')


def deliver(db, message_id, operation_key, payload):
    """Atomic inbox + local business effect; deliberately no external API here."""
    with db:
        if db.execute('SELECT 1 FROM inbox WHERE message_id=?', (message_id,)).fetchone():
            log(db, 'review', 'duplicate_message_ignored', {'message_id': message_id})
            return
        previous = db.execute('SELECT payload FROM delivery WHERE operation_key=?',
                              (operation_key,)).fetchone()
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        if previous and previous['payload'] != encoded:
            raise ValueError('same operation key with different business payload')
        db.execute('INSERT INTO inbox VALUES (?)', (message_id,))
        db.execute('INSERT OR IGNORE INTO delivery VALUES (?,?)', (operation_key, encoded))
        log(db, 'review', 'message_consumed', {'message_id': message_id})


def run(path, scenario='normal', crash_after=None):
    validate_plan(PLAN)
    db = connect(path)
    try:
        # Single-process teaching assumption: an earlier process has exited.
        # Production must use leases/fencing; this unconditional reset is not safe with multiple workers.
        with db:
            for row in db.execute("SELECT id FROM task WHERE state='running'").fetchall():
                db.execute("UPDATE task SET state='pending' WHERE id=?", (row['id'],))
                log(db, row['id'], 'interrupted_attempt_recovered', {})
        for task in PLAN:
            task_id = task['id']
            row = db.execute('SELECT * FROM task WHERE id=?', (task_id,)).fetchone()
            if row['state'] == 'succeeded':
                continue
            if row['state'] == 'failed':
                raise RuntimeError(f'task already terminally failed: {task_id}')
            inputs = {}
            for dep in task['deps']:
                parent = db.execute('SELECT * FROM task WHERE id=?', (dep,)).fetchone()
                if parent['state'] != 'succeeded':
                    raise RuntimeError('dependency is not complete')
                inputs[dep] = json.loads(parent['artifact'])
            agent = route(task['capability'])
            while True:
                row = db.execute('SELECT * FROM task WHERE id=?', (task_id,)).fetchone()
                attempt = row['attempts'] + 1
                if attempt > 2:
                    with db:
                        db.execute("UPDATE task SET state='failed' WHERE id=?", (task_id,))
                    raise RuntimeError('attempt budget exhausted')
                with db:
                    db.execute("UPDATE task SET state='running',attempts=? WHERE id=?", (attempt, task_id))
                    log(db, task_id, 'assigned', {'agent': agent, 'attempt': attempt})
                try:
                    result = worker(task_id, inputs, attempt, scenario)
                    check_artifact(task_id, result, inputs)
                except (TimeoutError, ValueError) as exc:
                    # Deliberately no actual sleep: retry timing is outside this lab's scope.
                    kind = 'transient_retry' if isinstance(exc, TimeoutError) else 'semantic_repair'
                    with db:
                        db.execute("UPDATE task SET state=? WHERE id=?",
                                   ('retry_wait' if attempt < 2 else 'failed', task_id))
                        log(db, task_id, kind, {'attempt': attempt, 'feedback': str(exc)})
                    if attempt >= 2:
                        raise RuntimeError('attempt budget exhausted') from exc
                    # A real LLM repair must receive this feedback. The deterministic worker
                    # produces its corrected second answer from its scripted scenario.
                    continue
                with db:
                    db.execute("UPDATE task SET state='succeeded',artifact=? WHERE id=?",
                               (json.dumps(result, ensure_ascii=False), task_id))
                    log(db, task_id, 'accepted', result)
                if crash_after == task_id:
                    os._exit(17)  # real process exit after committed checkpoint
                break
        # Stable operation identity also deduplicates a resend after process restart.
        reviewed = json.loads(db.execute("SELECT artifact FROM task WHERE id='review'").fetchone()[0])
        payload = {'total': reviewed['total']}
        deliver(db, 'review-result-message', 'publish-simulation-v1', payload)
        if scenario == 'duplicate':
            deliver(db, 'review-result-message', 'publish-simulation-v1', payload)
            deliver(db, 'resend-new-message', 'publish-simulation-v1', payload)
        return snapshot(db)
    finally:
        db.close()


def snapshot(db):
    return {
        'tasks': [dict(r) for r in db.execute('SELECT id,state,attempts FROM task ORDER BY rowid')],
        'delivery_count': db.execute('SELECT count(*) FROM delivery').fetchone()[0],
        'events': [{**dict(r), 'data': json.loads(r['data'])}
                   for r in db.execute('SELECT * FROM event ORDER BY seq')],
    }


class MechanismTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / 'state.sqlite')

    def test_normal_routes_and_dependency_order(self):
        result = run(self.path)
        self.assertEqual([e['task_id'] for e in result['events'] if e['kind'] == 'accepted'],
                         ['collect', 'calculate', 'write', 'review'])
        self.assertTrue(all(t['state'] == 'succeeded' for t in result['tasks']))

    def test_transient_retry_preserves_upstream(self):
        result = run(self.path, 'retry')
        self.assertEqual([t['attempts'] for t in result['tasks']], [1, 2, 1, 1])
        self.assertTrue(any(e['kind'] == 'transient_retry' for e in result['events']))

    def test_invalid_output_not_accepted(self):
        result = run(self.path, 'repair')
        self.assertEqual([t['attempts'] for t in result['tasks']], [1, 1, 2, 1])
        accepted = [e for e in result['events'] if e['task_id'] == 'write' and e['kind'] == 'accepted']
        self.assertEqual(accepted[0]['data']['total'], 360)

    def test_process_exit_and_resume(self):
        process = subprocess.run([sys.executable, str(Path(__file__).resolve()), 'run',
                                  '--db', self.path, '--crash-after', 'calculate'],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 17, process.stderr)
        result = run(self.path)
        self.assertEqual([t['attempts'] for t in result['tasks']], [1, 1, 1, 1])
        self.assertEqual(result['delivery_count'], 1)

    def test_duplicate_delivery_and_resume(self):
        result = run(self.path, 'duplicate')
        self.assertEqual(result['delivery_count'], 1)
        self.assertTrue(any(e['kind'] == 'duplicate_message_ignored' for e in result['events']))
        self.assertEqual(run(self.path, 'duplicate')['delivery_count'], 1)

    def test_bad_plan_and_missing_route(self):
        for plan in ([{'id': 'x', 'deps': ['missing']}],
                     [{'id': 'x', 'deps': ['y']}, {'id': 'y', 'deps': ['x']}],
                     [{'id': 'x', 'deps': []}, {'id': 'x', 'deps': []}]):
            with self.assertRaises(ValueError):
                validate_plan(plan)
        with self.assertRaises(ValueError):
            route('unavailable')

    def test_attempt_budget(self):
        db = connect(self.path)
        with db:
            db.execute("UPDATE task SET attempts=2 WHERE id='collect'")
        db.close()
        with self.assertRaisesRegex(RuntimeError, 'budget exhausted'):
            run(self.path)
        db = connect(self.path)
        self.assertEqual(db.execute("SELECT state FROM task WHERE id='collect'").fetchone()[0], 'failed')
        db.close()


def demo(output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    # A new directory prevents accidental reuse from changing expected attempt counts.
    from uuid import uuid4
    target = output / f'run-{uuid4().hex[:8]}'
    target.mkdir()
    reports = {}
    for scenario in ['normal', 'retry', 'repair', 'duplicate', 'crash_resume']:
        path = str(target / f'{scenario}.sqlite')
        if scenario == 'crash_resume':
            process = subprocess.run([sys.executable, str(Path(__file__).resolve()), 'run',
                                      '--db', path, '--crash-after', 'calculate'], capture_output=True)
            if process.returncode != 17:
                raise RuntimeError(f'expected injected crash, got {process.returncode}')
        reports[scenario] = run(path, scenario)
    report = target / 'report.json'
    report.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Report: {report.resolve()}')
    for name, result in reports.items():
        print(name, 'attempts=', [t['attempts'] for t in result['tasks']],
              'local_delivery_count=', result['delivery_count'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['demo', 'run', 'test'])
    parser.add_argument('--db', default='learning-state.sqlite')
    parser.add_argument('--scenario', choices=['normal', 'retry', 'repair', 'duplicate'], default='normal')
    parser.add_argument('--crash-after', choices=[t['id'] for t in PLAN])
    parser.add_argument('--output', default='learning/output')
    args = parser.parse_args()
    if args.command == 'test':
        unittest.main(argv=[sys.argv[0]], verbosity=2)
    elif args.command == 'demo':
        demo(args.output)
    else:
        print(json.dumps(run(args.db, args.scenario, args.crash_after), ensure_ascii=False, indent=2))
