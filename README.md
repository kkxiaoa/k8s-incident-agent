# K8s Incident Agent

面向受支持的真实 Kubernetes 环境构建 evidence-first 故障响应 Agent。目标不是生成泛化运维建议，而是完成“故障发现、证据收集、根因诊断、修复验证、人工审批、受控执行、恢复复查与失败回滚”的可观测闭环。

## 当前状态

项目已完成一个可安装、可恢复的只读诊断垂直切片：

- 已实现来源中立的持久化 Incident、可重复 Run、只读 Kubernetes Evidence、诊断 Agent、REST/SSE BFF 与 Incident Console；
- 固定 Kind 与单节点 K3s profile 已使用同一组双架构 Console / Runtime 产物完成安装、真实诊断、网络与身份门禁、持久化恢复和普通卸载验证；这不是任意 Kubernetes 兼容性承诺；
- development / evaluation 可手动触发版本化场景；online profile 不暴露人工创建或重新运行入口；
- Alertmanager intake、managed monitoring、有界 Prometheus 查询、Run-owned Evidence 与 Console 必要指标图表已实现；五个故障族的七个场景已有 fixed Kind/K3s 组合 live 证据，不代表任意 Kubernetes 兼容性或统计准确率、延迟、恢复率基线；
- Evidence-bound 镜像修复提案、独立 server-side dry-run 与只读修复验证 Console 已完成离线实现和验证；该修复链路尚未完成最终镜像与集群 live 验收。当前止于 `WAITING_APPROVAL`，尚未批准或执行；审批、受控执行、恢复验证与回滚仍未实现。

## 产品边界

K8s Incident Agent 负责应用运行后的故障响应；已有的 K8s YAML Authoring Copilot 负责部署前的 YAML 编写、检索、校验、生成和修复。两个产品保持独立，后续通过 Header 普通导航和受控 Patch 交接形成从“配置设计”到“运行诊断”、再从“修复 Patch”回到“配置审阅”的业务闭环。

产品目标是服务受支持真实环境中的故障发现、诊断与受控修复。当前只在固定 Kind 与固定单节点 K3s 演示基线验证，不连接生产集群，也不自动执行修复；该限制是当前安全门禁，不是产品定位。后续只有通过明确兼容矩阵、身份授权、发布与安全门禁的环境才属于受支持范围。

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
- 基础设施：Kind（开发/CI）、K3s（首个演示部署）、Kubernetes Python Client，以及 digest 锁定的 Prometheus、Alertmanager、kube-state-metrics managed profile；
- 数据与状态：SQLite、SQLAlchemy、Alembic、独立 LangGraph checkpointer；
- Agent 工具：类型化 Function Tools；MCP、多 Agent 与无人审批的生产自动修复不在当前范围。
