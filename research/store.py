"""JSON records have identical semantics in SQLite demo and PostgreSQL live storage."""
import json
import sqlite3
from datetime import datetime, timezone
from uuid import uuid4

from .config import Settings
from .models import Document, Policy


class Store:
    def __init__(self, settings: Settings):
        self.s = settings
        settings.state_dir.mkdir(parents=True, exist_ok=True)
        self.pg = settings.storage == 'postgres'
        if self.pg:
            import psycopg
            with psycopg.connect(settings.database_url) as conn:
                conn.execute('CREATE EXTENSION IF NOT EXISTS vector')
                conn.execute('CREATE TABLE IF NOT EXISTS research_records '
                             '(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created TEXT NOT NULL)')
                conn.execute('CREATE TABLE IF NOT EXISTS research_documents '
                             f'(id TEXT PRIMARY KEY, scope TEXT NOT NULL, embedding vector({settings.embedding_dims}))')
        else:
            self.path = settings.state_dir / 'lab.sqlite3'
            with self.connect() as conn:
                conn.execute('CREATE TABLE IF NOT EXISTS research_records '
                             '(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created TEXT NOT NULL)')
        if not self.list('policy'):
            self.save('policy', {**Policy(instruction='核对规则、日期、例外和后续更正；证据不足时明确说明。').model_dump(),
                                 'status': 'active', 'origin': 'initial'})

    def connect(self):
        if self.pg:
            import psycopg
            return psycopg.connect(self.s.database_url)
        return sqlite3.connect(self.path, timeout=30)

    def sql(self, query):
        return query.replace('?', '%s') if self.pg else query

    def save(self, kind: str, obj: dict):
        obj = dict(obj)
        obj.setdefault('id', str(uuid4()))
        obj.setdefault('created', datetime.now(timezone.utc).isoformat())
        with self.connect() as c:
            c.execute(self.sql('INSERT INTO research_records (id,kind,payload,created) VALUES (?,?,?,?) '
                               'ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'),
                      (obj['id'], kind, json.dumps(obj, ensure_ascii=False), obj['created']))
        return obj

    def list(self, kind: str):
        with self.connect() as c:
            rows = c.execute(self.sql('SELECT payload FROM research_records WHERE kind=? ORDER BY created DESC'),
                             (kind,)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def get(self, kind: str, record_id: str):
        return next((r for r in self.list(kind) if r['id'] == record_id), None)

    def documents(self, scope: str):
        records = [Document.model_validate({k: v for k, v in d.items() if k != 'created'})
                   for d in self.list('document') if d['scope'] == scope]
        # One active version per title in a scope; immutable old rows remain available for audits.
        latest = {}
        for d in records:
            if d.title not in latest or d.version > latest[d.title].version:
                latest[d.title] = d
        return list(latest.values())

    def add_document(self, doc: Document, embedding=None):
        if self.get('document', doc.id):
            raise ValueError('文档 ID 已存在；请使用新 ID 保存新版本')
        if any(d.title == doc.title and d.version >= doc.version for d in self.documents(doc.scope)):
            raise ValueError('同名资料必须使用更高版本号')
        payload = {**doc.model_dump(), 'created': datetime.now(timezone.utc).isoformat()}
        with self.connect() as c:
            c.execute(self.sql('INSERT INTO research_records (id,kind,payload,created) VALUES (?,?,?,?)'),
                      (doc.id, 'document', json.dumps(payload, ensure_ascii=False), payload['created']))
            if self.pg and embedding is not None:
                c.execute('INSERT INTO research_documents(id,scope,embedding) VALUES(%s,%s,%s::vector)',
                          (doc.id, doc.scope, json.dumps(embedding)))

    def vector_search(self, scope, embedding, k):
        if not self.pg:
            raise ValueError('向量检索仅用于 PostgreSQL 模式')
        active = {d.id: d for d in self.documents(scope)}
        if not active:
            return []
        with self.connect() as c:
            rows = c.execute('SELECT id FROM research_documents WHERE scope=%s AND id=ANY(%s) '
                             'ORDER BY embedding <=> %s::vector LIMIT %s',
                             (scope, list(active), json.dumps(embedding), k)).fetchall()
        return [active[r[0]] for r in rows]

    def active_policy(self):
        return next(p for p in self.list('policy') if p['status'] == 'active')

    def activate(self, policy_id):
        if not self.get('policy', policy_id):
            raise ValueError('版本不存在')
        # Update all policy rows in one transaction so rollback is atomic.
        with self.connect() as c:
            for p in self.list('policy'):
                p['status'] = 'active' if p['id'] == policy_id else (
                    'archived' if p['status'] == 'active' else p['status'])
                c.execute(self.sql('UPDATE research_records SET payload=? WHERE id=?'),
                          (json.dumps(p, ensure_ascii=False), p['id']))
