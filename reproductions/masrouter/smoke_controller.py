"""Run unchanged upstream controller classes with synthetic embeddings, offline.

AST extraction excludes integration imports, MasRouter, and external executors.
No sentence model, dataset, LLM endpoint, or generated code is executed.
"""
import argparse
import ast
import hashlib
import json
import math
import random
from pathlib import Path
from typing import List, Union, Literal, Optional

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.special import gammaln

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'upstream/MAR/MasRouter/mas_router.py'
CLASSES = {'GFusion', 'VAE', 'TaskClassifier', 'CollabDeterminer',
           'NumDeterminer', 'RoleAllocation', 'LLMRouter'}


def load_controllers():
    tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
    nodes = [node for node in tree.body if
             (isinstance(node, ast.ClassDef) and node.name in CLASSES) or
             (isinstance(node, ast.FunctionDef) and node.name == 'vae_loss_function')]
    scope = dict(torch=torch, nn=nn, F=F, gammaln=gammaln, List=List,
                 std2=0.1, var2=0.01, log_var2=math.log(0.01))
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), 'exec'), scope)
    return scope


def run(seed):
    torch.manual_seed(seed)
    torch.set_num_threads(1)
    core = load_controllers()
    # Execute the actual upstream adjacency construction with no graph executor.
    topology_source = ROOT / 'upstream/MAR/Utils/utils.py'
    topology_tree = ast.parse(topology_source.read_text(encoding='utf-8'))
    topology_scope = dict(Union=Union, Literal=Literal, Optional=Optional,
                          List=List, random=random)
    fn = next(n for n in topology_tree.body
              if isinstance(n, ast.FunctionDef) and n.name == 'get_kwargs')
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(topology_source), 'exec'), topology_scope)
    topology_results = {}
    for mode in ['IO', 'CoT', 'Chain', 'FullConnected', 'Debate', 'Reflection']:
        cfg = topology_scope['get_kwargs'](mode, 3)
        spatial, temporal = cfg['fixed_spatial_masks'], cfg['fixed_temporal_masks']
        assert len(spatial) == len(temporal) == 3
        assert all(len(row) == 3 for row in spatial + temporal)
        topology_results[mode] = dict(spatial=spatial, temporal=temporal,
                                      rounds=cfg['num_rounds'])
    assert sum(map(sum, topology_results['Chain']['spatial'])) == 2
    assert sum(map(sum, topology_results['FullConnected']['spatial'])) == 6
    assert topology_results['Debate']['rounds'] == 2
    modules = {
        'task': core['TaskClassifier'](device='cpu'),
        'collaboration': core['CollabDeterminer'](device='cpu', temp=0.8),
        'number': core['NumDeterminer'](device='cpu', max_agent=6),
        'role': core['RoleAllocation'](device='cpu', temp=0.5),
        'llm': core['LLMRouter'](device='cpu', max_agent=6),
    }
    params = [p for m in modules.values() for p in m.parameters()]
    optimizer = torch.optim.Adam(params, lr=0.01)
    query = torch.randn(2, 384)
    tasks, collabs, llms = (torch.randn(n, 384) for n in (3, 6, 5))
    role_pool = [torch.randn(7, 384), torch.randn(7, 384)]
    task_idx, task_probs, task_ctx = modules['task'](query, tasks)
    collab_idx, collab_log, collab_ctx, collab_vae = modules['collaboration'](collabs, query)
    number, number_float, number_vae = modules['number'](query)
    roles, role_log, role_ctx, role_vae = modules['role'](
        role_pool, torch.cat([task_ctx, collab_ctx], dim=-1), number)
    models, llm_log, llm_vae = modules['llm'](
        llms, torch.cat([task_ctx, collab_ctx, role_ctx], dim=-1), number, number_float)
    for i in range(2):
        assert len(roles[i]) == len(models[i]) == number[i].item()
        assert all(0 <= int(r) < 7 for r in roles[i])
        assert all(0 <= m < 5 for m in models[i])
    # Synthetic utilities only: this verifies autograd, not benchmark learning.
    utility = torch.tensor([[1.0], [-0.5]])
    policy_loss = -((collab_log + role_log + llm_log) * utility).mean()
    # Preserve upstream's cross_entropy-on-probabilities behavior for this check.
    loss = (policy_loss + F.cross_entropy(task_probs, torch.tensor([2, 2]))
            + 0.001 * (collab_vae + number_vae + role_vae + llm_vae))
    assert torch.isfinite(loss)
    before = {name: [p.detach().clone() for p in module.parameters()]
              for name, module in modules.items()}
    optimizer.zero_grad()
    loss.backward()
    gradients = {}
    for name, module in modules.items():
        grads = [p.grad for p in module.parameters() if p.grad is not None]
        assert grads and all(torch.isfinite(g).all() for g in grads)
        gradients[name] = sum(float(g.abs().sum()) for g in grads)
        assert gradients[name] > 0
    optimizer.step()
    changed = {name: any(not torch.equal(old, new) for old, new in
                        zip(before[name], module.parameters()))
               for name, module in modules.items()}
    assert all(changed.values())
    # Cover agent-count extremes independent of the untrained number predictor.
    edge_counts = torch.tensor([[1], [6]], dtype=torch.int32)
    edge_roles = modules['role'](role_pool, torch.cat([task_ctx, collab_ctx], -1), edge_counts)[0]
    edge_models = modules['llm'](llms, torch.cat([task_ctx, collab_ctx, role_ctx], -1),
                                edge_counts, edge_counts.float())[0]
    assert [len(x) for x in edge_roles] == [1, 6]
    assert [len(x) for x in edge_models] == [1, 6]
    return dict(status='passed', scope='synthetic controller forward/backward only',
                seed=seed, torch_version=torch.__version__, device='cpu',
                source_sha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
                tasks=task_idx.tolist(), collaborations=collab_idx.tolist(),
                agent_counts=number.flatten().tolist(),
                role_indices=[[int(r) for r in row] for row in roles],
                llm_indices=models, loss=float(loss.detach()),
                gradient_l1=gradients, parameter_updates=changed,
                edge_agent_counts=[1, 6], api_calls=0,
                topologies=topology_results,
                benchmark_accuracy=None)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed', type=int, default=1234)
    parser.add_argument('--output', type=Path, default=ROOT / 'results/controller-smoke.json')
    args = parser.parse_args()
    result = run(args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
