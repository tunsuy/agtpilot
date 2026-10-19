'use client';

import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ClipboardCheck, HelpCircle, Play, Send, Sparkles, SquarePen } from 'lucide-react';
import type { PendingQuestion, QuestionItem } from '../types/agent';

/**
 * ask_user 问题卡 / confirm_plan 计划确认卡(桌面驾驶舱/移动端「动态」共用):
 * agent 遇到模糊需求时先问后猜 —— 一次可打包 1-3 个相关问题,每问选项按钮
 * (推荐项加徽章)+ 多选 + 选项 preview 对照 + 自由文本,一张卡答完一次提交;
 * kind='plan' 时渲染计划概要 + 任务清单的方案批准门(开始执行/先调整一下)。
 * 交互分两档:
 * - 单问纯选项卡:点选项/回车即提交(零摩擦快路径);
 * - 其余(多问/多选/带 preview/计划卡):逐问选择,全部就绪后底部一次提交
 *   (带对照物或要批准方案的决策值得多看一眼,不给误触点发的快路径)。
 * 提交后乐观禁用防双击,真实撤卡走 question_resolved SSE 收口;
 * 超时未答按各问推荐项自动继续(工具侧兜底,卡片随事件消失)。
 */
interface QuestionCardProps {
  q: PendingQuestion;
  /** answers 为逐问回答(index 对应 questions 序),覆盖校验由后端桥做 */
  onAnswer: (questionId: string, answers: Array<{ index: number; answer: string; via: 'option' | 'free_text' }>) => void;
  /** 移动端紧凑样式 */
  compact?: boolean;
}

/** 单问的当前作答(选项与自由文本互斥:后写的赢;多选记多个 value) */
interface Draft {
  via: 'option' | 'free_text';
  /** via=option 时选中的选项 value 列表(多选可多个) */
  values: string[];
  /** via=free_text 时的原话 */
  text: string;
}

const emptyDraft = (): Draft => ({ via: 'option', values: [], text: '' });

export function QuestionCard({ q, onAnswer, compact = false }: QuestionCardProps) {
  const [submitted, setSubmitted] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  /** 每问当前展示 preview 的选项 value(点选或桌面端悬停设置) */
  const [previewFocus, setPreviewFocus] = useState<Record<number, string>>({});

  const questions: QuestionItem[] = q.questions || [];
  const isPlan = q.kind === 'plan';
  const single = questions.length === 1;
  const hasPreview = questions.some((item) => item.options.some((o) => o.preview));
  const hasMulti = questions.some((item) => item.multiSelect);
  // 快路径:单问、纯选项、无对照物、非计划卡 —— 点选即提交
  const fastSubmit = single && !isPlan && !hasPreview && !hasMulti;

  const draftOf = (qi: number): Draft => drafts[qi] || emptyDraft();

  /** 该问是否已作答 */
  const answered = (qi: number): boolean => {
    const d = draftOf(qi);
    return d.via === 'free_text' ? Boolean(d.text.trim()) : d.values.length > 0;
  };
  const allAnswered = useMemo(() => questions.every((_, i) => answered(i)), [questions, drafts]);

  /** 该问的最终答案文本(多选按选项序顿号拼接) */
  const answerOf = (qi: number): string => {
    const item = questions[qi];
    const d = draftOf(qi);
    if (d.via === 'free_text') return d.text.trim();
    return item.options
      .filter((o) => d.values.includes(o.value))
      .map((o) => o.label)
      .join('、');
  };

  const setDraft = (index: number, draft: Draft) => {
    setDrafts((prev) => ({ ...prev, [index]: draft }));
  };

  const submit = (answers: Array<{ index: number; answer: string; via: 'option' | 'free_text' }>) => {
    if (submitted) return;
    setSubmitted(true);
    onAnswer(q.id, answers);
  };

  const submitDrafts = () => {
    if (!allAnswered) return;
    submit(questions.map((_, i) => ({ index: i, answer: answerOf(i), via: draftOf(i).via })));
  };

  const pickOption = (qi: number, item: QuestionItem, value: string) => {
    setPreviewFocus((prev) => ({ ...prev, [qi]: value }));
    if (fastSubmit) {
      // 单问纯选项快路径:点选即提交
      const opt = item.options.find((o) => o.value === value);
      submit([{ index: 0, answer: opt?.label || value, via: 'option' }]);
      return;
    }
    const d = draftOf(qi);
    if (item.multiSelect) {
      const values = d.values.includes(value) ? d.values.filter((v) => v !== value) : [...d.values, value];
      setDraft(qi, { via: 'option', values, text: '' });
    } else {
      setDraft(qi, { via: 'option', values: [value], text: '' });
    }
  };

  const timeoutHint = q.expiresAt
    ? `${Math.max(1, Math.round((q.expiresAt - Date.now()) / 60000))} 分钟内未答将按推荐项自动继续`
    : isPlan
    ? '超时未答将按计划自动继续执行'
    : '超时未答将按推荐项自动继续';

  return (
    <div
      className={`rounded-xl border border-sky-200 bg-sky-50/90 shadow-xs animate-fadeIn ${
        submitted ? 'opacity-60 pointer-events-none' : ''
      } ${compact ? 'px-4 py-3.5' : 'p-3.5'}`}
    >
      <div className="space-y-4">
        {questions.map((item, qi) => {
          const d = draftOf(qi);
          const focusOpt = item.options.find((o) => o.value === previewFocus[qi]);
          return (
            <div key={qi} className={qi > 0 && !compact ? 'pt-4 border-t border-sky-100' : undefined}>
              <div className="flex items-start gap-2.5">
                <div
                  className={`h-8 w-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                    isPlan ? 'bg-indigo-100 text-indigo-700' : 'bg-sky-100 text-sky-700'
                  }`}
                >
                  {isPlan ? <ClipboardCheck className="h-4 w-4" /> : <HelpCircle className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-semibold text-zinc-900 block">
                    {isPlan && (
                      <span className="inline-flex items-center text-[10px] font-medium text-indigo-700 bg-indigo-100 rounded px-1.5 py-0.5 mr-1.5 align-middle">
                        计划确认
                      </span>
                    )}
                    {questions.length > 1 && (
                      <span className="text-sky-600 mr-1">
                        {qi + 1}/{questions.length}
                      </span>
                    )}
                    {item.question}
                  </span>
                  {item.context &&
                    (isPlan ? (
                      // 计划概要是模型给的 markdown 要点,富渲染
                      <div className="text-[11px] text-zinc-600 mt-1 prose prose-xs max-w-none [&_p]:my-0.5 [&_ul]:my-0.5 [&_li]:my-0">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.context}</ReactMarkdown>
                      </div>
                    ) : (
                      <p className="text-[11px] text-zinc-600 mt-0.5">{item.context}</p>
                    ))}
                </div>
              </div>

              {/* 计划卡:任务清单(看板要点) */}
              {isPlan && qi === 0 && (q.planTasks || []).length > 0 && (
                <ol className="mt-2.5 rounded-lg border border-indigo-100 bg-white/80 px-3 py-2 space-y-1">
                  {(q.planTasks || []).map((t, ti) => (
                    <li key={ti} className="flex items-start gap-2 text-[11px] text-zinc-700">
                      <span className="text-indigo-400 font-medium flex-shrink-0">{ti + 1}.</span>
                      <span className="min-w-0">{t}</span>
                    </li>
                  ))}
                </ol>
              )}

              <div className={`mt-3 ${compact || questions.length > 1 ? 'space-y-2' : 'grid grid-cols-1 sm:grid-cols-2 gap-2'}`}>
                {item.options.map((opt) => {
                  const picked = d.via === 'option' && d.values.includes(opt.value);
                  const goStyle = isPlan && opt.value === 'go';
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => pickOption(qi, item, opt.value)}
                      onMouseEnter={() => opt.preview && setPreviewFocus((prev) => ({ ...prev, [qi]: opt.value }))}
                      className={`w-full text-left px-3 py-2.5 rounded-lg border transition bg-white ${
                        goStyle && picked
                          ? 'border-sky-600 bg-sky-600 text-white'
                          : picked
                          ? 'border-sky-500 ring-1 ring-sky-300 bg-sky-50'
                          : opt.recommended
                          ? 'border-sky-300 ring-1 ring-sky-200 hover:border-sky-400 hover:bg-sky-50/50'
                          : 'border-zinc-200 hover:border-sky-400 hover:bg-sky-50/50'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        {item.multiSelect && (
                          <span
                            className={`h-3.5 w-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                              picked ? 'bg-sky-600 border-sky-600 text-white' : 'border-zinc-300 bg-white'
                            }`}
                          >
                            {picked && <Check className="h-2.5 w-2.5" />}
                          </span>
                        )}
                        {isPlan && (
                          <span className="flex-shrink-0 text-sky-600">
                            {opt.value === 'go' ? <Play className="h-3 w-3" /> : <SquarePen className="h-3 w-3" />}
                          </span>
                        )}
                        <span className={`text-xs font-medium ${goStyle && picked ? 'text-white' : 'text-zinc-900'}`}>
                          {opt.label}
                        </span>
                        {opt.recommended && (
                          <span
                            className={`inline-flex items-center gap-0.5 text-[10px] font-medium rounded px-1.5 py-0.5 flex-shrink-0 ${
                              goStyle && picked ? 'text-white bg-white/20' : 'text-sky-700 bg-sky-100'
                            }`}
                          >
                            <Sparkles className="h-2.5 w-2.5" /> 推荐
                          </span>
                        )}
                        {opt.preview && (
                          <span className="text-[10px] text-zinc-400 ml-auto flex-shrink-0">对照</span>
                        )}
                      </span>
                      {opt.description && (
                        <span className={`block text-[11px] mt-0.5 ${goStyle && picked ? 'text-sky-100' : 'text-zinc-500'}`}>
                          {opt.description}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* 选项对照面板:点选/悬停哪个看哪个(版式、结构类决策的可视化对比) */}
              {focusOpt?.preview && (
                <div className="mt-2 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 max-h-56 overflow-auto">
                  <div className="text-[10px] font-medium text-zinc-400 mb-1.5 flex items-center gap-1">
                    <Sparkles className="h-2.5 w-2.5" /> 对照 · {focusOpt.label}
                  </div>
                  <div className="text-[11px] text-zinc-700 prose prose-xs max-w-none [&_pre]:text-[10px] [&_pre]:bg-zinc-50 [&_pre]:rounded [&_pre]:p-2 [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0 [&_table]:text-[10px]">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{focusOpt.preview}</ReactMarkdown>
                  </div>
                </div>
              )}

              {item.allowFreeText !== false && (
                <div className="mt-2.5 flex items-center gap-2">
                  <input
                    type="text"
                    value={d.via === 'free_text' ? d.text : ''}
                    onChange={(e) => setDraft(qi, { via: 'free_text', values: [], text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && d.via === 'free_text' && d.text.trim()) {
                        if (fastSubmit) submit([{ index: 0, answer: d.text.trim(), via: 'free_text' }]);
                        else submitDrafts();
                      }
                    }}
                    placeholder={
                      isPlan
                        ? '有修改意见直接写在这里…'
                        : single
                        ? '或直接输入你的想法…'
                        : `第 ${qi + 1} 问:或直接输入你的想法…`
                    }
                    className="flex-1 min-w-0 h-9 px-3 rounded-lg border border-zinc-200 bg-white text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-200"
                  />
                  {fastSubmit && (
                    <button
                      type="button"
                      onClick={() => d.via === 'free_text' && submit([{ index: 0, answer: d.text.trim(), via: 'free_text' }])}
                      disabled={d.via !== 'free_text' || !d.text.trim()}
                      className="h-9 px-3 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:hover:bg-sky-600 text-white transition shadow-xs flex items-center gap-1.5 flex-shrink-0"
                    >
                      <Send className="h-3.5 w-3.5" />
                      <span className="text-xs font-medium">回答</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!fastSubmit && (
        <div className="mt-3 flex items-center gap-2">
          {!single && (
            <span className="text-[11px] text-zinc-500">
              已答 {questions.filter((_, i) => answered(i)).length}/{questions.length}
            </span>
          )}
          <button
            type="button"
            onClick={submitDrafts}
            disabled={!allAnswered}
            className="ml-auto h-9 px-4 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:hover:bg-sky-600 text-white transition shadow-xs flex items-center gap-1.5"
          >
            <Send className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{isPlan ? '确认' : '提交回答'}</span>
          </button>
        </div>
      )}

      <p className="mt-2 text-[10px] text-zinc-400">{timeoutHint}</p>
    </div>
  );
}
