# Loop 执行优化:2026-10 历史会话分析与改造清单

> 数据来源:生产环境 8 个真实会话的步骤轨迹、工具输出、执行效率统计、记忆审计日志
> (usr_747374616e673638,2026-10-09 ~ 10-11)。
> 本文是分析结论 + 依次开工的改造清单;每完成一项在对应章节标记状态。

## 一、总览:8 会话效率画像

| 会话 | 步数 | 工具调用 | 失败 | 有效率 | 挂载工具 |
|---|---|---|---|---|---|
| 公众号·观点评论 | 6 | 11 | 0 | 100% | 25/114 |
| 小红书每周选题(含存草稿) | 10 | 10 | 3 | 70% | 88/114 |
| 公众号·观点评论(用户中止) | — | 4 | — | — | — |
| 公众号·热点解读 | 11 | 17 | 4 | 76% | 40→60/60 |
| 科技热点日报 | 9 | 27 | 4 | 85% | 12/60 |
| 小红书·种草推荐 | 6 | 10 | 6 | **40%** | 27/56 |
| 教研备课 | 2 | 3 | 0 | 100% | 12/55 |
| 多模态调研 | 10 | 25 | 2 | 92% | 8/55 |

结构性健康:步数未触顶(maxSteps 20,最长 11 步)、熔断/任务内压缩/wrap-up/执行效率摘要均在生效。
问题集中在四个具体点,按影响排序如下。

## 二、发现与改造项(按优先级)

### P1 · search_web 结果质量差,引发连锁刮取

**现象**:google-news 引擎返回的 snippet 全是占位文案「来自 Google News 实时资讯」,
URL 是 200+ 字符的 `news.google.com/rss/articles/CBMi...` base64 跳转码——搜索几乎不提供信息量。
后果:模型被迫逐个 `browser_navigate` 开网页补内容。

- 热点解读:搜→刮→再搜→再刮循环 6 轮(unite.ai / kingy.ai 均转述同一 OpenAI 事件),4 次失败
- 热点日报:8 轮串行搜索全靠 google-news,之后仍需逐个浏览

**改造**:
- [x] search_web 换/补有真实摘要的引擎(已完成,2026-10-11):
  - Bing 国际区(mkt=en-US)为英文主力:真实标题+摘要+`/ck/a` 链接解码为真实出版权 URL
  - Google News RSS 为中文主力:标题(自带信息量)+ `<source>` 来源名 + pubDate 组成摘要,
    替换原「来自 Google News 实时资讯」占位文案
  - 两源并行(Promise.allSettled),按查询语种决定合流主次;Wikipedia 兜底不变
  - 实测弃用:DDG html / Baidu / Sogou / Mojeek 境内 IP 全反爬;Bing 中文查询返回推广垃圾;
    Google News 文章 ID 签名页已不含 data-n-a-sg(URL 解码路线不可行)
  - 修掉一个隐性 bug:`.repeat((-len) % 4)` 在 JS 中为负数会抛 RangeError 被静默吞掉
  - 测试:apps/web/src/lib/__tests__/plugin-search.test.ts(7 例,含真实生产 HTML 验证)
- [x] 跳转 URL 浪费:Bing 链接解码为真实 URL(短且可读);gnews 跳转链保留(浏览器可开,必需)
- 预期收益:砍掉约 60% 后续浏览轮次,同时省钱、提速、提有效率

### P2 · 工具路由每步重算,破坏 provider 前缀缓存 + 挂载面过大

**现象**:114 个工具目录超阈值(64k×10%=6400 tokens)触发按需路由后,
小红书任务仍挂载 86-88 个(大头 `mcp_*`,「多源检索」类 route 把所有 MCP 服务器都挂上了)。
更关键:`prepareStep` 每步动态重算 activeTools → 请求前缀每步都变 →
`routing.ts` 注释里「前缀恒定、跨任务共享 provider 缓存」的初衷被抵消,
DeepSeek/OpenAI 类自动缓存每步 miss,每轮全价重付工具 schema + 历史前缀。

**改造**:
- [x] 任务内「只扩不缩」(已完成,2026-10-11):
  - `routing.ts` 新增 `widenMountedTools`:prepareStep 每步重算的结果只**并入新增**工具,
    集合不变/缩容都不写回 —— 工具声明前缀跨步稳定,provider 前缀缓存只在扩容那一步
    破一次(新增工具本来就必须重建);缩容交给下一任务的初始路由
  - orchestrator 的 mountedNames 冻结集合 + `toolsMounted` 效率统计随扩容更新
  - 测试:routing.test.ts 新增 5 例(扩/缩/一致/undefined/步进序列)
- [x] 收紧 `mcp_*` 路由规则(已完成,2026-10-11):
  - plugin-mcp 毯式路由(「MCP/连接器」→ 全部 `mcp_` 前缀)收窄到只管
    CLI 的 `mcp_connect_*` 连接管理工具 —— 任务提示词顺带提「MCP 工具(若已连接)」
    不再把全部 MCP 服务器挂上(实测曾 88/114)
  - Web 侧按**服务器粒度**注册路由:`mcp-connectors.ts` 每个连接器声明 `routeWords`
    触发词(知乎/热榜/推特/飞书…)+ 服务器 label,`buildUserMcpToolRoutes(uid)` 为
    该用户已配置的连接器逐服务器生成 `{prefixes: ['mcp_<server>_']}` 路由;
    agent-backend 每次任务开始重注册(同 id 幂等覆盖,撤授权的陈旧路由前缀
    匹配不到任务目录里的工具,天然失效)
  - 中途授权桥 `connector_authorize` / `mcp_call` 标记 `baseline: true` 常驻
    (它们本就「始终注入」,旧毯式路由是其在路由态下唯一可见路径,须补齐)
  - `buildUserMcpServers` 与路由共用 `connectedServerDefs` 凭证判定,无行为变化
  - 测试:mcp-routing.test.ts 7 例,用生产 mission 提取的真实提示词验证
    「知乎热榜/站内搜索类 MCP 工具」只挂知乎 3 服务器 + newsnow,不挂 twitter/deepwiki
- 预期收益:每请求省 5k+ tokens 的 schema;恢复缓存命中(命中价约 1/10)

### P3 · token 用量已算出但被扔掉,成本不可观测

**现象**:core 每轮 emit `agtpilot/usage`(promptTokens/completionTokens/taskId),
plugin-model 有 `getUsage()`,但 apps/web 层零消费——不落库、不展示,成本优化无从度量。

**改造**:
- [x] agent-backend 接住 `agtpilot/usage` 事件,写入 mission(已完成,2026-10-11):
  - core `TaskEfficiency` 增加 `promptTokens` / `completionTokens`,orchestrator
    累计 loop 主循环 **+ 步数耗尽后的强制总结轮**的用量(都要付费,旧实现漏掉后者)
  - `agtpilot/usage` 事件从 loop 结束即发挪到强制总结之后,报完整账单
    (plugin-router 预算统计同步受益)
  - agent-backend `bindEvents` 订阅 usage 事件 → `mission.usage` 任务级累计
    (多轮追问续跑时是总账;效率摘要展示的是单次运行值),类型见 types/agent.ts
- [x] 执行效率摘要步骤带上 token 数(已完成,2026-10-11):
  - 纯函数抽到 `lib/mission-efficiency.ts`(格式化/标题/累计),驾驶舱 step_eff_
    标题追加「tokens 输入 5.2k / 输出 980」;历史会话旧事件无字段则不追加
  - 测试:mission-efficiency.test.ts 7 例
- 这是度量其他一切优化的前提 ✓(P1/P2 的收益从此可以在摘要里对账)

### P4 · 工具失败后 agent 盲目自救(8 轮空转案例)

**现象**:小红书存草稿任务:两次 `xhs_save_note_draft` 均因发布页改版选择器超时失败,
错误信息只有 Playwright 堆栈;agent 只能 `browser_screenshot` → `browser_wait`(30s 白等)
→ `observability_get_trace` → 3 次 `browser_navigate` 盲诊,烧 8 轮。
(选择器本身已由 78f76e0 聚合页状态机修复;通用问题仍在。)

**改造**:
- [x] 易碎工具的失败返回「下一步指引」型错误(已完成,2026-10-11):
  - core 新增 `classifyBrowserFailure`(纯函数):Playwright 报错归为
    page-structure(改版/加载慢) / network / session / unknown 四类,
    各附「下一步指引」文案 —— 明确告诉模型这类失败不是自调试能解决的,
    最多一次 screenshot,异常就停止浏览器操作、基于已有信息交付
  - plugin-browser:navigate / click / read / fill / type / upload / wait 的
    失败返回都带上分类结果(kind/reason/hint),不再是裸 Playwright 堆栈
  - `xhs_save_note_draft`:环境类失败特化为「交付笔记全文 + 引导用户到连接器页
    接管浏览器亲手发布」(发布本来就规定由用户本人完成),不再是
    `存草稿失败:<原始报错>` —— 那正是 8 轮盲诊(screenshot→30s wait→
    3 次 navigate)的触发器
  - 测试:core browser-failure.test.ts 6 例 + xhs-managed.test.ts 3 例
    (真实改版故障形态 `locator.fill: Timeout 20000ms exceeded` 全链路验证)
- [x] `browser_wait` 收紧(已完成,2026-10-11):
  - for=timeout 盲等上限收到 10s(实测 agent 曾用 30s 白等;条件等待
    selector/text/load 保留 30s);工具描述新增「优先 2-3 秒短探测」指引
- [x] `xhs_save_note_draft` 已有登录检测;其余 browser 类工具核对同类场景(已完成,见上)

### P5 · 缺 key 的连接器照样挂载、照样被调

**现象**:`browser_firecrawl_scrape`(13ms 秒败)、`search_tavily`、`search_exa` 无 key 仍挂载;
种草任务 40% 有效率主要由它们贡献。auto-distill 记忆已存「Firecrawl/Tavily 缺 Key」,
模型下次仍照调——记忆没有传导到工具可见性。

**改造**:
- [x] 缺 key 的工具不挂载(已完成,2026-10-11):
  - `ToolDefinition` 新增 `requiredEnv?: string[]` 声明(Key 环境变量名,任一存在
    即已配置):`search_exa`/`search_tavily`(plugin-search,config 带 Key 时
    不声明)与 `browser_firecrawl_scrape`(plugin-browser)接入;执行内的
    Key 检查保留为兜底
  - core 新增 `filterToolsByEnv(纯函数)`:编排器挂载前按
    taskEnv(用户个人空间,多用户隔离)∪ process.env 判定,缺 Key 直接剔除
    —— 不再挂一个 13ms 秒败的壳诱使模型调用
  - 剔除只发生在 runTask 内,下游路由/loopTools/效率统计全部只见过滤后
    目录;用户个人空间配了 Key 的任务不受影响(anyOf 语义)
- [x] 「缺 key」事实传导到工具目录(已完成,2026-10-11,短期形态):
  - 被剔除清单注入系统提示尾部:「【工具可用性】search_exa(EXA_API_KEY)…
    本次未挂载,不要尝试调用,直接使用已挂载的替代工具;确需启用提示用户
    在个人空间配置 Key 后重新发起」—— 决策点直接告知,替代 auto-distill
    记忆「存了缺 Key 但下次仍照调」的断链;长期形态(回退弧/目录动态标注)
    待 persistent-state-governance 演进
  - 测试:routing.test.ts 新增 6 例(剔除/taskEnv 隔离/process.env/anyOf)
    + plugin-search.test.ts 3 例(声明联动:个人空间有 EXA Key 时
    search_exa 挂载、search_tavily 剔除)

### P6 · 独立检索未并行,串行单工具轮次

**现象**:热点日报 8 次搜索每轮只发一个 query,每轮一次完整模型往返;
选题会任务证明一轮可并行发 3 个工具调用(newsnow+知乎+twitter 同轮)。

**改造**:
- [x] 系统提示加「独立检索可并行发起」指引(已完成,2026-10-11):
  - Web 提示词抽成纯函数 `lib/task-system-prompt.ts`(便于测试与调优),
    规则 6 从泛化的「独立调用并行发出」升级为具体操作指引:
    把主题拆成多个不同角度的关键词/信息源(多角度 search_web +
    已授权 MCP 检索工具),**一轮批量发起全部搜索,结果齐了再汇总
    决定下一步**;每轮只发一个查询会成倍浪费往返与上下文重发;
    浏览多个互不依赖的网页同理
  - CLI 缺省提示(core `DEFAULT_SYSTEM_PROMPT`,现从 index 导出)同步升级
  - 测试:task-system-prompt.test.ts 3 例(指引关键词/九条准则完整性
    防丢失红线/记忆块插值恒定)+ core system-prompt.test.ts 1 例
- 预期收益:8 轮压到 2-3 轮,省整轮上下文重发

## 三、开工顺序

P1 → P2 → P3 → P4 → P5 → P6,每项:实现 + 测试 + 全量回归。

六项已于 2026-10-11 全部完成(核心回归 core 83 + web 370 全绿,apps/web tsc 0 错误)。
后续验证:P3 的 token 账单与 P1/P2/P5/P6 的轮次/挂载面收益,在下一批真实任务的
执行效率摘要(`stepsCount/工具有效率/挂载数/tokens`)里对账。
