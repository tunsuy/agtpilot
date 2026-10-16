/**
 * 工坊参考资料(交付物复用):把平时会话的交付物作为资料带进工坊任务。
 *
 * 设计:prompt 里只带引用 id + 标题(不进正文),Agent 动笔前用
 * read_reference_material 工具(见 lib/reference-materials.ts)按需拉取全文。
 * 相对内联拼接:prompt 不膨胀、长文不截断、params 体积恒定(file 类型产物
 * 也可引用,正文由工具端解析)。
 * 数据流:表单用 collectWorkshopMaterials(missions) 列出可选交付物 →
 * 用户勾选 → 表单把 resolveMaterials(items, ids) 收进 params.materials →
 * 各工坊 skill run() 经 parseMaterials + buildMaterialsSection 拼进 prompt 末尾。
 * 无勾选时 section 为空字符串,拼进 prompt 的结果与原来逐字节一致(金测不受影响)。
 */

/** 表单勾选后随 params 传递的引用条目(仅 id + 标题,无正文) */
export interface WorkshopMaterial {
  id: string;
  title: string;
}

/** 选择器展示用的交付物条目(从任务列表汇总) */
export interface MaterialOption {
  id: string;
  title: string;
  missionTitle?: string;
  type: string;
  timestamp: number;
}

/** 单次任务可引用条数上限 */
export const MATERIAL_COUNT_LIMIT = 5;

/**
 * 从任务列表汇总可选交付物(与 DeliverablesView 同口径:任务 artifact 去重)。
 * 注意 file 类型也列出(正文由 read_reference_material 工具端解析,不再经 prompt)。
 */
export function collectWorkshopMaterials(
  missions: Array<{
    id: string;
    title: string;
    startedAt: number;
    artifact?: { title?: string; content?: string; type?: string } | null;
  }>
): MaterialOption[] {
  const seen = new Set<string>();
  const out: MaterialOption[] = [];
  for (const m of missions) {
    const content = m.artifact?.content || '';
    const isFile = (m.artifact?.type || 'markdown') === 'file';
    if ((!content && !isFile) || seen.has(content)) continue;
    seen.add(content);
    out.push({
      id: `art_${m.id}`,
      title: m.artifact?.title || m.title || '交付成果',
      missionTitle: m.title,
      type: m.artifact?.type || 'markdown',
      timestamp: m.startedAt,
    });
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

/** 按勾选 id 解析出随 params 传递的引用条目(只 id + 标题,超限丢弃多余) */
export function resolveMaterials(options: MaterialOption[], ids: string[]): WorkshopMaterial[] {
  return options
    .filter((o) => ids.includes(o.id))
    .slice(0, MATERIAL_COUNT_LIMIT)
    .map((o) => ({ id: o.id, title: o.title }));
}

/** 收敛表单 params.materials(宽松 Record 透传,防手造/历史脏数据) */
export function parseMaterials(v: unknown): WorkshopMaterial[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (m): m is WorkshopMaterial =>
        !!m && typeof m === 'object' && typeof (m as WorkshopMaterial).id === 'string'
    )
    .map((m) => ({
      id: m.id,
      title: typeof m.title === 'string' ? m.title : '参考资料',
    }))
    .slice(0, MATERIAL_COUNT_LIMIT);
}

/**
 * 拼进 prompt 末尾的参考资料段:只列引用 id + 标题,并指令 Agent 动笔前
 * 先用 read_reference_material 全部读一遍。空数组返回空字符串(调用方直接
 * 拼接即可,无资料时 prompt 与原来逐字节一致)。
 */
export function buildMaterialsSection(materials: WorkshopMaterial[]): string {
  if (materials.length === 0) return '';
  const lines = materials.map((m, i) => `【资料${i + 1}：${m.title}】(materialId=${m.id})`);
  return (
    `\n\n【参考资料】\n` +
    `以下是我之前会话的交付物引用(仅列标题,正文不在这里):动笔前必须用 read_reference_material ` +
    `工具把下面每一条都读一遍,涉及的事实、数据、观点优先采用引用内容;引用解析失败则按其它要求继续创作并注明。\n` +
    lines.join('\n')
  );
}
