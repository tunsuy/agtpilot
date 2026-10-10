# plugin-decision 功能职责与接口规范

- 日期: 2026-10-10
- 状态: 已实施（骨架 + 启发式兜底 + 守卫；D1/D2 待灰度接入，D3/D4 待安全验收）
- 前置阅读: `docs/design/decision-model-integration-notes.md`（选型依据）、`docs/design/compaction-plugin-plan.md`（首个调用方）
- 代码: `packages/plugin-decision/src/{index.ts, providers.ts}`；契约：`packages/core/src/contracts.ts`（`DecisionGateway`）

## 1. 一句话职责

全 harness 通用的**快判断插座**：把高频、封闭、可回退的语义判断从大模型生成链路里拆出来，以带置信度的结构化裁决供代码分支消费。只有建议权，无裁决权。

非职责：不做文本生成、不做长链路规划、不执行副作用、不替代静态安全规则。

## 2. 接口

```ts
decide(point, state, questions, opts?) -> Promise<DecisionVerdict[]>
// point: tool-routing | tier-routing | risk-assist | loop-progress
// questions: choice（单选）/ score（打分 0..1）/ yes-no（布尔），封闭输出
// DecisionVerdict: { kind, value, confidence, latencyMs, provider, mode }
// mode: model | heuristic-fallback（降级必须显式标注）
```

- 内核经 `ctx.reflect.get('decision')` 可选获取；缺失或 `AGTPILOT_DECISION=0` 时走现有启发式，行为回到今天。
- `isAvailable()` 供内核判断走模型路径还是启发式路径。
- `state` 截断 4000 字符；不可信内容由调用方加边界标记（复用 `text.ts` 截断策略）。

## 3. 四个决策点

| 点位 | 问题形态 | 触发 | 低置信守卫 | 状态 |
|---|---|---|---|---|
| D1 tool-routing | `choice`（options = route id + `all`） | 阈值门通过后，代替正则匹配 | 回 `all` 全量兜底 | 待灰度接入 |
| D2 tier-routing | `choice`（`reasoning\|fast\|local`） | 任务创建时一次 | 保持默认 `fast`，不激进降档 | 待灰度接入 |
| D3 risk-assist | `yes-no`（是否不可逆破坏） | `dangerLevel==='medium'` 调用 | 保守判 `true`（升级审批） | 待对抗集验收，最后接 |
| D4 loop-progress | `score`（是否在推进） | 每 k 步（建议 5）异步旁路 | 回 0.6 中性分，仅预警 | 待接入 |

## 4. 安全红线

1. 静态规则是硬底线：`high` 审批、签名计数熔断、预算双闸门，任何裁决不得绕过或降级。
2. 只能往更安全方向生效：D3 只升不降、D4 只预警不熔断、D1 拿不准回全量。
3. 生产流量默认仅自托管 provider；托管 API（Jev / OpenAI Decisions）只进评测，需过出境检查。
4. 每次裁决落 `agtpilot/decision` 事件：`{ point, provider, mode, latencyMs, confidence, stateHash, userId }`，只存哈希与裁决，可回放归因。

## 5. Provider 与环境变量

- `heuristic`（默认）：零外部依赖，当前唯一生效实现。
- `openai-compat`（占位）：vLLM/SGLang 自托管 Clef-flash / Kev / Intern；缺配置时抛错由 `DecisionService` 自动降级。
- 后续：`workers-ai`（托管对照）、`onnx-local`（Laya 端侧降级）、`jev-api` / `openai-decisions`（仅评测）。

| 变量 | 默认 | 作用 |
|---|---|---|
| `AGTPILOT_DECISION` | `0`（关） | 总开关 |
| `AGTPILOT_DECISION_PROVIDER` | `heuristic` | provider 选择 |
| `AGTPILOT_DECISION_MODEL` / `_BASE_URL` / `_API_KEY` | — | 模型名/端点/密钥（不透传 `process.env`，走配置白名单） |
| `AGTPILOT_DECISION_TIMEOUT_MS` | `150` | 单次裁决硬超时，超时即降级 |
| `AGTPILOT_DECISION_CONFIDENCE` | `0.7` | 置信度阈值，低于走守卫 |
| `AGTPILOT_DECISION_POINTS` | `tool-routing` | 逗号分隔，逐点灰度 |

## 6. 与 plugin-compaction 的关系

`compaction` 是 `decision` 的首个调用方，不是同一插件。`compaction` 的 `asker` 接口预留，后续可将 `heuristicAsker` 替换为 `decision.decide('tool-routing' …)` 模型裁决，主流程不动。

## 7. 验收（挂接 eval-hillclimb）

- 题库：checkpoint transcript 回放 + Decision Index 复现包 + injection 对抗集（D3 一票否决）。
- 验收线：D1 命中率显著优于正则且误挂不升；D2 holdout 集省钱不掉分有统计显著性；p95 < 150ms。
