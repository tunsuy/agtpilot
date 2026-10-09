# 研究文档:2026 Personal AI 浪潮对 agtpilot 的启发与路线图

> 状态:**研究结论 + 路线图提案**(2026-10-09;**§4 路线图已被 §5 批判性复核修订,以 §5.4 修订版为准**;开工前先读架构判读:§5.6(P1 Person 态试点设计输入)、§5.7(P0 wait_for/条件-唤醒底座设计输入);落地时按修订版分期拆任务)
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

## 4. 差距与路线图(初版提案)

> ⚠️ 本节为初版,**未做证据分级即把市场叙事直译成了工程计划**。负责人指正后已逐条批判复核,修订结论见 §5.4;两版冲突处以 §5.4 为准,本节保留作对照。

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

## 5. 批判性复核与路线图修订(2026-10-09,负责人指正后补充)

> 初版 §4 的问题:把一篇自媒体文章的市场叙事**直译**成了工程路线图,没有区分「可验证事实 / 媒体与分析师估算 / 作者叙事判断」,也没有逐项检查 agtpilot 的现实前置条件。本节先复核文章,再复核自己。

### 5.1 对文章的事实抽查

跨源检索验证了文章两个最吃重的事实支点:

- **Muse 存在且爆发属实**:Meta 官方 newsroom 发布公告(2026-09)、Reuters 报道其登顶下载榜、WSJ/CNN/CNBC 均有评测。✅
- **Instinct 融资属实**:Reuters(2026-09-28)报道 $1B 融资,TechCrunch 确认 Series C 估值 $10B,Fortune 有创始人专访。✅

其余产品动态(小微生物、Handy Bot、Dots 细节)未逐一验证,引用时按「媒体口径」对待。

### 5.2 文章没充分说、检索后发现的反面证据

1. **Meta 正在为 Muse 测试「human concierge」人工兜底**(Reuters,2026-09-22)——自主执行的实际完成率很可能显著低于宣传叙事,头部玩家都在用人力补洞。
2. **实测可靠性存疑**:CNN 上手测试质疑"替你做事"的实际成功率;CNBC(2026-10-07)判断"Meta 需要 Muse 超越 AI 新奇玩具";WSJ 评测标题即"既有用又吓人"。
3. **信任事故已在发生**:Inc. 记者实测发现 Muse 未经授权读取其私人消息——文章的 Trust 警告不是理论推演,是进行时的产品现实。
4. **估值泡沫信号**:Instinct 估值 $100M → $2.5B(8 月)→ $10B(9 月),两个月百倍。资本热度会系统性放大产品叙事,文章把这些数字当"方向正确"的证据,应打折使用。

**修正后的行情判断**:这波浪潮的真实瓶颈不在 Proactivity 或 Wallet 这些"上层想象力",而在 **Execution 的完成率与信任事故率**——恰是文章着墨相对少、而我们的治理体系(HITL/审计/回滚)最能发力的地方。这对 agtpilot 反而是利好:不追叙事热点,把"可靠、可审计、可回滚的长任务执行"做实,就是差异点。

### 5.3 文章方法论层面的弱点

- **十层栈是事后归纳**:把各家动作(Muse 的 VM、Cue 的钱包、小微的小程序)拼进一个"必然如此"的分层图,是分类法不是因果证明;哪些层真会普及、以什么顺序普及,文章没有给出可检验的判据。
- **叙事不可证伪处要隔离**:"终局是意图 OS""最终只剩一个 Primary Agent""Wallet 会像 Browser 一样成为标配"均为作者判断(C 级证据),不应直接转化为工程承诺。
- **五因子公式的乘法修辞**:`Context × Memory × Proactivity × Execution × Trust` 朗朗上口,但"任何一项为零整体为零"在工程上不成立(执行完成率高但主动性弱的产品照样有留存);公式当检查清单用可以,当优先级排序器不行。

### 5.4 路线图逐项复核与修订版

证据分级:**A** = 多源可验证事实/仓内既有工程结论;**B** = 单一媒体/分析师估算;**C** = 作者叙事判断。

| 初版条目 | 初版分期 | 复核结论 | 修订 |
|---|---|---|---|
| 记忆 4 类→9 维 | P0 | 两个缺陷:① 把 person/goal/commitment 建模成记忆 category,混淆「实体」与「记忆」,会 category 爆炸——实体应独立 store + 引用;② 九表 schema 出自文章举例(C 级),无工程验证,而"第一期只开人工写入"又砍掉了自动理解这个核心价值 | **缩小为最小试点(P1)**:只做 `goal` + `commitment` 两类实体(独立于 memory category,建在 user-store 旁,复用六维治理元数据),因为 planner 与 HITL 能直接消费它们、价值闭环最短;person/habit/constraint 推迟到出现真实用户需求或 auto 抽取质量可验证之后 |
| 主动性引擎 plugin-proactivity | P0.5 | **排序错误**。主动性的前提是有值得主动的个人事件源——现有连接器全是资讯/教研类(NewsNow/X/alphaXiv/HF),没有邮件读取、日历、通讯录;无米之炊做出来的只会是新闻推送式打扰,恰好犯文章警告的 false positive 错误,且无使用数据可校准 restraint | **降级 P2,设硬前置**:① 个人数据源连接器(邮件只读/日历)先行;② 有真实使用与接受率数据后再上线打扰判决。现阶段只做契约占位(§5.7.1 修订:统一事件总线,触发源分外因/内因/用户,不再是 cron/event/goal 三类并列),不写实现 |
| Delegation 十项指标 | P1 | 十项照抄文章;当前用户量下多数指标是"零的仪表盘";North Star"委托小时数/决策数"**无测量方法定义**,不可落地,属货物崇拜 | **缩为 4 项可具体测量(P1,随 observability 小改)**:mission 完成率、审批通过率(Confirmation→Execute)、人工干预率、记忆修正率。North Star 弃用,等指标有数据再议 |
| wait_for 异步等待原语 | P1.5 | **全场最扎实的一条**:不依赖文章叙事,解决的是仓内真实工程问题(异步 mission 的中断续跑),与铁律 7 兼容;§5.2 的 human-concierge 证据反而说明"长任务可控续跑"比"盲目自主推进"更贴近行业真实痛点 | **升级为第一优先(P0)**:先行立项,含 durable 挂起态 + 轻量 watcher + 条件满足后新建受控 loop 段;**设计约束见 §5.7.3——wait_for 是条件-唤醒底座的第一块切片,evaluator 契约与订阅持久化 schema 必须按底座标准设计,不得做成 mission 私有定时 hack** |
| plugin-wallet 原生支付 | P2 | **初版盲从了**。"Wallet 成标配"(C 级)是对重资本消费云产品的判断——托管基础设施、支付合规、风控、资损客服,开源自托管框架做原生支付集成等于把资金安全责任引入社区;Stripe SPT 生态成熟度也还是 B 级 | **砍掉原生 wallet**。保留「支付意图账本 + 审批抽象」(记录/限额/HITL/回滚把手,全部复用治理设施),执行委托给 browser 与既有工具;待 agentic payment 生态可验证后再评估 |
| Agent Identity(自有 email/phone/wallet) | P2 | Cue 式"Agent 自有身份"依赖厂商批量供给真实身份资源,OSS 不可复制 | **缩小(P1 小项)**:委托发件身份——每 Agent 实例专属发件地址+署名+可代表范围声明,挂到权限纪元(撤销即冻结),基于 email-smtp 小改 |
| 记忆主权/可携带性定位 + 互操作标准 | P3 | 叙事动听但空心:开源自托管本身就隐含主权,导出/导入只是一个 feature 而非护城河;"标准提案"无标准化组织承接 | **收缩为务实动作(P1 小项)**:User Model 完整导出/导入(结构化 JSON+治理元数据+审计台账)+ schema 文档化。标准提案不做 |
| plugin-channel(微信/Telegram 适配) | P3 | 方向有价值(本仓调度会话即微信通道的实战验证),但**平台 ToS 风险初版未标注**:微信对自动化官方受限,产品化承诺有风险 | **保留 P3,补风险标注**:先做通道适配层抽象(以本仓外部 harness 经验为参照),Telegram 等政策宽松通道先行,微信侧仅做个人自托管用途、不宣传 |
| Primary + Specialist 多 Agent(router 扩展) | P2/P3 | "最终只剩一个 Primary Agent"是 C 级推测;sub-agent 编排工程成本高、当前无用户侧需求证据 | **推迟,不排期**:router 保持模型分级路由,预留 specialist 路由接口即可 |

**修订后执行顺序**:`P0 wait_for 异步原语` → `P1 三小项(goal/commitment 实体试点、4 项委托指标、委托发件身份 + User Model 导出导入)` → `P2 主动性引擎(待个人数据源与使用数据就绪)` → `P3 通道抽象(带 ToS 风险标注)`。支付只剩账本抽象,随 P1 治理设施顺手做。

### 5.5 流程教训(对本文档自身)

1. 外部文章转化为路线图前,必须做**证据分级**(A/B/C)并对吃重事实做跨源抽查——本次抽查证实了文章事实底盘,但也挖出了文章没说的反面证据(human concierge 兜底、隐私事故、估值泡沫),这些直接改变了优先级排序。
2. 每个路线图条目要过**现实前置条件检查**(有没有事件源?有没有用户数据?有没有合规负担?),而不是"文章说重要所以我们做"。
3. 行业热度高时,**反向证据的检索优先级应高于顺向证据**。

### 5.6 「状态中心 = Person」的架构判读(2026-10-09 与负责人讨论后补充)

负责人对文章"状态中心从 Task 转成 Person"的判断最感兴趣。本节记录独立判读,作为 §5.4 中 P1 试点(goal/commitment 实体)开工时的设计输入。

#### 5.6.1 为什么这个方向必然成立

它是持久化工程的自然推论,不是新发明:**任务态的生命周期 = 任务,人态的生命周期 = 人**。一旦系统跨会话持久(agtpilot 的 checkpoint + userId 分域已满足),durable state 的天然主键就是 userId 而非 taskId。所谓"状态中心迁移",工程实质是「持久状态主键从 taskId 换成 userId,且 schema 变富」。Today 的 living memory、文章的 user model,都是同一件事的产品化包装。

#### 5.6.2 真正的难点是「写纪律」,不是 schema

核心在**错误的不对称性**:任务态写错是一次性损失;人态写错是持久的、复利的污染——一条自动抽取错误的"她不吃海鲜"会静默改写之后几个月所有相关决策,且用户难以察觉。因此 Person 中心的前置条件是:

1. **写入必须走治理弧**:来源/权威/置信度/可撤销——已落地的六维元数据 + 权限纪元 + 回退弧(治理 P0/P1)恰好是这条保险带。**没有治理的 Person 中心是危险品;治理是前置条件,不是附加功能。**
2. **冲突与过时必须有机制**:新观察与旧信念的裁决规则;人不删除记忆就会过时(AOEP"扁平事实库比不存还差"的教训在人态上加倍成立)。
3. **用户必须可读可改**:记忆可查看/编辑/删除,否则 trust 崩塌(Today 把它当核心能力是对的;web 端记忆管理页需对齐)。

这也是 agtpilot 相对这波消费级产品的真实身位:Person 中心的瓶颈是治理与回写纪律,不是模型能力,而治理恰是我们投入最重、行业最薄弱的层。

#### 5.6.3 双层状态,拒绝 god object

不主张"一切状态都挂到人身上"。合理结构是**双层状态 + 一条受控回写弧**:

```
Task 态(快变、可弃、mission 状态机)
        │  任务完成时:教训/偏好/承诺 回写(经验证、带来源、走治理弧)
        ▼
Person 态(慢变、高权威、受治理:goal/commitment/constraint/…)
```

没有回写弧,记忆只能靠用户手输,永远长不厚——文章说的飞轮(执行→反馈→更懂你)真正的机械结构就是这条回写弧,而不是"多存资料"。

#### 5.6.4 schema 由消费方倒推,不先建九表博物馆

Person 态只有在**有代码读它**时才成立。消费方倒推:

| 消费方 | 需要读的切片 | 带来的体验变化 |
|---|---|---|
| planner | goals(时间弧/里程碑)+ constraints(硬约束) | "帮我订周五餐厅"从 instruction following 变成 intent understanding |
| HITL/审批 | commitments + 委托包(哪些事可自动批) | 审批从"每次都问"进化为"按用户一贯决定给出建议默认值" |
| 主动性引擎(P2) | events × goals/commitments(截止日、里程碑触发) | 主动性的"料",restraint 判决的依据 |

结论(强化 §5.4):**先建一条消费链路(planner 读 goal/constraint)+ 一条回写弧,再谈扩维**。schema 跟着消费方长,不跟着文章的表格长。

#### 5.6.5 文章没碰、agtpilot 需提前想的两个暗面

1. **安全:Person model 是全系统价值最高的靶子**。一次注入读到它 = 整个用户画像外泄;一次污染写入 = 持久行为后门(比劫持单个任务严重一个量级)。需要独立威胁模型:任务只读所需切片(最小化)、写入分级授权、完整性审计。
2. **第三方影子画像**:relationship memory 意味着人态里存着"别人"——伴侣的饮食、朋友的生日,这些人从未同意被建模。person 实体引用真人时必须有自己的 scope 与删除语义(跨上下文不泄露、可整体移除)。文章完全未提;开源产品反而应该先做对。

#### 5.6.6 一句话判读

方向认同,且对 agtpilot 格外成立(瓶颈=治理,治理=我们的身位);警惕两个误区——把它当数据建模口号(先建大全 schema)、把它当浪漫叙事(忽视错误复利与影子画像)。正确姿势:**双层状态 + 受治理回写弧 + 消费方倒推 schema**,从 goal/commitment 一条链路做起。

### 5.7 触发方式与持久运行的架构判读(2026-10-09 与负责人讨论后补充)

负责人对文章另两个判断——「触发从 Prompt-only 走向 Prompt+Event+Goal」与「持久运行(Persistent Runtime)」——要求独立判读。本节结论直接作为 **P0 wait_for 原语的设计输入**。

#### 5.7.1 触发方式:成本分配问题,不是判决问题

1. **本质是成本分配**:Prompt 驱动 = 用户付注意力成本(得自己记得来问);Event/Goal 驱动 = 系统付推理成本 + 用户付打扰成本。每次触发都是一次模型调用,Instinct 的延迟/漏任务(§5.2 之外文章也承认的基础设施短板)证明成本侧真实存在。触发系统首先是经济学:单次触发成本 vs 价值密度。
2. **难点在事件源,不在判决**:触发质量上限由事件源决定——push 型(webhook,实时便宜但靠平台开放度)、poll 型(通用但贵,延迟-成本天然 trade-off)、infer 型(agent 定期自查状态找事做,最贵且最易 false positive)。工程失败多发生在事件源侧:漏报/重复/乱序。**去重幂等(同一事件不触发两次)与事件持久化(重启不丢)是必需品——即触发队列本身必须是 durable state 的一部分**(与持久运行的第一个交叉点)。
3. **建模修正:不需要三类并列触发**。Goal 驱动是 Event 的特例(goal + 时间/条件 = "里程碑临近"事件)。真正的分类维度是触发者来源:**外因**(外部世界事件)/ **内因**(Person 态自身变化:截止日、里程碑、衰减)/ **用户**(prompt)。统一为一条事件总线 + 订阅语义,替代 §4.2 初版 cron/event/goal 三类并列契约——更简单也更正确。
4. **restraint 别学推荐系统**:推荐系统优化 CTR 靠海量数据与 A/B 设施,个人 Agent 没有这个奢侈。现实落地是「打扰预算制」:
   - 硬预算:每天最多 N 次强打扰(用户可配,默认保守);
   - 三级通道:强打扰(push/消息)/ 弱打扰(app 内置顶待处理卡片)/ 静默(只记录);
   - **日报聚合成被低估的默认形态**:多数建议走弱打扰或聚合进每日摘要,把 N 次打扰变 1 次——"主动"不等于"发推送";
   - 每次强打扰消耗信任额度,误报双倍偿还(§5.6.2 错误不对称性的打扰版);接受/拒绝/忽略三态回流作校准信号。
5. **反直觉结论:引擎便宜,数据源才是护城河**。对框架型用户 cron+webhook 早已够用;消费级主动性的"魔法"全部来自接入了用户的邮件/日历/通讯录(小微的强势不在引擎,在它坐在微信里——消息即事件)。推论:**个人数据源连接器的投入优先级 > 触发引擎本身**,再次印证 §5.4 将主动性引擎降为 P2 且设数据源硬前置的修订。

#### 5.7.2 持久运行:本质是 durable state 的调度,不是进程永活

1. **拆穿包装**:治理文档引用的判据依然成立——always-on 的判据是「t 时刻行为依赖 t 之前积累的状态」。工程形态三种:
   - 真常驻 loop(每用户一个 loop 一直跑):最贵,而"等邮件"根本不需要算力;
   - **durable state + 事件唤醒**(状态落盘、轻量 watcher、条件满足才起新 loop 段):Temporal/durable-workflow 模式,成本随"实际发生的事"而非"时间流逝",业界已验证;
   - 轮询唤醒:最简单,延迟=轮询间隔。
   正确答案是第二种。Muse/Dots 的"云电脑常驻"是消费级包装 + 安全边界(VM 隔离),不代表 agent loop 在 7×24 烧 token。文章引 Barclays"免费 Personal AI 成本≈ChatGPT 十倍"的估算,大头即常驻算力;agtpilot 走第二种形态,成本随委托任务数走,**自托管叙事才在经济上成立**。
2. **三个真正的工程硬点**(比"开个云 VM"难得多):
   - **恢复的正确性**:checkpoint 不仅要记"做到哪",还要记"什么没确认"(in-flight 工具调用、未消费事件)。最危险是副作用窗口:邮件已发出、记录未落盘时崩溃 → 恢复时面临"重发还是不重发"。没有幂等键与回滚把手(治理 I5),持久运行只是**事故放大器**(重复发邮件/重复下单)。
   - **时间的 durable 语义**:三天后跟进、下月续订——定时/延迟状态必须跨重启存活(定时表落盘是底线);时区/DST 是产品化阶段才会集中踩的坑。
   - **环境漂移**:跨天任务的外部世界会变(页面改版、登录态失效、权限被撤)。设计原则:**每次恢复的第一步是 re-admit(重验权限纪元 + 预算 + 约束),不是继续执行**。权限纪元(治理 P1)在此直接兑现价值。
3. **铁律 7 的分级和解**(细化 §4.4 第二步):"受控自动恢复"不是全有全无开关,按 **actionability 分级**(六维元数据现成字段):纯信息段(读取/汇总/研究)可自动恢复;副作用段(外发/支付/写外部系统)必须 re-admit + HITL。治理投入第三次被直接复用(前两次:回写弧、re-admit 纪元校验)。
4. **agtpilot 现实选型——watcher 谁来当**:自托管语境 = 用户自己的机器要常开(这正是 LightVela 收钱的部署痛点)。选型倾向:**web server 进程兼任 watcher**(已有常驻 web app,零新增部署单元,自托管叙事保持轻),不建独立 daemon、不引入外部调度依赖;移动端(capacitor)**绝不承担**持久运行载体。

#### 5.7.3 交叉洞察:统一为「条件-唤醒底座」

本轮讨论最有价值的架构判断:**持久运行的"唤醒"与触发方式的"触发"是同一个机制**——本质都是「durable state 在什么条件下唤起 agent」。wait_for(condition) 是微观形态,事件总线是宏观形态,goal 里程碑是语义形态。

因此它们不应是两套系统,而是一个**条件-唤醒底座**:

```
条件求值器注册表(condition evaluators,可插拔)
        +
持久化订阅表(durable subscriptions:谁在等什么条件,跨重启存活)
        +
唤醒即起「受控新 loop 段」(不是重启 in-flight loop,兼容铁律 7)
        +
re-admit 门(纪元/预算/约束重验,副作用段强制 HITL)
```

**推论(P0 设计约束)**:wait_for 原语就是这个底座的第一块切片。P0 实现时必须把条件求值接口(evaluator 契约 + 订阅持久化 schema)按底座标准设计,则未来事件源接入(§5.7.1)与主动性引擎(P2)都是底座的消费者——不白做、不推翻重来。反之,若 P0 把 wait_for 做成 mission 内部的私有定时 hack,P2 时将付出重写代价。

#### 5.7.4 一句话判读

触发:方向成立,但引擎便宜、数据源是护城河,restraint 靠打扰预算+分级通道+日报聚合落地,建模统一为外因/内因/用户的事件总线。持久运行:本质是 durable state 调度而非进程永活,三个硬点是恢复正确性、durable 时间、环境漂移(re-admit);两者共用一个条件-唤醒底座,**wait_for(P0)是底座第一块切片,接口按底座标准设计**。

---

## 6. 风险与开放问题

1. **主动性的错误容忍不对称**:一次误打扰/误执行的信任损伤远大于十次正确建议的收益(Trust Flywheel 可反转)。对策已内建(restraint 层 + 永不绕过 Permission + Trust Incident 告警),但阈值需要真实使用数据校准,不能拍脑袋。
2. **状态模型的过度设计风险**:person/goal/commitment 的结构化 schema 若太重,agent-auto 抽取质量差会污染库(AOEP 教训的另一面)。§5.4 已据此把九维缩为 goal/commitment 最小试点;试点期只开 user-manual/user-confirmed 写入,auto 抽取在验收后再放开。
3. **支付相关的安全边界**:原生 wallet 已被 §5.4 砍掉,但「支付意图账本 + 审批抽象」仍会触碰资金语义——上线前需单独安全评审(威胁建模 + 限额默认值 + 审计全量落盘),不与其他分期捆绑。
4. **铁律 7 的修订权**:§4.4 第二步 / §5.7.2 的「受控自动恢复」(按 actionability 分级)属于架构铁律变更,须单独提案、单独评审,本文只记录路径与分级思路,不预设立场。
5. **文章信息的时效性**:文中产品动态(Muse 下载量、Instinct 融资、小微生物灰度等)为 2026-09/10 的媒体与分析师口径,引用作方向判断可,作数字引用需复核原始来源。

---

## 7. 一句话总结(修订版)

文章的事实底盘经跨源抽查成立,但其叙事层(意图 OS、Wallet 标配、Primary Agent 唯一)是 C 级判断,不能直接转化为工程承诺;行业真实瓶颈在**执行完成率与信任事故率**(头部玩家已在用人工兜底),这恰是 agtpilot 治理体系的发力点。修订后的打法:**先把 wait_for 长任务可控续跑做实(P0,按 §5.7.3 以「条件-唤醒底座第一块切片」的标准设计接口),再以小步补齐 goal/commitment 实体、4 项委托指标、委托发件身份与 User Model 可携带性(P1),主动性引擎等个人数据源和使用数据就绪再上(P2,作为底座消费者)**——不追叙事热点,把"可靠、可审计、可回滚"做成开源身位的差异化。
