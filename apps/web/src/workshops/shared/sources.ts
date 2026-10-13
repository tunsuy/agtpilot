/**
 * 内容工坊「选题/调研数据源」共用梯度文案。
 *
 * 背景:信息检索类连接器早已不止知乎——NewsNow 聚合 40+ 全网热榜、
 * 知乎三件套(站内搜索/全网聚合/实时热榜)、X/Twitter 数据、通用网页
 * 搜索工具等。各工坊 prompt 此前只点名「知乎热榜」,其余检索连接器
 * 形同虚设;统一在此维护数据源梯度,工坊按场景在最前面插入专属源
 * (如小红书的 xhs_read_creator_data),避免多处 prompt 口径漂移。
 *
 * 注意:这里列的是 mcp_<server>_* 工具名前缀,与 mcp-connectors.ts 的
 * servers[].name 一致;新增检索类连接器时同步维护本清单。
 */

/** 信息检索数据源梯度(已连接哪个用哪个;可直接嵌入各工坊 prompt) */
export const TOPIC_RESEARCH_SOURCES = `- 全网热榜 NewsNow(若已连接 mcp_newsnow_* 工具):一个连接器聚合 40+ 热榜——微博实时热搜、今日头条、百度热搜、抖音、知乎、哔哩哔哩、36氪、财联社、GitHub Trending、Hacker News 等
- 知乎(若已连接 mcp_zhihu_* 工具):站内搜索问答/文章、知乎实时热榜、全网聚合搜索
- X / Twitter 数据(若已连接 mcp_twitterapi_io_* 工具):趋势话题与推文搜索(海外动态、科技圈热点)
- 网页搜索工具(search_web / search_exa / search_tavily):通用兜底
- 以上都不可用:基于自身知识判断,并在选题依据里明确注明`;
