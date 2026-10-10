# 评测与自动爬坡框架设计(Evals + Hillclimb)

- 日期: 2026-10-10
- 状态: **提案**(待负责人评审,尚未实施任何代码)
- 前置阅读: `ARCHITECTURE.md`(分层的铁律 / 反模式清单)、`docs/design/persistent-state-governance.md`(治理六维)
- 外部参照: Anthropic《Automating eval design and hillclimbing》(claude.dev/blog, 2026-09-28,即 `/claude-api build-eval` + `hillclimb` 官方指南)——只借鉴方法论,不引入其任何代码或命令依赖

## 1. 背景与问题

当前 agtpilot 的质量保障只有两层:

1. **纯函数单测**: ~30 个 vitest 用例守护 routing / text / compaction / net-guard / sandbox-fence;
2. **stub 冒烟**: `packages/core/src/smoke.ts` 用 stub ModelGateway 验证熔断/看板/压缩三大 harness 能力。

**缺失的是第三层:任务级评测**——「给定真实任务,agent 端到端完成得好不好、花了多少钱、走了多少步」。由此带来三个实际痛点(与 Anthropic 指南开篇场景同构):

1. **改动无法验证**: 改 `DEFAULT_SYSTEM_PROMPT`(orchestrator.ts)、工具 description、路由阈值、router tier 配置时,没有任何手段知道「修好一处是否改坏别处」,只能人工试几轮;
2. **成本主张无数据**: plugin-router 的存在理由是「便宜模型 + 好配置也能达标」,但 tier 切换到底损失多少准确率、省多少钱,零数据支撑——按反模式 #3 的标准,这属于「描述骗人」;
3. **翻车无归档**: 历史上模型翻车的 case(工具假成功、路由漏挂、压缩丢关键信息)修完即散,没有沉淀成可复跑的回归题库。

**机会**: 内核其实已经产出了评测所需的全部原料——`TaskEfficiency`(步数/失败率/挂载数/有效率)、`agtpilot/usage`(真实 token 用量)、checkpoint 事件(每步消息快照)、`setBudget`(预算硬熔断)。缺的只是「题库 + 判分 + 复跑 + 裁决」这一层。本设计补齐它,并把 Anthropic 指南的 holdout 爬坡闭环搬进来。

## 2. Anthropic 指南借鉴矩阵

| 指南设计 | 采纳? | 我们的形态 |
|---|---|---|
| build-eval 采访式建题库 | ✅ 变体 | P0 手写 case + 脚手架;P1 起从 web 会话 checkpoint(生产 transcript)导入翻车案例 |
| 好 eval 四标准(真实分布/强模型更高分/不满分/低方差) | ✅ 采纳 | 写进 suite 诊断报告:饱和预警(≥95%)、方差预警、区分度检查 |
| 判分优先程序化,开放题才用 LLM-as-judge | ✅ 采纳 | grader 类型同名同义(见 §4.1) |
| 评分器先过人工校准 | ✅ 采纳 | `eval judge-calibrate` 金标流程,不达标拒绝参与爬坡裁决(见 §4.4) |
| train/holdout 拆分,holdout 对爬坡模型不可见 | ✅ 采纳 | split.json 种子锁定;runner 层强制隔离(见 §4.6) |
| 每轮单点修改、复跑、退步回滚 | ✅ 采纳 | hillclimb 循环,git worktree 承载补丁 |
| 过拟合检测(train 涨 holdout 不涨→回滚) | ✅ 采纳 | `eval-stats.isSignificant` 裁决 |
| 失败案例不原文贴进 prompt | ✅ 采纳 | 写进补丁模型的 system 约束 |
| 调优预算上限 | ✅ 采纳 | case 级(复用 `setBudget`)+ run 级 + 爬坡轮级三层 USD 熔断 |
| 调优对象含 harness 代码 | ⚠️ 部分 | 只开放**参数化目标白名单**(prompt/tier env/阈值/工具描述),不允许自动改内核逻辑代码 |
| web 结果页面 | ⚠️ 变体 | P0 出 markdown+JSON 报告;Generative UI 展示列后续(经 plugin-artifact) |
| 补丁自动合并 | ❌ 不借鉴 | 每轮保留的补丁落在独立 git 分支,人工 review 后才进 main |
| 在线生产流量评测 | ❌ 不做 | 多用户 web 的生产采样涉隐私治理,超出本项目范围 |
| (指南没有的)确定性回放 | ➕ 自研 | `--replay` 模式:录制真实 transcript 驱动 stub ModelGateway 复跑 harness 全链路,零 API 费进 CI(smoke.ts 理念的产品化,见 §4.3) |

## 3. 目标 / 非目标(诚实版)

**本框架能**:
- 对「任务→最终答案/交付物/工具行为/效率/成本」给出可复跑的量化分数;
- 在改 prompt、tier 配置、路由阈值、工具描述前后跑同一题库对比,显著性裁决保留或回滚;
- 用 holdout 集缓解「只对熟题变好」的过拟合;
- 回放模式下确定性验证 harness 行为(熔断/压缩/路由/审批)不回归,进 CI 零成本。

**本框架不能**(不夸大):
- 不能保证题库覆盖真实分布——holdout 之外的真实问题照样翻车(指南原文同款声明);
- 不能消除真实模型的方差——repeats + 显著性只能降噪,小样本仍会误判;
- 不能替代 vitest 单测——纯函数逻辑仍然单测守护,eval 测的是端到端行为;
- 不能自动合并补丁——爬坡产出的是「候选分支 + 证据报告」,拍板永远是人(对齐治理:关键取舍归负责人)。

## 4. 设计

### 4.1 题库目录与 case 格式

```
evals/
  pricing.json                 # provider/model → $/1M tokens(成本核算用,git 管理)
  suites/<suite>/
    suite.json                 # 套件配置: 目标描述、默认 maxSteps、pass 阈值、需要的插件、judge 配置
    cases.jsonl                # case 一行一个 JSON(追加友好,diff 可读)
    fixtures/                  # case 工作区初始文件(按 case.setup 引用拷入隔离工作区)
    split.json                 # train/holdout 拆分锁定(首跑种子生成,此后稳定)
    goldens/                   # judge 校准金标(人工已打分的答案样本)
  reports/<runId>/             # 运行产物(gitignore): report.json / report.md / transcripts/
```

case schema(关键字段):

```jsonc
{
  "id": "search-001",
  "prompt": "查一下 X 并给出对比表",
  "tags": ["search", "live"],          // live = 依赖外网,波动大;其余默认 deterministic
  "source": "hand | prod | synthetic",  // prod = 从 web checkpoint 导入的翻车案例
  "setup": { "fixtures": ["input.csv"], "env": {} },
  "needs": ["network"],                 // 声明依赖 → runner 决定 exclude 哪些插件、沙箱 net 开关
  "budgetUsd": 0.5,
  "checks": [ /* 见下 */ ]
}
```

check 类型(判分器,全部输出 `{pass, score∈[0,1], detail}`):

| kind | 判什么 | 实现 |
|---|---|---|
| `exact` / `contains` / `regex` | finalAnswer 文本 | 程序化 |
| `json_schema` | finalAnswer 或指定交付物是合法 JSON 且过 schema | 程序化 |
| `tool_used` / `tool_not_used` | 必须/禁止调用某工具(如危险操作必须被审批门拦) | 程序化(events) |
| `tool_sequence` | 工具调用满足有序模式(如先 search 后 artifact) | 程序化(events) |
| `file_exists` / `file_contains` | 工作区交付物断言 | 程序化(runner 读文件后传入) |
| `efficiency` | `stepsCount ≤ N` / `effectiveRate ≥ X` / `costUsd ≤ Y` | 程序化(TaskEfficiency + usage,**内核已免费产出**) |
| `answer_judge` | 开放性答案按明确 rubric 打分 | LLM-as-judge(§4.4) |

case 分 = checks 等权平均(suite 可配权重);case pass = 全部标 `hard: true` 的 check 通过且总分 ≥ 阈值(默认 0.8)。

### 4.2 core 纯函数(vitest 守护,铁律 6)

- **`packages/core/src/eval-graders.ts`**: 程序化判分纯函数。输入是 TaskResult 的可序列化摘要(`{finalAnswer, events, efficiency, files}`),输出 `CheckScore[]`。零 IO——文件类 check 由 runner 先读好文本再传入,保持纯函数可测。
- **`packages/core/src/eval-stats.ts`**: `mean/stddev`、比例置信区间(Wilson)、`splitCases(ids, seed, holdoutPct)`(种子 shuffle,稳定)、`isSignificant(before, after, noise)`(爬坡保留/回滚的唯一裁决依据:提升幅度必须超过评测噪声)。
- 对应 `eval-graders.test.ts` / `eval-stats.test.ts`,先红后绿。

内核改动仅此两处 + 下述 app-kit 一行,不触碰 orchestrator 逻辑。

### 4.3 Runner(apps/cli/src/eval/)

入口: `agtpilot eval run --suite <name> [--split train|holdout|all] [--repeats N] [--replay] [--budget-usd X] [--model <provider/model>] [--dry]`

每 case 执行序:

1. **隔离工作区**: `mkdtemp(agtpilot-eval-<runId>-<caseId>)`,拷入 fixtures——case 工作区永不在仓内,防被测 agent 读到 `evals/` 作弊(§7);
2. **起 runtime**: `createAgentRuntime({ exclude: 按 case.needs 反推不需要的重插件(browser/desktop…), sandbox: { workspaceRoot: 隔离目录 } })`;
3. **跑任务**: `orchestrator.runTask({ prompt, userId: 'eval-'+caseId, taskSandbox: { net: needs 含 network ? 'allow' : 'deny', fence: 'best_effort' }, maxSteps, system: suite 覆盖 })`,同时 `setBudget(case.budgetUsd)`;
4. **采集**: TaskResult + `agtpilot/usage` tokens + events 全量落 `transcripts/<caseId>.json`;
5. **判分**: 程序化 checks 直接算;`answer_judge` 走 judge 网关;
6. **清场**: dispose runtime、删工作区(失败也删,finally)。

repeats N 次取均值,同时报 stddev——方差本身是 suite 诊断指标(四标准之「低方差」)。

**唯一 app-kit 改动**: `CreateAgentOptions` 增加 `sandbox?: { workspaceRoot?: string }`,装配时透传给 plugin-sandbox(现在 mount 无 config,workspaceRoot 落到 process.cwd())。装配仍只发生在 app-kit(铁律 4)。

**`--replay` 回放模式(自研差异点)**: `agtpilot eval record --suite <name>` 在真实跑时把每 case 的模型响应序列(responseMessages)录进 case 附属文件;`--replay` 时用录制序列驱动 stub ModelGateway(smoke.ts 同款手法,实现 ModelGateway 契约,编译期防漂移)复跑 runTask 全链路。**测的是 harness(路由/熔断/压缩/审批/事件),不是模型**——模型不可复现,harness 必须可复现。回放零 API 费、确定性,适合进 CI 当 eval 框架自身的回归门(对齐反模式 #8:测试必须真实失败)。

### 4.4 LLM-as-judge(answer_judge)

- 走 `ModelGateway.invokeStep({ disableTools: true })`,输出结构化 `{verdict, score, rationale}`;rubric 必须是明确规则清单(哪些信息必须有/哪些错误不能犯/什么程度算过),禁止「专业、友好」式粗颗粒;
- **judge 模型默认 ≠ 被测模型**(`AGTPILOT_EVAL_JUDGE_MODEL`),至少要在报告中显式记录同款(自我偏好偏差);
- **校准门**: `agtpilot eval judge-calibrate --suite <name>` 对 goldens(人工已打分样本)跑 judge,输出一致率与混淆矩阵;一致率 < 80% 时:报告提示改 rubric,且**该 judge 禁止参与 hillclimb 裁决**(只能用于观察)。评分器本身先过关,是指南最容易被跳过也最不能跳过的一步;
- 校准通过后仍建议定期抽查(报告里保留 judge rationale 全文供人工复核)。

### 4.5 成本核算与预算熔断

- tokens 来自 `agtpilot/usage`(真实数据,非估算);`evals/pricing.json` 换算 costUsd,进 per-case 与汇总报告;
- 三层熔断,全部复用既有机制: case 级 = `setBudget`(loop 内硬收尾)→ run 级 = `--budget-usd`(runner 累计超限即停,**已跑部分照常出报告**,不吞结果)→ 爬坡轮级(§4.6)。

### 4.6 hillclimb(自动爬坡)

入口: `agtpilot eval hillclimb --suite <name> --rounds N --budget-usd X --targets prompt,router,thresholds,descriptions`

**补丁目标白名单**(只开放参数化目标;白名单外的文件补丁直接拒绝):

| target | 落点 |
|---|---|
| `prompt` | orchestrator `DEFAULT_SYSTEM_PROMPT`,或 suite 级 system 覆盖文件(优先后者,不动内核) |
| `router` | `AGTPILOT_{REASONING,FAST}_{PROVIDER,MODEL}` env 默认 / TIER_RESOLVERS 常量 |
| `thresholds` | `AGTPILOT_TOOL_SEARCH_THRESHOLD` / `AGTPILOT_CONTEXT_WINDOW` / 压缩触发阈值 |
| `descriptions` | 指定插件的工具 description 文本 |

**每轮循环**:

```
跑 train split(holdout 不参与调优)
→ 收集 train 失败案例摘要(只含失败现象与 rubric 差距,不含 holdout 任何信息)
→ 补丁模型(独立配置)提出【一处】修改,约束: 不得把失败案例原文贴进 prompt
→ 补丁应用到 git worktree 副本(主仓工作区永不被自动修改)
→ worktree 内复跑 train + holdout
→ 裁决(eval-stats.isSignificant):
   train↑ 且 holdout 不↓  → 保留: commit 到 hillclimb/<suite>-<runId> 分支
   train↑ 但 holdout ↓    → 判过拟合,回滚
   任一 ↓                 → 回滚
   提升 < 评测噪声         → 回滚,计一次停滞
→ 连续 2 轮停滞 → 停止,输出根因分类报告(prompt 缺失/case 歧义/judge 偏差/方差过大/已到顶)
```

**安全边界**: holdout case 内容与失败详情永不进入补丁模型上下文(runner 层强制,不靠自觉);每轮至多一个自动 commit;分支合并 main 永远人工;预算熔断优先级最高,超限立即终止并保留已产出分支。

### 4.7 报告

`reports/<runId>/report.json`(全量机器可读)+ `report.md`(人读:总分表、per-case 得分与 judge rationale、置信区间、stddev、成本明细、suite 诊断[饱和/方差/区分度])+ `transcripts/`。CLI 结束打印摘要表与路径。Web Generative UI 展示列后续(经 plugin-artifact,不阻塞本框架)。

## 5. 分层与落点核对(对照铁律逐条)

| 改动 | 位置 | 核对 |
|---|---|---|
| eval-graders / eval-stats 纯函数 + vitest | `packages/core/src/` | 铁律 6 ✅;core 零插件知识 ✅ |
| runner / record / hillclimb 命令 | `apps/cli/src/eval/` + bin.ts 子命令 | 应用层只经 app-kit ✅ |
| `CreateAgentOptions.sandbox.workspaceRoot` | app-kit 一行透传 | 装配只在 app-kit ✅ |
| 题库 / 金标 / 价格表 | `evals/`(git 管理) | 数据与代码分离 |
| 报告产物 | `evals/reports/`(gitignore) | — |
| **不做插件** | — | eval 是开发期工具而非运行时能力;塞进插件体系 = 反模式 #10 复发(持久化/执行身份/工具暴露三问全不适用) ✅ |

新增插件检查单不适用(无新插件);跨服务调用全部走 ModelGateway / orchestrator 既有契约(铁律 3)。

## 6. 分期与验收

| 期 | 内容 | 验收标准 |
|---|---|---|
| **P0 框架可用** | core 纯函数 + case 格式 + runner(真实模型) + 程序化 graders + report + 一个 5-case dogfood suite(覆盖 search/sandbox/审批门拒绝三类) | `agtpilot eval run --suite demo` 端到端出报告;新增 vitest 全绿;报告含每 case 得分/transcript/成本 |
| **P1 可信评测** | LLM judge + 校准门 + train/holdout split + repeats/方差 + 成本核算 + `--replay` 回放进 CI | judge-calibrate 对 goldens 一致率可量化;replay 在 CI 零 API 费复跑 harness 断言;holdout 拆分种子稳定 |
| **P2 自动爬坡** | hillclimb 循环 + worktree 隔离 + 显著性裁决 + 三层预算熔断 + 根因报告 | 在 demo suite 上完成 ≥3 轮自动爬坡,产出候选分支与证据报告,过拟合注入测试(故意贴答案)能被 holdout 裁决抓住并回滚 |

每期独立 PR,文档与代码同 commit(house 规矩)。P0 之前不写任何实现代码。

## 7. 风险与诚实声明

1. **评测本身烧钱**: 真实模型路径每跑一轮都是真金白银;replay 只覆盖 harness 不覆盖模型行为。先定预算再跑轮数(指南同款提醒);
2. **方差误判**: repeats 降噪但小样本仍可能把噪声当提升——所以爬坡裁决要求「提升 > 噪声」而非「提升 > 0」;
3. **过拟合无法根治**: holdout 只缓解「对熟题变好」,题库覆盖不到的真实问题仍会翻车;题库需要持续从生产翻车案例补充(P1 的 prod 导入通道);
4. **live case 波动**: 外网站点改版会让 browser/search case 假阳性——tags 区分 deterministic/live,爬坡裁决默认只吃 deterministic,holdout 里的 live case 单独报告;
5. **judge 偏差**: 冗长偏好、自我偏好真实存在——校准门 + 异模型 + rationale 留档三重缓解,不承诺消除;
6. **被测 agent 作弊面**: case 工作区在 tmp 隔离目录、fixtures 不含答案、`evals/` 永不进 case 工作区;沙箱 net 默认 deny(needs 显式声明才放行);
7. **爬坡补丁的破坏面**: 白名单外文件拒绝、worktree 隔离、人工合并三道闸;但白名单内(如系统 prompt)改坏仍可能不被本 suite 抓住——所以报告永远附 diff 全文。

## 8. 开放问题(评审时定)

1. **首个 dogfood suite 评什么**: 候选 a) router tier 选择准确率(直接支撑「省钱不降质」主张);b) search 研究类任务质量;c) 审批门/危险操作拦截正确率(安全回归)。建议 a+c 混合;
2. **judge 模型选型与预算**: 单轮全量跑 demo suite 的 USD 上限定多少;
3. **holdout 比例**: 指南未给死数,建议 20~30%,case 少于 10 个时 holdout 至少 2 个;
4. **P1 的 prod 导入通道**: 从 web 会话 checkpoint 导 case 涉及用户数据脱敏,是否需要先过治理评审。
