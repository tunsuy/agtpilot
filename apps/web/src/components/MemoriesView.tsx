'use client';

import React, { useState } from 'react';
import {
  Brain,
  Plus,
  Trash2,
  Sparkles,
  BookOpen,
  Sliders,
  ShieldAlert,
  FolderGit2,
  Check,
  Search,
  X,
  RotateCw,
} from 'lucide-react';
import { MemoryItem } from '../types/agent';

interface MemoriesViewProps {
  memories: MemoryItem[];
  onAddMemory: (memory: { title: string; content: string; category: MemoryItem['category'] }) => Promise<void>;
  onDeleteMemory: (id: string) => Promise<void>;
}

export function MemoriesView({
  memories,
  onAddMemory,
  onDeleteMemory,
}: MemoriesViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [subjectFilter, setSubjectFilter] = useState<'all' | 'user' | 'agent'>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [contentInput, setContentInput] = useState('');
  const [categoryInput, setCategoryInput] = useState<MemoryItem['category']>('preference');
  const [isSaving, setIsSaving] = useState(false);

  const categories = [
    { id: 'all', label: '全部记忆', count: memories.length },
    { id: 'preference', label: '个性与偏好', count: memories.filter((m) => m.category === 'preference').length },
    { id: 'rule', label: '执行红线/规则', count: memories.filter((m) => m.category === 'rule').length },
    { id: 'project', label: '项目背景', count: memories.filter((m) => m.category === 'project').length },
    { id: 'fact', label: '关键事实', count: memories.filter((m) => m.category === 'fact').length },
  ];

  // 记忆主体分组:用户事实记忆(画像/偏好) vs Agent 经验记忆(环境/工具/流程)
  const subjects = [
    { id: 'all' as const, label: '全部记忆', count: memories.length },
    { id: 'user' as const, label: '关于我', count: memories.filter((m) => (m.subject || 'user') === 'user').length },
    { id: 'agent' as const, label: 'Agent 经验', count: memories.filter((m) => m.subject === 'agent').length },
  ];

  const filtered = memories.filter((m) => {
    const matchesSubject = subjectFilter === 'all' || (m.subject || 'user') === subjectFilter;
    const matchesCategory = activeCategory === 'all' || m.category === activeCategory;
    const matchesSearch =
      m.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.content.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSubject && matchesCategory && matchesSearch;
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!titleInput.trim() || !contentInput.trim() || isSaving) return;
    setIsSaving(true);
    try {
      await onAddMemory({
        title: titleInput.trim(),
        content: contentInput.trim(),
        category: categoryInput,
      });
      setIsModalOpen(false);
      setTitleInput('');
      setContentInput('');
      setCategoryInput('preference');
    } catch (err) {
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  const getCategoryBadge = (cat: MemoryItem['category']) => {
    switch (cat) {
      case 'preference':
        return (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-purple-50 text-purple-700 border border-purple-200">
            个人偏好
          </span>
        );
      case 'rule':
        return (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-red-50 text-red-700 border border-red-200">
            执行红线
          </span>
        );
      case 'project':
        return (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-blue-50 text-blue-700 border border-blue-200">
            项目背景
          </span>
        );
      default:
        return (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-zinc-100 text-zinc-700 border border-zinc-200">
            关键事实
          </span>
        );
    }
  };

  // 疑似过时：自动沉淀 + 从未被召回 + 存在超过 30 天（与 memory-service 的衰减判定一致）
  const isStale = (item: MemoryItem) =>
    item.source === 'auto' &&
    !item.hitCount &&
    Date.now() - (item.updatedAt || 0) > 30 * 24 * 3600 * 1000;

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 md:py-12 space-y-8 animate-fadeIn">
      {/* 头部标题 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-xl bg-purple-50 text-purple-600 border border-purple-200/60 shadow-2xs">
              <Brain className="h-5 w-5" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
              个人专属记忆与偏好中心
            </h1>
            {memories.length > 0 && (
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-zinc-100 border border-zinc-200/80 text-zinc-600">
                {memories.length} 条记忆
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-1 max-w-xl leading-relaxed">
            AgtPilot 会跨会话沉淀两类记忆：关于你的画像与偏好（工作习惯、规范、禁忌），以及 Agent 自己从任务执行中学到的环境与工具经验（踩坑教训、有效路径）。执行任务时大模型会自动加载相关记忆；任务结束后也会自动提炼维护（可随时删除）。
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium transition shadow-xs flex-shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>添加新记忆</span>
        </button>
      </div>

      {/* 记忆主体分组(用户事实记忆 / Agent 经验记忆) */}
      <div className="flex items-center gap-1.5">
        {subjects.map((s) => (
          <button
            key={s.id}
            onClick={() => setSubjectFilter(s.id)}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-medium transition flex items-center gap-1.5 ${
              subjectFilter === s.id
                ? 'bg-zinc-900 text-white shadow-xs'
                : 'bg-zinc-100 hover:bg-zinc-200/70 text-zinc-600'
            }`}
          >
            <span>{s.label}</span>
            <span
              className={`text-[10px] px-1 rounded-full ${
                subjectFilter === s.id ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-500'
              }`}
            >
              {s.count}
            </span>
          </button>
        ))}
      </div>

      {/* 搜索与分类 Chips */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCategory(c.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition flex items-center gap-1.5 ${
                activeCategory === c.id
                  ? 'bg-zinc-900 text-white shadow-xs'
                  : 'bg-zinc-100 hover:bg-zinc-200/70 text-zinc-600'
              }`}
            >
              <span>{c.label}</span>
              <span
                className={`text-[10px] px-1 rounded-full ${
                  activeCategory === c.id ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-500'
                }`}
              >
                {c.count}
              </span>
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索已记住的偏好..."
            className="w-full pl-9 pr-4 py-1.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-400 transition"
          />
        </div>
      </div>

      {/* 记忆卡片网格 */}
      {filtered.length === 0 ? (
        <div className="py-20 text-center rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/50 space-y-3">
          <div className="w-10 h-10 rounded-2xl bg-white border border-zinc-200 flex items-center justify-center mx-auto text-zinc-400 shadow-2xs">
            <Brain className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold text-zinc-700">暂无相关记忆记录</p>
            <p className="text-[11px] text-zinc-400 max-w-sm mx-auto">
              你可以手动添加一条专属偏好（例如：“回答请用极简中文”），或在与 Agent 交互中让它自主提取记住。
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((item) => (
            <div
              key={item.id}
              className="p-5 rounded-2xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-xs transition flex flex-col justify-between group"
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="text-xs font-semibold text-zinc-900 leading-snug">
                    {item.title}
                  </h3>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {isStale(item) && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 border border-amber-200">
                        疑似过时
                      </span>
                    )}
                    {item.subject === 'agent' ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-cyan-50 text-cyan-700 border border-cyan-200 flex items-center gap-0.5">
                        <Sparkles className="h-2.5 w-2.5" />
                        Agent 经验
                      </span>
                    ) : (
                      item.source === 'auto' && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-0.5">
                          <Sparkles className="h-2.5 w-2.5" />
                          自动沉淀
                        </span>
                      )
                    )}
                    {getCategoryBadge(item.category)}
                  </div>
                </div>

                <p className="text-xs text-zinc-600 leading-relaxed font-sans mt-2 whitespace-pre-wrap">
                  {item.content}
                </p>
              </div>

              <div className="pt-3 mt-4 border-t border-zinc-100 flex items-center justify-between text-[10px] text-zinc-400">
                <span className="font-mono">
                  {new Date(item.updatedAt).toLocaleDateString()}
                  {item.hitCount !== undefined && ` · 命中 ${item.hitCount} 次`}
                </span>

                <button
                  onClick={() => onDeleteMemory(item.id)}
                  className="opacity-0 group-hover:opacity-100 transition p-1 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-md"
                  title="删除该记忆"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 新增记忆弹窗 Modal */}
      {isModalOpen && (
        <div className="fixed top-14 inset-x-0 bottom-0 bg-black/30 backdrop-blur-xs z-40 flex items-center justify-center p-4 animate-fadeIn">
          <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">
                  为 AgtPilot 注入个人新记忆
                </h3>
                <p className="text-xs text-zinc-500 mt-0.5">
                  沉淀后的偏好将跨任务永久生效，指导 Agent 的思考与行动准则。
                </p>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-700 p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-700 block">
                  记忆分类
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'preference', label: '个人偏好 (如代码/回复习惯)' },
                    { id: 'rule', label: '执行红线 (严格禁止的操作)' },
                    { id: 'project', label: '项目背景 (技术栈与依赖习惯)' },
                    { id: 'fact', label: '关键事实 (业务账号或环境)' },
                  ].map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setCategoryInput(cat.id as any)}
                      className={`p-2 rounded-xl border text-left text-xs transition ${
                        categoryInput === cat.id
                          ? 'border-zinc-900 bg-zinc-900 text-white font-medium shadow-2xs'
                          : 'border-zinc-200 hover:bg-zinc-50 text-zinc-700'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-700 block">
                  简明标题
                </label>
                <input
                  type="text"
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  placeholder="例如: 拒绝未经审批的 git push 推送"
                  required
                  autoFocus
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-700 block">
                  详细规范与偏好内容
                </label>
                <textarea
                  rows={4}
                  value={contentInput}
                  onChange={(e) => setContentInput(e.target.value)}
                  placeholder="例如: 当进行任何代码修改时，永远不要主动推送远程仓库，除非我明确发出推送指令；执行完毕后请提供完整代码审计。"
                  required
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500 leading-relaxed resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-100">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!titleInput.trim() || !contentInput.trim() || isSaving}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-medium transition shadow-xs"
                >
                  {isSaving && <RotateCw className="h-3.5 w-3.5 animate-spin" />}
                  <span>固化记忆</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
