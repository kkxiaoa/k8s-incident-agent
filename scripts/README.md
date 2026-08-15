# 项目脚本

本目录存放 K8s Incident Agent 的本地开发与验收脚本。它们只服务固定的本地 Kind 沙箱，不是 Runtime API，也不接受任意集群、Namespace、manifest 路径或 `kubectl` 参数。

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
| `npm run scenario -- list` | `scenario.mjs` | 校验并列出版本化场景的公开信息 | 否 |
| `npm run scenario -- apply <scenario-id>` | `scenario.mjs` | 安装指定 catalog fixture | 是 |
| `npm run scenario -- verify <scenario-id>` | `scenario.mjs` | 等待并验证场景的确定性证据条件 | 否 |
| `npm run scenario -- cleanup <scenario-id>` | `scenario.mjs` | 删除该场景 manifest 声明的对象 | 是 |

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

```bash
npm run scenario -- apply image-pull-backoff
npm run scenario -- verify image-pull-backoff
npm run scenario -- cleanup image-pull-backoff
```

- `apply` 只应用 catalog 中已经校验的 manifest；
- `verify` 使用 Deployment UID → ReplicaSet owner UID → Pod owner UID 证明对象关联，再检查 `ErrImagePull` / `ImagePullBackOff` 和关联 Warning Event；
- `cleanup` 只删除该场景 manifest 声明的对象，不删除 Namespace 或 Kind 集群；
- 三个命令都会先验证固定 Kind 集群基线，不接受额外的 `kubectl` 参数。

`verify` 使用 120 秒 absolute deadline，`kubectl` 查询和轮询等待都计入该预算；单次查询最多 30 秒，并在剩余预算不足时自动收窄。成功结果只包含安全的对象 identity 和 reason，不包含原始 Event note；超时失败只输出最后一个静态 unmet-condition reason。

## 测试与静态检查

默认测试入口会运行本目录全部 `*.test.mjs`：

```bash
npm test
npm run lint
```

排查单个脚本时可以直接运行对应测试文件：

```bash
node --test scripts/doctor.test.mjs
node --test scripts/kind-cluster.test.mjs
node --test scripts/scenario.test.mjs
```

测试使用临时目录和受控命令替身；默认 `npm test` 不创建、修改或删除真实 Kind 集群。

## 安全约束

- 所有外部命令都通过参数数组执行，不启用 shell；
- 集群、context 和 Namespace 身份固定，脚本不会连接任意用户输入的目标；
- 场景 ID 必须来自已经校验的 catalog，不能作为文件路径或额外命令参数；
- `up`、`bootstrap-access`、`down`、`scenario apply` 和 `scenario cleanup` 有明确副作用，运行前应确认目标状态；
- 脚本不会自动执行完整 live 验收序列，也不会自行决定最终保留 fixture 或 cleanup；
- kubeconfig、token、CA data 和原始敏感响应不得写入日志、测试 fixture 或版本库。

## 退出状态

- 成功时退出码为 `0`；
- 参数错误、版本漂移、基线不匹配、权限不足、请求超时或验证条件未满足时退出码为非零；
- `doctor` 使用逐项 `PASS` / `FAIL` 输出；
- `scenario` 失败输出格式为 `FAIL <code> <message>`，不会附带原始 Kubernetes 响应。
