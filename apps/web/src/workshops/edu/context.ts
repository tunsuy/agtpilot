/**
 * 教研工坊 · 模板上下文(四模式各一个模板文件 + 三段共享正文)
 *
 * 与办公工坊(weekly/email_triage 包)、投研工坊(invest 包)同一模式:
 * UI 收集结构化选项 → 生成 Prompt → onRunPrompt 作为新任务交给 Agent 执行。
 * 学术数据全部来自用户已连接的 MCP 连接器:
 * - OpenAlex(2.5 亿+ 文献元数据检索)、alphaXiv(arXiv 论文全文/PDF 问答/语义检索)、
 *   Hugging Face(模型/数据集/论文)、DeepL(翻译润色)、DeepWiki(开源仓库问答);
 * - 缺数据源时用网络搜索尽力而为并明示,绝不编造文献。
 *
 * 模板拆分:prompt.literature_review / paper_read / lesson_plan / flashcards 四模式
 * 模板;数据源规则、学术诚信红线、质量红线为共享单源(各自独立 .md,无变量,
 * 渲染即剥惯例尾行)。卡片类型/格式提示与行内回退(focusParen 等)经变量注入。
 *
 * 学术诚信红线:每条参考文献必须来自真实检索结果,附 DOI 或 arXiv ID;
 * 严禁编造论文标题/作者/引用;拿不到全文就明说「仅据摘要」;
 * 工坊全程只读检索,不改用户文献库;报告投递(邮件/群机器人)必须先展示全文、经用户确认。
 */
import litTpl from './prompt.literature_review.md';
import paperTpl from './prompt.paper_read.md';
import lessonTpl from './prompt.lesson_plan.md';
import cardsTpl from './prompt.flashcards.md';
import dataSourcesTpl from './prompt.academic-sources.md';
import academicIntegrityTpl from './prompt.academic-integrity.md';
import generationIntegrityTpl from './prompt.generation-integrity.md';
import { renderTemplate } from '../engine';

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

const DELIVERY_NOTE: Record<string, string> = {
  email:
    '投递方式:成果先完整展示给我;经我确认后用 email_send 发送到我指定的邮箱(收件地址向我确认后再发,未经确认严禁发送)。',
  webhook:
    '投递方式:成果先完整展示给我;经我确认后用 notify_send_webhook 推送到我已配置的群机器人(飞书/钉钉/企微/Slack,未经确认严禁发送)。',
  chat: '投递方式:直接输出到对话即可。',
};

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
  // 共享段:模板无变量,渲染即剥惯例尾行
  const dataSources = renderTemplate(dataSourcesTpl, {});
  const academicIntegrityFooter = renderTemplate(academicIntegrityTpl, {});
  const generationIntegrityFooter = renderTemplate(generationIntegrityTpl, {});
  const deliveryNote = DELIVERY_NOTE[delivery] || DELIVERY_NOTE.chat;

  if (mode === 'paper_read') {
    const paper = (input.paper || '').trim();
    const focusText = (input.focus || '').trim();
    return renderTemplate(paperTpl, {
      dataSources,
      academicIntegrityFooter,
      deliveryNote,
      paper: paper || '(未填写——先向我询问论文标题 / arXiv ID / DOI / 链接,拿到后再继续)',
      focus: focusText,
      focusParen: focusText ? `(${focusText})` : '',
    });
  }

  if (mode === 'lesson_plan') {
    const subject = (input.subject || '').trim();
    return renderTemplate(lessonTpl, {
      generationIntegrityFooter,
      deliveryNote,
      subjectOrPlaceholder: subject || '(学科待我补充)',
      subject: subject || '(未填写,先问我)',
      grade: (input.grade || '').trim() || '(未填写,先问我)',
      topic: (input.topic || '').trim() || '(未填写,先问我)',
      duration: (input.duration || '').trim() || '1 课时(45 分钟)',
      extras: (input.extras || '').trim(),
    });
  }

  if (mode === 'flashcards') {
    const cardType = String(input.cardType || 'mixed');
    const cardFormat = String(input.cardFormat || 'anki_csv');
    return renderTemplate(cardsTpl, {
      generationIntegrityFooter,
      topic: (input.topic || '').trim(),
      cardTypeHint: CARD_TYPE_HINT[cardType] || CARD_TYPE_HINT.mixed,
      cardFormatHint: CARD_FORMAT_HINT[cardFormat] || CARD_FORMAT_HINT.anki_csv,
      material:
        (input.material || '').trim() ||
        '(未粘贴材料——先向我询问要制作卡片的学习内容,拿到后再继续)',
    });
  }

  // literature_review(默认)
  return renderTemplate(litTpl, {
    dataSources,
    academicIntegrityFooter,
    deliveryNote,
    topic:
      (input.topic || '').trim() ||
      '(未填写——先向我询问要综述的研究课题/关键词,拿到后再继续)',
    focus: (input.focus || '').trim(),
  });
}
