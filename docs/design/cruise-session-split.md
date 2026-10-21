# 巡航会话分流 —— 定时任务会话归主动巡航,工作台只留人机对话

> 决策记录:2026-10-21 负责人拍板 —— 定时任务(主动巡航)产生的会话不再进工作台
> 历史会话列表(短时间刷爆 + 挤占持久化窗口),执行历史归巡航中心任务卡展示;
> 巡航会话数据不再随 state/init 全量下发(负责人追问「为什么要下发,不是浪费吗」
> 后由"照常下发只是不展示"修正为"服务端分流、按需取用")。

## 1. 问题(改造前)

- 巡航触发 `runMission`(标题 `【自动巡航】<任务名>`,unattended)产生的是普通
  mission:进同一个持久化列表、同一条 state/init 下行、同一个工作台「历史会话」。
- 持久化窗口每用户只有 50 条(`saveUserMission` 混算 slice)——一个日更巡航任务
  50 天就把手动会话全部顶出窗口,**巡航在吃掉工作台历史**。
- `mission_created` 广播无条件 `setActiveMissionId + setActiveView('cockpit')`:
  巡航触发瞬间把用户当前会话硬切走(每天打断一次)。
- 小红书「本周选题」锚点在前端跑:拿标题标记在下发会话列表里搜最新选题任务再
  解析步骤正文。终态下发行是 stripped 摘要(steps 已剥),**刷新页面后本来就解析
  不到**(半残);巡航会话分流后前端列表连锚点行都没有。

## 2. 身份标记(唯一事实源)

- `Mission.cronJobId`:定时触发(`registerUserCronJob`)与巡航页「立即执行」
  (`triggerUserCronJob`)两条路径的 `runMission` 都带上。
- 旧数据无该字段:`isCronMission`(lib/mission-wire.ts,纯函数,服务端/客户端共用)
  按标题 `【自动巡航】` 前缀(`CRUISE_TITLE_PREFIX`)兜底识别,零迁移。

## 3. 下行分流(lib/mission-wire.ts `splitMissionsForWire`)

state/init(/api/agent/state 与 SSE init 同构)把该用户全量会话(内存 + 持久化
合并去重)拆三路:

| 下行字段 | 内容 | 消费方 |
|---|---|---|
| `missions` | 手动会话,toWireMission 投影(终态摘要/活跃全量减会话历史,既有规则不变) | 工作台/移动端活动页 |
| `cronRuns` | 巡航会话执行历史行 `CronRunMeta`(id/jobId/title/status/startedAt/hasErrorStep/hasArtifact,任何状态都只发元信息),新前旧后,上限 100 | 巡航中心任务卡「最近执行」 |
| `cronDeliverables` | 终态且带交付物正文的巡航会话摘要行(toWireMission,含 artifact),上限 50 | 交付库 / 工坊素材选择器(与 missions 拼接去重后传入) |

ACTIVE 巡航会话的交付物随会话演进,不进静态索引;DONE 后经 `mission_updated`
广播在客户端补入(广播投影不变:stripConversation,点开查看时需要 steps 实时渲染)。

## 4. 持久化分窗(lib/user-store.ts `saveUserMission`)

插入时按来源分账,互不挤占:

- 手动会话:最近 `MISSIONS_MANUAL_CAP = 50` 条;
- 巡航会话:每任务最近 `MISSIONS_PER_CRON_JOB_CAP = 20` 次(分组键 cronJobId,
  旧数据按标题);
- 合并后按 startedAt 新前旧后重排(维持 unshift 序不变量);v2 布局(每任务一文件)
  的写路径会删除被移除任务的文件,淘汰真实回收磁盘。

## 5. 客户端路由(app/page.tsx)

- `mission_created`:巡航会话 → 只进 `cronRuns`(执行历史行),**不进 missions、
  不抢焦点**(修复巡航触发切走用户当前会话);手动会话行为不变。
- `mission_updated`:照常 map missions(只有从巡航中心点开注入的巡航会话在列表里,
  其余 no-op);巡航会话另刷新 cronRuns 行,终态且带交付物 → 补入 cronDeliverables。
- 点开详情 `openCronRun(missionId)`:巡航会话不随 init 下发,现场经
  `/api/agent/mission/[id]` 懒回水全量 → 注入 missions → 选中并跳工作台
  (桌面 cockpit / 移动 activity)。列表侧(CockpitView / MobileActivityView /
  MobileHomeView)按 `isCronMission` 过滤,**仅正被选中的巡航会话可见**,
  不占历史会话坑位;刷新后注入行自然消失(不再下发)。
- 推送深链(`/?tab=activity&mission=<id>`,巡航 DONE push 同款):目标不在下发
  列表 → 延时兜底走 openCronRun 现场取(手动会话仍由既有 exists effect 命中)。
- 巡航页「立即执行」不再跳工作台:留在巡航页看「最近执行」实时冒出新行。

## 6. 选题锚点改服务端(/api/workshops/xhs/topic-picks)

前端不再从下发会话列表搜锚点(见 §1 半残问题);服务端直查持久化库 + 内存活引用
(全量 steps 都在),纯函数 `findLatestTopicPicks` / `hasRunningTopicMission`
(workshops/xhs/topic-picks.ts)原样复用,契约测试不动。弹窗打开时 fetch 一次,
**刷新页面后选题清单稳定可见**(顺带修复既有 bug)。

## 7. 边界与不做

- 巡航会话在工作台被点开后可正常续聊(续聊轮保留 cronJobId,仍按巡航分流);
- 交付库/素材选择器数据源 = 手动会话 + cronDeliverables 拼接(按 id 去重),
  巡航产物(晨报/选题/成稿)照常可勾选为素材;
- 不做:巡航会话独立存储文件(仍在 missions 域内分窗)、ACTIVE 巡航广播瘦身
  (单条瞬时事件,init 大头已分流)、巡航中心分页(上限 100 行元信息足够轻)。
