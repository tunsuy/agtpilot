/**
 * 教研工坊 · 文献综述 / 论文精读 / 智能备课 / 学习卡片(教育场景:老师/学生/研究者)
 *
 * 与办公工坊(office-workshops.ts)、投研工坊(invest-workshops.ts)同一模式:
 * UI 收集结构化选项 → 生成 Prompt → onRunPrompt 作为新任务交给 Agent 执行。
 * 学术数据全部来自用户已连接的 MCP 连接器:
 * - OpenAlex(2.5 亿+ 文献元数据检索)、alphaXiv(arXiv 论文全文/PDF 问答/语义检索)、
 *   Hugging Face(模型/数据集/论文)、DeepL(翻译润色)、DeepWiki(开源仓库问答);
 * - 缺数据源时用网络搜索尽力而为并明示,绝不编造文献。
 *
 * 学术诚信红线:每条参考文献必须来自真实检索结果,附 DOI 或 arXiv ID;
 * 严禁编造论文标题/作者/引用;拿不到全文就明说「仅据摘要」;
 * 工坊全程只读检索,不改用户文献库;报告投递(邮件/群机器人)必须先展示全文、经用户确认。
 */

// ---------- 工坊模式 ----------

export const EDU_MODES = [
  { id: 'literature_review', name: '文献综述' },
  { id: 'paper_read', name: '论文精读' },
  { id: 'lesson_plan', name: '智能备课' },
  { id: 'flashcards', name: '学习卡片' },
] as const;

export type EduMode = (typeof EDU_MODES)[number]['id'];

// ---------- 学习卡片:卡片类型 ----------

export const FLASHCARD_TYPES = [
  { id: 'qa', name: '问答卡' },
  { id: 'cloze', name: '填空卡' },
  { id: 'mixed', name: '混合(问答+填空)' },
] as const;

export type FlashcardType = (typeof FLASHCARD_TYPES)[number]['id'];

// ---------- 学习卡片:输出格式 ----------

export const FLASHCARD_FORMATS = [
  { id: 'anki_csv', name: 'Anki 可导入 CSV' },
  { id: 'markdown', name: 'Markdown 表格' },
  { id: 'plain', name: '纯文本' },
] as const;

export type FlashcardFormat = (typeof FLASHCARD_FORMATS)[number]['id'];

// ---------- 报告投递方式(与投研/周报工坊一致) ----------

export const EDU_DELIVERIES = [
  { id: 'chat', name: '仅输出到对话' },
  { id: 'email', name: '确认后发邮件' },
  { id: 'webhook', name: '确认后发群机器人' },
] as const;

export type EduDelivery = (typeof EDU_DELIVERIES)[number]['id'];

export interface EduWorkshopInput {
  mode: EduMode | string;
  /** literature_review / lesson_plan:课题或教学主题 */
  topic?: string;
  /** literature_review / paper_read:额外关注点(如「近 3 年」「重点看方法论」「只要综述」) */
  focus?: string;
  /** paper_read:论文标识(标题 / arXiv ID / DOI / URL) */
  paper?: string;
  /** lesson_plan:学科 */
  subject?: string;
  /** lesson_plan:学段年级(如「初中二年级」「大学本科生」) */
  grade?: string;
  /** lesson_plan:课时数 */
  duration?: string;
  /** lesson_plan:教材版本 / 学情 / 特殊要求 */
  extras?: string;
  /** flashcards:粘贴的学习材料原文 */
  material?: string;
  /** flashcards:卡片类型 */
  cardType?: FlashcardType | string;
  /** flashcards:输出格式 */
  cardFormat?: FlashcardFormat | string;
  /** 报告投递方式(文献综述/论文精读/备课适用;学习卡片固定输出到对话) */
  delivery?: EduDelivery | string;
}

/** 学术数据源使用规则(文献综述/论文精读共用):按已连连接器取材,缺失降级为网络搜索并明示 */
const ACADEMIC_SOURCE_RULES = `数据源使用规则(只用已连接的,缺失的直接跳过,不要反复重试):
- 学术文献元数据检索(标题/作者/年份/引用数/摘要/机构):优先 OpenAlex 工具(openalex 开头)
- arXiv 论文全文、PDF 内容问答、语义检索、研究者追踪:alphaXiv 工具(alphaxiv 开头)
- AI/机器学习方向的模型、数据集、论文:Hugging Face 工具(huggingface 开头)
- 开源代码库理解(论文配套实现等):DeepWiki 工具(deepwiki 开头)
- 中文资料、教材、课程、政策、最新动态:网络搜索工具
- 外文文献翻译、术语润色:DeepL 工具(deepl 开头,若已授权)
若以上学术连接器一个都没配置,用网络搜索尽力完成,并在报告开头注明「未配置学术连接器,检索范围受限;建议到连接器页配置 OpenAlex / alphaXiv 以获得全面文献数据」。`;

const ACADEMIC_INTEGRITY_FOOTER = `学术诚信红线(必须遵守):
- 每一条参考文献都必须来自真实检索结果,并附 DOI 或 arXiv ID(拿不到就注明「未获取到标识符」),严禁编造论文标题、作者、期刊或引用数据。
- 引用具体数据/结论时标注来源文献;只读到摘要没读到全文的,明确写「据摘要」,不要把摘要脑补成全文结论。
- 综述观点与我方分析要区分:哪些是文献原话、哪些是你的归纳,不能混为一谈。
- 本次任务为只读检索:严禁修改我的文献库、严禁调用任何写入/删除类工具。`;

const GENERATION_INTEGRITY_FOOTER = `质量红线:
- 备课/卡片内容必须紧扣我给的主题与材料,知识点表述准确,不确定的概念先向我确认或标注「需教师核定」,不要编造事实、公式或引文。
- 涉及具体数据、年份、定义时,拿不准就用网络搜索核实并注明来源。
- 本次任务不修改我的任何资料库,只产出内容供我取用。`;

function deliverySection(delivery: string): string {
  if (delivery === 'email') {
    return `投递方式:成果先完整展示给我;经我确认后用 email_send 发送到我指定的邮箱(收件地址向我确认后再发,未经确认严禁发送)。`;
  }
  if (delivery === 'webhook') {
    return `投递方式:成果先完整展示给我;经我确认后用 notify_send_webhook 推送到我已配置的群机器人(飞书/钉钉/企微/Slack,未经确认严禁发送)。`;
  }
  return `投递方式:直接输出到对话即可。`;
}

const CARD_TYPE_HINT: Record<string, string> = {
  qa: '问答卡(正面问题 → 背面答案)',
  cloze: '填空卡(用 {{...}} 标记挖空,兼容 Anki 填空模板)',
  mixed: '混合:核心概念出问答卡,关键术语/公式/年份出填空卡',
};

const CARD_FORMAT_HINT: Record<string, string> = {
  anki_csv:
    'Anki 可导入 CSV:每张卡一行,问答卡为「正面,背面」两列,填空卡为「文本,类型标记」;含逗号/换行的字段用英文双引号包裹;首行给一行注释说明导入方式(制表符或逗号分隔、字段含义),放在代码块里方便我直接复制。',
  markdown: 'Markdown 表格:问答卡两列(正面/背面),填空卡两列(文本/答案);便于我预览与打印。',
  plain: '纯文本:每张卡用「Q: … / A: …」或「填空: … / 答案: …」两行表示,卡之间空一行。',
};

export function buildEduPrompt(input: EduWorkshopInput): string {
  const mode = String(input.mode || 'literature_review');
  const delivery = String(input.delivery || 'chat');

  if (mode === 'paper_read') {
    const paper = (input.paper || '').trim();
    const focusText = (input.focus || '').trim();
    const focusSection = focusText ? `\n我的额外关注点:${focusText}(精读时优先展开这一维度)` : '';
    return `【教研工坊 · 论文精读】
${ACADEMIC_SOURCE_RULES}

要精读的论文:${paper || '(未填写——先向我询问论文标题 / arXiv ID / DOI / 链接,拿到后再继续)'}
(可用标识:论文标题、arXiv ID 如 2506.13538、DOI、或 URL)${focusSection}

步骤:
1. 先定位论文:用 OpenAlex / alphaXiv / 网络搜索找到这篇文章,确认标题、作者、发表年份与出处(找不到就先问我核对标识,不要拿相近的论文顶替)。
2. 尽力获取全文(alphaXiv 的 PDF 内容问答优先);只能拿到摘要时明确说明,后续结论标注「据摘要」。
3. 输出一张「论文精读卡」:
   - 一句话概括:这篇论文解决了什么问题、给出了什么核心答案
   - 研究背景与动机:它针对的痛点、前人工作的不足
   - 核心方法/思路:关键技术方案、与前人方法的区别(有公式/架构就讲清直觉,不堆符号)
   - 实验与结论:主要实验设置、关键结果数据、作者声称的贡献
   - 局限与争议:作者承认的局限 + 你看到的潜在问题/适用边界
   - 术语表:文中出现的关键术语,每个一句话中文解释(需要时用 DeepL 辅助翻译)
   - 与我的关联:结合我的关注点${focusText ? `(${focusText})` : ''},这篇对我可能的启发或可借鉴之处
4. 附本文的规范引用格式(含 DOI/arXiv ID)与 3-5 篇它引用或相关的延伸阅读。
${deliverySection(delivery)}

${ACADEMIC_INTEGRITY_FOOTER}`;
  }

  if (mode === 'lesson_plan') {
    const subject = (input.subject || '').trim();
    const grade = (input.grade || '').trim();
    const topic = (input.topic || '').trim();
    const duration = (input.duration || '').trim();
    const extras = (input.extras || '').trim();
    const extrasSection = extras ? `\n补充要求(教材版本 / 学情 / 特殊安排):${extras}` : '';
    return `【教研工坊 · 智能备课】
你是一位经验丰富的${subject ? subject : '(学科待我补充)'}教研老师,请为我生成一份可直接用于课堂的教案。

基本信息:
- 学科:${subject || '(未填写,先问我)'}
- 学段年级:${grade || '(未填写,先问我)'}
- 课题:${topic || '(未填写,先问我)'}
- 课时:${duration || '1 课时(45 分钟)'}${extrasSection}

(以上信息不全时,先列出你的假设向我确认,或直接就缺失项提问,不要凭空设定学段与教材。)

步骤:
1. 必要时用网络搜索核对该学段的课程标准/教学大纲要求与主流教材对该知识点的处理,确保定位准确。
2. 输出结构化教案(Markdown):
   - 教学目标:分「知识与技能 / 过程与方法 / 情感态度价值观」三维,用可观测的行为动词表述
   - 教学重点与难点:各 1-3 条,并说明难点成因与突破策略
   - 学情分析:该学段学生已有基础与常见误区
   - 教学过程:按时间轴分环节(导入 / 新授 / 探究或例题 / 巩固练习 / 小结 / 作业布置),每环节标注预计时长、教师活动、学生活动、设计意图
   - 板书设计:用文字或简易结构图描述主板书布局
   - 课件大纲:逐页列出 PPT 每页标题与要点(便于我直接做课件)
   - 随堂测评:5-10 道题(选择/填空/简答混搭),每题附答案与简要解析,覆盖重点、区分基础与提高
   - 分层作业:基础题 / 提高题 / 拓展题各若干
   - 教学反思(留白):给我 2-3 个课后自问的问题
3. 全篇紧扣我给定的学段与课时,难度与容量匹配,不要超纲或堆砌。
${deliverySection(delivery)}

${GENERATION_INTEGRITY_FOOTER}`;
  }

  if (mode === 'flashcards') {
    const material = (input.material || '').trim();
    const topic = (input.topic || '').trim();
    const cardType = String(input.cardType || 'mixed');
    const cardFormat = String(input.cardFormat || 'anki_csv');
    const topicSection = topic ? `\n卡片主题(用于聚焦与命名):${topic}` : '';
    return `【教研工坊 · 学习卡片】
请把学习材料转成便于记忆复习的抽认卡(用于 Anki 等间隔重复软件)。
${topicSection}
卡片类型:${CARD_TYPE_HINT[cardType] || CARD_TYPE_HINT.mixed}
输出格式:${CARD_FORMAT_HINT[cardFormat] || CARD_FORMAT_HINT.anki_csv}

学习材料原文:
${material || '(未粘贴材料——先向我询问要制作卡片的学习内容,拿到后再继续)'}

步骤:
1. 通读材料,提炼需要记忆的核心概念、定义、公式、关键事实、易混点。
2. 按指定卡片类型出题,遵循记忆卡最佳实践:
   - 每张卡只考一个知识点(原子化),避免一张卡塞多个问题
   - 正面用提问/挖空触发主动回忆,背面答案简洁准确
   - 覆盖全面但不重复;材料里的重要术语不遗漏
   - 需要时用 DeepL 保证中英术语翻译准确(若已授权)
3. 生成 15-40 张卡(材料很长时先覆盖主干,并在末尾问我是否继续),按指定格式输出在代码块里方便我直接复制/导入。
4. 末尾统计:共几张卡、问答与填空各几张、覆盖了哪些知识模块。

投递方式:直接输出到对话即可(卡片内容我会自行复制导入)。

${GENERATION_INTEGRITY_FOOTER}`;
  }

  // literature_review(默认)
  const topic = (input.topic || '').trim();
  const focusText = (input.focus || '').trim();
  const focusSection = focusText
    ? `\n我的额外要求(时间范围 / 侧重 / 语言等):${focusText}(综述时优先满足这些约束)`
    : '';
  return `【教研工坊 · 文献综述】
${ACADEMIC_SOURCE_RULES}

综述课题:${topic || '(未填写——先向我询问要综述的研究课题/关键词,拿到后再继续)'}${focusSection}

步骤:
1. 拆解课题为 2-4 组检索关键词(含中英文),分别用 OpenAlex / alphaXiv / 网络搜索检索;优先近 5 年、被引量高、发表在主流会议或期刊的文献。检索式与命中数量在报告里简要交代。
2. 筛选出 10-20 篇最具代表性的文献(宁缺毋滥,每篇都要真实存在),通读摘要(能拿到全文更好),归类。
3. 输出结构化文献综述(Markdown):
   - 引言:课题背景、为什么重要、综述范围与方法(检索了哪些库、时间跨度)
   - 研究脉络与流派:按主题/方法/时间把文献分成 2-4 个子方向,每个方向概述代表性工作、核心思路与进展
   - 重点文献表:表格列出「标题 | 作者(首作 et al.) | 年份 | 出处 | DOI/arXiv ID | 一句话贡献」
   - 研究现状小结:当前主流做法、共识结论
   - 研究空白与争议:尚未解决的问题、方法局限、相互矛盾的结论——这部分是你综述的价值所在
   - 未来方向:3-5 条值得跟进的研究机会
   - 参考文献:规范引用格式(GB/T 7714 或 APA,二选一并统一),每条附 DOI 或 arXiv ID
4. 涉及外文文献,关键术语给出中文对照(需要时用 DeepL 辅助)。
${deliverySection(delivery)}

${ACADEMIC_INTEGRITY_FOOTER}`;
}
