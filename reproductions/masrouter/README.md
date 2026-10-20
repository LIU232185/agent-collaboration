# MasRouter 本地复现记录

范围：按用户要求，仅完成零 API 费用的控制器与拓扑验证。未执行真实 LLM 推理、基准训练或论文分数复现。

2026-10-20 实测：Python 3.12.14、PyTorch 2.14.1+cpu；前向、反向、五个模块的参数更新、人数边界和拓扑检查全部通过，API 调用为 0。结果见 `results/controller-smoke.json`。

## 来源与版本

- [ACL 2025 正式论文](https://aclanthology.org/2025.acl-long.757/)，重点为 §4.1–4.4。
- [官方代码](https://github.com/yanweiyue/masrouter)，本地在 `upstream/`。
- 固定提交：`e005f7696fe0c0412563f6cd67f4cd3712fa2822`。
- 官方代码 Apache-2.0，保留原许可证；本轮不改写 upstream。

## 运行

从项目根目录，在 PowerShell 执行：

```powershell
.\.venv\Scripts\python.exe reproductions\masrouter\smoke_controller.py
```

最小依赖是 CPU PyTorch；本地实际版本记录在 `results/controller-smoke.json`。新环境可执行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
```

已有环境可用 `pip install -r reproductions/masrouter/requirements-controller.txt` 安装本次锁定版本。上游仓库独立保存且被外层 Git 忽略；转移项目后需重新获取：

```powershell
git clone https://github.com/yanweiyue/masrouter.git reproductions/masrouter/upstream
git -C reproductions/masrouter/upstream checkout e005f7696fe0c0412563f6cd67f4cd3712fa2822
```

脚本通过 AST 提取原文件中的控制器类及函数，保持其计算代码不变，避开外部执行器和联网导入。输入是固定种子的随机 384 维向量，奖励是假设值；没有调用 MiniLM。它验证的是官方模块能否计算和更新参数，不能说明语义路由质量或训练收敛。

检查包括：两条查询的级联前向计算；角色数、模型数与人数一致；索引范围；损失与梯度有限；五个模块均有非零梯度且参数更新；人数为 1 和 6 的边界；六种官方模式的邻接矩阵与 Debate 轮数。结果含源码 SHA256、软件版本、选取索引和梯度，便于核对。

## 三个重点对应到代码

| 目标 | 官方入口 | 实际逻辑 |
| --- | --- | --- |
| 协作方式选择 | `MAR/MasRouter/mas_router.py: CollabDeterminer` | 查询与模式描述编码后，经 VAE 得到隐变量，按相似度 softmax 采样模式 |
| 人数决定 | 同文件 `NumDeterminer` | 查询隐变量经 sigmoid × max_agent，再 round、clamp |
| 角色分配 | 同文件 `RoleAllocation` | 根据查询、协作上下文及历史角色逐个采样；允许重复角色 |
| 模型路由 | 同文件 `LLMRouter` | 使用查询、协作与角色汇总上下文生成模型概率；采样多个模型，以 Gamma 函数近似人数相关的多项式项 |
| 消息连边 | `MAR/Utils/utils.py: get_kwargs` | 将所选模式映射为时空邻接矩阵与轮数，再交给 `MAR/Graph/graph.py` |

这套方法选择预定义协作模式、角色和模型，不直接生成任意子任务计划。LLMRouter 对同一查询内各 Agent 使用同一模型概率向量，再重复采样，并非逐个角色分别计算独立模型概率。角色顺序影响汇总上下文，但不能据此声称实现了逐角色最优配对。

## 静态审查发现：完整实验前必须处理

1. README 写 `experiments/run_mbpp.py`，实际目录是 `Experiments`。从 upstream 根目录运行，才能满足相对角色路径。
2. `Datasets/mbpp_dataset.py` 实际读取 Hugging Face parquet；`--dataset_json` 未在 MBPP 主流程使用。该模块底部还在导入时读取 test 数据。
3. 仓库没有依赖清单和预训练 `.pth`。真实链路还需 sentence-transformers、openai、groq、python-dotenv、loguru、shortuuid、class-registry、pandas、pyarrow、huggingface-hub、fsspec、PyYAML、matplotlib、seaborn、tiktoken、astunparse、langchain-community、wikipedia 等；此列表来自静态导入审查，尚未作为完整安装集验证。
4. 编码器需要 `sentence-transformers/all-MiniLM-L6-v2`。当前验证刻意使用合成向量，因此无需下载权重。
5. 论文 §4.1 人数用上取整，代码用 round。论文 §5.1 的成本惩罚、温度等配置与 MBPP 脚本默认值不完全一致；脚本 `cost_rate=400`，不能直接当作论文配置。
6. MBPP 训练中 `F.cross_entropy` 接收到的是已经 softmax 的概率。当前验证保留此行为；若修正须另列消融，不能静默改动后称完全忠实复现。
7. `RoleAllocation.init_role_embedding` 是普通 Tensor 而非 nn.Parameter，不被 optimizer 管理；历史角色汇总在选中最后一个角色前完成，需评估其是否符合预期。
8. 部分 GFusion 模块实例化但未参与 forward；存在参数无梯度是源码现状。本验证要求每个控制器有有效更新，不要求所有声明参数都有梯度。
9. `ALLChat.agen` 没有同步接口中的 cost_count；实际 Agent 文件可见同步 gen 路径。后续应检查真正执行路径，按返回 usage 统一核算成本，避免将未知模型价格算作零成本。
10. MBPP 测试阶段未使用 eval/no_grad，VAE 和类别选择也仍采样；报告必须说明推理随机性、种子和重复次数。
11. 模型池含历史模型别名；能否访问、版本与当年价格均未验证。更换模型属于迁移实验，不能直接比较原表分数。

## 后续真实复现的验收标准

先独立准备完整环境、离线数据快照与真实 MiniLM 编码器，修复集成问题并记录补丁；配置模型 ID、端点和本地密钥。先跑少量训练样本和独立测试样本，记录模式、人数、角色、模型、正确率、输入输出 token、调用次数、延迟与实际费用，再扩大规模。

至少比较完整 MasRouter、固定模式、固定角色、固定模型、固定人数及随机路由；各组使用相同数据划分、模型池与评测器。输出准确率—成本关系，而不只报告选路示例。先选择一个基准完成，再扩至其他基准。代码任务的模型输出必须在有进程隔离和硬超时的环境评测，不能把官方线程超时当作安全隔离。

当前没有训练后的 checkpoint、真实正确率或成本下降结论。所有示例索引来自未训练网络，仅用来验证计算链路。
