'use client';

import React, { useState } from 'react';
import {
  Clock,
  Plus,
  Play,
  Pause,
  Trash2,
  Pencil,
  Sparkles,
  Calendar,
  RotateCw,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Timer,
} from 'lucide-react';
import { CronJobItem } from '../types/agent';
import { formatCronNextRun, isValidCronPattern } from '@/lib/cron-utils';

interface CronJobsViewProps {
  jobs: CronJobItem[];
  onCreateJob: (job: { name: string; pattern: string; prompt: string }) => Promise<void>;
  onUpdateJob?: (job: { id: string; name: string; pattern: string; prompt: string }) => Promise<void>;
  onToggleJob: (id: string) => Promise<void>;
  onDeleteJob: (id: string) => Promise<void>;
}

export function CronJobsView({
  jobs,
  onCreateJob,
  onUpdateJob,
  onToggleJob,
  onDeleteJob,
}: CronJobsViewProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [patternInput, setPatternInput] = useState('0 9 * * *');
  const [promptInput, setPromptInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const presets = [
    {
      title: '每日早报 (朝9点)',
      pattern: '0 9 * * *',
      prompt: '搜索全球科技媒体与 arXiv 上的最新 AI Agent 进展，总结 3 条最重要趋势并生成早报。',
    },
    {
      title: '每小时服务器巡检',
      pattern: '0 * * * *',
      prompt: '通过终端检查服务器负载、内存使用率与容器健康状态，如异常则生成警报。',
    },
    {
      title: '工作日下班归档 (18点)',
      pattern: '0 18 * * 1-5',
      prompt: '整理今日交付库中的新文件与任务完成情况，生成工作日志汇报。',
    },
    {
      title: '每半小时 GitHub 关注项目扫描',
      pattern: '*/30 * * * *',
      prompt: '访问 GitHub 查看关注的开源项目的最新 release 与 issues，汇总关键更新。',
    },
  ];

  const handleOpenCreate = () => {
    setEditingJobId(null);
    setNameInput('');
    setPatternInput('0 9 * * *');
    setPromptInput('');
    setIsModalOpen(true);
  };

  const handleOpenEdit = (job: CronJobItem) => {
    setEditingJobId(job.id);
    setNameInput(job.name);
    setPatternInput(job.pattern);
    setPromptInput(job.prompt);
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameInput.trim() || !patternInput.trim() || !promptInput.trim() || isSaving) return;
    setIsSaving(true);
    try {
      if (editingJobId && onUpdateJob) {
        await onUpdateJob({
          id: editingJobId,
          name: nameInput.trim(),
          pattern: patternInput.trim(),
          prompt: promptInput.trim(),
        });
      } else {
        await onCreateJob({
          name: nameInput.trim(),
          pattern: patternInput.trim(),
          prompt: promptInput.trim(),
        });
      }
      setNameInput('');
      setPromptInput('');
      setPatternInput('0 9 * * *');
      setEditingJobId(null);
      setIsModalOpen(false);
    } finally {
      setIsSaving(false);
    }
  };

  const applyPreset = (preset: typeof presets[0]) => {
    setEditingJobId(null);
    setNameInput(preset.title);
    setPatternInput(preset.pattern);
    setPromptInput(preset.prompt);
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 md:py-12 space-y-8 animate-fadeIn">
      {/* 顶部标题栏 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            主动巡航中心
          </h1>
          <p className="text-xs text-zinc-500 mt-1 max-w-xl leading-relaxed">
            赋予智能体按计划或周期自动触发执行的能力，支持定时巡检、情报汇总与自动交付。
          </p>
        </div>

        <button
          onClick={handleOpenCreate}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium shadow-xs transition active:scale-95 self-start sm:self-auto flex-shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>新建自主巡航</span>
        </button>
      </div>

      {/* 快速预设模板卡片 */}
      <div className="space-y-2">
        <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-amber-500" />
          推荐巡航场景
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {presets.map((preset, idx) => (
            <div
              key={idx}
              onClick={() => {
                applyPreset(preset);
                setIsModalOpen(true);
              }}
              className="p-3.5 rounded-xl border border-zinc-200/80 bg-white hover:border-zinc-300 hover:shadow-xs transition cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-zinc-800 group-hover:text-blue-600 transition">
                  {preset.title}
                </span>
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">
                  {preset.pattern}
                </span>
              </div>
              <p className="text-[11px] text-zinc-500 line-clamp-2 leading-relaxed">
                {preset.prompt}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* 巡航任务列表 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            已激活的巡航任务 ({jobs.length})
          </h2>
        </div>

        {jobs.length === 0 ? (
          <div className="py-16 text-center border border-dashed border-zinc-200 rounded-2xl bg-zinc-50/50">
            <Timer className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-zinc-600">暂无自主巡航任务</p>
            <p className="text-xs text-zinc-400 mt-1">
              点击上方“新建自主巡航”或选择推荐场景快速设置。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {jobs.map((job) => {
              const isActive = job.status === 'active';
              return (
                <div
                  key={job.id}
                  className={`p-4 rounded-xl border transition ${
                    isActive
                      ? 'border-zinc-200/80 bg-white hover:border-zinc-300 shadow-xs'
                      : 'border-zinc-200/50 bg-zinc-50/60 opacity-75'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1.5 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            isActive ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-400'
                          }`}
                        />
                        <h3 className="text-sm font-semibold text-zinc-900">{job.name}</h3>
                        <span className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700 border border-zinc-200/60">
                          {job.pattern}
                        </span>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                            isActive
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60'
                              : 'bg-zinc-100 text-zinc-500 border border-zinc-200'
                          }`}
                        >
                          {isActive ? '自动巡航中' : '已暂停'}
                        </span>
                      </div>

                      <p className="text-xs text-zinc-600 leading-relaxed bg-zinc-50/80 p-2.5 rounded-lg border border-zinc-100 font-mono text-[11px]">
                        {job.prompt}
                      </p>

                      <div className="flex flex-wrap items-center gap-4 text-[11px] text-zinc-400 pt-1">
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          <span>
                            下一次触发: {formatCronNextRun(job.pattern, job.status, job.nextRun)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          <span>已执行次数: {job.runCount} 次</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleOpenEdit(job)}
                        className="p-2 rounded-lg border border-zinc-200 hover:border-blue-200 hover:bg-blue-50 text-zinc-500 hover:text-blue-600 transition"
                        title="编辑该巡检任务"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>

                      <button
                        onClick={() => onToggleJob(job.id)}
                        className={`p-2 rounded-lg border transition text-xs font-medium flex items-center gap-1 ${
                          isActive
                            ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                            : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                        }`}
                        title={isActive ? '暂停自动巡检' : '恢复自动巡检'}
                      >
                        {isActive ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        <span className="hidden sm:inline">{isActive ? '暂停' : '启动'}</span>
                      </button>

                      <button
                        onClick={() => onDeleteJob(job.id)}
                        className="p-2 rounded-lg border border-zinc-200 hover:border-red-200 hover:bg-red-50 text-zinc-500 hover:text-red-600 transition"
                        title="删除该巡检任务"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 新建/编辑弹窗 */}
      {isModalOpen && (
        <div className="fixed top-14 inset-x-0 bottom-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 animate-fadeIn">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-zinc-200/80 p-6 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-blue-600" />
                <h3 className="font-semibold text-sm text-zinc-900">
                  {editingJobId ? '编辑自主巡航任务' : '配置自主巡航任务'}
                </h3>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-xs text-zinc-400 hover:text-zinc-600 transition"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">
                  任务名称
                </label>
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="例如: 每日 AI Agent 突破研报"
                  required
                  className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1 flex items-center justify-between">
                  <span>Cron 调度表达式</span>
                  <span className="text-[10px] text-zinc-400">标准 5 位格式 (分 时 日 月 周)</span>
                </label>
                <input
                  type="text"
                  value={patternInput}
                  onChange={(e) => setPatternInput(e.target.value)}
                  placeholder="0 9 * * *"
                  required
                  className="w-full px-3 py-2 text-xs font-mono rounded-xl border border-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px]">
                  <span
                    onClick={() => setPatternInput('0 9 * * *')}
                    className="px-2 py-0.5 rounded bg-zinc-100 hover:bg-zinc-200 cursor-pointer text-zinc-600"
                  >
                    每天 09:00
                  </span>
                  <span
                    onClick={() => setPatternInput('0 * * * *')}
                    className="px-2 py-0.5 rounded bg-zinc-100 hover:bg-zinc-200 cursor-pointer text-zinc-600"
                  >
                    每小时
                  </span>
                  <span
                    onClick={() => setPatternInput('*/30 * * * *')}
                    className="px-2 py-0.5 rounded bg-zinc-100 hover:bg-zinc-200 cursor-pointer text-zinc-600"
                  >
                    每30分钟
                  </span>
                  <span
                    onClick={() => setPatternInput('0 18 * * 1-5')}
                    className="px-2 py-0.5 rounded bg-zinc-100 hover:bg-zinc-200 cursor-pointer text-zinc-600"
                  >
                    工作日 18:00
                  </span>
                </div>
                <div className="mt-2 p-2 rounded-lg bg-zinc-50 border border-zinc-100 flex items-center justify-between text-[11px]">
                  <span className="text-zinc-500">下次预计触发:</span>
                  <span className={`font-medium ${isValidCronPattern(patternInput) ? 'text-zinc-800 font-mono' : 'text-amber-600'}`}>
                    {isValidCronPattern(patternInput)
                      ? formatCronNextRun(patternInput, 'active')
                      : '格式有误 (请输入如 0 9 * * *)'}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">
                  巡航执行指令 (派发给 Agent 的完整任务 Prompt)
                </label>
                <textarea
                  rows={4}
                  value={promptInput}
                  onChange={(e) => setPromptInput(e.target.value)}
                  placeholder="详细描述唤醒后需要 Agent 主动做的事情，例如：搜索某信息、检查状态、写入文件交付件或发送系统通知..."
                  required
                  className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-100">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3.5 py-1.5 rounded-xl border border-zinc-200 text-xs font-medium text-zinc-600 hover:bg-zinc-50 transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-4 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium shadow-xs transition disabled:opacity-50"
                >
                  {isSaving ? '保存中...' : editingJobId ? '保存修改' : '启动巡航'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
