# 共研 · 可靠记忆与多智能体实验室

基于 LiteLLM + Pydantic + LangGraph + PostgreSQL/pgvector + 可选 Mem0 + 可选 Langfuse 的研究原型。保留项目原有 Node 工作台，新增服务监听 **127.0.0.1:4320**。

## 已实现

- 六节点 LangGraph：检索 → 压缩 → 分析 → 质疑 → 决策 → 引用完整性门禁。
- 有来源的结构化摘录、上下文预算、原文回取、范围隔离和资料版本。
- 方法经验先成为 pending 候选，人工填写独立验证依据后再入库。原始资料才是事实证据。
- SQLite 离线开发存储；真实模式支持 PostgreSQL/pgvector 及 LiteLLM Embedding。
- Mem0 可选接管已复核经验的存储检索（pgvector 后端）；候选提取由反思节点完成。
- Langfuse 可选记录根任务和模型调用，包含模型使用量。关闭时仍保留本地轨迹。引用检查之外，最终审查角色检查证据支持性，有未解决疑问则暂缓结论。
- 四个公开开发案例及三组策略对照；反思生成有限策略候选、同集比较、拒绝和回滚。
- 中文页面：协同任务、证据、记忆、对照实验、策略版本。

## 本地启动（不需要密钥）

Windows PowerShell，项目根目录：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn research.api:app --host 127.0.0.1 --port 4320
```

浏览器打开 http://127.0.0.1:4320 。默认 `MODE=demo`，仅使用确定性脚本和 SQLite，不会调用模型。它验证程序能运行，不能验证多 Agent 提升、幻觉降低或记忆学习效果。

## 切换真实链路

1. 安装 Docker 后启动数据库：`docker compose -f compose.research.yaml up -d`。仅绑定本机5438端口。示例密码仅供本机开发，修改时同步更新 DATABASE_URL。已有 pgvector 服务也可直接使用。
2. 如需要独立 LiteLLM 网关：`pip install 'litellm[proxy]'`。按 `litellm.example.yaml` 注释配置供应商模型ID和环境变量，设置 `LITELLM_MASTER_KEY`，运行 `litellm --config research/litellm.example.yaml --host 127.0.0.1 --port 4000`。也可以使用单位已有网关。网关额外依赖不包含在当前基础环境。
3. 复制 `research/.env.example` 为 `research/.env`；设置 MODE=live、STORAGE=postgres、DATABASE_URL、LLM_API_KEY 等。LLM_API_KEY 为网关密钥；提供商密钥留在网关。示例模型别名必须实际存在。
4. 确认 Embedding 模型和 EMBEDDING_DIMS 一致。库中的资料向量维度固定，换维度需要独立数据库/迁移，不能直接覆盖。
5. 设置 MEM0_ENABLED=true 启用 Mem0；此集成使用 OpenAI-compatible 网关及 pgvector，方法经验仍先人工复核。不会把未确认的模型答案自动写为事实。
6. 如需 Langfuse，准备独立部署或云服务，设置 LANGFUSE_ENABLED=true、两项密钥和地址。当前 Compose 仅启动 PostgreSQL，不包含 Langfuse 及其依赖。
7. 启动/重启 Python 服务。首次导入模拟规则需在「证据资料」点「导入模拟规则」，该操作会调用 Embedding 服务。默认真实模式不自动上传资料。

真实任务会将选中资料发给配置的模型；启用 Langfuse 后也会向该服务发送调用内容。页面不返回密钥。服务只适合本机单用户；没有用户认证，不应直接暴露公网。

## 如何操作

1. 先用模拟案例执行一次任务，检查完整六节点轨迹和来源。
2. 在「经验记忆」核对候选；模型的反思不是独立验证，需填写人工复核依据。
3. 选择「检索＋长期经验」才会加载已复核经验，且仅限相同 scope。
4. 执行开发集三组对照，查看逐题结果、上下文预算消耗和引用完整性。
5. 点击「反思并评估一个策略候选」。live 模式下，准确率严格改善、引用完整性不下降且上下文成本受限才晋级；demo 永不晋级。
6. 对曾启用的历史策略可恢复。此回滚仅恢复策略，不回滚文档或记忆，因此不等于完整实验快照。

## 计量与研究边界

- `CONTEXT_BUDGET_BYTES` 是 **UTF-8字节预算**，不是供应商精确 Token。前端与报告明确标注；模型真实 Token 在 live 轨迹 `calls[].usage` 和 Langfuse 中记录。
- 预算约束的是检索资料、问题和记忆组成的上下文包；系统提示、结构化Schema、审查及分析输出会增加完整请求Token，当前不承诺完整请求同预算对照。
- 压缩采用结构化逐字摘录；没有完整长会话增量压缩/记忆合并实现。单篇按条款导入，不超过6000字节预算，过长应拆分。四种策略的角色调用数相同，属于记忆策略消融，不是单 Agent 对多 Agent 的完整研究。
- 引用门禁只验证source_id与逐字摘录。它不能证明解释正确，也不证明引用支持结论。模型质疑属于辅助检查，不是事实真值。
- 资料scope是应用检索过滤，不是多租户安全边界。版本按同scope、同标题选择最高版本；业务有效期仍需模型核查，不支持完整时态数据库。
- 当前开发集只有4题，公开且可见，不能报告统计显著性或泛化提升。候选筛选是工程验证，晋级代表开发集改善，不代表生产可用。
- 100/300/500/1000任务学习曲线、封存测试集、重复随机顺序、完整状态快照及自动验证经验尚未实现，需补充正式数据和评估协议。
- 外部组件异常明确报错，不伪装为成功；核心任务失败当前不支持中途恢复，成功任务及实验逐题结果持久化。
- 本系统仅提供模拟案例研究，不接生产客户决策、不执行交易、不更新基础模型参数。

## 验证

```powershell
.\.venv\Scripts\python.exe -m pytest research/test_research.py -q
node --test lab.test.mjs
```

依赖范围见根目录requirements.txt；本次实际安装版本已固定到根目录requirements.lock.txt，可使用 `pip install -r requirements.lock.txt` 重建本次环境（Python 3.12 / Windows）。真实pgvector、Mem0、LiteLLM网关与Langfuse的端到端连接需要外部服务与凭据，离线测试不能代替该验证。

## 官方接口依据

- LiteLLM：https://docs.litellm.ai/docs/
- Pydantic：https://docs.pydantic.dev/latest/
- LangGraph：https://docs.langchain.com/oss/python/langgraph/quickstart
- pgvector：https://github.com/pgvector/pgvector
- Mem0：https://github.com/mem0ai/mem0
- Langfuse：https://langfuse.com/docs/observability/sdk/overview
