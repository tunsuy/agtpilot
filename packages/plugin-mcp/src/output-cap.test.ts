import { describe, it, expect, afterEach } from 'vitest';
import {
  capMcpToolResult,
  compactJsonStrings,
  mcpOutputLimit,
  MCP_OUTPUT_LIMIT_DEFAULT,
} from './output-cap';

/**
 * 层1 源头裁剪 ③:MCP 客户端统一输出治理(设计注记见 output-cap.ts 头注)。
 * 不变量:纯函数不改入参;cap=0(env 保险丝)原样透传;一切裁剪带显式标记
 * (不静默截断红线);非文本项换占位;JSON 字段压缩保结构砍长串。
 */

afterEach(() => {
  delete process.env.AGTPILOT_MCP_OUTPUT_LIMIT;
});

const text = (t: string) => ({ type: 'text', text: t });
const result = (...content: any[]) => ({ content });

describe('mcpOutputLimit(env + per-server 规则)', () => {
  it('默认:统一 12000;deepwiki 收紧 8000;github_mcp 用统一值', () => {
    expect(mcpOutputLimit('newsnow')).toBe(MCP_OUTPUT_LIMIT_DEFAULT);
    expect(mcpOutputLimit('deepwiki')).toBe(8_000);
    expect(mcpOutputLimit('github_mcp')).toBe(12_000);
  });

  it('env 覆盖统一上限;0 = 全关(含 per-server)', () => {
    process.env.AGTPILOT_MCP_OUTPUT_LIMIT = '5000';
    expect(mcpOutputLimit('newsnow')).toBe(5000);
    expect(mcpOutputLimit('deepwiki')).toBe(5000); // per-server 也被统一值压顶
    process.env.AGTPILOT_MCP_OUTPUT_LIMIT = '0';
    expect(mcpOutputLimit('newsnow')).toBe(0);
    expect(mcpOutputLimit('deepwiki')).toBe(0);
  });
});

describe('capMcpToolResult', () => {
  it('保险丝关(env=0)→ 原引用透传', () => {
    process.env.AGTPILOT_MCP_OUTPUT_LIMIT = '0';
    const r = result(text('x'.repeat(50_000)));
    expect(capMcpToolResult(r, 'deepwiki')).toBe(r);
  });

  it('形态不认识(非对象/无 content 数组/自带 error)→ 原样返回', () => {
    expect(capMcpToolResult(null, 'deepwiki')).toBe(null);
    const err = { error: 'MCP 连接器 [x] 调用失败', hint: 'h' };
    expect(capMcpToolResult(err, 'deepwiki')).toBe(err);
  });

  it('短输出不动、不加裁剪标记(与改造前逐字段一致)', () => {
    const r = result(text('{"a":1}'), text('ok'));
    const out = capMcpToolResult(r, 'newsnow');
    expect(out.content).toEqual([text('{"a":1}'), text('ok')]);
    expect(out._agtpilotTrim).toBeUndefined();
  });

  it('不改动入参(纯函数)', () => {
    const r = result(text('y'.repeat(20_000)));
    capMcpToolResult(r, 'deepwiki');
    expect(r.content[0].text.length).toBe(20_000);
  });

  it('超 cap → 头保留 + 显式标记(附原始字符数与重查指引)', () => {
    const r = result(text('z'.repeat(20_000)));
    const out = capMcpToolResult(r, 'deepwiki');
    const t = out.content[0].text;
    expect(t.length).toBeLessThan(9_500); // 8000 + 标记
    expect(t.startsWith('zzz')).toBe(true);
    expect(t).toContain('MCP 输出已裁剪');
    expect(t).toContain('20000');
    expect(out._agtpilotTrim).toMatchObject({ server: 'deepwiki', originalChars: 20_000, limit: 8_000 });
  });

  it('多段 content:按序分配预算,骑线段截短,其后各段换省略标记', () => {
    const r = result(text('a'.repeat(6_000)), text('b'.repeat(6_000)), text('c'.repeat(100)));
    const out = capMcpToolResult(r, 'deepwiki'); // cap 8000
    expect(out.content[0].text).toBe('a'.repeat(6_000)); // 预算内原样
    expect(out.content[1].text.startsWith('bbb')).toBe(true);
    expect(out.content[1].text).toContain('MCP 输出已裁剪');
    expect(out.content[2].text).toContain('本段整体省略');
  });

  it('image/audio/二进制 resource → 文本占位(base64 不进上下文)', () => {
    const r = result(
      { type: 'image', data: 'BASE64'.repeat(100), mimeType: 'image/png' },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      { type: 'resource', resource: { uri: 'file://x.png', blob: 'BBBB' } },
      text('保留我'),
    );
    const out = capMcpToolResult(r, 'newsnow');
    expect(out.content[0].text).toContain('图片内容已省略');
    expect(out.content[1].text).toContain('音频内容已省略');
    expect(out.content[2].text).toContain('已省略');
    expect(out.content[3]).toEqual(text('保留我'));
    expect(JSON.stringify(out)).not.toContain('BASE64');
  });

  it('github_mcp:JSON 文本做字段压缩(长串截短、结构与短字段原样)+ structuredContent 同治', () => {
    const payload = {
      total_count: 42,
      items: [
        { title: '短标题', state: 'open', body: 'B'.repeat(5_000), reactions: { '+1': 7 } },
      ],
    };
    const withStructured: any = { content: [text(JSON.stringify(payload))], structuredContent: payload };
    const out = capMcpToolResult(withStructured, 'github_mcp');
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.total_count).toBe(42);
    expect(parsed.items[0].title).toBe('短标题');
    expect(parsed.items[0].state).toBe('open');
    expect(parsed.items[0].reactions).toEqual({ '+1': 7 });
    expect(parsed.items[0].body.length).toBeLessThan(500); // maxStringChars=400 + 标记
    expect(parsed.items[0].body).toContain('字段已截短');
    // structuredContent 双投影同样压缩(编排器 JSON.stringify 整个返回对象)
    expect(out.structuredContent.items[0].body).toContain('字段已截短');
    expect(out._agtpilotTrim).toMatchObject({ server: 'github_mcp' });
  });

  it('非 JSON 文本(Markdown 答案)不做字段压缩,只受总量 cap', () => {
    const md = '# 答案\n\n' + '结论。'.repeat(100); // <8000,不触发 cap
    const out = capMcpToolResult(result(text(md)), 'deepwiki');
    expect(out.content[0].text).toBe(md);
  });

  it('isError 结果同样走治理(错误文本超长也被裁,不豁免)', () => {
    const r: any = { content: [text('E'.repeat(20_000))], isError: true };
    const out = capMcpToolResult(r, 'newsnow');
    expect(out.isError).toBe(true);
    expect(out.content[0].text.length).toBeLessThan(13_000);
    expect(out.content[0].text).toContain('MCP 输出已裁剪');
  });
});

describe('compactJsonStrings(纯函数)', () => {
  it('字符串 ≤ 上限原引用返回;超长截短带标记', () => {
    const s = 'abc';
    expect(compactJsonStrings(s, 10)).toBe(s);
    const long = 'L'.repeat(50);
    const out = compactJsonStrings(long, 10);
    expect(out.startsWith('L'.repeat(10))).toBe(true);
    expect(out).toContain('原始 50 字符');
  });

  it('结构不动:数组/对象层级、数字、布尔、null 原样;无变化时返回原引用', () => {
    const v = { a: [1, true, null, { b: 'x' }] };
    expect(compactJsonStrings(v, 100)).toBe(v);
  });
});
