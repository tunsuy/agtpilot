/**
 * 逐字段交付工具测试(计划「novel 工坊逐字段交付」Phase 3)
 *
 * 锁 buildDeliverFieldTool.execute 的交付语义:enum 外打回、校验失败即时反馈、
 * 服务端权威校验(authoritativeCheck)、重交=替换、remaining/hint、缺任务上下文打回;
 * 以及注册表 seed/get/clear 与 deliveredFieldsFromSteps 的跨轮口径(只收 ok、后值替换)。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildDeliverFieldTool,
  seedDeliveries,
  clearDeliveries,
  getDeliveries,
  deliveredFieldsFromSteps,
  DELIVER_FIELD_TOOL,
} from '../workshop-delivery';
import type { DeliveryContract } from '@/workshops/types';
import type { MissionStep } from '@/types/agent';

// 最小契约(非 novel 专属,验证工具的通用性)
const CONTRACT: DeliveryContract = {
  id: 'test_contract',
  fields: [
    { key: '甲', label: '字段甲', required: true, validate: (c) => (c.trim().length >= 2 ? [] : ['甲太短']) },
    { key: '乙', label: '字段乙', required: true, validate: (c) => (c.trim() ? [] : ['乙不能为空']) },
    { key: '丙', label: '字段丙', required: false, validate: (c) => (c.trim() ? [] : ['丙不能为空']) },
  ],
};

const session = (taskId?: string) => ({ taskId: taskId || 'm1', step: 1 }) as any;

describe('buildDeliverFieldTool', () => {
  beforeEach(() => {
    clearDeliveries('m1');
    clearDeliveries('m2');
  });

  it('工具契约:baseline 穿透白名单、dangerLevel low、刻意不设 readOnly(保重交=替换)', () => {
    const tool = buildDeliverFieldTool(CONTRACT);
    expect(tool.name).toBe(DELIVER_FIELD_TOOL);
    expect(tool.baseline).toBe(true);
    expect(tool.dangerLevel).toBe('low');
    expect(tool.readOnly).toBeUndefined();
    expect(tool.parameters.properties.field.enum).toEqual(['甲', '乙', '丙']);
  });

  it('缺任务上下文打回', async () => {
    const tool = buildDeliverFieldTool(CONTRACT);
    const r = await tool.execute({ field: '甲', content: '合格内容' }, { step: 1 } as any);
    expect(r.ok).toBe(false);
  });

  it('enum 外字段打回(未知字段)', async () => {
    const tool = buildDeliverFieldTool(CONTRACT);
    const r = await tool.execute({ field: '不存在', content: 'x' }, session());
    expect(r.ok).toBe(false);
    expect(String(r.errors[0])).toContain('未知字段');
  });

  it('校验失败即时反馈(ok=false + errors + 重试 hint),不写注册表', async () => {
    const tool = buildDeliverFieldTool(CONTRACT);
    const r = await tool.execute({ field: '甲', content: '短' }, session());
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['甲太短']);
    expect(getDeliveries('m1')?.fields['甲']).toBeUndefined();
  });

  it('校验通过 → ok=true,注册表累积,remaining/hint 反映进度', async () => {
    const tool = buildDeliverFieldTool(CONTRACT);
    const r1 = await tool.execute({ field: '甲', content: '合格' }, session());
    expect(r1.ok).toBe(true);
    expect(r1.delivered).toEqual(['甲']);
    expect(r1.remaining).toEqual(['乙', '丙']);
    expect(String(r1.hint)).toContain('继续交付');
    expect(getDeliveries('m1')?.fields['甲']).toBe('合格');
  });

  it('全部字段交付完 → hint 转收尾(不要重复字段内容)', async () => {
    const tool = buildDeliverFieldTool(CONTRACT);
    await tool.execute({ field: '甲', content: '合格' }, session());
    await tool.execute({ field: '乙', content: '合格' }, session());
    const r = await tool.execute({ field: '丙', content: '合格' }, session());
    expect(r.ok).toBe(true);
    expect(r.remaining).toEqual([]);
    expect(String(r.hint)).toContain('收尾');
  });

  it('重交 = 替换同 key(不新增,内容以最新为准)', async () => {
    const tool = buildDeliverFieldTool(CONTRACT);
    await tool.execute({ field: '甲', content: '第一版' }, session());
    const r = await tool.execute({ field: '甲', content: '第二版' }, session());
    expect(r.ok).toBe(true);
    expect(r.delivered.filter((k: string) => k === '甲').length).toBe(1);
    expect(getDeliveries('m1')?.fields['甲']).toBe('第二版');
  });

  it('authoritativeCheck 打回(服务端权威校验失败)→ ok=false,不写注册表', async () => {
    const tool = buildDeliverFieldTool(CONTRACT, {
      authoritativeCheck: async (field) => (field === '乙' ? ['书号不存在或无权访问'] : []),
    });
    const r = await tool.execute({ field: '乙', content: '合格' }, session());
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['书号不存在或无权访问']);
    expect(getDeliveries('m1')?.fields['乙']).toBeUndefined();
  });

  it('authoritativeCheck 通过 → 正常入库', async () => {
    const tool = buildDeliverFieldTool(CONTRACT, { authoritativeCheck: async () => [] });
    const r = await tool.execute({ field: '乙', content: '合格' }, session());
    expect(r.ok).toBe(true);
  });

  it('authoritativeCheck 自身抛错 → 打回但不泄漏内部细节给模型', async () => {
    const tool = buildDeliverFieldTool(CONTRACT, {
      authoritativeCheck: async () => {
        throw new Error('数据库连接密钥 sk-secret 泄漏');
      },
    });
    const r = await tool.execute({ field: '乙', content: '合格' }, session());
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.errors)).not.toContain('sk-secret');
  });

  it('多任务注册表按 missionId 分域互不串', async () => {
    const tool = buildDeliverFieldTool(CONTRACT);
    await tool.execute({ field: '甲', content: 'm1的甲' }, session('m1'));
    await tool.execute({ field: '甲', content: 'm2的甲' }, session('m2'));
    expect(getDeliveries('m1')?.fields['甲']).toBe('m1的甲');
    expect(getDeliveries('m2')?.fields['甲']).toBe('m2的甲');
  });
});

describe('seedDeliveries / clearDeliveries', () => {
  it('seed 预灌注册表(续聊/重启从 steps 复原),clear 清场', () => {
    seedDeliveries('m9', 'test_contract', { 甲: '预灌值' });
    expect(getDeliveries('m9')?.fields['甲']).toBe('预灌值');
    clearDeliveries('m9');
    expect(getDeliveries('m9')).toBeUndefined();
  });
});

describe('deliveredFieldsFromSteps', () => {
  const step = (over: Partial<MissionStep>): MissionStep =>
    ({ id: 's', title: 't', tool: DELIVER_FIELD_TOOL, status: 'DONE', ...over }) as MissionStep;

  it('只收 DONE+output.ok 的字段;RUNNING/rejected/FAILED 不计入', () => {
    const steps: MissionStep[] = [
      step({ args: { field: '甲', content: 'ok甲' }, output: { ok: true } }),
      step({ args: { field: '乙', content: '打回乙' }, output: { ok: false, errors: ['x'] } }),
      step({ args: { field: '丙', content: '交付中' }, status: 'RUNNING', output: undefined }),
      step({ args: { field: '丁', content: '失败' }, status: 'FAILED', output: { ok: true } }),
    ];
    const out = deliveredFieldsFromSteps(steps);
    expect(out).toEqual({ 甲: 'ok甲' });
  });

  it('跨轮后值替换前值(重交=替换口径)', () => {
    const steps: MissionStep[] = [
      step({ args: { field: '甲', content: '旧' }, output: { ok: true } }),
      step({ args: { field: '甲', content: '新' }, output: { ok: true } }),
    ];
    expect(deliveredFieldsFromSteps(steps)).toEqual({ 甲: '新' });
  });

  it('非交付工具步/无 steps → 空', () => {
    expect(deliveredFieldsFromSteps(undefined)).toEqual({});
    expect(
      deliveredFieldsFromSteps([{ id: 's', title: 't', tool: 'other_tool', status: 'DONE', args: { field: '甲' }, output: { ok: true } } as MissionStep])
    ).toEqual({});
  });
});
