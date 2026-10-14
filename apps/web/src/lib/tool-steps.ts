import type { Mission, MissionStep } from '../types/agent';

/**
 * 工具步骤与事件的 callId 关联(纯函数,便于单测)。
 *
 * 生产实例(2026-10-14 mission_1791968561786,上海到北京出行报告):SDK 对同轮
 * 全部工具调用 Promise.all 并行,事件流里插件层与编排器层双重广播 tool_call
 * (入参形状还不同:编排器带 args 字段,插件层平铺在 payload 顶层),而步骤归属
 * 只按「工具名 + 末位位置」倒查 —— 结果是同一物理调用产生成对重复步骤、真实
 * 结果落在重复步骤上、原步骤挂着「执行中」直到 100 秒后被路过的无关
 * tool_result 误关(output 为空、时长虚高百倍、入参与出参交叉)。
 *
 * 修法:编排器给每个物理调用发 callId(广播与 ToolSession 双通道),步骤记录
 * 按 callId 一一对应、幂等合并;无 callId 的事件(旧事件源/smoke 流)走原有
 * 末位倒查兜底,行为不变。
 */

export interface ToolCallEventInput {
  tool: string;
  /** 编排器层广播的规整入参;插件层平铺事件没有该字段 */
  args?: any;
  /** 物理调用 id;编排器逐调用生成,插件层经 ToolSession 透传 */
  callId?: string;
  /** 无 callId 兜底时的整体 payload(与旧实现一致:args 缺失时整包当入参) */
  payload?: Record<string, any>;
}

/** tool_call 事件 → 步骤落地:callId 命中则幂等合并(双广播),否则新建 RUNNING 步骤 */
export function upsertToolStep(mission: Mission, ev: ToolCallEventInput): void {
  // ---- callId 路径:同一物理调用的插件/编排器双广播在此合并,不再成对重复 ----
  if (ev.callId) {
    const existing = mission.steps.find((s) => s.callId === ev.callId);
    if (existing) {
      // 二次广播只刷新入参,且仅当事件真的带 args 字段 —— 插件层平铺事件的
      // payload 顶层混着 tool 等元数据,整包覆写会污染步骤入参
      if (ev.args !== undefined) existing.args = ev.args;
      return;
    }
    mission.steps.push({
      id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: `执行工具: ${ev.tool}`,
      tool: ev.tool,
      role: 'tool',
      status: 'RUNNING',
      args: ev.args,
      callId: ev.callId,
      startedAt: Date.now(),
    });
    return;
  }

  // ---- 无 callId 兜底(旧事件源):末位同名 RUNNING 去重,行为与旧实现一致 ----
  const lastStep = mission.steps[mission.steps.length - 1];
  if (lastStep && lastStep.tool === ev.tool && lastStep.status === 'RUNNING') {
    lastStep.args = ev.args || ev.payload;
  } else {
    mission.steps.push({
      id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: `执行工具: ${ev.tool}`,
      tool: ev.tool,
      role: 'tool',
      status: 'RUNNING',
      args: ev.args || ev.payload,
      startedAt: Date.now(),
    });
  }
}

export interface ToolResultEventInput {
  tool?: string;
  output?: any;
  compensation?: MissionStep['compensation'];
  callId?: string;
}

/** tool_result 事件 → 步骤收尾;返回是否真的改了步骤(调用方据此决定是否广播) */
export function settleToolStep(mission: Mission, ev: ToolResultEventInput): boolean {
  // ---- callId 路径:精确收尾,无关事件不再误关并行中的同名工具步骤 ----
  if (ev.callId) {
    const target = mission.steps.find((s) => s.callId === ev.callId);
    if (!target) return false;
    if (target.status === 'RUNNING') {
      target.status = 'DONE';
      target.output = ev.output;
      if (ev.compensation) target.compensation = ev.compensation;
      target.duration = `${Math.max(0, Date.now() - (target.startedAt || Date.now()))}ms`;
      return true;
    }
    // 已收尾(浏览器插件层 tool_result 先到,不带 output):内核带权威
    // output 的事件后到时补洞,不让步骤落空 output
    if (ev.output !== undefined && target.output === undefined) {
      target.output = ev.output;
      return true;
    }
    return false;
  }

  // ---- 无 callId 兜底:从后往前找最后一个 RUNNING 的同名工具步骤(旧实现) ----
  const targetStep =
    [...mission.steps].reverse().find((s) => s.status === 'RUNNING' && (!ev.tool || s.tool === ev.tool)) ||
    mission.steps[mission.steps.length - 1];
  if (targetStep && targetStep.status === 'RUNNING') {
    targetStep.status = 'DONE';
    targetStep.output = ev.output;
    if (ev.compensation) targetStep.compensation = ev.compensation;
    targetStep.duration = `${Math.max(0, Date.now() - (targetStep.startedAt || Date.now()))}ms`;
    return true;
  }
  return false;
}
