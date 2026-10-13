# 研究文档:多 Agent / 子 Agent 何时该用 —— 业界产品调研与 agtpilot 决策

> 状态:**研究结论 + 提案**(2026-10-13;由负责人微信提问「工坊任务有必要多 agent 吗」触发。核心裁定:**不做 agent 团队编排;补一个只读检索子 agent(P1)+ 上下文工程只补真空白(P1);PPT 长任务走多段 Mission 分解(P2)**。同日二次核查修订 §6.2:Manus 上下文工程四要点经代码 + git log 逐项核实,**大半已在本仓实现**,该节改写为核查状态表 + 仅存空白)
> 来源:Claude Code 子 agent 机制(第一手运行经验)、Anthropic 多 agent 研究系统工程博客、Manus 官方博客(Wide Research + 上下文工程)、Meta Muse 设计页、Cognition《Don't Build Multi-Agents》、OpenAI Agents SDK,以及本仓代码调研(orchestrator / planner / router / decision / runner / 工坊)
> 涉及模块:`packages/core/src/orchestrator.ts`、`packages/core/src/routing.ts`、`packages/plugin-router`、`packages/plugin-planner`、`packages/plugin-decision`、`packages/plugin-compaction`、`apps/runner`、`apps/web/src/components/workshops`
> 关联文档:`personal-ai-landscape-insights.md`(多 Agent「推迟不排期」的原始裁定)、`agent-runtime-decoupling-insights.md`(subagent 标记「❌ 缺;随 Thread 搁置」)、`workshop-scenario-loop.md`(多步工作流 P1)、`local-runner-bridge.md`(派发 = 任务级委托)、`context-store-filesystem-paradigm.md`(文件系统范式,与 §6.2 直接相关)、`subagent-plugin-spec.md`(§6.1 的实施方案,2026-10-13 草案)

---

## 0. 结论速览(TL;DR)

1. **业界规律**:生产环境跑通的子 agent 场景全部满足「读密集、可并行、高噪音、或需权限/审查隔离」;写密集强耦合任务(改代码)业界一致单 agent(Claude Code 主循环、Devin、Cursor composer、Manus 核心链路皆如此)。
2. **agtpilot 现状**:单 agent 主循环 + 插件工具箱,无多 agent;这不是缺陷,与业界主流一致。且 runner 派发(工坊发现 → 本地 `claude -p` 动手)已经是 Primary + Specialist 的**正确形态**——跨机器、以任务队列为边界。
3. **13 个工坊逐一评估**(§5):内容生产类不需要;调研类(oss_radar / invest / edu / follow_builders)是唯一值得上子 agent 的场景;PPT 是任务分解问题而非多 agent 问题。
4. **行动建议**(§6):P1 只读检索子 agent(轻量,落在 router 预留的 specialist 接口位);P1 上下文工程**只补真空白**——看板复述注入、大结果自动 offload、提示前缀治理(经核查 Manus 四要点中「文件系统当记忆」「保留失败动作」「前缀稳定」大半已实现,见 §6.2 核查表);P2 PPT 拆多段 Mission;**明确不做**:agent 团队协作编排、并行写代码、角色扮演式多 agent。

---

## 1. 判断框架:什么时候需要子 agent

多 agent 的本质是**上下文管理 + 并行 + 隔离边界**,不是「多个 AI 一定更好」。两条判断标准:

| # | 标准 | 是 → 收益 | 否 → 纯开销 |
|---|---|---|---|
| 1 | 子任务相互独立吗? | 并行缩短墙钟时间 | 协调成本超过收益,产出互相冲突 |
| 2 | 中间噪音远大于最终结论吗?(翻 50 个文件出一个结论) | 上下文隔离,主线保持干净 | 隔离无意义 |

辅助维度:

- **读密集 vs 写密集**:读密集(搜索/调研/审查)可并行;写密集(改代码/写文件)强耦合,并行必冲突。
- **决策耦合度**:子任务若需要看到彼此的中间决策,拆开会各自做出冲突假设(Cognition 的核心论点,见 §3.7)。
- **成本容忍**:Anthropic 实测多 agent 研究系统 token 消耗约为单 agent 对话的 **15 倍**——只在「任务价值 > 15x token」时用。

---

## 2. Claude Code 的子 agent 机制(第一手样本)

Claude Code 是「主循环单 agent + 场景化子 agent」的代表实现,其边界设计最值得抄:

### 2.1 四种触发情况

1. **广域搜索(最主要)**:任务需要扫大量文件/目录,而主 agent 只需要结论不需要文件内容。Explore 子 agent 的定位原话:「you keep the conclusion, not the file dumps」。
2. **可并行的独立工作**:多个互不依赖的子任务(如从 bugs/性能/安全多维度审查同一份 diff)同时派发。
3. **新鲜眼睛**:主 agent 审查自己刚写的代码有自我确认偏差;spawn 干净上下文的子 agent 只看 diff 本身,更客观。
4. **权限/模型/隔离边界**:不同子 agent 挂不同工具权限(只读 vs 可写)、简单子任务用便宜快的模型、危险改动进隔离 worktree,失败不污染主会话。

### 2.2 上下文隔离的三层边界(关键设计)

| 层 | 内容 | 持久性 |
|---|---|---|
| 子 agent 自己的上下文 | grep 结果、文件 dump 全量追加;单次工具输出有截断保护(如 Read 默认 ≤2000 行) | 临时,任务结束即弃用 |
| 跨边界回主 agent | **只有 final report 一段文本**,原始工具输出零回传;报告大小由派发指令控制(「只要结论、附文件:行号、别贴代码」) | 进入主上下文 |
| 完整 transcript 落盘 | JSONL 全量落盘,用于审计与「续聊」(可唤醒同一子 agent 从其 transcript 恢复) | 主 agent 被**明确禁止**读取,防止噪音回灌 |

**实现要点一句话:边界上只允许传一条 final message。** 子 agent 的 tool results 追加到它自己独立的消息数组,主循环永远看不到。

### 2.3 Claude Code 写代码为何仍是单 agent

改代码是串行强耦合任务(每步决策依赖前步产出),由主 agent 独占;子 agent 只做搜索/审查/问答。与 §3.7 Cognition 的结论互相印证。

---

## 3. 业界产品扫描:四种模式 + 一个反例

### 3.1 模式一:Deep Research 并行检索(子 agent 最成功的商用场景)

- **Anthropic Claude Research**:orchestrator-worker 架构。主 agent(lead)拆解研究问题后 spawn 多个并行搜索子 agent,各查一路(不同关键词/来源/角度),只回传提炼结论。官方数据:多 agent 比单 agent Opus 在内部研究评测上**提升 90.2%**,代价是 token 消耗约 15 倍;并明确总结「多 agent 适合广度优先的读密集任务,不适合写密集任务」。
- **Gemini Deep Research、OpenAI Deep Research**:同思路(规划 → 并行检索分支 → 汇总)。
- 适用特征:开放式研究问题、广度优先、读密集、各路独立、噪音极高。

### 3.2 模式二:Specialist 交接(handoff)——「换 agent」而非「并行多 agent」

- **OpenAI Agents SDK**:核心原语是 handoff——triage agent 判断意图后,把对话连同上下文**移交**给专家 agent(改签航班的、退款的、答 FAQ 的)。
- 典型场景:客服/企业 copilot。价值在**工具权限隔离**(退款 agent 能调退款 API,FAQ agent 只读)+ 提示词聚焦,不在并行;同一时刻只有一个 agent 活跃。

### 3.3 模式三:生成与审查分离(新鲜眼睛)

- 代码审查机器人、generator-critic 循环:产出方与验收方分离,critic 拿干净上下文只看成品。CI 类产品(自动 review、安全扫描)几乎都是这个形态。

### 3.4 模式四:任务级并行(环境隔离的多实例,不在一个进程里)

- **Cursor background agents**:多个独立任务各开一个隔离环境并行跑。
- **GitHub Copilot coding agent**:一个 issue 派一个 agent,独立沙箱分支干活,产出 PR。
- 并行的单位是**任务**而非进程内子 agent —— 与本仓 runner 派发同类(§4.2)。

### 3.5 Manus:核心单 agent,多 agent 只用在 Wide Research 一个功能上

**核心执行链路是单 agent + 云端沙箱 VM**,以「上下文工程」闻名(其官方博客六课,对 agtpilot 直接可抄,见 §6.2):

1. 围绕 KV-cache 设计(提示词前缀稳定,缓存命中率直接决定延迟与成本);
2. 屏蔽工具而非删除工具(保持工具列表稳定);
3. **文件系统当外部记忆**:资料写文件、上下文只留路径,把「无限上下文」外包给磁盘;
4. **todo.md 复述(recitation)**:每步把任务清单重写到上下文末尾,对抗长任务目标漂移;
5. 保留失败动作在上下文里,让模型学会绕坑;
6. 避免 few-shot 堆砌,给清晰的动态指令。

**Wide Research(2025 年中上线)是其唯一的多 agent 功能**,官方定位:「系统级并行处理机制 + agent 间协作协议」。

- 触发场景非常窄:**广度优先、按条目展开的批量任务**——「研究财富 500 强每家」「对比所有顶级 MBA 项目」「扫描 GenAI 工具全景」。核心思想:一个处理器串行处理 n 个条目会撑爆上下文,不如派 n 个并行子 agent 各处理一个。
- 两个设计细节:① 每个子 agent 都是**完整的通用 Manus 实例**(自己的 VM 和上下文),不是阉割版角色工人——回避角色分工的协调复杂度;② 主控只做「分解成独立可并行子任务 + 汇总」,不干预子 agent 内部。
- 判断标准与 §1 完全一致:条目独立 + 读密集 + 单上下文装不下,三条全占才开 swarm;普通任务(订票、做表、写报告)一律单 agent。

### 3.6 Muse(Meta,2026-09 上线):单 agent + 每人一台云 VM,官方架构无子 agent

- 每用户一台专属云端虚拟机(文件系统/终端/浏览器),24/7 后台运行;模型为自研 Muse Spark(后续 Muse Wonder)。
- **并发靠会话级隔离而非 agent swarm**:main chat 主对话 + side chats 各自独立上下文 + goals 后台长任务;记忆持久化为可查看的 Memory files。
- 安全:结构化审批卡 + 对「难以撤销的操作」强制 human-in-the-loop。
- 官方设计页通篇未提 subagent/并行 agent/编排——「同时管多件事」= 多会话多目标并行。
- 姊妹产品 Muse Code(2026-08)对标 Anthropic/OpenAI 编程 agent,同样未宣传多 agent。

### 3.7 反例:Cognition(Devin)《Don't Build Multi-Agents》

- 核心论点:写密集任务拆给并行子 agent 必然翻车——**行动携带隐含决策**,各 agent 看不到彼此的决策轨迹就会做出冲突假设;**上下文碎片化比上下文过长更致命**。
- Devin 的选择:单线程长任务 + 上下文压缩(+ 为长上下文微调模型)。
- MetaGPT / ChatDev 式「模拟软件公司多角色辩论」基本停在学术演示,未进生产。

### 3.8 模式汇总表

| 模式 | 代表产品 | 并行? | 适用任务 | agtpilot 对应 |
|---|---|---|---|---|
| 1 Deep Research 并行检索 | Claude Research、Gemini/OpenAI DR、Manus Wide Research | ✅ 进程内子 agent | 广度优先读密集调研 | **缺**(§6.1 补) |
| 2 Specialist handoff | OpenAI Agents SDK、客服系统 | ❌ 单活跃 | 多领域 + 权限隔离 | plugin-router 已预留 specialist 接口位 |
| 3 生成/审查分离 | 代码审查机器人、critic 循环 | 可选 | 交付物独立验收 | 将来做发布前审查时可选 |
| 4 任务级并行 | Cursor background agents、Copilot coding agent、**agtpilot runner** | ✅ 环境隔离 | 独立工单批量执行 | **已有**(runner 派发) |
| 反例 单 agent + 压缩 | Devin、Claude Code 主循环、Manus 核心、Muse | ❌ | 写密集强耦合 | 现状即正确 |

---

## 4. agtpilot 现状盘点(代码调研结论)

### 4.1 内核:单 agent,无任何派生子 agent 路径

- `packages/core/src/orchestrator.ts:43` `OrchestratorService` 名为 orchestrator,实为**单任务循环编排器**:`runTask()`(:73)一个任务跑一条模型 agent loop(多步循环委托 plugin-model 的 AI SDK v5),核心层只做熔断、HITL 审批、压缩、检查点、事件广播;maxSteps 默认 20(:25)。
- 全部约 47 个注册工具中**不存在 Task/Agent/spawn_agent 类工具**;`routing.ts:69` `selectActiveTools` 是工具按需挂载,不是 agent 路由。
- 三个易混淆插件均非多 agent 编排:**planner** = 任务看板(分解展示,文档原话「不是并行执行」);**router** = 模型能级路由(reasoning/fast/local 三档,换模型不换 agent);**decision** = 小模型对工具路由等决策点做 150ms 限时裁决。
- 既有裁定:`personal-ai-landscape-insights.md:188`「Primary + Specialist 多 Agent……**推迟,不排期**:router 保持模型分级路由,预留 specialist 路由接口即可」;`agent-runtime-decoupling-insights.md:87-88` 将 subagent/子线程标为「❌ 缺,随 Thread 概念一起搁置」。本文不推翻该裁定,只是把「什么情况下值得解冻」写清楚。

### 4.2 runner 派发 = 已经是正确形态的「跨机器多 agent」

- 工坊(云端只读发现)→ 雷达机会卡「派发到本地」→ runner 轮询领取(`apps/runner/src/client.ts:98-105`,可绑定 targetDeviceId)→ spawn 本机 `claude -p` headless 动手改码(`executor.ts:186` ClaudeCodeAdapter)→ 两阶段安全(本地干活无副作用,云端审批固化 push/PR,`publish.ts` 白名单)。
- 这就是 Primary + Specialist:写密集强耦合的活外包给独立 agent,以任务队列(TaskPack)为边界,天然规避了 Cognition 指出的并行写冲突。**不需要改造,需要的是把工坊侧的「发现」环节补强**(§5、§6.1)。

### 4.3 与 Muse 同构的产品形态

驾驶舱(main chat)+ 沙箱/桌面插件(VM)+ HITL 审批门(审批卡)+ runner 两阶段审批(难撤销操作固化)——与 Muse 的架构选择一一对应,说明产品形态已被业界头部验证。

---

## 5. 工坊任务逐一评估

工坊 = 表单拼 Prompt → 一个普通 Mission → `orchestrator.runTask` 单循环,**不走 runner**(`apps/web/src/components/workshops/registry.ts`、`run.ts:41`)。13 个工坊按形态分三类:

### 5.1 内容生产类 —— 不需要多 agent

小红书/公众号/知乎/微博/抖音/B站脚本/周报/邮件分诊:单发生成或几轮工具,短任务、低噪音、任务间完全独立。两条标准(§1)全不占,单 agent + 现有并行工具调用已覆盖。上多 agent 是纯开销。

### 5.2 调研类 —— 唯一值得上子 agent 的场景

oss_radar / invest / edu / follow_builders / 小红书选题:多路异构检索(GitHub MCP + DeepWiki + 网页搜索 + 行情连接器/OpenAlex)→ 汇总。**两条标准全占**:各路检索天然独立;噪音中等偏高。

痛点已在代码里露头:`orchestrator.ts:41` 特意叮嘱「独立检索一轮批量发出,否则成倍浪费往返与**上下文重发**」——现在靠并行工具调用硬扛,但所有检索原始结果仍全部灌进主上下文,挤压 20 步预算与压缩水位。

这正是模式一(Deep Research 并行检索)的轻量版场景,方案见 §6.1。

### 5.3 PPT —— 任务分解问题,别用多 agent 解

`ppt-workshop.ts:170-214` 的 pptx 路线是 12 步脚本(读规范 → 逐页手写 SVG → 反复质检 → 导出),唯一容易撞 maxSteps=20 上限、被系统建议「拆小」的场景(`orchestrator.ts:534`),中间噪音最高。但步骤**串行强耦合**(写 → 质检 → 修 → 导出),并行收益为零。正确解法是 `workshop-scenario-loop.md` 已提议的多步工作流:拆成多段 Mission + 检查点(§6.3)。

### 5.4 评估汇总表

| 工坊类别 | 读/写 | 长度 | 子任务独立? | 噪音比 | 多 agent? |
|---|---|---|---|---|---|
| 内容生产(6+ 个) | 写 | 短(单发) | — | 低 | ❌ 不需要 |
| 调研类(oss_radar/invest/edu/follow_builders) | 读 | 中(多轮检索) | ✅ 各路独立 | 中高 | ✅ 检索子 agent(§6.1) |
| PPT | 写 | 长(12 步,撞上限) | ❌ 串行耦合 | 高 | ❌ 拆 Mission(§6.3) |
| 动手改码 | 写 | 长 | — | — | ✅ 已外包给 runner(§4.2) |

---

## 6. 借鉴清单与路线图

### 6.1 P1:只读检索子 agent(模式一轻量版)

**目标**:调研类工坊的多路检索不再灌爆主上下文;检索路数可扩展而不挤占主任务 20 步预算。

**设计要点**(全部来自 §2.2 Claude Code 边界设计):

1. 新增一个工具(如 `research_subagent(query, sources_hint, output_schema)`),挂在 plugin-router 预留的 specialist 接口位,或直接作为 core 工具;
2. 子 agent = **独立消息数组 + 独立步数/token 预算**(建议 8~10 步、可配),复用现有 ModelGateway,可用 router 的 fast 档模型省成本;
3. **边界上只传一条 final message**:子 agent 的全部 tool results 留在自己的消息数组,主循环只拿到最终结构化结论(按工坊输出格式约定字段头);
4. 子 agent 完整 transcript 落盘(检查点/observability 已有管道),**主循环永不自动回灌**;
5. 只读工具集(搜索/网页/MCP 读接口),不给写工具——权限隔离即模式二的最小应用;
6. 支持一轮 spawn 多个并行实例(各路检索独立),主控汇总——这就是 orchestrator-worker,规模上限设小(如 ≤4 路),token 成本可控(§1 的 15 倍教训)。

**不做什么**:不做角色专精人设(Manus Wide Research 教训:子 agent 用通用实例 + 明确任务描述即可);不做 agent 间实时通信(主控分解 + 汇总足够)。

**实施方案**:已细化为 `docs/design/subagent-plugin-spec.md`(2026-10-13 草案,含接口签名、白名单、三重预算闸、安全红线、验收与 M1-M3 分期)。

**验收**:oss_radar 工坊一次 run 的主上下文 token 量显著下降;20 步预算内可完成此前会被迫砍路数的调研;结论质量不降(对照现有输出格式逐字段检查)。

### 6.2 P1:Manus 式上下文工程 —— 核查结论:大半已实现,只补真空白

> **2026-10-13 逐项核查**(代码 + git log + 设计文档):本节初稿的四条建议中,「文件系统当记忆」「保留失败动作」「前缀稳定」**已在本仓专项实现过**——`context-store-filesystem-paradigm.md` P1-P3 已于 2026-10-12 落地(commit f952c34→2cf5487→8e64419→a242257),失败保留是 `compaction-plugin-plan.md` 的明文验收项(commit aff4996),路由只扩不缩是 `loop-execution-optimization.md` P2 的 KV-cache 专项(commit 7345e4a)。初稿属重复建议,现改写为核查状态表 + 仅存空白。

**核查状态表**:

| Manus 要点 | 本仓状态 | 关键证据 |
|---|---|---|
| 文件系统当记忆 | ✅ 大半已做,缺「自动 offload」 | `context_file` 笔记区五动作、大输出存文件留摘要+路径(`apps/web/src/lib/memory-service.ts:1185-1240`);L0 清单只注入 path+大小(:893-897);浏览器 4000 字符窗口 + nextOffset 续读(`plugin-browser/src/index.ts:150-160,590-601`);工具输出 16KB 头尾截断(`core/src/text.ts:45-63`) |
| todo.md 复述 | ❌ 没做(四项中唯一完全空白) | 看板只存进程内存 + 广播前端(`plugin-planner/src/index.ts:20,129-136`);`prepareStep` 每步做路由/压缩/治理/steering/检查点,**唯独不注入看板状态**(`orchestrator.ts:375-437`);模型唯一可见点是 `planner_create_plan` 的一次性返回值,无 get_plan 类查询工具 |
| KV-cache 友好 | ⚠️ 部分做 | 已做:工具 tokens < 上下文 10% 时全量挂载、前缀恒定(`routing.ts:82-83`);任务内**只扩不缩**、注释明说为 provider 前缀缓存(`routing.ts:109-131`、`orchestrator.ts:324-329,389-399`);时间戳刻意日粒度(`task-system-prompt.ts:17-25`)。未做:activeTools 是**移除式**而非 Manus「保留定义 + tool_choice 屏蔽」(`plugin-model/src/index.ts:104-117`);动态内容(时间戳、userMemoryPrompt)嵌在前缀中部,记忆一更新整段前缀缓存失效 |
| 保留失败动作 | ✅ 已显式做 | isError 检测 + 失败调用 keepCall=0.8/keepResult=0.95(`plugin-compaction/src/classify.ts:61,77-79`);keep 白名单调用+结果**原样保留**不进纪要(`core/src/compaction.ts:39-43,73-84`);连续失败守卫注入换思路提示且保留真实报错(`orchestrator.ts:255-272`) |

**真空白(建议按此顺序补)**:

1. **看板复述注入**(对应 Manus todo.md recitation,零架构改动):`prepareStep` 末尾把当前看板快照(步骤 + 完成态)注入模型上下文,或加一个 `planner_get_board` 只读工具。现状反而是负分:看板自动推进(`orchestrator.ts:380-388`)之后,模型再无任何渠道看到清单——创建完就"失忆",长任务(PPT 12 步)目标漂移风险真实存在。
2. **大结果自动 offload**(「丢中间」变「存中间」):现有 16KB 截断与 4000 字符窗口丢掉的中间内容**直接消失、不落盘、无法按路径取回**;压缩蒸馏出的纪要也不留被压原文的磁盘副本(唯一落盘是崩溃恢复面的 checkpoint 消息快照,模型不可寻址)。建议:超限工具结果自动全文写入笔记区文件、上下文留路径+摘要;compaction 时把被压原文归档到磁盘。
3. **提示前缀治理**(静态前置、动态后置):把时间戳、userMemoryPrompt 等动态块移到系统提示**尾部**,行为准则等静态段前置,避免记忆更新击穿整段前缀缓存。进阶可选项:activeTools 从移除式改为全量声明 + tool_choice 屏蔽(Manus 原教旨做法),代价是请求体变大,需实测缓存命中收益后决定。

**顺带发现的两个 bug 级瑕疵(建议尽快修,与多 agent 无关)**:

- `classify.ts` 的 isError 正则只认英文 `fail|error|timeout|exception`,**纯中文报错会漏检**,失败调用被当普通调用压进纪要;
- 纪要蒸馏 prompt(`orchestrator.ts:643` 附近)写着「**忽略重复与失败细节**」,与「失败→keep」策略自相矛盾——目前靠 classify 前置拦截才没出事,属定时炸弹文案,应改为「保留失败及其原因」。

### 6.3 P2:PPT 长任务拆多段 Mission

跟随 `workshop-scenario-loop.md` 的多步工作流(P1 提案)一起落地:大纲 → 分页生成(每页/每批一段 Mission,段间以文件系统交接 SVG 产物)→ 质检修复 → 导出。段与段之间用检查点衔接,天然解决 maxSteps 上限;**不需要**段间并行(串行耦合),因此不需要多 agent。

### 6.4 明确不做

| 不做 | 原因 |
|---|---|
| Agent 团队协作编排(agent 间实时通信/共享黑板) | 无场景;Cognition 论证写密集任务必翻车;Anthropic 15x token 成本 |
| 并行多 agent 写代码 | 改码已外包 runner(单设备串行),业界一致单 agent |
| 角色扮演式多 agent(MetaGPT/ChatDev 式辩论) | 学术演示,未进生产 |
| 解冻 Primary + Specialist 全量路线图 | 维持 `personal-ai-landscape-insights.md` 的「推迟不排期」;仅以 §6.1 的检索子 agent 作为 specialist 的最小试点 |

### 6.5 远期选项:Wide-Research 式批量条目处理

若将来出现「给 100 个仓库各出一份贡献评估」「逐条尽调一个列表」类需求,再引入 Manus Wide Research 形态:通用实例子 agent × n + 主控只管分解汇总。判断信号:用户开始要求「对列表里的每一项都做 X」且单项产出独立。在此之前不做。

---

## 7. 参考资料

- Anthropic《How we built our multi-agent research system》:https://www.anthropic.com/engineering/multi-agent-research-system
- Manus《Introducing Wide Research》:https://manus.im/blog/introducing-wide-research
- Manus《Wide Research: Beyond the Context Window》:https://manus.im/blog/manus-wide-research-solve-context-problem
- Manus《Context Engineering for AI Agents》:https://manus.im/blog/context-engineering-for-ai-agents-lessons-from-building-manus
- Meta《Introducing Muse》:https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ ;设计页:https://introducing.muse.ai/
- Cognition《Don't Build Multi-Agents》:https://cognition.ai/blog/dont-build-multi-agents
- OpenAI Agents SDK(handoffs):https://openai.github.io/openai-agents-python/
- 本仓关联:`docs/design/personal-ai-landscape-insights.md` §3/§5、`docs/design/agent-runtime-decoupling-insights.md`、`docs/design/workshop-scenario-loop.md`、`docs/design/local-runner-bridge.md`
