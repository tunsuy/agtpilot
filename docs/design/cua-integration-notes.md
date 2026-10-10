# trycua/cua 调研与集成可行性笔记

- 日期: 2026-10-10
- 状态: **调研笔记 / 提案**(未动任何代码;是否排期 P0 待负责人决策)
- 前置阅读: `ARCHITECTURE.md`(分层铁律 / 反模式清单 / 新增插件检查单)、`docs/design/sandbox-control-hardening.md`(沙箱现状与诚实声明)、`docs/design/eval-hillclimb-framework.md`(评测提案)
- 外部参照: trycua/cua(github.com/trycua/cua,约 29.2k stars)。调研基于 2026-10-10 浅克隆快照(HEAD `7cc4bd0`,本地副本 `/tmp/cua-study/cua`,临时目录可能已清理)。**未实际运行其代码**,协议与版本细节以源码为准;该项目刚完成大重构(旧 agent/computer/computer-server 全线弃用),API 可能仍在演进,集成时务必锁版本。

## 1. cua 是什么(一句话 + 组件图)

"给 Agent 一台可操作的电脑"的开源基础设施:统一驱动层 + 沙箱/VM 供给 + 评测基准。它不卷模型,只把"手"标准化。

| 组件 | 语言/形态 | 许可 | 角色 |
|---|---|---|---|
| **cua-driver** | Rust 核心 + UniFFI 生成 Python/TS 绑定;单二进制 | MIT | 操控 macOS/Windows/Linux 桌面与 Chromium(CDP);对外是 stdio MCP server / UDS daemon / 进程内 SDK 三种形态 |
| **@trycua/cua**(TS SDK)/ `cua`(PyPI) | 生成绑定 | MIT | 统一创建/连接沙箱:local(Docker/gVisor/QEMU)、cloud(Fleet)、BYOC(AWS/GCP/Modal)、direct(任意自托管 spacesd) |
| **cua-spacesd** | Rust 守护进程,单端口 3211 | **FSL-1.1-MIT** | 沙箱内代理:gRPC(System/Process/Filesystem/Computer/…)+ `/mcp` + `/files` + 媒体流;输入全部委托给进程内链接的 cua-driver |
| **cua-relay** | 同上 | **FSL-1.1-MIT** | NAT 穿透中继(yamux over 出站 WS),可自部署 |
| **Lume / lumier** | Swift | MIT | Apple Silicon 本地 macOS/Linux VM(Virtualization.framework);仅 Apple 平台 |
| **fleet(libs/fleet)** | Go + K8s + React | 镜像 MIT(定位为 Cua 托管云) | 云控制面:pool → claim(租约 TTL)→ service 路由;warm pool 自动扩缩 |
| **cua-bench** | Python 3.12,CLI 名 `cb` | MIT | 任务级评测:运行矩阵(local/cloud × container/vm × gvisor/runc/qemu/lume/kubevirt)、轨迹导出、训练数据格式转换 |
| **libs/images** | OCI 镜像 | 见各镜像 | 规范沙箱镜像:`ghcr.io/trycua/linux:24.04`(XFCE+Xvfb+AT-SPI+spacesd)、`windows:2022`、`macos:26`(Lume)、xfce/kasm 轻量桌面 |

## 2. 决定接法的关键架构事实

1. **driver 的 agent 边界是 MCP over stdio(JSON-RPC 2.0)**,`{"command":"cua-driver","args":["mcp"]}` 即接;协议支持现代修订 `2026-07-28`(带 `_meta`、`server/discover`、skills 扩展)并兼容 legacy `2025-06-18`。任何 MCP client 都能零依赖接入。
2. **工具面**:typed 契约 29 个(`libs/cua-driver/contract/manifest.json`,contract_version 0.8.0,CI 有漂移门禁),MCP 注册表更大(含 `browser_*`、`run_actions`、`get_accessibility_tree`、录制、后台投递输入——不抢焦点)。
3. **平台支持**:macOS(AX/Quartz/ScreenCaptureKit,最完整)、Windows(UIA/Win32)、Linux X11(XTest/AT-SPI)、Wayland(分级支持,需 env 开关 + compositor helper)。
4. **权限模型**(可直接抄的设计):`CUA_DRIVER_PERMISSION_MODE` 三档(standard/bounded/unrestricted)+ `CUA_DRIVER_POLICY_FILE` 支持 YAML/Rego deny-by-default 策略。
5. **daemon/远程形态**:`cua-driver serve` 是本机 UDS/命名管道 daemon(行分隔 JSON);**没有开箱即用的跨机 TCP server**,跨机要走 spacesd 的 `/mcp`(bearer token)或 Fleet envelope 通道。
6. **TS SDK 现状**:`@trycua/cua`(0.4.x)API 面为 `embedded()`(进程内 Rust 运行时)/ `connect()`(连 daemon)→ `sandboxes().create({on: "local"|"cloud"|"aws"|"gcp"|"modal"|"direct:<host:3211>"})` → `sb.service("mcp").request(...)` / `publicUrl()`;`cua.spacesd(url, token)` 直连任意 spacesd 得到 `SpacesdClient`(typed 方法 + `callJson` 覆盖全部 `cua.env.v1` gRPC RPC)。typed Driver 集成目前 **Python 侧最完整**,TS 侧(`@trycua/cua-driver/fleet`)是候选特性。
7. **自托管最小路径**(普通 Linux 服务器,无 Fleet、无 cua.ai 账号):`docker run -e CUA_ENV_TOKEN -p 3211 ghcr.io/trycua/linux:24.04` + SDK `spaces.add(url, token)` 直连。

## 3. 集成路径:P0 / P1 / P2

### P0:MCP 零代码挂载(验证用)

- **做法**:不改任何代码,把 cua-driver 当普通外部 MCP server,走 plugin-mcp 现成通道(`mcp_connect_stdio` 或 mount 时预配置 `MCPServerConfig`),工具以 `mcp_xxx_*` 名挂进 agent loop。
- **得到**:跨 OS 原生桌面操控 + CDP 浏览器 + 无障碍树 + 后台输入 + 录制,约 30 个工具;正好补 plugin-desktop 的空白(现状:仅 macOS、5 个工具、无鼠标/键盘能力)。
- **局限**(MCP 通用通道的天花板,对应反模式 #10 的教训——工具暴露语义归应用层):
  1. 所有工具 `dangerLevel` 一律 `medium` → 高危桌面动作**不会触发 HITL 审批门**;
  2. 无 `compensation` 补偿声明,回滚语义丢失;
  3. 参数/结果是 MCP JSON 文本,截图等无法接 `viewport_update` 事件流给 Web UI;
  4. 与 `ToolSession` 不联动:taskId/userId 分域、env 白名单、sandbox 策略都传不进去。
- **定位**:借道验证"桌面操控对真实任务有没有价值",沉没成本≈0。

### P1:新建 `packages/plugin-computer`(正式集成,推荐路径)

- **做法**:依赖 `@trycua/cua-driver` TS SDK(进程内 typed API,`CuaDriver.create()` 无需 daemon),按 `ARCHITECTURE.md`「新增插件检查单」注册 `computer_*` 前缀 `ToolDefinition` + `registerToolRoute`;app-kit `mount()` 加一行。**内核零改动**。
- **得到**:逐工具标注 `dangerLevel`(high 自动进 orchestrator 审批门/5min 超时拒绝)、声明 `compensation`、截图接 `viewport_update`、`execute(args, session)` 拿到完整 `ToolSession`(userId 分域、env、sandbox 策略联动)、熔断/循环检测/事件广播全部免费复用。
- **量级参照**:plugin-browser 约 447 行;本插件预计同量级。
- **前置决策**:权限模式映射——把 cua 的 permission mode/policy file 与我们的 `SandboxSessionPolicy` + HITL 审批对齐(建议:插件侧固定 `bounded` + 我们的审批门做二次收口,不放开 `unrestricted`)。

### P2:沙箱桌面后端(给 agent"一台隔离的机器")

- **做法**:`@trycua/cua` SDK 以 direct 模式连自托管 spacesd 容器(linux:24.04 镜像),作为 plugin-sandbox 之外的**远程隔离桌面后端**(定位同 E2B 分支:E2B 只给 Python 代码执行,cua 给完整桌面)。
- **技术债前置**:plugin-sandbox 目前**没有 provider/driver 抽象**(三后端是 7 个工具 execute 内的 inline 分支),接新后端前应先抽 provider 接口——这本身是该还的债,与是否接 cua 无关。
- **合规约束**:spacesd/relay 为 FSL-1.1-MIT,**内部自托管自由**;若 agtpilot 将来把"托管沙箱桌面"作为对外商业服务,落入 Competing Use,需商业许可(licensing@trycua.com)或等版本发布 2 年自动转 MIT,或改走 MIT 的 `cua-vmm` 容器路径绕开 spacesd。

### 对比速查

| 维度 | P0(MCP 挂载) | P1(plugin-computer) | P2(spacesd 后端) |
|---|---|---|---|
| 代码量 | 0(一条配置) | ~一个插件包 | 插件 + sandbox provider 抽象 |
| HITL 审批 | ✗(一律 medium) | ✓ 逐工具 | ✓ |
| compensation/事件流 | ✗ | ✓ | ✓ |
| ToolSession 联动 | ✗ | ✓ | ✓ |
| 操控目标 | 宿主机桌面 | 宿主机桌面 | **隔离沙箱内桌面** |
| 何时做 | 立即 | P0 验证有价值后 | 需要"敢让 agent 放开了点"的场景时 |

## 4. 借鉴点(不集成也该抄的设计)

### 4.1 → `eval-hillclimb-framework.md`(我们的评测提案,现状零代码)

cua-bench 四件事,建议吸收进提案 v2:

1. **任务=目录+四段式回调**(load/setup/solve/evaluate),内置 **oracle 参考解**:先跑参考解拿 reward=1.0 证明任务本身可用,再评 agent——我们的 `cases.jsonl` 只有 checks,没有"任务自校验"环节,值得加;
2. **产物不发明私有格式**:result.json 对齐 Harbor trial 字段、轨迹用 ATIF-v1.8、`pass_at_k` 用无偏估计、导出器直出 aguvis/gui-r1 训练格式——对照我们提案里的自定义 checks 结构,至少在轨迹导出上考虑兼容 ATIF;
3. **数据集 git commit pin + 本地缓存 + 可换源 env**——与我们 `split.json` 种子锁定同思路,可统一;
4. **运行溯源写进结果**:backend 名(`local-gvisor`)+ `image_digest@sha256` + 分阶段计时 + `--dry-run`——我们的 runner 应记录 runtime 版本/模型快照到同等粒度。

### 4.2 → 工程实践(core / 插件协议)

1. **契约 manifest + fixtures + CI 漂移门禁**(`libs/cua-driver/contract/`):工具契约版本化(contract_version 0.8.0),CI `--check` 拒绝 manifest 与实现漂移。可用于我们 `registerTool` 的全局注册表——工具 schema 变更从此有据可查、CI 可拦。
2. **MCP envelope carrier 的能力协商**(`docs/mcp-envelope-carrier.md`):在通用 MCP 传输上叠加 typed RPC 时,先验证 `capabilities.experimental["ai.cua.driver.envelopes"].version==1` 再开通道,**失败即拒、绝不静默降级**——与我们 E2B 降级显式标注(`mode:'local-fallback'`,反模式 #14)同一哲学,可推广为插件协议的通用规则。

## 5. 许可与雷区(集成前必读)

| 项 | 边界 | 我们的动作 |
|---|---|---|
| MIT 覆盖 | cua-driver、@trycua/cua 及各语言 SDK、cua CLI、Lume、cua-bench(-rl/-s1)、kasm、`cua.env.v1` proto 契约、libs/typescript/* | 可自由集成/二次分发 |
| **FSL-1.1-MIT** | **cua-spacesd、cua-relay**、Spaces 四个 app、media-protocol/transport 全链、keyvault/teleport 等 | 内部自托管 OK;对外提供托管桌面服务 = Competing Use,需商业许可;每版本 2 年后自动转 MIT |
| **AGPL 雷区** | driver 的可选 **perception 扩展**(OmniParser 图标检测,AGPL-3.0-only)、`libs/python/som`(AGPL,已弃用) | **不安装、不链接、不分发**;不装不影响 driver 主体的 MIT |
| 弃用包 | `cuabot`(**有已知安全问题,官方要求立即停用**)、`cua-computer`、`cua-computer-server`、`cua-agent`、`cua-som`;TS 的 `@trycua/agent`/`@trycua/playground` 随服务端弃用 | 集成目标只认三样:**cua-driver / @trycua/cua / spacesd(direct 模式)** |
| 商标 | `TRADEMARKS.md` 对 "Cua" 品牌另有约束 | 我们插件命名避免 `cua-*` 前缀,用 `plugin-computer` |
| 许可分界自律 | 官方架构约定:MIT 侧只定义扩展点,FSL 侧实现,MIT 从不链接 FSL | P2 若走商用发布路径,沿用同一分界(经网络协议对接 spacesd,不静态链接) |

## 6. 建议决策与下一步

1. **P0 立即可做**(不排期也行):在一台 Linux 机器装 cua-driver 二进制(或用 xfce/linux:24.04 容器),经 plugin-mcp stdio 挂载,跑 3~5 个真实桌面任务(跨 App 操作、表单、文件整理)看成功率与延迟。**验收标准**:至少一个"浏览器自动化做不到"的任务被稳定完成。
2. **P0 通过 → P1 排期**:按 §3 P1 方案立项 `plugin-computer`,先落权限映射设计再写代码。
3. **P0 不通过 → 全部止损**,仅吸收 §4 借鉴点进 eval 提案与工程实践。
4. **P2 与 plugin-sandbox provider 抽象解耦推进**:抽象接口先行(独立价值),cua 后端在"需要隔离桌面"需求出现时再接。

## 7. 关键源码索引(相对 cua 仓根,快照 `7cc4bd0`)

| 主题 | 路径 |
|---|---|
| driver Rust 核心 / MCP wire / daemon | `libs/cua-driver/rust/crates/cua-driver-core/src/{mcp_wire.rs,cdp.rs}`、`crates/cua-driver/src/{serve.rs,mcp_http.rs}` |
| driver 工具契约 manifest | `libs/cua-driver/contract/manifest.json`(+ fixtures 与 `--check` 门禁) |
| driver 协议/skills/envelope 文档 | `libs/cua-driver/docs/{mcp-protocol-and-skills.md,mcp-envelope-carrier.md}`、`rust/Skills/cua-driver/SKILL.md` |
| TS SDK 入口 / spacesd client | `libs/cua/typescript/src/{index.ts,mcp.ts,native/cua_sdk.ts}` |
| spacesd / proto 契约 | `libs/cua-spacesd/`、`libs/cua/proto/cua/env/v1/*.proto` |
| bench | `libs/cua-bench/`(CLI `cb`;`cua_bench/results.py`、`example_tasks/`) |
| 许可 | `LICENSING.md`、`COMMERCIAL.md`、`LICENSE.md`、`THIRD_PARTY_NOTICES.md` |
| 弃用迁移 | README「Deprecated packages」、`docs/content/docs/.../migrate-from-deprecated-packages.mdx` |
