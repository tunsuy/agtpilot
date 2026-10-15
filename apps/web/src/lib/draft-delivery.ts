import type { MissionStep } from '../types/agent';

/**
 * 草稿投递态检测(笔记包/文章包「存草稿箱」按钮的防重复投递)。
 *
 * 生产实例(2026-10):卡片按钮点击只是发一条续聊投递指令,任务跑完后按钮
 * 原样可点 —— 再点就再投一轮审批、再存一份重复草稿。按钮的终态不该由
 * 卡片自己的 useState 记(卡片从 answer 重解析挂载,状态随重挂丢失),
 * 而要从 mission 步骤推导:落稿工具成功执行过、且标题或正文命中本篇
 * (正文做第二判据:模型偶尔微调标题,长正文几乎必逐字 —— 内嵌投递)。
 * 任务在飞(ACTIVE/WAITING_APPROVAL/QUEUED)期间按钮一律禁用:投递轮
 * 进行中不可再发,排队路径对投递指令本就该关死。
 */

export interface DraftDeliveryIndex {
  /** 已成功落稿的标题集合( trimmed ) */
  titles: Set<string>;
  /** 已成功落稿的正文集合( trimmed;zh body / mp content 均归一到此) */
  bodies: Set<string>;
}

const EMPTY_INDEX: DraftDeliveryIndex = { titles: new Set(), bodies: new Set() };

/** 扫描任务步骤:deliverTool 的 DONE 调用收集标题/正文入索引 */
export function buildDraftDeliveryIndex(
  steps: MissionStep[] | undefined | null,
  deliverTool: string | undefined,
): DraftDeliveryIndex {
  if (!deliverTool || !steps?.length) return EMPTY_INDEX;
  const titles = new Set<string>();
  const bodies = new Set<string>();
  for (const s of steps) {
    if (s.tool !== deliverTool || s.status !== 'DONE') continue;
    const t = s.args?.title;
    if (typeof t === 'string' && t.trim()) titles.add(t.trim());
    const b = s.args?.body ?? s.args?.content;
    if (typeof b === 'string' && b.trim()) bodies.add(b.trim());
  }
  return { titles, bodies };
}

/** 本篇是否已投递:标题或正文任一命中 */
export function isDraftDelivered(
  index: DraftDeliveryIndex | undefined,
  title: string | undefined,
  body: string,
): boolean {
  if (!index) return false;
  const t = typeof title === 'string' ? title.trim() : '';
  const b = typeof body === 'string' ? body.trim() : '';
  if (t && index.titles.has(t)) return true;
  return Boolean(b) && index.bodies.has(b);
}
