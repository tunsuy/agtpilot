# 网文小说工坊(novel)· 长篇一致性设计

状态:P0 已实现(2026-10-14,负责人拍板「搞吧」)
关联:`apps/web/src/workshops/novel/`、`apps/web/src/lib/novel-store.ts`、`/api/novels`
负责人需求原话:「自动帮我写小说」「要好好设计,得看正常一个好作者都是怎么做的——先有大故事设定、人物关系;AI 有记忆问题,写到后面会前后不一致、逻辑错误」。

## 1. 方法论来源(调研结论,三路收敛)

1. **人类作者工程化六件套**(番茄官方构思五步法 + 网文圈共识):
   设定集(世界观)/ 人物卡集 / 三层大纲(粗纲→卷纲→章细纲)/ 伏笔台账 /
   时间线年表 / 文风锚。「伏笔收不回不是能力问题,是没台账」。
   - 番茄官方五步法:题材卖点 → 梗概主线 → 人设 → 大纲细纲 → 开篇三章
     (notice.fanqienovel.com/docs/9476/gousi)。
2. **AI 长篇一致性学术/业界共识**:结构化 story bible(机器可读,不只是笔记)
   + 分层大纲 + 逐章滚动摘要 + 显式叙事状态跟踪。
   - DOME(NAACL 2025,arXiv 2412.13575):动态分层大纲 + 记忆增强;
   - NstAgent(arXiv 2609.35759):training-free 叙事状态跟踪,书越长一致性越好;
   - Novarrium 反方观点佐证:纯设定文档没用,必须「强制 AI 遵守自己写下的事实」。
3. **同栈先例**:Cppys/OpenNovel(claude sdk + LangGraph + SQLite + ChromaDB)——
   规划/写作/编辑/审稿/记忆分工,写前检索摘要、写后更新记忆、每 N 章全局审查、
   审稿不过重写。我们取其结构、弃其黑盒:**状态库全部文件化,可审计可手改**,
   不引入向量库。

## 2. 核心机制:恒定上下文 + 反思写回

**不变量:书越写越长,每章生成注入的上下文恒定(≈4-6k token),百万字不漂移。**

每章任务的上下文装配(`assembleChapterContext`,纯函数):

| 注入项 | 来源 | 预算 |
|---|---|---|
| 设定集(浓缩) | book.bible | ~1k |
| 出场人物卡(含当前状态) | book.characters 筛选:主角/主要恒入 + 本章细纲文本点名者 | ~1k |
| 本章细纲 | book.detailed[下一章] | ~300 |
| 近 3 章摘要 | book.summaries 尾部 | ~600 |
| 全书滚动总纲 | book.volumeSummary | ~500 |
| 未回收伏笔 | book.ledger(status=planted) | ~500 |
| 时间线尾部 | book.timeline 尾 5 条 | ~200 |

分层压缩抗漂移:章正文 → 章摘要(150-250 字)→ 全书总纲(反思时滚动更新)。

**反思写回五连**(每章生成完,同一输出契约里强制带出,`saveChapter` 一次落库):
1. 章摘要 → `summaries[]`
2. 出场人物「当前状态」增量 → `characters[].currentState`(按名合并)
3. 伏笔动作(埋设/回收)→ `ledger[]`
4. 时间线追加 → `timeline[]`
5. 进度指针/字数/总纲 → `progress`、`volumeSummary`

写回不靠模型自觉:契约解析失败(缺【本章摘要】等)时入库按钮给出明确缺失提示,
宁可拒绝入库也不落半截状态。

## 3. 状态库(novel-store)

位置:`getDataDir()/novels/<safeUserId>/<bookId>/`(与 artifact_files 同区,
路径分量白名单消毒同 user-store 风格,拒绝穿越)。

```
book.json          # 单一事实源:meta + 六件套结构化状态(见下)
chapters/001.md    # 章节正文单独成文件(书可长达 MB 级,不塞 JSON)
```

`NovelBook`(book.json):
- meta:bookId(`nv_<ts36>_<hex>`)、title、genre、premise(一句话卖点)、style、
  status(active/paused/finished)、createdAt/updatedAt
- progress:{ chapterCount, wordCount, nextChapter }
- 六件套:bible(md 文本)、characters(结构化卡集,含 currentState)、
  outline(粗纲+卷纲 md)、detailed(当前细纲池,章颗粒)、ledger(伏笔台账)、
  timeline(年表条目)
- 记忆层:summaries(逐章摘要数组)、volumeSummary(全书滚动总纲)
- chapters:章元数据(title/wordCount/createdAt),正文在 chapters/NNN.md

原子写(tmp + rename)同 artifact-files;章文件先落、book.json 后落
(崩溃最坏丢一次指针,不丢正文)。

## 4. 格式契约(novel-package,「格式即契约」)

与 note-package/article-package 同族:prompt 模板约定【字段头】输出,纯函数解析,
解析失败降级普通 markdown 渲染。互斥锚(开书三段化后五种包):

- **设定包**(genesis_bible,三段化第一步):必含【设定集】+【人物卡】,无章正文。
  前置回显段【题材】【文风锚】【每章字数】——表单值经模型回显进包,卡片据此
  串「继续:生成大纲」(mission 不持久化 params,契约回显是唯一通道;模型漏回显
  时缺省,卡片走各自兜底)。
- **大纲包**(genesis_outline,三段化第二步):必含【粗纲】+【细纲】,无设定集
  无章正文。首段【书号】回显(服务端渲染时逐字注入),入库前按用户书库校验。
- **开书包**(genesis,旧单次全量,历史任务重渲染兼容):必含【设定集】+【粗纲】
  +至少一章正文。字段:【书名】【卖点】【设定集】【人物卡】(## 姓名 +
  `- 键:值` 行)【粗纲】【细纲】(### 第N章 + `- 钩子:/事件:/情绪:/伏笔:/字数:`)
  【伏笔】(`- [埋设] 内容`)【时间线】【第N章】(首行标题 + 正文 + 【本章摘要】)
  × 开篇章数。
- **续写包**(parseNovelContinue):必含【书号】+【本章摘要】,不得含【设定集】。
  字段:【书号】(服务端渲染时逐字注入,Agent 原样回显;入库时按用户书库校验)
  【第N章】+【本章摘要】+【人物状态更新】(`- 姓名: 新状态`)+【伏笔动作】
  (`- [埋设] …` / `- [回收] 关键词 @方式:…`)+【时间线】+【下章细纲】(可选,
  细纲池余量不足时补充)+【总纲更新】(可选)。
- **文风锚包**(style,P2):必含【文风锚】;设定包也回显【文风锚】——有
  【设定集】或【人物卡】的输出绝不是文风锚包(解析器显式拒吞)。
- **审查报告**(parse 不做结构化,P0 按 markdown 渲染):基于状态库交叉核对
  (人名漂移/年龄/时间线冲突/战力越界/伏笔回收率/动机跑偏),不读全文。

互斥性由契约测试双向锚定(开书包不误命中续写解析、反之亦然;
【本章摘要】不命中文章包的【摘要】锚——正则要求「摘要」顶格)。

## 5. 工坊装配(workshops/novel/)

- 五模式 run():`genesis_bible`(开书第一步:设定包,拍板书名/卖点/建设定集
  与人物卡)/ `genesis_outline`(开书第二步:大纲包,吃第一步入库的书)/
  `continue`(续写下一章:装配恒定上下文)/ `review`(全书体检)/ `style`
  (P2 文风学习)。旧 `genesis`(单次全量)保留给历史重跑,新表单不再产。
- **服务端权威注入**(server-render 扩展点 `WorkshopSkill.loadContext`):
  continue/review/genesis_outline 的 params 带 bookId,服务端渲染时现读
  novel-store 把书状态快照放进 ctx——客户端只传 bookId,状态永远以服务端为
  准(与档案现读同理)。客户端预览用表单已拉取的书快照,同一 buildWorkshopRun
  路径。
- 参数钳制:每章字数 1000-6000(缺省 3000)。
- prompt 红线段(模板内置):内容边界(不碰政治敏感/色情/未成年人)、
  必须原创(不得复刻具体现有作品/真实在架书)、发布合规提示
  (平台 AI 声明如实勾选、发布永远人工确认——对齐 2025.9 施行的
  《人工智能生成合成内容标识办法》与番茄 2025-2026 低质内容治理)。

## 6. 入库闭环(UI)

- 驾驶舱答复卡:CockpitView 解析链加 novel 分支(与 picks/article/note/oss
  并列,锚互斥、顺序不敏感),五种包五种卡 +「存入书库」按钮 → POST
  /api/novels(create/append/mergeOutline)。
- **开书三段化串联**:设定包卡「存入书库」(action=create,0 章建书)后出
  「继续:生成大纲」链钮 → 派发 genesis_outline 工坊任务(服务端权威渲染,
  prompt 只是乐观气泡展示文本);大纲包卡「存入书库」(action=mergeOutline,
  只写规划层不动正文)后出「继续:写第 N 章」链钮 → 走 continue 逐章管线。
  每步结果先给用户审,不满意可重跑。
- 书号回显解决「章/大纲归哪本书」:mission 不持久化 workshop params,
  故契约要求 Agent 回显【书号】;校验失败(书号不在当前用户书库)时
  卡片降级为「选择目标书」下拉,不猜。
- 工坊表单「续写/审查」模式列出用户书库(GET /api/novels),显示进度
  (第 N 章 / 字数 / 未回收伏笔数)。

## 7. 分期

- **P0(本次)**:novel-store + 契约解析 + 三模式工坊包 + /api/novels +
  表单/卡片/驾驶舱接线 + 契约/存储/prompt/服务端渲染测试。
  立住「能连写不漂」的完整闭环(开书→入库→续写→入库→审查)。
- **P1**:cron 日更场景(novel_daily_chapter,CronScenarioSpec 声明,
  触发时服务端装配最新状态)+ 场景档案槽位 'novel'(文风样例/禁忌)+
  每 N 章自动审查(续写管线内联触发)+ TXT/EPUB 导出(artifact-files 通道)。
- **P2**:番茄作家助手托管连接器(存官方草稿箱 + 阅读数据看板,候选底座
  fuhei/tomato-writer-mcp,先实测 cookie 鉴权面/稳定性/风控再定;写操作
  审批门照 xhs managedGate 先例,subagentOpen=false)+ fanqie-radar 榜单
  连接器做数据化选题(公开榜单元数据,无正文)+ 文风学习(去 AI 味)。

## 8. 安全与红线

1. **发布永远人工**:P0-P1 只产文本与本地书库;任何平台投递(P2)都是
   「存草稿 + 人工确认发布」,且 AI 使用声明由作者本人在平台如实勾选——
   不代填、不绕过(法规 + 平台规则双重约束)。
2. **不接正文抓取**:番茄/起点章节正文类爬虫连接器一律不入库(版权红线,
   见 2026-10-14 小说连接器调研结论);选题数据只用公开榜单元数据(fanqie-radar)。
3. **原创性**:prompt 禁止复刻具体现有作品;「仿写评分」类数据只作选题参考。
4. **状态库不含凭证**:novel-store 只存创作内容;P2 托管连接器凭证走
   user-store 既有托管通道,不进书目录。
5. **路径消毒**:userId/bookId/chapter 全部白名单字符消毒后拼路径,拒绝穿越
   (artifact-files 同款);章节序号服务端钳制,防目录外写。

## 9. 测试

- novel-store:tmpdir 隔离(USER_DATA_DIR 模式)——create/get/list、
  appendChapter 反思合并(人物按名合并/台账埋设与回收/时间线追加/指针推进)、
  章文件与 JSON 一致性、路径穿越拒绝。
- novel-package:设定包/大纲包/开书包/续写包固定样例契约、坏输入降级、
  与 note/article 解析器双向互斥锚定。
- prompt:五模式模板 golden(参数钳制、回显段、恒定上下文段齐全、红线段在场)。
- server-render:loadContext 注入(书状态现读、bookId 非法时 400 语义)。
