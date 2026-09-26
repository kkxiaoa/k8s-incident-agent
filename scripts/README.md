# 项目脚本

本目录存放 K8s Incident Agent 的本地开发、安装与验收脚本。Kind 命令只服务固定本地沙箱；Scenario 命令服务固定 Kind 沙箱与经显式 context 指定的 `k3s-evaluation`；`deployment.mjs` 服务固定的 Kind/K3s 安装 profile，但只接受仓库内 manifest、固定 Namespace 和显式 kubeconfig context，不接受任意 manifest 路径或 `kubectl` 参数。

除非特别说明，命令都应在仓库根目录执行。

## 前置条件

- 已安装项目锁定版本的 Node.js、npm、Python、uv、Kind 和 kubectl；
- Docker daemon 可用；
- 已安装根目录 npm 依赖；
- 涉及现有集群的命令要求 kubeconfig 中存在固定 context `kind-k8s-incident-agent`。

先运行环境检查：

```bash
npm run doctor
```

版本基线分别来自 `.nvmrc`、`package.json`、`services/agent-runtime/.python-version`、`services/agent-runtime/pyproject.toml` 和 `deploy/kind/versions.json`，不要在脚本中单独维护另一份版本号。

## 命令总览

| npm 命令 | 底层脚本 | 用途 | 是否改变外部状态 |
| --- | --- | --- | --- |
| `npm run doctor` | `doctor.mjs` | 检查工具版本、Docker daemon 和 kubectl 版本偏差 | 否 |
| `npm run cluster -- up` | `kind-cluster.mjs` | 创建或验证固定 Kind 集群 | 是，集群不存在时创建 |
| `npm run cluster -- status` | `kind-cluster.mjs` | 验证现有集群是否符合固定基线 | 否 |
| `npm run cluster -- bootstrap-access` | `kind-cluster.mjs` | 安装固定诊断 RBAC 并生成受限 kubeconfig | 是 |
| `npm run cluster -- down` | `kind-cluster.mjs` | 删除固定 Kind 集群 | 是，破坏性操作 |
| `npm run deployment -- render <profile> --release <release.json>` | `deployment.mjs` | 离线渲染固定安装 profile | 否 |
| `npm run deployment -- status <profile> --context <context> --release <release.json>` | `deployment.mjs` | 只读核对版本、组件、Secret、workload、PVC、NetworkPolicy 对象与 RBAC | 否 |
| `npm run deployment -- install\|upgrade\|uninstall ... [--preview] --release <release.json>` | `deployment.mjs` | 默认预览精确资源集合 | 否 |
| `npm run deployment -- install\|upgrade\|uninstall ... --confirm --release <release.json>` | `deployment.mjs` | 对已核对的固定目标执行显式生命周期写操作 | 是 |
| `npm run deployment -- purge ... --preview\|--confirm <identity> --release <release.json>` | `deployment.mjs` | 预览或确认 K3s Runtime PVC/PV 数据清理 | `--confirm` 是破坏性操作 |
| `npm run deployment -- cutover <evaluation-profile> --context <context> --preview\|--confirm <confirmation> --release <release.json>` | `deployment.mjs` | 用固定一次性 Job 预览或确认早期 Runtime 业务库（Alembic `20260814_0001`/`20260901_0002`）的数据 cutover，保留 PVC | 是；`--confirm` 额外删除旧业务数据 |
| `npm run evaluation -- run <evaluation-profile> [--context <context>] --release <release.json>` | `evaluation.mjs` | 逐项验证七个 catalog scenario 与五类真实告警/诊断切片 | 是；会应用并清理 Scenario、重建固定 Pod、轮换 Webhook Secret，并执行受控监控中断探针 |
| `npm run evaluation -- online k3s-online --context <context> --release <release.json>` | `evaluation.mjs` | 验证 online profile 的只读 API 与人工入口缺失边界 | 否 |
| `npm run scenario -- list` | `scenario.mjs` | 校验并列出版本化场景的公开信息 | 否 |
| `npm run scenario -- apply <scenario-id>` | `scenario.mjs` | 安装指定 catalog fixture | 是 |
| `npm run scenario -- verify <scenario-id>` | `scenario.mjs` | 等待并验证场景的确定性证据条件 | 否 |
| `npm run scenario -- cleanup <scenario-id>` | `scenario.mjs` | 删除该场景 manifest 声明的对象 | 是 |
| `npm run openapi:generate` | `openapi-types.mjs` | 更新固定 OpenAPI artifact 与生成的 TypeScript types | 否，仅修改仓库内产物 |
| `npm run openapi:check` | `openapi-types.mjs` | 检查 OpenAPI artifact 与 TypeScript types 是否漂移 | 否 |

## `doctor.mjs`

`doctor` 读取仓库中的版本契约并检查：

- Node.js、npm、Python、uv、Kind 和 kubectl 是否满足锁定版本；
- Docker daemon 是否可用；
- kubectl client 与锁定的 Kubernetes minor 是否处于支持的一个 minor 偏差内；
- Kind node image tag、Kubernetes 版本和 SHA-256 digest 是否一致。

每项检查输出一行 `PASS` 或 `FAIL`。任一检查失败时进程退出码为非零；该命令不会创建集群、下载 Python 或修改项目文件。

## `kind-cluster.mjs`

集群身份固定为：

```text
cluster:   k8s-incident-agent
context:   kind-k8s-incident-agent
namespace: k8s-incident-scenarios
```

### 创建或验证集群

```bash
npm run cluster -- up
npm run cluster -- status
```

`up` 只在目标集群不存在时创建单 control-plane Kind 集群。若存在同名集群但 node image、Kubernetes minor、拓扑或 API endpoint 不符合锁定基线，命令会失败，不会自动删除或重建。

### 生成诊断凭据

```bash
npm run cluster -- bootstrap-access
```

该命令会应用仓库内固定 RBAC manifest，通过 Kubernetes TokenRequest 获取限时 ServiceAccount token，并在访问检查通过后原子替换：

```text
.runtime/diagnostic.kubeconfig
```

默认 `.runtime/` 权限为 `0700`，kubeconfig 权限为 `0600`。凭据内容不会输出到终端，也不得加入版本库。

可通过 `RUNTIME_DATA_DIR` 指定 `.runtime/` 或其中的专用子目录；该值不能指向仓库根目录、仓库外部路径或符号链接。

### 删除集群

```bash
npm run cluster -- down
```

`down` 只删除固定名称的 Kind 集群，但仍属于破坏性操作。其他命令不会隐式调用它。

## `scenario.mjs`

### 查看场景

```bash
npm run scenario -- list
```

`list` 会校验 catalog JSON、fixture manifest、固定 target 和路径安全约束，只输出身份、展示信息、trigger 和 target，不输出期望根因、允许工具或 verifier 等私有评估字段。

默认 catalog 位于仓库根目录 `scenarios/`。如需覆盖，可设置绝对、非符号链接的专用目录；文件系统根、用户 home 和仓库根等宽泛目录会被拒绝：

```bash
SCENARIO_CATALOG_DIR=/absolute/path/to/scenarios npm run scenario -- list
```

### 安装、验证与清理

Kind evaluation 使用固定入口：

```bash
npm run scenario -- apply image-pull-backoff
npm run scenario -- verify image-pull-backoff
npm run scenario -- cleanup image-pull-backoff
```

固定 K3s evaluation 安装完成后使用显式 context：

```bash
npm run scenario -- apply image-pull-backoff --profile k3s-evaluation --context <context> --release <release.json>
npm run scenario -- verify image-pull-backoff --profile k3s-evaluation --context <context> --release <release.json>
npm run scenario -- cleanup image-pull-backoff --profile k3s-evaluation --context <context> --release <release.json>
```

- `apply` 只应用 catalog 中已经校验的 manifest；
- `verify` 使用 Deployment UID → ReplicaSet owner UID → Pod owner UID 证明对象关联，再检查 `ErrImagePull` / `ImagePullBackOff` 和关联 Warning Event；
- `cleanup` 只删除该场景 manifest 声明的对象，不删除 Namespace 或 Kind 集群；
- 默认命令先验证固定 Kind 集群基线；K3s命令只接受`k3s-evaluation`和显式context，并复用`deployment status`对固定kubectl、K3s/Kubernetes版本、bundled components、安装对象、镜像、Secret、RBAC与readiness的只读门禁；
- `k3s-online`、未知profile、缺失或option形context以及额外kubectl参数都会在执行前拒绝。K3s路径不调用Kind CLI或固定Kind context。

`verify` 使用 120 秒 absolute deadline，`kubectl` 查询和轮询等待都计入该预算；单次查询最多 30 秒，并在剩余预算不足时自动收窄。成功结果只包含安全的对象 identity 和 reason，不包含原始 Event note；超时失败只输出最后一个静态 unmet-condition reason。

## `openapi-types.mjs`

```bash
npm run openapi:generate
npm run openapi:check
```

`generate` 先通过本地 `agent-runtime-openapi` 从生产 FastAPI app 离线导出
`contracts/agent-runtime.openapi.json`，再用锁定的本地 `openapi-typescript`
生成 `src/lib/agent-runtime/generated.ts`。两个产物都先写入同目录临时文件，生成成功且内容变化时才原子替换。

`check` 重新生成临时产物并按字节比较，不修改 tracked 文件。脚本只接受
`generate` 或 `check`，schema input 和 TypeScript output 均固定在仓库内，不接受
路径或 URL 参数；执行前需要先在 `services/agent-runtime` 完成 `uv sync --locked`。

## `release.mjs` / `release-smoke.mjs` / `publish.mjs`

构建、内容核验、双平台隔离启动、打包及人工发布说明见 [Candidates and approved releases](../documentation/releases.md)。
`release.json` 是生成产物，不写回源码；唯一共享 loader 供部署与评估使用。

`publish.mjs select/publish` 仅供受保护 release workflow 使用，不在发布时重建镜像；失败保留 draft/部分上传状态，同版本只允许相同内容续传。正式安装前可在对应的干净源码 checkout 执行 `node scripts/publish.mjs fetch --version vX.Y.Z --output <new-directory>`，只接受已正式发布且完整通过校验的 bundle；需要锁定版本的 `python3`，不需要 Docker 或集群连接。归档导入器 `release-archive.py` 由该命令内部调用，不是绕过批准状态的安装入口。
CI 候选只在本仓库 main push 的四组质量检查成功后构建，不授予发布/部署权限。
真实构建、容器运行与集群 live 分别需要授权；离线 mock Docker 测试不算真实 smoke。

## `evaluation.mjs`

评估入口不接受任意 URL、Namespace、manifest、PromQL、artifact 路径或
kubectl 参数。Kind 只使用固定 context；K3s 必须显式提供经过 deployment status
门禁的 context。命令会在本机回环建立 Runtime、Console、Prometheus 与
Alertmanager 的固定临时 port-forward，完成后关闭。

```bash
npm run evaluation -- run kind-evaluation --release <release.json>
npm run evaluation -- run k3s-evaluation --context <context> --release <release.json>
npm run evaluation -- online k3s-online --context <context> --release <release.json>
```

`run` 复用 `scenario.mjs` 已校验的私有评估投影，逐 entry 证明健康基线、真实
Prometheus/Alertmanager firing、健康对照不触发、唯一 Incident/Run、required
Evidence 及其根因引用、必要 panel、具备完整 lifecycle payload 的 SSE replay、Console
稳定详情、目标 Incident 自身的重复投递去重和 resolved 信号。场景彼此独立执行；单项
失败会保留固定错误分类并继续后续 entry。重复投递按目标 Incident 的 `updatedAt` 推进
判断，不使用可能被 Watchdog 等其他告警污染的全局 webhook 计数。
最后还会受控缩放并恢复 kube-state-metrics/Prometheus，以验证 stale 与 monitoring
unavailable 状态，然后轮换两个 Namespace 的同值 Webhook Secret、重建 Runtime 与
Alertmanager，并要求 Watchdog 接收时间严格推进后再次证明链路健康。

命令在任何 live 副作用前通过共享 `release.mjs` loader 校验显式选择的
`--release <release.json>`。当前 Git worktree 必须干净，HEAD 与 manifest 的
`sourceRevision` 完全一致；两组件 OCI 的 index、manifest、config 和全部 layer
均检查 size/digest，且恰有 linux/amd64、linux/arm64 两个平台、同 source、非 root。
应用镜像身份只来自该 manifest。相同已验证 manifest 传给 deployment status
及 scenario 的 K3s preflight，不重复选择另一份镜像身份。

online 产物固定原子写入 `.runtime/evaluation/<profile>.json`；dataset run 使用
`<profile>-<dataset-id>-v<dataset-version>[-focused].json`，与普通 run 及其他数据集版本的结果互不覆盖。
目录/文件权限分别为 `0700`/`0600`。artifact 包含所选 release manifest、数据集身份、布尔检查、状态、计数、
Evidence kind、诊断 code 和 panel ID；不包含 Secret、token/hash、原始 Evidence、模型
陈述、Event note、日志、上游响应或任意凭据。该命令具有上述精确 live 副作用，仍须在
用户授权后运行；它不会 install/uninstall、purge、删除 Namespace/PVC/PV/Secret，或
修改 cert-manager 与兄弟项目资源。

## `deployment.mjs`

固定 profile 为：

```text
kind-evaluation
k3s-evaluation
k3s-online
k3s-public
```

所有 deployment 命令必须显式提供 `--release <release.json>`，并使用对应的干净源码。
`render`、`install|upgrade|uninstall` 默认只执行本地
`kubectl kustomize`，不会读取 kubeconfig 或访问集群。所有确认写操作和
`status` 都要求显式 `--context`，先精确核对仓库锁定的 kubectl 与目标
Kubernetes/K3s 版本；Kind 还要求固定 context。K3s 会继续核对 CoreDNS、
Traefik、local-path-provisioner 的固定镜像与当前可用性，以及默认 StorageClass。
确认 install/upgrade 还要求固定单节点 Ready、两个应用 manifest 可解析的
`ghcr.io/kkxiaoa/k8s-incident-agent-<component>@<index-digest>` identity 已导入，并通过 kubectl
内部投影只返回固定模型 Secret 与两个 namespaced `alertmanager-webhook` Secret 的
key 是否非空，不把 Secret value 返回给生命周期
脚本。任何检查失败都不会回退到宽权限、宿主机 Runtime 或内存数据。
所选 release 的每个逻辑镜像是一个只含`linux/arm64`与`linux/amd64`的OCI index。containerd
导入archive后默认只为顶层index保留tag；即使使用`ctr images import --digests`，也
不会自动生成manifest所引用的应用repository@index。因此operator必须在导入同一
archive后，使用`ctr images tag <imported-reference> <canonical-repository>@<index-digest>`
为同一index增加精确reference。预检继续要求完整repository@index，不降级为可变tag。
镜像导入/预取是另行授权的安装准备动作。render/status 基于临时 release Kustomize overlay；
server dry-run 与实际 apply 使用同一份渲染内容。裸 `kubectl kustomize` 只得到源码模板，
不是安装产物。第三方 monitoring 镜像 digest 由 `deploy/application/versions.json` 与
`deploy/monitoring/base/workloads/kustomization.yaml` 共同锁定，deployment 校验两者一致，不随 release 变化。
Kind 静态 hostPath 额外由同一锁定 Runtime image 的受限 init 只调整挂载根
ownership；migration 和 Runtime 本身仍保持非 root。status 按固定 kubectl 的资源
列表命令 `apiVersion: v1, kind: List` producer contract 校验，并忽略 RollingUpdate
已带删除时间的旧 Console Pod。`INCIDENT_INTAKE_MODE` 直接位于
Console 与 Runtime 的 Deployment Pod template；base 为 `manual`，`k3s-online`
overlay 改为 `online` 并触发 rollout。ConfigMap 不重复保存该值，status 会
核对实际容器 env 与 rollout generation，防止 profile 已升级但进程仍使用旧 mode。

只有 `k3s-public` 渲染 Console Ingress 与放行 Traefik 访问 Console 的 NetworkPolicy
`allow-traefik-to-console`：Ingress 只匹配 `incident.kubesmith.cloud`，并使用本项目的
TLS Secret `incident-console-tls`（证书单独签发）。`k3s-evaluation` 与 `k3s-online` 不渲染
这两个对象，只能经 port-forward 访问：没有 host 的规则会同时响应节点地址，并在同一 Traefik 上
压过相邻站点的 IngressRoute。status 按渲染结果核对：公开 profile 要求 host、TLS 与后端一致
且 Traefik 已分配地址；其他 profile 发现 `incident-console` Ingress 或多出的 NetworkPolicy 即失败。
v0.1.1 及更早版本的私有 K3s 安装带有这两个对象，从 `k3s-public` 切换到私有 profile 也会留下它们；
`upgrade` 不删除渲染结果之外的已有对象，清理前会在最后的 status 核对处失败。先确认它们带有
`app.kubernetes.io/part-of: k8s-incident-agent` 标签，再手动删除，然后重新执行 status：

```bash
kubectl --context <context> --namespace k8s-incident-agent get ingress/incident-console networkpolicy/allow-traefik-to-console --show-labels --ignore-not-found
kubectl --context <context> --namespace k8s-incident-agent delete ingress incident-console --ignore-not-found
kubectl --context <context> --namespace k8s-incident-agent delete networkpolicy allow-traefik-to-console --ignore-not-found
```

`k3s-public` 在 `k3s-online` 之上固定 `OPERATOR_ORIGIN=https://incident.kubesmith.cloud`、
`CONSOLE_ACCESS_MODE=public_demo` 与 `YAML_ASSISTANT_URL=https://yaml.kubesmith.cloud/`。
公开数据批准不由部署写入：migration 与 Runtime 容器只从安装者预先创建的 ConfigMap
`agent-runtime-public-approval` 读取 `PUBLIC_DEMO_DATA_APPROVED` 一个键；对象或键缺失时 Pod 无法启动，
值为假或无法解析时 Runtime 拒绝以公开模式启动。

所有 profile 都渲染 digest 锁定的 Prometheus、Alertmanager
与 kube-state-metrics。operator 固定核对三个独立 ServiceAccount、当前
Pod/ReplicaSet 最小 KSM RBAC 与 allow/deny、resource/metric allowlist、15秒
scrape/evaluation、15天与1600MB TSDB上限、Prometheus保留PVC、配置/rule与catalog、
配置digest触发的rollout、健康probe、ClusterIP Service及两个Namespace的精确
NetworkPolicy对象。Runtime与Alertmanager分别挂载本Namespace中同名Secret的
`token`；两个对象的同值只能由安装流程和真实Webhook验收证明，status不读取明文。

K3s profile 启用 Kustomize Component
`deploy/monitoring/components/node-metrics`：Prometheus 以自身 projected token /
集群 CA 严格 TLS 读取固定单节点 kubelet 的 `/metrics/resource|cadvisor|probes`，
通过 `k8s-incident-scenarios` 内 `pods` `list/watch` 的 pod-role 服务发现为每个
regular 容器生成 target，并在入库前用 `keepequal` 只保留属于该容器的样本
（init / ephemeral / 其他 Namespace / `container=""` 样本丢弃）。三条 job 的
`sample_limit: 20` 故意收紧：整节点级过滤失效（如 `keepequal` 整体丢失）时整次
抓取失败而不是把整个节点入库；局部失效由 operator 对 scrape 配置的精确匹配兜底。
`up` 等 report 序列不经 metric relabel，会带 `scrape_*` 辅助标签（值为本项目对象名）。
install/upgrade/uninstall 的 `--preview` JSON 除 `resources`（kustomize 渲染集合）外
以 `operatorBoundResources` 列出由 operator 而非 kustomize 应用 / 删除的
ClusterRole/ClusterRoleBinding，供操作者与 CI 读取完整对象集合。
operator 精确核对 `prometheus.yaml` 的 `scrape_config_files`、node-metrics scrape
配置、Pod 发现 Role/RoleBinding、新增 egress NetworkPolicy、credential/scrape
挂载与含 scrape 数据的配置 digest；并要求告警目录里每个面板的 `producer` 都有同名
scrape job，否则渲染失败——不启用 node-metrics 的 profile 豁免三条
kubelet job，其余 producer 一律强制；`nodes/metrics` 的 ClusterRole/ClusterRoleBinding
不在 overlay 中，由 install/upgrade 在 admission boundary 就绪后把
`deploy/monitoring/components/node-metrics/cluster-rbac.yaml` 的 `__REGISTERED_NODE__`
绑定到唯一 Ready 节点并经 stdin apply，status 按同一节点名比对、并对 prometheus
ServiceAccount 做 `pods list/watch`、`nodes/<node>/metrics get` 正向与
`pods get`、无名 `nodes/metrics`、`nodes get/list`、`nodes/proxy` 负向 SSAR。
`status` 以 `monitoring.nodeMetrics = { configuration: "bound", node,
collection: "requires-live-probe" }` 报告：组件存在与 RBAC 绑定不证明端点可读、
样本新鲜或过滤有效，这些需要另行授权的 live 验证。`kind-evaluation` 不启用该组件
（kubeadm 默认 kubelet 自签 serving 证书无法用集群 CA 严格校验），status 要求该
ClusterRole/Binding 不存在并对 prometheus 做全部负向检查。普通 `uninstall` 在
kustomize 删除后核对 ClusterRole/Binding 的 `app.kubernetes.io/part-of` /
`app.kubernetes.io/name` ownership 标签，仅删除本项目自己创建的对象；标签不符时以
`ownership_mismatch` 拒绝且不删除。

普通 `uninstall` 使用独立 Kustomize 资源集合，从结构上排除 Namespace、PVC
、PV、Secret和证书资源，并在已有Runtime/Prometheus PVC时核对卸载前后UID不变。
现有`purge`只管理Runtime数据：它必须先确认应用 Namespace 内标准 Pod controller 与 Pod 均已卸载，
再把当前 PVC/PV UID 组成的精确
identity 返回给操作者；只有同一次确认仍匹配当前对象且 K3s PV 使用
`Delete` reclaim policy 时才请求删除。Kind 静态 hostPath 无法由 Kubernetes
对象删除证明底层数据已清理，因此该脚本拒绝 Kind purge；Prometheus PVC 当前没有
自动purge入口。

Runtime 数据 cutover 只处理 Alembic head 为 `20260814_0001` 或 `20260901_0002` 的早期业务库：清除其业务数据、
checkpoint 与 artifact 并重建空业务库，PVC 保留；缺失、空库或已完成 cutover 的空库只做收尾，其他状态一律拒绝。
只接受 `kind-evaluation` 与 `k3s-evaluation`：

```bash
npm run deployment -- cutover k3s-evaluation --context <context> --preview --release <release.json>
npm run deployment -- cutover k3s-evaluation --context <context> --confirm <cutover-confirmation> --release <release.json>
```

cutover 要求应用 workload 已停止，并重新核对固定集群版本、单 Ready node、
锁定 Runtime image、Namespace/PVC/PV identity、唯一 `default-deny` 和三类 API
mutator 空集合。preview 也会以锁定 Runtime image 创建一次无 token、无 Secret、
无网络 allow、单 Pod、零重试的固定 Job，因此不是离线只读操作；真实 admitted Pod
必须保持 `SchedulingGated`，通过固定安全投影后才用 UID/resourceVersion 前置条件
移除 gate。每个 Job 无论结果如何都按创建时的 UID 清理，普通 install/upgrade
发现 Job 或 owner Pod 残留时会在 apply 前拒绝。

preview 只输出有界 reset 摘要和绑定当前集群/PVC/image/Runtime plan 的版本化
confirmation。confirm 会先运行一个全新 preview Job，再重读全部外部 identity；只有
用户 confirmation 仍匹配时，才把该次 Runtime `planDigest` 传给新的 confirm Job。
不接受 image、PVC、Namespace、manifest、路径、SQL、Run ID、环境变量或任意命令参数。

公开的本地启动步骤和真实环境前置条件见
[Getting started](../documentation/getting-started.md)。这些模板只用于固定 profile，
不能直接安装到任意集群。真实 image import、apply、
uninstall、purge 与 NetworkPolicy enforcement 都需要对应 live 授权。

私有 profile 默认不配置兄弟项目入口，`k3s-public` 固定指向 `https://yaml.kubesmith.cloud/`。
其他环境确实部署了独立 YAML 编写助手时，可在本项目
`incident-console-config` 中显式设置 `YAML_ASSISTANT_URL` 并重启 Console；不要修改
兄弟资源。该值只是普通导航，既不是安装依赖也不是 Runtime 上游。
URL 的合法性由 Console 配置边界校验（无凭据的 HTTP(S) URL 或同源绝对路径，
禁止 query/fragment）；deployment status 只核对 profile 渲染出的值（即 `k3s-public` 的固定地址），
自行添加的键不参与比较，也不探测外部链接。

Console 页脚可显示 ICP 备案号：在 `incident-console-config` 中设置 `PUBLIC_ICP_RECORD`，
只接受“省份简称 + ICP备 + 编号 + 号（可带 -N）”形式的纯文本，例如 `京ICP备12345678号-1`；
链接固定为 `https://beian.miit.gov.cn/`，未设置时不显示，其他值使 Console 配置失败。

## `deploy-gateway.mjs`

受限部署入口：在固定 K3s 主机上由专用部署用户的 SSH 强制命令调用，配置文件路径是它唯一的
命令行参数。网关程序、专用用户、强制命令、主机配置与部署身份都由集群管理员在主机初始化
（bootstrap）时安装，调用方无法修改。调用方只能经 stdin 发送一行 JSON：

```json
{"version":"vX.Y.Z","profile":"k3s-public"}
```

版本必须是已正式发布的稳定版本；profile 只能是 `k3s-evaluation` 或 `k3s-public`，并且在主机
配置允许的集合内（`k3s-online` 不设置 `OPERATOR_ORIGIN`，install 与 upgrade 同样拒绝它）。
SSH 会话请求的命令（`SSH_ORIGINAL_COMMAND`）、多余字段或多行输入一律拒绝。网关丢弃 SSH 会话
带来的环境变量，子进程只使用固定的最小环境。主机配置是不超过 4 KiB 的 JSON 文件，字段固定为
`schemaVersion`（`1`）、`profiles`、`kubeconfig`（部署身份 kubeconfig 的绝对路径）、`context`、
`workRoot`（网关工作目录）与 `registryProxy`（访问 GHCR 的 HTTP 代理，可为 `null`）。

执行顺序：

1. 经 GitHub API 核对 release 已正式发布、tag 指向 `sourceRevision`、附件齐全，只下载
   `release.json` 并按附件 digest 校验；
2. 按 release tag 浅取回源码，核对提交号，拒绝 symlink 与 submodule；
3. 经 `registryProxy` 向 GHCR 核验两个镜像的 index、双平台、非 root 与源码 revision 标签，
   规则与 `release.mjs` 核验本地 bundle 相同，不下载镜像层；
4. 核对主机 kubectl 与 K3s 版本等于 release 锁定的基线，再用网关自身的代码渲染所选 profile，并
   执行 install / upgrade 在 apply 前做的同一组渲染检查。
   两个项目 Namespace 内的 ConfigMap、Service、Deployment、NetworkPolicy 与 Ingress 属于日常
   更新；Namespace、ServiceAccount、RBAC、准入策略与 PVC 属于 bootstrap，必须与集群现状一致
   （标签以及 Namespace、PVC 的 spec 允许服务端默认值，RBAC 规则与绑定、ServiceAccount 的
   token 挂载和准入策略须完全相同）；其他类型直接拒绝。工作负载不能使用宿主机 namespace、
   hostPath、hostPort、特权、新增 capability 或项目以外的 ServiceAccount。公开数据只由安装者批准：release
   不能带批准 ConfigMap，ConfigMap 中的 `PUBLIC_DEMO_DATA_APPROVED` 不能为真，容器 env 只能以
   `configMapKeyRef` 引用 `agent-runtime-public-approval`，`CONSOLE_ACCESS_MODE` 只能出现在
   `agent-runtime-config`（Runtime 读取环境变量时不区分大小写，任何大小写写法都按同一个键处理）；
5. apply 只更新、不删除，因此集群中带 `app.kubernetes.io/part-of=k8s-incident-agent` 标签的
   日常类型对象必须恰好是渲染结果（bootstrap 创建的公开数据批准 ConfigMap 除外）：缺少的对象
   先由 bootstrap 创建，多出的对象（例如改用不渲染 Console Ingress 的 profile 时遗留的 Ingress）
   先由 bootstrap 删除。Deployment 引用运行版本未使用的 Secret（或 Secret 中的键）时拒绝：Secret
   由 bootstrap 创建，网关无权读取它们。网关 Job 需要的 `deploy-jobs` 与 `runtime-backup` 不存在时
   拒绝；留有未完成的 Runtime 数据 cutover 时拒绝，与 install / upgrade 相同；
6. 渲染结果为公开访问模式时要求 `agent-runtime-public-approval` 已批准，随后对全部日常对象做
   服务端 dry-run；
7. 预拉取 Job 让节点按 digest 拉取两个镜像，旧版本在此期间照常服务。网关 Job 的 Pod 不带项目标签，
   结束后不计入 status 对项目 Pod 的核对；
8. Runtime 缩容到 0 并等待 Pod 退出，备份 Job 用新版本 Runtime 镜像的 `runtime backup` 保存数据。
   新版本的迁移不认识现有数据的 Alembic head 时（即降级到不兼容的版本），备份以
   `schema_unknown` 拒绝，旧版本恢复运行；
9. apply 日常对象，Runtime 以新镜像启动时由 `migrate` 初始化容器迁移数据库；网关等待全部
   Deployment rollout，渲染出 Ingress 时还核对它与渲染一致且已由 Traefik 分配地址。

结果以一行 JSON 写到 stdout：`status`、`version`、`profile`、`sourceRevision`、被替换的 Runtime
镜像 `previousRuntimeImage`、`backup` 以及备份时数据的 `alembicHead`。每进入一个阶段，在 stderr
写一行 `phase <名称>`；失败时 stdout 输出 `status: "failed"` 及 `code`、`phase`、`message`，
退出码为 1。drain 阶段读到运行中的 Runtime 之后失败时还带 `previousRuntimeImage`，备份完成
之后失败时再带 `backup` 与 `alembicHead`。读不到 `runtime` 容器的镜像时（容器或镜像缺失，或镜像
引用超过 512 个字符），`previousRuntimeImage` 为 `null`。

失败处理：

- 缩容或备份失败时集群对象尚未改变，网关把 Runtime 恢复为原副本数后报告原失败，备份命令给出的
  拒绝原因附在 `message` 末尾；恢复本身失败时返回 `runtime_not_restored`，需要人工把
  `agent-runtime` 扩回原副本数。
- apply 及之后的失败只停止并报告，不自动回滚、不清库、不 purge；apply 阶段失败时 Runtime 可能
  仍为 0 副本，需要人工核对。
- 输出只是尽力而为：SSH 连接中断后网关照常完成本次部署或失败处理，结果需在集群中核对。
- 同一时刻只允许一次部署。网关进程被强制终止时不会执行恢复与清理，先人工确认没有部署在进行、
  核对 `agent-runtime` 的副本数，再删除 `workRoot` 下的 `deploy.lock`。

网关只部署与自身兼容的 release：部署契约不兼容时在渲染阶段拒绝，需要先经 bootstrap 更新网关；
Runtime 镜像不含 `runtime backup` 的版本在备份阶段失败，集群保持原版本。

`deploy/application/gateway/` 只由 bootstrap 应用，任何 profile 都不包含它：

- `deploy-gateway` ServiceAccount 只能按名称读取并 patch 渲染出的日常对象、列出两个项目
  Namespace 内的日常类型对象与应用 Namespace 的 Pod、缩放 Runtime、创建 Job 并读取其状态与日志，
  按名称读取 bootstrap 对象与 Job 所需的 `deploy-jobs`、`runtime-backup`；没有直接读取 Secret、
  ServiceAccount token、PV 或 exec 的权限，也不能写 RBAC、Namespace 或准入策略。它能更新挂载
  Secret 与 Runtime 数据的项目 Deployment：kubeconfig 在网关之外被使用、或已发布的 release 被篡改
  时，Secret 可被间接读取，Runtime 数据与集群内的全部备份可被删改。因此 kubeconfig 须与这些
  Secret 同等保护，只保存在主机上、仅部署用户可读；备份 PVC 防的是升级失败，要抵御这类情况，
  恢复点须拷到集群之外。release 新增或删除日常对象时，需同步更新这里的对象名称。
- 准入策略 `k8s-incident-agent-deploy-gateway` 只约束该身份的写入：禁止宿主机 namespace、
  hostPath、hostPort、特权与新增 capability；Deployment 只能使用项目 ServiceAccount；Job 只能运行
  网关的两条固定命令（预拉取运行 `/bin/true`，备份运行 `runtime backup`），不能带 lifecycle 钩子、
  探针、端口、额外参数或 Secret 引用，Pod 的 `app.kubernetes.io/name` 只能是 `deploy-prefetch` 或
  `runtime-backup`（不会被任何 NetworkPolicy 放行），以 `deploy-jobs` 运行、不挂载凭据、只按固定
  路径挂载 `runtime-data` 与 `runtime-backup`；镜像只能是
  本项目 GHCR 仓库的 digest 或 `deploy/application/versions.json` 锁定的第三方 digest；Service
  只能是 ClusterIP 且不带 externalIPs；Ingress 只能把 `incident.kubesmith.cloud` 路由到
  `incident-console`。网关生成的 Job 形状或第三方 digest 变化时须同步更新该策略。
- `runtime-backup` PVC（5Gi，local-path）保存备份。

`runtime backup --destination <绝对路径>` 持有 Runtime 自身的锁（Runtime 仍在运行时以
`runtime_in_use` 拒绝），用 SQLite 在线备份复制业务库与 checkpoint 并做完整性检查，复制 run
artifact，在 `backup.json` 中记录 Alembic head 与每个文件的 SHA-256；数据的 Alembic head 不在
所用镜像的迁移中时以 `schema_unknown` 拒绝。备份目录按 UTC 时间命名（如
`20260926T071500Z`），成功后只保留最近 3 份（刚完成的一份始终保留），不触碰其他目录。网关
每次部署在备份阶段生成一份，所以保留的是最近 3 次部署之前的数据；需要长期保留的恢复点应另行
拷出备份 PVC。成功时在 stdout 输出一行 JSON（`backup`、`alembicHead`、`files`、`bytes`、
`removed`），失败时在 stderr 输出 `{"error":{"code":…,"phase":"backup"}}` 并以 1 退出。

恢复是需要另行授权的人工操作：

1. 按 `backup.json` 的 `alembicHead` 选择要运行的 release：它的迁移必须包含这个 head，例如
   升级失败后回到该次部署输出（成功或失败）中 `previousRuntimeImage` 对应的升级前版本；
2. Runtime 缩容为 0 后，用同时挂载两个 PVC、以 UID 10001 运行的一次性 Pod，把 Runtime 数据
   目录中的两个数据库、它们的 `-wal` / `-shm` 文件以及 `runs/` 整体移出另存，避免遗留的 WAL
   与恢复的数据库错配；
3. 按 `backup.json` 核对所选备份各文件的 SHA-256，把其中的 `incidents.sqlite3`、
   `checkpoints.sqlite3` 与 `runs/` 放回（文件 0600、目录 0700），确认没有 `-wal` / `-shm`；
4. 让 Deployment 使用第 1 步选定的 release 后扩容，`migrate` 会把数据迁移到该版本的 Alembic head。

## 测试与静态检查

默认测试入口会运行本目录全部 `*.test.mjs`：

```bash
npm test
npm run lint
```

排查单个脚本时可以直接运行对应测试文件：

```bash
node --test scripts/doctor.test.mjs
node --test scripts/deployment.test.mjs
node --test scripts/kind-cluster.test.mjs
node --test scripts/openapi-types.test.mjs
node --test scripts/scenario.test.mjs
```

测试使用临时目录和受控命令替身；默认 `npm test` 不创建、修改或删除真实 Kind 集群。

## 安全约束

- 所有外部命令都通过参数数组执行，不启用 shell；
- OpenAPI 生成只使用本地 FastAPI exporter、固定本地 artifact 和固定本地 TypeScript output；
- 集群、context 和 Namespace 身份固定，脚本不会连接任意用户输入的目标；
- 场景 ID 必须来自已经校验的 catalog，不能作为文件路径或额外命令参数；
- deployment profile、Namespace、资源名、镜像 digest 与 manifest 路径均来自仓库固定契约；只有显式 context 由操作者选择，并在任何写操作前核对目标版本/发行版；
- deployment lifecycle preview 默认无副作用；cutover preview 会创建并清理固定 Job，必要时创建并保留 `default-deny`；install、upgrade、uninstall、purge 与 cutover 的破坏性路径都必须使用各自的显式确认模式，普通 uninstall 永不包含 Namespace、PVC、PV、Secret 或证书对象；
- `up`、`bootstrap-access`、`down`、`scenario apply` 和 `scenario cleanup` 有明确副作用，运行前应确认目标状态；
- 脚本不会自动执行完整 live 验收序列，也不会自行决定最终保留 fixture 或 cleanup；
- kubeconfig、token、CA data 和原始敏感响应不得写入日志、测试 fixture 或版本库。

## 退出状态

- 成功时退出码为 `0`；
- 参数错误、版本漂移、基线不匹配、权限不足、请求超时或验证条件未满足时退出码为非零；
- `doctor` 使用逐项 `PASS` / `FAIL` 输出；
- `scenario` 失败输出格式为 `FAIL <code> <message>`，不会附带原始 Kubernetes 响应。
