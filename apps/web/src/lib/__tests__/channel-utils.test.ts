import { describe, it, expect } from 'vitest';
import { extractFinalAnswer, parseChannelCommand } from '../channel-utils';

/**
 * channel-utils 纯函数用例(铁律 6)。
 * 刻意不 import channel-service(重依赖链:agent-backend → runtime),
 * 被测函数已抽到无 IO 模块。
 */

describe('extractFinalAnswer', () => {
  it('取最后一条 assistant 的 answer', () => {
    const mission: any = {
      steps: [
        { role: 'assistant', answer: '第一条' },
        { role: 'user', content: '追问' },
        { role: 'assistant', answer: '最终答复' },
      ],
    };
    expect(extractFinalAnswer(mission)).toBe('最终答复');
  });

  it('trim 空白', () => {
    const mission: any = { steps: [{ role: 'assistant', answer: '  答复  ' }] };
    expect(extractFinalAnswer(mission)).toBe('答复');
  });

  it('跳过没有 answer 的 assistant 步骤', () => {
    const mission: any = {
      steps: [
        { role: 'assistant', answer: '有效答复' },
        { role: 'assistant' }, // 工具步骤,无 answer
        { role: 'assistant', answer: '   ' }, // 纯空白不算
      ],
    };
    expect(extractFinalAnswer(mission)).toBe('有效答复');
  });

  it('无 steps / 空 mission → null', () => {
    expect(extractFinalAnswer(null)).toBeNull();
    expect(extractFinalAnswer(undefined)).toBeNull();
    expect(extractFinalAnswer({ steps: [] } as any)).toBeNull();
    expect(extractFinalAnswer({} as any)).toBeNull();
  });
});

describe('parseChannelCommand', () => {
  it('绑定指令(中文/英文/多余空白)', () => {
    expect(parseChannelCommand('绑定 123456')).toEqual({ type: 'bind', code: '123456' });
    expect(parseChannelCommand('bind 000001')).toEqual({ type: 'bind', code: '000001' });
    expect(parseChannelCommand('  绑定   654321  ')).toEqual({ type: 'bind', code: '654321' });
  });

  it('绑定码必须恰好 6 位数字', () => {
    expect(parseChannelCommand('绑定 12345')).toBeNull();
    expect(parseChannelCommand('绑定 1234567')).toBeNull();
    expect(parseChannelCommand('绑定 abcdef')).toBeNull();
    expect(parseChannelCommand('绑定')).toBeNull();
  });

  it('解绑指令(大小写不敏感)', () => {
    expect(parseChannelCommand('解绑')).toEqual({ type: 'unbind' });
    expect(parseChannelCommand('unbind')).toEqual({ type: 'unbind' });
    expect(parseChannelCommand(' UNBIND ')).toEqual({ type: 'unbind' });
  });

  it('新会话指令(/new 与 中文)', () => {
    expect(parseChannelCommand('/new')).toEqual({ type: 'new' });
    expect(parseChannelCommand('新会话')).toEqual({ type: 'new' });
  });

  it('普通消息不是指令', () => {
    expect(parseChannelCommand('帮我查一下天气')).toBeNull();
    expect(parseChannelCommand('')).toBeNull();
    expect(parseChannelCommand('   ')).toBeNull();
    // 指令词混在句子里不算(必须整句匹配)
    expect(parseChannelCommand('我想解绑账号')).toBeNull();
    expect(parseChannelCommand('请绑定 123456 谢谢')).toBeNull();
  });
});
