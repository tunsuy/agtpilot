import { describe, it, expect } from 'vitest';
import { appendStepNotice, appendUserMessage, STEP_NOTICE_PREFIX, USER_MESSAGE_PREFIX } from './notice';

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

/** 用户追加消息注入(docs/design/mid-run-user-messages.md):
 *  任务进行中的追问经 prepareStep 注入 —— 前缀 + user 角色是与工具
 *  结果区分的双保险(Claude Code 生产踩过排队消息被误读为工具输出的坑) */
describe('appendUserMessage', () => {
  it('空消息返回 null(队列无消息时内核跳过,消息数组保持原样)', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    expect(appendUserMessage(messages, null)).toBeNull();
    expect(appendUserMessage(messages, undefined)).toBeNull();
    expect(appendUserMessage(messages, '')).toBeNull();
    expect(appendUserMessage(messages, '  \n ')).toBeNull();
  });

  it('排队消息以【用户追加消息】前缀的 user 消息追加到末尾', () => {
    const messages = [
      { role: 'user', content: '查一下 ai 最新发展' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'search_web', input: {} }] },
      { role: 'tool', content: '搜索结果…' },
    ];
    // 上层已把多条排队消息合并成一条(\n\n 拼接,对齐 Claude Code)
    const merged = '卡住了吗\n\n顺便也查下融资动态';
    const next = appendUserMessage(messages, merged);
    expect(next).not.toBeNull();
    expect(next!.length).toBe(4);
    expect(next![3]).toEqual({
      role: 'user',
      content: `${USER_MESSAGE_PREFIX}${merged}`,
    });
    // 前缀必须区别于治理提示,两者可能同帧注入
    expect(USER_MESSAGE_PREFIX).not.toBe(STEP_NOTICE_PREFIX);
  });

  it('不修改原消息数组(不可变追加),空白被裁剪', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const next = appendUserMessage(messages, '  追问内容  ');
    expect(messages.length).toBe(1);
    expect(next![1].content).toBe(`${USER_MESSAGE_PREFIX}追问内容`);
  });
});
