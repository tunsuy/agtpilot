/**
 * 任务看板卡(会话流钉挂):planner_create_plan 所在轮次常驻展示看板
 * 目标 / 步骤状态 / 进度。数据源 mission.plan('plan' 事件实时镜像,
 * 看板由模型同批申报维护、重建自动替换),执行全程进度一眼可见。
 *
 * 不参与整轮过程折叠(钉在过程区之前):受控进展播报开始吐正文后
 * 过程区会收起,看板进度不能跟着一起消失。
 */
import { CheckCircle2, Circle, ListChecks, Loader2, XCircle } from 'lucide-react';
import type { PlanData, PlanTask } from '@agtpilot/protocol';

function taskIcon(status: PlanTask['status']) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />;
    case 'in_progress':
      return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin flex-shrink-0 mt-0.5" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0 mt-0.5" />;
    default:
      return <Circle className="h-3.5 w-3.5 text-zinc-300 flex-shrink-0 mt-0.5" />;
  }
}

const taskTitleClass: Record<PlanTask['status'], string> = {
  completed: 'text-zinc-400',
  in_progress: 'text-zinc-800 font-medium',
  failed: 'text-red-600',
  pending: 'text-zinc-500',
};

export function KanbanPlanCard({ plan }: { plan: PlanData }) {
  const total = plan.tasks.length;
  const completed = plan.tasks.filter((t) => t.status === 'completed').length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="rounded-lg border border-zinc-200/80 bg-zinc-50/60 px-3 py-2.5 space-y-2 shadow-2xs animate-fadeIn">
      {/* 头部:看板标识 + 完成计数(与左侧会话徽标 progress 同口径) */}
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-600 select-none">
        <ListChecks className="h-3.5 w-3.5 text-zinc-400" />
        <span>任务看板</span>
        <span className="ml-auto text-[10px] font-mono text-zinc-400">
          {completed}/{total} 步 · {pct}%
        </span>
      </div>
      {plan.goal && (
        <p className="text-[10px] text-zinc-400 truncate" title={plan.goal}>
          目标:{plan.goal}
        </p>
      )}
      {/* 进度条:完成比例,transition 让推进有滑动感 */}
      <div className="h-1 rounded-full bg-zinc-200/80 overflow-hidden">
        <div
          className="h-full bg-blue-500 transition-all duration-500"
          style={{ width: `${Math.max(pct, 3)}%` }}
        />
      </div>
      {/* 步骤清单:状态图标 + 标题;进行中/待执行的描述挂 title 提示 */}
      <ul className="space-y-1">
        {plan.tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-1.5 leading-relaxed">
            {taskIcon(t.status)}
            <span
              className={`text-[11px] ${taskTitleClass[t.status]}`}
              title={t.description || t.result || undefined}
            >
              {t.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
