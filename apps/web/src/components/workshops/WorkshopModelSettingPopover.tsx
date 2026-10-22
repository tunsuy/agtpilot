'use client';

/**
 * 工坊思考深度 · 卡片右上角设置弹层(工坊模型设置的 UI 入口)。
 *
 * 优先级 = 工坊设置(这里改,存 user-store)> 连接器全局 > env > 分支缺省。
 * 巡航触发时服务端现读,存量巡航任务自动跟随;只对推理型模型有意义,
 * 非推理模型忽略该参数(与连接器卡片口径一致)。
 * 未设置 = 不落键 = 跟随连接器(存储层表达不出「显式关」,与连接器卡片同款语义)。
 */
import { useEffect, useRef, useState } from 'react';
import { Gauge, Check } from 'lucide-react';
import type { WorkshopDef } from './registry';

const EFFORT_OPTIONS: Array<{ value: string; label: string; desc: string }> = [
  { value: '', label: '跟随连接器', desc: '用连接器卡片上的全局设置(默认)' },
  { value: 'none', label: '关闭', desc: '不下发思考参数外,还显式要求模型关思考 —— 输出预算全留给正文' },
  { value: 'low', label: '低', desc: '反应快、省 token,适合重产出轻推理(日更、模板化写作)' },
  { value: 'medium', label: '中', desc: '均衡档' },
  { value: 'high', label: '高', desc: '深度推理,更慢更贵,适合复杂调研与决策' },
];

interface WorkshopModelSettingPopoverProps {
  workshop: WorkshopDef;
  /** 当前档位;undefined = 跟随连接器 */
  value?: 'low' | 'medium' | 'high' | 'none';
  onChange: (effort: string) => void;
}

export function WorkshopModelSettingPopover({ workshop, value, onChange }: WorkshopModelSettingPopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部/ESC 关闭(工坊页无全局遮罩,弹层自管理)
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const activeLabel = value ? EFFORT_OPTIONS.find((o) => o.value === value)?.label : undefined;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 px-1.5 py-1 rounded-lg text-[10px] font-medium transition ${
          value
            ? 'bg-violet-50 text-violet-600 border border-violet-200/70 hover:bg-violet-100'
            : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 border border-transparent'
        }`}
        title="本工坊任务的思考深度(巡航触发同样生效);默认跟随连接器全局设置"
      >
        <Gauge className="h-3 w-3" />
        <span className="font-sans">{value ? `思考·${activeLabel}` : '思考深度'}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-30 w-72 rounded-xl border border-zinc-200 bg-white p-3 shadow-lg animate-fadeIn">
          <div className="text-[11px] font-semibold text-zinc-800">{workshop.name} · 思考深度</div>
          <p className="text-[10px] text-zinc-400 mt-0.5 leading-relaxed">
            本工坊所有任务(含巡航触发)的思考档,压过连接器全局;改档即时生效,续聊下一轮跟随。
          </p>
          <div className="mt-2.5 space-y-1">
            {EFFORT_OPTIONS.map((o) => {
              const active = (value || '') === o.value;
              return (
                <button
                  key={o.value || 'default'}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`w-full flex items-start gap-2 px-2 py-1.5 rounded-lg text-left transition ${
                    active ? 'bg-zinc-100' : 'hover:bg-zinc-50'
                  }`}
                >
                  <span className="flex items-center h-4 shrink-0">
                    <span
                      className={`h-3.5 w-3.5 rounded-full border flex items-center justify-center ${
                        active ? 'border-violet-600' : 'border-zinc-300'
                      }`}
                    >
                      {active && <Check className="h-2.5 w-2.5 text-violet-600" />}
                    </span>
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-[11px] font-medium ${active ? 'text-zinc-900' : 'text-zinc-700'}`}>
                      {o.label}
                    </span>
                    <span className="block text-[10px] text-zinc-400 leading-snug">{o.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 pt-2 border-t border-zinc-100 text-[10px] text-zinc-400 leading-relaxed">
            仅对推理型模型有意义;非推理模型会忽略该参数。连接器卡片的设置仍管其余任务。
          </p>
        </div>
      )}
    </div>
  );
}
