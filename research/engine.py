import json
import time
from typing import TypedDict
from uuid import uuid4

from langgraph.graph import END, START, StateGraph

from .models import Compression, Decision, Document, MemoryCandidate, Policy, Review, TaskRequest
from .providers import Memory, Models, Trace
from .store import Store


def token_count(text: str):
    # Conservative offline byte budget: no tokenizer download, no model-specific claim.
    # Actual provider Token usage is recorded separately by LiteLLM.
    return len(text.encode('utf-8'))


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False)


def quote_errors(quotes, documents):
    sources = {d['id']: d['content'] for d in documents}
    return [f'引用不存在或并非逐字原文：{q.source_id}' for q in quotes
            if q.source_id not in sources or q.quote not in sources[q.source_id]]


class State(TypedDict, total=False):
    request: dict
    documents: list[dict]
    context: dict
    compression: dict
    analysis: dict
    review: dict
    decision: dict
    audit: dict
    events: list[dict]


class Engine:
    def __init__(self, settings, store=None):
        settings.validate_live()
        self.s = settings
        self.store = store or Store(settings)
        self.trace = Trace(settings)
        self.memory = Memory(settings, self.store)

    def seed(self):
        examples = [
            Document(id='demo-rule-v1', title='模拟消费奖励规则',
                     content='【模拟资料】客户必须先报名，活动期为2026年10月1日至12月31日。合格消费累计满1000元可领取奖励。'),
            Document(id='demo-exception-v1', title='模拟奖励例外条款',
                     content='【模拟资料】已退款交易除外，不计入合格消费；未报名客户不可领取奖励。'),
        ]
        for doc in examples:
            if not self.store.get('document', doc.id):
                self.add_document(doc)

    def add_document(self, doc):
        if token_count(doc.content) > 6000:
            raise ValueError('单篇资料超过6000字节，请按条款拆分后导入')
        model = Models(self.s, self.trace)
        vector = model.embed(doc.content) if self.s.mode == 'live' and self.store.pg else None
        self.store.add_document(doc, vector)

    def run(self, request: TaskRequest, policy=None, *, persist=True, learn=True):
        started = time.monotonic()
        run_id = str(uuid4())
        policy = Policy.model_validate({k: v for k, v in (policy or self.store.active_policy()).items()
                                        if k in Policy.model_fields})
        models = Models(self.s, self.trace)
        events = []

        def record(name, data):
            events.append({'node': name, 'data': data})
            return data

        def retrieve(state):
            docs = self.store.documents(request.scope)
            if request.strategy == 'recent':
                docs = docs[:1]
            elif request.strategy in ('retrieval', 'memory'):
                if self.s.mode == 'live' and self.store.pg:
                    docs = self.store.vector_search(request.scope, models.embed(request.question), policy.retrieval_k)
                else:
                    # Explicit offline lexical baseline, not pgvector simulation.
                    def score(d):
                        return sum(ch in d.content for ch in set(request.question) if ch.strip())
                    docs = sorted(docs, key=score, reverse=True)[:policy.retrieval_k]
            # Bound the extractor input too. Never silently truncate within a clause.
            selected = []
            for doc in docs:
                if token_count(dumps([d.model_dump() for d in selected + [doc]])) <= self.s.context_budget_bytes:
                    selected.append(doc)
            return record('retrieve', {'documents': [d.model_dump() for d in selected]})

        def compress(state):
            docs = state['documents']
            if request.strategy == 'recent':
                compressed = Compression()
                facts = [dict(source_id=d['id'], quote=d['content'], kind='fact') for d in docs]
            else:
                compressed = models.generate('compressor', Compression, {
                    'documents': docs, 'instruction': policy.instruction,
                    'task': '逐字提取必要事实；标记日期、否定、例外、更正，不改写引用。'})
                invalid = quote_errors(compressed.facts, docs)
                facts = [f.model_dump() for f in compressed.facts
                         if not quote_errors([f], docs)]
                if invalid:
                    compressed.missing_information.extend(invalid)
            memories = self.memory.search(request.question, request.scope) if request.strategy == 'memory' else []
            context = {'question': request.question, 'policy': policy.instruction,
                       'documents': [{'id': f['source_id'], 'content': f['quote'], 'kind': f['kind']} for f in facts],
                       'memories': memories}
            omitted = 0
            while token_count(dumps(context)) > self.s.context_budget_bytes and context['memories']:
                context['memories'].pop()
                omitted += 1
            while token_count(dumps(context)) > self.s.context_budget_bytes and context['documents']:
                # Preserve explicit exceptions/corrections when policy requests it.
                idx = next((i for i in range(len(context['documents']) - 1, -1, -1)
                            if not policy.preserve_exceptions or context['documents'][i]['kind'] not in ('exception', 'correction')), -1)
                context['documents'].pop(idx)
                omitted += 1
            if token_count(dumps(context)) > self.s.context_budget_bytes:
                raise ValueError('问题及策略本身超过上下文预算，请缩短问题或调大预算')
            original_tokens = token_count(dumps(docs))
            return record('compress', {'context': context, 'compression': {
                'input_bytes': original_tokens, 'context_bytes': token_count(dumps(context)),
                'omitted_items': omitted, 'missing_information': compressed.missing_information,
                'facts': facts, 'budget_unit': 'UTF-8 bytes (conservative offline budget); provider tokens recorded separately'}})

        def analyze(state):
            answer = models.generate('analyst', Decision, state['context'])
            return record('analyze', {'analysis': answer.model_dump()})

        def criticize(state):
            review = models.generate('critic', Review, {
                **state['context'], 'proposed_answer': state['analysis'],
                'task': '核查结论是否被证据支持，检查遗漏和例外；有疑问要求回查原文。'})
            return record('critic', {'review': review.model_dump()})

        def decide(state):
            context = dict(state['context'])
            if state['review']['needs_original']:
                originals = [{'id': d['id'], 'content': d['content']} for d in state['documents']]
                expanded = {**context, 'documents': originals}
                if token_count(dumps(expanded)) <= self.s.context_budget_bytes:
                    context = expanded
                else:
                    return record('decide', {'decision': Decision(
                        verdict='insufficient', explanation='核查要求回看原文，但原文超过上下文预算，需拆分任务。',
                        uncertainties=['需人工核查原始资料']).model_dump()})
            decision = models.generate('decision', Decision, {
                **context, 'analysis': state['analysis'], 'review': state['review'],
                'task': '根据证据与审查意见给出最终结论；无法消除的疑问必须返回 insufficient。'})
            return record('decide', {'decision': decision.model_dump()})

        def audit(state):
            decision = Decision.model_validate(state['decision'])
            citation_errors = quote_errors(decision.evidence, state['documents'])
            if decision.verdict != 'insufficient' and not decision.evidence:
                citation_errors.append('确定性结论没有引用证据')
            errors = list(citation_errors)
            if state['compression']['missing_information']:
                errors.append('压缩阶段存在未解决的来源或信息缺口')
            semantic_review = None
            if not errors and decision.verdict != 'insufficient':
                semantic_review = models.generate('final_auditor', Review, {
                    'question': request.question,
                    'documents': [{'id': q.source_id, 'content': q.quote} for q in decision.evidence],
                    'answer': decision.model_dump(),
                    'task': '检查引用是否足以支持最终结论，有推理遗漏、矛盾或需回查时提出issues；不要将格式正确当成事实正确。'})
                if semantic_review.issues or semantic_review.needs_original:
                    errors.extend(semantic_review.issues or ['最终证据支持性核查需要更多原文'])
            if errors:
                decision = Decision(verdict='insufficient', explanation='证据门禁未通过，暂缓结论。', uncertainties=errors)
            return record('audit', {'decision': decision.model_dump(), 'audit': {
                'citation_integrity_passed': not citation_errors, 'gate_passed': not errors, 'errors': errors,
                'model_support_review': semantic_review.model_dump() if semantic_review else None,
                'semantic_truth_verified': False,
                'note': '逐字引用校验不证明逻辑蕴含；模型核查也不能替代独立参考答案。'}})

        graph = StateGraph(State)
        nodes = [('retrieve', retrieve), ('compress', compress), ('analyze', analyze),
                 ('critic', criticize), ('decide', decide), ('audit', audit)]
        for name, fn in nodes:
            graph.add_node(name, fn)
        graph.add_edge(START, nodes[0][0])
        for (a, _), (b, _) in zip(nodes, nodes[1:]):
            graph.add_edge(a, b)
        graph.add_edge(nodes[-1][0], END)
        with self.trace.span('reliable-memory-run', input=request.model_dump(),
                             metadata={'run_id': run_id, 'mode': self.s.mode, 'policy_id': policy.id}) as span:
            result = graph.compile().invoke({'request': request.model_dump()})
            result.update(id=run_id, mode=self.s.mode, policy_id=policy.id,
                          events=events, calls=models.calls, elapsed_ms=round((time.monotonic() - started) * 1000),
                          memory_status='not_requested')
            if learn and result['audit']['gate_passed'] and result['documents']:
                try:
                    candidate = models.generate('reflection', MemoryCandidate, {
                        'question': request.question, 'decision': result['decision'],
                        'review': result['review'], 'source_ids': [d['id'] for d in result['documents']],
                        'task': '提取一条待验证的方法经验；不得把本次模型答案宣称为已确认事实。'})
                    if set(candidate.source_ids) <= {d['id'] for d in result['documents']}:
                        candidate_record = self.store.save('memory', {
                            **candidate.model_dump(), 'scope': request.scope, 'run_id': run_id,
                            'status': 'pending', 'mode': self.s.mode})
                        result['memory_status'] = 'pending'
                        result['memory_id'] = candidate_record['id']
                except Exception as exc:
                    result['memory_status'] = 'failed'
                    result['memory_error_type'] = type(exc).__name__
            if persist:
                self.store.save('run', result)
            if span:
                span.update(output={'decision': result['decision'], 'audit': result['audit']})
        if self.trace.client:
            self.trace.client.flush()
        return result
