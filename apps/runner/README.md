# @agtpilot/runner

AgtPilot 本地薄 runner:接云端派发的开源贡献任务,调起你本地已装的 coding agent CLI
(v1 仅 Claude Code)完成 clone → 改码 → 测试循环;push/PR 一律回云端审批门,
批准后执行**审批时固化的命令集**。

设计文档:[`docs/design/local-runner-bridge.md`](../../docs/design/local-runner-bridge.md)

## 安全形态(一句话版)

- **出站-only HTTPS 轮询**:本机零开放端口,云端零新增常驻进程;
- **凭据零上行**:git/gh/Claude 凭据全留本地原处,runner 代码里不存在读取它们的逻辑;
- **数据最小化**:默认只上行结构化状态摘要(工具名+一行摘要+测试尾部+diffstat),代码内容永不上传;
- **上行 redaction**:事件出本机的唯一出口(client.postEvents)集中过滤已知密钥形态
  (GitHub/AWS/Slack/OpenAI/Anthropic/Google/npm/Stripe/JWT/Bearer/URL 内嵌凭据/key=value)
  + 本机 deviceSecret 值黑名单——防的是意外,不读取才是根本;
- **断网缓冲重发**:上行失败的事件落 `~/.agtpilot/runner/outbox.json`(0600,TTL 7 天/上限 2000 条),
  恢复后自动补发;云端按 eventId 幂等去重,重发窗口安全;
- **本地审计**:append-only JSONL(`audit.jsonl`:配对/启停/任务生命周期/固化命令逐条执行结果),
  `agtpilot-runner logs` 可查,永不上传;
- 本地配对凭据:`~/.agtpilot/runner/credentials.json`(0600),吊销后自动 401 → 本地自毁。

## 使用(配对 → 心跳 → 领取执行)

```bash
# 0.(仓内开发者路径)安装包装命令;正式渠道为 npm i -g @agtpilot/runner(org 注册后启用)
bash apps/runner/scripts/install.sh          # 生成 ~/.local/bin/agtpilot-runner(需先 pnpm install)
# 1. web 驾驶舱「设备」页 → 配对新 Runner → 得到 8 位配对码(5 分钟有效)
# 2. 本地:
agtpilot-runner pair --server https://<部署地址> --code XXXXXXXX
agtpilot-runner start                          # 前台心跳 + FIFO 领取任务,Ctrl+C 退出
agtpilot-runner status                         # 配对状态 + 实例是否在跑
agtpilot-runner stop                           # 停止后台(nohup/tmux)起的实例
agtpilot-runner logs --tail 50 [--json]        # 本地审计日志
agtpilot-runner config                         # 工作区/凭据/审计/离线队列路径一览
```

(未安装包装命令时用 `pnpm --filter @agtpilot/runner exec tsx src/bin.ts <子命令>`。)

`start` 领取任务后:仓库 clone/fetch 到工作区(默认 `~/agtpilot-workspace`,
`AGTPILOT_WORKSPACE_ROOT` 可覆写)→ 调起本地 `claude -p`(headless + stream-json,
工具白名单固化:禁 git push / gh / 联网,永不使用 --dangerously-skip-permissions)→
独立复跑验收命令 → 校验本地 commit → 事件回流,任务停在 awaiting_approval。

云端批准后,runner 随轮询收到**审批时刻固化的命令集**(`git push` / `gh pr create` /
可选 `gh issue comment` 认领留言),逐条再过白名单校验后**逐字执行**——不重新规划、
不追加命令,任何一条失败即停并上报;PR 链接自动回流任务卡。拒绝则任务取消,
本地分支保留(可自行处置)。

## 里程碑

| 阶段 | 能力 |
|---|---|
| M1 | 协议(packages/protocol/runner.ts)+ 配对/设备/任务/事件 API + runner 骨架(pair/start 心跳/status) |
| M2 | 任务包渲染(packages/protocol/runner-taskpack.ts)+ 机会卡「派发到本地」+ ClaudeCodeAdapter(spawn + stream-json 解析,假 claude 二进制测试)+ 事件回流/状态徽章 |
| M3 | 审批闭环:awaiting_approval → 高危审批卡(runner_publish)+ Web Push → 批准时刻固化命令集下行 → runner 白名单复核后逐字执行 → PR 链接回流 done;拒绝 → cancel 下行、本地分支保留 |
| **M4(当前)** | 硬化:离线事件队列(断网缓冲/TTL/幂等补发)+ 上行 redaction(密钥形态用例库)+ 本地审计 JSONL(logs 子命令)+ stop/config 子命令 + pidfile 单实例 + claude 进程组 tree-kill + 安装脚本;按需看 diff 依决策项 7 暂缓(等真实使用反馈) |

## 测试

```bash
pnpm --filter @agtpilot/runner test   # vitest(假 fetch,不起真网络)
```
