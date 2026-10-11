import { describe, it, expect } from 'vitest';
import { narrateStep, formatActivityDuration } from '../activity-narration';
import type { MissionStep } from '../../types/agent';

const step = (partial: Partial<MissionStep>): MissionStep => ({
  id: `step_${Math.random().toString(36).slice(2)}`,
  title: 'x',
  status: 'DONE',
  ...partial,
});

describe('narrateStep 工具映射', () => {
  it('搜索工具带 query 内联到叙述', () => {
    const n = narrateStep(step({ tool: 'search_web', args: { query: 'AI Agent 演进' } }));
    expect(n?.kind).toBe('search');
    expect(n?.label).toBe('搜索「AI Agent 演进」');
  });

  it('搜索工具无 query 兜底', () => {
    const n = narrateStep(step({ tool: 'search_tavily', args: {} }));
    expect(n?.label).toBe('搜索资料');
  });

  it('browser_navigate 带 URL 细节', () => {
    const n = narrateStep(step({ tool: 'browser_navigate', args: { url: 'https://github.com/trending' } }));
    expect(n?.kind).toBe('browser');
    expect(n?.label).toBe('打开网页');
    expect(n?.detail).toBe('https://github.com/trending');
  });

  it('browser_click 映射点击,长 text 截断', () => {
    const n = narrateStep(step({ tool: 'browser_click', args: { text: 'a'.repeat(100) } }));
    expect(n?.label).toBe('点击网页元素');
    expect(n?.detail?.endsWith('…')).toBe(true);
    expect(n?.detail?.length).toBeLessThanOrEqual(61);
  });

  it('sandbox 三件套分别叙述命令/文件/目录', () => {
    expect(narrateStep(step({ tool: 'sandbox_run_command', args: { command: 'pip list' } }))?.label).toBe('运行命令');
    expect(narrateStep(step({ tool: 'sandbox_read_file', args: { path: '/tmp/a.md' } }))?.label).toBe('读取文件');
    expect(narrateStep(step({ tool: 'sandbox_list_dir', args: { path: '/tmp' } }))?.label).toBe('查看目录');
  });

  it('artifact_render 带文档标题', () => {
    const n = narrateStep(step({ tool: 'artifact_render', args: { title: '调研报告' } }));
    expect(n?.kind).toBe('artifact');
    expect(n?.label).toBe('生成交付文档');
    expect(n?.detail).toBe('调研报告');
  });

  it('平台专用工具走专区叙述', () => {
    expect(narrateStep(step({ tool: 'xhs_save_note_draft' }))?.label).toBe('保存小红书笔记草稿');
    expect(narrateStep(step({ tool: 'wechat_mp_create_draft' }))?.label).toBe('写入公众号草稿箱');
  });

  it('mcp_ 前缀归连接器,兜底归执行任务', () => {
    expect(narrateStep(step({ tool: 'mcp_notion__search' }))?.kind).toBe('connector');
    expect(narrateStep(step({ tool: 'some_unknown_tool' }))?.kind).toBe('generic');
    expect(narrateStep(step({ tool: 'some_unknown_tool' }))?.label).toBe('执行任务');
  });
});

describe('narrateStep assistant 阶段', () => {
  it('RUNNING 无输出 → 思考', () => {
    const n = narrateStep(step({ role: 'assistant', status: 'RUNNING', answer: '', reasoning: '' }));
    expect(n?.kind).toBe('think');
    expect(n?.label).toBe('思考');
  });

  it('RUNNING 有 reasoning → 深度思考(不叠「正在」时也语义完整)', () => {
    const n = narrateStep(step({ role: 'assistant', status: 'RUNNING', reasoning: '推理中', answer: '' }));
    expect(n?.label).toBe('深度思考');
  });

  it('RUNNING 有 answer → 撰写回复', () => {
    const n = narrateStep(step({ role: 'assistant', status: 'RUNNING', answer: '部分文本' }));
    expect(n?.kind).toBe('reply');
    expect(n?.label).toBe('撰写回复');
  });

  it('wrap-up 轮 live step(标题含「总结」)→ 整理最终结论', () => {
    const n = narrateStep(step({ role: 'assistant', status: 'RUNNING', title: '正在做最终总结…', answer: '' }));
    expect(n?.label).toBe('整理最终结论');
  });

  it('messageKind final → 交付最终答复', () => {
    const n = narrateStep(step({ role: 'assistant', messageKind: 'final', status: 'DONE', answer: '结论' }));
    expect(n?.kind).toBe('reply');
    expect(n?.label).toBe('交付最终答复');
  });

  it('完成的无正文推理轮 → 完成一轮推理', () => {
    const n = narrateStep(step({ role: 'assistant', status: 'DONE', answer: '' }));
    expect(n?.label).toBe('完成一轮推理');
  });
});

describe('narrateStep 用户步骤与 formatActivityDuration', () => {
  it('用户步骤作为轮次分隔保留', () => {
    const n = narrateStep(step({ role: 'user', userPrompt: '调研一下 AI Agent' }));
    expect(n?.kind).toBe('user');
    expect(n?.label).toBe('提出请求');
    expect(n?.detail).toBe('调研一下 AI Agent');
  });

  it('duration 毫秒字符串 → 人类可读', () => {
    expect(formatActivityDuration('3200ms')).toBe('3.2s');
    expect(formatActivityDuration('800ms')).toBe('0.8s');
    expect(formatActivityDuration('65000ms')).toBe('1m05s');
    expect(formatActivityDuration(undefined)).toBeUndefined();
    expect(formatActivityDuration('abc')).toBeUndefined();
  });
});
