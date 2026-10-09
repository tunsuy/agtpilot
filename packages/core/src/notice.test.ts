import { describe, it, expect } from 'vitest';
import { appendStepNotice, STEP_NOTICE_PREFIX } from './notice';

describe('appendStepNotice', () => {
  it('空提示返回 null(调用方跳过注入)', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    expect(appendStepNotice(messages, null)).toBeNull();
    expect(appendStepNotice(messages, undefined)).toBeNull();
    expect(appendStepNotice(messages, '')).toBeNull();
    expect(appendStepNotice(messages, '   \n  ')).toBeNull();
  });

  it('有效提示追加到末尾且带统一前缀', () => {
    const messages = [
      { role: 'user', content: '帮我查一下' },
      { role: 'assistant', content: '好的' },
    ];
    const next = appendStepNotice(messages, '连接器 EXA 授权已撤销(纪元 0→1)');
    expect(next).not.toBeNull();
    expect(next!.length).toBe(3);
    expect(next![2]).toEqual({
      role: 'user',
      content: `${STEP_NOTICE_PREFIX}连接器 EXA 授权已撤销(纪元 0→1)`,
    });
  });

  it('不修改原消息数组(不可变追加)', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const next = appendStepNotice(messages, '记忆 m1 已被用户删除');
    expect(messages.length).toBe(1);
    expect(next).not.toBe(messages);
  });

  it('提示文本两端空白被裁剪', () => {
    const next = appendStepNotice([], '  权限已收窄  ');
    expect(next![0].content).toBe(`${STEP_NOTICE_PREFIX}权限已收窄`);
  });

  it('messages 为空/undefined 时也能安全注入', () => {
    const next = appendStepNotice(undefined as any, '治理事件');
    expect(next!.length).toBe(1);
    expect(next![0].role).toBe('user');
  });
});
