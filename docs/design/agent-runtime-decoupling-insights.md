# 研究文档:Agent 与 Sandbox 解耦——Tetral 架构判读、业界实践对照与 agtpilot 取舍

> 状态:**研究结论 + 设计输入提案**(2026-10-10;§6 行动建议按证据分级收敛过,开工前先读 §3 批判性复核)
> 来源文章:人工智能前线《别再给每个 Agent 塞一个 Sandbox:下一代 Agent 架构正在重写》(https://mp.weixin.qq.com/s/0GOYMWUJt20Auol5dRshXg)——Tetral 作者(Anoma → Tetral)自述,MIT 开源,运行于个人 k3s 集群的 alpha
> 涉及模块:`packages/core/src/orchestrator.ts`(checkpoint/审批门)、`packages/core/src/compaction.ts`、`packages/core/src/sandbox-fence.ts`、`packages/plugin-sandbox`、`packages/plugin-model`、apps/web 持久化层(user-store / mission rehydrate / governance-bus)
> 关联文档:`docs/design/sandbox-control-hardening.md`(凭据托管/端点绑定,本文多处对照)、`docs/design/persistent-state-governance.md`(治理六维/五不变量)、`docs/design/eval-hillclimb-framework.md`(轨迹→评测通道)、`docs/design/personal-ai-landscape-insights.md`(§5 批判性复核方法论,本文沿用其证据分级)

---

## 1. 文章核心判断(浓缩)

1. **扩展单位错位**:过去一年主流做法是「一个 Agent 住一个 Sandbox」(Claude Code/Codex 本地模式直接搬进 E2B),于是扩 Agent = 扩 Sandbox。作者连续两个产品(Anoma→Tetral)后判断:这是在扩展错误的东西——真正要扩的是「长期运行、可恢复、跨设备、可独立调度的 Agent 系统」。
2. **核心命题:Computer 是 Agent 调用的资源,不是 Agent 居住的地方**。Agent Runtime 是稳定共享的;Sandbox 是隔离、突发、一次性的。两者扩展曲线不同,绑定扩容系统天然变重。Linux/Windows/macOS 不是不同种类的 Agent,只是不同形式的计算资源。
3. **Runtime 只剩一件事:计算下一步**。所有生命周期/所有权/扩展模式不同的职责全部外置:Gateway(模型协议+凭证,Key 永不进 Runtime/Sandbox)、PostgreSQL(唯一事实源)、Bridge(状态边界+事务+Session 所有权校验)、Queue(Outbox 式可靠投递:租约/重试/死信)、Sandbox Service(计算机生命周期,懒分配+复用+共享激活)、Public API + Event Stream(产品接口)。
4. **先记录,再执行(WAL)**:任何推进状态或产生外部副作用的动作,先提交声明(稳定 ID = 幂等键)再真正执行;Runtime 中途消失,新 Runtime 从已提交事实恢复,不靠猜「没执行/执行中/执行完没记录」。重试同 ID 返回既有结果,同 ID 不同内容直接拒绝。
5. **Session Log ≠ 聊天记录**:完整逻辑执行记录(输入/模型请求边界/工具调用/结果/中断/结束);模型加载的是独立的 Context Projection(压缩摘要),原始记录完整保留、未来可搜索——「不要求一份 Summary 永远承载整个过去」。
6. **三层状态模型**:Workspace(长期资源:文件/Memory/仓库/凭证/Agent Version)→ Session(一个完整工作过程)→ Thread(Session 内独立执行路径,Root + Child)。Thread 扩同一任务的并行,Session 扩不同任务;Subagent 的 spawn 也必须走持久化(同事务提交 child thread/关系/初始 context/inbox/delivery job,重试幂等)。
7. **凭证隔离 ≠ 授权**:Credential Isolation 是能力访问边界(Gateway 验证 Runtime 的 K8s 身份 + Session 所有权后注入凭证;缺失/撤销即失败,禁止静默回退);Authorization 是动作批准边界——**不能让提出操作的 Agent 同时成为自己操作是否安全的最终裁判**。MCP 同款:Runtime 只见工具 schema,Connector 持凭证。
8. **授权链的保守设计**:高风险调用 → Tool Gate 产出「提案」→ 独立 Reviewer Thread 审核(被审内容一律视为**证据而非指令**,防 prompt injection;输出格式异常 = 审核失败,绝不默认放行)→ 审核结果先落库 → Runtime 二次过 Gate 重验证 → 才提交执行进 Queue。**审核结果本身不是权限,被系统记录并重新验证后才是**。提案产生后授权完成前 Runtime 崩溃 → 提案作废,宁可牺牲恢复能力也不让孤儿授权生效。
9. **多 Agent 不自动等于更好**:更多 Agent = 更多 token/消息/噪声,共享 coding swarm 越大可合并比例反而越低。Tetral 下注:先对抗式评审(主动挑战结论与证据)再合并;协作以 **Accepted Artifact 为中心**而非 Conversation 为中心——只有被正式接纳的产物才改变共同事实(同软件工程:讨论无限,进主干的只有过审 commit)。
10. **轨迹反哺评测/训练**:每次 Agent 行为都有完整轨迹 → 被拒的 Tool Call、被推翻的判断、人工修正都是 Eval 数据;前提是 Provenance 完整、私有数据清理、人类明确标注成败。但外部副作用安全**不能只靠模型「学会安全」**,仍需确定性 Policy/验证/独立 Review/人工升级。
11. **瓶颈向外围迁移**:模型越强,外围(Edit/Build/Test 工具链、Sandbox 调度、Session Trace 存储)越先成为短板——Bun 从 Zig 转 Rust、TypeScript 原生 Go 化(~10x)都是为此。完整 Sandbox 不该是所有操作的默认边界:普通文件访问也许只要 VFS,小任务只要轻量容器,强隔离不可信代码才要 Sandbox,未来可能是 Actor 式更轻的计算原语。
12. **Agent 成为可寻址参与者**:身份从客户端/电脑中解耦后,Agent 跨界面持续存在(Terminal/浏览器/手机/GitHub),关客户端不等于结束 Session;身份带来责任链(操作可溯源到 Agent Version/Session/Thread/Policy/Review),并最终与「有限、可追踪、可撤销的授权」绑定——用户/组织仍是 Principal。

---

## 2. 业界对照:孤例还是共识?

Tetral 只是个人 k3s 上的 alpha(文章 §36 自认,且坦白 Runtime Placement/Backpressure/跨节点恢复/优雅 Drain 四个未解问题)。但它的设计几乎每一条都能在 2026 年的业界实践里找到独立印证——**方向是共识,实现是孤例**:

### 2.1 云厂商同构:AWS Bedrock AgentCore

AgentCore 的部件分解与 Tetral 几乎一一对应:Runtime(每 Session 独立 microVM,会话结束即销毁)、**Gateway**(MCP 工具统一接入+凭证)、**Identity**(身份与凭证托管)、**Memory**(状态外置)、Code Interpreter(沙箱即服务)、Browser 工具;2026-03 增加托管 Session Storage(文件系统状态跨会话持久)。计算与状态/凭证/身份分家,大厂已经产品化。(https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html)

### 2.2 Durable Execution 引擎群:WAL 原则的工业化

「先记录再执行 + 幂等键 + 确定性恢复」不是文章发明,是 durable execution 赛道的方法论本体:Temporal(https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai)、Cloudflare Workflows GA 及 2026-05 的 Dynamic Workflows(https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/ 、https://www.infoq.com/news/2026/05/cloudflare-dynamic-workflows/)、Restate(https://restate.dev/what-is-durable-execution)、DBOS(https://www.dbos.dev/blog/durable-execution-crashproof-ai-agents)、Azure Durable Task for AI Agents(https://learn.microsoft.com/en-us/azure/durable-task/sdks/durable-task-for-ai-agents)、LangGraph checkpointing/interrupt。2026 年的共性组件清单已收敛为:**execution journal、幂等工具边界、版本化 prompt/tool、durable human approval、恢复演练**(https://zylos.ai/research/2026-04-24-durable-execution-agent-runtimes/ ;IEEE 已有模式论文 https://ieeexplore.ieee.org/document/11638700/ ;横向对比 https://upstash.com/blog/durable-workflow-engines-compared-every-major-option-in-2026)。文章 §8 的「声明→提交→执行」就是 execution journal 的 Agent 方言;durable human approval 对应 §8 的审批落库重验证。

### 2.3 开源同行:OpenHands 的事件溯源(及其反面证据)

OpenHands 从第一天就把 **Event Stream 当事实源**(arXiv 2407.16741),SDK 重构后明确「event-sourced state model + deterministic replay」(arXiv 2511.03690,https://docs.openhands.dev/sdk/arch/overview)——与文章 §10「Session Log 是完整逻辑执行记录」同构。**反面证据**:其 issue #4671(https://github.com/OpenHands/software-agent-sdk/issues/4671)显示单把 FIFOLock 同时守护 event log/agent/执行状态/secrets/stats,正在被迫拆分——「事件日志 = 事实源」会带来真实的工程耦合成本,不是免费午餐。

### 2.4 上下文工程派:Manus 的互补视角

Manus(https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)从成本/延迟方向得到同构结论:围绕 KV-cache 设计、工具**遮蔽而非移除**(移除会毁缓存前缀)、**文件系统即上下文**(旧上下文外置到文件系统按需读回,而非截断)。与文章 §10 的 Context Projection 互补:一个为了可审计/可恢复保留全量原始记录,一个为了 cache 命中率稳定模型可见上下文——**两者都拒绝「把所有东西塞进上下文窗口」,原始记录与模型投影分离是共识**。

### 2.5 更轻的计算原语:Actor 回归

文章 §33 的「比 Sandbox 更轻的原语」有现成注脚:Cloudflare Durable Objects 被从业者直接称为「为 Agent 而生」的 actor 式有状态计算(https://calv.info/durable-objects-are-made-for-agents),Orleans 式 virtual actor(可寻址/可睡眠/可唤醒/无需整台电脑)是同一思想的老祖宗。沙箱商业市场(E2B/Daytona/Modal/Fly,https://northflank.com/blog/top-ai-agent-runtime-tools)则印证「Computer 按需租用」已基础设施化。

### 2.6 小结

| 文章主张 | 业界独立印证 | 证据级别 |
|---|---|---|
| 凭证/身份与执行分家(Gateway) | AgentCore Identity/Gateway、Tetral、OpenShell(我们已借鉴过) | **A** |
| 先记录再执行 + 幂等恢复 | Temporal/Cloudflare/Restate/DBOS/Azure/LangGraph 全赛道 | **A** |
| 原始日志与模型上下文分离 | OpenHands 事件溯源、Manus 文件系统即上下文 | **A** |
| Sandbox 懒分配、按需资源 | AgentCore microVM per session、E2B/Daytona 商业模式 | **A** |
| 授权在外部边界、Reviewer 与内容分离 | durable human approval 模式、Anthropic 一贯的 HITL 主张 | **A**(原则)/ **B**(Reviewer Thread 具体形态,Tetral 独有) |
| 对抗式评审 + Artifact 为中心 | 多 Agent 编码实践的共同教训(swarm 越大合并率越低) | **B** |
| RoboBun/Raft/Claude Tag 代表的「可寻址 Agent」趋势 | 文章列举,未跨源验证 | **B** |
| 「三个核心下注」/MCP 成 cloud-native 能力主接口/Agent System 即产品本体 | 作者叙事判断 | **C** |
| Bun Zig→Rust、TS Go 化 ~10x 的动因归述 | 公开事实存在,动因归述是作者转述 | **B** |

---

## 3. 批判性复核(沿用 insights §5.5 方法论)

1. **立场偏差要标注**:作者是云平台产品作者(卖 Hosted Agent System Service),「CLI 不该承担云端能力」「Agent 是 Cloud Native 的」等判断服务于其产品叙事。对**个人自托管定位**的 agtpilot,这些判断只能当参考系,不能当需求。
2. **文章自己承认的未解题**:Runtime Placement 无容量考量、Backpressure 未联动、跨节点恢复未验证、发版无法优雅 Drain(正在执行的 Turn 会中断)——**它批评的「in-flight 中断」问题,自己也没解决**。这和 agtpilot 铁律 7 的诚实声明(in-flight loop 不自动重启)处于同一水平线上,谁也没资格居高临下。
3. **WAL 全量化的成本**:每个 tool call 前多一次「声明提交」往返(Bridge→PG),延迟与复杂度真实存在;OpenHands #4671 是前车之鉴。小规模系统全量照搬 = 用分布式系统的税单买单机系统用不上的保险。
4. **五件套(Gateway/Bridge/Queue/PG/Sandbox Service)是多租户答案**:文章 §36 自己说「小型部署应能把多个逻辑服务合并到更少进程」。对 agtpilot(单机、个位数用户),正确形态是**逻辑分离、进程合一**——边界留在契约层,不拆进程。这也与负责人此前拍板(不引常驻 daemon/独立进程,见 sandbox-control-hardening §2)一致。
5. **不可证伪处隔离**:「未来真正需要配置的是完整 Agent System 而非模型」「Actor 原语会替代部分 Sandbox」是 C 级叙事,不转化为工程承诺,只做方向观察。

---

## 4. agtpilot 逐条对照

| 文章机制 | Tetral 形态 | agtpilot 现状 | 判定 |
|---|---|---|---|
| Agent 不住沙箱 | Runtime 与 Sandbox Service 拆分 | agent loop 在进程内;sandbox 只是插件资源(local 围栏/bwrap/E2B 三级) | ✅ **天然同构**,从未犯「Agent 住沙箱」的错 |
| 凭证 Gateway | Gateway 持 Key,验 Runtime K8s 身份+Session 所有权 | sandbox-control-hardening:Key 留 web 进程(user-store 密文)、子进程零 Key、credentialRef 注入、凭据-端点绑定、sandbox_http_request 宿主代发 | ✅ 同构(与 OpenShell 同源)。差距:同进程内**无调用方身份二方验证**(威胁模型已诚实声明防不了插件被劫持) |
| 状态源 + Bridge | PG 事实源,Bridge 管事务/所有权/顺序 | checkpoint jsonl 落盘 + user-store + mission rehydrate;无事务边界与所有权校验 | ⚠️ 有雏形无 Bridge;单机 jsonl 够用,**所有权校验是多用户并发才需要的东西** |
| Queue 可靠投递 | Outbox + 租约 + 重试 + 死信 | 无(进程内直调);web 靠启动僵尸清扫兜底 | ❌ 缺,但单机规模可接受;引入即过度工程 |
| **先记录再执行(WAL)** | 声明→提交→执行,幂等键 | **先执行后记录**(每步 checkpoint);崩溃后分不清副作用状态 → 铁律 7:in-flight 不自动重启 | ❌ **最大真实差距**,且有小步解法(§5.2) |
| Session Log ≠ Context Projection | 全量执行记录 + 模型投影分离 | checkpoint(原始逐步落盘)vs compaction(摘要替换旧消息) | ✅ 同构;差距:原始记录**不可搜索**(未接召回,insights §4.1 已列) |
| Workspace/Session/Thread 三层 | Child Thread 并行执行路径 | 无 subagent/子线程;planner 看板是任务分解展示,不是并行执行 | ❌ 缺;insights §5.4 已裁定多 Agent「推迟不排期」,本文维持 |
| Subagent 持久化 spawn | 同事务提交+幂等重试 | 无 | ❌ 同上,随 Thread 概念一起搁置 |
| 授权外部边界 | Tool Gate→独立 Reviewer Thread→落库→二次 Gate | HITL 审批门(dangerLevel)+ 权限纪元(governance P1);但审批与插件同进程、**审批决定不落盘不重验**、无 Reviewer 内容隔离 | ⚠️ 落后半步;两个可吸收切片(§5.3) |
| 对抗式评审 + Artifact 为中心 | 挑战结论与证据后才 merge | 无 Agent 间评审;但 house 工作流(设计文档评审→commit→人工拍板)与 eval-hillclimb 的 holdout 独立裁决精神同构 | ⚠️ 人工版已有,Agent 版随 Thread 搁置 |
| 轨迹 → Eval 数据 | Provenance + 脱敏 + 人工标注 | eval-hillclimb-framework P1「prod 翻车 case 导入」通道,前置条件(脱敏治理评审)与其一致 | ✅ 已有设计,互为印证 |
| 计算资源懒分配 | Lazy Allocation + 共享冷启动 | browser headless 按需、sandbox 不调用不占资源、工具按阈值路由挂载 | ✅ 天然满足 |
| 工具链瓶颈前置 | Build/Test 吞吐会先于模型成为短板 | eval --replay(零 API 费确定性回归)正是为此准备的 CI 门禁 | ✅ 对齐 |
| 可寻址身份/责任链 | Agent Identity + 有限授权 | 无 Agent 自有身份(insights §5.4 已缩为「委托发件身份」小项);责任链由审计日志+权限纪元覆盖 | ⚠️ 责任链**不落后**(治理是差异化强项),身份按既有修订走 |

**总评**:14 项中 6 项天然同构或已有设计、4 项缺但属「多租户才需要」(单机定位下不补)、2 项半落后但有低成本切片、真正的大差距只有 **WAL** 一项。这篇文章对 agtpilot 的价值不是「架构要重做」,而是**验证了既有方向 + 精确暴露了持久化语义的短板**。

---

## 5. 我的独立思考(文章没写透的部分)

### 5.1 尺度决定形态:契约是未来的拆分缝

Tetral 五件套是多租户云的正确答案;单机的正确答案是**逻辑分离、进程合一**。关键洞察:agtpilot 的铁律 1/3(内核零插件知识、跨服务走契约)已经预埋了所有拆分缝——`ModelGateway` 契约 ≈ Gateway 的接口化,`ToolSession` ≈ 身份锚点,checkpoint 事件 ≈ 状态外置的挂钩。**今天不拆进程,但绝不绕过契约;未来若真上云,沿契约拆即可,不需要推倒重来**。这是比「照抄架构图」重要得多的动作(建议固化进 ARCHITECTURE.md,见 §6 建议 4)。

### 5.2 WAL 的最小可行切片:工具意图日志(不需要 PG 和 Bridge)

「先记录再执行」的 80% 收益可以用 20% 的成本拿到:

- orchestrator 的工具执行包装处,执行前先 append 一条 **intent 记录**(jsonl:`{toolCallId, toolName, argsDigest, ts}`;toolCallId 天然是幂等键,AI SDK 已保证唯一);执行完成后 append **result 记录**;
- 恢复语义:重启后扫描——有 intent 无 result = **悬空副作用**。对 `compensation.kind` 可回滚的工具,提示回滚把手;不可回滚或拿不准的,**显式交人确认,绝不自动重试**(与文章 §22 哲学一致:孤儿动作宁死不活;也与铁律 7 兼容:不是自动重启 loop,是把「标记中断」升级为「精确知道断在哪个副作用上」);
- 零新依赖(jsonl 与既有 checkpoint/user-store 审计同款),纯增量;
- **与 insights §5.4 修订版 P0 的 wait_for 是同一底座**:两者都需要「durable 状态声明 + 受控恢复」,应合并设计(共享 intent/journal schema),避免各造一套——这正是 insights §5.7.3「不得做成私有 hack」警告的适用场景。

### 5.3 Reviewer 隔离的可吸收精髓:不是「另一个 Agent」,是「证据与指令分离」+「审批落盘重验」

Tetral 的独立 Reviewer Thread 对单机 agtpilot 过重,但两个原则可以低成本落地:

1. **审批决定持久化 + 执行前重验证**:现在审批结果活在内存 promise 里,重启即蒸发;改为审批决定落盘(挂治理总线既有通道),工具执行前重验「该 toolCallId 的审批仍然有效且属于当前纪元」——权限纪元失效即审批失效,孤儿审批作废。纯 web 层 + orchestrator 小改;
2. **证据/指令分离写进审批 UI 契约**:审批卡展示的工具参数、文件内容、网页摘录一律标注为「待审证据」,未来若引入 LLM 预审(house 场景:微信通道里先由小模型给风险摘要),其 policy 提示词与被审内容必须分通道注入,输出格式异常 = 拒绝而非放行。这条现在只是 UI/提示词纪律,成本≈0,但决定了未来 LLM Reviewer 能不能安全上马。

### 5.4 「评测与治理是同一份资产」不是巧合

文章 §29(轨迹→Eval 数据)与我们刚立项的 eval-hillclimb 框架(P1 prod 导入通道)互为独立印证:**完整执行记录既是审计资产(治理)又是评测资产(eval)**,前提三件套(Provenance 完整、私有数据清理、人类标注成败)与治理文档的审计日志/脱敏/权威分级完全对得上。这提示一个架构纪律:checkpoint/intent 日志的 schema 设计要**同时满足**治理回放与 eval 导入两个消费方,不要为 eval 另造一套 transcript 格式。

### 5.5 文章最被低估的一节:§31 工具链瓶颈

「Agent 写代码变快后,Edit/Build/Test 吞吐先到极限」对 agtpilot 是切身问题:eval 全量跑真实模型一轮数分钟起步、web 集成路径测试更慢。对策已埋在设计里(--replay 零成本 CI + 阈值路由降 token),但**测量缺失**:建议在 observability 里给「验证类操作耗时」(测试/构建/lint)单独埋点,瓶颈要能被看见才能被治理。

---

## 6. 行动建议(证据分级收敛后)

| # | 建议 | 分期 | 证据/前置 |
|---|---|---|---|
| 1 | **工具意图日志(WAL 切片)**:intent/result 双记录 + 悬空副作用检测 + 保守恢复;与 wait_for 底座**合并设计**(共享 journal schema) | P0,与 insights §5.4 wait_for 同批立项 | A 级原则(durable execution 赛道共识)+ 仓内真实债(铁律 7 的根因);§5.2 |
| 2 | **审批决定落盘 + 执行前重验 + 纪元绑定**(孤儿审批作废);审批 UI 契约写入「证据非指令」纪律 | P1 小项 | A 级原则(durable human approval);纯 web/orchestrator 小改;§5.3 |
| 3 | **checkpoint/intent schema 双消费方对齐**:治理回放 + eval 导入共用格式,写进 eval 框架 P1 的设计约束 | P1,随 eval P1 | §5.4;避免重复建设 |
| 4 | **ARCHITECTURE.md 固化「契约即拆分缝」**:ModelGateway≈Gateway、ToolSession≈身份锚点、checkpoint≈状态外置挂钩;新增旁路直连 provider/绕过 ToolSession 的 PR 视为违规 | 文档动作,随时 | §5.1;防止未来上云时推倒重来 |
| 5 | Thread/Session 并行、独立 Reviewer Agent、PG/Queue/Bridge 进程拆分 | **不排期**,只留观察哨 | C 级或尺度不匹配;触发条件:出现真实多用户并发需求或跨机部署需求(前置条件检查,insights §5.5 教训) |
| 6 | 验证类操作耗时埋点(build/test/lint) | P2,随 observability 顺手 | §5.5;B 级(趋势)+ 本地实测体感 |

---

## 7. 一句话总结

> 这篇文章用一座个人 k3s 上的 alpha,把 durable execution、凭证网关、沙箱按需化三股已被业界独立验证的潮流汇成了同一张架构图;agtpilot 在凭证边界、日志/投影分离、懒分配上已经同构,真正要还的债只有「先记录再执行」——而它还这笔债的方式应该是 jsonl 意图日志级别的小步增量,不是五件套级别的推倒重来。
