# 设计文档:用户上下文存储范式演进(单 JSON blob → 用户上下文目录)

> 状态:**方案待评审**(2026-10-12,负责人指示「先写个方案,也可以先详细看下其他顶级产品怎么做的」)
> 灵感来源:ByteDance OpenViking 的「上下文文件系统」范式(viking:// + L0/L1/L2 分层),以及对 Claude memory tool、Manus、Letta/MemGPT、ChatGPT memory、mem0、Zep/Graphiti 的调研
> 涉及模块:`apps/web/src/lib/user-store.ts`(主改造)、`memory-service.ts`、`skill-cards.ts` / `packages/plugin-skill`、`agent-backend.ts`(注入侧)
> 关联文档:`docs/design/persistent-state-governance.md`(五条治理不变量在本方案中必须继续成立)

---

## 1. 背景与动机

负责人关注 OpenViking 的文件系统存储范式,问「我们现在数据是怎么存储的」。盘点结论:

**现状 = 每用户单 JSON blob + 只增审计 JSONL**

1. 主存储 `.cache/user_data/<userId>.json`(USER_DATA_DIR 可覆盖),一个用户一个大 JSON,顶层字段分区:connectors(AES-256-GCM 加密)、mcpAuth、memories、missions、goals、cronJobs、skillCards、browserAudit、scenarioProfiles、xhsManaged/zhihuManaged、sandbox、policyProposals、deletionLedger、authorityEpochs……未知字段透传,零迁移;
2. 写入 = 整文件读 → 改 → tmp + rename 原子写回(last-writer-wins,无记录级粒度);
3. 审计独立 append-only JSONL(`<user>.audit.jsonl`、`<user>.sandbox-audit.jsonl`);
4. 技能包本来就是文件系统(`/opt/skills/<pack>/SKILL.md`,plugin-skill 扫描建注册表);
5. 检索纯进程内关键词/分词打分(memory-service BM25 风格 + 技能卡关键词计分),无向量库。

**痛点(随规模增长显现)**:

| # | 痛点 | 后果 |
|---|---|---|
| P-a | 任何域的写都要整 blob 读-改-写 | missions 高频写会连带重写 memories/connectors,放大 IO 与损坏面 |
| P-b | 并发写 = 整文件 last-writer-wins | 双任务并行时后写覆盖先写(丢记忆/丢审计窗口) |
| P-c | 单文件无界增长 | missions 全量内嵌,读一次全量 parse;无法按任务寻址 |
| P-d | 无摘要层 | 注入 = 检索 top-k 全文塞 prompt,记忆/卡片多了 token 成本线性涨 |
| P-e | 检索不可观测 | 「为什么注入了这条/漏了那条」没有落盘痕迹,蒸馏质量难调 |

## 2. 业界调研:顶级产品怎么存

### 2.1 逐家范式

| 产品 | 存储范式 | 关键事实 |
|---|---|---|
| **Anthropic Claude memory tool**(2025-09 beta,`memory_20250818`) | **客户端文件目录**(约定 `/memories`),模型用 view/create/str_replace/insert/delete/rename 六个命令自管文件;后端(本地 FS/Redis/S3/DB)由开发者注入 | 与 context editing(清理旧 tool result)配套;Claude Code 另用 CLAUDE.md/MEMORY.md 分层 markdown |
| **Manus**(2025-07 工程博客) | **文件系统即外部化上下文**:超限时把内容写文件、留路径,可恢复 | KV-cache 命中率是第一指标 → 前缀稳定、append-only、mask 工具而非删工具;todo.md 复述操纵注意力;错误轨迹保留在上下文 |
| **Letta/MemGPT** | **三层**:core memory blocks(常驻上下文、模型自编辑)+ archival(向量库)+ recall(会话历史) | Letta Filesystem 实验:纯文件 + grep/search/open 工具在 LoCoMo 拿 74.0%(GPT-4o mini),胜过 mem0 图方案 68.5%;结论「记忆是上下文管理问题,不是检索机制问题」 |
| **ChatGPT memory** | **双层**:saved memories(显式条目、用户可编辑、独立于聊天删除)+ reference chat history(2025-04,全量历史 RAG,不可逐条编辑) | 后续上线「Dreaming」:离线整合历史提炼记忆(与我们的任务末蒸馏同族) |
| **mem0** | 抽取原子事实 → **向量库**(+ 可选图层 mem0g) | 主打小足迹(自称单会话 1,764 token vs Zep 60 万);AOEP 治理测评垫底——抽取把权限/来源/删除链**抹平**(persistent-state-governance.md §1.1 已记录) |
| **Zep/Graphiti** | **双时序知识图谱**(Neo4j/FalkorDB),事实带生效区间,矛盾时 invalidate 而非 overwrite | 基准数字争议大(官方修正后 LoCoMo 75.14%);图谱运维重 |
| **OpenViking**(ByteDance) | **viking:// 虚拟目录树**:resources/ + user/{id}/memories\|resources\|skills\|peers;每目录 .abstract/.overview 元数据支撑 **L0(百字摘要)/L1(概览)/L2(全文)** 三层加载;目录递归向量检索 + 检索轨迹落盘;会话 commit 自动蒸馏 | 39.7k star,VLDB 2026;**AGPLv3**(红线,不引代码);需独立 server + embedding/VLM |

### 2.2 跨家共同结论(方案的真正依据)

1. **文件系统正在成为 Agent 记忆的标准基底**:Claude(memory tool)、Manus、Letta(FS 实验)、OpenViking 全部收敛到「路径可寻址 + 模型天生会用文件操作」;Letta 的实验证明纯文件 + grep 就能打赢专用向量方案。
2. **两层记忆是共识**:一个小的、常驻注入的精选层(core blocks / saved memories / L0-L1)+ 一个大的、按需检索的原始层(recall / history RAG / L2)。我们的 memories+skillCards ≈ 精选层,missions 全量 ≈ 原始层,但目前两层都全文注入、没有摘要梯度。
3. **离线整合是标配**:ChatGPT Dreaming、Letta sleeptime agents、OpenViking session commit、我们的任务末蒸馏三通道——我们已有,方向正确。
4. **append-only + 稳定前缀**:为 KV-cache 与可恢复性,大家都追加不改写。我们的审计 JSONL 已符合;主数据 blob 不符合。
5. **检索机制不是决定因素,治理字段才是**:mem0 式抽取在 AOEP 垫底的教训 = 演化存储时**必须保留治理元数据**(权威纪元、删除台账、来源链),不能为了范式好看而抹平。
6. **不引向量库是合理选择**:我们的规模(每用户几十~几百条)下确定性关键词检索白盒、可测、零运维;上向量库换不来准确率还引入 embedding 依赖与黑盒。

## 3. 目标范式:用户上下文目录(context store v2)

```
.cache/user_data/                    # 根不变(USER_DATA_DIR)
  v2/
    <userId>/                        # 每用户一个目录 = 命名空间(对标 viking://user/<id>/)
      profile.json                   # 低频配置域:connectors(逐值加密不变)/mcpAuth/activeModelId/
                                     #   sandbox/authorityEpochs/xhsManaged/zhihuManaged/pushSubscriptions
      memories.jsonl                 # 一行一条(append + 压实);治理字段全透传
      skill-cards.jsonl              # 同上(card 形态)
      missions/
        index.jsonl                  # 每任务一行摘要:id/goal/status/createdAt/updatedAt/summary(L0)
        <missionId>.json             # 任务全文(steps/efficiency…)——按任务寻址,写不碰他人
      goals.jsonl
      cron-jobs.json
      scenario-profiles.json         # 工坊档案
      deletion-ledger.jsonl          # 只增
      audit/
        memory.jsonl                 # 原 <user>.audit.jsonl 迁入
        sandbox.jsonl                # 原 <user>.sandbox-audit.jsonl 迁入
        browser.jsonl                # browserAudit 从 blob 数组改追加式
        retrieval.jsonl              # 新增:检索轨迹(§5 P2)
      agent-notes/                   # P3:Agent 自管文件区(对标 Claude memory tool)
  <userId>.json                      # 旧单文件:迁移后改名 .json.bak 只读归档
```

设计要点:

- **域拆分按写入频率与并发面**:高频(missions/audit)每记录一文件或 append-only;低频(profile/scenario)整文件原子写不变。
- **append + 压实**:JSONL 追加写(单行小写近乎原子),读时全量扫 + 定期压实(条数阈值触发重写,压实保留来源字段——不变量 I4)。
- **并发**:进程内 per-user 写锁(mutex)串行化同用户写;跨域写不再互相覆盖(解决 P-b)。
- **未知字段透传**照旧:每行 JSON 原样保留未知 key,零迁移承诺不变。
- **加密收口不变**:profile.json 内 connectors 逐值 `enc:v1:`,secret-box 单点。
- **门面不动**:`getUserData()/saveUserData()` 签名保留,v2 下内部路由到新布局——上层几十个调用方与 476 个测试零改动。

## 4. 与治理不变量的对齐(persistent-state-governance.md I1–I5)

| 不变量 | v2 落点 |
|---|---|
| I1 权威只收窄 | authorityEpochs 留 profile.json,语义不变 |
| I2 范围不扩大 | 目录即 userId 硬边界;agent-notes 限 user/<id>/ 子树 |
| I3 删除传导 | deletion-ledger.jsonl 只增;传导目标路径更新为新布局(实现时改 propagate 清单) |
| I4 整合保来源 | 压实/合并保留 sourceMissionId、actor、原行(改写前旧行进 audit) |
| I5 行动留把手 | audit/ 全域追加式;mission 单文件天然可回滚(.bak) |

## 5. 分期计划

### P1 · 拆目录(纯内部重构,行为等价)

- user-store 内部实现 v2 布局 + 门面路由;懒迁移:首次 getUserData 读旧文件 → 写 v2 → 旧文件改名 .bak;
- browserAudit 数组 → audit/browser.jsonl(旧数据迁移,读侧合并兼容一个版本);
- 开关 `AGTPILOT_CONTEXT_STORE_V2=0` 一键回退旧路径(v2 目录保留不动);
- 新增测试:迁移正确性(逐字段往返)、并发写不互覆、压实保来源、开关回退。
- 预估 1~1.5 天(含测试)。

### P2 · 摘要分层(L0)+ 检索轨迹

- memories/missions 每条加一行式 `summary` 字段(蒸馏时顺带产出;存量懒生成——首次注入时截断 goal/首句兜底,不批量烧模型);
- 注入改两级:任务开始注 **摘要清单**(L0,前缀稳定利缓存)+ 高分项全文;新增 `read_memory(id)`/`read_mission(id)` 工具按需取 L2(对标 OpenViking 分层加载与 Letta FS 的 open);
- 检索轨迹:每次注入把 {候选 id、得分明细、入选/落选原因} 追加进 audit/retrieval.jsonl(对标 OpenViking 可观测检索);
- 技能卡侧同步:plugin-skill 的 selectCards 输出得分明细。
- 预估 0.5~1 天。

### P3 · Agent 自管上下文文件(可选,对标 Claude memory tool)

- 新工具 `context_file`(view/create/str_replace/delete),根目录锁死 `v2/<userId>/agent-notes/`,总预算(如 64KB)+ 单文件上限 + 全操作进审计;
- 用途:长任务把中间产物外部化(Manus 范式),任务末蒸馏可把它当轨迹素材;
- 与 plugin-skill pack 形态互补:pack 是管理员预置(只读),agent-notes 是运行时自写。
- 预估 1 天。**是否做等 P1/P2 落地后按实际痛点决定。**

### 明确不做

- ❌ 不集成 OpenViking(AGPLv3 红线 + 独立 Python server + embedding/VLM 依赖);
- ❌ 不引向量库/embedding(§2.2 第 6 条);
- ❌ 不上知识图谱(Zep 式运维成本与规模不匹配;「invalidate 而非 overwrite」理念已由治理层的 supersede/疑似过时机制承载);
- ❌ 不动 /opt/skills pack 范式(它已经是文件系统)。

## 6. 迁移与回滚

1. v2 与旧文件共存期:读优先 v2,无 v2 则读旧文件并触发懒迁移;
2. 回滚 = 设 `AGTPILOT_CONTEXT_STORE_V2=0`,旧 .bak 文件仍在,恢复原名即回到迁移前状态(压实发生前的数据以 .bak 为准);
3. 部署面无变化:仍是本地磁盘目录,无新进程、无新端口、无新依赖。

## 7. 验收标准

- [ ] web 全量测试(现 476)绿 + core(89)绿 + plugin-skill(40)绿;
- [ ] 新增 user-store v2 测试组:迁移往返、并发、压实、开关回退、加密值往返;
- [ ] 手工验证:老用户目录懒迁移后 .bak 与 v2 内容逐字段一致;
- [ ] P2 后:同一任务注入 token 数不升(摘要清单 ≤ 原全文注入),retrieval.jsonl 可回答「为何注入/漏掉某条」。

## 8. 参考

- OpenViking:github.com/volcengine/OpenViking(AGPL-3.0,调研只读,不引代码)
- Anthropic memory tool:platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Manus 上下文工程:manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Letta 文件系统记忆基准:letta.com/blog/benchmarking-ai-agent-memory/(LoCoMo 74.0%)
- Letta 记忆分层:letta.com/blog/agent-memory/、docs.letta.com(memory blocks / archival)
- ChatGPT 记忆双层与 Dreaming:help.openai.com/articles/8590148、openai.com/index/chatgpt-memory-dreaming/
- mem0:arXiv:2504.19413;Zep/Graphiti:arXiv:2501.13956(基准争议:getzep/zep-papers#5)
- 本仓治理不变量:docs/design/persistent-state-governance.md
