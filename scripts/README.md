# 项目脚本

本目录存放 K8s Incident Agent 的本地开发、安装与验收脚本。Kind 和 Scenario 命令仍只服务固定本地沙箱；`deployment.mjs` 额外服务 Stage 1.5 固定 Kind/K3s profile，但只接受仓库内 manifest、固定 Namespace 和显式 kubeconfig context，不接受任意 manifest 路径或 `kubectl` 参数。

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
| `npm run deployment -- render <profile>` | `deployment.mjs` | 离线渲染固定安装 profile | 否 |
| `npm run deployment -- status <profile> --context <context>` | `deployment.mjs` | 只读核对版本、组件、Secret、workload、PVC、NetworkPolicy 对象与 RBAC | 否 |
| `npm run deployment -- install\|upgrade\|uninstall ... [--preview]` | `deployment.mjs` | 默认预览精确资源集合 | 否 |
| `npm run deployment -- install\|upgrade\|uninstall ... --confirm` | `deployment.mjs` | 对已核对的固定目标执行显式生命周期写操作 | 是 |
| `npm run deployment -- purge ... --preview\|--confirm <identity>` | `deployment.mjs` | 预览或确认 K3s Runtime PVC/PV 数据清理 | `--confirm` 是破坏性操作 |
| `npm run deployment -- cutover <evaluation-profile> --context <context> --preview\|--confirm <confirmation>` | `deployment.mjs` | 用固定一次性 Job 预览或确认保留 PVC 的 Stage 1 数据 cutover | 是；`--confirm` 额外删除旧业务数据 |
| `npm run evaluation -- run <evaluation-profile> [--context <context>]` | `evaluation.mjs` | 逐项验证七个 catalog scenario 与五类真实告警/诊断切片 | 是；会应用并清理 Scenario、重建固定 Pod、轮换 Webhook Secret，并执行受控监控中断探针 |
| `npm run evaluation -- online k3s-online --context <context>` | `evaluation.mjs` | 验证 online profile 的只读 API 与人工入口缺失边界 | 否 |
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

Kind evaluation 保持原有固定入口：

```bash
npm run scenario -- apply image-pull-backoff
npm run scenario -- verify image-pull-backoff
npm run scenario -- cleanup image-pull-backoff
```

固定 K3s evaluation 安装完成后使用显式 context：

```bash
npm run scenario -- apply image-pull-backoff --profile k3s-evaluation --context <context>
npm run scenario -- verify image-pull-backoff --profile k3s-evaluation --context <context>
npm run scenario -- cleanup image-pull-backoff --profile k3s-evaluation --context <context>
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

## `evaluation.mjs`

Task 9 的评估入口不接受任意 URL、Namespace、manifest、PromQL、artifact 路径或
kubectl 参数。Kind 只使用固定 context；K3s 必须显式提供经过 deployment status
门禁的 context。命令会在本机回环建立 Runtime、Console、Prometheus 与
Alertmanager 的固定临时 port-forward，完成后关闭。

```bash
npm run evaluation -- run kind-evaluation
npm run evaluation -- run k3s-evaluation --context <context>
npm run evaluation -- online k3s-online --context <context>
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

命令在任何 live 副作用前要求 Git worktree 干净，并从固定的
`.runtime/release/console-oci` 与 `.runtime/release/runtime-oci` OCI layout 核对 lock 中的
顶层 digest、`linux/arm64`/`linux/amd64` 两个 child 以及每个 image config 的
`org.opencontainers.image.revision`。两份 layout 必须来自同一个 committed source
revision；当前 clean `HEAD` 只能在该 revision 之后修改两个固定 digest-lock 文件，其他
源码或部署漂移都会 fail closed。这个两提交约束避免 digest lock 对自身 commit 产生不可
构建的哈希自引用，同时仍拒绝旧镜像、可变 tag、单架构 image 与未提交源码。

产物固定原子写入 `.runtime/evaluation/<profile>.json`，目录/文件权限分别为
`0700`/`0600`。artifact 只包含 release revision/image digest、布尔检查、状态、计数、
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
```

`render`、`install|upgrade|uninstall` 默认只执行本地
`kubectl kustomize`，不会读取 kubeconfig 或访问集群。所有确认写操作和
`status` 都要求显式 `--context`，先精确核对仓库锁定的 kubectl 与目标
Kubernetes/K3s 版本；Kind 还要求固定 context。K3s 会继续核对 CoreDNS、
Traefik、local-path-provisioner 的固定镜像与当前可用性，以及默认 StorageClass。
确认 install/upgrade 还要求固定单节点 Ready、两个应用 manifest 可解析的
`docker.io/library/<repository>@<locked-digest>` identity 已导入，并通过 kubectl
内部投影只返回固定模型 Secret 与两个 namespaced `alertmanager-webhook` Secret 的
key 是否非空，不把 Secret value 返回给生命周期
脚本。任何检查失败都不会回退到宽权限、宿主机 Runtime 或内存数据。
当前lock是每个逻辑镜像一个只含`linux/arm64`与`linux/amd64`的OCI index。containerd
导入archive后默认只为顶层index保留tag；即使使用`ctr images import --digests`，也
不会自动生成manifest所引用的应用repository@index。因此operator必须在导入同一
archive后，使用`ctr images tag <repository>:<build-tag> <repository>@<locked-index-digest>`
为同一index增加精确reference。预检继续要求完整repository@index，不降级为可变tag。
Kind 静态 hostPath 额外由同一锁定 Runtime image 的受限 init 只调整挂载根
ownership；migration 和 Runtime 本身仍保持非 root。status 按固定 kubectl 的资源
列表命令 `apiVersion: v1, kind: List` producer contract 校验，并忽略 RollingUpdate
已带删除时间的旧 Console Pod。`INCIDENT_INTAKE_MODE` 直接位于
Console 与 Runtime 的 Deployment Pod template；base 为 `manual`，`k3s-online`
overlay 改为 `online` 并触发 rollout。ConfigMap 不重复保存该值，status 会
核对实际容器 env 与 rollout generation，防止 profile 已升级但进程仍使用旧 mode。

Stage 2 Task 2 已让三个 profile 同时渲染 digest 锁定的 Prometheus、Alertmanager
与 kube-state-metrics。operator 固定核对三个独立 ServiceAccount、当前
Pod/ReplicaSet 最小 KSM RBAC 与 allow/deny、resource/metric allowlist、15秒
scrape/evaluation、15天与1600MB TSDB上限、Prometheus保留PVC、配置/rule与catalog、
配置digest触发的rollout、健康probe、ClusterIP Service及两个Namespace的精确
NetworkPolicy对象。Runtime与Alertmanager分别挂载本Namespace中同名Secret的
`token`；两个对象的同值只能由安装流程和真实Webhook验收证明，status不读取明文。

Stage 3 DC-3 为两个 K3s profile 引入 Kustomize Component
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
scrape job，否则渲染失败——不启用 node-metrics 的 profile 按 ADR-0011 豁免三条
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

Stage 1.6 数据 cutover 只接受 `kind-evaluation` 与 `k3s-evaluation`：

```bash
npm run deployment -- cutover k3s-evaluation --context <context> --preview
npm run deployment -- cutover k3s-evaluation --context <context> --confirm <cutover-confirmation>
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

完整安装顺序、Secret 边界和命令见本地 Work 的
`docs/work/stage-1-5-k3s-installable-baseline/installation.md`。真实 image import、
apply、uninstall、purge 与 NetworkPolicy enforcement 都需要对应 live 授权。

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
