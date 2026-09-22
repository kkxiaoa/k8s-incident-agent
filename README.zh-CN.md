# K8s Incident Agent

[English](README.md)

面向 Kubernetes 运行期故障的 evidence-first 响应 Agent：发现异常，通过有界只读工具调查，并准备可供人工审核的受控修复建议。

产品目标是服务受支持的真实 Kubernetes 环境。**当前验证仅覆盖固定 Kind 与单节点 K3s 沙箱，不连接生产集群，也不承诺任意 Kubernetes 安装兼容。**

## 项目能力

- 持久化 Incident、可重复诊断 Run、Evidence 引用与审计事件。
- 综合 Kubernetes workload、Event、有界日志与目录驱动的 Prometheus 证据；保留证据不足语义，不把模型推断写成集群事实。
- 中文 Console 展示监控、诊断、处置建议、提案与实时进展。
- 通用诊断建议与可执行修复分离：当前受控 action 是绑定证据的 Deployment 容器镜像变更，不接受任意 YAML 或 shell。
- 已实现独立 dry-run、精确人工审批、执行回执、恢复观察及另行批准的回滚。**执行默认关闭，这套新增执行／恢复链路尚未完成最终集群 live 验收。**未知写入结果保持冻结，不自动重试。

部分诊断场景已有固定 Kind/K3s live 证据，但不是统计准确率基线，不代表全部扩充告警已验收或生产环境兼容。公开 HTTPS 演示和正式安装产物尚未提供。

## 本地体验 UI——合成数据

无需 Kubernetes 集群或模型 API Key。这是开发 fixture，**不是真实诊断或自动恢复演示**。

前置版本：Node.js **24.19.0**、npm **11.17.0**、Python **3.13.15**、uv **0.12.3**。以仓库 `.nvmrc`、Python 版本文件与 lockfile 为准。以下命令使用 POSIX shell。

```bash
git clone https://github.com/kkxiaoa/k8s-incident-agent.git
cd k8s-incident-agent
npm ci
uv sync --project services/agent-runtime --locked
install -d -m 700 "$HOME/.config/k8s-incident-agent"
uv run --project services/agent-runtime runtime operator init \
  --output "$HOME/.config/k8s-incident-agent/operator-verifier"
```

设置本项目独立密码，建议由密码管理器生成并保存。交互输入不会回显，只保存私有 verifier 文件；项目没有默认密码。已有文件不会被覆盖，可复用原文件或选用新路径。

终端 1，在仓库根目录执行：

```bash
OPERATOR_VERIFIER_FILE="$HOME/.config/k8s-incident-agent/operator-verifier" \
  node tests/e2e/manual-runtime.mjs
```

终端 2，同样在仓库根目录执行：

```bash
AGENT_RUNTIME_URL=http://127.0.0.1:18080 YAML_ASSISTANT_URL= \
  npm run dev -- --hostname 127.0.0.1 --port 3000
```

打开 <http://127.0.0.1:3000>，使用刚才设置的密码登录。手工 fixture 的 Origin 固定为此地址，不要替换成 localhost。兄弟项目 YAML 编写助手是可选导航，无需启动或安装。

fixture 加载 19 条诊断／修复生命周期案例和合成监控趋势，部分案例故意展示监控缺失。它不运行模型、Validator 或 Executor；批准可进入“等待执行领取”，后续结果来自不同预置快照，不会模拟 Kubernetes 写入。重启会重建 fake 数据并撤销 fake 会话；两个终端分别 Ctrl+C 停止，不影响真实 Runtime 数据库。不要把此测试服务公开到网络。

依赖安装、认证、真实 Runtime 配置、排错和公开只读限制见 [Getting started](documentation/getting-started.md)。

## 安全与访问

默认 private，单操作者、1 小时空闲滑动会话；不提供注册、多角色或 SSO。显式启用公开只读模式后，公众可查看已获公开许可的数据，**全部人工业务操作仍需登录**。公开模式不是跳过鉴权，公网 HTTPS 验收尚未完成。

浏览器不持有 Kubernetes 凭据，也不直连 Prometheus 或数据库；诊断 Agent 没有写工具或 shell。独立 Executor 必须校验完全一致且仍有效的已批准变更，UI 和 Prompt 不能代替服务端门禁。参见[安全政策](SECURITY.md)。

## 开发与文档

```bash
npm run lint
npm run build
```

[贡献指南](CONTRIBUTING.md) 列出完整检查和额外的 kubectl／Docker／Chrome 前置条件。`npm test` 并非只安装 npm 依赖即可运行；真实模型和集群评估是需单独授权的操作。

- [启动与配置](documentation/getting-started.md)
- [运维脚本](scripts/README.md)
- [监控与告警目录](monitoring/catalog/README.md)
- [故障注入场景与安全说明](scenarios/README.md)

Web/BFF 使用 Next.js、React、TypeScript；Runtime 使用 Python、FastAPI，LangGraph 编排确定性流程，LangChain 执行有界诊断；业务 SQLite 与 workflow checkpoint 独立；监控使用 Prometheus、Alertmanager、kube-state-metrics。当前模型基线为 `deepseek-flash` non-thinking，精确版本见仓库 manifest 与 lockfile。

## 许可证

[Apache-2.0](LICENSE)，第三方依赖保留各自许可证。
