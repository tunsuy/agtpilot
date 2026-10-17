# Token 消耗深度归因 + 工具挂载专题(选题 73 万事件)

> 记录日期:2026-10-17。触发事件:开源贡献雷达「选题」扫描任务单次 mission.usage 达 ~73 万
> prompt tokens(未到派发阶段)。本文两部分:①73 万的逐环节归因;②工具挂载专题
> (现状 / 业界对照 / 改造方案)。所有代码结论均附文件:行号,业界数字附来源链接。
> 状态:分析已定稿;工坊白名单(§9.1)与 reasoning 剥离(§9.2)已实施,余待拍板。

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
   预算闸存在但默认关(`plugin-model/src/index.ts:82` `budgetMaxTokens = 0`),唯一
   入口是模型自己调 `router_set_budget_limit`(`plugin-router/src/index.ts:156-175`);
   且 `usedTokens` 是**进程级跨任务串账**(`plugin-model:83-84`),开了也兜不住单任务。
2. **工具挂载面失控(雷达任务特有,详见第二部分)。**
   雷达 prompt 是「关键词磁铁」:仓库/PR/执行/网页/检索/调研/github/deepwiki 命中
   全部 route,把 GitHub 官方 MCP 全服务器(~30-40 个大 schema)+ browser(11)+
   sandbox(8)+ git(7)+ search(4)+ subagent 等全部拖进来;任务内「只扩不缩」
   (`orchestrator.ts:401-406`、`routing.ts:148-158`)。
3. **DeepWiki / GitHub MCP 输出无源头裁剪,压缩骑线压不动。**
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
   每次导航 ~12KB base64 噪音 ≈3k tokens 纯浪费(截断后对模型零信息量)。
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
> novel/email_triage 按裁剪口径。落地形态:B 层检索组分四档 `searchGroup:
> full / research / web / none`(full=内容工坊标准梯度,research=去社媒热榜保留
> 三件套+子agent+firecrawl+参考资料,web=仅 search 三件套,none=不挂);
> C 层特例表 `DEPS_TOOL_OVERRIDES`(email→固定三件、tomato_writer→空、
> **github_mcp→空即整台默认禁入**,需要 GitHub 的工坊在 D 层按精确名声明);
> 灰度保险丝 `AGTPILOT_WORKSHOP_TOOLS=0` 整体回退原关键词路由;
> 续聊继承:白名单按 `options.workshopId || mission.workshopId` 解析,
> 同 mission 的存草稿投递轮天然继承。测试:packages/core routing.test.ts
> (explicit 通配/baseline 并入/跨步稳定/零命中回退)+ apps/web
> tool-whitelist.test.ts(14 坊包含/排除/规模断言,GitHub 整台通配与
> sandbox 越界全仓禁入)。

白名单不逐坊手写全量,按「四层并集」自动派生:

- **A. baseline 常驻**(~13 个,内核自动并入,工坊不声明):planner_create_plan /
  planner_update_task、memory_store / memory_recall、router_select_tier /
  router_get_budget_status / router_set_budget_limit、observability_get_trace /
  observability_get_metrics、artifact_render、connector_authorize、mcp_call、notify_*。
- **B. 通用检索组**(内容工坊共享,与 `workshops/shared/sources.ts` 检索梯度同源):
  search_web / search_exa / search_tavily、mcp_newsnow_*、mcp_zhihu_*、
  mcp_twitterapi_io_*、research_subagent、browser_firecrawl_scrape、
  read_reference_material。
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
| 5 | weibo | 无 | 纯 A+B(deps 已含 newsnow/zhihu/twitter/exa) |
| 6 | video(抖音/B站) | 无 | A+B |
| 7 | novel | mcp_fanqie_radar_*(榜单选题) | B 组裁剪:只留 search 三件套,不要推特热榜;写作/入库走服务端不经工具 |
| 8 | weekly | mcp_atlassian_*、mcp_lark_suite_*、mcp_dingtalk_* + email_list / email_read | GitHub 已拍板:只读精确名 5 个(list_commits / search_issues / list_pull_requests / get_pull_request / get_file_contents),整台不进 |
| 9 | ppt | ppt_check_env、ppt_publish_deck、ppt_publish_pptx + sandbox_run_command / sandbox_write_file | 唯一保留 sandbox 的工坊(prompt 明确引用) |
| 10 | email_triage | email_list / email_read / email_send | B 组裁剪:分诊不需要热榜,A+email 三件 |
| 11 | follow_builders | follow_builders_fetch_feed | B 组保留全量(twitter/exa/search 是核心) |
| 12 | invest | deps 映射:tushare、a_stock、alphavantage_mcp、coingecko_mcp | +B |
| 13 | edu | deps 映射:openalex、alphaxiv、huggingface_mcp、deepl_mcp | +B |

挂载数预估:雷达 ~20、内容工坊 ~25-30、weekly ~35(GitHub 整台时超 30-40 安全线,
可用精确名压回)、novel/email_triage ~15 以下。

灰度顺序:oss_radar(事发地先止血)→ 内容四坊(xhs/wechat_mp/zhihu/weibo)→ 其余;
每坊上线前加一条「生产 prompt → 挂载数断言」测试。(实施时收敛为单 PR 全量声明 +
`AGTPILOT_WORKSHOP_TOOLS=0` 保险丝,灰度改由部署观测承担。)

已拍板(2026-10-17「按你建议来吧」):① weekly GitHub 走精确名;② novel /
email_triage 按裁剪口径。

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
- P0:browser_navigate 剥离 screenshotBase64;DeepWiki/GitHub MCP 源头字段裁剪;
  任务级 token 预算闸(usedTokens 先改任务级);
- P1:重发前剥离历史 reasoning(**已实施**,见 §9.2);近期 10 条窗口内超大 tool_result 二次截断(~4KB);
  子 agent/蒸馏 usage 计入 mission.usage;
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
**范围注记**:plugin-subagent 子循环未经 orchestrator 三道闸,其 reasoning 仍在
子循环内回传(≤8 步、报告 ≤8000 字符回流,量级小)—— 列为后续独立小项。

---

## 附 · 数据勘误备忘(引用外部数字时注意)

- RAG-MCP「95.62% / -92%」为旧版口径,现行 arXiv 摘要为 **-50%+ / 13.62%→43.13%**。
- Manus「hit rate <10%→39%、TTFT 2x」原文不存在;可确认的是 10× 缓存单价差。
- Anthropic「87% / 150+ tools」查无官方原词,最接近的是 -85% 与 -98.7%。
- Cursor「40→80」仅社区传闻;官方口径 40(论坛答复,超限静默失效)。
- OpenAI Tool Search 官方未公布节省百分比(~47% 为第三方测试)。
