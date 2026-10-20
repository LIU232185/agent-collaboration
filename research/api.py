import threading
from contextlib import asynccontextmanager, contextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import ROOT, Settings
from .engine import Engine
from .experiments import evaluate, evolve
from .models import Approval, Document, ExperimentRequest, Rollback, TaskRequest


def create_app(settings=None):
    settings = settings or Settings()
    lock = threading.Lock()

    @asynccontextmanager
    async def lifespan(app):
        app.state.engine = Engine(settings)
        if settings.mode == 'demo':
            app.state.engine.seed()
        yield
        if app.state.engine.trace.client:
            app.state.engine.trace.client.flush()

    app = FastAPI(title='共研 · 可靠记忆实验室', lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['localhost', '127.0.0.1', 'testserver'])

    @app.middleware('http')
    async def local_writes(request: Request, call_next):
        if request.method in ('POST', 'PUT', 'DELETE', 'PATCH'):
            origin = request.headers.get('origin')
            # CLI has no Origin. Browsers must use this exact local service.
            if origin and origin != str(request.base_url).rstrip('/'):
                return JSONResponse({'detail': '仅允许同源写入'}, status_code=403)
            if request.headers.get('sec-fetch-site') == 'cross-site':
                return JSONResponse({'detail': '拒绝跨站请求'}, status_code=403)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Content-Security-Policy'] = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
        return response

    @contextmanager
    def mutation():
        if not lock.acquire(blocking=False):
            raise HTTPException(409, '另一个任务运行中，请稍后再试')
        try:
            yield
        except (ValueError, KeyError) as exc:
            raise HTTPException(422, str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:
            # Do not return exception messages which may contain provider credentials/DSNs.
            raise HTTPException(502, f'外部组件执行失败（{type(exc).__name__}）；请核对本地服务与配置') from exc
        finally:
            lock.release()

    @app.get('/api/state')
    def state():
        e = app.state.engine
        return {'mode': settings.mode, 'storage': settings.storage, 'model': settings.llm_model or 'offline-script',
                'busy': lock.locked(), 'context_budget_bytes': settings.context_budget_bytes,
                'mem0': settings.mem0_enabled, 'langfuse': settings.langfuse_enabled,
                'documents': e.store.list('document'), 'runs': e.store.list('run')[:30],
                'memories': e.store.list('memory')[:50], 'policies': e.store.list('policy'),
                'experiments': e.store.list('experiment')[:20]}

    @app.post('/api/documents')
    def document(body: Document):
        with mutation():
            app.state.engine.add_document(body)
            return body

    @app.post('/api/seed')
    def seed():
        with mutation():
            app.state.engine.seed()
            return {'ok': True}

    @app.post('/api/tasks')
    def task(body: TaskRequest):
        with mutation():
            return app.state.engine.run(body)

    @app.post('/api/experiments')
    def experiments(body: ExperimentRequest):
        with mutation():
            return evaluate(app.state.engine, body.strategies)

    @app.post('/api/evolve')
    def evolution():
        with mutation():
            return evolve(app.state.engine)

    @app.post('/api/policies/rollback')
    def rollback(body: Rollback):
        with mutation():
            e = app.state.engine
            policy = e.store.get('policy', body.version_id)
            if not policy or policy['status'] not in ('archived', 'active'):
                raise ValueError('只能恢复曾启用的策略版本')
            e.store.activate(body.version_id)
            e.store.save('rollback', {'policy_id': body.version_id})
            return {'ok': True}

    @app.post('/api/memories/{memory_id}/approve')
    def approve(memory_id: str, body: Approval):
        with mutation():
            e = app.state.engine
            record = e.store.get('memory', memory_id)
            if not record or record['status'] != 'pending':
                raise ValueError('待验证记忆不存在')
            if settings.mode == 'live' and record['mode'] != 'live':
                raise ValueError('演示记忆不能进入真实模式')
            return e.memory.approve(record, body.evidence)

    @app.get('/')
    def index():
        return FileResponse(ROOT / 'research' / 'web' / 'index.html')

    app.mount('/assets', StaticFiles(directory=ROOT / 'research' / 'web'), name='assets')
    return app


app = create_app()
