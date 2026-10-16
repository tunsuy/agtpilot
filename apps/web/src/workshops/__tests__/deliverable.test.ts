import { describe, it, expect } from 'vitest';
import { hasWorkshopDeliverable } from '../deliverable';

/** 单条机会清单(契约格式子集:【项目】+ 链接 + ≥4 字段头,见 opportunities 解析器) */
const ossList = `【机会 1】
1
【项目】
vllm-project/vllm
【项目简介】
高吞吐 LLM 推理引擎,star 45k。
【机会链接】
https://github.com/vllm-project/vllm/issues/12345
【为什么适合你】
你主力是 Python + PyTorch,该 Issue 只涉及采样参数解析。
【难度】
低`;

describe('hasWorkshopDeliverable · 折叠边界豁免判定', () => {
  it('开源机会清单 → true', () => {
    expect(hasWorkshopDeliverable(ossList)).toBe(true);
  });

  it('步数耗尽强制总结的泛化散文 → false', () => {
    expect(
      hasWorkshopDeliverable(
        '调研完成,看板已收尾。清单与卡片均已交付(3 条机会:#470 参数对齐 / #488 标签与过滤),随时可以指定一条。',
      ),
    ).toBe(false);
  });

  it('空串/寒暄/过程叙述 → false', () => {
    expect(hasWorkshopDeliverable('')).toBe(false);
    expect(hasWorkshopDeliverable('好的,我先去查一下这个仓库的 open issues。')).toBe(false);
  });
});
