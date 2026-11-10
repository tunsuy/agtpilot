# Agent 沙箱化设计:粒度未决,两案并列

- 日期: 2026-11-09
- 状态: 设计已对齐,粒度待定(方案 A 用户级 / 方案 B 会话级,见 §2),未实施
- 前置阅读: `docs/design/sandbox-control-hardening.md`(现有隔离现状与老债)、`docs/design/local-runner-bridge.md`(通道模式来源)、`docs/design/mid-run-user-messages.md`、`docs/design/background-child-missions.md`
- 外部参照: `~/work/ai/sandbox/agent-sandbox-paradigms-analysis.md` §3.2(同箱形态)、§4.5(个人通用助理)、§5(安全设计要点);Devin / Manus / Cursor Cloud Agents / Cowork 云端会话

## 1. 背景与问题

agtpilot 当前是「执行面沙箱化」形态(分析文档 3.1):harness(orchestrator/审批/审计)在可信 web 进程,执行走本地逻辑围栏 + 可选 E2B。两条老债:

1. `sandbox-control-hardening.md` §3 第一条诚实声明:审批门、围栏决策与插件同进程,**防不了插件 JS 进程本身被劫持**——根治需要真进程隔离;
2. 执行环境无状态、无浏览器登录态持久化,「个人通用助理」形态(文件系统做长期记忆、浏览器与 shell 共存)落不了地。

已定形不随粒度变化的部分:**agent in sandbox 同箱形态**(决策循环 + 执行同进 microVM,控制面留平台侧),以及 D2–D6 的全部决策(同箱切分、CubeSandbox 首选、runner 设备模型复用、凭据两步走、休眠保守路线)。用户之间无论 A/B 都是 microVM 硬隔离。

待定的是沙箱生命周期挂在**用户**还是**会话**(channel conversation)上——这决定记忆连续性、成本曲线、跨任务污染面与 cron 落位四个维度,两案差异在 §2 展开。

## 2. 两案并列

### 方案 A:每用户一箱(用户生命周期)

沙箱 = 该用户的常驻云端个人电脑。agtpilot runtime 常驻箱内,跨 mission 连续(workspace + 浏览器登录态 = 用户记忆),控制面留在平台侧。

- **生命周期**:建/醒/睡/销绑定 userId;
- **记忆**:跨任务连续,workspace 即长期记忆,登录一次用到底;
- **cron**:天然落位——cron 是用户级语义,挂用户级箱,到点 ensureAwake(userId) 即可;
- **成本**:用户数 × 箱均内存线性,休眠托底(只占持久层磁盘);长尾在「注册不活跃用户」,容量按活跃用户规划;
- **污染面**:跨任务污染是**结构**问题(§4.2),需要白名单回注 + 卫生重置整套治理机制;
- **通道**:D4 设备模型整套复用,每用户 = 一台「云端 runner 设备」;
- **案例**:dots / Muse 的「账号拥有云电脑」。

### 方案 B:每会话一箱(channel conversation 级)

沙箱 = 一段对话的工作台,新会话新箱。产品语义上「会话」不是 mission:`channel-store.ts` 的 `ChannelConversation` 有「续聊映射 + 『新会话』指令清除映射」语义,一个会话可跨多个 mission。箱挂会话级意味着会话内跨 mission 连续(续聊上下文 + workspace),会话间干净。

- **生命周期**:建/醒/睡/销绑定 (channel, conversationId);
- **记忆**:会话内连续,会话间隔离;登录态复用需**会话间迁移机制**(从旧箱抽 profile 归档到平台侧,新箱起时注入)——A 案无此机制,这是 B 案的额外工程;
- **cron**:**结构性错配**——cron 是用户级语义,目标箱已随会话生灭,到点无箱可投。候选对策见 §4.6,选型待拍板;
- **成本**:成本峰谷与会话活跃度同步,无常驻长尾;但会话高频生灭使快照/注回/唤醒机制被高频触发;
- **污染面**:会话边界即箱边界,**天然规避** §4.2(但若配用户级 profile 归档,归档带雷会随注入复活,§5);
- **通道**:D4 复用但每会话一台设备,注册表按会话记;
- **案例**:Manus「每次会话一个全新环境」、Cowork 云端会话「每次会话一个临时隔离沙箱」。

### 待定维度对照

| 维度 | 方案 A 用户级 | 方案 B 会话级 |
|---|---|---|
| 沙箱粒度 | userId | (channel, conversationId) |
| 生命周期 | 常驻(睡/醒循环) | 随会话生灭 |
| 记忆连续性 | 跨任务连续(设计目标) | 会话内连续,会话间迁移 |
| 跨任务污染 | 结构问题,需治理机制 | 天然规避(箱边界=会话边界) |
| cron 落位 | 天然落位 | 结构性错配(§4.6) |
| 成本曲线 | 活跃用户 × 常驻箱,休眠托底 | 随会话活跃度,无常驻长尾 |
| 唤醒频率 | 低(一次唤醒跑多任务) | 高(每会话一次) |
| 登录态复用 | 常驻 profile | 需会话间迁移机制 |
| 产品定位 | 个人助理(跨任务记忆) | 会话工作台(会话隔离优先) |
| 案例参照 | dots / Muse | Manus / Cowork 云端会话 |
| 通道复用度 | D4 整套复用 | D4 复用,注册表按会话记 |

### 先验分差(供拍板参考,不预设结论)

- A 案与 agtpilot 既有产品形态(个人助理跨任务记忆 + cron + 登录态复用)同构;B 案需补 cron 错配对策 + 登录态迁移两块工程;
- 反向论点:A 的跨任务污染是**结构**问题(只能缓解),B 的 cron 错配与登录态迁移是**工程**问题(可做掉)。若把「隔离洁癖」权重放最高,B 案更干净;
- **折中路线备忘**(不入 v1):「B 的箱边界 + A 的记忆」——箱挂会话,持久层按用户归档,会话箱起时注回用户级归档。拿 B 的隔离 + A 的记忆,代价:每次会话唤醒都要全量注回(分钟级),且注回本身是污染复活通道(白名单治理不能省)。

### 拍板路径

粒度决策待定。建议决策输入:①产品定位(要跨任务记忆选 A,要会话隔离选 B);②cron 的产品权重(核心场景则 B 的 §4.6 必须先答);③两案各自补课的工程量接受度(A:污染治理,B:迁移机制)。M1/M2 的通用层粒度无关(§6),拍板可推迟到 M2 末,不阻塞开工。

## 3. 目标架构(两案共同骨架)

### 3.1 生命周期

方案 A(用户级):
```
用户首次使用 ──→ 建箱(模板 + 持久层注回 + Key create-env 注入)
运行中(awake) ←─ ensureAwake(userId) ←─ 唤醒源: 用户消息 / cron 到点 / 审批决定
空闲超时(默认 30min 无活动 且 无在跑 mission) ──→ 休眠(rsync 持久目录外置 → 销箱 → sleeping)
用户注销/删除数据 ──→ 销箱 + 销毁持久层
```

方案 B(会话级):
```
会话首条消息 ──→ 建箱(模板 + [登录态迁移] + Key 注入)
运行中(awake) ←─ ensureAwake(conv) ←─ 唤醒源: 该会话用户消息 / 审批决定 / cron(按 §4.6 选型)
会话空闲超时 ──→ 休眠(同 A)或过期直接销毁
「新会话」指令 / 会话删除 ──→ 销箱;新箱起时做登录态迁移
```

### 3.2 状态归属

| 箱内(随箱/持久层生存) | 箱外(平台可信态,web 进程 + 存储) |
|---|---|
| workspace 文件系统(记忆 + checkpoint) | user-store / secret-box(真实密钥库,密文) |
| `.browser-profile/`(浏览器登录态) | 沙箱注册表(A: userId→box;B: conv→box) |
| agtpilot box-runtime(loop + supervisor) | 审批卡、Web Push、计费、平台审计 |
| mission 过程产物、audit 副本 | 持久层存储(A: 用户级归档;B: 会话级归档 + 用户级登录态归档) |

### 3.3 组件切分

| 现有组件 | 去向 |
|---|---|
| core / orchestrator / app-kit(`createAgentRuntime()`) | 进箱:新 `apps/box-runtime` headless 包装(去 web 依赖) |
| plugin-model / browser / search / git / artifact / subagent / … | 进箱,照旧 |
| plugin-sandbox | 进箱但**角色变化**:箱内 shell 直执行,`resolveSafePath` 路径围栏保留,bwrap / E2B 分支退役(已在 VM 内,无意义) |
| plugin-cron | 触发面留箱外(到点 → ensureAwake);箱内不再常驻计时 |
| apps/web(agent-backend / 审批 / push / user-store) | 留箱外,新增 sandbox-dispatcher |
| apps/runner 的 client / heartbeat / event-queue / redaction / audit | **移植进 box-runtime**:上行 poster + 长轮询下行 + outbox(TTL/容量上限照搬) |

### 3.4 通道

- **建箱/销箱/休眠**:dispatcher → CubeSandbox REST(`POST :3000/sandboxes` X-Api-Key;`DELETE` 销;`http://49999-<id>.cube.app/execute` 箱内操作)。模板镜像走 TCR(cube-sandbox-cn),节点拉不到 Docker Hub。
- **任务/事件**:复用 `/api/runner/*` 路由族,新增 deviceKind `sandbox`(配对由 dispatcher 代办,不经 pair-code);箱内持 deviceSecret 派生 token。上行 `POST .../events`(eventId 幂等 + redaction 脱敏),下行 `GET` 长轮询拿审批决定与 mid-run 用户消息(steering 注入通道同构)。
- **产物回流**:mission DONE 后 dispatcher 经 files API 抽产物到平台侧再落用户可见处(箱可睡,产物不能只在箱里)。

## 4. 沙箱化特有问题与对策

1. **状态持久性是成败点**(D6):v1 rsync 保守路线,持久层做成可插拔接口(`PersistLayer: snapshot(dirs) / restore(dirs)`),CubeSandbox 原生 pause 验证后无缝升级(秒级唤醒)。
2. **跨任务污染**(A 案结构问题 / B 案天然规避):mission A 克隆的恶意仓库往 `~/.bashrc`、git hooks、`node_modules` 埋雷,mission B 中招。A 案对策 = Manus 式「系统层可抛弃、用户层持久」:持久目录白名单(`workspace/`、`.browser-profile/`、少数 dotfiles)之外一切可丢弃;定期(或每 N 个 mission)重置到干净模板 + 只回注白名单目录,卫生重置做成箱外可下发的治理任务。B 案箱边界即会话边界,天然规避;但配用户级 profile 归档后,归档带雷会随注入复活——筛查机制同 A 的白名单思路。
3. **成本线性**:容量按**活跃单位**规划(A 活跃用户 / B 活跃会话)。l40-01 单机容量 = 常驻内存 ÷ 箱均内存,需实测 cubebox 单箱开销后定容量模型与第二节点触发线。计费维度从 mission 改为「箱·小时 + 唤醒次数」。差异:A 长尾在注册不活跃用户(休眠托底),B 峰值在并发活跃会话(会话结束箱即销)。
4. **持久层/快照凭据卫生**:`.browser-profile` 本身含登录 cookie——属预期内(这就是产品能力),但持久层归档因此成为高价值目标,平台侧必须加密 + 按用户隔离;mission 级 API Key 仍**不落箱盘**(D5,唤醒注入休眠消失)。原生 pause 落地后必须补「休眠前 secrets 清扫」步骤(分析文档 §5.2)。
5. **(仅 B)会话间登录态迁移**:从旧会话箱抽 `.browser-profile` 归档到平台侧,新箱起时注入。工程量 = profile 抽取/注入(tar 传输)+ 存储加密 + 版本管理。若走折中路线(§2),workspace 也按用户归档,每次会话唤醒全量注回,白名单治理不能省。
6. **(仅 B)cron 错配**:cron 用户级语义 vs 会话级箱,到点无箱可投。候选对策:①cron 绑发起会话——到点 ensureAwake 那个会话的箱,语义「cron 在你的会话工作台里跑」;②cron job 首次执行生成自己的会话箱——一个 cron job 一个箱,语义「cron 有自己的工作台」;③把 cron 会话当「永续会话」——cron 创建的会话不受会话过期规则约束,每次到点都是唤醒源。三案语义各有扭曲,选型待粒度拍板后细化。

## 5. 威胁模型(诚实版,延续老文档格式)

本次迁移**能防**(两案相同):
- 插件 JS 进程被劫持(老债消解:agent 进程整体进 VM,平台侧只信控制面);
- 用户间横向越权(microVM 硬隔离,替代原先「同进程不同 userId 过滤」);
- 出网滥用(egress 默认拒 + allowlist,`DEFAULT_CREDENTIAL_BINDINGS` 网络层强制;内网/元数据端点同拒);
- mission Key 经快照/持久层泄漏(不落盘注入制)。

**不能防 / 新引入**(如实记录):
- **A 案**:同用户跨 mission 污染(§4.2 对策是缓解不是根治:白名单目录内的污染仍可能随回注复活);
- **B 案**:会话间登录态迁移是新增攻击面(profile 归档被平台侧攻破 = 用户全部登录态一锅端);归档带雷随注入复活污染;
- microVM 逃逸 0-day——边界强度依赖 cubebox/Firecracker 本身,平台侧监控 + 单箱资源上限兜底;
- DNS rebinding TOCTOU(既有,延续;根治需箱内 pin IP,后续项);
- 持久层归档被平台侧攻破 = 用户全部登录态 + 工作区一锅端(加密是缓解,平台存储本身成为单点);
- 沙箱↔web 明文(TLS 配好前,内网部署是唯一缓解)。

## 6. 里程碑(分层:通用层先行,粒度决策可推迟)

- **M1 box-runtime**(粒度无关):新 `apps/box-runtime`(headless `createAgentRuntime()`,吃任务包跑 loop);移植 runner poster/redaction/outbox/audit;本地 docker 冒烟,**不碰真沙箱**。
- **M2 通用注册表 + 唤醒/休眠**(粒度无关的通用层):web 侧 sandbox-dispatcher——ensureAwake 状态机(missing→creating→awake→sleeping,建中并发请求合并)+ 空闲 sweep(在跑保护)+ v1 持久层(rsync 持久目录,可插拔接口)。**注册表 key 设计为 `(scope: user | conversation, scopeId)`**,两案只差 scope 值与 sweep 语义(A: 用户空闲 30min;B: 会话空闲 + 会话过期双重 sweep)。
- **M2.5**(仅 B 案,拍板后):登录态迁移机制 + §4.6 cron 对策选型落地。
- **M3 模板与治理闭环**:CubeSandbox 模板(node20 + box-runtime + chromium/playwright,TCR 构建);egress allowlist 下发;cron 唤醒;审批跨箱(Phase 2 frozen-command 白名单门模式移植);产物回流。治理重心:A 案 = 跨任务污染(白名单回注 + 卫生重置);B 案 = 会话边界治理(过期销毁 + 归档带雷筛查)。
- **M4 升级与容量**:实测 CubeSandbox 原生 pause/resume(成则替换 rsync);卫生重置任务(A);密度压测定容量模型;计费改造(箱·小时)。

拍板不阻塞开工:M1/M2 通用层对两案同构,粒度决策最晚可推迟到 M2 末(即 M3 模板与治理按案分叉前)。

## 7. 上机验证清单(决定 M2/M4 走向,尽早做)

1. CubeSandbox 是否有运行中沙箱的 pause/resume 或快照 API(决定 D6 升级路径);
2. 单箱内存/磁盘实际开销 + 同节点多箱密度(决定容量模型,两案都需要);
3. 销箱重建 + 持久目录注回后 playwright profile 完整性(登录态是否保真;B 案登录态迁移机制的可行性前提);
4. egress allowlist 能做到什么程度(平台侧配不了就用箱内 iptables 兜底);
5. playwright/chromium 模板镜像体积与 READY 时间(B 案高频生灭下此项权重更高)。

## 8. 测试计划

- dispatcher 单测:ensureAwake 状态机全转移(无箱/建中/醒/睡/建中并发请求合并);空闲 sweep 的在跑保护与竞态;
- 持久层:往返一致性(workspace + profile 快照→注回内容一致)、中断续传、持久层存储加密;
- 污染治理:(A)白名单外路径丢弃、白名单内保留断言;(B)登录态迁移往返一致性 + 归档带雷筛查;
- 凭据:mission Key 不落箱盘断言(全盘扫描)、休眠后环境清零;
- 通道:eventId 幂等去重、redaction 脱敏断言、outbox TTL/上限(移植 runner 测试模式,`apps/runner/src/*.test.ts` 同构);
- e2e:docker 冒烟(消息唤醒→跑→空闲→休眠→cron 唤醒→审批交互全程)。

## 9. 显式不做(v1 边界)

- 不做原生 pause / 运行中快照(M4 验证后再上,不阻塞 v1);
- 不做同用户/同会话多箱并行(一单位一箱,箱内调度解决);
- 不做箱内 GUI / Computer Use(浏览器走 playwright,桌面面不进箱);
- 不做 MCP gateway(CubeSandbox 侧接口就绪但不可用,不依赖);
- 不做 per-tenant 计费精细化(箱·小时 + 唤醒次数够用);
- 凭据代理(v2)不进 v1,占位接口预留;
- 折中路线(§2)不进 v1,仅备忘。

## 10. 时序(典型场景重放)

方案 A(用户级):
```
T0   用户首次发消息 → dispatcher:无箱 → 建箱(模板+持久层注回+Key 注入) → supervisor 起 → 任务包投递
T1   mission 跑完 DONE → 空闲计时开始;期间后台子 mission 照跑(不休眠保护)
T2   30min 无活动 → sweep: rsync 持久目录 → 销箱 → state=sleeping(只占持久层磁盘)
T3   次日 cron 到点 → ensureAwake: sleeping → 建箱+注回 → 定时任务包(用户不在线也跑)
T4   用户点审批卡 → ensureAwake(已醒,直接投递) → 审批决定经长轮询下行 → mission 续跑
T4'  (变体)箱已睡 → 审批交互先唤醒(分钟级)再投递;审批等待期间不休眠
```

方案 B(会话级):
```
S0   会话首条消息 → dispatcher:无箱 → 建箱(模板+[登录态迁移]+Key 注入) → 任务包投递
S1   续聊(同会话新 mission)→ 箱已醒直接投递;会话上下文随箱内 runtime 连续
S2   会话空闲超时 → 休眠(同 A);会话过期 → 销毁
S2'  「新会话」指令 → 销旧箱;新箱起时做登录态迁移
S3   cron 到点 → 按 §4.6 选型执行(绑发起会话 / cron 专属箱 / 永续会话,三选一)
```

## 11. 版本说明

本版为两案并列草稿(粒度待定)。原单案版(每用户一箱,2026-11-09 上午)的论证已并入 §2 方案 A;原决策记录中 D1(每用户一箱)解耦为待定项,D2–D6 对两案均成立。粒度拍板后,本文档收敛回单案,§2 另一案降级为「已否决备选」附录。
