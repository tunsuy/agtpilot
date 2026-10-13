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

## 使用(配对 → 心跳 → 领取执行)

```bash
# 1. web 驾驶舱「设备」页 → 配对新 Runner → 得到 8 位配对码(5 分钟有效)
# 2. 本地:
pnpm --filter @agtpilot/runner exec tsx src/bin.ts pair --server https://<部署地址> --code XXXXXXXX
pnpm --filter @agtpilot/runner exec tsx src/bin.ts start   # 前台心跳 + FIFO 领取任务,Ctrl+C 退出
pnpm --filter @agtpilot/runner exec tsx src/bin.ts status  # 查看配对状态
```

`start` 领取任务后:仓库 clone/fetch 到工作区(默认 `~/agtpilot-workspace`,
`AGTPILOT_WORKSPACE_ROOT` 可覆写)→ 调起本地 `claude -p`(headless + stream-json,
工具白名单固化:禁 git push / gh / 联网,永不使用 --dangerously-skip-permissions)→
独立复跑验收命令 → 校验本地 commit → 事件回流,任务停在 awaiting_approval,
push/PR 等云端审批(M3 交付前产出只留本地分支)。

正式分发渠道为 `npm i -g @agtpilot/runner`(npmjs org 注册后启用;当前为仓内开发者路径)。

## 里程碑

| 阶段 | 能力 |
|---|---|
| M1 | 协议(packages/protocol/runner.ts)+ 配对/设备/任务/事件 API + runner 骨架(pair/start 心跳/status) |
| **M2(当前)** | 任务包渲染(packages/protocol/runner-taskpack.ts)+ 机会卡「派发到本地」+ ClaudeCodeAdapter(spawn + stream-json 解析,假 claude 二进制测试)+ 事件回流/状态徽章 |
| M3 | 审批闭环(awaiting_approval → 审批卡 + Web Push → 固化命令集执行 → PR 回流) |
| M4 | 硬化(离线队列/TTL/redaction/审计视图/stop·logs 子命令/按需 diff) |

## 测试

```bash
pnpm --filter @agtpilot/runner test   # vitest(假 fetch,不起真网络)
```
