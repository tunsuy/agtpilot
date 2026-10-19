/**
 * 逐字段交付 · 前端视图收集(纯函数,客户端 bundle 安全)
 *
 * 数据源 = mission.steps 里的 workshop_deliver_field 工具步:tool_call 事件在执行前
 * 广播完整 args(field+content)→ RUNNING 步即内容可预览;tool_result → DONE+output.ok。
 * args/output 持久化进 steps 并经 /api/agent/state 重放,故跨步/跨轮累积无需新事件类型。
 *
 * 三态语义:
 * - delivering:RUNNING 步已到达(args 有内容),工具尚未 settle —— 卡片可预览但标"交付中";
 * - delivered:DONE 且 output.ok=true —— 字段入库点亮;
 * - rejected:DONE 且 output.ok=false(或 FAILED)—— 校验没过,不点亮,等模型重试;
 * - pending:该字段还没有任何交付步 —— 骨架行。
 *
 * 跨轮累积按步序扫描,后值替换前值("重交=替换"语义):同字段先 rejected 后 delivered
 * 的最终态是 delivered。与 lib/workshop-delivery.ts 的 deliveredFieldsFromSteps 同一口径
 * (那边只收 ok=true 供服务端预灌,这边保留三态供渲染)。
 */
import type { DeliveryContract } from '@/workshops/types';
import type { MissionStep } from '@/types/agent';
import { DELIVER_FIELD_TOOL } from '@/lib/workshop-delivery';

export type DeliverFieldState = 'pending' | 'delivering' | 'delivered' | 'rejected';

export interface FieldProgressView {
  key: string;
  label: string;
  required: boolean;
  state: DeliverFieldState;
  /** 最新交付/交付中的内容(pending 时为 '') */
  content: string;
}

export interface DeliveryProgressView {
  contractId: string;
  /** 按契约字段序(建议交付序)排列,含未交付的 pending 骨架行 */
  fields: FieldProgressView[];
  deliveredCount: number;
  totalCount: number;
  /** 全部 required 字段已 delivered → 激活「存入书库」 */
  requiredDone: boolean;
  /** 全部字段已 delivered */
  complete: boolean;
}

/**
 * 从任务步收集逐字段交付进度。无契约或无任何交付步 → null(文本解析路径/旧任务
 * 不钉渐进卡,行为与从前逐字节一致)。
 */
export function collectWorkshopDeliveries(
  steps: MissionStep[] | undefined,
  contract: DeliveryContract | undefined | null
): DeliveryProgressView | null {
  if (!contract || !contract.fields?.length) return null;

  const observed: Record<string, { state: DeliverFieldState; content: string }> = {};
  let sawAny = false;
  for (const s of steps || []) {
    if (s?.tool !== DELIVER_FIELD_TOOL) continue;
    const args = s.args as any;
    const key = typeof args?.field === 'string' ? args.field : '';
    if (!key) continue;
    sawAny = true;
    const content = typeof args?.content === 'string' ? args.content : '';
    if (s.status === 'RUNNING' || s.status === 'PENDING') {
      observed[key] = { state: 'delivering', content };
    } else if (s.status === 'DONE') {
      const ok = Boolean((s.output as any)?.ok);
      observed[key] = { state: ok ? 'delivered' : 'rejected', content };
    } else {
      // FAILED 等:视作被打回,不点亮
      observed[key] = { state: 'rejected', content };
    }
  }
  if (!sawAny) return null;

  const fields: FieldProgressView[] = contract.fields.map((f) => {
    const obs = observed[f.key];
    return {
      key: f.key,
      label: f.label,
      required: f.required,
      state: obs?.state || 'pending',
      content: obs?.content || '',
    };
  });

  const deliveredCount = fields.filter((f) => f.state === 'delivered').length;
  const requiredDone = fields.filter((f) => f.required).every((f) => f.state === 'delivered');
  const complete = fields.every((f) => f.state === 'delivered');

  return {
    contractId: contract.id,
    fields,
    deliveredCount,
    totalCount: fields.length,
    requiredDone,
    complete,
  };
}
