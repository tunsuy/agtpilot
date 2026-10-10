# 沙箱控制增强设计(借鉴 OpenShell 关键模式)

- 日期: 2026-10-10
- 状态: 已实施(本文档与代码同 commit)
- 前置阅读: `docs/design/persistent-state-governance.md`(治理六维/五不变量)、`docs/design/personal-ai-landscape-insights.md` §5.7
- 外部参照: NVIDIA OpenShell(github.com/NVIDIA/OpenShell, Apache-2.0, 0.1.x alpha)——只借鉴模式,不引入其任何进程/依赖

## 1. 背景:一次审计发现的真实缺口

对当前隔离现状的审计(2026-10)结论:

1. **唯一的系统级隔离是 E2B**(Firecracker MicroVM,云端,仅 Python 且需用户配 Key)。本地执行路径(run_command / run_code 本地分支 / 文件工具)只有**逻辑围栏**: resolveSafePath 路径围栏、execFile 零 shell、超时与 maxBuffer。
2. **凭据泄漏(已确认)**: `buildChildEnv` 把整个 `session.env` 展开进子进程环境——用户个人空间保存的全部 Key(EXA/TAVILY/FIRECRAWL/E2B/各 Webhook URL)对任意一次模型触发的 `sandbox_run_command` 子进程可见。而所有合法消费方(plugin-search/plugin-notify 等)都在**插件 JS 进程内**读 `session.env`,子进程从不需要这些 Key——纯粹是暴露面。
3. **无出站网络控制**: 本地执行的子进程可以自由访问内网、云元数据端点(169.254.169.254)。
4. **HITL 审批门与插件同进程**: 防的是模型失误,防不了插件被劫持(诚实声明,见 §3)。
5. **README 与事实不符**: 宣称 "Docker / E2B",实际不存在 Docker 后端。

## 2. OpenShell 借鉴矩阵

| OpenShell 设计 | 采纳? | 我们的形态 |
|---|---|---|
| Gateway 托管真实密钥,沙箱内只有占位令牌 | ✅ 采纳(变体) | 密钥留在 web 进程(user-store 密文);工具子进程环境**默认零 session.env Key**;新增 `sandbox_http_request` 由宿主进程按 `credentialRef` 注入真实凭据发请求 |
| 凭据-端点绑定(credential_endpoint_mismatch) | ✅ 采纳 | `DEFAULT_CREDENTIAL_BINDINGS`(EXA→api.exa.ai 等 8 组)+ 用户自定义绑定;凭据只允许发往绑定 host,否则拒绝并记 `credential_endpoint_mismatch` |
| 拒绝日志 → 权限提案 → 人工审核 → 热更新 | ✅ 采纳 | `sandbox_deny` 事件 → user-store `policyProposals` → `/api/sandbox-proposals` 审核 → approve 即改配置并**热更新 in-flight 任务**(活引用) |
| best_effort / hard_requirement 两种围栏模式 | ✅ 采纳 | `fence` 配置同名同义:bwrap 不可用时 best_effort 降级继续(显式标注)、hard_requirement 直接拒绝执行 |
| Landlock/seccomp/netns 内核围栏 | ⚠️ 部分(变体) | 不常驻 daemon、不写内核代码:检测宿主机 `bwrap`(bubblewrap)存在则用它包裹子进程(只读根 + 可写 workspace + tmpfs /tmp + --die-with-parent [+ --unshare-net]);默认 `off` 保持向后兼容 |
| 私有网段/元数据端点拦截 | ✅ 采纳 | `net-guard`: 我们自己的 HTTP 出站工具统一过 `guardUrlHost`(DNS 解析后校验,非仅字符串匹配) |
| 策略 lint(私网 host/通配符/端点不匹配预警) | ✅ 采纳(简化) | `lintConnectorValue`: 保存连接器时非阻断警告 |
| 每二进制粒度的出站策略(curl 可访问 X,python 不行) | ❌ 不借鉴 | 需要溯源 TCP→进程的内核能力,超出本项目体量 |
| SMT Policy Prover 形式化验证 | ❌ 不借鉴 | 过度工程 |
| 常驻 Gateway/Supervisor 双进程 | ❌ 不借鉴 | 引入独立进程 = 部署复杂度陡增(负责人已确认不要);web 进程兼任控制面 |
| K3s/K8s 编排 | ❌ 不借鉴 | 同上 |

## 3. 威胁模型(诚实版)

本次增强**能防**:
- 模型被提示词注入后诱导子进程 `env | grep KEY` 外泄凭据(子进程环境默认无 Key);
- 子进程/HTTP 工具访问内网、云元数据端点;
- 凭据被发往攻击者控制的陌生端点(端点绑定);
- 围栏静默失效(降级必显式标注 + 事件,延续 E2B 降级诚实模式)。

本次增强**不能防**(维持既有事实,不夸大):
- 插件 JS 进程本身被劫持——审批门、围栏决策与插件同进程,防内鬼需要真进程隔离(= 用 E2B 路径或未来独立 supervisor);
- DNS rebinding TOCTOU: `guardUrlHost` 解析后校验,但 fetch 再次解析可能拿到不同 IP(缓解: redirect 逐跳重校验;根治需自建 socket 层 pin IP,列为后续);
- 子进程原始 TLS 隧道内的内容(无 MITM 代理);
- 写在项目文件/提示词里的明文密钥(凭据托管只覆盖 user-store 管理的 Key)。

## 4. 设计

### 4.1 core 新模块(纯函数,vitest 可测)

**`packages/core/src/net-guard.ts`**
- `isPrivateOrReservedIp(ip)`: 覆盖 0/8、10/8、127/8、169.254/16(含元数据端点)、100.64/10、172.16/12、192.168/16、192.0.2/24 等 TEST-NET、224/4、240/4、::1、fc00::/7、fe80::/10、IPv4-mapped IPv6。
- `guardUrlHost(url, lookup?)`: 仅允许 http/https;hostname 为字面量 IP 直接判;域名经可注入 DNS lookup(默认 `node:dns/promises`)解析后**逐个地址**判私网;`localhost` 直接拒。返回 `{ok, reason?}`。

**`packages/core/src/sandbox-fence.ts`**
- `SandboxSessionPolicy { exposeEnv?, credentialBindings?, fence?, net? }` —— 经 `ToolSession.sandbox` 下发,**活引用**(热更新点)。
- `DEFAULT_CREDENTIAL_BINDINGS`: 8 个既有连接器 envVar → 官方 API host。
- `buildChildEnv(sessionEnv, policy, hostEnv?)`: base 白名单(CI/PATH/HOME/LANG/LC_ALL/TZ/TMPDIR)+ **仅** `policy.exposeEnv ∩ sessionEnv` 的键。默认(sessionEnv 全量不进子进程)。
- `resolveCredentialRequest({credentialRef, hostname}, sessionEnv, bindings)`: `credential_not_found` / `credential_endpoint_mismatch` / ok 三态,凭据值只在 ok 时返回。
- `decideFence(mode, bwrapAvailable)`: off→不包;best_effort+bwrap→包;best_effort 无 bwrap→降级不包(degraded=true);hard_requirement 无 bwrap→拒绝执行(blocked=true)。
- `buildBwrapArgs({workspaceRoot, net})`: `--ro-bind-try / / --dev /dev --proc /proc --tmpfs /tmp --die-with-parent [--unshare-net] --bind <ws> <ws>`。

### 4.2 契约扩展

- `ToolSession.sandbox?: SandboxSessionPolicy`(contracts.ts);
- `TaskOptions.taskSandbox?: SandboxSessionPolicy`(task-types.ts),orchestrator 原样透传进 session——与 taskEnv 同一注入点、同样活引用语义。

### 4.3 plugin-sandbox

- `buildChildEnv` 本地实现删除,改用 core 版(默认零 Key)——**这是修复泄漏的关键一行**;
- run_command / run_code 本地分支按 `decideFence` 决定是否 `execFile('bwrap', [...args, '--', ...])` 包裹;bwrap 在 apply() 时探测一次并缓存;降级/拒绝在结果与 `thought` 事件里显式标注(延续 E2B 降级诚实模式);
- 新工具 **`sandbox_http_request`**(dangerLevel high → 过 HITL 审批门): url/method/headers/body/credentialRef/authStyle(bearer|header|query)/authHeaderName/authQueryParam/timeoutMs;执行序: guardUrlHost → 凭据解析+端点绑定校验 → 手动跟随重定向(≤3 跳,逐跳重新 guard) → fetch。任何一步拒绝都发 `sandbox_deny` 结构化事件(含 reason/url/credentialRef/taskId/userId)并返回失败;
- `AgentEvent.type` 联合新增 `'sandbox_deny'`(protocol);
- 全部工具 description 标注真实隔离层级(local 逻辑围栏 / bwrap 内核围栏 / e2b MicroVM)。

### 4.4 web 层(apps/web)

- **user-store**: `UserScopedData.sandbox?: {exposeAllowlist?, credentialBindings?, fence?}`、`policyProposals?: PolicyProposalRecord[]`;`getSandboxConfig/saveSandboxConfig`、`addPolicyProposal/resolvePolicyProposal`(approve 时把绑定/白名单合并进 sandbox 配置)、`appendSandboxAudit/readSandboxAudit`(jsonl,镜像 memory audit)、`lintConnectorValue`(私网 host/通配符/端点不匹配→警告数组,saveUserConnector 返回之,非阻断)。
- **governance-bus**: 新增 `PermissionProposedEvent` / `PermissionResolvedEvent` 及 on/emit(globalThis 单例,同既有模式)。
- **agent-backend**: 任务启动时构建 `taskSandbox`(exposeEnv = 用户 exposeAllowlist ∩ 实际注入的 taskEnv 键;bindings = DEFAULT ∪ 用户自定义;fence = 用户配置 → `AGTPILOT_SANDBOX_FENCE` → 'off'),存入 taskRuntimes(活引用)并传 runTask;`handleEvent` 新增 `sandbox_deny` case → 落审计 + 按 reason 生成 pending 提案(credential_endpoint_mismatch→credential-binding 提案;其余记录) + emit PermissionProposed;订阅 PermissionResolved(approved)→ 热更新该用户在跑任务的 taskSandbox 活引用(绑定/白名单即时生效,不重启任务——不违反铁律 7,这不是重启 loop)。
- **API**: `/api/sandbox-proposals`(auth() 会话门): GET 列出提案+最近拒绝审计;POST {proposalId, action} → resolvePolicyProposal + emit PermissionResolved。

### 4.5 文档真实性

- README: "Docker / E2B" → 如实改为 "本地围栏(路径/环境白名单/可选 bwrap)+ E2B 云端 MicroVM(可选)";删除 "Docker (optional...)" 依赖项。

## 5. 配置参考

| 配置 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `sandbox.exposeAllowlist` | user-store(用户级) | `[]` | 允许进子进程环境的 session.env 键;用户显式 opt-in |
| `sandbox.credentialBindings` | user-store(用户级) | DEFAULT 8 组 | envVar → 允许 host 列表;http_request 凭据注入前校验 |
| `sandbox.fence` | user-store / `AGTPILOT_SANDBOX_FENCE` | `off` | off / best_effort / hard_requirement(bwrap) |
| `sandbox.net` | taskSandbox | `allow` | deny 时 bwrap 加 --unshare-net(需 fence 生效) |

## 6. 测试计划(先写测试,确认真实失败,再实现)

- `packages/core/src/net-guard.test.ts`: 私网/保留段矩阵、字面量 IP、注入 lookup 的域名解析拒绝、scheme 限制;
- `packages/core/src/sandbox-fence.test.ts`: 子进程环境默认零 Key、exposeEnv 交集、凭据三态、fence 决策矩阵、bwrap 参数;
- `apps/web/src/lib/__tests__/sandbox-control.spec.ts`(USER_DATA_DIR tmpdir 隔离模式): exposeAllowlist 门控、提案生命周期(pending→approve 合并配置 / reject 不动)、lint 警告、审计 jsonl 往返、bus 事件。

## 7. 非目标

- 不引入任何常驻进程/容器运行时依赖(bwrap 为可选探测);
- 不做每二进制粒度策略、SMT 验证、MITM 代理;
- 不承诺 in-flight loop 重启(铁律 7);热更新仅指策略活引用原地生效;
- plugin-search 各 provider 端点(硬编码、进程内消费)与 plugin-browser 导航的出站治理不在本次范围(浏览器导航治理列为后续项)。
