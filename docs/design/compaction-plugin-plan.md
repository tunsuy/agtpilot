# 压缩插件方案（plugin-compaction / plugin-decision）

- 日期: 2026-10-10
- 状态: 已实施（P0/P1：plugin-compaction + orchestrator 接入已合入；plugin-decision 待 P2）
- 背景: 公众号文章《把 Agent 的“判断题”从大模型里拆出来》（Jev / fast-jev-compaction）+ 本次讨论结论
- 前置阅读: `packages/core/src/compaction.ts`、`docs/design/decision-model-integration-notes.md`

## 1. 核心原则（已拍板）

1. **落盘全量，会话裁剪**：checkpoint 是账本，append-only 全量落盘，承担审计 / 链路追踪 / 评测回放；发给大模型的才是报表，按 verdict 裁剪。
2. **不直接集成 fast-jev-compaction**：只抄模式（`keepCall / keepResult` 双判 + `keep / drop_result / drop_call` 三分 + `asker` 抽象），不引运行时依赖。原因：transcript 格式不对接、缺审计/降级/分域、无出境管控、绑 Jev API。
3. **单独插件，不耦合内核**：内核零插件知识，经 `ctx.reflect.get()` 可选服务 + 回调注入接入，拔掉插件行为回到今天。

## 2. 现状（core/compaction.ts）

- `compactConversationMessages()`：纯函数 + `summarize` 回调注入，失败退化原文截断——机制是对的。
- 问题：中间区工具调用/结果“一刀切全蒸馏”成一段 `【历史会话纪要】`，把精确证据（如 `order-export.test.ts + 5000ms + authorization header`）改写成大意，可复核性断裂；只有全删/全留两种粒度。

## 3. plugin-compaction：读路径裁剪层

职责：输入 `fullMessages`，输出 `llmMessages + compactionReport`；不碰写路径。

```
checkpoint（全量）
  ↓ 读路径
prepareStep → reflect.get('compaction')?.buildView(fullMessages)
  → 有插件按 verdict 裁剪，无插件发全量
  → report（含 verdict/confidence/stateHash）回写 checkpoint 审计
```

内部四步：

1. `collectToolCalls`：`assistant tool-call` 与 `tool` 结果按 `toolCallId` 配对；首条 + 最近 N 条标 `pinned` 强制保留。
2. `state` 构造：只给短说明（`ok, 4213 chars` / `error, 830 chars`），不给全文。
3. 双判：每组问 `keepCall（调用还有用吗）/ keepResult（结果全文还要留吗）`。首版 `asker` 为本地启发式（error 位、长度、工具类型规则），接口预留，后续可换 Clef-flash / Jev。
4. 三分执行：`keep` 原样保留不进纪要；`drop_result` 留调用截结果；`drop_call` 一起删。只有 drop 下来的才走老纪要流水。asker 异常/超时/收益不足一律回退全量。

文件规划：`packages/plugin-compaction/src/{classify.ts, heuristicAsker.ts, fitState.ts, index.ts}` + vitest（`list_dir→drop_result、无关read→drop_call、失败日志→keep`）。

## 4. plugin-decision：详见独立规范

`compaction` 是 `decision` 的首个调用方。职责、接口、四决策点、安全红线、provider 与验收详见 `docs/design/decision-plugin-spec.md`，此处不重复。

## 5. 实施顺序

1. P0：`compaction.ts` 内 `for (middle)` 收集段拆 `classifyEntries()` 纯函数 + 单测；`plugin-compaction` 骨架 + heuristicAsker。
2. P1：`prepareStep` 经 reflect 接入 `buildView`；灰度开关默认关。
3. P2：`plugin-decision` + D1/D2；D3/D4 待安全验收后。
