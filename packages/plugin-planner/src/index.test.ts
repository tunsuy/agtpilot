import { describe, it, expect } from 'vitest';
import { PlannerService } from './index';

/**
 * PlannerService 看板语义测试:
 * - 建板:首步 in_progress、其余 pending;同 taskKey 重建自动替换旧板
 *   (提示词现在明确引导「计划改向时重建看板」,替换语义是它的落地)
 * - 滞后催促(2026-10 契约切换):看板进度由模型显式申报(planner_update_task
 *   同批,业界 Claude Code TodoWrite / Codex update_plan 同款);模型忘了
 *   申报时 boardLagNotice 给出带当前步骤上下文的催促文本。旧的
 *   noteToolResult「工具成功自动推进」已废 —— 推断猜不准语义事件。
 * - 淘汰:>20 时优先逐出「全部完结且最久未更新」的,活跃看板宁超限不逐出
 *
 * 注:滞后计数/清零/注入在 core Orchestrator 的 prepareStep(那里有轮边界),
 * 这里只测催促文本的取舍。
 */

/** cordis Service 构造只依赖 reflect.provide;广播走 ctx.emit + agent.emitEvent */
function mockCtx() {
  const ctxEvents: Array<{ name: string; plan: any }> = [];
  const agentEvents: any[] = [];
  const ctx: any = {
    reflect: { provide: () => {} },
    emit: (name: string, plan: any) => ctxEvents.push({ name, plan }),
    agent: { emitEvent: (e: any) => agentEvents.push(e) },
  };
  return { ctx, ctxEvents, agentEvents };
}

function newService() {
  const { ctx } = mockCtx();
  return new PlannerService(ctx);
}

const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `step_${i + 1}`, title: `步骤${i + 1}` }));

describe('PlannerService 看板语义', () => {
  it('建板:首步 in_progress、其余 pending;广播 plan 事件给 UI', () => {
    const svc = newService();
    const plan = svc.createPlan('调研 AI 最新发展', steps(3), 'm1');
    expect(plan.tasks.map((t) => t.status)).toEqual(['in_progress', 'pending', 'pending']);
    expect(plan.currentTaskId).toBe('step_1');
    expect(svc.getPlan('m1')?.id).toBe(plan.id);
  });

  it('同 taskKey 重建看板自动替换旧板(计划改向不留两套看板)', () => {
    const svc = newService();
    svc.createPlan('原目标', steps(2), 'm1');
    const rebuilt = svc.createPlan('新目标', steps(3), 'm1');
    // 旧板被替换:同 taskKey 只剩新板
    expect(svc.getPlan('m1')?.id).toBe(rebuilt.id);
    expect(rebuilt.goal).toBe('新目标');
  });

  it('滞后催促:有进行中步骤时给出带步骤上下文、指向同批申报的提醒文本', () => {
    const svc = newService();
    svc.createPlan('目标', steps(3), 'm1');
    const notice = svc.boardLagNotice('m1', 2);
    expect(notice).not.toBeNull();
    expect(notice).toContain('2 轮');
    expect(notice).toContain('步骤1'); // 当前进行中步骤的标题进上下文
    expect(notice).toContain('同一批');
    expect(notice).toContain('planner_update_task');
  });

  it('无看板 / 无进行中步骤(全完结)→ null,没有可催促的进度', () => {
    const svc = newService();
    expect(svc.boardLagNotice('nope', 2)).toBeNull();
    svc.createPlan('目标', steps(1), 'm1');
    svc.updateTask('step_1', 'completed', undefined, 'm1');
    expect(svc.boardLagNotice('m1', 2)).toBeNull();
  });

  it('步骤标 failed 同样推进(failed 后 currentTaskId 不悬停,看板不冻结)', () => {
    const svc = newService();
    svc.createPlan('目标', steps(3), 'm1');
    const plan = svc.updateTask('step_1', 'failed', '检索为空', 'm1')!;
    expect(plan.tasks[0].status).toBe('failed');
    expect(plan.currentTaskId).toBe('step_2');
    expect(plan.tasks[1].status).toBe('in_progress');
  });

  it('未知 taskKey / 未知步骤的催促与更新是安全空操作', () => {
    const svc = newService();
    expect(svc.boardLagNotice('nope', 2)).toBeNull();
    svc.createPlan('目标', steps(2), 'm1');
    expect(svc.updateTask('step_9', 'completed', undefined, 'm1')).toBeNull();
  });

  it('容量淘汰:>20 时逐出「全部完结且最久未更新」的,活跃看板宁超限不逐出', () => {
    const svc = newService();
    // 21 个全部完结的旧看板(建板后把唯一步骤标完成,不同 updatedAt)
    for (let i = 0; i < 21; i++) {
      const plan = svc.createPlan(`完结${i}`, steps(1), `done_${i}`);
      svc.updateTask('step_1', 'completed', undefined, `done_${i}`);
      plan.updatedAt = 1000 + i; // 手动错开更新时间
    }
    // 一个活跃看板(有 in_progress 步骤)
    const active = svc.createPlan('活跃', steps(2), 'active_m');
    // 再压一个完结板触发淘汰
    svc.createPlan('完结22', steps(1), 'done_22');

    const all = (svc as any).plans as any[];
    expect(all.some((p) => p.taskKey === active.taskKey)).toBe(true); // 活跃板幸存
    expect(all.some((p) => p.taskKey === 'done_0')).toBe(false); // 最旧的完结板被逐出
    // 最旧的活跃板之后逐出的是次旧完结板,不是活跃板
    expect(all.filter((p) => p.taskKey?.startsWith('done_')).length).toBeLessThanOrEqual(21);
  });
});
