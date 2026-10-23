'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Package, X, Loader2, Check } from 'lucide-react';

/**
 * 技能包显式引用选择器(共享组件):手工会话输入区(桌面 popover / 移动端
 * sheet)、巡航任务弹窗、长期目标弹窗四处宿主共用。
 *
 * 语义:引用 = 该任务的 system prompt 注入其 SKILL.md 全文(「用户指定,
 * 严格遵循」+ 第三方护栏);不引用则任务对技能包零感知。上限与服务端
 * REFERENCED_PACK_MAX 同口径(缺省 5),服务端另有一道白名单收敛。
 *
 * 数据:自包含懒加载 GET /api/skills(.installed),模块级 30s TTL 缓存 +
 * in-flight 去重 —— 多宿主实例共享一次拉取,page.tsx 无需 prop 钻透。
 */

export interface SkillPackOption {
  name: string;
  description: string;
  dirName: string;
}

interface SkillPackPickerProps {
  /** 已选包名(canonical name);受控 */
  selected: string[];
  onChange: (names: string[]) => void;
  /** 上限,缺省 5(与服务端 REFERENCED_PACK_MAX 同口径) */
  max?: number;
  /** popover=桌面弹层(缺省);sheet=移动端底部抽屉(fixed z-[60] + safe-area) */
  variant?: 'popover' | 'sheet';
  /** popover 展开方向:composer 贴屏幕底传 'up'(缺省 'down',modal 表单用) */
  direction?: 'up' | 'down';
  /** 紧凑触发器(纯图标+角标,不渲染已选 chips):输入框按钮簇用 */
  compact?: boolean;
  disabled?: boolean;
}

const CACHE_TTL_MS = 30_000;
let cache: { at: number; packs: SkillPackOption[] } | null = null;
let inflight: Promise<SkillPackOption[]> | null = null;

function loadInstalled(): Promise<SkillPackOption[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return Promise.resolve(cache.packs);
  if (!inflight) {
    inflight = fetch('/api/skills')
      .then((res) => res.json())
      .then((data) => {
        const packs: SkillPackOption[] = Array.isArray(data?.installed)
          ? data.installed
              .map((p: any) => ({
                name: String(p?.name || ''),
                description: String(p?.description || ''),
                dirName: String(p?.dirName || ''),
              }))
              .filter((p: SkillPackOption) => p.name)
          : [];
        cache = { at: Date.now(), packs };
        return packs;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function SkillPackPicker({
  selected,
  onChange,
  max = 5,
  variant = 'popover',
  direction = 'down',
  compact = false,
  disabled = false,
}: SkillPackPickerProps) {
  const [open, setOpen] = useState(false);
  const [packs, setPacks] = useState<SkillPackOption[]>(cache?.packs || []);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const openPanel = useCallback(async () => {
    if (disabled) return;
    setOpen(true);
    setLoading(true);
    setLoadError(false);
    try {
      setPacks(await loadInstalled());
    } catch {
      setLoadError(true); // 失败保留旧缓存列表;重开即重试
    } finally {
      setLoading(false);
    }
  }, [disabled]);

  // popover:点击外部 / Esc 关闭(sheet 自带背板点击与完成按钮)
  useEffect(() => {
    if (!open || variant !== 'popover') return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, variant]);

  const toggle = (name: string) => {
    if (selected.includes(name)) onChange(selected.filter((n) => n !== name));
    else if (selected.length < max) onChange([...selected, name]);
  };

  const atMax = selected.length >= max;

  const listBody = loading ? (
    <div className="py-6 flex items-center justify-center gap-2 text-xs text-zinc-400">
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在加载已安装技能包…
    </div>
  ) : loadError ? (
    <div className="py-6 text-center space-y-2">
      <p className="text-xs text-zinc-400">技能包列表加载失败</p>
      <button
        type="button"
        onClick={openPanel}
        className="text-xs font-medium text-zinc-700 underline underline-offset-2"
      >
        重试
      </button>
    </div>
  ) : packs.length === 0 ? (
    <div className="py-6 px-4 text-center text-xs text-zinc-400 leading-relaxed">
      还没有引用生态技能 —— 去技能中心「技能市场」
      安装后可在此引用
    </div>
  ) : (
    <div className="space-y-0.5">
      {packs.map((p) => {
        const checked = selected.includes(p.name);
        return (
          <button
            key={p.dirName || p.name}
            type="button"
            onClick={() => toggle(p.name)}
            disabled={disabled || (!checked && atMax)}
            className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition hover:bg-zinc-50 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <span
              className={`mt-0.5 h-4 w-4 rounded border flex items-center justify-center flex-shrink-0 ${
                checked ? 'bg-zinc-900 border-zinc-900 text-white' : 'border-zinc-300 bg-white'
              }`}
            >
              {checked && <Check className="h-3 w-3" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-zinc-800 truncate">{p.name}</span>
              {p.description && (
                <span className="block text-[11px] text-zinc-400 line-clamp-1">{p.description}</span>
              )}
            </span>
          </button>
        );
      })}
      {atMax && packs.length > max && (
        <p className="px-2.5 pt-1 pb-1.5 text-[10px] text-zinc-400">至多引用 {max} 个技能包</p>
      )}
    </div>
  );

  return (
    <>
      <div className="relative" ref={rootRef}>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => (open ? setOpen(false) : openPanel())}
            disabled={disabled}
            title="引用技能包(任务将注入其 SKILL.md 全文)"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition flex-shrink-0 ${
              selected.length > 0
                ? 'bg-zinc-900 border-zinc-900 text-white shadow-2xs'
                : 'bg-white border-zinc-200/90 text-zinc-600 hover:text-zinc-900 hover:border-zinc-300 shadow-2xs'
            } disabled:opacity-40`}
          >
            <Package className="h-3.5 w-3.5" />
            {!compact && <span>技能包</span>}
            {selected.length > 0 && (
              <span
                className={`text-[10px] min-w-4 text-center px-1 rounded-full ${
                  selected.length > 0 ? 'bg-zinc-700 text-zinc-100' : ''
                }`}
              >
                {selected.length}
              </span>
            )}
          </button>

          {/* 已选 chips(紧凑模式不渲染,选择详情看角标与面板勾选态) */}
          {!compact &&
            selected.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-zinc-100 border border-zinc-200 text-[10px] font-medium text-zinc-700 max-w-[140px]"
              >
                <span className="truncate">{name}</span>
                <button
                  type="button"
                  onClick={() => toggle(name)}
                  className="p-0.5 rounded-full hover:bg-zinc-200 text-zinc-400 hover:text-zinc-700 transition flex-shrink-0"
                  title={`移除引用「${name}」`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
        </div>

        {open && variant === 'popover' && (
          <div
            className={`absolute z-50 w-72 left-0 rounded-xl border border-zinc-200 bg-white shadow-lg p-1.5 animate-fadeIn ${
              direction === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
            }`}
          >
            {listBody}
          </div>
        )}
      </div>

      {open && variant === 'sheet' && (
        <div className="fixed inset-0 z-[60]" role="dialog" aria-label="引用技能包">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-0 inset-x-0 rounded-t-2xl bg-white max-h-[60vh] flex flex-col shadow-xl pb-[env(safe-area-inset-bottom,0px)]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 flex-shrink-0">
              <div>
                <p className="text-sm font-semibold text-zinc-900">引用技能包</p>
                <p className="text-[11px] text-zinc-400 mt-0.5">
                  已选 {selected.length}/{max} · 任务将注入其 SKILL.md 全文
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto p-2 flex-1">{listBody}</div>
            <div className="px-4 py-3 border-t border-zinc-100 flex-shrink-0">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-full py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-medium transition"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
