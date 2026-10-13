import { describe, it, expect } from 'vitest';
import { collectSearchSources, sourcesForAnswer } from '../search-sources';
import type { MissionStep } from '../../types/agent';

const step = (partial: Partial<MissionStep>): MissionStep => ({
  id: `step_${Math.random().toString(36).slice(2)}`,
  title: 'x',
  status: 'DONE',
  ...partial,
});

const searchStep = (over: {
  id?: string;
  output?: unknown;
  tool?: string;
  status?: MissionStep['status'];
}): MissionStep =>
  step({
    role: 'tool',
    tool: 'search_web',
    status: 'DONE',
    ...over,
  } as Partial<MissionStep>);

const results = (items: Array<{ title: string; url: string }>) => ({
  success: true,
  query: 'AI Agent',
  count: items.length,
  engine: 'exa',
  results: items.map((r) => ({ ...r, snippet: '片段', engine: 'exa' })),
});

describe('collectSearchSources · 结构化输出解析', () => {
  it('对象形态输出:取 results 的 url/title,域名去 www.,补 engine', () => {
    const src = collectSearchSources([
      searchStep({
        output: results([
          { title: '多模态智能体综述', url: 'https://www.example.com/paper/1' },
        ]),
      }),
    ]);
    expect(src).toHaveLength(1);
    expect(src[0]).toMatchObject({
      url: 'https://www.example.com/paper/1',
      title: '多模态智能体综述',
      host: 'example.com',
      engine: 'exa',
    });
  });

  it('JSON 字符串落盘形态同样可解析(容错)', () => {
    const src = collectSearchSources([
      searchStep({ output: JSON.stringify(results([{ title: 'B 站教程', url: 'https://bilibili.com/video/1' }])) }),
    ]);
    expect(src).toHaveLength(1);
    expect(src[0].host).toBe('bilibili.com');
  });

  it('非搜索工具与 mcp_ 连接器不计入(与 narrateTool 同口径)', () => {
    const steps = [
      searchStep({ tool: 'mcp_notion__search', output: results([{ title: '内部文档', url: 'https://notion.so/x' }]) }),
      searchStep({ tool: 'browser_navigate', output: results([{ title: '页面', url: 'https://example.com/x' }]) }),
    ];
    expect(collectSearchSources(steps)).toHaveLength(0);
  });

  it('FAILED 检索步骤与缺 title/url 的条目、非法 URL 跳过', () => {
    const steps = [
      searchStep({ status: 'FAILED', output: results([{ title: '失败结果', url: 'https://example.com/f' }]) }),
      searchStep({
        output: {
          success: true,
          results: [
            { url: 'https://example.com/no-title' }, // 无 title
            { title: '无 URL' }, // 无 url
            { title: '坏 URL', url: 'not-a-url' }, // URL 解析失败
          ],
        },
      }),
    ];
    expect(collectSearchSources(steps)).toHaveLength(0);
  });

  it('URL 去重、按出现序、封顶 limit', () => {
    const dup = { title: '同一篇', url: 'https://example.com/1' };
    const many = Array.from({ length: 12 }, (_, i) => ({
      title: `结果 ${i}`,
      url: `https://example.com/${i}`,
    }));
    const src = collectSearchSources(
      [
        searchStep({ output: results([dup, dup]) }),
        searchStep({ output: results(many) }),
      ],
      8
    );
    expect(src).toHaveLength(8);
    expect(src[0].url).toBe('https://example.com/1'); // 首次出现的去重锚
    expect(src[7].url).toBe('https://example.com/7'); // 封顶截断锚(批次内 /1 重复被去重)
  });
});

describe('sourcesForAnswer · 逐轮归属(多轮不串来源)', () => {
  const user = (id: string): MissionStep => step({ id, role: 'user', userPrompt: '查一下' });
  const final = (id: string): MissionStep =>
    step({ id, role: 'assistant', messageKind: 'final', answer: '答复', title: '最终答复' });
  const search = (id: string, url: string): MissionStep =>
    searchStep({ id, output: results([{ title: '来源', url }]) });

  it('首轮:答复之前的搜索结果全部计入', () => {
    const steps = [user('u1'), search('s1', 'https://a.com/1'), search('s2', 'https://b.com/1'), final('f1')];
    const idx = steps.findIndex((s) => s.id === 'f1');
    expect(sourcesForAnswer(steps, idx).map((x) => x.url)).toEqual([
      'https://a.com/1',
      'https://b.com/1',
    ]);
  });

  it('第二轮追问只引用上一条最终答复之后的搜索结果', () => {
    const steps = [
      user('u1'),
      search('s1', 'https://a.com/1'),
      final('f1'),
      user('u2'),
      search('s2', 'https://b.com/1'),
      final('f2'),
    ];
    const idx = steps.findIndex((s) => s.id === 'f2');
    expect(sourcesForAnswer(steps, idx).map((x) => x.url)).toEqual(['https://b.com/1']);
  });

  it('无更早最终答复时从头起算;纯对话追问不挂旧来源', () => {
    const steps = [user('u1'), search('s1', 'https://a.com/1'), final('f1'), user('u2'), final('f2')];
    const idx = steps.findIndex((s) => s.id === 'f2');
    expect(sourcesForAnswer(steps, idx)).toHaveLength(0);
  });
});
