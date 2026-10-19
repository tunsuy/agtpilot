/**
 * 逐字段交付工具(工坊层通用能力,首个接入 = novel 设定包/大纲包)
 *
 * 背景:开书设定包/大纲包曾是"单轮巨型文本契约"——一次生成扛书名/卖点/设定集/
 * 人物卡全部强耦合决策,推理模型单步思考 47k 字符、正文 0 字(生产 mission n6185)。
 * AI SDK agent loop 一步纯文本即终结循环,单轮巨契约 = 一次生成扛全部决策,思考无法
 * 分段、进度不可见、无法中途纠偏。改为每字段一步小生成 + workshop_deliver_field
 * 工具交付:思考被切段有界、前端按工具步 args 跨步累积逐字段点亮、校验失败即时反馈重试。
 *
 * 对齐 Claude Code 范式:进度单元小(工具调用为界)、拆分由模型对着清单自主做、
 * 每单元完成即广播。机制是工坊层通用的(契约 spec 声明字段清单),novel 首个接入,
 * 后续 PPT 逐页等同构复用。
 *
 * 挂载范本 = ask-user-bridge(build*Tool(deps) + 模块级注册表):
 * - baseline:true 穿透工坊白名单(routing.ts resolveExplicitTools);
 * - dangerLevel low;
 * - **不设 readOnly**:orchestrator 对 readOnly 工具有 5 分钟同签名结果缓存,
 *   会旁路"重交=替换"语义(同字段同 content 第二次调必须重新校验并替换注册表);
 * - 校验器是纯函数(随 spec 进客户端 bundle,无 fs/网络);书号的服务端权威归属
 *   校验(getNovelBook)由 deps.authoritativeCheck 注入(agent-backend 挂载块构造)。
 *
 * 注册表是模块级单例(Next dev/prod 下 lib 模块同进程共享),按 missionId 分域:
 * 续聊/重启时由 agent-backend 从 mission.steps 预灌(seedDeliveries),轮末/停止清场。
 */
import type { ToolDefinition } from '@agtpilot/core';
import type { DeliveryContract } from '@/workshops/types';
import type { MissionStep } from '@/types/agent';

/** 工具名(前端叙述/视图收集/挂载块共用同一常量,防漂移) */
export const DELIVER_FIELD_TOOL = 'workshop_deliver_field';

/** 一个任务已交付的字段累积(重交 = 替换同 key) */
export interface DeliveredFields {
  contractId: string;
  fields: Record<string, string>;
}

const registry = new Map<string, DeliveredFields>();

/**
 * 预灌注册表(续聊/重启):agent-backend 从 targetMission.steps 里已成功的
 * workshop_deliver_field 步复原已交付字段,避免续聊时"字段已交付但注册表空"
 * 导致 remaining 误报、模型重复交付。fields 缺省 = 空累积(仅登记 contractId)。
 */
export function seedDeliveries(missionId: string, contractId: string, fields?: Record<string, string>): void {
  if (!missionId) return;
  registry.set(missionId, { contractId, fields: { ...(fields || {}) } });
}

/** 清场(轮末 finally / stopMission):防注册表跨任务泄漏 */
export function clearDeliveries(missionId: string): void {
  if (!missionId) return;
  registry.delete(missionId);
}

/** 读累积(视图收集/测试用;不存在返回 undefined) */
export function getDeliveries(missionId: string): DeliveredFields | undefined {
  return registry.get(missionId);
}

/**
 * 从任务步骤里扫出已接受(ok=true)的交付字段 → {field: content}(按步序,
 * 后值替换前值 = "重交=替换"语义)。续聊/重启预灌注册表(seedDeliveries)与
 * 前端渐进卡视图收集共用此口径,单一事实源。只认 DONE + output.ok 的步:
 * RUNNING(交付中)与 rejected(ok=false)不计入已交付。
 */
export function deliveredFieldsFromSteps(steps: MissionStep[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of steps || []) {
    if (
      s?.tool === DELIVER_FIELD_TOOL &&
      s?.status === 'DONE' &&
      (s?.output as any)?.ok &&
      typeof (s?.args as any)?.field === 'string'
    ) {
      const key = (s.args as any).field as string;
      out[key] = typeof (s.args as any).content === 'string' ? ((s.args as any).content as string) : '';
    }
  }
  return out;
}

export interface DeliveryToolDeps {
  /**
   * 服务端权威校验(可选):纯函数校验通过后再跑,返回错误清单(空 = 通过)。
   * novel 大纲包用它对【书号】做 getNovelBook(userId, bookId) 归属校验——
   * 书号是入库对账钥匙,格式对但书不存在/越权必须打回重试(卡片下拉指认保留为最后兜底)。
   */
  authoritativeCheck?: (field: string, content: string) => Promise<string[]> | string[];
}

/**
 * 构建任务级 workshop_deliver_field 工具(taskTools 注入,不进全局注册表)。
 * schema 的 field 是 enum(契约字段键),content 是该字段完整 markdown。
 * execute:归属校验 → spec.validate 纯函数校验 → deps.authoritativeCheck 服务端校验
 * → 注册表累积(重交=替换)→ 返回 {ok, field, delivered, remaining, hint}。
 */
export function buildDeliverFieldTool(contract: DeliveryContract, deps: DeliveryToolDeps = {}): ToolDefinition {
  const keys = contract.fields.map((f) => f.key);
  const byKey = new Map(contract.fields.map((f) => [f.key, f]));
  const fieldLines = contract.fields
    .map((f) => `  - ${f.key}${f.required ? '(必交付)' : ''}:${f.hint || f.label}`)
    .join('\n');

  return {
    name: DELIVER_FIELD_TOOL,
    description:
      `逐字段交付本任务的结构化产出。**一步只交付一个字段**:写完一个字段立即调用本工具交付它,` +
      `严禁攒到最后一次性输出全文。field 从枚举里选,content 是该字段的完整内容(markdown,不含【字段头】、不含代码围栏)。` +
      `返回 ok=false 时按 errors 修改后**重新交付该字段**(同 field 再调一次即替换);ok=true 后该字段已入库,后续任何输出不得复述它。` +
      `全部字段交付成功后只输出一句收尾提醒,不要重复字段内容。本任务需交付的字段:\n${fieldLines}`,
    dangerLevel: 'low',
    // baseline:穿透工坊白名单与关键词路由(交付出口不能按需挂载,漏挂会把模型逼回单轮巨文本老路)
    baseline: true,
    // 刻意不设 readOnly:orchestrator 的 5 分钟同签名结果缓存会旁路"重交=替换"语义
    parameters: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          enum: keys,
          description: '要交付的字段名(从枚举里选,一次一个)',
        },
        content: {
          type: 'string',
          description: '该字段的完整内容(markdown;不含【字段头】,不含代码围栏)',
        },
      },
      required: ['field', 'content'],
    },
    execute: async ({ field, content }, session): Promise<Record<string, any>> => {
      const missionId = session?.taskId;
      const key = typeof field === 'string' ? field.trim() : '';
      const body = typeof content === 'string' ? content : '';
      if (!missionId) {
        return { ok: false, errors: ['缺少任务上下文,无法交付字段'] };
      }
      const spec = byKey.get(key);
      if (!spec) {
        return { ok: false, errors: [`未知字段「${key}」;可交付字段:${keys.join(' / ')}`] };
      }
      // 纯函数校验(结构从严、篇幅从宽,防重试死循环)
      const errs = spec.validate ? spec.validate(body) : body.trim() ? [] : ['内容不能为空'];
      if (errs.length) {
        return { ok: false, field: key, errors: errs, hint: '按 errors 修改后重新交付该字段(同 field 再调一次即替换)' };
      }
      // 服务端权威校验(novel 书号归属等;纯函数校验通过后才跑)
      if (deps.authoritativeCheck) {
        try {
          const authErrs = await deps.authoritativeCheck(key, body);
          if (authErrs.length) {
            return { ok: false, field: key, errors: authErrs, hint: '按 errors 修改后重新交付该字段' };
          }
        } catch (e: any) {
          // 权威校验自身异常 ≠ 内容不合格:打回但不把内部错误细节泄漏给模型
          return { ok: false, field: key, errors: [`字段「${key}」权威校验失败,请重试或核对内容`], hint: String(e?.message || '') };
        }
      }
      // 累积(重交 = 替换同 key);contractId 不符(理论不该发生)时以当前契约为准重置
      let entry = registry.get(missionId);
      if (!entry || entry.contractId !== contract.id) {
        entry = { contractId: contract.id, fields: {} };
        registry.set(missionId, entry);
      }
      entry.fields[key] = body;
      const delivered = keys.filter((k) => k in entry!.fields);
      const remaining = keys.filter((k) => !(k in entry!.fields));
      const allDone = remaining.length === 0;
      return {
        ok: true,
        field: key,
        delivered,
        remaining,
        hint: allDone
          ? '全部字段已交付:只输出一句收尾提醒,不要重复任何字段内容'
          : `已交付「${key}」(${delivered.length}/${keys.length});继续交付下一个字段(一步一个,别复述已交付内容)`,
      };
    },
  };
}
