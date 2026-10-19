# Token 消耗深度归因 + 工具挂载专题(选题 73 万事件)

> 记录日期:2026-10-17。触发事件:开源贡献雷达「选题」扫描任务单次 mission.usage 达 ~73 万
> prompt tokens(未到派发阶段)。本文两部分:①73 万的逐环节归因;②工具挂载专题
> (现状 / 业界对照 / 改造方案)。所有代码结论均附文件:行号,业界数字附来源链接。
> 状态:分析已定稿;工坊白名单(§9.1)、reasoning 剥离(§9.2)、层1 源头裁剪
> (§9.3)、层0 目录卡片 B v1(§9.4)与路由零命中收敛兜底(§9.5)已实施。余待拍板。

---

## 第一部分 · 选题 73 万 token 归因

### 0. 总账公式

**mission.usage.promptTokens = Σ 每一步模型调用的输入面值**。一步 = AI SDK agent loop
里的一次完整请求,重发「system + 工具 schema + 全部消息历史」
(`packages/core/src/orchestrator.ts:444-451`,AI SDK v5 streamText 语义)。

73 万的典型算术:**15~21 次调用 × 每次 4~5.5 万输入**。20 步上限
(`orchestrator.ts:26`,env `AGTPILOT_MAX_STEPS` 默认 20)× 每步 35~55k ≈ 70 万+,
再加步数耗尽后一轮未压缩全量的强制总结(`orchestrator.ts:610-653`)。

### 1. 每步输入的构成(雷达选题任务实测画像)

| 组成 | 估算 tokens/步 | 依据 |
|---|---|---|
| 工具 schema(挂载 80~100 个) | **10~27k** | `routing.ts:64-67` 生产实测:三字符闲聊付 45.8k 输入、135 个 MCP 工具 schema 占六成 ≈27k |
| 消息历史(压缩阈值 30k + 近 10 条原样保留) | 20~40k | `compaction.ts:33-40`;近期窗口常驻多个 16KB 级工具结果 |
| system 段(提示词 ~1.9k + 记忆块 + 技能卡 ≤1200 字符 + 派发历史 ≤50 条) | 4~6k | `task-system-prompt.ts:37-53`、`memory-service.ts:163-179`、`plugin-skill/cards.ts:113`、`runner-dispatch.ts:210` |
| 合计 | **35~55k(骑线时更高)** | |

### 2. 放大器排名(按贡献排序)

1. **结构性主因:每步全量重发 × 20 步,token 层面零熔断。**
   预算闸存在但默认关(`plugin-model/src/index.ts` `budgetMaxTokens = 0`),原唯一
   入口 `router_set_budget_limit` 已随 plugin-router 整包删除(2026-10-19 基线清理),
   `setBudget` 契约保留但无生产调用方;且 `usedTokens` 是**进程级跨任务串账**,
   即便重新接线也兜不住单任务。
   (**2026-10-19 已治理**:改走 per-call `tokenBudget` 任务级预算闸 + 子代理/蒸馏
   usage 入账总账,见 §9.6;进程级 `setBudget`/`usedTokens` 旧口径原样保留未动。)
2. **工具挂载面失控(雷达任务特有,详见第二部分)。**
   雷达 prompt 是「关键词磁铁」:仓库/PR/执行/网页/检索/调研/github/deepwiki 命中
   全部 route,把 GitHub 官方 MCP 全服务器(~30-40 个大 schema)+ browser(11)+
   sandbox(8)+ git(7)+ search(4)+ subagent 等全部拖进来;任务内「只扩不缩」
   (`orchestrator.ts:401-406`、`routing.ts:148-158`)。
3. **DeepWiki / GitHub MCP 输出无源头裁剪,压缩骑线压不动。**(已治理,见 §9.3)
   两者原样返回长文档/全字段 JSON(`plugin-mcp:396-399` `return await call(client)`),
   只有 16KB 统一兜底截断(`text.ts:6` `TOOL_OUTPUT_LIMIT = 16*1024`,头 70%/尾 30%),
   每条 ≈4k tokens;「最近 10 条原样保留」的保护窗(`compaction.ts:38`)让 3~5 个这种块
   常驻历史 → 历史长期骑在 30k 阈值上,中间区太小时压缩直接返回 null
   (`compaction.ts:75`),**骑线时每步重复触发蒸馏**,蒸馏调用的 usage 被丢弃不入账
   (`orchestrator.ts:775-784`)。
4. **reasoning 回流入上下文,永不截断。**(已治理,见 §9.2)
   生产实测单轮思考 10.8 万字(`task-system-prompt.ts:16-19` 注释);
   `@ai-sdk/deepseek`(dist:314-355)与 `@ai-sdk/openai-compatible`(dist:94-124)会把
   历史 assistant 消息里的 reasoning 部件重新序列化回后续每次请求,全仓无剥离代码;
   reasoning 还进 `mission.conversationMessages`(`orchestrator.ts:603-606`)跨轮重发。
5. **browser_navigate 把 screenshotBase64 塞进工具结果**(`plugin-browser:31,164-178`):
   每次导航 ~12KB base64 噪音 ≈3k tokens 纯浪费(截断后对模型零信息量)。(已治理,见 §9.3)
6. **强制总结轮**:步数耗尽后全量(未压缩)历史再发一次
   (`orchestrator.ts:603-653`),+30~50k。
7. **research_subagent 并行派发**:`prompt.main.md:29` 教模型「独立调研路一轮内并行派发」,
   4 并发 × 8 步 × 60k 上下文闸(`plugin-subagent/index.ts:43-47`;注意 60k 是消息体积闸
   非累计消耗闸,`runner.ts:294-311`),子循环 usage **不进 mission.usage**
   (`runner.ts:315-326` 没传 onStepFinish)——单轮最高 ~24 万账面外消耗;
   每份 ≤8000 字符报告回流主上下文并驻留近期窗口。
8. **旁路蒸馏全部暗账**:压缩蒸馏(`orchestrator.ts:773-785`)、任务末记忆/技能蒸馏
   (`memory-service.ts:1361-1365`、`plugin-skill/cards.ts:640`)usage 均被丢弃。

### 3. 记账口径(UI 上「73 万」的含义)

- 展示位:任务卡 `mission.usage.promptTokens / completionTokens`
  (`CockpitView.tsx:611-618`、`MobileActivityView.tsx:437-442`),每步实时入账
  (`orchestrator.ts:570-573` → `agent-backend.ts:298-310` → `mission-efficiency.ts:43-53`)。
- **既高估又漏计**:input 取 provider `prompt_tokens` 全价面值、含缓存命中部分
  (缓存价 ≈1/10,`@ai-sdk/deepseek` dist:805);同时子 agent/蒸馏/记忆旁路全部不入账。
- 前缀缓存:无任何显式 cache 配置,依赖 provider 自动前缀缓存;**压缩重写消息、
  路由扩容都会打破前缀 → 该步缓存 miss 全价重付**(`routing.ts:141-147` 注释即为此
  设计「只扩不缩」)。

### 4. 排除项(查过、不是问题)

- **github_scan 不是大户**:topics ≤5、reposPerTopic 默认 3(钳 30)、issue 检索合并一次
  per_page=50 单仓封顶 5、15 分钟进程内缓存 + orchestrator 只读结果 5 分钟复用
  (`github-scan.ts:27-33,187-189,229-255`;`orchestrator.ts:203-215`),
  一次 ≈2~4.5k tokens。它本身正是省 token 的改造(替代沙箱现写 Python 调 API)。
- **派发历史有上限**:`RADAR_HISTORY_LIMIT = 50`(`runner-dispatch.ts:210`),
  满额 ≈1.5~3k tokens,不会无限膨胀。
- **系统提示词每步 ~1.9k**:小头(×20 步后约 4 万,次要)。

### 5. 佐证样本(派发阶段,同类结构问题)

本机 runner 一份真实 transcript(milvus 派发任务,`~/.claude/projects/...0d119f0b...jsonl`):
135 次模型调用,**未缓存 input 275 万 + cache_read 565 万 + output 4.5 万**;
工具结果原始体积仅 179KB。派发环节走 claude-code SDK 路径,机制独立但结构问题同类
(每步全量重发),治理需另立专项。

---

## 第二部分 · 工具挂载专题

### 6. agtpilot 现状(packages/core/src/routing.ts)

- 目录 114 个工具(web 侧再叠用户已连 MCP 服务器,生产实测可到 135)。
- 阈值门:工具声明 tokens < 上下文 64k × 10% = 6400 时**全量挂载**(保前缀缓存);
  超了才路由(`routing.ts:56-60,102`)。
- 路由方式:插件自注册 `{test: 正则, prefixes: [...]}`,prompt 命中关键词 →
  **按前缀整组挂载**;拿不准(零命中)→ 全量兜底(`routing.ts:112-123`)。
- 闲聊短路:全串锚定问候语只挂 baseline(`routing.ts:69-77,108-110`)。
- 任务内「只扩不缩」:prepareStep 每步重算,仅扩容写回(`routing.ts:148-158`)。
- 缺 Key 工具不挂载(`routing.ts:170-187`)。
- `selectActiveTools` 支持 `explicit` 显式白名单(`routing.ts:92-98`),orchestrator
  已透传 `options.activeTools`(`orchestrator.ts:395-399`),**web 侧从未使用**。

三个结构性缺陷:
1. **挂载粒度太粗**——命中一个关键词把整台 MCP 服务器 30~40 个工具全挂上;
2. **正则关键词是磁铁**——雷达 prompt 天然命中 browser/sandbox/git/search/subagent 全部
   route(生产实测小红书任务挂 86~88 个,`loop-execution-optimization.md` P2);
3. **只扩不缩是单向棘轮**——任务内挂载面只增不减(缓存保护本身是对的,见下)。

### 7. 业界调研(2025-11 ~ 2026-10,均实抓官方页/论文)

#### 7.1 Anthropic(数字最全,形态标杆)

| 机制 | 工作方式 | 关键数字 |
|---|---|---|
| **Tool Search Tool**(2025-11-24 beta → **2026-02-17 GA**) | 工具标 `defer_loading: true` 不进 system 前缀;挂一个 ~500 token 搜索元工具(BM25 自然语言 ≤500 字符 / regex ≤200 字符);命中以 `tool_reference` **内联 append**(不破 prompt cache) | 5 台 MCP 58 工具 ≈55k tokens 定义;总上下文 **77k→8.7k(-85%)**;选择准确率 **Opus 4: 49%→74%,Opus 4.5: 79.5%→88.1%**;默认 top-5(limit 1~10000);deferred 目录上限 10000/请求;官方建议 ≥10 工具或定义 >10k tokens 才启用;**>30-50 个工具准确率退化** |
| **Programmatic Tool Calling**(2026-01) | 工具加 `allowed_callers: ["code_execution_20260120"]`,模型写 Python 在容器里调;**中间结果不进上下文不计费** | 示例 43588→27297(-37%);75 工具 PM agent 计费 -38%;agentic search +11% 性能/-24% input |
| **Code Execution with MCP**(工程博文 2025-11-04) | MCP server 表示为代码 API + 文件树,渐进披露按需读定义 | 工具发现 **150k→2k(-98.7%)** |
| **Mid-conversation tool changes**(2026-07 beta) | 应用侧显式 `tool_addition`/`tool_removal` 系统块(与 search 分工:search=发现,此=控制) | — |
| Claude Code 客户端落地 | MCP 工具**默认全部 defer**,只加载工具名+server instructions;`ENABLE_TOOL_SEARCH=auto` 可 defer 定义 ≥上下文 **10%** 才切换;server 级 `alwaysLoad`、工具级 `_meta["anthropic/alwaysLoad"]` 豁免;加载的工具驻留到 compaction,之后重搜 | 输出治理:`MAX_MCP_OUTPUT_TOKENS` 默认 **25000**、文本 >50000 字符**落盘只留路径**、Bash 内联 ~30000 字符;工具描述前置截 2048 字符(搜索加载 16384) |

定性建议(Effective context engineering / Writing tools for agents):上下文是边际收益
递减的有限资源;目标是「最小高信号 token 集」;反对 bloated tool sets,主张 minimal
viable set + 功能最小重叠 + 返回 token-efficient;工具响应建议截断在 25k tokens。

来源:
- https://www.anthropic.com/engineering/advanced-tool-use
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
- https://www.anthropic.com/engineering/code-execution-with-mcp
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://www.anthropic.com/engineering/writing-tools-for-agents
- https://code.claude.com/docs/en/agent-sdk/tool-search 、/docs/en/mcp 、/docs/en/env-vars

#### 7.2 OpenAI(2026 年跟进同形态)

- Function calling 指南:「Keep the number of initially available functions small」,
  **<20 个/轮软建议**;工具定义计入 context limit 按 input 计费;合并顺序调用的函数。
- **Tool Search**(Responses API,2026-03-05,gpt-5.4+):`defer_loading: true` +
  `{"type":"tool_search"}`;加载的工具放**上下文末尾以保 cache**;namespace 分组
  (<10 函数/组官方经验值)。官方未公布节省百分比(第三方测 ~47%)。
- **Programmatic Tool Calling**(2026-07-09,GPT-5.6):模型写 JS 在隔离 V8 里编排,
  中间结果留 runtime;Agents API 默认启用。
- MCP connector:`allowed_tools` 名单/filter 只导入子集;整 server 可 `defer_loading`。
- 每请求 **128 tools 硬上限**;Assistants API 2026-08-26 已 sunset。

来源:https://developers.openai.com/api/docs/guides/function-calling 、
/tools-tool-search 、/tools-programmatic-tool-calling 、/tools-connectors-mcp

#### 7.3 Manus(KV-cache 工程派)

- 「KV-cache hit rate is the single most important metric」;input:output ≈**100:1**;
  cached **$0.30/MTok vs uncached $3.00/MTok(10× 单价差)**。
- **Append-only 上下文**;文件系统 = ultimate context;压缩必须可恢复(丢正文保 URL)。
- **Mask, don't remove tools**:不动态增删工具定义(定义在上下文最前,改动使其后全部
  KV-cache 失效;历史引用已删工具诱发幻觉调用),用状态机 + 解码时 mask logits 收窄
  动作空间;工具按组命名(`browser_*`)做组级 gating。
- ⚠️ 流传的「hit rate <10%→39%、TTFT 2x」原文不存在,勿引用。

来源:https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus

#### 7.4 MCP 生态(协议不做,客户端/网关做)

- 规范层:三个过滤提案全部关闭(SEP-1300 Groups/Tags **rejected**、SEP-1821、SEP-1881);
  官方立场「not something we can bake into the protocol」。2026-07-28 版规范只加了
  `tools/list` 确定性排序(利于 prompt cache)+ `ttlMs`/`cacheScope`。
- **官方 Client Best Practices**(= 官方「工具太多」答案):
  ① Progressive Tool Discovery(轻量 `search_tools` 元工具,catalog→inspect→execute);
  ② Dynamic Server Management(按任务连/断整台 server);③ Code Mode(schema 生成
  类型化 API,模型写沙箱代码,~100k+ → ~200 token 脚本);**建议切换阈值 = 工具定义
  占上下文 1%~5%**;警告中途增删工具打掉前缀缓存。
- 网关:Cloudflare **Code Mode**(2500+ endpoints:**1.17M→~1k tokens,-99.9%**)、
  Cloudflare MCP portals(4 server 52 工具 9400→600,-94%)、Docker MCP Gateway
  (工具级黑白名单)、Portkey mcp-tool-filter(预计算 embedding,1000+ 工具→10-20 个,
  <10ms)。
- 客户端硬上限:**Cursor 40(超限静默丢,被社区批评)、Devin/Cascade 100、
  OpenAI 128**;Claude Code 靠 defer 支持目录 10000。

来源:https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices 、
https://blog.cloudflare.com/code-mode-mcp/ 、https://blog.cloudflare.com/enterprise-mcp 、
https://github.com/Portkey-AI/mcp-tool-filter 、https://docs.devin.ai/desktop/cascade/mcp 、
https://forum.cursor.com/t/increase-the-mcp-tool/69194

#### 7.5 学术界

| 工作 | 机制 | 关键数字 |
|---|---|---|
| ToolLLM/ToolBench(ICLR'24) | Sentence-BERT API retriever 检索 top-k | 16464 API;**top-k=5** 时 pass rate 反超 ground-truth 集合 |
| AnyTool(ICML'24) | meta→category→tool 三级分层检索 + self-reflection | 16000+ API;较 ToolLLM +35.4% |
| RAG-MCP(2025) | 工具描述建索引,运行时语义检索注入 | **现行摘要口径**:prompt tokens 2133.84→1084.00(**-50%+**),选择准确率 **13.62%→43.13%**。⚠️ 流传的 95.62%/-92% 系旧版口径,勿引 |
| MCP-Zero(2025) | 主动工具发现 + 分层语义路由 | token **-98%**,准确率降幅 ≤3% |
| MCPGAUGE(NeurIPS'25) | 系统评测 MCP 增益 | **全量注入平均 -9.5% 性能**(代码生成 -17%),输入 token 开销 3.25~236.5× |
| 微软 tool-space interference(2025-09) | 工具空间互扰实测 | 某些模型性能**最高 -85%**;1312 工具 775 重名("search"×32 台) |
| Tool-Use Tax(2026) | 仅暴露工具不调用 | Qwen3-4B GSM8K-SD 85.44%→52.08%(-33.36pp) |
| LiveMCPBench(2025) | 95 真实任务 | ~50% 失败 = 找不到正确工具 |

来源:arXiv 2307.16789 / 2402.04253 / 2505.03275 / 2506.01056 / 2508.12566 /
2605.00136 / 2508.01780 、
https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/

#### 7.6 其他产品

- **GitHub Copilot**(最完整第三方案例):内置工具 **40→13 核心 + 4 虚拟分组**;MCP 用
  embedding 聚类按需展开;Tool Use Coverage **94.5% vs 静态全量 69.0%**,SWE-bench
  +2~5pp,延迟 -400ms,TTFT -190ms;远程 `X-MCP-Tools` header 过滤,官方称省 60-90% context。
  https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/
- **Stripe Kai**(LangChain Deep Agents):500+ 内部 MCP 工具/1000+ skills,
  **skill 的 `allowedTools` 门控两遍式装载**(先选技能再拉工具);>150 skills 观察到
  前沿模型质量下降。https://www.langchain.com/blog/how-stripe-built-their-knowledge-ai-platform-on-deep-agents
- **LangGraph bigtool**:工具描述向量化,每轮模型调用前按 query 检索装载子集。
  https://github.com/langchain-ai/langgraph-bigtool
- **LlamaIndex**:`ObjectIndex` + `ToolRetriever`(向量索引,similarity_top_k=1~2)。
- **OpenAI Codex CLI**:config `enabled_tools`/`disabled_tools` + 单工具 `output_token_limit`。
- **Vercel AI SDK**:无内置动态选择;工具集在 generate/stream 启动时锁定
  (`prepareStep`/`dynamicTool()` 可切换,issue #11920)。

### 8. 共识提炼(六条)

1. **同时挂载数 ≤20~30 是准确率与成本的双赢线**(OpenAI <20 软建议、SEP-1300 ~10、
   Cline ~20、Anthropic 30-50、Cursor 40 硬限、微软实测 -85%)。挂多了不是「备用」,
   是又贵又笨(MCPGAUGE 净负收益、Tool-Use Tax -33pp)。
2. **小目录全量常驻保缓存,大目录按需装载**;10% 上下文是通用触发线
   (Claude Code auto 默认 10%,MCP 官方建议 1~5%)。我们的阈值门与 Claude Code 同源,方向没错。
3. **「按需」的正确形态是模型自主搜索(tool_search 元工具)或语义检索(embedding),
   不是宿主用正则猜**。Anthropic/OpenAI/MCP 官方/Copilot/bigtool 全部收敛到
   「defer + 搜索元工具 + 命中才展开」。
4. **append 而非 swap、工具列表字节稳定** → 保 prompt/KV cache(Anthropic tool_reference
   内联追加、OpenAI 加载放上下文末尾、MCP 规范确定性排序、Manus mask-don't-remove)。
   我们的「只扩不缩」与这条教义一致,**保留**。
5. **高频确定性流程固化为胖工具或代码化**(Code Mode / PTC:-98.7% / -99.9% / -37%)。
   github_scan 就是我们自己的成功案例。
6. **工具命名/描述质量决定检索命中率**(search_slack_messages > query_slack;
   LiveMCPBench ~50% 失败 = 找不到工具;ToolRet:43k 工具语料最强检索器 nDCG@10 仅 0.338)。

### 9. 改造方案(按落地顺序,待拍板)

**第一步 · 工坊显式白名单 + 挂载封顶(不动架构,预期砍掉 73 万的最大单项)**
- `skill.run()` 声明工具白名单 → `runMission` 透传 `options.activeTools`
  (`orchestrator.ts:399` 与 `routing.ts:92-98` explicit 参数均已支持,只差 web 接线);
- 雷达任务从 80~100 个缩到 ~15 个(github_scan + deepwiki 3 + search 4 + subagent +
  baseline),每步 schema 10~27k → ~3k,**20 步总账省 15~45 万**;
- 路由后挂载集封顶 ~30(超了按路由得分取 top-N,而非全收);
- 与 Stripe Kai allowedTools / GitHub Copilot 虚拟分组同构,业界已验证。

### 9.1 工坊工具白名单分配表(2026-10-17 负责人拍板「按你建议来吧」,已实施)

> 实施记录:分支 feat/workshop-tool-whitelist。weekly 拍板走 GitHub 精确名(5 个只读),
> novel/email_triage 按裁剪口径。落地形态:B 层检索组分档 `searchGroup:
> research / web / none`(research=三件套+子agent+firecrawl+参考资料,
> web=仅 search 三件套,none=不挂;原最重 full 档已于 2026-10-19 删除,见本节末增补);
> C 层特例表 `DEPS_TOOL_OVERRIDES`(email→固定三件、tomato_writer→空、
> **github_mcp→空即整台默认禁入**,需要 GitHub 的工坊在 D 层按精确名声明);
> 灰度保险丝 `AGTPILOT_WORKSHOP_TOOLS=0` 整体回退原关键词路由;
> 续聊继承:白名单按 `options.workshopId || mission.workshopId` 解析,
> 同 mission 的存草稿投递轮天然继承。测试:packages/core routing.test.ts
> (explicit 通配/baseline 并入/跨步稳定/零命中回退)+ apps/web
> tool-whitelist.test.ts(14 坊包含/排除/规模断言,GitHub 整台通配与
> sandbox 越界全仓禁入)。

白名单不逐坊手写全量,按「四层并集」自动派生:

- **A. baseline 常驻**(内核自动并入,工坊不声明):planner_create_plan /
  planner_update_task、artifact_render、connector_authorize、mcp_call、
  ask_user / confirm_plan、read_tool_output、workshop_deliver_field。
  > 2026-10-19 基线清理:router_select_tier / router_get_budget_status /
  > router_set_budget_limit(plugin-router 整包删除——用户连接器部署下
  > configOverride 永远压过 preferred,能级切换三重无效)、observability_get_trace /
  > observability_get_metrics(plugin-observability 整包删除——进程内 ring buffer
  > 唯二读者就是这两个工具)、codebase_search_symbols(从 plugin-git 删除——
  > grep 的是服务进程 cwd,Web 部署下即容器目录,检索不到用户代码);
  > memory_store / memory_recall 所属的 plugin-memory 整包删除——Web 侧三把
  > (store/recall/list)本就被用户空间同名 taskTools 覆盖,插件版唯一存活场景
  > 是 CLI 单用户;整包移除后用户空间版成为唯一记忆实现,跨用户泄漏路径
  > 物理消除。基线净省 ≈1060 tokens/步(插件注册表口径 2131→1070)。
- **B. 通用检索组**(按 searchGroup 档位):search_web / search_exa / search_tavily、
  research_subagent、browser_firecrawl_scrape、read_reference_material。
  > 2026-10-19 降载:社媒热榜 MCP(mcp_newsnow_* / mcp_zhihu_* / mcp_twitterapi_io_*)
  > 移出 B 层,一律经 C 层 deps 声明进入(单一事实源;见本节末增补)。
- **C. deps 映射**:`meta.deps` 连接器 id → `mcp_<id>_*` 前缀(deps 已是单一事实源,
  新工坊自动受益)。特例表:zhihu → zhihu_search / zhihu_global / zhihu_hot 三台;
  email → 固定工具 email_list / email_read / email_send(非 MCP);
  tomato_writer 本地 MCP 已撤,不映射。
- **D. 工坊额外声明**(下表「专属」列)。

| # | 工坊 | 专属(D) | 备注 |
|---|---|---|---|
| 1 | oss_radar | github_scan、mcp_deepwiki_* | GitHub MCP 整台不进;折中=精确名 mcp_github_mcp_search_issues / get_issue / list_commits 3 个。不挂 browser 全套 / sandbox / git |
| 2 | xhs | xhs_read_creator_data、xhs_save_note_draft | 续聊投递同 mission 继承 workshopId,白名单天然覆盖 |
| 3 | wechat_mp | wechat_mp_check_setup、wechat_mp_create_draft | |
| 4 | zhihu | zhihu_save_article_draft | |
| 5 | weibo | 无 | 纯 A+B(社媒热榜经 deps 已含 newsnow/zhihu/twitter/exa) |
| 6 | video(抖音/B站) | 无 | A+B |
| 7 | novel | mcp_fanqie_radar_*(榜单选题) | B 组裁剪:只留 search 三件套,不要推特热榜;写作/入库走服务端不经工具 |
| 8 | weekly | mcp_atlassian_*、mcp_lark_suite_*、mcp_dingtalk_* + email_list / email_read | GitHub 已拍板:只读精确名 5 个(list_commits / search_issues / list_pull_requests / get_pull_request / get_file_contents),整台不进 |
| 9 | ppt | ppt_check_env、ppt_publish_deck、ppt_publish_pptx + sandbox_run_command / sandbox_write_file | 唯一保留 sandbox 的工坊(prompt 明确引用) |
| 10 | email_triage | email_list / email_read / email_send | B 组裁剪:分诊不需要热榜,A+email 三件 |
| 11 | follow_builders | follow_builders_fetch_feed | twitter 经 deps 保留;newsnow/zhihu 不再白背(降载) |
| 12 | invest | deps 映射:tushare、a_stock、alphavantage_mcp、coingecko_mcp | +B(research 档;财经热榜 newsnow 经 deps 保留,zhihu/twitter 不再白背) |
| 13 | edu | deps 映射:openalex、alphaxiv、huggingface_mcp、deepl_mcp | +B(research 档;社媒热榜全不挂) |

挂载数预估:雷达 ~20、内容工坊 ~25-30、weekly ~35(GitHub 整台时超 30-40 安全线,
可用精确名压回)、novel/email_triage ~15 以下。

灰度顺序:oss_radar(事发地先止血)→ 内容四坊(xhs/wechat_mp/zhihu/weibo)→ 其余;
每坊上线前加一条「生产 prompt → 挂载数断言」测试。(实施时收敛为单 PR 全量声明 +
`AGTPILOT_WORKSHOP_TOOLS=0` 保险丝,灰度改由部署观测承担。)

已拍板(2026-10-17「按你建议来吧」):① weekly GitHub 走精确名;② novel /
email_triage 按裁剪口径。

**增补(2026-10-19 token 盘点放大器④,负责人拍板「改吧」)——full 档降载**:
16 坊中 9 个 meta(xhs/weibo/zhihu/wechat_mp/video×2/follow_builders/invest/edu)
原未声明 searchGroup,隐式落到最重 full 档 —— B 层直挂社媒热榜 MCP 通配
(newsnow/zhihu/twitterapi_io,~2-8k tokens/步,且通配挂载在测量口径里不可见)。
改动:① full 档与 `?? 'full'` 隐式兜底删除,`searchGroup` 改**必填**(新工坊
必须显式选档,编译期兜底);② 9 坊逐个显式声明 research 档;③ 社媒热榜 MCP
一律经 C 层 deps 进入(单一事实源)。功能零损失:社媒六坊(xhs/weibo/zhihu/
wechat_mp/video×2)deps 本就声明三台社媒,挂载集合不变;真实收益在
follow_builders(只留 twitter,deps 如此声明)、invest(只留 newsnow 财经热榜)、
edu(社媒全不挂)。测试:tool-whitelist.test.ts 重写 B 层口径块(17 例全绿,
新增「社媒只经 deps 进入」「invest/edu 不白背」断言);apps/web tsc 通过。

**增补(2026-10-17 负责人:「子agent的工具绑定逻辑也要跟主agent一样吧」)**:
plugin-subagent 挂载面与工坊白名单对齐 —— `TaskOptions.activeTools` 透传进
`ToolSession.activeTools`,子 agent 在只读双层白名单之上再取「候选 ∩ 工坊白名单」,
匹配复用 core `resolveExplicitTools`(精确名 / `前缀*` 通配 / baseline 自动并入,
与主循环单一事实源)。主循环整台禁入的 github_mcp 子循环同样禁入(此前子 agent
经双钥匙可达其只读件,是唯一绕过工坊白名单的口子);非工坊任务不受影响。
详见 `subagent-plugin-spec.md` §4.3 对齐条目。

**第二步 · 自有 tool_search 元工具(provider 无关,照 Anthropic GA 形态)**
- 超阈值后非 baseline 工具全部不挂,挂一个 `tool_search`(目录 = name+一句话描述紧凑
  索引,114 个 ≈3~4k);BM25/关键词检索,命中 top-5 以 **append** 方式并入 mounted
  (复用现有 widenMountedTools,缓存只破一次);压缩时可选回收、重搜再装;
- 工具描述前置截 2048 字符(Claude Code 同款);命名改造提升命中率。

**第三步 · 路由正则与 MCP 粒度收紧(过渡期止血)**
- 「执行/代码」不再命中 sandbox、「网页」不拖全组 browser;
- MCP 服务器内按 annotations/只读白名单做工具级筛选(只挂检索类,不挂整台)。

**第四步 · 远期**
- GitHub MCP 等大户走 Code Mode(我们有 sandbox;把「搜 issue/查 repo」合并成 1~2 个
  胖工具后整台服务器可以不挂);
- 关键词正则 → embedding 语义检索(bigtool/RAG-MCP 式);
- 对齐 Anthropic mid-conversation tool changes 的「控制」语义(权限回收/模式切换);
- 会话数据「单一事实源 + 双投影」重构(2026-10-17 负责人提议):只存一份原始
  消息/事件流,UI steps 与模型上下文都做成动态组装的投影视图(发模型时才剥
  reasoning、压缩——Claude Code transcript 同形态)。前置约束:①事实源必须无损
  (现有 steps 是展示有损投影,不能直接当源);②conversationMessages 现兼崩溃
  检查点续跑状态与压缩纪要存放,需一并重构;③收益是磁盘与架构纯度,token
  端已由 §9.2 剥离解决(reasoning 大头不再双份)。

**配套的 token 治理(与挂载专题独立,见第一部分放大器 3~8)**
- P0:browser_navigate 剥离 screenshotBase64(**已实施**,§9.3 ①);DeepWiki/GitHub MCP
  源头字段裁剪(**已实施**,§9.3 ②③);任务级 token 预算闸(**已实施**,§9.6:
  不改进程级 usedTokens,直接 per-call tokenBudget 接线);
- P1:重发前剥离历史 reasoning(**已实施**,见 §9.2);近期 10 条窗口内超大 tool_result 二次截断(~4KB)
  (**已实施**,由 spill-to-file 方案覆盖并超出:超限输出全量落盘 + 进历史的换成
  ~4.5KB「预览+指针」,保护窗最坏 160KB→45KB,截断部分从永久丢失变可恢复续读,
  见 `tool-output-spill.md`);子 agent/蒸馏 usage 计入 mission.usage(**已实施**,§9.6);
- P2:UI 分列缓存命中/全价;环节级 token 看板(schema/历史/system/工具结果四栏)。

### 9.2 reasoning 剥离(2026-10-17 负责人点题「思考剥离吧」,方案确认后实施)

> 放大器 4 的治理。实施记录:分支 feat/strip-reasoning(基于工坊白名单分支)。

**机制**:`packages/core/src/reasoning.ts` 纯函数 `stripReasoningParts(messages)`
→ `{messages, stripped}`:只删 assistant 消息数组 content 里的 `type:'reasoning'`
部件,text/tool-call 原样保留(工具配对不破);浅拷贝不改原对象;幂等 —— 无可剥
内容返回原数组引用,调用方以引用相等免写回。

**orchestrator 三道闸**:
- 闸1 入口:`historyMessages` 拼 baseMessages 前剥离 —— 剥离上线前落盘的存量
  mission 续聊轮不再把历史思考重发回 provider;
- 闸2 循环内:prepareStep 每步剥离,**放在压缩之前** —— 蒸馏输入(messageText
  对数组 content 做 JSON.stringify)同步干净,不再为思考文本二次付费;幂等性
  保证改写只发生在最新一条 assistant 消息,已剥历史前缀跨步字节稳定,
  provider 前缀缓存只在尾部破一次(append-only 教义不冲突);
- 闸3 装配:`responseMessages` 并入 conversation 前剥离(SDK 返回的 responseMessages
  保留全部步的 reasoning,闸2 只覆盖步前可见消息)→ 强制总结 invokeStep、
  task-end 压缩、result.messages 落盘(mission.conversationMessages)、跨轮重发全干净。

**安全性核实**(实施前逐路查证):
- DeepSeek 官方口径 reasoning_content 多轮无需回传;当前 thinking.ts 三分支
  (openai/deepseek/openai-compatible)均不依赖历史 reasoning;
- UI「思考过程」展示走 assistant_delta 事件流(kind:'reasoning')实时累积进
  mission steps,**不读消息历史** —— 剥离后前端照常显示思考;
- ⚠️ 边界:未来接 Anthropic(thinking+tool_use 要求保留 thinking 块)或
  OpenAI o 系列(加密 reasoning items)必须按 provider 分支门控,勿全局放开
  (reasoning.ts 头注已留标记)。

**保险丝**:`AGTPILOT_STRIP_REASONING=0` 三道闸整体回退原行为。
**可观测**:`TaskEfficiency.reasoningPartsStripped`(可选字段,三闸合计)随
done 事件落 mission,生产可验证剥离量。
**测试**:reasoning.test.ts 9 例(纯函数不变量)+ orchestrator-reasoning.test.ts
6 例(三道闸行为、前缀引用稳定、保险丝、tool-call 配对完好);core 141 /
web 1206 全绿,golden 快照零漂移。
**范围注记**:plugin-subagent 子循环最初未经三道闸(其 reasoning 仍在子循环内回传);
2026-10-17 负责人点题「子agent也把思考剥离吧」已补齐 —— 子循环闸:runner.ts
prepareStep 步前剥离(**放在 60k token 闸之前**,思考文本不再虚占预算)+ 强制收敛
invokeStep 消息同剥(闸3 同款);transcript 落盘保持无损原文(观测记录不回传模型,
事实源无损原则);保险丝 `AGTPILOT_STRIP_REASONING=0` 对子循环同样生效;
可观测:`SubagentRunMeta.reasoningPartsStripped`(>0 才写)。测试 runner.test.ts
「3.5 reasoning 剥离」6 例。

**配套修复(2026-10-18 负责人拍板「修」)**:plugin-model 的 prepareStep 包装层
旧实现 `if (result.activeTools?.length)` 把返回的 `activeTools` 按 falsy 丢弃 ——
子 agent token 预算闸的「收掉全部工具」收敛信号(`activeTools: []`)在生产静默
失效(只剩注入的收敛提示消息起作用,工具照挂,预算触顶后模型仍可继续检索)。
修复:适配逻辑抽为纯函数 `adaptPrepareStepResult`(plugin-model/src/index.ts)——
显式空数组透传;非空声明但名字全部不在本次工具表 = 无效输入,维持现状(不得
误发收工具语义);主循环不受影响(routing prepareStep 从不返回空数组)。
测试:plugin-model prepare-step.test.ts 6 例。

### 9.3 层1 源头裁剪(2026-10-17 负责人拍板「那就把层1完整的做完」,已实施)

> 三层漏斗的层1:在噪音**产生的地方**就不让它进模型上下文。此前仓内只有
> github_scan 一个成功案例(胖工具,单次 2~4.5k);spill-to-file(§9 P1)是层2
> 兜底 —— 但 16KB 以下的噪音(截图 base64 ~12KB、GitHub 全字段 JSON)够不着
> spill 阈值,原样常驻历史,且通用头尾截断不是语义裁剪,模型续读一次
> read_tool_output 又是一整步 16~25k。本节三件套补齐层1。

**① 截图剥离(放大器 5 治理)**
- `browser_navigate` / `browser_screenshot`(plugin-browser)与 `xhs_read_creator_data`
  (web 托管读工具)的**工具返回值**不再携带 `screenshotBase64`(~12KB base64 ≈3k
  tokens,对文本模型零信息量)。
- UI 安全性核实(实施前逐路查证):驾驶舱视口读的是 `viewport_update` **事件流**
  (`agent-backend.ts` viewport_update 分支 → `state.viewport` → CockpitView),
  全仓组件对工具返回里的 base64 **零消费**(仅 XhsWebLoginModal 读登录帧事件);
  服务层 `navigateAndDistill`/`captureFrame` 契约不变(登录通道、事件通道照常拿截图)。
- **有意保留**:存草稿类写工具(xhs_save_note_draft / zhihu_save_article_draft /
  fanqie_save_chapter_draft / script-skills)的截图是**人工核对交付物**(测试锁死的
  产品契约),且写路径低频(每日上限)—— 不剥。读路径高频才是治理对象。
- 测试:plugin-browser 首个测试文件 `index.test.ts` 3 例(playwright 全 mock;
  返回值零 base64 + 事件通道携带 data URI + 服务层契约不变);
  web `xhs-managed.test.ts` 增读路径剥离断言。

**② ToolDefinition.outputCap(工具级输出限额机制)**
- `contracts.ts` 新增可选 `outputCap?: number`;生效限额 =
  `min(outputCap, TOOL_OUTPUT_LIMIT)`(`text.effectiveOutputLimit`,单一事实源),
  编排器截断点与 plugin-subagent 内部截断**共用同一函数**。
- 语义:cap 只压「进模型」的一份 —— 超限仍**先试 spill 全量落盘**(无损、可
  read_tool_output 续读),回退头尾截断按 cap;`tool_result` 广播始终全量原文
  (UI 不受影响)。未声明 outputCap 的工具行为与从前逐字节一致。
- 声明方:MCP 连接器注册时代设(见 ③,与客户端 cap 同值双保险);内置工具
  按需自选(现无 —— 读路径均有 4000 字符窗口/github_scan 已瘦身)。
- 测试:core `text.test.ts` effectiveOutputLimit 3 例 + `orchestrator-outputcap.test.ts`
  5 例(cap 截断/ spill 优先/未声明不变/低于 cap 不触发/超 16KB 压顶);
  plugin-subagent `runner.test.ts` 子循环同源限额 1 例。

**③ MCP 客户端统一输出治理(放大器 3 治理,业界同构)**
- `plugin-mcp/src/output-cap.ts`:`callTool` 返回后、进编排器前统一裁剪
  (`capMcpToolResult`,纯函数,首调 + 重连重试两处都包)。三层动作,全部带
  「不静默截断」标记:
  1. 非文本 content(image/audio/二进制 resource)→ 文本占位(文本模型面,
     base64 帧与 ① 同一裁定);
  2. JSON 文本字段压缩:content.text 可解析为 JSON 时递归截短超长字符串字段
     (GitHub MCP 的 body/body_html 是典型肥大字段),结构/数字/短字段原样;
     `structuredContent` 同治(编排器 JSON.stringify 整个返回对象,双投影双份付费);
  3. 文本总量 cap:统一 env `AGTPILOT_MCP_OUTPUT_LIMIT`(默认 12000 字符,
     0 = 关闭;业界锚 Claude Code `MAX_MCP_OUTPUT_TOKENS`=25k tokens)+
     per-server 规则表 `SERVER_OUTPUT_RULES`(deepwiki 8000 头保留;
     github_mcp 字段压缩 400)。
- 被裁剪时返回值附 `_agtpilotTrim` 元数据(server/originalChars/limit),审计可见。
- 无损性取舍:cap 后 MCP 输出不再触发 16KB spill(已小于阈值)—— 有意为之,
  MCP 查询只读可重放,与 Claude Code 客户端侧截断同构;标记内写明「携带更精确
  参数缩小范围重查」。
- 测试:`output-cap.test.ts` 14 例(env 保险丝/per-server 上限/纯函数不动入参/
  短输出零变化/头保留标记/多段预算分配/非文本占位/github JSON 字段压缩 +
  structuredContent/Markdown 不字段压缩/isError 不豁免)。

**层1 完成度自查(对照 §9 第一步~第四步)**:读路径截图 ✅、工具级限额机制 ✅、
MCP 统一 cap + deepwiki/GitHub 裁剪 ✅。任务级预算闸(放大器 1)已于
2026-10-19 落地(§9.6)。余(不在本次范围):search 类结果字段瘦身、层1 规则表随新连接器扩充。

### 9.4 层0 工具卡片化(schema 渐进披露)——测量先行(2026-10-18 负责人点题「能否将工具做成跟 skill 一样,只把卡片加到上下文,需要时再加 schema」,拍板「搞」)

**机制设计(v1 已按此通道实施,见本节末「B v1 已实施」)**:

- 业界锚:Anthropic Tool Search Tool(`defer_loading`,官方宣称大 MCP 工具集省
  ~85% 上下文)、Claude Code 的 MCP 工具按需检索、OpenAI Tool Search(§7.2);
  终局形态 = Code Mode(工具变运行时函数,schema 彻底退出 prompt,负责人 backlog)。
- 与 skill 渐进披露的本质差异:skill 是纯文本内容,任意时刻可注入;工具 schema
  必须进 API tools 块模型才能发合法 tool_call。但 **AI SDK `activeTools` 语义
  (不在名单的工具不上线)+ plugin-model 每步 prepareStep 重算可见集**就是现成
  通道(2026-10-18 修复的 `adaptPrepareStepResult` 透传即此通道):
  1. 工具分两档:baseline+高频常驻全量 schema;长尾/MCP 大户只进「目录卡片」
     (名字+一行用途,实测均值 ≈37 tokens/把,见下);
  2. 新增 `load_tools` 元工具:模型看目录点名 → execute 记入共享状态 → 下一步
     prepareStep 将其并入 activeTools,schema 才真正上线;
  3. core 零改动,全在包装层;与现有关键词路由/工坊白名单是同一机制,只是把
     「谁决定挂什么」从关键词换成模型自己。
- 三个坑(立项前必须量化):① 额外一跳(load = 多一步延迟+token,常驻集选不准
  就倒亏);② tools 块步间变化破前缀缓存(API 请求布局 tools 在最前,一变则
  system+messages 全部 cache miss;Anthropic 官方方案保 tools 块稳定、把检索到的
  schema 以 tool_result 文本喂回,可借鉴;deepseek 隐式缓存净损益需实测);
  ③ 目录纪律(一行描述不够短,省的被吃回去)。

**测量工具(已实施 2026-10-18;口径修复 2026-10-19,见本节末)**:两段式,可重复跑——
- 第 1 段 `pnpm measure:tools`(= `npx tsx scripts/tool-schema-measure.mts`):启动
  app-kit 真实注册表(EXA/TAVILY/FIRECRAWL 假 key 对齐生产注册面;只读注册表,
  不执行工具),按「name+description+parameters 序列化」计每把工具上线成本;
  估算口径 CJK 字符 ×1.0 + 其余 ÷4(单一事实源 `scripts/tool-schema-est.ts`,
  两段共享);产物 `scripts/out/tool-registry-measure.json`(不入库);
- 第 2 段 apps/web vitest `src/workshops/__tests__/tool-schema-cost.measure.test.ts`
  (`pnpm measure:workshops`):消费 JSON,用与生产同一代码路径
  (`resolveWorkshopActiveTools` 四层并集 + 内核 `resolveExplicitTools`)算每坊
  每步 tools 块成本与卡片化理论上限;**2026-10-19 起并入用户级 taskTools 表面**
  (记忆五件套 / read_tool_output / ask 桥 / cron 三件 / connector 桥 / 交付字段 /
  TOOL_PROVIDER 固定工具——现场用生产同款 builder + stub 依赖构建,这些从不进
  全局注册表,第 1 段对其不可见);`MEASURE=1` 打印表格,JSON 缺席时工坊合并
  表格 skip、用户级表面测量恒跑;
- 一键生产口径 `pnpm measure:all`:服务器端(MCP 连接器已连接)跑第 1 段 +
  第 2 段,mcpToolCount 与 mcp_* schema 成本才入表(本地/CI 恒为 0,表格是下限)。

**静态测量结果(2026-10-18,内置口径——本地无 MCP 连接器,mcp_* 缺席)**:

| 口径 | ≈tokens/步 |
|---|---:|
| 内置注册表 48 把全量挂载(最坏情形,回到白名单之前) | 7658 |
| 内容/调研工坊白名单挂载(16 把,xhs/雷达/投研/教研等同值) | 3105 |
| novel/ppt(web/生成档,14~16 把) | 2634~2995 |
| email_triage/weekly(none 档,仅 baseline 11 把) | 2131 |
| baseline 常驻块(每任务固定成本) | 2131 |
| 内置全部非常驻工具卡片化(理论上限,零 load 假设) | 省 ≤791(≈25%) |

单工具前 5 贵:sandbox_http_request 433、planner_create_plan 397(baseline)、
artifact_render 393(baseline)、search_web 312、research_subagent 302。

**静态结论(数据说话)**:
1. 工坊白名单(§9.1)已把内置 tools 块从 ~7.7k 压到 ~3.1k/步;**内置工具再
   卡片化的理论上限只有 ~791 tokens/步(25%)**,扣掉 load 额外一跳与缓存破裂
   成本,内置侧不值得全面卡片化;
2. 真正的大头在 **MCP 侧**:73 万事件已证 github_mcp 30~40 个大 schema 是最大
   单项放大器(白名单已把整台禁入收敛到精确名 3 个),newsnow/deepwiki/
   twitter 等检索组 MCP 的 schema 成本本地测不到——**生产口径必须服务器端
   已连接状态重跑第 1 段补测**;
3. 立项前置数据 = 两个:① MCP 精确名工具的 schema 成本(服务器端补测);
   ② 工具命中分布(真实 run 里每把工具的调用率——没被用的 schema 才是纯浪费,
   命中率高的就该常驻)。②需要 run 事件数据或加打点,拿到后再定卡片化名单。

**B v1 已实施(2026-10-18 负责人拍板「搞」;此前一问「B 必须要服务端测试后
才能做吗」→ 结论:补测数据用于调优,不构成门槛,直接开工)**——菜单点菜制,
范围按批准的 v1 收口:

- **只收编 MCP 工具**:plugin-mcp `buildToolDefs` 给每把连接器工具自声明
  `catalogable: true` + `catalogGroup: <服务器名>`(contracts.ts 新增字段,与
  baseline/fallback 同款自声明模式,内核零插件知识);内置工具不动(静态结论 1:
  内置侧卡片化上限 ~791 tokens 不值得)。
- **目录注入面**(orchestrator runTask):自由任务(无工坊白名单、路由已启用
  `routedTools !== undefined`、非闲聊短路)里,未被挂载的 catalogable 工具按
  服务器分组、一行一把(`- 名字: 用途首句 ≤60 字`,剥 `[MCP连接器: x]` 行内
  重复标签)进系统提示【按需工具目录】段。零命中与关键词命中档都注入;工坊
  白名单/全量挂载档/闲聊档不注入。目录每任务构建一次、输入序=声明序,跨步
  字节稳定(前缀缓存纪律)。
- **load_tools 元工具**(core/tool-catalog.ts `createLoadToolsDefinition`):
  任务级合成、不进全局注册表(子 agent 天然不可见,双钥匙语义不变);
  readOnly+low(纯挂载申报,走只读并行门与既有包装管道——广播/熔断/截断
  照常);点名只认目录内名字,目录外如实报 unknown 不放行;模型点名 →
  `loadedToolNames` → 下一步 prepareStep 与 widenMountedTools 共用同一次
  写回并入挂载面(schema 上线,缓存至多破一次)。
- **观测**:每次 load_tools 调用发 cordis 自定义事件 `agtpilot/tool-catalog`
  (`{taskId, step, loaded, unknown}`,不进 SSE、AgentEvent 封闭集不动)——
  这就是立项前置数据②「命中分布」的自动采集通道,欠的账由 B 自己补上。
- **保险丝**:`AGTPILOT_TOOL_CATALOG=0` 不注入目录也不注入 load_tools,行为
  回到 §9.5 止血 A 现状(调用时读 env,热切)。
- **危险语义零变化**:挂载 ≠ 执行,被点名工具真正调用时仍过既有审批门
  (dangerLevel high 挂起审批)、MCP 输出治理(outputCap)与只读分类。
- 静态收益口径:135 把 MCP schema ≈27k tokens/步 → 目录卡片 ≈37 tokens/把
  ×135 ≈ 5k/步(且只进 system 一次、跨步稳定),自由任务每步净省 ≈22k;
  点菜一跳的代价 = 一次 load_tools 调用 + 扩容步一次缓存重建。
- 测试:tool-catalog.test.ts 16 例(保险丝/卡片行/分组/目录字节稳定/点菜
  语义含 unknown、alreadyMounted、空参)+ orchestrator-catalog.test.ts 10 例
  (注入面五档 × 点菜流程 × 广播管道 × 效率统计口径);core 191 全绿。
- v1 明确不做(留给数据说话后的 v2):内置工具卡片化、目录按命中分布自动
  排序/裁剪、load 的跨任务预取(高频点名工具晋升常驻)。

**口径修复与复测(2026-10-19,⑤ 测量脚本修口径)**:此前两段测量有三处系统性
低估,已修复并复测(基线 add6045 工具清理后):
1. **本地 JSON 过期**:旧表基于清理前注册表(48 把 / 内置 baseline 2131);
   复测后 39 把 / 全量挂载 6547 / 内置 baseline **1070** tokens/步。
2. **用户级 taskTools 从不入账**(最大缺口):agent-backend 每任务现场装配的
   26 把用户级工具(合计 ≈6462 tokens)第 1 段全部不可见,其中 baseline 六件
   (ask_user 649 / confirm_plan 326 / workshop_deliver_field 327 /
   connector_authorize 299 / read_tool_output 234 / mcp_call 173)穿透一切
   工坊白名单,**每任务每步固定 ≈2008 tokens**——旧每坊表格全部少算这一块;
   记忆/cron 工具非 baseline,只在自由路由任务出现(自由路由最坏情形
   ≈6547+6462=**13009** tokens/步)。修复后每坊合并挂载面:novel 3581 ~
   wechat_mp 5040 tokens/步(xhs/zhihu 托管 provider 本地缺凭证构建 0 把,
   表格显式标注低估项;服务器端 `pnpm measure:all` 取生产口径)。
3. **MCP 生产口径没有入口**:一直是「服务器端补测」的口头约定;现已固化为
   根 package.json 一键脚本(measure:tools / measure:workshops / measure:all)。

### 9.5 路由零命中收敛兜底(快速止血 A,2026-10-18 负责人盘点路由后拍板「搞」= C 方案:A 先落、B 等 §9.4 数据立项)

**诊断(路由全链路盘点)**:自由任务(非工坊白名单、非闲聊短路)的关键词路由是
「全有或全无」——
- 9 条插件正则零命中 → `selectActiveTools` 返回 undefined **全量挂载**:生产
  内置 48 把 + MCP 连接器 135 把 ≈35k tokens/步,每步重付(「你是谁」45.8k 实测
  的主放大器;闲聊短路只堵 ≤24 字符全串锚定那一小类,「讲个笑话」「你是谁的
  作者」都落全量档);
- 命中任一条 → 只挂命中组 + baseline,但 **135 个 MCP 工具不属于任何 route**
  (`mcp_connect_` 只管连接器管理件)——自由任务一旦走命中分支,MCP 整体缺席,
  中途 prepareStep 重算也补不进来(重算用的是同一批正则)。

**修复(A,本次实施)**:零命中分支不再全量,收敛为
`baseline ∪ fallback ∪ prompt 显式点名的工具`:
- `ToolDefinition.fallback?: boolean`(contracts.ts,与 baseline 同款插件自声明
  模式,内核零插件知识):检索组自标——search_web/search_exa/search_tavily
  (plugin-search)、research_subagent(plugin-subagent)、browser_firecrawl_scrape
  (plugin-browser)、read_reference_material(web 宿主);缺 Key 的仍被
  filterToolsByEnv 剔除,fallback 不绕过 Key 门;
- 返回序 = 目录声明序(跨任务字节稳定,保 provider 前缀缓存);
- 漏挂补救沿用既有机制:prepareStep 每步用近 8 条消息重算 + widenMountedTools
  只扩不缩(工具结果里出现 URL → 浏览器组扩进来,扩容步破一次缓存);
- 保险丝 `AGTPILOT_ROUTE_FALLBACK=full` 恢复旧全量兜底(每次调用读 env,热切;
  缺省 lean);
- 命中分支与显式白名单分支语义零变化(fallback 只在零命中档生效)。

**明码代价**:自由任务的 MCP 从「零命中全量时碰巧可用」变为「统一不挂」——
27k tokens 的 MCP schema 磁铁正是本刀要杀的;MCP 的自助通道 = B(§9.4 目录
卡片 + load_tools,模型看菜单点菜)——**已于同日实施(§9.4 B v1),本代价
由目录通道闭环**。工坊任务不受影响(白名单 C 层 mcp_<id>_* 照旧)。

**测试**:routing.test.ts 新增「零命中收敛兜底」5 例(baseline+fallback 声明序 /
点名并入 / widen 兼容 / 空目录保守回全量 / 命中分支不受 fallback 影响)+ 既有
全量兜底断言 3 处改收敛口径 + full 保险丝 1 例;core 165 全绿。

### 9.6 任务级 token 预算闸 + 全口径记账(2026-10-19 负责人听放大器盘点后拍板「做吧」= 方案A重新接线 + ①记账,已实施)

**背景**:放大器 1(token 层面零熔断)与放大器 8/10(子代理 ~240k/轮、压缩蒸馏
3-4 次/任务均不入账)合并治理 —— 先能看见每个任务烧了多少(记账),再用预算封顶(闸门)。

**① 全口径记账(mission.usage 从「主循环可见部分」变成「任务真实总账」)**
- 子代理:plugin-subagent 结束/失败时本就 `ctx.emit('agtpilot/subagent', {phase, parentTaskId, usage, ...})`
  (子循环直连 `model.runAgentLoop`,不经 orchestrator,天然无 `agtpilot/usage` 事件、
  不会双计)——agent-backend 新增订阅,finished/failed 的 usage 经 `accumulateMissionUsage`
  并入父任务总账并广播 `mission_usage`。
- 压缩蒸馏:`compactConversation` 的 summarize 回调拿到 `invokeStep` 返回的 usage 后,
  经既有 `agtpilot/usage` 通道按 `options.taskId` 上报(TaskOptions 新增可选 taskId 透传)。
- 有意留白:记忆/技能卡蒸馏(无任务上下文,不属于 mission 账)、runner 派发(另项目)。

**② per-call 预算闸(不改进程级旧账,并发安全)**
- 契约:`AgentLoopOptions.tokenBudget`(单次调用 prompt+completion 累计上限,循环内
  逐步实时记账;0/缺省 = 不设限)+ `TaskOptions.tokenBudget` 透传。策略(额度多大)归
  应用层,网关只执行(反模式 #10)。
- 网关(plugin-model):`loopTokens` per-call 计数器(onStepFinish 累加),停循环判定抽为
  纯函数 `shouldStopAgentLoop`(步数闸 / per-call 预算闸 / legacy 进程级闸三合一,
  loop-stop.ts);触顶 → `finishReason 'budget-exceeded'` + `stepsExhausted` → 上层强制
  总结轮诚实收尾(orchestrator needsWrapUp 既有链路,零改动)。旧 `setBudget/usedTokens`
  原样保留(诚实失败:不假装删除无调用方的契约)。
- 应用层(agent-backend):每轮 runTask 前 `computeMissionTokenBudget(mission.usage, cap)`
  = 总账上限 − 已花;cap 来自 `AGTPILOT_MISSION_TOKEN_BUDGET`(默认 300k,显式 0 = 关闸)。
  **余额耗尽钉 1 而非 0**(0 在网关语义 = 不设限,会静默放开烧)——最多再走 1 步即触顶收尾。
- 记账与闸门闭环:子代理/蒸馏入账 → 下一轮预算自动扣除 → 总账口径封顶。

**测试**:plugin-model loop-stop.test.ts 7 例(三道闸独立/预算 0-缺省-负数=不限/per-call
隔离),plugin-model 31 全绿;core 191 全绿(orchestrator 透传+蒸馏上报不破坏既有用例);
web mission-efficiency.test.ts 新增 11 例(缺省 300k/余额扣减/关闸/钉 1/负余额防御/
NaN 兜底/向下取整/env 解析合法-非法-显式 0)21 全绿;apps/web `tsc --noEmit` 通过。
本地 `next build` 受宿主 1.6GB 内存限制无法验证(OOM,既有环境问题)。修正(2026-10-19):
本仓 GitHub Actions 仅有 docker-release(v* 标签/手动触发),PR 侧无 CI 检查——
合并前以上述本地验证手段为准。

### 9.7 无界注入项封顶:rule 红线字符预算 + 小说 bible 上限(2026-10-19 盘点放大器④,负责人拍板「好 可以」,已实施)

盘点里两个"没有上限的注入口",都走 system prompt / 任务 prompt 每步全量重发,
被步数放大 20 倍:

**① rule 红线特权通道(memory-service.ts)**:普通记忆有双重封顶(6 条全文 +
2400 字符),但 rule 类是特权通道 —— ≤10 条、每条全文、单条长度无上限。
治理:新增总字符预算 `PROMPT_MAX_RULE_CHARS = 4000`,挑选逻辑抽为纯函数
`selectRuleInjection`(条数+字符双闸,入参按更新时间降序 → 新红线优先保全文,
贪心装填:中间超长条不挡后面短条)。超预算条目**降级 L0 摘要层,不静默丢**:
摘要行带显式标记「[红线·全文未注入,执行相关操作前先 read_memory 取全文]」,
检索轨迹 reason=`rule-chars-cap` 如实落 audit。预算内红线行为零变化。

**② 小说设定集 bible(novel-context.ts)**:随创作只增不减、三个注入点原样全文
嵌入。治理:`NOVEL_BIBLE_MAX_CHARS = 12000` 硬上限,纯函数 `capNovelBible`
超限保头 70% + 尾 30%、中段显式标记截断(不静默,MCP output-cap 同原则);
续写/体检/开书大纲三点统一走封顶。近章摘要/时间线等既有滑动窗口不动
(本就是常量界)。详见 novel-workshop.md §2 增补。

**留白(有意)**:全书总纲/伏笔台账增长缓慢且是创作正确性关键,暂不封顶;
章节正文从不进 prompt(滑动窗口设计,负责人确认过)。

**测试**:memory-retrieval.test.ts 新增 3 例(纯函数双闸/贪心/条数闸 + 超长红线
降级集成 + 预算内回归锁)、novel-context.test.ts 新文件 8 例(纯函数 + 三嵌入点
+ 空态);web 全量 1321 例绿,tsc 通过。

---

## 附 · 数据勘误备忘(引用外部数字时注意)

- RAG-MCP「95.62% / -92%」为旧版口径,现行 arXiv 摘要为 **-50%+ / 13.62%→43.13%**。
- Manus「hit rate <10%→39%、TTFT 2x」原文不存在;可确认的是 10× 缓存单价差。
- Anthropic「87% / 150+ tools」查无官方原词,最接近的是 -85% 与 -98.7%。
- Cursor「40→80」仅社区传闻;官方口径 40(论坛答复,超限静默失效)。
- OpenAI Tool Search 官方未公布节省百分比(~47% 为第三方测试)。
