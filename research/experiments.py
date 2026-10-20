"""Small public development fixtures, not a hidden benchmark or financial dataset."""
from uuid import uuid4
from .models import Policy, TaskRequest

DEV_CASES = [
    {'id': 'refund', 'question': '活动期内客户已报名，消费1200元但全部退款，能领取奖励吗？', 'expected': 'ineligible'},
    {'id': 'registration', 'question': '活动期内客户未报名，消费1200元没有退款，能领取奖励吗？', 'expected': 'ineligible'},
    {'id': 'eligible', 'question': '活动期内客户已报名，合格消费1200元，能领取奖励吗？', 'expected': 'eligible'},
    {'id': 'unknown', 'question': '客户情况不详，能领取奖励吗？', 'expected': 'insufficient'},
]


def evaluate(engine, strategies, policy=None):
    rows = []
    for strategy in dict.fromkeys(strategies):
        for case in DEV_CASES:
            run = engine.run(TaskRequest(question=case['question'], strategy=strategy),
                             policy=policy, learn=False)
            rows.append({'case_id': case['id'], 'strategy': strategy, 'expected': case['expected'],
                         'actual': run['decision']['verdict'], 'correct': run['decision']['verdict'] == case['expected'],
                         'citation_integrity_passed': run['audit']['citation_integrity_passed'],
                         'gate_passed': run['audit']['gate_passed'],
                         'provider_tokens': sum(c['usage'].get('total_tokens', 0) for c in run['calls']),
                         'context_bytes': run['compression']['context_bytes'],
                         'elapsed_ms': run['elapsed_ms'], 'run_id': run['id']})
    metrics = []
    for strategy in dict.fromkeys(strategies):
        group = [r for r in rows if r['strategy'] == strategy]
        metrics.append({'strategy': strategy, 'accuracy': sum(r['correct'] for r in group) / len(group),
                        'mean_context_bytes': round(sum(r['context_bytes'] for r in group) / len(group)),
                        'citation_integrity_rate': sum(r['citation_integrity_passed'] for r in group) / len(group)})
    return engine.store.save('experiment', {'mode': engine.s.mode, 'dataset': 'public-development-fixtures-v1',
        'research_evidence': False, 'note': '仅4个公开开发案例。demo是脚本结果；live也不构成泛化或统计显著性证据。',
        'rows': rows, 'metrics': metrics})


def evolve(engine):
    from .providers import Models
    incumbent = engine.store.active_policy()
    errors = [{'request': r['request'], 'review': r['review'], 'audit': r['audit']}
              for r in engine.store.list('run')[:8]]
    development_feedback = [e['rows'] for e in engine.store.list('experiment')[:2]]
    if not errors:
        raise ValueError('请先运行任务或对照实验，形成优化依据')
    candidate = Models(engine.s, engine.trace).generate('optimizer', Policy, {
        'current_policy': {k: incumbent[k] for k in Policy.model_fields},
        'trajectories': errors, 'development_feedback': development_feedback,
        'task': '根据历史问题改进有限记忆策略；不能修改评分器、数据或系统权限。'})
    # Model output must never overwrite an existing strategy ID.
    candidate.id = str(uuid4())
    before = evaluate(engine, ['retrieval'], incumbent)
    after = evaluate(engine, ['retrieval'], candidate.model_dump())
    b, a = before['metrics'][0], after['metrics'][0]
    gain = a['accuracy'] - b['accuracy']
    accepted = (engine.s.mode == 'live' and gain > 0
                and a['citation_integrity_rate'] >= b['citation_integrity_rate']
                and a['mean_context_bytes'] <= max(b['mean_context_bytes'] * 1.2, 512))
    record = engine.store.save('policy', {**candidate.model_dump(), 'status': 'candidate' if accepted else 'rejected',
        'origin': 'reflection', 'parent_id': incumbent['id'], 'before_experiment': before['id'],
        'after_experiment': after['id'], 'accuracy_gain': gain, 'mode': engine.s.mode,
        'reason': '开发验证集上改善且未降低引用完整性、上下文成本受限' if accepted else
                  '演示模式不晋级，或准确率未改善，或引用完整性/成本门禁未通过',
        'generalization_verified': False})
    if accepted:
        engine.store.activate(record['id'])
    return engine.store.get('policy', record['id'])
