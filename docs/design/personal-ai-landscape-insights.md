# 研究文档:2026 Personal AI 浪潮对 agtpilot 的启发与路线图

> 状态:**研究结论 + 路线图提案**(2026-10-09,未开工;落地时按本文分期拆任务)
> 来源文章:言之AI笔记《万字 Personal AI 深度研究:Muse,Cue,Dots,小微,小豆,Today,Instinct,Alexa...》(https://mp.weixin.qq.com/s/xQA7y1YPus6gNVhkGAgTRQ)
> 涉及模块:`apps/web/src/lib/memory-service.ts`、`packages/plugin-cron`、`packages/plugin-router`、`packages/plugin-observability`、`packages/plugin-memory`,以及规划中的 `plugin-wallet` / 主动性引擎
> 关联文档:`docs/design/persistent-state-governance.md`(治理 P0/P1 已实现,本文大量构建其上)

---

## 1. 文章核心判断(浓缩)

1. **范式迁移**:AI 产品的基本单位从「一次对话 / 一个任务」转向「一个长期被理解和服务的用户」。第三种交互关系:AI 长期理解一个人 → 持续观察目标与环境 → 主动发现待办 → 获授权后执行 → 从反馈中加深理解。
2. **定义公式**:`Personal AI = Personal Context × Persistent Memory × Proactivity × Execution × Trust`。任何一项接近零,整体价值明显下降(有 Memory 没执行=懂你的 Chatbot;有执行没 Memory=通用 Agent;缺 Proactivity=高级助理工具)。
3. **Personal 的四层**:Preference Memory → Relationship & Commitment Memory → Behavioral Model(你通常怎么做决定)→ Goal Model(持续数月的 long arcs)。第四层才真正拉开与普通 Assistant 的差距。
4. **终局判断**:Personal AI = 「个人意图操作系统」(Personal Intent OS),管理的是时间、注意力、关系、任务、信息、权限、账号和钱;竞争资源从 Attention → Intent → **Delegation**(用户愿意把多少决策和行动委托给你)。
5. **六块技术拼图同时成熟**:Computer Use 可用化、长时运行 Agent Runtime(Muse Secure VM / Dots Cloud Computer)、Memory 成为正式产品基础设施(Today "living memory",用户可查看/修改/删除)、Tool 层标准化(MCP)、Agentic Payment(Stripe Shared Payment Tokens / Agentic Commerce;Cue 给每个 Agent 配 email/phone/wallet/computer)、Security 进入工程化阶段(prompt injection 未解决,permission/sandbox/audit 成为核心产品能力)。
6. **反直觉结论**:最强模型 ≠ 最好的 Personal AI。胜负取决于 Memory architecture、Permission architecture、Identity、Security、User control、Recovery/rollback、Agent UX。
7. **护城河**:Memory Lock-in(Personal Context Lock-in)——"它已经认识我两年了"的迁移成本。
8. **结构预判**:最终每用户只剩一个 Primary Agent,下挂 Specialist Agent 团队(OpenAI "teams of Dots"、Cue 多 Agent 协作同向)。
9. **主动性的陷阱**:「越主动越好」是危险误区。真正的能力是 restraint——判断该不该打扰、该不该先问、该不该沉默。主动性模型是新一代推荐系统:从 "What should I show you?" 变成 "Should I interrupt you? Act now? Ask first? Stay silent?"。
10. **演进路径**:Agent as Tool(OpenClaw/Hermes)→ Agent as Worker(办公 AI)→ Agent as Assistant(Muse/Today/Cue/Dots)→ Agent as Representative(替你沟通/谈判/购买/维护关系)→ Agent as Digital Twin / Personal Operating Layer。

---

## 2. 十层技术栈对照:agtpilot 现状盘点

文章给出的 Personal AI OS 十层栈,对照 agtpilot(pnpm monorepo,微内核 + 16 插件):

| 层 | 文章定义 | agtpilot 现状 | 覆盖度 |
|---|---|---|---|
| Interface Layer | Chat / Voice / Glasses / Messaging | `apps/web`(Generative UI / AG-UI)+ `apps/cli`;微信通道已在实战中跑通(本仓调度会话即经由 WeChat channel) | ✅ |
| Personal Context Layer | Memory / Relationship / Preference / Goals | `memory-service.ts`:四类记忆(preference/project/fact/rule)+ 六维治理元数据 + 删除台账 + 软删传导(治理 P0/P1 已实现) | ⚠️ 有骨架,缺 People/Goals/Habits/Constraints 等结构化维度(见 §4.1) |
| Intent Layer | 理解真正目标 | planner(`PlannerNotifier` 契约)+ orchestrator 循环 | ⚠️ 任务级意图有,长期目标模型无 |
| Planning Layer | 拆解任务、资源规划 | `plugin-planner`、orchestrator(熔断/审批/压缩/检查点) | ✅ |
| Permission Layer | 什么自动做、什么必须确认 | HITL 审批(`dangerLevel`)+ 权限纪元(authority epoch,治理 P1) | ✅ 且领先 |
| Execution Runtime | Cloud Computer / Browser / Code | `plugin-browser`(Playwright 持久化)、`plugin-sandbox`(Docker/E2B)、checkpoint + rehydrate | ⚠️ 有,但 in-flight loop 不自动续跑(铁律 7,见 §4.4) |
| Tool & Service Layer | MCP / API / Skills / Mini Programs | `plugin-mcp`(Tool Registry)+ 连接器体系(NewsNow/X/alphaXiv/HuggingFace/DeepL 等) | ✅ |
| Identity Layer | Email / Phone / Accounts | `email-smtp.ts` 仅发送;连接器 OAuth 代管账号;无 Agent 自有身份 | ❌ 缺 |
| Transaction Layer | Wallet / Payment / Commerce | 无 | ❌ 缺 |
| Audit & Trust Layer | History / approval / rollback / security | 治理 P0+P1:审计日志、回退弧、回滚把手、治理总线(`governance-bus.ts`)+ 473 行治理测试;插件审计修复注入面/假成功 | ✅ 且是差异化强项 |

**结论**:10 层已覆盖 6 层半,其中 Permission 与 Audit & Trust 两层因治理 P0/P1 的落地处于行业前沿位置——这正是文章论证的"胜负手"层。缺口集中在 **Personal Context 的结构化深度、Identity、Transaction、主动性引擎**。

---

## 3. 已踩对的方向(继续加码,不回头)

1. **治理即卖点**:文章引 Anthropic 结论(prompt injection 远未解决,Opus 4.5 内部测试仍有 ~1% 攻击成功率)与 Muse 上线即曝 VM/filesystem 攻击面的事实,论证 permission/sandbox/credential isolation/audit trail 的重要程度"和模型能力接近"。我们的插件审计三主线(注入面、身份锚点、假成功)与治理 P0/P1 正踩在这条主线上。
2. **Mem0 式扁平记忆是死路**:治理文档 §1.1 引用的 AOEP 教训(把经历抽成原子事实塞向量库,治理题垫底、比不存还差)与本文文章"Memory 成为正式产品基础设施"(结构化 Personal State,而非 RAG 聊天库)互为印证。我们选择六维元数据 + 结构化字段不被提炼抹平(I4),方向正确。
3. **HITL + Generative UI 审批卡**:文章强调敏感动作保留用户确认(Today 外发动作必须确认、Muse human-in-the-loop),我们的审批门 + AG-UI 富交互组件天然匹配,未来主动性引擎的建议卡片可直接复用。
4. **MCP 标准化路线**:文章判断 Tool 层正在标准化为 "Runtime ↓ MCP/APIs/Skills/Browser ↓ 服务",与我们 plugin-mcp + 连接器的架构一致,不为每家服务单独造轮子。

---

## 4. 差距与路线图(分期提案)

> 分期原则:P0 = 直接构建在已落地的治理设施上、改动集中、收益明确;P1 = 需要新插件/新契约;P2 = 依赖外部生态(支付/身份)或需架构决策;P3 = 定位与生态动作。每期独立可交付,遵守仓内「测试必须真实失败」铁律。

### 4.1 P0 — Personal State Model:记忆从 4 类扩到 9 维

**现状**:`MemoryCategory = preference | project | fact | rule`,主体 user/agent,权威四级。对照文章的 Personal State 九表:

| Personal state 维度 | 现有承载 | 差距 |
|---|---|---|
| Identity(我是谁) | fact(散落) | 无专类,无 profile 聚合视图 |
| People(家人/朋友/同事) | fact(散落) | **全缺**:无关系实体,无法支撑"识别 Alex → 看冲突 → 约饭"类链路 |
| Preferences | preference ✅ | 无 |
| Commitments(答应过谁什么) | rule(部分) | rule 混载"用户规则"与"对外承诺",缺对象(对谁)、期限、状态 |
| Goals(long arcs) | project(部分) | **缺时间弧**:无里程碑、无推进记录、无"持续几个月"的目标生命周期 |
| Habits(周三通常健身) | 无 | 全缺 |
| Constraints(周五要接孩子) | rule(部分) | 缺"硬约束 vs 软偏好"区分,planner 无法显式消费 |
| Resources(时间/账号/预算) | router 预算(部分) | 账号/时间维度缺 |
| History(过去怎么处理类似事) | checkpoint/审计日志 ✅ | 未接入记忆召回 |

**提案**:
- 扩展 `MemoryCategory` 为 `preference | project | fact | rule | person | commitment | goal | habit | constraint`(向后兼容:旧四类不动,新五类增量;治理元数据六维对全部类别生效)。
- `person` 类记忆带结构化 payload:`{ name, relation, notes[], lastInteraction }`;`commitment` 带 `{ toWhom(personRef), dueBy, status: open|done|broken }`;`goal` 带 `{ horizon: weeks|months|years, milestones[], progress[] }`。
- 召回侧:构建 user profile 聚合视图(每用户一份,由记忆派生、可重建),注入 system prompt 时按 token 预算裁剪(rule > constraint > commitment > goal > preference 优先级)。
- Today 的"living memory"三原则直接采纳为用户故事:**记忆可查看、可编辑、可删除**——web 端记忆管理页对齐(软删 + 台账已就绪,补 UI)。
- 验收:治理测试套新增"person/commitment/goal 写入→提炼→删除传导"用例;AOEP 式对抗题(改写承诺对象、删除某人后衍生引用传导)通过。

### 4.2 P0.5 — 主动性引擎:Prompt-only → Prompt + Event + Goal,且带 restraint

**现状**:`plugin-cron` 提供定时触发;无事件驱动、无目标驱动,无"该不该打扰"的判断层。

**提案**(新建 `packages/plugin-proactivity`,cron 保留为其中一种 trigger):
- 三类 trigger 统一契约:`{ kind: 'cron' | 'event' | 'goal', condition, action: 'suggest' | 'ask' | 'act' }`。
  - event:连接器/MCP 订阅源变化(新邮件、价格变动、日历冲突);
  - goal:goal 类记忆的里程碑检查(每周推进 review);
  - cron:既有定时。
- **restraint 层是本体,不是附件**:每次触发先过一道"打扰判决"(小模型或规则):`Should I interrupt? Act now? Ask first? Stay silent?` 判决依据 = constraint(周五接孩子→周五傍晚静默)+ habit + 用户对同类建议的历史接受率。
- 建议统一走 Generative UI 审批卡(suggest→卡片;ask→卡片+输入;act→按 dangerLevel 走既有 HITL 门),**主动性永远不绕过 Permission 层**——这是与治理体系的接合点,也是文章"错误容忍曲线不对称"(替用户发错邮件是事故级)的对策。
- 反冷启动:接受/拒绝/忽略三态回流为 behavioral 信号(见 §4.1 habit/constraint 的自动沉淀,标 `agent-auto` 权威,可被用户覆盖)。
- 验收:注入"高频误报触发器"的对抗测试——restraint 层必须把静默率压在阈值内,否则测试失败。

### 4.3 P1 — Delegation 指标体系:observability 埋"委托"而非"活跃"

文章给出的指标框架,直接采纳为 `plugin-observability` 的 metrics 扩展:

| 指标 | 含义 | 埋点位置 |
|---|---|---|
| Delegated Tasks / WAU | 每周真正委托的事数 | mission 创建 |
| Task Completion Rate | 真正完成比例 | mission 终态 |
| Proactive Acceptance Rate | 主动建议被认可率 | 主动性引擎三态回流 |
| Confirmation → Execute Rate | 审批通过后的执行成功率 | HITL 门 + 工具结果 |
| Permission Expansion Rate | 用户愿意开放更多权限 | 权限纪元变更事件 |
| Memory Correction Rate | 用户改/删记忆的频率(User Model 准确度) | 记忆审计日志 |
| Autonomous Task Duration | 一个目标被持续管理多久 | goal 生命周期 |
| Repeat Delegation Rate | 成功后是否继续委托 | mission 归因 |
| Human Intervention Rate | 需要用户救场次数 | 熔断/接管事件 |
| Trust Incident Rate | 错发/误买/越权事故 | 审计日志 + 回滚把手触发 |

North Star:**Hours / Decisions Delegated per User**(委托出去的生活认知负担),而非会话时长。`observability_get_metrics` 增加 `delegation` 命名空间;Trust Incident 单独告警。

### 4.4 P1.5 — 持久运行:mission 受控续跑(与铁律 7 的和解方案)

**张力**:文章强调"关了 App 事还在推进"是 Muse/Dots 的核心体验(生活任务天然异步:等邮件/等降价/等预约);而 ARCHITECTURE.md 铁律 7 与治理文档非目标均承诺 **in-flight loop 不自动重启**(现状:重启后 mission 标记中断、由用户续对话恢复)。

**提案**:不推翻铁律,而是分两步走:
1. **异步等待原语**(先做):mission 内显式 `wait_for(condition, timeout)` 挂起点——落盘为 durable 状态,由轻量 watcher(非 agent loop)轮询/订阅条件,满足后**新建一段 loop** 继续 mission。这不违反铁律 7(不是重启 in-flight loop,而是调度新的受控段),却覆盖"今天发邮件→三天后查回复→下月续订"的主场景。
2. **受控自动恢复**(后议,P2 决策点):在治理三件套齐备的领域(该 mission 全部行动有回滚把手、权限纪元未失效、预算内)允许自动续跑,其余维持人工确认。是否放开由 Trust Incident 指标说话。

### 4.5 P2 — Agent Identity + Wallet:补最后两层

- **Identity**:Cue 的信号是 "Every agent gets its own identity"(email/phone/wallet/computer),文章判断 **Wallet 会像 Browser 一样成为 Agent Runtime 标配**。演进路径 `AI uses my accounts → My AI has its own delegated identity`。agtpilot 第一步不必激进:先做**委托身份档案**——每个 Agent 实例一份 identity bundle(专属发件地址、署名、可代表范围声明),挂到权限纪元上(撤销授权=纪元失效=身份冻结)。
- **Wallet**:新建 `plugin-wallet`,只对接带授权原语的支付基础设施(Stripe Shared Payment Token / Agentic Commerce 式:授权范围、时间、金额、商户四约束,不暴露原始凭据)。每一笔支付天然 `dangerLevel: critical` 走 HITL + 回滚把手(不可补偿则显式标注,治理 I5)。国内链路(微信支付/AI 支付基础设施)留连接器位。
- **多 Agent**:文章"一个 Primary + 一队 Specialist"结构与 `plugin-router` 天然适配——router 从模型分级路由扩展为 specialist 路由(旅行/购物/研究/编码/财务),Primary 持有 Personal Context、Intent、Permission、Routing 四权,Specialist 以受限 ToolSession 领任务。

### 4.6 P3 — 定位与生态动作

文章的残酷现实:OpenClaw/Hermes 一脉"能力很强,但安装/配置/选模型/管 Skills/API Key 本身就筛掉了绝大多数消费者";同时大厂用 Memory Lock-in 建墙("它已经认识我两年了")。

**agtpilot 不应去拼消费级 UX,应反向定位**:

> **自托管、记忆主权归用户、治理/审计/回滚一等公民的开源 Personal AI Runtime。**

- 大厂护城河是"迁移成本",我们的反命题是"**可携带性**":User Model 完整导出/导入(结构化 JSON + 治理元数据 + 审计台账),把 lock-in 变成行业互操作标准提案。这是开源身位独有的可信度。
- Instinct 的教训(9 月下旬延迟与任务遗漏,归因有限基础设施)说明该赛道 compute-intensive——自托管 + router 预算控制反而是成本叙事上的卖点。
- interface-less 趋势(Instinct 无 App 理念、小微微信原生)验证了消息通道即入口:把本仓实战中的微信通道调度经验产品化为 `plugin-channel`(WeChat/Telegram/WhatsApp 适配器),让 agtpilot 实例"随处可达"而非 Destination App。
- LightVela(云端托管 Hermes)展示的 Agent Hosting 空位,与 `agthelm`(部署交付)方向吻合:agtpilot 的一键自托管部署模板可作为跨仓协作课题另行立项。

---

## 5. 风险与开放问题

1. **主动性的错误容忍不对称**:一次误打扰/误执行的信任损伤远大于十次正确建议的收益(Trust Flywheel 可反转)。对策已内建(restraint 层 + 永不绕过 Permission + Trust Incident 告警),但阈值需要真实使用数据校准,不能拍脑袋。
2. **九维状态模型的过度设计风险**:person/goal/commitment 的结构化 schema 若太重,agent-auto 抽取质量差会污染库(AOEP 教训的另一面)。对策:新类别第一期只开 user-manual/user-confirmed 写入,auto 抽取在 P0 验收后再放开。
3. **支付层的合规与安全**:plugin-wallet 触真实资金,P2 前需单独安全评审(威胁建模 + 限额默认值 + 审计全量落盘),不与本文其他分期捆绑。
4. **铁律 7 的修订权**:§4.4 第二步(受控自动恢复)属于架构铁律变更,须单独提案、单独评审,本文只记录路径不预设立场。
5. **文章信息的时效性**:文中产品动态(Muse 下载量、Instinct 融资、小微生物灰度等)为 2026-09/10 的媒体与分析师口径,引用作方向判断可,作数字引用需复核原始来源。

---

## 6. 一句话总结

文章的十层栈里,agtpilot 已经把最难、最不出彩、也最值钱的两层(Permission、Audit & Trust)做成了领先身位;接下来按 **P0 状态模型九维化 → P0.5 带 restraint 的主动性引擎 → P1 委托指标 → P1.5 异步等待原语 → P2 身份与钱包 → P3 记忆主权定位** 推进,就是在用开源的身位,拼同一张图的空白部分。
