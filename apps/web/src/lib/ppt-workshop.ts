/**
 * PPT 演示稿工坊 · Prompt 构建器(格式即契约)
 *
 * 与办公工坊(office-workshops.ts)同一模式:UI 收集结构化选项 → 生成 Prompt →
 * 作为新任务交给 Agent 执行。产出双路线(方案见 docs/design/univer-office-integration-plan.md §4):
 * - bento(网页演示页):镜像预装 qiaomu-bento-ppt skill(MIT,纯 Python 标准库),
 *   Agent 经 sandbox_run_command/sandbox_write_file 构建单文件 .bento.html,
 *   再用 ppt_publish_deck 工具(ppt-deck.ts)服务端读文件挂上中央画布 —— 严禁让模型
 *   把 ~600KB 的 HTML 壳回显进 artifact_render content(撑爆上下文);
 * - pptx(S2,ppt-master 路线):镜像预装 ppt-master skill(MIT)+ 独立 venv,
 *   Agent 按 Quick Generate profile(全程无交互)手写 SVG → 质检 → 导出原生
 *   可编辑 .pptx,用 ppt_publish_pptx 收进服务端文件库(type=file,前端下载卡片)。
 *
 * 红线:数据不编造、图表注来源、大纲先行再排版、无外链媒体(离线单文件承诺)。
 */
import { createSkillService } from '@agtpilot/plugin-skill';

/** 镜像内 bento skill 固定安装路径(Dockerfile 层 tarball 固定 commit 解包于此);pack 注册表查不到时兜底 */
export const BENTO_SKILL_DIR = '/opt/skills/qiaomu-bento-ppt';

/** 镜像内 ppt-master skill 固定安装路径(SKILL_DIR 契约:命令一律用此绝对路径展开);pack 注册表查不到时兜底 */
export const PPT_MASTER_SKILL_DIR = '/opt/skills/ppt-master';

// 沙箱技能包统一经 plugin-skill 的 pack 注册表发现(扫 AGTPILOT_SKILL_PACK_DIRS,
// 缺省 /opt/skills,读 SKILL.md frontmatter 元数据;60s 缓存)。注册表查不到
// (如 dev 机没有 /opt/skills)时回落上面的镜像固定路径 —— 生产镜像上两者同值。
const skillPacks = createSkillService();

/** 按目录名(优先)或 frontmatter name 查 pack 实际路径;查不到用 fallback */
function resolvePackDir(folder: string, fallback: string): string {
  const packs = skillPacks.listPacks();
  const hit = packs.find((p) => p.dir.endsWith(`/${folder}`)) || skillPacks.getPack(folder);
  return hit?.dir || fallback;
}

/** bento skill 目录(注册表解析,ppt-deck/环境自检/工坊 prompt 共用) */
export function bentoSkillDir(): string {
  return resolvePackDir('qiaomu-bento-ppt', BENTO_SKILL_DIR);
}

/** ppt-master skill 目录(注册表解析) */
export function pptMasterSkillDir(): string {
  return resolvePackDir('ppt-master', PPT_MASTER_SKILL_DIR);
}

/**
 * ppt-master 专用 venv 解释器(装有 python-pptx/skia-pathops/uharfbuzz 等)。
 * 不进 PATH(PATH 首位是 A股 venv),契约里全部命令显式用该绝对路径。
 */
export const PPT_MASTER_PYTHON = '/opt/ppt-master/bin/python3';

export const PPT_PURPOSES = [
  { id: 'report', name: '汇报提案' },
  { id: 'launch', name: '产品发布' },
  { id: 'training', name: '培训课件' },
  { id: 'data', name: '数据报告' },
] as const;

export const PPT_STYLES = [
  { id: 'business', name: '商务' },
  { id: 'minimal', name: '简约' },
  { id: 'dark', name: '深色' },
] as const;

export const PPT_PAGE_OPTIONS = [8, 12, 20] as const;

/** 输出形态:bento 网页演示页 / pptx 真文件(ppt-master,S2 已接入) */
export const PPT_OUTPUTS = [
  { id: 'bento', name: '网页演示页', hint: 'bento 单文件 HTML,画布直接放映,可下载离线编辑' },
  { id: 'pptx', name: 'PPTX 文件', hint: 'ppt-master 导出原生可编辑 .pptx,Office/WPS 可直接二改' },
] as const;

export type PptPurpose = (typeof PPT_PURPOSES)[number]['id'];
export type PptStyle = (typeof PPT_STYLES)[number]['id'];
export type PptOutput = (typeof PPT_OUTPUTS)[number]['id'];

export interface PptWorkshopInput {
  /** 主题(建议必填;与材料都为空时 Agent 会先询问) */
  topic?: string;
  /** 用户粘贴的材料原文(文档文字/要点/数据) */
  material?: string;
  purpose: PptPurpose | string;
  style: PptStyle | string;
  /** 约多少页(含封面/结尾) */
  pages: number;
  output?: PptOutput | string;
}

/** 用途 → 叙事结构建议(与 bento workflow.md 的 1a/2b/3c 方向卡对齐) */
const PURPOSE_NARRATIVE: Record<string, string> = {
  report: '决策型叙事:现状 → 选项/进展 → 权衡 → 建议 → 下一步',
  launch: '叙事型:一个冲突 → 一条变化 → 一项结论,情绪曲线递进,主视觉突出',
  training: '教学型:概念 → 机制 → 示例 → 练习 → 总结,每页一个知识点,信息密度克制',
  data: '数据看板型:总览结论先行 → 趋势 → 归因 → 行动建议,数字尽量图表化',
};

/** 风格 → 视觉方向(一套主色、最多两套字体;bento theme 与 SVG 配色通用) */
const STYLE_THEME: Record<string, string> = {
  business: '深蓝主色 + 灰白底,克制留白,数据图表为主视觉',
  minimal: '黑白灰 + 单一强调色,大字号标题,大量留白,拒绝装饰性元素',
  dark: '深黑/炭色底 + 高亮强调色(如橙/青),适合发布会与暗场演示',
};

/** 两条路线共用的用户选项段 + 材料段(格式即契约,测试锚定关键串) */
function buildOptionsSection(input: {
  topicText: string;
  materialText: string;
  purposeName: string;
  styleName: string;
  narrative: string;
  themeHint: string;
  pageCount: number;
}): string {
  const { topicText, materialText, purposeName, styleName, narrative, themeHint, pageCount } = input;
  const materialSection = materialText
    ? `\n我提供的材料(内容以此为准,可补充结构但不得改变事实与数据):\n---\n${materialText}\n---\n`
    : `\n材料:未提供(基于主题与你自身知识创作,所有数据必须真实并标注来源或时间口径)。\n`;
  return `请为我制作一份${purposeName}用途的演示稿。

- 主题:${topicText || '未指定(材料中也提炼不出主题时,先在对话里问我,不要凭空自拟开跑)'}
- 用途:${purposeName} —— ${narrative}
- 风格:${styleName} —— ${themeHint}
- 页数:约 ${pageCount} 页(含封面与结尾页,可在 ±2 页内浮动)${materialSection}`;
}

/** 两条路线共用的内容红线 */
const CONTENT_RED_LINES = `内容红线:
- 数据与事实不得编造:材料里没有、你也无法确证的数字/案例/引言一律不写,宁缺毋滥;
- 图表必须注明数据来源或标注「示意数据」;
- 大纲先行再排版,不得跳过 deck-plan 直接生成成品;
- 交付物必须保持单文件离线可用,不引入任何外链资源。`;

/** bento 网页演示页路线(qiaomu-bento-ppt,纯标准库) */
function buildBentoRoute(): string {
  const SK = bentoSkillDir();
  return `制作流程(qiaomu-bento-ppt skill 已预装在 ${SK},纯 Python 标准库脚本,构建全程无需联网):

1. **环境自检**:调用 ppt_check_env 工具。ready=true 走下面正式路线;skill 缺失(本地开发环境)直接跳到末尾「降级路线」。
2. **读规范(严禁凭记忆发明字段)**:用 sandbox_run_command 阅读 skill 内置资料——
   - cat ${SK}/SKILL.md
   - cat ${SK}/references/upstream/bento-format.md(重点:BentoDoc 顶层结构、Elements、Format invariants、Minimal valid document)
   - cat ${SK}/examples/qiaomu-bento-ppt-intro.json(成品 deck.json 范例)
3. **大纲先行**:先把逐页大纲(每页:任务/核心信息/视觉主语/notes 要点)简短输出到对话,再落 ppt/deck-plan.md(sandbox_write_file);工坊表单已收集我的意图,无需停下等我确认大纲,直接继续。
4. **起草 deck.json**(sandbox_write_file 写入 ppt/deck.json):
   - format "bento/slides"、size 1280×720;新建文档不带 collab/template/readonly 字段,不手写 docId(构建时 --new-document 生成);
   - theme 按风格要求:一套主色、最多两套字体;
   - 内容映射:数字→chart(option 必须是纯 JSON,bar/line 数据用纯数字,禁止函数 formatter)、规格/对比→table、关键数字→countUp、流程→path、同一对象跨页变化→morph(稳定 id);
   - 每页一个视觉主语,画面与正文不复读同一句话;每页写 speaker notes;
   - 离线承诺:严禁外链图片/字体/媒体,插图用 shape/svg 自绘或纯文字排版。
5. **构建与验证**(sandbox_run_command,在任务输出目录下):
   python3 ${SK}/scripts/bento_deck.py build ppt/deck.json --output ppt/deck.bento.html --new-document --report ppt/reports/deck-validation.json
   再读 ppt/reports/deck-validation.json:有 error 必须修复后重新 build;有 warning(文字越界/关键文字过小/空 notes 等)逐项修复,确实无法消除的在交付说明中解释。
6. **发布产物**:调用 ppt_publish_deck 工具(path 传 ppt/deck.bento.html,title 传演示稿标题)。严禁把 .bento.html 内容粘贴进 artifact_render —— 文件约 600KB+,必须走 ppt_publish_deck 由服务端读文件挂画布。
7. **交付说明**:页数、风格、验证结果(errors/warnings 处置)、放映方式(中央画布直接放映;可下载 .bento.html 双击离线打开,浏览器内即可继续编辑与演示)、missing evidence(未做真实浏览器人工核验时如实标注,不得写成「已验证」)。

${CONTENT_RED_LINES}

降级路线(仅当 ppt_check_env 报告 skill 缺失时):自行编写一个自包含 HTML 演示页(内联 style/script、16:9 分页、键盘 ←→ 翻页、页码指示、无外链资源),用 artifact_render(type=html)发布,并在交付说明中注明「bento skill 缺失,本次为降级产物」。`;
}

/**
 * ppt-master 真 .pptx 路线(S2):Quick Generate profile,全程无交互。
 * 关键契约(命令均已在真 skill 上冒烟验证):
 * - SKILL_DIR 绝对路径展开,严禁 cd 进 skill 目录;
 * - init 必须带 --dir ppt(默认 PROJECTS_ROOT 在镜像只读区,工作区才可写);
 * - 质检 --quick-generate --canonical-authoring --stage final --json 零 error 才许导出;
 * - 导出 svg_to_pptx.py <project_path> --quick-generate --with-notes;
 * - 产物走 ppt_publish_pptx,严禁回显二进制。
 */
function buildPptxRoute(): string {
  const SK = pptMasterSkillDir();
  const PY = PPT_MASTER_PYTHON;
  return `制作流程(ppt-master skill 已预装在 ${SK},依赖装在独立 venv ${PY};命令中 \${SKILL_DIR} 一律展开为 ${SK} 绝对路径,严禁 cd 进 skill 目录):

**任务意图声明:本次是 Generate PPTX 路线的 Quick Generate(快速生成)—— 全程无交互:不向我提问、不等任何确认、不生成 design_spec.md / spec_lock.md、不走 Strategist/Confirm UI;所有未指明的选择由你直接决定。**

1. **环境自检**(sandbox_run_command):
   test -f ${SK}/SKILL.md && ${PY} -c "import yaml, pptx, pathops, uharfbuzz" && echo PPT-MASTER-READY
   失败(skill 或依赖缺失,常见于本地开发环境)→ 跳到末尾「降级路线」。
2. **完整性门禁**:${PY} ${SK}/scripts/attribution_guard.py —— 非零退出立即停止,不得检查/修复/绕过。
3. **读规范**:cat ${SK}/SKILL.md、${SK}/workflows/profiles/quick-generate.md(本次的执行权威)、${SK}/references/canvas-formats.md、${SK}/references/shared-standards-core.md;需要图表/图标时再读 ${SK}/templates/charts/chart-vocabulary.md 与 ${SK}/templates/icons/README.md。严禁凭记忆发明字段与流程。
4. **初始化项目**(在任务输出目录下):
   ${PY} ${SK}/scripts/project_manager.py init deck --quick-generate --dir ppt
   记下打印的项目路径(形如 ppt/deck_<日期>),后续命令的 <project_path> 都用它。若我提供了材料,先把材料原文写入 ppt/source-material.md(sandbox_write_file),再执行:
   ${PY} ${SK}/scripts/project_manager.py import-sources <project_path> ppt/source-material.md
5. **大纲先行**:把逐页 roster(每页:核心信息一句话 + 版式方向 + 密度 anchor/dense/breathing)简短输出到对话并落 <project_path>/deck-plan.md;无需停下等我确认,直接继续。
6. **文字度量校准**(排版前必做,防止文字溢出画布):
   ${PY} ${SK}/scripts/text_measure.py calibrate <project_path> --role title:<字体>:<字号> --role body:<字体>:<字号>
   中文 deck 字体用 Noto Sans CJK SC(镜像已装),西文/数字用 Arial;后续每页按校准表估算行宽。
7. **逐页手写 SVG** 到 <project_path>/svg_output/(零填充编号:01_cover.svg、02_xxx.svg…):
   - 画布 ppt169:根 <svg viewBox="0 0 1280 720" width="1280" height="720" lang="zh-CN" data-pptx-page-role="cover|section|content|ending">;首页 viewBox 即画布权威,所有页保持一致;
   - 文字只用 <text>/<tspan> 手动断行,禁止 foreignObject;颜色大写 #RRGGBB;XML 保留字符转义(&amp; 等),禁止 &nbsp; 之类 HTML 实体;
   - 图标/插图优先纯 SVG 自绘或文字排版;不调用生图 API、不联网搜图;
   - 每页写演讲者备注素材;页数 ≥7 时,写完第 5 页先跑一次早期质检(第 9 步命令把 --stage final 换成 --stage early)再继续。
8. **演讲者备注**:写 <project_path>/notes/total.md(每页一段:# Slide <N> 标题 + 正文,页间 --- 分隔,覆盖全部页),然后:
   ${PY} ${SK}/scripts/total_md_split.py <project_path>
9. **终检**(必须零 blocking error 才能导出;导出器会校验报告指纹与 svg_output/ 一致):
   ${PY} ${SK}/scripts/svg_quality_checker.py <project_path> --quick-generate --canonical-authoring --stage final --json
   有 error → 修复对应 SVG → 重跑同一命令;不得跳过或降级检查。
10. **导出 PPTX**:
    ${PY} ${SK}/scripts/svg_to_pptx.py <project_path> --quick-generate --with-notes
    产物在 <project_path>/exports/*.pptx(原生 DrawingML,可编辑)。禁止运行 finalize_svg.py;禁止生成 narration/音频/视频。
11. **发布产物**:调用 ppt_publish_pptx 工具(path 传 exports/ 下 .pptx 的工作区相对路径,title 传演示稿标题,description 传页数/画布/质检摘要)。严禁用 artifact_render 回显 .pptx 内容或 base64 —— 二进制必须走 ppt_publish_pptx 由服务端读文件入库。
12. **交付说明**:页数、画布与字体、质检结果(error/warning 处置)、下载方式(画布文件卡片一键下载 .pptx,PowerPoint/WPS/Keynote 可直接编辑)、missing evidence(未人工在 Office 里打开核验时如实标注,不得写成「已验证」)。

${CONTENT_RED_LINES}

pptx 路线附加红线:
- 所有命令 \${SKILL_DIR} 用绝对路径 ${SK} 展开,解释器固定 ${PY},不装任何新依赖、不改 skill 目录;
- 不生成 design_spec.md / spec_lock.md / 确认卡片(Quick 契约);
- 不调用生图/搜图/联网接口,不生成音频视频;
- 中途上下文丢失就从头重跑 Quick,不做跨运行拼接。

降级路线(仅当第 1 步环境自检失败时):改走网页演示页(bento)路线 —— 调用 ppt_check_env,按其结果执行 bento 构建(规范与命令见 ${bentoSkillDir()},流程同「网页演示页」形态的制作流程 2~7 步,发布用 ppt_publish_deck),并在交付说明中注明「ppt-master 环境缺失,本次降级为网页演示页」。若 bento 也缺失,自行编写自包含 HTML 演示页用 artifact_render(type=html)发布。`;
}

export function buildPptWorkshopPrompt({
  topic,
  material,
  purpose,
  style,
  pages,
  output,
}: PptWorkshopInput): string {
  const purposeName = PPT_PURPOSES.find((p) => p.id === purpose)?.name || '演示稿';
  const styleName = PPT_STYLES.find((s) => s.id === style)?.name || '商务';
  const narrative = PURPOSE_NARRATIVE[purpose] || PURPOSE_NARRATIVE.report;
  const themeHint = STYLE_THEME[style] || STYLE_THEME.business;
  const pageCount = PPT_PAGE_OPTIONS.includes(pages as never) ? pages : 12;
  const topicText = (topic || '').trim();
  const materialText = (material || '').trim();

  const optionsSection = buildOptionsSection({
    topicText,
    materialText,
    purposeName,
    styleName,
    narrative,
    themeHint,
    pageCount,
  });

  if (output === 'pptx') {
    return `【PPT 演示稿工坊 · PPTX 文件(ppt-master)】
${optionsSection}
${buildPptxRoute()}`;
  }

  return `【PPT 演示稿工坊 · 网页演示页(bento)】
${optionsSection}
${buildBentoRoute()}`;
}
