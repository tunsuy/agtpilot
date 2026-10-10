# 业界基准评测接入方案(External Benchmarks)

- 日期: 2026-10-10
- 状态: **提案**(待负责人评审,尚未实施任何代码)
- 前置阅读: `docs/design/eval-hillclimb-framework.md`(内部评测框架——本文是它的外部互补层)、`ARCHITECTURE.md`(微内核 / 契约)
- 外部参照: Gaia2(ARE)、BrowseComp-Plus、OSWorld-Verified、τ²-bench 官方仓库与论文(链接见 §6)

## 1. 背景与动机

agent 产品上线对外需要**业界公认的数字**证明能力水位;对内需要**外部标尺**校准自家题库的难度分布。当前 agtpilot 只有内部质量保障(单测 + stub 冒烟 + 规划中的 eval-hillclimb),没有任何可对外引用的基准成绩。

两层评测的分工(与 eval-hillclimb-framework 的边界):

| | 内部评测(hillclimb) | 外部基准(本文) |
|---|---|---|
| 目的 | 改动前后回归验证、爬坡裁决 | 对外公信力、与业界产品对标 |
| 题库 | 自建(生产翻车案例沉淀) | 业界公开基准 |
| 运行频率 | 每次改动 / CI | 发版节点 / 榜单更新 |
| 成本 | stub 回放为主,零 API 费 | 真实模型全量跑,API 费是大头 |

## 2. 2026 业界格局速览

选型前先明确三条行业共识,避免踩坑:

1. **静态基准饱和且已被攻破**: GAIA / WebArena 等老牌基准被伯克利研究证明可被 reward hacking 拿高分而不解任务(WebArena 是污染验证器 `eval()`,GAIA 是答案文件泄露在 HuggingFace)。**结论: 跑任何基准都要留存轨迹自证,不裸发分数。**
2. **榜单量的是「模型 × harness」**: 同一 agent 换 harness 分差可达 50+ 分(OSWorld best-of-10 从 65.6→69.9;Claude Code 各版本在 CCBench 跨度 50.8)。**结论: 我们的数字代表 agtpilot 整个系统,这恰好是我们想要的——评的是产品,不是裸模型。**
3. **评测重心转向 live / 轨迹审计 / 业务结果**: LiveAgentBench(防数据污染)、AgentAtlas(轨迹失败分类)、私有业务集。**结论: 公开基准只是入场券,长期要配自建场景集(见 §7)。**

## 3. 选型矩阵

按 agtpilot 产品形态(Playwright 浏览器 + 沙箱执行 + deep research + MCP 工具 + HITL 的个人自主 agent)匹配:

| 优先级 | 基准 | 测什么 | 匹配点 | 运行模式 | 工作量 |
|---|---|---|---|---|---|
| **P0** | Gaia2(ARE, Meta) | 通用个人助理: 执行/搜索/歧义处理/适应性,1000+ 场景 | 与产品定位完全重合 | 完全自托管(Docker) | 2-3 周,核心是 adapter |
| **P0** | BrowseComp-Plus | 深度研究多跳检索(固定 10 万文档语料,830 题) | browser plugin + deep research 是核心卖点 | 完全自托管(本地索引) | 1-2 周 |
| **P1** | τ²-bench(Sierra) | 对话+工具+用户模拟闭环可靠性(pass^k) | HITL / 会话可靠性是差异化点 | 自托管(pip) | 2-3 天,最轻 |
| **P1** | OSWorld-Verified | 真实 OS 内 computer use(369 任务) | 沙箱/执行能力上限 | 本地可跑;上官方榜须走 AWS 平台+公开轨迹 | 1-2 周(虚拟化重) |
| **P2** | LiveAgentBench | live 持续更新真实场景(防污染) | 上线后持续回归 | **待核实**(见 §5.5) | 待定 |
| 不做 | BFCL / MMLU / WebArena / SWE-bench | 模型层能力 / 已饱和 / 验证器被攻破 | 我们用现成模型,测了不代表产品 | — | — |

## 4. 三种运行模式(部署成本差异)

```
模式A 完全自托管:  Gaia2/ARE、BrowseComp-Plus、τ²-bench
                   本地 Docker/索引,分数本地算,自己控制节奏与预算

模式B 本地自测+平台上榜:  OSWorld-Verified
                   内部: VMware/VirtualBox/Docker+KVM 起真实 OS 虚拟机
                   上榜: 官方 AWS 评估平台,须公开代码与轨迹

模式C 官方在线:  LiveAgentBench(入口未核实)
```

各基准部署要点:

- **Gaia2/ARE**: clone `facebookresearch/meta-agents-research-environments`,Docker 起 ARE;数据集 CC BY 4.0;判分框架自带。ARE 是 adapter 模式——agent 实现其接口即可。
- **BrowseComp-Plus**: 下载固定语料(100,195 文档)+830 题,本地建检索索引;agent 对本地语料做多跳检索,strict 准确率自动判分。语料固定 → 完全可复现、无外部依赖。
- **τ²-bench**: `pip install` 即用;环境状态机 + LLM 用户模拟器 + 判分全在框架内;agent 作为可插拔后端;指标为 pass^k(注意是 k 次独立运行全过的可靠性,不是 pass@k)。
- **OSWorld-Verified**: clone `xlang-ai/OSWorld`,agent 写在 `mm_agents/`,跑 `run.py`;369 任务基于执行结果判分(检查文件/应用终态)。上官方榜必须走其 AWS 平台并公开轨迹——这同时是防 hack 的公信力来源。

## 5. 接入设计(与微内核架构对齐)

### 5.1 总体形态

新增 `packages/eval-external/`(或独立 `apps/eval-runner`,评审时定),不进内核:

```
packages/eval-external/
  src/
    adapters/
      are-adapter.ts        # Gaia2: ARE agent 接口 → agtpilot runtime
      browsecomp-adapter.ts # BrowseComp-Plus: 检索任务 → mission
      tau2-adapter.ts       # τ²-bench: 对话+工具 → ModelGateway/工具调用
      osworld-adapter.ts    # OSWorld: 截图+动作循环 → CUA 通路(依赖 P2)
    runner.ts               # 题集调度、预算熔断(复用内核 setBudget 理念)、断点续跑
    trajectory.ts           # 轨迹留存(每步 checkpoint 事件落盘,发榜自证用)
    report.ts               # markdown + JSON 成绩报告
```

关键决策: **adapter 只依赖 `app-kit` 的 `createAgentRuntime()` 组合根**,不碰内核契约——外部基准属于最外层应用,符合分层铁律(参照 ARCHITECTURE 反模式清单:eval 逻辑不下沉内核)。

### 5.2 Gaia2 adapter(P0,核心工程)

- ARE 侧: 实现 ARE 的 agent 接口(接收任务描述/工具集,产出动作与最终答案)
- agtpilot 侧: 任务 → mission 编排,ARE 暴露的工具挂到 plugin-mcp 的 Tool Registry
- 风险点: ARE 场景含**工具故障注入与歧义任务**,orchestrator 的熔断/重试逻辑会被真实考验——这正是我们要的信号,但要防止把「合理失败」误判为 harness bug
- 预算: 先跑 ~100 题子集校准,再决定是否全量(1000+ 场景全量 API 费不小)

### 5.3 BrowseComp-Plus adapter(P0)

- 语料索引本地化后,本质是「给 mission 一个受限检索环境」——沙箱的 egress guard 需要为基准开白名单(仅允许本地索引端点),与 sandbox-control-hardening 的红线兼容
- 判分 strict exact-match,无 LLM-as-judge,报告直接可信

### 5.4 τ²-bench adapter(P1,先跑通拿首个数字)

- 最小接入: agtpilot 的模型/工具后端接进其 CLI;不涉及浏览器/沙箱通路
- pass^k 要求同一任务跑 k 次全过——正好检验 orchestrator 检查点/恢复的稳定性

### 5.5 LiveAgentBench(P2,入口待核实)

调研时未搜到可靠的官方参与文档(搜索结果被同名产品"LiveAgent"桌面客户端污染)。若后续核实其入口与模式,再补充本节;在核实前**不列入任何对外承诺**。

## 6. 路线图与成本

| 阶段 | 内容 | 产出 | 预算(粗估) |
|---|---|---|---|
| W1 | τ²-bench 跑通 | 第一个可对外数字(pass^k) | API 费低(对话为主) |
| W2-W4 | Gaia2/ARE adapter + 子集校准 + 全量 | 主打成绩 + 轨迹存档 | API 费中-高,先子集后全量 |
| W5-W6 | BrowseComp-Plus | deep research 维度成绩 | 语料索引为一次性成本,API 费中 |
| 之后 | OSWorld(视 CUA 通路成熟度)、LiveAgentBench(视核实结果) | computer use 维度成绩 | 虚拟化基建 1-2 周 |

隐性成本(必须预算):

1. **LLM API 费**: 全量 Gaia2 一轮不便宜;策略 = 子集校准 + 预算熔断 + 失败 case 复跑收敛
2. **轨迹留存**: 每步 checkpoint 落盘,公开发榜附轨迹(防 reward hacking 指控)
3. **复跑义务**: 基准/环境升级后成绩要能复现,报告须记录版本(模型、harness、基准 commit)

## 7. 红线与风险

1. **不许 hack 判分器**: 任何「让分数高但不解任务」的手段(探测验证器、答案缓存)一律禁止——业界已有反例被公开处刑,公信力是唯一资产
2. **数字表述诚实**: 对外引用必须注明「模型 × agtpilot harness」的整体成绩,不冒充裸模型能力;报告含环境/版本/子集声明
3. **外部基准不进 CI**: 真实 API 费与不可复现性决定了它只在发版节点跑;日常回归归 eval-hillclimb 管
4. **翻车 case 反哺**: 外部基准失败案例导入内部题库(喂给 hillclimb 的 case 源),形成「外部标尺 → 内部回归」单向流
5. **长期不依赖公开基准**: 公开基准只是入场券;真正的护城河是「工坊/场景任务中心」沉淀的自建场景集(L5 私有业务评测),公开基准成绩会饱和,自建集不会

## 8. 与现有文档的关系

- `eval-hillclimb-framework.md`: 内部题库 + 判分 + 爬坡,本文的失败案例是其 case 源之一
- `sandbox-control-hardening.md`: BrowseComp-Plus 本地索引白名单需遵守其 egress guard 设计
- `cua-integration-notes.md`: OSWorld adapter 依赖 CUA(截图→操作)通路,时序上排后
