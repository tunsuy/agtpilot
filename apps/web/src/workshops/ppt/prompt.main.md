【PPT 演示稿工坊 · 网页演示页(bento)】
{{optionsSection}}
制作流程(qiaomu-bento-ppt skill 已预装在 {{bentoSkillDir}},纯 Python 标准库脚本,构建全程无需联网):

1. **环境自检**:调用 ppt_check_env 工具。ready=true 走下面正式路线;skill 缺失(本地开发环境)直接跳到末尾「降级路线」。
2. **读规范(严禁凭记忆发明字段)**:用 sandbox_run_command 阅读 skill 内置资料——
   - cat {{bentoSkillDir}}/SKILL.md
   - cat {{bentoSkillDir}}/references/upstream/bento-format.md(重点:BentoDoc 顶层结构、Elements、Format invariants、Minimal valid document)
   - cat {{bentoSkillDir}}/examples/qiaomu-bento-ppt-intro.json(成品 deck.json 范例)
3. **大纲先行**:先把逐页大纲(每页:任务/核心信息/视觉主语/notes 要点)简短输出到对话,再落 ppt/deck-plan.md(sandbox_write_file);工坊表单已收集我的意图,无需停下等我确认大纲,直接继续。
4. **起草 deck.json**(sandbox_write_file 写入 ppt/deck.json):
   - format "bento/slides"、size 1280×720;新建文档不带 collab/template/readonly 字段,不手写 docId(构建时 --new-document 生成);
   - theme 按风格要求:一套主色、最多两套字体;
   - 内容映射:数字→chart(option 必须是纯 JSON,bar/line 数据用纯数字,禁止函数 formatter)、规格/对比→table、关键数字→countUp、流程→path、同一对象跨页变化→morph(稳定 id);
   - 每页一个视觉主语,画面与正文不复读同一句话;每页写 speaker notes;
   - 离线承诺:严禁外链图片/字体/媒体,插图用 shape/svg 自绘或纯文字排版。
5. **构建与验证**(sandbox_run_command,在任务输出目录下):
   python3 {{bentoSkillDir}}/scripts/bento_deck.py build ppt/deck.json --output ppt/deck.bento.html --new-document --report ppt/reports/deck-validation.json
   再读 ppt/reports/deck-validation.json:有 error 必须修复后重新 build;有 warning(文字越界/关键文字过小/空 notes 等)逐项修复,确实无法消除的在交付说明中解释。
6. **发布产物**:调用 ppt_publish_deck 工具(path 传 ppt/deck.bento.html,title 传演示稿标题)。严禁把 .bento.html 内容粘贴进 artifact_render —— 文件约 600KB+,必须走 ppt_publish_deck 由服务端读文件挂画布。
7. **交付说明**:页数、风格、验证结果(errors/warnings 处置)、放映方式(中央画布直接放映;可下载 .bento.html 双击离线打开,浏览器内即可继续编辑与演示)、missing evidence(未做真实浏览器人工核验时如实标注,不得写成「已验证」)。

内容红线:
- 数据与事实不得编造:材料里没有、你也无法确证的数字/案例/引言一律不写,宁缺毋滥;
- 图表必须注明数据来源或标注「示意数据」;
- 大纲先行再排版,不得跳过 deck-plan 直接生成成品;
- 交付物必须保持单文件离线可用,不引入任何外链资源。

降级路线(仅当 ppt_check_env 报告 skill 缺失时):自行编写一个自包含 HTML 演示页(内联 style/script、16:9 分页、键盘 ←→ 翻页、页码指示、无外链资源),用 artifact_render(type=html)发布,并在交付说明中注明「bento skill 缺失,本次为降级产物」。
