'use client';

/**
 * 场景档案首次引导 / 编辑向导(scenario-loop §2)
 *
 * 3 分钟三步:定位 → 人设 → 节奏。保存走 POST /api/scenario-profiles(upsert)。
 * WorkshopsView 内部状态渲染(fixed z-50 遮罩,与 WorkshopModalShell 同级),
 * 桌面与移动端工坊覆盖层之上均可直接叠放,不动 page.tsx。
 */
import React, { useState } from 'react';
import { X, Sparkles, ChevronLeft, Check } from 'lucide-react';
import { ChipGroup, FieldLabel, inputClass, textareaClass } from './forms/shared';
import type { ScenarioProfile } from '../../lib/scenario-profile';

interface ScenarioProfileWizardProps {
  scenarioKey: string;
  /** 编辑模式回填;首次引导为 null */
  initial?: ScenarioProfile | null;
  /** 保存成功(已 POST)后回调整份档案 */
  onComplete: (profile: ScenarioProfile) => void;
  /** 跳过,直接开表单 */
  onSkip: () => void;
  /** 纯关闭,不推进 */
  onClose: () => void;
}

const STEPS = [
  { title: '账号定位', hint: '让 Agent 知道你在做哪个赛道、写给谁看' },
  { title: '语气人设', hint: '写两句你最自然的口吻,产出会和你的账号一个声音' },
  { title: '发布节奏', hint: '让选题建议匹配你的更新频率' },
] as const;

const CADENCE_OPTIONS = [
  { id: 0, name: '不固定' },
  { id: 3, name: '每周 3 篇' },
  { id: 5, name: '每周 5 篇' },
  { id: 7, name: '每天 1 篇' },
];

export function ScenarioProfileWizard({
  scenarioKey,
  initial,
  onComplete,
  onSkip,
  onClose,
}: ScenarioProfileWizardProps) {
  const [step, setStep] = useState(0);
  const [niche, setNiche] = useState(initial?.positioning.niche || '');
  const [audience, setAudience] = useState(initial?.positioning.audience || '');
  const [differentiation, setDifferentiation] = useState(initial?.positioning.differentiation || '');
  const [toneSamples, setToneSamples] = useState((initial?.persona.toneSamples || []).join('\n'));
  const [taboos, setTaboos] = useState((initial?.persona.taboos || []).join('、'));
  const [cadence, setCadence] = useState<number>(initial?.cadence.postsPerWeek || 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = Boolean(initial);
  const stepValid = step === 0 ? niche.trim().length > 0 && audience.trim().length > 0 : true;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/scenario-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          scenarioKey,
          profile: {
            niche: niche.trim(),
            audience: audience.trim(),
            differentiation: differentiation.trim() || undefined,
            toneSamples: toneSamples.trim() || undefined,
            taboos: taboos.trim() || undefined,
            ...(cadence > 0 ? { postsPerWeek: cadence } : {}),
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || '保存失败,请稍后再试');
        return;
      }
      onComplete(data.profile);
    } catch {
      setError('网络异常,请稍后再试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl animate-fadeIn space-y-5">
        {/* 标题 + 步骤指示 */}
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">
              {isEdit ? '编辑账号档案' : '建立账号档案'}
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
              {STEPS[step].title} · {STEPS[step].hint}
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 p-1 rounded-md">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full transition ${i <= step ? 'bg-violet-500' : 'bg-zinc-200'}`}
            />
          ))}
          <span className="text-[10px] font-mono text-zinc-400 ml-1.5">
            {step + 1}/{STEPS.length}
          </span>
        </div>

        {/* 步骤体 */}
        {step === 0 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <FieldLabel>赛道</FieldLabel>
              <input
                type="text"
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
                placeholder="如:秋冬通勤穿搭 / 职场干货 / 宝妈好物"
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <FieldLabel>目标人群</FieldLabel>
              <input
                type="text"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="如:30+ 通勤女性 / 入职 1-3 年的年轻人"
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <FieldLabel optional>差异点</FieldLabel>
              <textarea
                value={differentiation}
                onChange={(e) => setDifferentiation(e.target.value)}
                placeholder="如:只写平价可复制的组合,不追奢侈品"
                rows={2}
                className={textareaClass}
              />
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <FieldLabel optional>语气样例</FieldLabel>
              <textarea
                value={toneSamples}
                onChange={(e) => setToneSamples(e.target.value)}
                placeholder={'写两句你平时发笔记的口吻,每行一句,如:\n姐妹们这套真的绝\n打工人早八也能三分钟出门'}
                rows={3}
                className={textareaClass}
              />
            </div>
            <div className="space-y-1.5">
              <FieldLabel optional>禁忌</FieldLabel>
              <textarea
                value={taboos}
                onChange={(e) => setTaboos(e.target.value)}
                placeholder="用顿号或逗号分隔,如:不要感叹号、不提价格、不喊宝子"
                rows={2}
                className={textareaClass}
              />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <FieldLabel>更新频率</FieldLabel>
              <ChipGroup options={CADENCE_OPTIONS} value={cadence} onChange={setCadence} accent="violet" />
            </div>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              档案保存后随时可改;之后的每次创作都会自动带上这份设定,不用再重复解释。
            </p>
          </div>
        )}

        {error && (
          <p className="text-[11px] text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>
        )}

        {/* 底部导航 */}
        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={onSkip}
            className="text-[11px] text-zinc-400 hover:text-zinc-600 transition"
          >
            {isEdit ? '取消' : '跳过,先不设档案'}
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => s - 1)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                <span>上一步</span>
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button
                type="button"
                disabled={!stepValid}
                onClick={() => setStep((s) => s + 1)}
                className="px-4 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition shadow-xs"
              >
                下一步
              </button>
            ) : (
              <button
                type="button"
                disabled={saving || !stepValid}
                onClick={handleSave}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition shadow-xs"
              >
                {saving ? <Check className="h-3.5 w-3.5 animate-pulse" /> : <Sparkles className="h-3.5 w-3.5" />}
                <span>{isEdit ? '保存' : '保存并开始'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
