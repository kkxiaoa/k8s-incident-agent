# K8s Incident Agent

面向 Kubernetes 故障响应场景的 evidence-first Agent 实验项目。目标不是生成泛化运维建议，而是在受控集群中完成“告警接入、证据收集、故障诊断、修复验证、人工审批、执行复查与失败回滚”的可观测闭环。

## 当前状态

项目处于设计与工程初始化阶段：

- 已初始化 Next.js 16、React 19、TypeScript 与 Tailwind CSS 工程；
- 已确定产品边界、总体架构、安全原则、MVP 路线和评估方案；
- 尚未接入真实集群、Prometheus、Alertmanager 或任何写操作能力；
- 当前所有指标均为待实现的评估定义，不代表已有运行结果。

## 产品边界

K8s Incident Agent 负责应用运行后的故障响应；已有的 K8s YAML Authoring Copilot 负责部署前的 YAML 编写、检索、校验、生成和修复。两个产品保持独立，并在 Header 中互相链接，形成从“配置设计”到“运行诊断”、再从“修复 Patch”回到“配置审阅”的业务闭环。

第一阶段仅支持本地 Kind 沙箱中的只读诊断，不连接生产集群，也不自动执行修复。K3s 留作后续公网演示环境。

## 本地开发

```bash
npm install
npm run dev
```

打开 <http://localhost:3000>。

## 工程检查

```bash
npm run lint
npm run build
```

## 技术栈基线

- Web 与 BFF：Next.js 16、React 19、TypeScript 5、Tailwind CSS 4、REST / SSE；
- Agent Runtime：Python 3.13、FastAPI、Pydantic 2、LangChain、LangGraph；
- 模型基线：`deepseek-v4-flash` non-thinking，`deepseek-v4-pro` 作为评估候选；
- 基础设施：Kind、Kubernetes Python Client、Prometheus、Alertmanager；
- 数据与状态：SQLite、SQLAlchemy、Alembic、独立 LangGraph checkpointer；
- Agent 工具：类型化 Function Tools，MCP、多 Agent 与生产自动修复暂缓。
