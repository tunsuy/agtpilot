/**
 * 参考资料引用工具 · 工坊「参考资料」(会话交付物复用)的服务端解析端。
 *
 * 设计:工坊 prompt 里只带引用 id + 标题(几十字符,不进正文),Agent 动笔前
 * 用本工具按需拉取全文。相对内联拼接的好处:prompt 不膨胀(省 token、
 * 不稀释注意力)、长文不截断、params 不进 localStorage 历史。
 * 只读(dangerLevel low,readOnly),按 uid 用户分区读取自己任务的 artifact。
 */
import type { ToolDefinition } from '@agtpilot/core';
import { getUserMissions } from './user-store';

/** 服务端单次返回正文上限(字符);超出标记 truncated,Agent 可分段追读 */
export const REFERENCE_CONTENT_LIMIT = 8000;

export interface ReferenceMaterialBody {
  id: string;
  title: string;
  missionTitle?: string;
  content: string;
  truncated: boolean;
}

/**
 * 按引用 id 解析交付物正文。id 形如 `art_<missionId>`(表单勾选时生成),
 * 兼容裸 missionId(容错:历史 params 手填)。
 */
export function resolveReferenceMaterial(
  userId: string,
  refId: string
): ReferenceMaterialBody | null {
  const raw = (refId || '').trim();
  if (!raw) return null;
  const missionId = raw.startsWith('art_') ? raw.slice(4) : raw;
  let missions: any[] = [];
  try {
    missions = getUserMissions(userId) || [];
  } catch {
    return null;
  }
  const mission = missions.find((m: any) => m?.id === missionId);
  const content = mission?.artifact?.content || '';
  if (!content) return null;
  return {
    id: raw,
    title: mission?.artifact?.title || mission?.title || '参考资料',
    ...(mission?.title ? { missionTitle: mission.title } : {}),
    content,
    truncated: content.length > REFERENCE_CONTENT_LIMIT,
  };
}

export function buildReferenceTools(userId: string): ToolDefinition[] {
  return [
    {
      name: 'read_reference_material',
      description:
        '读取本次任务 prompt【参考资料】段列出的引用交付物全文(只读):' +
        '传入 materialId(如 art_<任务id>),返回该交付物的标题与正文(超长截断并标记,' +
        '需要剩余部分时用 offset 参数继续读)。动笔前必须先把列出的引用全部读一遍,' +
        '事实、数据、观点优先采用引用内容。只能读你自己的任务交付物,无权读他人任务。',
      dangerLevel: 'low',
      readOnly: true, // 只读并行门控:纯读自己任务的 artifact,无副作用
      // 零命中收敛兜底(token 文档 §9.5):带参考资料的任务不保证命中检索关键词,
      // 兜底档常驻本工具,防止「有引用却读不到」
      fallback: true,
      parameters: {
        type: 'object',
        properties: {
          materialId: {
            type: 'string',
            description: '引用 id(【参考资料】段中【资料N】括号内的 materialId)',
          },
          offset: {
            type: 'number',
            description: '超长截断后继续读取的起始字符位置(默认 0)',
          },
        },
        required: ['materialId'],
      },
      execute: async ({ materialId, offset }: any) => {
        const body = resolveReferenceMaterial(userId, String(materialId || ''));
        if (!body) {
          return {
            success: false,
            error:
              `引用 ${materialId} 解析失败(任务不存在、无交付物或已被删除)。` +
              '降级路径:按 prompt 其它要求与联网调研继续创作,并在成稿处注明该引用不可用。',
          };
        }
        const from = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Math.floor(Number(offset)) : 0;
        const full = body.content;
        const slice = full.slice(from, from + REFERENCE_CONTENT_LIMIT);
        const end = from + slice.length;
        return {
          success: true,
          id: body.id,
          title: body.title,
          ...(body.missionTitle ? { missionTitle: body.missionTitle } : {}),
          content: slice,
          truncated: end < full.length,
          ...(end < full.length
            ? { nextOffset: end, hint: `还有剩余内容,用 offset=${end} 继续读` }
            : {}),
        };
      },
    },
  ];
}

/** 工具提供方注册表条目(tool-providers.ts) */
export const TOOL_PROVIDER: import('./tool-providers').ToolProvider = {
  id: 'reference',
  deps: ['uid'],
  build: ({ uid }) => buildReferenceTools(uid),
};
