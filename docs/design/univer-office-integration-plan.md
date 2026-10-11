# 办公文档集成方案(PPT 工坊优先;Univer 表格暂缓)

- 日期: 2026-10-11
- 状态: 范围已拍板——**表格(Univer)暂缓,只做 PPT 工坊**(负责人 2026-10-11 指令);**S1(工坊壳 + bento)与 S2(ppt-master 真 .pptx)均已开发完成并自测通过(2026-10-11),待负责人验收**;提交合入需负责人另行指令
- 背景: 负责人转发公众号文章《15.8k stars,Canvas 在 Web 办公领域的含金量还在上升》(开源小聪明,2026-09-23),问 Univer 可否集成;评估后确认可行,选型对比见 §1
- 前置阅读: `packages/plugin-artifact/src/index.ts`、`apps/web/src/components/DeliverablesView.tsx`、`apps/web/src/lib/cockpit-blocks.ts`

## 1. 选型结论(已拍板)

**Univer(github.com/dream-num/univer,Apache-2.0,15.8k star)**:Luckysheet 原团队官方继任者(Luckysheet 已停更并官方推荐迁移)。TS + 自研 Canvas 渲染(百万单元格 60fps)、前后端同构公式引擎(Node 脱机算公式,无需无头浏览器)、表格/文档/幻灯片/多维表共用一个内核、官方定位「Office Harness for AI Agents」(Worktree 草稿分支 + 人审 diff 合并,与本产品审批理念同构)。

落选方案及理由:

| 方案 | 结论 | 理由 |
|---|---|---|
| Figwright(Figma MCP) | ❌ 已否决 | Figma 插件走 local-only WebSocket(127.0.0.1:3055),必须与用户 Figma 桌面端同机;本产品服务器/容器部署形态开箱不通,隧道方案性价比低(负责人已拍板「算了」) |
| SpreadJS(葡萄城) | 备选 | Excel 保真度天花板 + 商业支持,但闭源、授权贵;未来有客户强需求且愿付费再评估 |
| OnlyOffice / Collabora | ❌ | 全家桶保真度高但 Docker 重部署;AGPL 对闭源商用有传染风险,需购商业授权 |
| FortuneSheet | ❌ | Luckysheet 社区分支,轻量带协同,但活跃度与功能深度不及 Univer,无服务端公式引擎与 AI 设计 |
| WPS WebOffice / 腾讯文档开放平台 | ❌ | 纯 SaaS 付费,数据过第三方,与自部署形态冲突 |

**PPT 结论**:Univer 开源版幻灯片只含数据模型,完整编辑 UI 在 Pro(付费);且开源界 web 端 PPT 在线编辑无成熟方案(行业空白)。因此 PPT 不做 web 在线编辑,走「Agent 生成、用户下载/放映」路线;具体候选(ppt-master 生成真 .pptx / qiaomu-bento-ppt 生成 HTML 演示页)见 §4。

## 2. 现状盘点(接入面)

产物链路已存在且完整,Univer 直接挂进该链路:

```
Agent 调 artifact_render 工具(code/html/markdown/chart 四类)
  → plugin-artifact ArtifactService(内存 Map,上限 50,超限淘汰最旧)
  → ctx.agent.emitEvent({type:'artifact'}) 广播
  → agent-backend case 'artifact' 挂到 mission.artifact + broadcast artifact_updated
  → mission 经 user-store saveUserMission 持久化(产物随任务落盘)
  → 前端 CockpitView(驾驶舱内联) + DeliverablesView(交付物页聚合)按 type 分支渲染
```

- `packages/protocol` `ArtifactData.type: 'code'|'html'|'markdown'|'chart'`,`content: string`。
- 仓库当前无任何 excel/office 前端依赖,底子干净。
- 办公工坊(`office-workshops.ts`)现为邮件分诊/周报,纯文本产物,不与本方案冲突。

## 3. 表格产物可编辑(P0 → **暂缓**,负责人 2026-10-11 拍板先不做;方案留档备启动)

### 3.1 协议层(packages/protocol)

`ArtifactData.type` 联合类型加 `'sheet'`;`content` 存 Univer 工作簿 JSON 快照(`IWorkbookData` 序列化)。不新增字段,快照即内容,随 mission 持久化链路自动落盘。

### 3.2 Agent 工具(packages/plugin-artifact)

`artifact_render` 的 `type` 枚举加 `sheet`,`content` 约定为工作簿 JSON;工具 description 补充触发时机(「整理数据成表格/报表时优先 sheet,而非 markdown 表格」)。Agent 产出结构化表格数据的两种输入形态都接受:

1. 完整 `IWorkbookData` JSON(多 sheet、样式、公式);
2. 简化形态(约定 `{"sheets":[{"name":"...","data":[[行],[行]]}]}`),前端组件归一化为 `IWorkbookData`——降低模型输出负担,减少 JSON 超长失败率。

### 3.3 前端(apps/web)

- 新组件 `components/artifacts/UniverSheetArtifact.tsx`:挂载 `@univerjs/presets` + `@univerjs/sheets-presets`,`next/dynamic` 懒加载(Univer 包体大,严禁进首屏 bundle);加载快照 → 可编辑 → 「保存」把最新快照写回(经现有 mission 更新通道,刷新不丢)→ 「下载 xlsx」调服务端导出。
- `DeliverablesView` 与 `CockpitView` 的产物渲染分支加 `sheet` case(图标 + 打开即挂 UniverSheetArtifact);列表页只渲染占位卡,点开才加载编辑器,控制内存。
- 编辑保存的去抖与冲突:同一产物以最后保存为准(单用户场景,一期不做多人协同)。

### 3.4 服务端(apps/web/api)

- 新路由 `POST /api/artifacts/export-xlsx`:入参工作簿 JSON,`exceljs`(MIT)生成 .xlsx 流式下载。一期只做导出;导入(解析外部 xlsx)放二期,规避兼容损耗争议。
- 脱机公式重算(`@univerjs` Node 端 Facade)一期不做——导出的 xlsx 带公式串,由 Excel/WPS 打开时自算,满足验收。

### 3.5 测试与验收

- 单测(vitest):协议类型守卫、简化形态→IWorkbookData 归一化纯函数、export-xlsx 路由(入参校验 + 生成文件头 magic bytes)。
- `npx tsc --noEmit` 全绿;现有 248 用例不回归。
- 手动验收链:对 Agent 说「帮我把 XX 整理成表格」→ 驾驶舱/交付物页出现可编辑真表格 → 手改单元格保存 → 刷新仍在 → 下载 xlsx 用 Excel/WPS 正常打开。

## 4. PPT 模块候选路线(P0.5,待负责人确认)

> 2026-10-11 补充:负责人点名评估 **ppt-master** 与 **bento** 两个开源项目,取代此前「pptxgenjs 手写模板」的初步设想(手写模板出片下限低,不再推荐)。

### 候选 A:ppt-master(github.com/hugohe3/ppt-master,MIT,~58k star)

- 形态:平台无关的 Agent Skill 工作流(SKILL.md + Python 脚本),要求 agent 能读写文件、执行命令、多轮对话——**agtpilot 的 sandbox_run_command + 文件工具满足,可脱离 Claude Code 接入**。
- 产出:**原生 DrawingML 可编辑 .pptx**(真形状/图表/表格/动画/演讲者备注)+ SVG 预览;输入 PDF/DOCX/URL/Markdown/纯文本/纯主题;支持用户自有 .pptx 转模板。
- 环境:Python 3.10+ + `pip install -r requirements.txt`;容器已内置 python3 venv(A股连接器,606c8fb),扩一个 venv 即可;可选 Pandoc、生图 API key(.env)。
- ⚠️ 许可注意:主仓 MIT;可选 PDF 转换依赖 PyMuPDF 为 AGPL-3.0——只装必选依赖、不启用 PDF 转换可规避,或在沙箱内进程隔离使用(不链接进主程序)。
- 接入方式:镜像内 git clone + venv;工坊「PPT 生成」把 SKILL.md 工作流注入 Agent prompt,产物 .pptx 挂 mission 供下载。工作量约 1~2 天(含镜像调整与工作流调优)。

### 候选 B:qiaomu-bento-ppt(github.com/joeseesun/qiaomu-bento-ppt,MIT,127 star)

- 形态:Agent Skill,`python3 bento_deck.py build deck.json --output result.bento.html`。
- 产出:**单文件 .bento.html**(bento 网格风演示页,浏览器内可编辑、可放映、离线可用);**无 pptx/pdf 导出**。
- 接入方式:产物直接走现有 `html` artifact 类型在中央画布放映,**前端零改造**;仅需沙箱 Python + npx 装 skill。工作量约 0.5 天。
- 风险:社区小(127 star、单人维护),形态是「网页演示」不是 Office 交付件。

### 对比结论

| 维度 | A · ppt-master | B · bento |
|---|---|---|
| 交付物 | 真 .pptx,可给他人用 Office/WPS 二改 | 单 HTML,只能浏览器放映 |
| 出片质量 | 高(58k star、70+ 示例、设计规则完整) | 中上(bento 风格化) |
| 接入成本 | 1~2 天(镜像 + 工作流) | 0.5 天(html 产物现成) |
| 项目风险 | 低(社区大) | 中(单人小项目) |

**建议**:两者不互斥——B 先上(近零成本,即时获得「Agent 一句话出演示页」体验),A 作为正式 PPT 交付件路线随后接入;若只选一个且需求是「PPT 文件交付」,选 A。pptxgenjs 手写模板路线废弃。

### 4.3 接入形态:PPT 工坊(负责人已拍板方向,2026-10-11)

PPT 能力以**工坊卡片**形态落地(与公众号/小红书/邮件分诊同范式:UI 收集结构化选项 → buildPrompt → Agent 执行),而非裸工具:

- **registry**:「PPT 演示稿」卡片,category 归 `office`(办公提效),现有分类不动。
- **表单字段**(`components/workshops/forms/PptWorkshopForm.tsx`):
  - 主题/材料(textarea;可直接粘贴文档文字;附件上传留二期)
  - 用途预设 chip:汇报提案 / 产品发布 / 培训课件 / 数据报告
  - 输出形态 chip:**网页演示页(bento,快,可直接放映)** / **PPTX 文件(ppt-master,可二改交付)**——按 §4 候选 A/B 双路线并存,用户按交付物选
  - 页数区间(约 8/12/20 页)、风格(商务/简约/深色,映射模板)
- **prompt 构建**(`ppt-workshop.ts`,格式即契约):注入对应 skill 的工作流指令摘要 + 创作红线(数据不编造、图表注明来源、大纲先行再排版);沿用 `buildWorkshopRun` / `recordRun` 既有机制。
- **产物挂载**:bento → 现有 `html` artifact,中央画布直接放映;ppt-master → `.pptx` 文件产物挂 mission,前端下载入口(产物类型扩展 `file`,或复用 sheet 一期的导出下载通道)。
- **沙箱前置**:镜像内 python3 venv + 两个 skill 预装(`npx skills add …` 或 git clone);沿用 606c8fb 的 venv 模式,skill 装进镜像避免运行时拉网。
- **分期**:工坊壳 + bento 路线先行(P0.5a,约 1 天);ppt-master 路线镜像就绪后接入(P0.5b,约 1 天,含 .pptx 产物下载链路)。

## 5. 二期展望(P1+,暂不排期)

1. **xlsx 导入**:exceljs/Univer headless 解析外部文件 → sheet 产物;明确告知兼容损耗边界。
2. **脱机公式重算**:Node 端跑 Univer 同构内核,报表工坊在服务器完成跨表重算,产物即终值。
3. **Worktree 式 AI 改动审阅**:借 Univer Office Harness 的草稿分支/diff 模型,对接现有审批卡片——AI 改表格先落草稿分支,用户画布内看 diff、一键合并;这是与「Agent 直接覆盖产物」的本质区别,也是选 Univer 的战略理由。
4. **文档形态(类 Word)**:Univer docs 成熟后评估图文报告产物从 markdown 升级。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| Univer 包体大(数 MB),拖慢首屏 | next/dynamic 懒加载 + 仅产物打开时挂载;构建后 bundle 分析把关 |
| 产物内存上限 50、大快照 JSON 撑大 mission 落盘体积 | sheet 快照做单元格数量/体积上限(超限提示 Agent 精简);持久化沿用现有链路不加新存储 |
| 模型输出大 JSON 易截断/格式错 | 简化输入形态(§3.2)+ 服务端 JSON 解析失败时降级为 markdown 表格产物,不阻塞任务 |
| 外部 xlsx 导入兼容损耗引发预期落差 | 一期不做导入;二期做时明确标注「尽力还原」 |
| Univer 仍在高速迭代,API 变动 | 锁 minor 版本;封装层(UniverSheetArtifact)隔离 API 面 |

## 7. 实施顺序与工作量(2026-10-11 按「只做 PPT」重排)

1. **S1:PPT 工坊壳 + bento 路线**(§4.3,约 1 天)——✅ **已完成(2026-10-11,未提交)**:
   - 工坊壳:`registry.ts` 新增 `ppt` 卡片(office/sky/Presentation)、`forms/PptWorkshopForm.tsx`(主题/材料/用途/风格/页数,输出形态 pptx 置灰预告)、`run.ts` case、`WorkshopsView` FORMS 登记;
   - Prompt 契约:`lib/ppt-workshop.ts`(skill 工作流七步 + 内容红线 + 降级路线;BENTO_SKILL_DIR=/opt/skills/qiaomu-bento-ppt);
   - 交付工具:`lib/ppt-deck.ts` `ppt_check_env` / `ppt_publish_deck`(服务端读工作区 .bento.html 直挂 ArtifactService type=html,8MB 上限,围栏同 plugin-sandbox;杜绝模型回显 600KB HTML),agent-backend 任务级注入;
   - html 产物渲染:CockpitView / DeliverablesView 新增 iframe srcDoc 沙箱放映分支(allow-scripts 无 same-origin)+ .html 下载 + 交付库「演示页」过滤与图标;
   - 镜像:Dockerfile 重型依赖层新增 skill 层(node fetch 固定 commit 55c63c8 tarball → /opt/skills,层尾 locate 自检,7.8MB);
   - 自测:tsc 全绿;vitest 297/297 通过(新增 ppt-workshop 9 例 + ppt-deck 12 例);bento build 本地冒烟(640KB 产物 0 error/warning,0.2s);Dockerfile 层命令逐字复现通过。
2. **S2:ppt-master 路线**(约 1 天)——✅ **已完成(2026-10-11,未提交,与 S1 同批待验收)**:
   - 协议扩展:`packages/protocol` `ArtifactData.type` 加 `'file'` + `fileMeta?`(fileId/fileName/mime/sizeBytes),二进制不进 mission JSON;前端 `ArtifactState` 同步;
   - 服务端文件库:`lib/artifact-files.ts`(`getDataDir()/artifact_files/<uid>/`,userId/fileId 双消毒 + 路径围栏、tmp+rename 原子写、manifest sidecar、32MB 上限);下载路由 `GET /api/artifacts/file?fileId=`(auth() 登录鉴权,只取本人分区,RFC 5987 中文文件名);
   - 交付工具:`lib/ppt-deck.ts` 新增 `ppt_publish_pptx`(围栏 .pptx、zip 魔数校验、体积上限、入库后以 type=file + fileMeta 挂 ArtifactService,content 只放人类可读摘要),agent-backend 注入 storeFile 闭包(绑定 uid);
   - Prompt 契约:`lib/ppt-workshop.ts` 新增 pptx 分支——ppt-master **Quick Generate**(全程无交互,不生成 spec/lock)12 步:环境自检 → attribution_guard 门禁 → 读规范 → `init --dir ppt`(关键:默认 PROJECTS_ROOT 在镜像只读区,--dir 指回沙箱工作区)→ import-sources → 大纲先行 → text_measure calibrate(Noto Sans CJK SC)→ 逐页手写 SVG(ppt169 1280×720)→ notes 拆分 → 终检零 error → `svg_to_pptx.py --quick-generate --with-notes` 导出 → ppt_publish_pptx 发布;附加红线(禁 finalize_svg/音频视频/装依赖)+ 降级路线(环境缺失回退 bento);
   - 表单/渲染:PptWorkshopForm 输出形态双 chip 解锁(output 状态化、hint 随行);CockpitView / DeliverablesView 新增 file 产物下载卡片(文件名/体积/一键下载)+ 交付库「文件」过滤;registry 卡片文案更新为双路线;
   - 镜像:Dockerfile 新增 ppt-master 层——codeload tarball 固定 commit b4efe3d、`--strip-components=3 --wildcards` 直解 skill 子树到 /opt/skills/ppt-master、裁 templates/sounds(13MB,工坊禁音频)、独立 venv /opt/ppt-master 只装核心六件(PyYAML/python-pptx/XlsxWriter/skia-pathops/uharfbuzz/Pillow,**排除 AGPL 的 PyMuPDF**)、apt fonts-noto-cjk(中文度量)、层尾 attribution_guard + import 双门禁;venv 不进 PATH(避免与 A股 venv 冲突),契约命令显式绝对路径;
   - 自测:tsc 全绿;vitest **311/311**(新增 artifact-files 6 例、ppt-deck +4、ppt-workshop +4);本机全链路冒烟(venv + 真 skill):guard → init --dir → 手写 SVG → 终检 0 error → notes 拆分 → 导出 16.7KB 真 .pptx(python-pptx 复读 1 slide 通过);Dockerfile 层命令用真实 tarball 逐字复现(布局/裁 sounds 66MB/双门禁全过)。
3. ~~表格产物下载若需通用 `file` 产物类型,随 S2 一并做协议扩展~~ ✅ 已随 S2 完成(见上「协议扩展」)。
4. ~~P0-a/b/c 表格三步~~ **暂缓**(§3 留档,启动时按原方案执行,约 1~1.5 天)。

合计本轮 PPT 工坊约 2 天。开发在 `~/dev/agtpilot` 仓进行,遵循仓内既有提交规范(中文 conventional commits),完成并自测通过后提交合入需负责人另行指令。
