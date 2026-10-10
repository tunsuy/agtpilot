# agtpilot 文档中心

> 设计与研究文档目前以中文撰写。主文档: [README (EN)](../README.md) · [README (中文)](../README.zh-CN.md) · [ARCHITECTURE](../ARCHITECTURE.md) · [CONTRIBUTING](../CONTRIBUTING.md) · [SECURITY](../SECURITY.md)

## 索引

| 文档 | 状态 | 一句话摘要 |
|---|---|---|
| [ARCHITECTURE.md](../ARCHITECTURE.md) | 已实施 | 分层的铁律、反模式清单（都真的犯过）、新增插件检查单、环境变量 |
| [sandbox-control-hardening.md](./sandbox-control-hardening.md) | ✅ 已实施 | 沙箱控制增强（借鉴 OpenShell 模式）：路径围栏 / env 白名单 / 凭据-端点绑定 / 出口守卫 / bwrap / E2B |
| [persistent-state-governance.md](./persistent-state-governance.md) | ✅ P0/P1 已实现 | 持久状态治理：治理六维 / 五不变量，记忆服务与 governance-bus 的实现记录 |
| [agent-runtime-decoupling-insights.md](./agent-runtime-decoupling-insights.md) | 研究结论 / 提案 | Agent 与 Sandbox 解耦（Tetral 判读 + 业界对照）——orchestrator checkpoint、审批门、压缩的未来取舍 |
| [eval-hillclimb-framework.md](./eval-hillclimb-framework.md) | 提案 | 内部评测与自动爬坡框架（借鉴 Anthropic eval/hillclimb 方法论，不引依赖） |
| [industry-benchmark-evaluation.md](./industry-benchmark-evaluation.md) | 提案 | 外部基准评测接入：Gaia2 / BrowseComp-Plus / OSWorld-Verified / τ²-bench 选型与 adapter 设计 |
| [decision-model-integration-notes.md](./decision-model-integration-notes.md) | 设计提案 | Jev 类决策模型集成：DecisionGateway 契约、D1–D4 决策点接入、安全红线 |
| [workshop-scenario-loop.md](./workshop-scenario-loop.md) | 设计提案 | 工坊场景运营循环：场景档案 / 笔记包交付物 / 截图读数回流 / 发布到草稿托管模式（她只出判断、不出搬运） |
| [cua-integration-notes.md](./cua-integration-notes.md) | 调研笔记 | trycua/cua 计算机使用栈的调研与集成可行性（未运行其代码，集成需锁版本） |
| [personal-ai-landscape-insights.md](./personal-ai-landscape-insights.md) | 研究结论 / 路线图 | 2026 Personal AI 浪潮对 agtpilot 的启发与路线图（以 §5.4 批判性复核修订版为准） |

## 状态标记约定

- **已实施 / P0-P1 已实现** —— 文档描述与当前代码一致，可当作行为参考。
- **设计提案** —— 未动代码，排期待定；文中含契约草案与分期路径。
- **研究结论 / 调研笔记** —— 外部项目的判读与对照，作为后续设计输入。

> 提案类文档动手前请先读其文首的「前置阅读」与状态声明；多篇含自我批判性复核章节（如 personal-ai-landscape-insights §5），以修订版为准。
