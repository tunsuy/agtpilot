【PPT 演示稿工坊 · PPTX 文件(ppt-master)】
{{optionsSection}}
制作流程(ppt-master skill 已预装在 {{pptSkillDir}},依赖装在独立 venv {{pptMasterPython}};命令中 ${SKILL_DIR} 一律展开为 {{pptSkillDir}} 绝对路径,严禁 cd 进 skill 目录):

**任务意图声明:本次是 Generate PPTX 路线的 Quick Generate(快速生成)—— 全程无交互:不向我提问、不等任何确认、不生成 design_spec.md / spec_lock.md、不走 Strategist/Confirm UI;所有未指明的选择由你直接决定。**

1. **环境自检**(sandbox_run_command):
   test -f {{pptSkillDir}}/SKILL.md && {{pptMasterPython}} -c "import yaml, pptx, pathops, uharfbuzz" && echo PPT-MASTER-READY
   失败(skill 或依赖缺失,常见于本地开发环境)→ 跳到末尾「降级路线」。
2. **完整性门禁**:{{pptMasterPython}} {{pptSkillDir}}/scripts/attribution_guard.py —— 非零退出立即停止,不得检查/修复/绕过。
3. **读规范**:cat {{pptSkillDir}}/SKILL.md、{{pptSkillDir}}/workflows/profiles/quick-generate.md(本次的执行权威)、{{pptSkillDir}}/references/canvas-formats.md、{{pptSkillDir}}/references/shared-standards-core.md;需要图表/图标时再读 {{pptSkillDir}}/templates/charts/chart-vocabulary.md 与 {{pptSkillDir}}/templates/icons/README.md。严禁凭记忆发明字段与流程。
4. **初始化项目**(在任务输出目录下):
   {{pptMasterPython}} {{pptSkillDir}}/scripts/project_manager.py init deck --quick-generate --dir ppt
   记下打印的项目路径(形如 ppt/deck_<日期>),后续命令的 <project_path> 都用它。若我提供了材料,先把材料原文写入 ppt/source-material.md(sandbox_write_file),再执行:
   {{pptMasterPython}} {{pptSkillDir}}/scripts/project_manager.py import-sources <project_path> ppt/source-material.md
5. **大纲先行**:把逐页 roster(每页:核心信息一句话 + 版式方向 + 密度 anchor/dense/breathing)简短输出到对话并落 <project_path>/deck-plan.md;无需停下等我确认,直接继续。
6. **文字度量校准**(排版前必做,防止文字溢出画布):
   {{pptMasterPython}} {{pptSkillDir}}/scripts/text_measure.py calibrate <project_path> --role title:<字体>:<字号> --role body:<字体>:<字号>
   中文 deck 字体用 Noto Sans CJK SC(镜像已装),西文/数字用 Arial;后续每页按校准表估算行宽。
7. **逐页手写 SVG** 到 <project_path>/svg_output/(零填充编号:01_cover.svg、02_xxx.svg…):
   - 画布 ppt169:根 <svg viewBox="0 0 1280 720" width="1280" height="720" lang="zh-CN" data-pptx-page-role="cover|section|content|ending">;首页 viewBox 即画布权威,所有页保持一致;
   - 文字只用 <text>/<tspan> 手动断行,禁止 foreignObject;颜色大写 #RRGGBB;XML 保留字符转义(&amp; 等),禁止 &nbsp; 之类 HTML 实体;
   - 图标/插图优先纯 SVG 自绘或文字排版;不调用生图 API、不联网搜图;
   - 每页写演讲者备注素材;页数 ≥7 时,写完第 5 页先跑一次早期质检(第 9 步命令把 --stage final 换成 --stage early)再继续。
8. **演讲者备注**:写 <project_path>/notes/total.md(每页一段:# Slide <N> 标题 + 正文,页间 --- 分隔,覆盖全部页),然后:
   {{pptMasterPython}} {{pptSkillDir}}/scripts/total_md_split.py <project_path>
9. **终检**(必须零 blocking error 才能导出;导出器会校验报告指纹与 svg_output/ 一致):
   {{pptMasterPython}} {{pptSkillDir}}/scripts/svg_quality_checker.py <project_path> --quick-generate --canonical-authoring --stage final --json
   有 error → 修复对应 SVG → 重跑同一命令;不得跳过或降级检查。
10. **导出 PPTX**:
    {{pptMasterPython}} {{pptSkillDir}}/scripts/svg_to_pptx.py <project_path> --quick-generate --with-notes
    产物在 <project_path>/exports/*.pptx(原生 DrawingML,可编辑)。禁止运行 finalize_svg.py;禁止生成 narration/音频/视频。
11. **发布产物**:调用 ppt_publish_pptx 工具(path 传 exports/ 下 .pptx 的工作区相对路径,title 传演示稿标题,description 传页数/画布/质检摘要)。严禁用 artifact_render 回显 .pptx 内容或 base64 —— 二进制必须走 ppt_publish_pptx 由服务端读文件入库。
12. **交付说明**:页数、画布与字体、质检结果(error/warning 处置)、下载方式(画布文件卡片一键下载 .pptx,PowerPoint/WPS/Keynote 可直接编辑)、missing evidence(未人工在 Office 里打开核验时如实标注,不得写成「已验证」)。

内容红线:
- 数据与事实不得编造:材料里没有、你也无法确证的数字/案例/引言一律不写,宁缺毋滥;
- 图表必须注明数据来源或标注「示意数据」;
- 大纲先行再排版,不得跳过 deck-plan 直接生成成品;
- 交付物必须保持单文件离线可用,不引入任何外链资源。

pptx 路线附加红线:
- 所有命令 ${SKILL_DIR} 用绝对路径 {{pptSkillDir}} 展开,解释器固定 {{pptMasterPython}},不装任何新依赖、不改 skill 目录;
- 不生成 design_spec.md / spec_lock.md / 确认卡片(Quick 契约);
- 不调用生图/搜图/联网接口,不生成音频视频;
- 中途上下文丢失就从头重跑 Quick,不做跨运行拼接。

降级路线(仅当第 1 步环境自检失败时):改走网页演示页(bento)路线 —— 调用 ppt_check_env,按其结果执行 bento 构建(规范与命令见 {{bentoSkillDir}},流程同「网页演示页」形态的制作流程 2~7 步,发布用 ppt_publish_deck),并在交付说明中注明「ppt-master 环境缺失,本次降级为网页演示页」。若 bento 也缺失,自行编写自包含 HTML 演示页用 artifact_render(type=html)发布。
