import { describe, it, expect } from 'vitest';
import { buildDraftDeliveryIndex, isDraftDelivered } from '../draft-delivery';
import type { MissionStep } from '../../types/agent';

/**
 * 草稿投递态检测(防重复投递,2026-10 生产实例):
 * 点击「存入草稿箱」只是发一条续聊投递指令,任务跑完按钮原样可点 →
 * 再点就是第二轮审批 + 重复草稿。终态必须从 mission 步骤推导:
 * - 落稿工具 DONE 且标题或正文命中本篇 → 已投递(正文兜底:模型偶尔微调标题);
 * - 失败/被拒的调用不算 DONE → 按钮回到可点(可重试);
 * - 工具未执行(status 还在 RUNNING)或非落稿工具 → 不命中。
 */

const step = (over: Partial<MissionStep>): MissionStep => ({
  id: `s_${Math.random()}`,
  title: 't',
  status: 'DONE',
  ...over,
});

const DONE_SAVE = step({ tool: 'xhs_save_note_draft', args: { title: '标题A', body: '正文内容' } });

describe('buildDraftDeliveryIndex', () => {
  it('落稿工具 DONE 调用的标题/正文进索引;body/content 双字段名都归一', () => {
    const idx = buildDraftDeliveryIndex(
      [DONE_SAVE, step({ tool: 'wechat_mp_create_draft', args: { title: '标题B', content: '公众号正文' } })],
      'wechat_mp_create_draft',
    );
    expect(idx.titles.has('标题B')).toBe(true);
    expect(idx.bodies.has('公众号正文')).toBe(true);
    expect(idx.titles.has('标题A')).toBe(false); // 其他工具的调用不相干
  });

  it('失败/执行中的落稿调用不算投递成功(被拒后可重试)', () => {
    const idx = buildDraftDeliveryIndex(
      [step({ tool: 'xhs_save_note_draft', status: 'FAILED', args: { title: '标题A', body: '正文内容' } })],
      'xhs_save_note_draft',
    );
    expect(idx.titles.size).toBe(0);
    expect(idx.bodies.size).toBe(0);
  });

  it('未声明 deliverTool / 无步骤 → 空索引(无检测,不误伤)', () => {
    expect(buildDraftDeliveryIndex([DONE_SAVE], undefined).titles.size).toBe(0);
    expect(buildDraftDeliveryIndex(undefined, 'xhs_save_note_draft').bodies.size).toBe(0);
  });

  it('命中判据:标题精确命中,或正文命中(模型微调标题的兜底);空白不误命中', () => {
    const idx = buildDraftDeliveryIndex([DONE_SAVE], 'xhs_save_note_draft');
    expect(isDraftDelivered(idx, '标题A', '别的正文')).toBe(true); // 标题命中
    expect(isDraftDelivered(idx, '模型改过的标题', '正文内容')).toBe(true); // 正文兜底
    expect(isDraftDelivered(idx, '其他标题', '其他正文')).toBe(false);
    expect(isDraftDelivered(idx, '', '')).toBe(false); // 空白不当命中
    expect(isDraftDelivered(undefined, '标题A', '正文内容')).toBe(false); // 无索引
  });
});
