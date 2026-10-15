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

  it('planner_create_plan 带 goal 细节(看板创建行不再孤零零)', () => {
    const n = narrateStep(step({ tool: 'planner_create_plan', args: { goal: '产出 3 条核验过的贡献机会' } }));
    expect(n?.kind).toBe('planner');
    expect(n?.label).toBe('创建任务看板');
    expect(n?.detail).toBe('产出 3 条核验过的贡献机会');
  });

  it('planner_update_task 不叙述(看板记账是内部簿记,状态由计划卡呈现,活动流不刷「推进任务看板」)', () => {
    expect(narrateStep(step({ tool: 'planner_update_task', args: { taskId: 't1', status: 'completed' } }))).toBeNull();
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

  it('完成且有 reasoning → 完成深度思考(数据判定,不依赖标题字符串)', () => {
    const n = narrateStep(
      step({ role: 'assistant', status: 'DONE', answer: '', reasoning: '先分析问题再决定检索' })
    );
    expect(n?.kind).toBe('think');
    expect(n?.label).toBe('完成深度思考');
    expect(n?.detail).toBe('先分析问题再决定检索');
  });

  it('完成且 reasoning+answer 并存 → 仍按思考段叙述(思考是步骤主属性)', () => {
    const n = narrateStep(
      step({ role: 'assistant', status: 'DONE', answer: '中间结论', reasoning: '推导过程' })
    );
    expect(n?.label).toBe('完成深度思考');
    expect(n?.detail).toBe('推导过程');
  });

  it('完成仅 answer 无 reasoning → 完成阶段分析(旧路径不受影响)', () => {
    const n = narrateStep(step({ role: 'assistant', status: 'DONE', answer: '中间结论' }));
    expect(n?.label).toBe('完成阶段分析');
    expect(n?.detail).toBe('中间结论');
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

describe('narrateStep 失败步骤显式可见(时间线不再误述为完成推理)', () => {
  // 修复背景:无内容的 FAILED assistant 步骤此前落进「完成一轮推理」兜底,
  // 中断/异常在动态流里被叙述成正常完成 —— 失败必须在时间线显式可见
  it('FAILED assistant(无 tool)→ 回复中断,带标题细节', () => {
    const n = narrateStep(step({ role: 'assistant', messageKind: 'progress', status: 'FAILED', title: '模型连接超时' }));
    expect(n?.label).toBe('回复中断');
    expect(n?.detail).toBe('模型连接超时');
  });

  it('FAILED 非 assistant 角色步骤 → 执行失败', () => {
    const n = narrateStep(step({ role: 'tool', status: 'FAILED', title: '沙盒启动失败' }));
    expect(n?.label).toBe('执行失败');
    expect(n?.detail).toBe('沙盒启动失败');
  });

  it('final 形态的 FAILED 仍优先叙述为交付(失败标记由会话流卡承担)', () => {
    const n = narrateStep(step({ role: 'assistant', messageKind: 'final', status: 'FAILED', answer: '部分答复' }));
    expect(n?.label).toBe('交付最终答复');
  });
});

describe('narrateStep 停止收尾口径(终止不误述为失败,未启动不刷屏)', () => {
  // 生产实测:用户点停止后,abort 标记行 + 被清扫的看板步骤全部叙述成
  // 红色「执行失败」—— 终止是用户自己的动作,计划步骤从未跑过
  it('step_abort_ 标记行 → 已手动终止(不红显失败)', () => {
    const n = narrateStep(step({ id: 'step_abort_1791880287701', title: '任务已被用户主动终止 (Aborted)', status: 'FAILED', duration: '0ms' }));
    expect(n?.label).toBe('已手动终止');
    expect(n?.detail).toBeUndefined();
  });

  it('标题含「主动终止」的会话重置行同样按终止叙述', () => {
    const n = narrateStep(step({ title: '会话已重置，任务已终止 (Session Reset)', status: 'FAILED' }));
    expect(n?.label).toBe('已手动终止');
  });

  it('无 startedAt 的看板步骤 FAILED → 未启动(终止清扫,从未执行)', () => {
    const n = narrateStep(step({ id: 'step_1', title: '只读拉取 GitHub 实时数据', status: 'FAILED' }));
    expect(n?.label).toBe('未启动');
    expect(n?.detail).toBe('只读拉取 GitHub 实时数据');
  });

  it('有 startedAt 的失败步骤仍按执行中断叙述(跑过才叫失败)', () => {
    const n = narrateStep(step({ role: 'tool', status: 'FAILED', title: '沙盒启动失败', startedAt: 1791880000000 }));
    expect(n?.label).toBe('执行失败');
    const a = narrateStep(step({ role: 'assistant', messageKind: 'progress', status: 'FAILED', title: '模型连接超时', startedAt: 1791880000000 }));
    expect(a?.label).toBe('回复中断');
  });
});
