from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from research.api import create_app
from research.config import Settings
from research.engine import Engine, quote_errors, token_count
from research.experiments import evaluate, evolve
from research.models import Decision, Document, Policy, SourceQuote, TaskRequest
from research.providers import Models


@pytest.fixture
def engine(tmp_path):
    result = Engine(Settings(_env_file=None, state_dir=tmp_path))
    result.seed()
    return result


def test_graph_provenance_and_pending_memory(engine):
    result = engine.run(TaskRequest(question='活动期内客户已报名，消费1200元但全部退款，能领取奖励吗？'))
    assert result['decision']['verdict'] == 'ineligible'
    assert len(result['events']) == 6
    assert result['audit']['citation_integrity_passed']
    assert not result['audit']['semantic_truth_verified']
    assert result['compression']['context_bytes'] <= engine.s.context_budget_bytes
    assert result['mode'] == 'demo'
    assert engine.memory.search('退款', 'demo-card') == []
    memory = engine.store.get('memory', result['memory_id'])
    engine.memory.approve(memory, '测试人员已核查示例原文与适用条件')
    assert engine.memory.search('退款', 'demo-card')
    assert engine.memory.search('退款', 'another-scope') == []


def test_fabricated_citations_fail_closed(engine, monkeypatch):
    original = Models.generate

    def fake(self, role, schema, payload):
        if role == 'decision':
            return Decision(verdict='eligible', explanation='错误结论', evidence=[
                SourceQuote(source_id='invented', quote='虚构规则')])
        return original(self, role, schema, payload)

    monkeypatch.setattr(Models, 'generate', fake)
    result = engine.run(TaskRequest(question='客户能否领取奖励？'))
    assert result['decision']['verdict'] == 'insufficient'
    assert not result['audit']['citation_integrity_passed']
    assert result['memory_status'] == 'not_requested'


def test_version_scope_and_immutable_sources(engine):
    engine.add_document(Document(id='new-rule', title='模拟消费奖励规则', version=2,
                                 content='【模拟资料】新规则门槛2000元。'))
    docs = engine.store.documents('demo-card')
    assert 'demo-rule-v1' not in [d.id for d in docs]
    assert engine.store.get('document', 'demo-rule-v1') is not None
    assert engine.store.documents('other-scope') == []
    with pytest.raises(ValueError):
        engine.add_document(Document(id='new-rule', title='模拟消费奖励规则', version=3, content='覆盖原文'))


def test_experiments_do_not_write_memory_and_demo_cannot_promote(engine):
    result = evaluate(engine, ['recent', 'summary', 'retrieval'])
    assert len(result['rows']) == 12
    assert not result['research_evidence']
    assert engine.store.list('memory') == []
    active = engine.store.active_policy()['id']
    candidate = evolve(engine)
    assert candidate['status'] == 'rejected'
    assert engine.store.active_policy()['id'] == active


def test_rollback_is_persisted(engine):
    original = engine.store.active_policy()['id']
    candidate = engine.store.save('policy', {**Policy(instruction='测试新策略').model_dump(), 'status': 'candidate'})
    engine.store.activate(candidate['id'])
    assert engine.store.active_policy()['id'] == candidate['id']
    engine.store.activate(original)
    assert Engine(engine.s).store.active_policy()['id'] == original


def test_api_and_cross_origin(tmp_path):
    with TestClient(create_app(Settings(_env_file=None, state_dir=tmp_path))) as client:
        assert client.get('/').status_code == 200
        assert client.get('/assets/app.js').status_code == 200
        assert client.get('/api/state').json()['mode'] == 'demo'
        assert client.post('/api/tasks', json={'question': '测试'}, headers={'origin': 'https://evil.example'}).status_code == 403
        assert client.post('/api/tasks', json={'question': ''}).status_code == 422
        assert client.post('/api/tasks', json={'question': '客户能否领取奖励？'}).status_code == 200


def test_live_configuration_does_not_silently_fallback(tmp_path):
    with pytest.raises(ValueError):
        Engine(Settings(_env_file=None, mode='live', state_dir=tmp_path))


def test_quote_validation_does_not_claim_semantics():
    assert quote_errors([SourceQuote(source_id='x', quote='不存在')], [{'id': 'x', 'content': '原文'}])
    assert not quote_errors([SourceQuote(source_id='x', quote='原文')], [{'id': 'x', 'content': '原文'}])


def test_live_litellm_contract_without_external_requests(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    from research.models import Compression, Fact, MemoryCandidate, Review

    source = {'source_id': 'live-rule', 'quote': '合格消费满1000元可领取奖励。'}
    answer = Decision(verdict='eligible', explanation='达到门槛。', evidence=[SourceQuote(**source)])
    responses = iter([
        Compression(facts=[Fact(**source)]), answer, Review(), answer, Review(),
        MemoryCandidate(lesson='核对合格消费金额与门槛。', source_ids=['live-rule']),
    ])
    calls = []

    def completion(**kwargs):
        calls.append(kwargs)
        output = next(responses).model_dump_json()
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=output))],
                               usage=SimpleNamespace(model_dump=lambda: {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}))

    monkeypatch.setitem(sys.modules, 'litellm', SimpleNamespace(completion=completion))
    engine = Engine(Settings(_env_file=None, state_dir=tmp_path, mode='live', llm_model='openai/test',
                             critic_model='openai/critic', llm_api_key='test-not-a-real-key'))
    engine.add_document(Document(id='live-rule', title='测试规则', content=source['quote']))
    result = engine.run(TaskRequest(question='合格消费1200元能否领取奖励？'))
    assert result['mode'] == 'live'
    assert result['decision']['verdict'] == 'eligible'
    assert len(calls) == 6
    assert calls[2]['model'] == 'openai/critic'
    assert calls[4]['model'] == 'openai/critic'
    assert all(c['num_retries'] == 0 for c in calls)
    assert result['calls'][0]['usage']['total_tokens'] == 15
