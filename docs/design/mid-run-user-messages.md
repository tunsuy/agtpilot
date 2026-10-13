# 任务进行中的用户消息:排队注入(steering)

状态:已实现(2026-10-13)
关联:`docs/design/loop-execution-optimization.md`(prepareStep/路由)、`docs/design/persistent-state-governance.md` §3.3(注入通道)

## 1. 问题

任务执行中用户继续发消息,旧实现(b85b053 短暂引入)是**打断重跑**:新消息 abort 在飞轮次、以新消息为准重新起一轮。生产实测暴露三个代价:

1. **旧轮工作全作废**——已搜到的资料、已完成的推理随 abort 丢弃;「ai最新发展」的答复被一条「卡住了吗」打断后拖了近一分钟才出来;
2. **答非所问**——「卡住了吗」是问状态,不是想推翻原任务;打断重跑让新轮反查任务状态,原始问题反而没人答;
3. **UI 双轮交错**的历史 bug(b85b053 已修)根源也在这里:两个 runTask 并发写同一 mission。

## 2. Claude Code 的做法(参照系)

官方文档(code.claude.com/docs/en/interactive-mode)核实:

- **Enter = 排队,不打断**。排队消息以灰色气泡显示在会话流里,↑ 可拉回编辑;
- **投递时机 = 工具边界、同轮注入**:工具调用一结束就把消息作为 user 输入传入**同一轮**,模型看到后调整方向继续(steering)。纯文本输出期没有边界 → 等轮末再发;斜杠命令/`!` 命令也等轮末;
- **Esc = 打断但保留已完成的工作**,排队消息紧接着发出;Ctrl+Enter = 立即发送(打断 + 一次性发出全部排队);
- **多条合并**:轮末一起发时合并成一条 user 消息(社区在 #73661 争议是否该 FIFO 逐条);
- **踩过的坑**:注入消息被模型误读为工具输出(#97575);工具执行期的 steering 被忽略(2.1.277 修复)。

## 3. AgtPilot 设计

对齐 Claude Code 语义:**排队 + prepareStep 边界注入 + 停止按钮负责真打断**。

### 3.1 后端(agent-backend.ts)

- `queuedUserInputs: Map<missionId, string[]>`:mission 级消息队列。与 taskRuntimes 分离——准备阶段(MCP 建连等,尚未进模型循环)收到的消息也能排队,等 runTask 起来后第一步注入;
- `runMission` 发现在飞轮次(`runInflight` 有值)时**只排队**:
  - 推入队列(消息原文);
  - mission 里推一个 `queued: true` 的用户步骤(气泡即刻可见),**不**起新轮、**不**动 live step、**不** abort;
  - 广播 mission_updated 后直接返回;
- 注入通道复用治理提示机制:runTask 新增 `getUserMessages` 选项,prepareStep 每步调用(拉取式,与 `getStepNotice` 同款)。排队的消息**合并成一条**(多条 `\n\n` 拼接,对齐 CC),以 `【用户追加消息】` 前缀的 user 消息追加到本步消息末尾(压缩之后,防被蒸馏);
  - 前缀的作用:与工具结果区分,防 CC 踩过的「误读为工具输出」坑;
  - 经 `adjust.messages` 进入循环状态 → 随 `result.messages` 落进 conversationMessages,续聊不丢;
  - 注入同时清掉对应用户步骤的 `queued` 标记并广播(前端气泡转正常色);
- **轮末兜底**:IIFE 落地时若队列仍有未注入消息(典型:最终答复流式期间收到追问,后面没有边界了),自动派发一轮续聊把消息发出去(合并文本为 prompt,`skipUserStep` 避免重复气泡)。对齐 CC「轮末自动发出」;
- `stopMission` 清空队列:用户主动终止语义强于排队发送(CC 的 Esc 会发排队消息,我们的「停止」是明确的终止,不清队列反而会诈尸)。

### 3.2 内核(orchestrator.ts / notice.ts)

- `TaskOptions.getUserMessages?: () => string | null | undefined | Promise<...>`:prepareStep 时机、语义与 `getStepNotice` 完全一致;
- `appendUserMessage(messages, text)`:与 `appendStepNotice` 同构,前缀 `【用户追加消息】`。

### 3.3 前端(page.tsx / MissionStep)

- `MissionStep.queued?: boolean`:排队中的用户气泡置灰 + 「排队中,将在下一步注入」提示(对齐 CC 灰色气泡);
- 乐观提交:目标 mission 在跑(有 RUNNING live step)时只追加排队态用户气泡,**不**再追加「正在思考」占位(避免双 live step——这正是当初布局乱的入口之一)。

### 3.4 保留的既有设施

- `runInflight` 登记 + finally 身份比对删除:仍用于「在飞判定」与 stopMission 正确性;
- superseded 守卫:stopMission 打断后的收尾不重复写错误步骤;
- 上一轮 b85b053 的「打断重跑」路径删除(排队语义下不再存在中途顶替新轮的场景);路由兜底(合成 user 历史)保留——轮末续聊派发时同样受益。

## 4. 显式不做

- **FIFO 逐条一轮**:多条排队合并成一条注入(CC 现行为,也省轮次);
- **卡死自动打断**:注入只在边界生效,推理期间(如 40s)排队消息要等推理结束——这是可接受的延迟,UI 的排队态就是反馈;真卡死由用户点「停止」;
- **注入进 system**:一次性事件追加在消息末尾最贴近注意力分布(与治理提示同一决策,见 persistent-state-governance.md §3.3)。

## 5. 时序(生产事故重放)

```
09:40:58  轮1「ai最新发展」派发(MCP 冷建连中…)
09:41:31  用户发「卡住了吗」→ 排队,气泡置灰,不打断
09:41:38  轮1 进模型循环,prepareStep 第1步注入「卡住了吗」(合并一条)
09:41:4x  轮1 下一轮回答状态 + 继续原任务,已搜资料不丢
09:42:xx  轮1 收尾:最终答复覆盖原问题 + 追问,一条答复两件事都答
```
