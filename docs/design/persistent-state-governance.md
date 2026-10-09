# 设计文档:持久状态治理(Persistent State Governance)

> 状态:**P0/P1 已实现**(2026-10-09,实现记录与偏差见 §9;P2 待做)
> 灵感来源:综述《Always-On Agents: A Survey of Persistent Memory, State, and Governance in LLM Agents》(arXiv:2606.30306)与 OpenAI Dots 的工程实践
> 涉及模块:`apps/web/src/lib/memory-service.ts`、`apps/web/src/lib/user-store.ts`、`apps/web/src/lib/governance-bus.ts`(新增)、`packages/core`(orchestrator / contracts / notice)、`packages/plugin-git`、`packages/plugin-browser`、连接器/MCP OAuth(`mcp-connectors.ts` / `connector-oauth.ts`)

---

## 1. 背景与动机

### 1.1 综述的核心判断

1. **Always-on 的判据是「持久化」而非「持续运行」**:一个 Agent 在时刻 t 的行为依赖 t 之前积累的状态,它就是 always-on。agtpilot 的 checkpoint + rehydrate、跨会话用户记忆、cron 定时任务已经满足这个定义。
2. **这类系统的本质难题不是「记忆」,而是「持久状态治理」**:哪条留存状态对下一步行动是权威的?它如何被修订、限域、撤销和修复?
3. **每条持久状态应带六维元数据**:权威(authority)、范围(scope)、可变性(mutability)、来源(provenance)、可恢复性(recoverability)、可行动性(actionability)。
4. **生命周期 = 前进弧 + 回退弧**:
   - 前进弧:observe → write → validate → organize → retrieve → act
   - 回退弧:update → forget → audit → rollback
5. **五条不变量**:
   - I1 权威只能收窄,不能悄悄放宽;
   - I2 范围不能悄悄扩大;
   - I3 删除必须传导到所有衍生副本;
   - I4 整合必须保留来源;
   - I5 每个行动都要留下可回滚的「把手」。
6. **AOEP 测评的教训**:Mem0 式「把经历抽取成原子事实塞向量库」的方案在治理题上垫底(真实 mem0 库 3/15,比不存还差),因为抽取过程把权限纪元、删除链接、信任层级等结构化信息**抹平**了。「治理不是阅读问题」——上下文再大、检索再强,读不出库里压根没存的字段。

### 1.2 agtpilot 现状对照

| 综述要求 | agtpilot 现状 | 差距 |
|---|---|---|
| 跨会话持久状态 | ✅ `agtpilot/checkpoint` 事件 + web 落盘 + rehydrate 续跑;user-store 按 userId 隔离持久化 | 无 |
| 范围(scope) | ✅ userId 分域(反模式 #12 的整改成果);`ToolSession{taskId, step, env, userId}` | 记忆条目缺任务/工具/时段级 scope 字段 |
| 权威(authority) | ⚠️ 部分:`source: manual/auto` 区分、rule 类记忆受保护不可自动改删 | 未形式化;无「谁批准其影响行动」的显式字段;无权限纪元 |
| 可变性(mutability) | ⚠️ 部分:hitCount 衰减、`疑似过时` 标记、rule 保护 | 缺修订历史、锁定语义 |
| 来源(provenance) | ⚠️ 部分:auto 记忆带 `missionId` | 提炼(ADD/UPDATE)后来源链断裂;plugin-memory 全局版完全没有来源 |
| 可恢复性(recoverability) | ❌ 删除是硬删(`deleteUserMemory` 直接移除);无台账;无传导 | 全缺 |
| 可行动性(actionability) | ❌ 事实(fact)与承诺(rule/委托)混在同一 category 语义里 | 全缺 |
| 回退弧(forget/audit/rollback) | ❌ 只有会话末 Mem0 式 CRUD 提炼(前进弧的一部分) | 审计与回滚全缺 |
| 副作用回滚把手 | ⚠️ `dangerLevel` 标注 + HITL 审批门 | 审批是事前门,无事后撤销/补偿 |

结论:**前进弧完整、回退弧空白**。这正好是全行业最薄弱、综述论证的主战场,也是 agtpilot 作为开源个人 Agent 框架的差异化机会。

---

## 2. 目标与非目标

### 目标

1. 给持久状态(以用户记忆为首个载体)补齐六维元数据,并保证**提炼/整合过程不抹平结构化字段**(I4)。
2. 建立回退弧:软删除 + 删除台账 + 删除传导(I3),记忆审计日志。
3. 凭证撤销引入**权限纪元(authority epoch)**:连接器/MCP OAuth 撤销后,in-flight 会话与后续行动立即感知(I1)。
4. 有副作用的工具行动留下**回滚把手**(I5):可补偿的自动补偿,不可补偿的显式标注并纳入审批。
5. 建立 **AOEP 式治理测试套**:故障注入(重启、撤销、删除请求、对抗写入)后对状态轨迹打分,纳入 vitest,遵守「测试必须真实失败」铁律。

### 非目标

- 不重写现有记忆召回算法(TF-IDF/embedding 属前进弧,已够用)。
- 不承诺 in-flight loop 自动重启(维持 ARCHITECTURE.md 铁律 7 的既有口径)。
- 不做跨用户的全局记忆治理(多用户隔离已由 userId 分域解决)。
- 第一期不覆盖 RAG 知识库的删除传导(仅在台账中登记 derivedRef,预留钩子)。

---

## 3. 核心设计

### 3.1 六维状态元数据(P0)

扩展 `apps/web/src/lib/memory-service.ts` 的 `UserMemory`:

```ts
export interface GovernanceMeta {
  /** 权威:谁允许这条状态影响行动 */
  authority: {
    grantedBy: 'user-manual' | 'user-confirmed' | 'agent-auto' | 'system';
    /** 权限纪元:授予时的 epoch;凭证/授权撤销后 epoch 递增,旧 epoch 的记录需重新确认 */
    epoch: number;
    /** 是否受保护(自动流程不可改删;原 rule 保护逻辑收敛到这里) */
    protected: boolean;
  };
  /** 范围:哪些上下文可以用它(缺省全空 = 该用户全域) */
  scope: {
    userId: string;                 // 必填,沿用现有分域
    missionId?: string;             // 限定只对某任务生效
    toolPrefixes?: string[];        // 限定只对某类工具生效(如 ['browser_'])
    expiresAt?: number;             // 时间边界
  };
  /** 可变性:能否被修订、衰减、锁定 */
  mutability: {
    policy: 'immutable' | 'user-only' | 'auto-decay' | 'mutable';
    revision: number;               // 每次 UPDATE +1
    supersededBy?: string;          // 被哪条新记忆取代(保留链,不物理覆盖)
  };
  /** 来源:从哪个源头、经哪些变换得来(I4) */
  provenance: {
    originMissionId?: string;       // 原始来源任务(提炼后不丢)
    originMemoryIds?: string[];     // UPDATE/合并时的来源条目 id
    transforms: Array<'distill' | 'user-edit' | 'auto-crud'>; // 变换链
  };
  /** 可恢复性:删除方式与台账指针 */
  recoverability: {
    deleted?: { at: number; by: 'user' | 'auto' | 'propagated'; ledgerId: string };
  };
  /** 可行动性:被动事实还是可执行承诺 */
  actionability: 'fact' | 'commitment';
}

export interface UserMemory {
  // ...现有字段全部保留(id/title/content/category/confidence/updatedAt/
  //    source/subject/missionId/hitCount/lastHitAt)
  governance?: GovernanceMeta;      // 新增;缺省时按 §6 迁移规则回填
}
```

**语义约定**

- `actionability: commitment` 的条目(如「每周五自动发周报」)在注入 prompt 时单独分块、显式标注「这是一条待执行承诺」,与事实记忆区分——避免模型把承诺当背景知识读过就算。
- `authority.protected` 收敛现有「用户手动 rule 不可自动改删」逻辑,成为唯一判断入口。
- 召回排序在现有 TF-IDF + hitCount 基础上,追加过滤:`scope` 不匹配当前任务/工具的条目**不进 prompt**(I2:范围不悄悄扩大)。
- plugin-memory(CLI 全局版)保持现状不动,文档标注「无治理元数据,仅单用户 CLI 场景」;Web 用户级记忆是唯一治理载体。

### 3.2 回退弧:软删除 + 删除台账 + 传导(P0)

**软删除**:`deleteUserMemory` 不再物理移除,改为写 `recoverability.deleted` 并在召回/注入处过滤。用户手动删除默认保留 30 天可恢复,自动删除保留 7 天。

**删除台账**(user-store 新增 `deletion ledger`,按 userId 分域落盘):

```ts
export interface DeletionLedgerEntry {
  id: string;                 // 台账条目 id
  target: { kind: 'memory' | 'connector-auth' | 'rag-doc'; id: string; userId: string };
  requestedBy: 'user' | 'auto' | 'propagated';
  reason?: string;
  at: number;
  /** I3 传导:由本次删除派生的下游删除/失效动作 */
  propagated: Array<{ kind: string; id: string; action: 'soft-delete' | 'invalidate' | 'flag-review' }>;
  status: 'done' | 'partial'; // partial = 有下游无法自动传导,需人工
}
```

**传导规则(I3)**:删除一条记忆时——

1. `provenance.originMemoryIds` 包含它的所有衍生记忆 → 打 `flag-review`(不自动删,标记「来源已删除,待确认」,前端展示);
2. 它 `supersededBy` 链上的历史版本 → 一并软删;
3. 已注入进行中任务 system prompt 的副本 → 通过事件总线广播 `agtpilot/memory-revoked`(payload 带 memoryId + taskId),orchestrator 在下一步 prepareStep 时剔除;
4. RAG 索引中的对应文档(第一期)→ 台账登记 `flag-review`,预留 `rag_forget` 钩子。

**审计日志(audit)**:所有 write/update/soft-delete/restore 追加一条只增不改的 `memory-audit.jsonl`(按 userId 分域),字段:`{at, actor, op, memoryId, before?, after?, epoch}`。这是 AOEP「删除台账还在吗」考题的直接答案。

### 3.3 权限纪元(authority epoch)(P1)

**问题**:用户在连接器中心撤销某个 MCP OAuth / API Key 后,in-flight 任务的 `session.env` 里可能还揣着旧凭证,后续步骤继续用它行动——违反 I1(权威只能收窄,且收窄要即时生效)。

**设计**:

- user-store 为每个 `(userId, connectorId)` 维护单调递增的 `epoch`;`deleteMcpAuth` / 覆盖 `saveUserConnector` 时 `epoch += 1`。
- 任务启动时,orchestrator 记录本任务持有的 `(connectorId, epoch)` 快照。
- 撤销发生时广播 `agtpilot/authority-revoked`(payload: `{userId, connectorId, epoch}`);agent-backend 收到后对 in-flight 任务:
  1. 从 `session.env` 移除对应 Key;
  2. 下一次工具调用前注入一条 system 提示:「连接器 X 的授权已于步骤 N 后被撤销(epoch a→b),相关能力不可用,请调整计划或交回用户」——对齐 Dots「被阻止时把原因告知 Agent,由它决定下一步」的模式;
  3. 治理元数据中 `authority.epoch < 当前 epoch` 的 commitment 记忆自动降级为「待重新确认」,不再注入 prompt。
- 工具侧(如 `mcp_call_*`)执行前校验 epoch,过期凭证直接 `success:false + reason:'authority-revoked'`(遵守反模式 #14:失败就是失败,不静默降级)。

### 3.4 回滚把手(rollback handle)(P1)

**原则(I5)**:每个有副作用的行动,要么可补偿,要么在行动前就知道自己不可补偿。

- `ToolDefinition` 新增可选字段:

```ts
export interface ToolDefinition {
  // ...现有字段
  /** 副作用补偿声明 */
  compensation?: {
    kind: 'reversible' | 'partially-reversible' | 'irreversible';
    /** 可逆时:补偿工具的调用描述(如 browser 填表 → 清空;git commit → revert) */
    undoHint?: string;
  };
}
```

- 执行结果落 checkpoint 时,把「本次行动产生的副作用清单 + 补偿方式」一并快照(`agtpilot/checkpoint` payload 扩展 `sideEffects?: SideEffectRecord[]`)。
- 前端任务详情页提供「撤销上一步」入口(仅对 `reversible` 生效;`irreversible` 置灰并注明原因)。
- `irreversible` + `dangerLevel: high` 的工具(发邮件、支付类)强制走既有 HITL 审批门——事前审批与事后回滚把手互补,不重复建设。
- 第一期只给 git(commit→revert)、browser(form fill→clear)、artifact(删除→回收站)三个插件补 compensation,其余插件按检查单逐步补。

### 3.5 提炼管线防抹平(P0,随 §3.1 一起)

会话末 Mem0 式 CRUD 提炼是 AOEP 测评中的重灾区,整改:

1. **ADD**:提炼 prompt 要求模型同时输出六维元数据的可判定字段(`actionability`、`scope` 建议、`authority.grantedBy` 固定为 `agent-auto`),代码侧校验后写入;缺字段的候选直接丢弃。
2. **UPDATE**:禁止原地覆盖。写新条目(`revision+1`、`supersededBy` 指向旧条目、`provenance.originMemoryIds` 保留旧 id),旧条目转 `superseded` 状态(不注入 prompt、可追溯)。
3. **DELETE**:自动提炼只允许发起**软删**,且 `authority.protected` 条目代码侧硬性拦截(现有 rule 保护逻辑迁入)。
4. 提炼产物的 `confidence` 上限压到 0.8(低于用户手动条目),体现权威差异。

### 3.6 AOEP 式治理测试套(P2,但用例先行)

在 `apps/web/src/lib/__tests__/governance.spec.ts`(vitest)建立故障注入协议的最小实现:

| # | 注入事件 | 检查的状态轨迹断言 |
|---|---|---|
| G1 | 进程重启(loadFromDisk 重放) | 软删条目不复活;审计台账完整;epoch 不回退 |
| G2 | 用户撤销连接器授权 | in-flight 任务 env 中旧 Key 已移除;过期 epoch 的 commitment 不再注入;工具调用返回 `authority-revoked` |
| G3 | 用户请求删除记忆 X | X 软删;衍生记忆被 flag-review;台账含传导记录;审计日志可回答「删过什么、谁删的、何时」 |
| G4 | 对抗写入(自动提炼试图改 protected rule / 试图放宽 scope) | 代码侧拦截;审计日志留下拒绝记录;原条目不变 |
| G5 | 删除后恢复请求 | 台账期内可 restore,restore 本身也留审计 |

评分方式对齐 AOEP:断言全部基于**落盘状态轨迹**而非模型输出文本;任何一条「静默通过」都视为测试失败(铁律 6/8)。

---

## 4. 五条不变量 → 实现规则映射

| 不变量 | 落地点 |
|---|---|
| I1 权威只收窄 | §3.3 epoch 单调递增;§3.5 protected 拦截;confidence 分层 |
| I2 范围不扩大 | §3.1 scope 过滤在召回侧强制;UPDATE 不允许扩 scope(代码校验,扩范围必须新建条目走用户确认) |
| I3 删除传导 | §3.2 台账 + 四类传导规则 + `agtpilot/memory-revoked` 事件 |
| I4 整合保来源 | §3.5 UPDATE 不覆盖、supersededBy/originMemoryIds 链 |
| I5 行动留把手 | §3.4 compensation 声明 + checkpoint sideEffects 快照 |

## 5. 分层铁律合规性自查

- 内核零插件知识:core 新增的只有 `contracts.ts` 的 `compensation` 字段、`task-types.ts` 的 `getStepNotice` 回调与 `notice.ts` 纯函数——**未新增任何 cordis 事件类型**(回退弧广播走 web 层 governance-bus,见 §9.2 偏差 1),模块增强仍全部收敛 core(铁律 1/2)。
- 治理元数据、台账、审计全部归**应用层**(web lib),插件只消费事件——与反模式 #10 的收敛方向一致(plugin-cron 先例:插件留无头能力,持久化/身份归应用层)。
- 新增纯函数(scope 匹配、epoch 校验、台账传导计算)带 vitest 用例(铁律 6)。
- 对外承诺口径:文档/README 只写已实现部分;「撤销上一步」明确标注仅覆盖声明了 compensation 的工具(铁律 7)。

## 6. 数据迁移与兼容

- 存量 `UserMemory` 无 `governance` 字段:读取时惰性回填——`source: manual` → `grantedBy: user-manual, protected: category==='rule'`;`source: auto` → `grantedBy: agent-auto`;`missionId` → `provenance.originMissionId`;`actionability` 按 category 映射(`rule`→commitment,其余→fact);epoch 回填为当前值。
- 回填只发生在内存读取层,首次写回时落盘;不跑一次性迁移脚本,避免半迁移状态。
- 台账与审计为新文件(`deletion-ledger.json` / `memory-audit.jsonl`,按 userId 分域),与现有 user-store 数据文件并列,互不影响。

## 7. 分期计划

| 期 | 内容 | 状态 |
|---|---|---|
| **P0** | §3.1 六维元数据 + §3.5 提炼防抹平 + §3.2 软删/台账/传导 + G1/G3/G4 测试 | ✅ 已完成(2026-10-09) |
| **P1** | §3.3 权限纪元 + §3.4 回滚把手 + G2/G5 测试 | ✅ 已完成(插件覆盖面与前端撤销入口有偏差/延后,见 §9) |
| **P2** | RAG 删除传导(`rag_forget`)、审计前端页(记忆库页展示台账/审计)、commitment 专属注入分块打磨、前端「撤销上一步」入口、工具侧 epoch 预检(`mcp_call_*` 过期凭证直接返回 `authority-revoked`) | ⏳ 待做 |

## 8. 参考

- Always-On Agents: A Survey of Persistent Memory, State, and Governance in LLM Agents — arXiv:2606.30306
- OpenAI:How we build safety, security and privacy into Dots — openai.com/zh-Hans-CN/index/how-we-build-safety-security-and-privacy-into-dots/
- 本仓 `ARCHITECTURE.md`(分层铁律、反模式 #7/#10/#12/#13/#14)
- 本仓 `apps/web/src/lib/memory-service.ts` 头注(双通道架构、Mem0 式 CRUD 决策环现状)

## 9. 实现记录与偏差(2026-10-09)

### 9.1 落地清单

**Web 应用层(P0)**
- `apps/web/src/lib/governance-bus.ts`(新增):零依赖进程内事件总线(`globalThis` 单例,防 Next dev 热重载双实例),两类事件 `memory-revoked` / `authority-revoked`。
- `apps/web/src/lib/user-store.ts`:`UserScopedData` 增 `deletionLedger`(cap 200,只增不改)与 `authorityEpochs`;新增 `getAuthorityEpoch` / `bumpAuthorityEpoch`(单调 +1、审计、总线广播)/ `getDeletionLedger` / `appendDeletionLedger` / `appendMemoryAudit`(append-only jsonl:`<userId>.audit.jsonl`)/ `readMemoryAudit`;`saveUserConnector`(清空值)与 `deleteMcpAuth` 自动推进纪元——**所有撤销路径**(连接器页、MCP disconnect、OAuth revoke)无需改调用方即被覆盖。
- `apps/web/src/lib/memory-service.ts`:`GovernanceMeta` 六维元数据 + `ensureGovernance` 惰性回填(§6 迁移规则);`isActiveMemory`/`listActiveMemories`(软删/被取代/过期/纪元降级统一过滤);`softDeleteUserMemory`(protected 拦截 + 链式软删 + 衍生 flag-review + 台账 + 审计 + 广播);`restoreUserMemory`;`upsertManualMemory`;提炼 CRUD 全面防抹平(UPDATE=取代、升级拦截、ADD 带完整 governance、confidence ≤0.8);commitment 注入显式标注(`formatMemoryLine`)。
- `apps/web/src/app/api/memories/route.ts`:GET 默认活跃集,`?deleted=1` 软删视图,`?audit=1` 审计+台账;POST delete→软删、restore→恢复、clear→逐条软删(不做不可追溯的物理清空)。响应形状与现有前端兼容。

**内核层(P1)**
- `packages/core/src/contracts.ts`:`ToolDefinition.compensation`(`kind` + `undoHint`),tool_result 广播透传。
- `packages/core/src/task-types.ts`:`TaskOptions.getStepNotice`(回退弧感知通道)。
- `packages/core/src/notice.ts`(新增):`appendStepNotice` 纯函数 + `STEP_NOTICE_PREFIX`;orchestrator `prepareStep` 在**压缩之后**追加治理提示(不被蒸馏掉),检查点快照含注入结果;`notice.test.ts` 5 例。
- `apps/web/src/lib/agent-backend.ts`:`taskRuntimes` Map(missionId → {userId, taskEnv 活引用, notices 队列});订阅治理总线——记忆删除→排队提示,授权撤销→从 taskEnv 活引用删 Key(session.env 同对象,即时生效)+ `disconnectUser` 断开 MCP + 排队提示;`getStepNotice` 每步取一条;tool_result 的 compensation 落到 `MissionStep.compensation` 随任务快照持久化。

**插件补偿声明(P1)**:`git_apply_patch` → reversible(反向补丁 / git checkout);`browser_stagehand_act` → partially-reversible(页面内动作可逆,提交类动作不可);`email_send` → irreversible(事前显式告知,配合审批门)。

**测试(P0/P1)**:`apps/web` 补 vitest(devDep + `vitest.config.ts` + `test` 脚本);`src/lib/__tests__/governance.spec.ts` G1-G5 共 14 例全部基于落盘状态轨迹断言。全仓 `pnpm -r run test`:core 35 + web 14 全绿;`apps/web` `tsc --noEmit` 零错误(经 app-kit 传递覆盖全部插件包)。

### 9.2 与原设计的偏差(均为实现时校准,已验证)

| # | 原设计 | 实际实现 | 原因 |
|---|---|---|---|
| 1 | cordis 事件 `agtpilot/memory-revoked` / `agtpilot/authority-revoked` | web 层 `governance-bus`(globalThis 单例) | 事件源在 user-store(最底层,不能反向 import 上层,也拿不到 ctx);总线挂 globalThis 同时解决 Next dev 热重载双实例问题。**core 未新增任何事件类型**,内核零插件知识保持得更干净 |
| 2 | 撤销后「从 system prompt 剔除已注入副本」 | `getStepNotice` 注入一条【系统治理提示】user 消息 | system 在 loop 中是常量,重写代价高且会破坏缓存;显式告知模型「该记忆已删除,不得再引用」对齐 Dots「把阻止原因告诉 Agent」模式,且留审计可见 |
| 3 | §3.4 覆盖 git/browser/artifact 三插件 | 覆盖 git_apply_patch / browser_stagehand_act / email_send | plugin-artifact 实际只有 `artifact_render`(无删除类工具,无回滚语义);email_send 是现有工具集中唯一典型不可逆副作用,声明价值最大 |
| 4 | checkpoint payload 扩展 `sideEffects` | compensation 随 tool_result → `MissionStep.compensation` 落任务快照 | 复用既有持久化链路,checkpoint 形状不动;副作用清单粒度对第一期过重 |
| 5 | `GovernanceMeta.scope.userId` 必填 | 未设 userId 字段;新增 `scope.connectorId` | 数据本就按 userId 分文件,再存一份是冗余;connectorId 是纪元联动的实际键 |
| 6 | 工具侧 epoch 预检(`mcp_call_*` 返回 `authority-revoked`) | 延后到 P2 | in-flight env 删 Key + MCP disconnect 已封死主路径;预检是纵深防御的第三层 |
| 7 | `recoverability.deleted` 无保留期字段 | 增 `recoverableUntil` + `reviewFlag` | 惰性 purge 需要显式 deadline;flag-review 传导需要落点 |

### 9.3 已知边界(如实口径,铁律 7)

- 软删/台账/审计目前只覆盖**用户记忆**;cron/goals/missions 的删除仍是物理删(台账 `target.kind` 已预留 `connector-auth`/`rag-doc`)。
- 前端「最近删除/可恢复」「台账/审计」视图未做(P2),当前可经 `GET /api/memories?deleted=1|audit=1` 查看。
- 「撤销上一步」前端入口未做(P2);compensation 数据已随任务快照落盘,入口是纯前端增量。
- plugin-memory(CLI 全局版)保持现状:无治理元数据,仅单用户 CLI 场景。
