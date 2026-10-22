/**
 * 移动端对话态(mobile/MobileConversationView)配套纯函数。
 *
 * vitest 环境是 node(无 jsdom/RTL,组件渲染测试归 e2e),新增可测逻辑一律
 * 放这里。分块/轮次分组/折叠边界复用 lib/cockpit-blocks(已测,与桌面驾驶舱
 * 同源),本文件只补两枚:
 * - chatAvailability:对话内容三态判定 —— 终态会话 wire 下发被 strip
 *   (steps 已剥、懒回水在途),不能误判成「空会话」;
 * - summarizeProcessBlocks:「任务过程 · N 项」折叠摘要行统计,从桌面
 *   CockpitView 轮次渲染的 inline 逻辑抽纯,口径逐字一致。
 */
import { processElapsedMs, type CockpitBlock } from './cockpit-blocks';
import type { Mission } from '../types/agent';

export type ChatAvailability = 'ready' | 'loading' | 'empty';

/**
 * 对话内容三态:
 * - ready:有 steps,直接渲染聊天流(含发送后的乐观气泡);
 * - loading:终态摘要(stripped,steps 已剥)等待懒回水回填 —— 历史内容
 *   拉取中;发消息续聊不受影响(服务端读自己的存储,不依赖客户端副本);
 * - empty:无 steps 且非 stripped(新会话待命/历史缺失),待命空态。
 */
export function chatAvailability(mission: Mission | null): ChatAvailability {
  if (!mission) return 'empty';
  if (mission.steps?.length) return 'ready';
  if (mission.stripped) return 'loading';
  return 'empty';
}

/**
 * 整轮过程折叠摘要行统计(桌面 CockpitView 同款口径):
 * - count:工具块数真实动作行(带 tool 或失败的步骤),思考/回复/通知块计 1;
 * - failed:失败步骤数;
 * - elapsedMs:首步开始 → 末步结束的墙钟时间(思考/检索间隙也计入,
 *   processElapsedMs 与桌面同源),全无计时数据返回 undefined。
 */
export function summarizeProcessBlocks(processBlocks: CockpitBlock[]): {
  count: number;
  failed: number;
  elapsedMs: number | undefined;
} {
  const count = processBlocks.reduce(
    (n, b) =>
      n +
      (b.type === 'tools'
        ? b.steps.filter((s) => s.tool || s.status === 'FAILED').length
        : 1),
    0
  );
  const failed = processBlocks.reduce(
    (n, b) =>
      n +
      (b.type === 'tools'
        ? b.steps.filter((s) => s.status === 'FAILED').length
        : 0),
    0
  );
  const elapsedMs = processElapsedMs(
    processBlocks.flatMap((b) => (b.type === 'tools' ? b.steps : [b.step]))
  );
  return { count, failed, elapsedMs };
}
