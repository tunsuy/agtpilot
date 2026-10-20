# 设计文档:工具输出 spill-to-file(超长结果全量落盘 + 指针续读)

> 状态:**方案已发负责人确认;代码已预写完毕待 commit**(2026-10-17)——
> core 149 测全绿(含新增 orchestrator-spill 8 例)、web 1218 测全绿(含新增
> tool-output-store 12 例)、web tsc exit 0;另顺手拆除 follow-builders.test.ts
> 的时钟时间炸弹(钉死 2026-10-11 的 NOW 改动态,存量失败与本方案无关)
> 关联文档:`token-consumption-and-tool-loading.md`(放大器盘点与三层漏斗改造建议)、
> `context-store-filesystem-paradigm.md`(用户上下文目录 v2 —— 本方案的存储基底)
> 涉及模块:`packages/core/src/orchestrator.ts`(截断点改造)、`packages/core/src/text.ts`(指针文案)、
> `apps/web/src/lib/tool-output-store.ts`(新增)、`apps/web/src/lib/agent-backend.ts`(注入)、
> `packages/core/src/task-types.ts`(效率统计字段)

---

## 1. 背景与病理

生产雷达任务实测:单任务 73 万 input tokens。工具输出侧的病理链:

1. **截断即永久丢失**:orchestrator 统一截断点(`orchestrator.ts:379-385`)对超过
   `TOOL_OUTPUT_LIMIT=16KB` 的工具结果做头尾混合截断(`text.ts truncateToolOutput`),
   截断标记里有原始大小与 offset 续读指引,但**被截掉的中间部分没有任何副本** ——
   模型想回看只能整体重取(重取是步数空转的典型来源,截断文案自己都这么写)。
2. **保护窗骑线**:压缩阈值 30k tokens(`COMPACT_THRESHOLD_TOKENS`)+ 近 10 条原样保留
   (`COMPACT_RECENT_MESSAGES`)。16KB 截断版 × 10 条保护窗 ≈ 最坏 160KB 字符骑在阈值上,
   历史反复触发蒸馏、每步重复付费(token 文档「放大器 3」病根之一)。
   (2026-10-19 更新:token 文档 §9.8 已把阈值改为 min(静态 30k, 模型窗口动态预算)、
   近期窗口改为 token 预算制(默认 ≤8k、条数 4~10 钳制),「160KB 骑线」的最坏形态
   由窗口预算直接封死;落盘指针机制的价值不变。)
3. **浏览器窗口分页不保底**:`browser_navigate`/`browser_firecrawl_scrape` 用
   `PAGE_WINDOW=4000` 窗口 + offset 续读,但全文只存在于源站 —— 页面一变(动态渲染/反爬)
   offset 续读就拉不到同一份内容,不可恢复。

## 2. 业界调研(2026-10):三层漏斗

| 层 | 做法 | 代表 |
|---|---|---|
| 层1 源头裁剪 | 工具声明输出上限,服务端截 | Claude Code MCP `MAX_MCP_OUTPUT_TOKENS` 默认 25k tokens(10k 告警;`anthropic/maxResultSizeChars` 注解持久可到 50 万字符);OpenAI Codex 10KiB/256 行 + per-tool `output_token_limit`;Cline 8k 字符;Cursor 100k 字符 |
| 层2 截断+落盘 | 截断版进上下文,全量写文件留指针 | Gemini CLI 40k 字符 + 全量写临时文件;Claude Code「自动写文件」仍是 open feature request(anthropics/claude-code#20342) |
| 层3 指针化续读 | 上下文只留引用,按需拉取 | LangChain Deep Agents context offloading(大结果与大输入都卸载到文件系统,旧 tool call 换成磁盘指针);Manus「文件系统=终极上下文,可恢复压缩:丢正文保 URL」 |

**红线(各家共识)**:禁止静默截断 —— 必须告知模型原始大小 + 如何继续获取,
否则「agents lie」(模型基于残缺数据自信作答)。我们现有截断标记已符合,spill 后继续符合。

**远期方向**:Code Mode / PTC(Programmatic Tool Calling,上下文节省 -37%~-99.9%)——
工具输出不进对话、由代码消费,本方案不做,列为远期(见 token 文档 §9 第三步之后)。

## 3. 现状盘点:范式已有,缺的是工具输出这一路

「全量存文件 + 引用 id + 按需拉取」在本仓已有三处实现(负责人记忆核实 2026-10-17):

| 机制 | 位置 | 范围 |
|---|---|---|
| `read_memory` / `read_mission` | `memory-service.ts:1101/1143`(context-store v2 P2) | 记忆 L0 摘要注入 + 全文按需从 `v2/<userId>/missions/` 拉 |
| `read_reference_material` | `apps/web/src/lib/reference-materials.ts` | 工坊参考资料:prompt 只带引用 id+标题,8000 字上限 + offset 续读(art_* 交付物 / upl_* 本地上传双来源,见 material-uploads.md) |
| `context_file` / agent-notes | context-store v2 P3 | Agent 主动写文件(对标 Claude memory tool),非框架兜底 |

**通用工具输出路径没有任何 spill**:只有 16KB 截断(§1.1)与浏览器 4000 字窗口(§1.3)。
本方案 = 把已有范式补到工具输出这一路,基建(用户目录、按需读取工具形态、审计链)全部现成。

## 4. 方案设计

### 4.1 存储布局(对齐 context-store v2)

```
.cache/user_data/v2/<userId>/
  tool-output/
    <taskId>/
      <callId>.txt          # 全量原文(截断前的 serialized 字符串)
  audit/
    tool-output.jsonl       # 只增:spill 事件 + 读取事件(含过期未命中)
```

- 按任务分目录:任务删除可级联清理整目录;callId(`call_<ts>_<rand>`)全局唯一,天然防碰撞;
- v2 关闭(`AGTPILOT_CONTEXT_STORE_V2=0`)回退旧平铺形态 `<safeName>.tool-output/<taskId>/`
  (对齐 agent-notes 的回退先例,`user-store.ts:1019-1022`);
- 路径构造只经 `user-store-v2.ts` 的 `userDirV2`/`safeName`,callId/taskId 过白名单正则
  (`^[\w-]+$`)防路径穿越(对齐 agent-notes P3 验收项)。

### 4.2 注入路径(core 不依赖 web 存储)

core 定义契约、web 实现落盘 —— 对齐 `getStepNotice`/`getUserMessages` 的既有回调注入模式:

```ts
// task-types.ts TaskOptions 新增(可选,CLI/runner 不注入 = 现行为不变):
spillToolOutput?: (info: {
  taskId: string; callId: string; toolName: string; fullText: string;
}) => string | null | Promise<string | null>;
// 返回非空 = 落盘成功,返回值即指针 callId 确认文本;返回 null/抛错 = 走现行截断
```

orchestrator 截断点改造(`orchestrator.ts:379-385`):

```ts
const serialized = typeof output === 'string' ? output : JSON.stringify(output);
let finalOutput = output;
if (serialized.length > TOOL_OUTPUT_LIMIT) {
  const spill = spillEnabled() && options.spillToolOutput
    ? await trySpill(options.spillToolOutput, { taskId, callId, toolName: toolDef.name, fullText: serialized })
    : null;                       // trySpill 内部 catch 一切异常 → null(降级不失败)
  finalOutput = spill !== null
    ? buildSpillPointer(serialized, toolDef.name, callId, spill)   // 预览+指针(§4.3)
    : truncateToolOutput(serialized, toolDef.name, TOOL_OUTPUT_LIMIT); // 现状兜底
}
```

- **UI 不受影响**:`tool_result` 广播在截断点之前、携带完整 output(`orchestrator.ts:370-376`),
  前端步骤展示照旧全文;spill 只改「回填模型上下文」的那一份;
- **缓存联动**:`toolResultCache` 是 runTask 作用域,缓存的 finalOutput(预览+指针版)
  TTL 内同签名复用,指针仍有效,无跨任务泄漏;
- web 层在 `agent-backend.ts` 构建 runTask options 时注入实现(写 `tool-output-store.ts`)。

### 4.3 指针消息格式(红线:不静默)

```
<头尾混合预览,复用 truncateToolOutput 语义、限额 SPILL_PREVIEW_LIMIT=4KB>
…[原输出共 123456 字符,已全量保存(引用 ref=call_1760...abc)。以上仅为头尾预览。
需要中间或指定位置内容:调用 read_tool_output(callId="call_1760...abc", offset=N) 窗口读取;
或用更精确参数缩小范围重查,不要整体重取]…
```

进历史体积 ≈ 4.5KB(预览 4KB + 指针说明),保护窗 10 条最坏 ≈ 45KB ——
较现状 160KB 降 ~72%,骑线病理直接缓解(§1.2);且指针文本远小于
`COMPACT_DIGEST_ENTRY_LIMIT=600` 的蒸馏截断损失面,压缩后指针仍可续读
(= Manus「可恢复压缩」:丢正文保引用)。

### 4.4 续读工具 read_tool_output(仿 read_mission/read_reference_material)

注册于 `tool-output-store.ts`,web 层随有 userId 的任务挂载(与 read_mission 同处接线):

```
read_tool_output(callId: string, offset?: number, limit?: number)
→ { success, tool, totalChars, offset, content, nextOffset?, note? }
```

- 默认 `limit=8000`(对齐 REFERENCE_CONTENT_LIMIT),返回窗口 + 剩余量 + nextOffset;
- callId 只允许来自本 userId 的 tool-output 目录(跨用户读取 = not-found,不泄漏存在性);
- 文件已过期/被清理 → `{success:false, message:'该输出已过期清理,如需请重新执行原工具获取'}`
  —— 诚实报错,不装有;
- 每次读取追加 audit 轨迹(对齐 appendRetrievalTrace 形态)。

### 4.5 清理策略

| 触发 | 动作 |
|---|---|
| 任务删除(已有「终态任务可删除」) | 级联删除 `tool-output/<taskId>/` 整目录 |
| 用户预算超限(默认 20MB/用户,`AGTPILOT_TOOL_SPILL_BUDGET_MB`) | 按 taskId 时间戳从旧到新整目录淘汰(LRU),audit 记一行 |
| TTL 兜底(默认 7 天,`AGTPILOT_TOOL_SPILL_TTL_DAYS`) | 读取时惰性判定过期 + 启动时清扫(挂 user-store 既有启动枚举路径) |

### 4.6 可观测性

- `audit/tool-output.jsonl`:spill 事件(callId/taskId/tool/originalChars)、读取事件
  (callId/offset/hit|expired|not-found)、清理事件(reason=budget|ttl|mission-delete);
- `TaskEfficiency` 新增可选字段(对齐 `reasoningPartsStripped` 先例,旧 mission 不受影响):
  `spilledOutputs?: number; spilledChars?: number;`
- `tool_result` 事件 payload 增 `spilled?: { callId, originalChars }`(前端徽章可后续做,事件先带)。

### 4.7 保险丝与降级

- `AGTPILOT_TOOL_SPILL=0` → web 层不注入回调,全链路回退现行 16KB 截断(零行为变化);
- 落盘抛错(磁盘满/权限)→ catch → 回退现行截断,**绝不因 spill 失败工具调用**;
- 回退路径的截断标记与现状逐字节一致(现有测试全绿即回归证明)。

### 4.8 范围边界(v1 不做)

- 层1 源头裁剪(各插件自报输出上限、MCP `maxResultSizeChars` 透传)—— 另立项,见 token 文档;
- 浏览器 PAGE_WINDOW 窗口机制不动(spill 在 orchestrator 统一截断点兜住所有工具最终输出,
  含 firecrawl 窗口后的结果;窗口本身是工具内行为,与 spill 正交);
- Code Mode / PTC —— 远期;
- 前端「已落盘」徽章 UI —— 事件已带数据,UI 后续单独做。

## 5. 测试计划

| 层 | 文件 | 覆盖 |
|---|---|---|
| core | `orchestrator-spill.test.ts`(stub harness 复用 orchestrator-reasoning.test.ts 模式) | 超限+有回调 → finalOutput 含指针与预览、回调收到全量原文;回调抛错 → 回退截断;无回调 → 现状逐字节一致;保险丝=0 → 不回调;efficiency 计数;≤16KB 不 spill;tool_result 广播仍带全量 |
| web | `__tests__/tool-output-store.test.ts` | 写/读往返、offset 续读窗口、跨用户不可读、路径穿越拒绝、TTL 过期诚实报错、预算 LRU 淘汰、任务删除级联、audit 轨迹逐行 |
| 回归 | core 141 + web 1206 全绿;`npx tsc --noEmit`(apps/web)exit 0;golden 零漂移 | |

## 6. 实施顺序

1. core:契约(TaskOptions.spillToolOutput)+ 截断点改造 + 指针文案 + efficiency 字段 + 测试;
2. web:tool-output-store.ts(存储/续读工具/清理/审计)+ agent-backend 注入 + 测试;
3. 文档:token-consumption-and-tool-loading.md 的 P1 行标记已实施并回链本文档;
4. 生产验证:跑一次雷达任务,看 `spilledOutputs`/`spilledChars` 与 input tokens 对比 73 万基线。
