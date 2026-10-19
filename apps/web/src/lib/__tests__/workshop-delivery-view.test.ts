/**
 * 逐字段交付视图收集测试(计划「novel 工坊逐字段交付」Phase 4)
 *
 * 锁 collectWorkshopDeliveries 的三态与累积语义:RUNNING→delivering、DONE+ok→delivered、
 * DONE+非ok/FAILED→rejected、无步→pending 骨架;跨轮后值替换;requiredDone/complete 门;
 * 无契约或无任何交付步 → null(文本路径不钉渐进卡)。
 */
import { describe, it, expect } from 'vitest';
import { collectWorkshopDeliveries } from '../workshop-delivery-view';
import { DELIVER_FIELD_TOOL } from '../workshop-delivery';
import type { DeliveryContract } from '@/workshops/types';
import type { MissionStep } from '@/types/agent';

const CONTRACT: DeliveryContract = {
  id: 'test_contract',
  fields: [
    { key: '甲', label: '字段甲', required: true },
    { key: '乙', label: '字段乙', required: true },
    { key: '丙', label: '字段丙', required: false },
  ],
};

const step = (over: Partial<MissionStep>): MissionStep =>
  ({ id: 's', title: 't', tool: DELIVER_FIELD_TOOL, status: 'DONE', ...over }) as MissionStep;

describe('collectWorkshopDeliveries', () => {
  it('无契约 → null', () => {
    expect(collectWorkshopDeliveries([], undefined)).toBeNull();
    expect(collectWorkshopDeliveries([], null)).toBeNull();
  });

  it('有契约但无任何交付步 → null(文本路径不钉卡)', () => {
    expect(collectWorkshopDeliveries([{ id: 'x', title: 't', status: 'DONE' } as MissionStep], CONTRACT)).toBeNull();
    expect(collectWorkshopDeliveries([], CONTRACT)).toBeNull();
  });

  it('三态:delivered / delivering / rejected / pending 骨架', () => {
    const steps: MissionStep[] = [
      step({ args: { field: '甲', content: 'A' }, output: { ok: true } }), // delivered
      step({ args: { field: '乙', content: 'B' }, status: 'RUNNING', output: undefined }), // delivering
      // 丙 无步 → pending
    ];
    const v = collectWorkshopDeliveries(steps, CONTRACT)!;
    expect(v).not.toBeNull();
    const by = Object.fromEntries(v.fields.map((f) => [f.key, f.state]));
    expect(by).toEqual({ 甲: 'delivered', 乙: 'delivering', 丙: 'pending' });
    expect(v.deliveredCount).toBe(1);
    expect(v.totalCount).toBe(3);
    expect(v.requiredDone).toBe(false); // 乙 未 delivered
    expect(v.complete).toBe(false);
  });

  it('rejected:ok=false 或 FAILED 不点亮', () => {
    const v1 = collectWorkshopDeliveries(
      [step({ args: { field: '甲', content: 'A' }, output: { ok: false, errors: ['x'] } })],
      CONTRACT
    )!;
    expect(v1.fields.find((f) => f.key === '甲')!.state).toBe('rejected');
    const v2 = collectWorkshopDeliveries(
      [step({ args: { field: '甲', content: 'A' }, status: 'FAILED', output: { ok: true } })],
      CONTRACT
    )!;
    expect(v2.fields.find((f) => f.key === '甲')!.state).toBe('rejected');
  });

  it('跨轮后值替换:先 rejected 后 delivered → delivered', () => {
    const steps: MissionStep[] = [
      step({ args: { field: '甲', content: 'A1' }, output: { ok: false } }),
      step({ args: { field: '甲', content: 'A2' }, output: { ok: true } }),
    ];
    const v = collectWorkshopDeliveries(steps, CONTRACT)!;
    const f = v.fields.find((x) => x.key === '甲')!;
    expect(f.state).toBe('delivered');
    expect(f.content).toBe('A2');
  });

  it('requiredDone:全部 required delivered 即真(可选字段不阻塞)', () => {
    const steps: MissionStep[] = [
      step({ args: { field: '甲', content: 'A' }, output: { ok: true } }),
      step({ args: { field: '乙', content: 'B' }, output: { ok: true } }),
    ];
    const v = collectWorkshopDeliveries(steps, CONTRACT)!;
    expect(v.requiredDone).toBe(true); // 丙(可选)仍 pending
    expect(v.complete).toBe(false);
    expect(v.deliveredCount).toBe(2);
  });

  it('complete:全部字段 delivered', () => {
    const steps: MissionStep[] = [
      step({ args: { field: '甲', content: 'A' }, output: { ok: true } }),
      step({ args: { field: '乙', content: 'B' }, output: { ok: true } }),
      step({ args: { field: '丙', content: 'C' }, output: { ok: true } }),
    ];
    const v = collectWorkshopDeliveries(steps, CONTRACT)!;
    expect(v.complete).toBe(true);
    expect(v.requiredDone).toBe(true);
    expect(v.deliveredCount).toBe(3);
  });

  it('非交付工具步被忽略', () => {
    const steps: MissionStep[] = [
      { id: 'x', title: 't', tool: 'other', status: 'DONE', args: { field: '甲' }, output: { ok: true } } as MissionStep,
      step({ args: { field: '甲', content: 'A' }, output: { ok: true } }),
    ];
    const v = collectWorkshopDeliveries(steps, CONTRACT)!;
    expect(v.deliveredCount).toBe(1);
  });
});
