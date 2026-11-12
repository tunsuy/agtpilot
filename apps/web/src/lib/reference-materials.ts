/**
 * 参考资料引用工具 · 工坊「参考资料」(会话交付物复用)的服务端解析端。
 *
 * 设计:工坊 prompt 里只带引用 id + 标题(几十字符,不进正文),Agent 动笔前
 * 用本工具按需拉取全文。相对内联拼接的好处:prompt 不膨胀(省 token、
 * 不稀释注意力)、长文不截断、params 不进 localStorage 历史。
 * 只读(dangerLevel low,readOnly),按 uid 用户分区读取自己任务的 artifact。
 */
import { getUserMissions } from './user-store';
import { loadMaterialUploadManifest, readMaterialText, UPLOAD_ID_RE } from './material-uploads';

/** 服务端单次返回正文上限(字符);超出标记 truncated,Agent 可分段追读。
 *  取值 14000:分页结果经 JSON 序列化(转义膨胀 + success/title/nextOffset 外壳)
 *  后仍须低于内核 TOOL_OUTPUT_LIMIT(16384 字符),否则会触发 spill 落盘换指针、
 *  反而多一轮续读往返。旧值 8000 让 4 万字符文档分 5 页读,每页进上下文后在
 *  后续每轮全量重发滚雪球(生产实测:一篇公众号文输入 126.6k tokens,重发占
 *  约六成);调大后同文档 3 页读完,常见 ≤14k 字符文档一页读完。 */
export const REFERENCE_CONTENT_LIMIT = 14000;

export interface ReferenceMaterialBody {
  id: string;
  title: string;
  missionTitle?: string;
  content: string;
  truncated: boolean;
}

/**
 * 按引用 id 解析资料正文。两种来源(同一工具、同一分段语义):
 * - `art_<missionId>`(兼容裸 missionId):会话交付物,正文在 mission JSON;
 * - `upl_<时间36进制>_<hex>`:本地上传文件(2026-10-20),正文在上传库
 *   (text 直读原件;pdf/docx 读上传时抽取的纯文本)。
 * 均按 userId 分区,只能读自己名下的资料。
 */
export function resolveReferenceMaterial(
  userId: string,
  refId: string
): ReferenceMaterialBody | null {
  const raw = (refId || '').trim();
  if (!raw) return null;

  if (UPLOAD_ID_RE.test(raw)) {
    const manifest = loadMaterialUploadManifest(userId, raw);
    const content = readMaterialText(userId, raw);
    if (!manifest || !content) return null;
    return {
      id: raw,
      title: manifest.title || manifest.fileName || '上传资料',
      content,
      truncated: content.length > REFERENCE_CONTENT_LIMIT,
    };
  }

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
