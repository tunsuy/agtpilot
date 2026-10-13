# @agtpilot/runner

AgtPilot 本地薄 runner:接云端派发的开源贡献任务,调起你本地已装的 coding agent CLI
(v1 仅 Claude Code)完成 clone → 改码 → 测试循环;push/PR 一律回云端审批门,
批准后执行**审批时固化的命令集**。

设计文档:[`docs/design/local-runner-bridge.md`](../../docs/design/local-runner-bridge.md)

## 安全形态(一句话版)

- **出站-only HTTPS 轮询**:本机零开放端口,云端零新增常驻进程;
- **凭据零上行**:git/gh/Claude 凭据全留本地原处,runner 代码里不存在读取它们的逻辑;
- **数据最小化**:默认只上行结构化状态摘要(工具名+一行摘要+测试尾部+diffstat),代码内容永不上传;
- 本地配对凭据:`~/.agtpilot/runner/credentials.json`(0600),吊销后自动 401 → 本地自毁。

## 使用(M1 骨架:配对 + 心跳)

```bash
# 1. web 驾驶舱「设备」页 → 配对新 Runner → 得到 8 位配对码(5 分钟有效)
# 2. 本地:
pnpm --filter @agtpilot/runner exec tsx src/bin.ts pair --server https://<部署地址> --code XXXXXXXX
pnpm --filter @agtpilot/runner exec tsx src/bin.ts start   # 前台心跳,Ctrl+C 退出
pnpm --filter @agtpilot/runner exec tsx src/bin.ts status  # 查看配对状态
```

正式分发渠道为 `npm i -g @agtpilot/runner`(npmjs org 注册后启用;当前为仓内开发者路径)。

## 里程碑

| 阶段 | 能力 |
|---|---|
| **M1(当前)** | 协议(packages/protocol/runner.ts)+ 配对/设备/任务/事件 API + runner 骨架(pair/start 心跳/status) |
| M2 | 任务包渲染 + 机会卡「派发到本地」+ ClaudeCodeAdapter(spawn + stream-json 解析)+ Mission 回流 |
| M3 | 审批闭环(awaiting_approval → 审批卡 + Web Push → 固化命令集执行 → PR 回流) |
| M4 | 硬化(离线队列/TTL/redaction/审计视图/stop·logs 子命令/交接包兜底按钮) |

## 测试

```bash
pnpm --filter @agtpilot/runner test   # vitest(假 fetch,不起真网络)
```
