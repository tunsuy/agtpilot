import { describe, it, expect } from 'vitest';
import { buildDocReadTools } from '../doc-read';

describe('doc_read 统一只读文档工具', () => {
  it('未放行 skill_pack 时 schema 只暴露 reference 与 tool_output', async () => {
    const [tool] = buildDocReadTools('u1', { allowSkillPack: false });
    const enumVals = (tool.parameters as any).properties.source.enum;
    expect(enumVals).toEqual(['reference', 'tool_output']);
  });

  it('allowSkillPack=true 时 schema 增列 skill_pack 源', async () => {
    const [tool] = buildDocReadTools('u1', { allowSkillPack: true });
    const enumVals = (tool.parameters as any).properties.source.enum;
    expect(enumVals).toContain('skill_pack');
  });

  it('未放行 skill_pack 时执行返回诚实错误(不静默)', async () => {
    const [tool] = buildDocReadTools('u1', { allowSkillPack: false });
    const r: any = await tool.execute({ source: 'skill_pack', pack: 'demo' } as any, {} as any);
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('没有显式引用技能包');
  });

  it('未知 source → 报错并列出可选值', async () => {
    const [tool] = buildDocReadTools('u1');
    const r: any = await tool.execute({ source: 'nope' } as any, {} as any);
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('reference');
    expect(String(r.error)).toContain('tool_output');
  });

  it('source=tool_output / reference 缺参 → 各自需要 callId / materialId 的明确报错', async () => {
    const [tool] = buildDocReadTools('u1');
    const r1: any = await tool.execute({ source: 'tool_output' } as any, {} as any);
    expect(r1.success).toBe(false);
    const r2: any = await tool.execute({ source: 'reference' } as any, {} as any);
    expect(r2.success).toBe(false);
    expect(String(r2.error)).toContain('materialId');
  });
});
