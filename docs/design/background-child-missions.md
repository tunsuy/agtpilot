# 后台异步子任务:子 mission 派发 + 完成回注唤醒

状态:已实现(2026-10-20)
关联:`docs/design/mid-run-user-messages.md`(steering 注入通道,本特性的通知通道照其同构)、`docs/design/subagent-plugin-spec.md`(M3「续聊唤醒」由本特性以子 mission 路线落地;同步 research_subagent 与本特性异步派发分工并存)

## 1. 问题

用户诉求:复刻 Claude Code 的后台异步任务交互形态 —— 长任务后台跑、主对话不阻塞、结果稍后自动送达。盘点存量后发现两块已上线(runMission fire-and-forget 主对话后台可交互;queuedUserInputs 中途插话步边界注入),真正缺口是:**耗时子任务无法后台化,完成结果无法回注父任务并唤醒续聊**。没有这条链路,模型面对「深度调研 + 主线答疑」类复合请求只能全程串行。

## 2. Claude Code 的做法(参照系)

- `run_in_background` / 后台 Bash 与子 agent:派发即返回,主循环不阻塞;
- 子 agent transcript 单独落盘,事后可回看(不是「不落库」);
- 后台任务完成时以 `<task-notification>` 形式在**下一个工具边界**注入主对话;
- 模型被明确要求派发后先干别的,严禁空转轮询。

## 3. 三个已拍板决定

1. **载体 = 独立子 mission**(`parentMissionId` 关联):复用落库/SSE/活动列表/DONE 推送全套基建,过程实时可见 + 事后可回溯;
2. **触发 = 模型自主决定**:`launch_background_task` 任务级工具(run_in_background 同款),不走用户手动按钮;
3. **范围 = 核心闭环**:过程可见 + 完成/失败回注 + 通知气泡;不含重启续跑、应用内通知中心。

## 4. 设计

### 4.1 派发(lib/background-tasks.ts + agent-backend 挂载块)

- `launch_background_task {goal, title}`:goal 必须自包含(子任务看不到父上下文、无人值守不能提问);title ≤20 字(展示位是窄条);execute 立即返回 `{success, childMissionId, title, hint}` 不阻塞;
- **每父 4 个在飞并发闸**:超限 `success:false` 指路模型改同步执行,增长有界(子任务永不挂派发工具 → 无链式风暴);
- **防递归 gate**:`options.parentMissionId || targetMission.parentMissionId` 任一命中不挂工具(含用户点开子会话手动续聊的轮次);
- 子 mission = `runMission(goal, {parentMissionId, unattended: true, userId: 父})`:unattended 写死(后台弹 ask_user 卡是错误语义);userId 继承 → 记忆/连接器/模型覆盖照常;
- **不抢 activeMissionId**(`!options.parentMissionId` 才赋值):否则 init/state 重放与日志归属被污染;
- Feature flag:`AGTPILOT_BACKGROUND_TASKS=0` 关挂载块(全链路暗)。

### 4.2 完成回注 = 第四注入通道(core notice.ts / orchestrator.ts)

- `BACKGROUND_NOTICE_PREFIX = '【后台任务通知】'` + `appendBackgroundNotice`(照 appendBoardReminder 同构);`TaskOptions.getBackgroundNotice?` prepareStep 时机消费;
- 注入顺序(压缩之后、防蒸馏):**治理提示 → 后台通知 → 用户追加消息**;CLI/runner 不传回调零感知;
- 挂钩点:handleEvent `done`(payload.finalAnswer)与 `error`(abort-echo 护栏**之后** —— 用户主动停止/级联停止天然不误报失败);`notifiedChildren: Set` 去重(done/error 双路只投一次,>500 收敛 250);
- 通知文本:标题 + 结果摘要(**截 2000 字**;error 截 200)+ 整合指令 +「不要重复派发/不要原样重试」;
- **路由**(lib/background-notify.ts `deliverChildOutcome`,顺序不可换):
  1. `appendBubble` 通知气泡先落(此时父 push 去重集还挡着,气泡广播 mission_updated 不会误推);
  2. `unlockParentPush`(`pushedDoneMissions.delete(parentId)`);
  3. 父在飞 → `taskRuntimes.bgNotices` 入队,下一步边界一次 drain 全部(`\n\n` join,与治理 notices 的单条 shift 语义分开);父不在飞(含已 DONE)→ `void runMission(prefix+text, {missionId: parentId, skipUserStep: true})` 唤醒续轮;入队失败(收尾竞态,把手已删)回退唤醒 → 撞在飞唤醒轮则进 steering 队列,收敛;
- **轮末兜底扩展**:通知落在最后一个 prepareStep 之后时,`roundLanded && bgNotices.length>0` 也派发续轮(与用户消息 leftover 合并成一条,通知在前);轮没落地(失败/被停)不派发,气泡已落库;
- **Push 语义**:子任务 DONE push 抑制(`parentMissionId` 即 return,N 子=N push 是刷屏且深链落割裂子会话);父首轮 DONE 已进去重集,回注解锁后唤醒轮收尾照常推(整合后的报告,深链落父会话)。

### 4.3 通知气泡(types/agent.ts MissionStep.bgNotice)

- `bgNotice?: {childMissionId, childTitle, outcome: 'done'|'failed', summary?}` 专用字段(不复用 messageKind:'intervention' —— 全仓零实现,激活要动三路判定);
- step `{id: 'step_bg_<childId>'(幂等), title: '后台任务已完成/失败: <title>', status: 'DONE'|'FAILED'}`:无 role/tool/answer → 不被 legacy-final 判定误收为最终答复卡;插入 parent.steps + broadcast → 自动落盘,刷新仍在。

### 4.4 前端(零新 API / 零新 SSE 事件)

子 mission 事件本就以 childId 广播、按 userId 过滤天然到达,`missions.find(childMissionId)` 即得 live 数据:

- **cockpit-blocks.ts**:bgNotice 步骤独立成 `notice` 块(照 eff-step 模式先 flushTools;不拦截会掉进 isTool catch-all 被折叠不可见);
- **CockpitView.tsx**:notice 块渲染为常显系统通知卡(完成/失败两态,摘要 clamp-3 可展开,「查看子任务」= onSelectMission 逃生舱);**不参与整轮过程折叠**(pinnedNotices 从 processRegion 拆出,折叠边界只在内容块上计算);`launch_background_task` 工具行 → 子状态 chip(执行中 spinner/已完成/失败,失败信号 = step_err_ 尾步数据判定)+ chevron 开 inline **BackgroundChildPanel**(子 steps 走同一套 splitStepsIntoBlocks + narrateStep 紧凑渲染);
- **activity-narration.ts**:`background` kind(派发后台任务/后台任务完成/后台任务失败),bgNotice 步骤早退防掉进「执行失败」「完成一轮推理」兜底;
- **列表折叠**:sidebar 顶层 `filter(!parentMissionId)` + 父行下子任务 chip;MobileActivityView 任务切换条同款;
- **坑①(page.tsx)**:mission_created 监听原本对新 mission 无条件 `setActiveMissionId + setActiveView('cockpit')` —— 子 mission 创建瞬间会把用户当前会话切走;带 parentMissionId 只并入列表即 return。

### 4.5 停止级联

`stopMission` 级联停全部在飞子任务(不级联则子继续烧 token 且完成时唤醒刚被终止的父 = 僵尸续轮)。级联停止触发的 error 事件被 abort-echo 护栏吞掉 → 静默无失败气泡。

## 5. 显式不做(v1 边界)

- **重启续跑**:服务重启后父子同标 INTERRUPTED,sweepInterruptedMissions 不续跑不回注(气泡不落、通知不补);
- **单独停子任务**:入口只有停父级联;直接停子会走 abort-echo 静默(无气泡),文档化接受;
- **应用内通知中心**:通知只有会话内气泡 + 父任务 push;
- **IM 通道派发的子任务**:结果只落 web 父会话(IM 回推通道未接);
- **持久化挤出**:50 条历史上限下子任务正常占坑,最坏挤出父记录 → 回水失败、唤醒退化(气泡已落库不丢),不动 user-store。

## 6. 时序(典型场景重放)

```
T0   用户「后台调研竞品 X,同时回答我 Y」
T1   父 mission 建板 → launch_background_task 派发 → 工具行即返(hint: 先干别的)
T1'  子 mission_created(parentMissionId 带)→ 前端只并入列表,会话不切走;sidebar 父行下挂 chip
T2   父答 Y 完毕 → DONE(push 进去重集);子仍在跑(面板 spinner,chip 执行中)
T3   子 done → deliverChildOutcome:气泡落父会话(step_bg_)→ 解锁父 push → 父不在飞 → 唤醒轮
T4   唤醒轮 prepareStep 注入【后台任务通知】→ 模型整合 X+Y 交付 → 父 DONE push(深链落父会话)
T4'  (变体)父 T3 时仍在飞 → bgNotices 入队,下一步边界注入;若恰在轮末 → leftover 兜底续轮
```
