# Agent 学习实验室

新增：[论文驱动的 DeepSeek 协作看板](hierarchy-demo/README.md)。运行 npm run hierarchy，打开 http://127.0.0.1:4323/ 。直接输入问题，固定摇摆户、营销、风控三团队；支持手动、LLM 或规则选择五种协作方式，独立审查交接消息，支持隔离、修订与复审；所有调用可查看真实输入输出和用量。支持 VPN 系统网络与 HTTP(S) 代理，会产生 API 用量。

## 首次运行最终论文协作 Demo

需要 Node.js 22 或更新版本。克隆仓库后，在项目目录运行：

```powershell
Copy-Item .env.deepseek.example .env
# 在本地 .env 填写 DEEPSEEK_API_KEY
npm run hierarchy
```

浏览器打开 http://127.0.0.1:4323/ 。填好密钥后，在页面重新读取本地 API 配置。可手动选择五种拓扑，或由 LLM / 规则自动选择；卡片展示下一次选择，连线图展示本次实际执行。执行、Inspector 审查及修订均调用真实模型，会产生费用；单任务最多 48 次请求，同时最多两个请求。最终 Demo 需要有效密钥，不提供假答案回退。

运行 `npm test` 执行离线回归，不调用付费 API。完整功能、论文对应关系和实现边界见 [最终 Demo 说明](hierarchy-demo/README.md)，讲解见 [技术讲解](hierarchy-demo/技术讲解.md) 与 [汇报讲解](hierarchy-demo/汇报讲解.md)。旧版离线看板仍可通过 `npm run board` 打开（端口 4322）。

仓库不包含 API 密钥、个人任务运行记录、虚拟环境和本机配置。论文官方仓库未打包，获取方式与验证边界见 `reproductions/` 下的说明。GitHub 保存源码；该 Node.js 后台不能直接通过 GitHub Pages 运行。

新增：[协作任务看板](board/README.md)：运行 `npm run board`，打开 http://127.0.0.1:4322 。输入问题后观察节点状态、协作连线、材料交接与最终交付；默认零费用规则演示，可配置真实模型。

新增：[可靠记忆与多智能体研究后端](research/README.md)，使用 LiteLLM、Pydantic、LangGraph、PostgreSQL/pgvector、可选 Mem0 和 Langfuse。独立中文实验页面运行于 `http://127.0.0.1:4320`；下文原 Node 工作台继续保留。

本地命令行基础版，使用 Node.js 22+，无需安装第三方依赖。三个角色可在 `agents.json` 修改。

## 中文交互工作台

运行 `npm run ui`，浏览器打开 http://127.0.0.1:4317 。支持协作总览、课题讨论、互相教学、角色配置、Markdown 资料新增与查看、教学验证入库。任务状态自动刷新。API 密钥仍仅从本地 `.env` 读取，不返回浏览器。修改 `.env` 后需重启服务。

服务仅监听本机，限制同源写入，单次只运行一个模型任务。关闭网页不会取消已启动任务。该工作台用于本地单用户，不适合直接暴露到公网。未配置 API 时可管理角色与资料，但不能发起模型任务。

## 配置

将 `.env.example` 复制为 `.env`，在本地编辑：

```dotenv
OPENAI_API_KEY=你的API密钥
OPENAI_MODEL=你的账户可用的模型ID
```

密钥不要发送到聊天或提交到 Git。默认后端使用 OpenAI Responses API；也支持 DeepSeek 官方 Chat Completions 接口。DeepSeek 使用 `.env.deepseek.example` 中的 `LLM_PROVIDER=deepseek` 与 `DEEPSEEK_*` 配置；看板中可点击“重新读取本地 API 配置”生效。详见 [DeepSeek 接入](board/README.md)。

```powershell
Copy-Item .env.example .env
npm start -- status
npm start -- discuss "怎样验证一种职场培训方法是否有效"
npm start -- teach researcher practitioner "如何设计对照实验"
npm start -- approve 教学ID "独立练习与外部核查的结果和证据位置"
npm test
```

讨论最多 6 次模型调用，教学 3 次；每次最多 3000 输出 token，API 会产生费用。不自动重试失败的付费调用。`discuss` 再次运行会新建任务，不会续跑。`status` 只检查本地配置是否存在，不验证 API 可用性。

## 独立资料

首次运行会创建：

```text
data/agents/researcher/knowledge/   私有知识
data/agents/researcher/skills/      允许共享的技能说明
data/agents/researcher/memory/      允许共享的已确认经验
data/agents/practitioner/...       实践员独立空间
data/agents/reviewer/...           审查员独立空间
data/runs/                        讨论和状态记录
data/lessons/                     待验证及已确认教学记录
```

将 UTF-8 Markdown 文件放进对应目录。每个 Agent 只加载自己的资料；教学只加载自己的 `skills`、`memory`。讨论默认也仅加载这两个允许共享的目录。配置 `shareKnowledge: true` 表示明确允许该 Agent 使用私有知识参与共享讨论，输出可能包含资料内容。

目前技能是方法说明，没有代码执行、联网检索或外部工具权限。隔离由应用的上下文装配实现，同一个本地进程拥有这些目录的权限；不是操作系统级沙箱。不允许在可共享的技能和经验目录放入敏感数据。所有被加载资料会发送到所配置的模型服务。

## 学习的边界

教学、学生作答和审查意见先落到待验证记录，不直接进入长期记忆。外部验证后，用 `approve` 提供证据，才写入学生自己的记忆。当前证据由使用者核查，程序不会自动验证真实性；审查模型的评价不等于能力提升证明。

这里的学习指持续积累可加载的知识和方法，不更新模型参数。当前编排是固定流程，尚未实现自主消息路由、独立测试题库、可执行技能或向量检索。

接口依据：https://developers.openai.com/api/docs/quickstart

