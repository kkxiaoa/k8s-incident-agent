# K8s Incident Agent

面向受支持的真实 Kubernetes 环境构建 evidence-first 故障响应 Agent。目标不是生成泛化运维建议，而是完成“故障发现、证据收集、根因诊断、修复验证、人工审批、受控执行、恢复复查与失败回滚”的可观测闭环。

## 当前状态

项目当前处于 Stage 1 只读诊断切片：

- 已实现固定 Kind 开发/CI 基线、持久化 Incident Runtime、只读 Kubernetes Evidence、诊断 Agent、REST/SSE BFF 与 Incident Console；
- 当前只连接本地 Kind 沙箱，只有一个手动触发的 `ImagePullBackOff` 场景，尚未接入 Prometheus、Alertmanager 或写操作能力；
- K3s 是首个单集群可安装演示目标，当前尚无可部署产物；后续才扩展到明确兼容矩阵内的真实 Kubernetes 环境；
- 当前所有指标均为待实现的评估定义，不代表已有运行结果。

## 产品边界

K8s Incident Agent 负责应用运行后的故障响应；已有的 K8s YAML Authoring Copilot 负责部署前的 YAML 编写、检索、校验、生成和修复。两个产品保持独立，并在 Header 中互相链接，形成从“配置设计”到“运行诊断”、再从“修复 Patch”回到“配置审阅”的业务闭环。

产品目标是服务受支持真实环境中的故障发现、诊断与受控修复。第一阶段仍只在本地 Kind 沙箱验证只读诊断，不连接生产集群，也不自动执行修复；该限制是当前安全门禁，不是产品定位。K3s 将作为首个独立于 Kind 运行的单集群演示环境。

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
- 基础设施：Kind（开发/CI）、K3s（首个演示部署）、Kubernetes Python Client、Prometheus、Alertmanager；
- 数据与状态：SQLite、SQLAlchemy、Alembic、独立 LangGraph checkpointer；
- Agent 工具：类型化 Function Tools；MCP、多 Agent 与无人审批的生产自动修复不在当前范围。
