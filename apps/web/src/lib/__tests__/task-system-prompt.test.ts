import { describe, expect, it } from 'vitest';
import { buildTaskSystemPrompt } from '../task-system-prompt';

/**
 * loop 执行优化 P6:系统提示的并行检索指引。
 * 生产实测:热点日报 8 轮串行搜索每轮只发一个 query,而泛化的
 * 「独立调用并行发出」不足以改变检索行为 —— 必须给出具体操作指引
 * (拆多角度关键词/信息源,一轮批量发起)。
 */
describe('buildTaskSystemPrompt', () => {
  it('规则 6 给出独立检索的具体并行指引(拆角度→一轮批量→结果齐再汇总)', () => {
    const s = buildTaskSystemPrompt();
    expect(s).toContain('一轮批量发起');
    expect(s).toContain('每轮只发一个查询');
    expect(s).toContain('多角度');
  });

  it('行为准则完整保留(防调优中丢失红线)', () => {
    const s = buildTaskSystemPrompt();
    for (const keyword of [
      'AgtPilot',
      '区分对话与执行',
      '连接器工具优先',
      '中途授权',
      '结构化交付',
      '步数经济',
      '看板规划',
      '安静执行',
      '小红书托管边界',
      '公众号草稿箱边界',
      '发布永远由用户本人', // 小红书发布合规红线
      'freepublish', // 公众号群发红线
    ]) {
      expect(s).toContain(keyword);
    }
  });

  /**
   * 看板规划优化(对照 CC/Codex/Manus 公开实践):
   * - 正面触发清单(旧版只有反面清单「不要」,判「该」靠感觉)
   * - 「先规划后执行」时序(旧版没约束建板发生在动手之前)
   * - 追问注入后的重建语义(配合 steering 特性:【用户追加消息】改向时重建看板)
   */
  it('看板规划规则给出正面触发清单、规划先行时序与追问改向重建语义', () => {
    const s = buildTaskSystemPrompt();
    expect(s).toContain('三个以上异构动作'); // 正面触发判据
    expect(s).toContain('多个待办事项'); // 一条消息多事项也触发
    expect(s).toContain('再开始执行第一个动作'); // 先规划后执行
    expect(s).toContain('【用户追加消息】'); // steering 改向重建
    expect(s).toContain('重建看板'); // 重建出口
    // 看板策略已从步数经济里拆出独立规则(两条各自一个注意力锚点)
    expect(s.indexOf('【步数经济】')).toBeGreaterThan(0);
    expect(s.indexOf('【看板规划】')).toBeGreaterThan(s.indexOf('【步数经济】'));
  });

  it('用户记忆块按需插值:有值时插入、缺省时无空占位', () => {
    const withMemory = buildTaskSystemPrompt('【用户记忆】偏好中文交付');
    expect(withMemory).toContain('【用户记忆】偏好中文交付');
    const without = buildTaskSystemPrompt();
    expect(without).not.toContain('undefined');
    // 两次无记忆调用输出恒定(提示前缀稳定 = provider 缓存可命中)
    expect(without).toBe(buildTaskSystemPrompt());
  });

  it('思考经济规则锚定(推理模型不预演执行细节,生产实测 7.5 分钟过度思考修复)', () => {
    const s = buildTaskSystemPrompt();
    expect(s).toContain('【思考经济】');
    expect(s).toContain('脑内模拟不产生任何核验价值');
    expect(s).toContain('够决定下一步动作');
    // 规则编号连续:排在时效基准(11)之后
    expect(s.indexOf('【思考经济】')).toBeGreaterThan(s.indexOf('【时效基准】'));
  });
});
