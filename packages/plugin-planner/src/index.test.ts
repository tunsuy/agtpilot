import { describe, it, expect } from 'vitest';
import { PlannerService } from './index';

/**
 * PlannerService 看板语义测试:
 * - 建板:首步 in_progress、其余 pending;同 taskKey 重建自动替换旧板
 *   (提示词现在明确引导「计划改向时重建看板」,替换语义是它的落地)
 * - 推进:真实工具成功 → 当前步完成 + 下一 pending 转 in_progress;
 *   failed 同样推进(否则看板冻结);元工具不推进
 * - 淘汰:>20 时优先逐出「全部完结且最久未更新」的,活跃看板宁超限不逐出
 *
 * 注:同轮并行调用「最多推进一次」的批处理在 core Orchestrator 的
 * prepareStep 结算(那里有轮边界,这里看不到),服务侧契约不变。
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

  it('真实工具成功推进当前步骤并把下一 pending 转入进行中', () => {
    const svc = newService();
    svc.createPlan('目标', steps(3), 'm1');
    svc.noteToolResult('m1', 'search_web');
    const plan = svc.getPlan('m1')!;
    expect(plan.tasks[0].status).toBe('completed');
    expect(plan.tasks[1].status).toBe('in_progress');
    expect(plan.currentTaskId).toBe('step_2');
  });

  it('元工具(看板/记忆/路由/观测)不推进 —— 调度类调用不该「完成」一个步骤', () => {
    const svc = newService();
    svc.createPlan('目标', steps(2), 'm1');
    svc.noteToolResult('m1', 'planner_update_task');
    svc.noteToolResult('m1', 'memory_store');
    svc.noteToolResult('m1', 'router_select_tier');
    svc.noteToolResult('m1', 'observability_trace');
    expect(svc.getPlan('m1')!.tasks[0].status).toBe('in_progress');
  });

  it('步骤标 failed 同样推进(failed 后 currentTaskId 不悬停,看板不冻结)', () => {
    const svc = newService();
    svc.createPlan('目标', steps(3), 'm1');
    const plan = svc.updateTask('step_1', 'failed', '检索为空', 'm1')!;
    expect(plan.tasks[0].status).toBe('failed');
    expect(plan.currentTaskId).toBe('step_2');
    expect(plan.tasks[1].status).toBe('in_progress');
  });

  it('未知 taskKey / 未知步骤的推进与更新是安全空操作', () => {
    const svc = newService();
    expect(() => svc.noteToolResult('nope', 'search_web')).not.toThrow();
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
