# 模型流遥测与看门狗（轻量第一方观测）

## 背景

生产实测（2026-10-15，mission rk1yt）：自定义 OpenAI 兼容端点首 token 延迟约 6 分钟，
中途流出 52k 字符思考过程后假死 —— 连接未断、不再吐任何字节。`runAgentLoop` 的
fullStream 消费无 in-stream 超时兜底，任务无限期卡在 RUNNING，前端「深度思考中…」
永远不结束，事后无任何排障线索。

未引入第三方观测库（Langfuse/Phoenix/OTel）前的第一方埋点：零新基建、零业务代码
改动（AI SDK 调用参数不变），把「模型流健康度」写进任务运行日志。

## 链路

```
plugin-model runAgentLoop
  ├─ TTFT 打点：首个 text/reasoning 增量距流开始的毫秒数（每 run 一次）
  ├─ 静默看门狗：15s 巡检「距上一流部件」的时长
  │    工具执行 / prepareStep(含任务内压缩) 期间不计时（合法静默）
  │    ├─ ≥ WARN(默认 120s) → stall-warn（区分等首字/中途断流两种文案）
  │    └─ ≥ ABORT(默认 600s) → 主动断流，任务以「模型连接中断」明确失败收尾
  ├─ 流错误：fullStream error part / SDK onError → stream-error（先于最终失败留痕）
  ↓ onTelemetry 回调（contracts.ModelStreamTelemetry）
orchestrator broadcast('model_telemetry')（taskId 统一盖章）
  ↓ agtpilot/event
agent-backend handleEvent
  └─ addTerminalLog → 任务终端日志（SSE terminal_log 实时推前端；
     mission.terminalLogs 随检查点落盘，历史任务可回看；
     stderr 级同步镜像 runtime.log，进程重启后 docker logs 仍可排障）
```

## 阈值

环境变量可覆盖（进程级）：

| 变量 | 默认 | 语义 |
| --- | --- | --- |
| `MODEL_STALL_WARN_MS` | 120000 | 静默告警阈值；每超一轮阈值重复告警一次（心跳式） |
| `MODEL_STALL_ABORT_MS` | 600000 | 看门狗中止阈值；触发即断流并抛「模型连接中断」 |

巡检间隔固定 15s —— 告警/中止的实际触发点有 ≤15s 的粒度误差，换取极低开销。

中止语义与用户主动终止分流：看门狗断的是 plugin-model 自建的 AbortController
（与用户中止信号中继到同一条 SDK 信号），抛出的错误消息带「模型连接中断」，
orchestrator catch → error 事件 → 任务 FAILED，而非「任务已被主动终止」。

## 前端可见位置

任务页右侧「终端」栏（CockpitView 运行终端；移动端活动视图同步）：

```
[模型] 首 token 延迟 2.3s
[模型] 已等待 120.1s 未收到模型输出（上游排队或重试退避中），继续等待…
[模型] 模型输出已静默 245.3s（上游流可能中断），继续等待…
[模型] 流错误: <错误消息>
[模型] 看门狗中止: 静默 605.0s 超阈值，已断开本次模型调用
```

## 验证

冒烟（假 OpenAI 兼容端点，2026-10-16）：
- 挂死流（200 + SSE 头后永不吐字节）→ 告警 → 中止 → 明确报错 ✅
- 中途断流（先吐一段再永久断死，rk1yt 复现）→ `awaitingFirstToken=false` 告警 → 中止 ✅
- 健康流 → TTFT 打点 + 正常完成 + 零误报 ✅

## 后续（未做）

- 升级路径：AI SDK v5 原生 OTel span（含 TTFT/重试）→ 任意 OTLP 后端
  （Phoenix 单容器最轻）——埋线与本次打点不冲突，可叠加。
- 慢模型 UI 提示（「模型响应较慢，可能在排队…」顶部横幅）——现有 stall-warn
  日志已覆盖信息面，横幅属纯 UI 增强。
