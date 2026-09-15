# K8s Incident Agent

面向受支持的真实 Kubernetes 环境构建 evidence-first 故障响应 Agent。目标不是生成泛化运维建议，而是完成“故障发现、证据收集、根因诊断、修复验证、人工审批、受控执行、恢复复查与失败回滚”的可观测闭环。

## 当前状态

项目已完成一个可安装、可恢复的只读诊断垂直切片：

- 已实现来源中立的持久化 Incident、可重复 Run、只读 Kubernetes Evidence、诊断 Agent、REST/SSE BFF 与 Incident Console；
- 当前工作区增加单操作者登录、30 分钟可撤销会话、Origin/CSRF 与读取/SSR/SSE 认证；该认证变更尚未进行集群 live 验证，不代表审批或执行已开放；
- 固定 Kind 与单节点 K3s profile 已使用同一组双架构 Console / Runtime 产物完成安装、真实诊断、网络与身份门禁、持久化恢复和普通卸载验证；这不是任意 Kubernetes 兼容性承诺；
- development / evaluation 可手动触发版本化场景；online profile 禁止人工创建 Incident，允许认证操作者对已有 Incident 重新诊断或准备修复；
- Alertmanager intake、managed monitoring、有界 Prometheus 查询、Run-owned Evidence 与 Console 必要指标图表已实现；五个故障族的七个场景已有 fixed Kind/K3s 组合 live 证据，不代表任意 Kubernetes 兼容性或统计准确率、延迟、恢复率基线；
- Evidence-bound 镜像修复提案、独立 server-side dry-run、持久等待、精确审批/执行账本、独立 Executor、确定性恢复验证和另行批准的显式回滚已实现并通过离线验证。`SANDBOX_EXECUTION_ENABLED` 默认 `false`，关闭时不注册审批端点；显式开启后，认证操作者只能批准本次 Run 的 exact proposal，由独立 Executor 执行一次受控写入。该链路尚未完成部署启用、最终镜像与集群 live 验收。
- 当前 Console 已接通准备、有限历史镜像选择、批准/拒绝、重新准备、重新诊断及显式回滚；JSON Patch 保持只读。已领取但结果不确定的执行保持 `UNKNOWN` 并占用目标，禁止自动重试、回滚或释放；可信写入回执不等于恢复成功，恢复结论须由独立观察证明。UI 的离线浏览器测试不替代真实集群执行验收。

## 产品边界

K8s Incident Agent 负责应用运行后的故障响应；已有的 K8s YAML Authoring Copilot 负责部署前的 YAML 编写、检索、校验、生成和修复。两个产品保持独立，后续通过 Header 普通导航和受控 Patch 交接形成从“配置设计”到“运行诊断”、再从“修复 Patch”回到“配置审阅”的业务闭环。

产品目标是服务受支持真实环境中的故障发现、诊断与受控修复。当前只在固定 Kind 与固定单节点 K3s 演示基线验证，不连接生产集群，也不自动执行修复；该限制是当前安全门禁，不是产品定位。后续只有通过明确兼容矩阵、身份授权、发布与安全门禁的环境才属于受支持范围。

## 本地开发

```bash
npm install
npm run dev
```

打开 <http://localhost:3000>。Console 需要独立运行的 Runtime；缺少 Runtime 或认证配置时不会回退为匿名或静态数据。

### 首次设置登录密码

项目没有默认密码或注册入口。首次运行前，由安装者设置本项目的独立密码；建议使用密码管理器生成并保存。安装 [uv](https://docs.astral.sh/uv/getting-started/installation/) 后，在仓库根目录的交互式终端运行：

```bash
uv sync --project services/agent-runtime --locked
install -d -m 700 "$HOME/.config/k8s-incident-agent"
uv run --project services/agent-runtime runtime operator init \
  --output "$HOME/.config/k8s-incident-agent/operator-verifier"
```

按提示输入两次密码（终端不回显）。命令只创建权限为 `0600` 的密码校验文件，不保存或打印原始密码，也不会覆盖已有文件。浏览器登录时输入刚才设置的密码，不是校验文件的内容。口令上限为 1024 UTF-8 bytes；不要通过命令行参数或管道传入口令。

在启动 Runtime 的终端中配置以下两项（也可将路径与 Origin 写入 Runtime 的 `.env`，不要写入密码或校验文件内容）：

```bash
export OPERATOR_VERIFIER_FILE="$HOME/.config/k8s-incident-agent/operator-verifier"
export OPERATOR_ORIGIN="http://localhost:3000"
```

`OPERATOR_ORIGIN` 必须与浏览器完全一致、无尾斜杠；`localhost` 和 `127.0.0.1` 不互换。校验文件使用锁定的 Argon2id 参数，Runtime 只读取它；不要上传到版本库、Issue 或日志。忘记密码或需要轮换时，用同一命令创建一个新路径的校验文件，更新 Runtime 的配置后重启，无须删除业务数据。

会话采用 30 分钟空闲滑动过期，不设绝对期限。可见页面的鼠标点击、键盘和滚轮操作触发续期（最多每分钟一次，期限从最近成功续期计算）；后台轮询、SSR 和 SSE 不续期。退出或普通 Runtime 重启会撤销会话。Cookie 始终为 HttpOnly / Secure / SameSite=Strict，HTTP 例外仅限 loopback；远程访问须配置本项目 HTTPS。没有绝对期限意味着被盗会话若持续续期，可能保持有效直到撤销。

### 使用测试数据走查 UI

仅走查测试数据 UI 时，可在仓库根目录的两个终端分别启动以下服务（无需集群或模型）。fake Runtime 复用已安装 Runtime 的密码校验器；会话与业务数据仍为测试实现，不能作为生产认证或诊断验收证据。

```bash
OPERATOR_VERIFIER_FILE="$HOME/.config/k8s-incident-agent/operator-verifier" node tests/e2e/manual-runtime.mjs
```

```bash
AGENT_RUNTIME_URL=http://127.0.0.1:18080 npm run dev -- --hostname 127.0.0.1 --port 3000
```

浏览器打开 `http://127.0.0.1:3000`，使用 `operator init` 时设置的密码；此测试入口固定为该 Origin，不要替换为 `localhost`。

手工入口启动时自动加载 14 条带 `T7`–`T10` 标签的走查案例：执行待领取/已领取/UNKNOWN、恢复观察/成功/监控不可用、回滚待审批/成功/无法证明恢复/UNKNOWN，以及诊断准备/待审批/拒绝/过期。可从首页列表进入，并沿“查看来源运行”查看诊断、修复与回滚历史。

这些案例包含与启动时刻对齐的合成监控趋势，可切换图表时间范围。故障、恢复观察和恢复成功分别展示对应快照；两条“监控不可用”案例故意保留空态。图表不是实时集群指标，也不会因点击批准而自动演示恢复。

这些是内存中的 UI 测试快照，不运行 Executor，也不产生 Kubernetes 写入。批准按钮可走到“等待执行领取”，后续执行/恢复展示使用对应预置案例；不要把它当作自动恢复演示。重新准备会生成新的测试提案；重启 fake Runtime 会重建案例并撤销 fake 会话，不影响真实 Runtime 数据。

### 集群与评估凭据

集群 profile 将外部管理的 `k8s-incident-agent/operator-auth` Secret 中 `password-verifier` 只读挂载到 Runtime，不挂载到 Console、迁移容器或 Validator。安装检查只返回该 key 存在与否。Kind evaluation Origin 固定为 `http://127.0.0.1:13000`；K3s 必须先明确本项目 HTTPS Origin/TLS，当前未配置模板会在安装前拒绝，不借用兄弟项目证书。实际 HTTPS 安装验收尚未完成。

既有 `evaluation` 命令另需 `OPERATOR_PASSWORD_FILE`（绝对路径、私有普通文件、无尾换行的原始口令，最多 1024 bytes）与匹配的 `OPERATOR_ORIGIN`。它通过固定 loopback port-forward 登录，将 Cookie/CSRF 仅保留在内存并发送到项目 Runtime/Console，不发送到 Prometheus/Alertmanager、不写入评估产物。这证明私有隧道上的会话链路，不替代 K3s 浏览器 HTTPS 验收。

## 工程检查

```bash
npm run lint
npm run build
```

## 技术栈基线

- Web 与 BFF：Next.js 16、React 19、TypeScript 5、Tailwind CSS 4、REST / SSE；
- Agent Runtime：Python 3.13、FastAPI、Pydantic 2、LangChain、LangGraph；
- 模型基线：`deepseek-flash` non-thinking，`deepseek-v4-pro` 作为评估候选；
- 基础设施：Kind（开发/CI）、K3s（首个演示部署）、Kubernetes Python Client，以及 digest 锁定的 Prometheus、Alertmanager、kube-state-metrics managed profile；
- 数据与状态：SQLite、SQLAlchemy、Alembic、独立 LangGraph checkpointer；
- Agent 工具：类型化 Function Tools；MCP、多 Agent 与无人审批的生产自动修复不在当前范围。
