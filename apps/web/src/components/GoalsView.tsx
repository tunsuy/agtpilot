'use client';

import React, { useState } from 'react';
import {
  Target,
  Plus,
  Sparkles,
  Calendar,
  CheckCircle2,
  Circle,
  Play,
  Trash2,
  Pencil,
  ChevronDown,
  ChevronUp,
  Search,
  Trophy,
  Flame,
  ArrowRight,
  Clock,
  Flag,
  Loader2,
  AlertCircle,
  Layers,
} from 'lucide-react';
import { GoalItem, GoalMilestone } from '../types/agent';

interface GoalsViewProps {
  goals: GoalItem[];
  onCreateGoal: (goal: {
    title: string;
    description: string;
    category?: GoalItem['category'];
    targetDate?: string;
    milestones: Array<{ title: string; description?: string; status?: GoalMilestone['status'] }>;
  }) => Promise<void>;
  onUpdateGoal?: (goal: {
    id: string;
    title?: string;
    description?: string;
    category?: GoalItem['category'];
    targetDate?: string;
    status?: GoalItem['status'];
    milestones?: GoalMilestone[];
  }) => Promise<void>;
  onDeleteGoal: (id: string) => Promise<void>;
  onToggleMilestone: (goalId: string, milestoneId: string, status?: GoalMilestone['status']) => Promise<void>;
  onAdvanceMilestone: (goal: GoalItem, milestone: GoalMilestone) => void;
}

const CATEGORY_MAP: Record<string, { label: string; color: string; bg: string }> = {
  engineering: { label: '技术工程', color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
  learning: { label: '学习成长', color: 'text-purple-700', bg: 'bg-purple-50 border-purple-200' },
  career: { label: '职业发展', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
  efficiency: { label: '效能提升', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
  finance: { label: '财务规划', color: 'text-cyan-700', bg: 'bg-cyan-50 border-cyan-200' },
  custom: { label: '自定义', color: 'text-zinc-700', bg: 'bg-zinc-100 border-zinc-200' },
};

const PRESETS = [
  {
    title: '从零构建企业级 AI Agent 架构体系',
    category: 'engineering' as const,
    description: '深入掌握多智能体协作、长期记忆索引、工具沙箱调用及自主巡航机制，沉淀一套高扩展可投产的个人与团队智能体底座。',
    milestones: [
      { title: '阶段 1：调研并确立智能体核心架构规范与生命周期状态机', description: '梳理感知、规划、工具调用、记忆回写四步闭环模型，设计统一事件流' },
      { title: '阶段 2：完成长效记忆（RAG + 会话上下文）与多工具挂载能力', description: '集成向量知识库与本地执行沙箱，实现精准上下文注入与意图路由' },
      { title: '阶段 3：构建主动巡航与定时守护机制，打通自动化闭环', description: '支持 Cron 表达式调度，实现无人值守的后台巡检与结构化成果产出' },
      { title: '阶段 4：端到端综合压测与实战场景落地复盘', description: '接入真实业务场景，优化延迟与调用成本，输出完整架构文档与代码仓' },
    ],
  },
  {
    title: '3 个月攻克 Rust 系统级编程与高性能引擎',
    category: 'learning' as const,
    description: '通过理论结合实战项目，掌握所有权、生命周期、并发与 Unsafe Rust，完成一个高性能命令行搜索引擎或存储引擎。',
    milestones: [
      { title: '阶段 1：通读 Rust 官方教程与所有权核心机制攻坚', description: '深入理解借用检查器、生命周期标注、模式匹配与智能指针' },
      { title: '阶段 2：实战开发一个高性能本地文本/代码全文检索引擎', description: '实现倒排索引、内存映射文件与多线程并行查询' },
      { title: '阶段 3：深入异步并发（Tokio）与 FFI 跨语言调用', description: '实现高吞吐异步网络服务，沉淀个人开源库与性能基准评测报告' },
    ],
  },
  {
    title: '打造个人被动生产力与全自动数字资产工作流',
    category: 'efficiency' as const,
    description: '让 AI 智能体全面接管日常信息抓取、文献跟踪、晨报汇编及定期归档，每天释放 2 小时专注时间。',
    milestones: [
      { title: '阶段 1：梳理每日重复性信息流输入与输出触点', description: '列出早报、GitHub Trending、技术博客与项目周报的具体规则' },
      { title: '阶段 2：配置对应的主动巡航任务与沉浸式交付物生成', description: '定制定时 Prompt，验证生成质量并自动归档至 Deliverables 画布' },
      { title: '阶段 3：持续调优记忆库与个人偏好，实现免干预自主护航', description: '将个人关注关键词和过滤标准固化到长效记忆库' },
    ],
  },
  {
    title: '自媒体与数字内容资产增长全自动化运营',
    category: 'career' as const,
    description: '通过智能体全流程协同：对标账号拆解、高频热点选题感知、3:4 图文切片卡片渲染、人机协同审核与互动复盘。',
    milestones: [
      { title: '阶段 1：对标账号拆解与个人差异化人设定位沉淀', description: '抓取垂类 TOP 10 对标账号，提炼爆款标题公式、视觉调性，并固化至记忆库' },
      { title: '阶段 2：搭建高频选题库并跑通 3:4 爆款图文卡片生成', description: '每日巡航热搜选题，自动化输出多平台格式文案、首图大字报与干货切片卡片' },
      { title: '阶段 3：建立发布门禁流水线与每周互动数据复盘反思', description: '通过人机协同审批确认发布，监控点赞收藏比，自进化迭代高转化选题模型' },
    ],
  },
];

export function GoalsView({
  goals = [],
  onCreateGoal,
  onUpdateGoal,
  onDeleteGoal,
  onToggleMilestone,
  onAdvanceMilestone,
}: GoalsViewProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedGoals, setExpandedGoals] = useState<Record<string, boolean>>({});
  const [showPresets, setShowPresets] = useState(false);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [titleInput, setTitleInput] = useState('');
  const [descInput, setDescInput] = useState('');
  const [categoryInput, setCategoryInput] = useState<GoalItem['category']>('engineering');
  const [targetDateInput, setTargetDateInput] = useState('');
  const [milestonesInput, setMilestonesInput] = useState<Array<{ id?: string; title: string; description: string; status?: GoalMilestone['status'] }>>([
    { title: '阶段 1：调研规划与初步路径确立', description: '' },
    { title: '阶段 2：核心攻坚与最小可用成果交付', description: '' },
    { title: '阶段 3：成果落地、验收与长期固化', description: '' },
  ]);
  const [isDecomposing, setIsDecomposing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // 统计指标
  const totalGoals = goals.length;
  const completedGoals = goals.filter((g) => g.status === 'completed' || g.progress === 100).length;
  const activeGoals = totalGoals - completedGoals;
  const totalMilestones = goals.reduce((acc, g) => acc + (g.milestones?.length || 0), 0);
  const completedMilestones = goals.reduce(
    (acc, g) => acc + (g.milestones?.filter((m) => m.status === 'completed').length || 0),
    0
  );
  const overallMilestoneRate = totalMilestones > 0 ? Math.round((completedMilestones / totalMilestones) * 100) : 0;

  // 过滤展示
  const filteredGoals = goals.filter((goal) => {
    if (selectedCategory !== 'all' && goal.category !== selectedCategory) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = goal.title.toLowerCase().includes(q);
      const matchDesc = goal.description?.toLowerCase().includes(q);
      const matchMs = goal.milestones?.some(
        (m) => m.title.toLowerCase().includes(q) || m.description?.toLowerCase().includes(q)
      );
      if (!matchTitle && !matchDesc && !matchMs) return false;
    }
    return true;
  });

  // 智能折叠：仅有 1 个目标时默认展开，多个目标时默认收起以防止页面过长
  const isExpanded = (id: string) => {
    if (expandedGoals[id] !== undefined) return expandedGoals[id];
    return goals.length <= 1;
  };

  const toggleExpand = (id: string) => {
    setExpandedGoals((prev) => ({
      ...prev,
      [id]: !isExpanded(id),
    }));
  };

  const handleToggleAllExpand = () => {
    const anyExpanded = filteredGoals.some((g) => isExpanded(g.id));
    const nextState: Record<string, boolean> = {};
    filteredGoals.forEach((g) => {
      nextState[g.id] = !anyExpanded;
    });
    setExpandedGoals(nextState);
  };

  const handleOpenCreate = () => {
    setEditingGoalId(null);
    setTitleInput('');
    setDescInput('');
    setCategoryInput('engineering');
    setTargetDateInput('');
    setMilestonesInput([
      { title: '阶段 1：调研规划与初步路径确立', description: '' },
      { title: '阶段 2：核心攻坚与最小可用成果交付', description: '' },
      { title: '阶段 3：成果落地、验收与长期固化', description: '' },
    ]);
    setIsModalOpen(true);
  };

  const handleApplyPreset = (preset: typeof PRESETS[0]) => {
    setEditingGoalId(null);
    setTitleInput(preset.title);
    setDescInput(preset.description);
    setCategoryInput(preset.category);
    setMilestonesInput(
      preset.milestones.map((m) => ({
        title: m.title,
        description: m.description,
      }))
    );
    setIsModalOpen(true);
  };

  const handleOpenEdit = (goal: GoalItem) => {
    setEditingGoalId(goal.id);
    setTitleInput(goal.title);
    setDescInput(goal.description || '');
    setCategoryInput(goal.category || 'engineering');
    setTargetDateInput(goal.targetDate || '');
    setMilestonesInput(
      (goal.milestones || []).map((m) => ({
        id: m.id,
        title: m.title,
        description: m.description || '',
        status: m.status,
      }))
    );
    setIsModalOpen(true);
  };

  // AI 智能拆解
  const handleAIDecompose = async () => {
    if (!titleInput.trim()) {
      alert('请先输入长期目标的标题或大致愿景，AI 将为您拆解里程碑。');
      return;
    }
    setIsDecomposing(true);
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'decompose',
          title: titleInput.trim(),
          description: descInput.trim(),
        }),
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.milestones)) {
        setMilestonesInput(
          data.milestones.map((m: any) => ({
            title: m.title,
            description: m.description || '',
          }))
        );
      } else {
        alert(data.error || 'AI 拆解失败，请检查网络或配置');
      }
    } catch (e: any) {
      console.error(e);
      alert('AI 拆解失败: ' + e.message);
    } finally {
      setIsDecomposing(false);
    }
  };

  const handleAddMilestoneField = () => {
    setMilestonesInput((prev) => [
      ...prev,
      { title: `阶段 ${prev.length + 1}：`, description: '' },
    ]);
  };

  const handleRemoveMilestoneField = (index: number) => {
    setMilestonesInput((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleSaveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!titleInput.trim() || isSaving) return;

    const validMilestones = milestonesInput
      .filter((m) => m.title.trim().length > 0)
      .map((m, idx) => ({
        id: m.id,
        title: m.title.trim(),
        description: m.description?.trim() || '',
        status: m.status || (idx === 0 ? 'in_progress' : 'pending'),
      }));

    setIsSaving(true);
    try {
      if (editingGoalId && onUpdateGoal) {
        await onUpdateGoal({
          id: editingGoalId,
          title: titleInput.trim(),
          description: descInput.trim(),
          category: categoryInput,
          targetDate: targetDateInput.trim(),
          milestones: validMilestones as GoalMilestone[],
        });
      } else {
        await onCreateGoal({
          title: titleInput.trim(),
          description: descInput.trim(),
          category: categoryInput,
          targetDate: targetDateInput.trim(),
          milestones: validMilestones,
        });
      }
      setIsModalOpen(false);
    } catch (err: any) {
      console.error(err);
      alert('保存失败: ' + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 md:py-12 space-y-8 animate-fadeIn">
      {/* 顶部标题区 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-xl bg-rose-50 text-rose-600 border border-rose-200/60 shadow-2xs">
              <Target className="h-5 w-5" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
              长期目标与里程碑
            </h1>
            {totalGoals > 0 && (
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-zinc-100 border border-zinc-200/80 text-zinc-600">
                {completedGoals}/{totalGoals} 达成
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-1 max-w-xl leading-relaxed">
            为个人超级智能体注入灵魂——围绕你的核心愿景进行科学拆解、持续协同推进与长期成果沉淀。
          </p>
        </div>

        <button
          onClick={handleOpenCreate}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium shadow-xs transition active:scale-95 self-start sm:self-auto flex-shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>设定新目标</span>
        </button>
      </div>

      {/* 推荐目标愿景场景（已有目标时默认收纳为轻量抽屉，无目标时直接展示，避免撑高页面） */}
      {goals.length > 0 ? (
        <div className="rounded-xl border border-zinc-200/60 bg-zinc-50/50 overflow-hidden">
          <button
            onClick={() => setShowPresets(!showPresets)}
            className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium text-zinc-600 hover:text-zinc-900 transition"
          >
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-amber-500" />
              <span>探索推荐目标模板 ({PRESETS.length} 组预设)</span>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-zinc-400">
              <span>{showPresets ? '收起推荐' : '展开查看'}</span>
              {showPresets ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </div>
          </button>

          {showPresets && (
            <div className="p-3 pt-0 border-t border-zinc-200/50 bg-white/60">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2.5">
                {PRESETS.map((preset, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleApplyPreset(preset)}
                    className="p-3 rounded-lg border border-zinc-200/80 bg-white hover:border-rose-200 hover:bg-rose-50/20 hover:shadow-2xs transition cursor-pointer group flex flex-col justify-between space-y-2"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-zinc-800 group-hover:text-rose-600 transition truncate pr-1">
                          {preset.title}
                        </span>
                        <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 flex-shrink-0">
                          {CATEGORY_MAP[preset.category]?.label || '预设'}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500 line-clamp-2 leading-relaxed">
                        {preset.description}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 text-[10px] font-medium text-zinc-600 group-hover:text-rose-600 pt-1.5 border-t border-zinc-100">
                      <span>应用此模板</span>
                      <ArrowRight className="h-3 w-3 group-hover:translate-x-0.5 transition" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* 搜索与分类 Chips（与记忆库/连接器保持统一） */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition flex items-center gap-1.5 ${
              selectedCategory === 'all'
                ? 'bg-zinc-900 text-white shadow-xs'
                : 'bg-zinc-100 hover:bg-zinc-200/70 text-zinc-600'
            }`}
          >
            <span>全部目标</span>
            <span className="opacity-75 font-mono text-[11px]">({totalGoals})</span>
          </button>
          {Object.entries(CATEGORY_MAP).map(([catKey, info]) => {
            const count = goals.filter((g) => g.category === catKey).length;
            if (count === 0 && selectedCategory !== catKey) return null;
            return (
              <button
                key={catKey}
                onClick={() => setSelectedCategory(catKey)}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition flex items-center gap-1.5 ${
                  selectedCategory === catKey
                    ? 'bg-zinc-900 text-white shadow-xs'
                    : 'bg-zinc-100 hover:bg-zinc-200/70 text-zinc-600'
                }`}
              >
                <span>{info.label}</span>
                <span className="opacity-75 font-mono text-[11px]">({count})</span>
              </button>
            );
          })}
        </div>

        <div className="relative w-full sm:w-64 flex-shrink-0">
          <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索目标或里程碑..."
            className="w-full pl-9 pr-3 py-1.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 focus:border-zinc-400 transition"
          />
        </div>
      </div>

      {/* 目标卡片列表 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              进行中的长期目标 ({filteredGoals.length})
            </h2>
            {filteredGoals.length > 1 && (
              <button
                onClick={handleToggleAllExpand}
                className="text-[11px] text-zinc-400 hover:text-zinc-700 underline underline-offset-2 transition"
              >
                {filteredGoals.some((g) => isExpanded(g.id)) ? '全部折叠' : '全部展开'}
              </button>
            )}
          </div>
          {totalMilestones > 0 && (
            <span className="text-xs text-zinc-400 font-mono">
              里程碑达成率: {overallMilestoneRate}%
            </span>
          )}
        </div>
      {filteredGoals.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-200 bg-white p-10 text-center space-y-6">
          <div className="max-w-md mx-auto space-y-2">
            <div className="h-12 w-12 rounded-2xl bg-rose-50 text-rose-500 flex items-center justify-center mx-auto shadow-2xs">
              <Target className="h-6 w-6" />
            </div>
            <h3 className="text-sm font-semibold text-zinc-900">
              {goals.length === 0 ? '尚未制定长期目标' : '未找到匹配的目标'}
            </h3>
            <p className="text-xs text-zinc-500 leading-relaxed">
              个人超级智能体的核心价值是帮你达成长期重要目标。你可以自行设定，或点击下方模板快速开启：
            </p>
          </div>

          {goals.length === 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-left max-w-2xl mx-auto">
              {PRESETS.map((preset, i) => (
                <div
                  key={i}
                  onClick={() => handleApplyPreset(preset)}
                  className="p-4 rounded-xl border border-zinc-200/80 bg-zinc-50/50 hover:bg-rose-50/30 hover:border-rose-300 cursor-pointer transition group flex flex-col justify-between space-y-3"
                >
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-white border border-zinc-200 text-zinc-600">
                      {CATEGORY_MAP[preset.category]?.label || '预设'}
                    </span>
                    <h4 className="text-xs font-semibold text-zinc-800 group-hover:text-rose-600 transition line-clamp-1">
                      {preset.title}
                    </h4>
                    <p className="text-[11px] text-zinc-500 line-clamp-2 leading-relaxed">
                      {preset.description}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 text-[11px] font-medium text-rose-600 pt-1 border-t border-zinc-200/50">
                    <span>使用此模板并设定</span>
                    <ArrowRight className="h-3 w-3 group-hover:translate-x-0.5 transition" />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div>
            <button
              onClick={handleOpenCreate}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium transition"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>新建自定义目标</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredGoals.map((goal) => {
            const categoryMeta = CATEGORY_MAP[goal.category || 'engineering'] || CATEGORY_MAP.custom;
            const expanded = isExpanded(goal.id);
            const totalMs = goal.milestones?.length || 0;
            const completedMs = goal.milestones?.filter((m) => m.status === 'completed').length || 0;
            const isFullyCompleted = goal.status === 'completed' || goal.progress === 100;

            return (
              <div
                key={goal.id}
                className={`rounded-2xl border transition shadow-2xs overflow-hidden ${
                  isFullyCompleted
                    ? 'bg-white border-emerald-200/80'
                    : 'bg-white border-zinc-200/80 hover:border-zinc-300'
                }`}
              >
                {/* 目标卡片头部 */}
                <div className="p-5 md:p-6 space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1.5 flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${categoryMeta.bg} ${categoryMeta.color}`}
                        >
                          {categoryMeta.label}
                        </span>

                        {goal.targetDate && (
                          <span className="flex items-center gap-1 text-[11px] text-zinc-500 font-mono">
                            <Calendar className="h-3 w-3 text-zinc-400" />
                            <span>目标期: {goal.targetDate}</span>
                          </span>
                        )}

                        {isFullyCompleted ? (
                          <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <Trophy className="h-3 w-3 text-amber-500" />
                            <span>全里程碑已达成</span>
                          </span>
                        ) : (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
                            推进中
                          </span>
                        )}
                      </div>

                      <h2 className="text-base font-bold text-zinc-900 tracking-tight leading-snug">
                        {goal.title}
                      </h2>

                      {goal.description && (
                        <p className="text-xs text-zinc-600 leading-relaxed max-w-3xl">
                          {goal.description}
                        </p>
                      )}
                    </div>

                    {/* 右侧操作按钮 */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleOpenEdit(goal)}
                        className="p-1.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded-lg transition"
                        title="编辑目标与里程碑"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`确定要删除目标【${goal.title}】吗？`)) {
                            onDeleteGoal(goal.id);
                          }
                        }}
                        className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                        title="删除目标"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => toggleExpand(goal.id)}
                        className="p-1.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded-lg transition"
                        title={expanded ? '收起里程碑' : '展开里程碑'}
                      >
                        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  {/* 进度条与完成比例 */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-zinc-600 flex items-center gap-1.5">
                        <Flag className="h-3.5 w-3.5 text-zinc-400" />
                        <span>里程碑交付进度</span>
                        <span className="text-zinc-400 font-mono text-[11px]">
                          ({completedMs}/{totalMs})
                        </span>
                      </span>
                      <span className="font-bold text-zinc-900 font-mono">{goal.progress}%</span>
                    </div>

                    <div className="w-full bg-zinc-100 rounded-full h-2 overflow-hidden">
                      <div
                        className={`h-2 rounded-full transition-all duration-500 ${
                          isFullyCompleted
                            ? 'bg-emerald-500'
                            : 'bg-gradient-to-r from-rose-500 to-pink-500'
                        }`}
                        style={{ width: `${goal.progress}%` }}
                      />
                    </div>
                  </div>

                  {/* 折叠状态下的当前推进阶段概览（紧凑防撑高，同时支持快速推进） */}
                  {!expanded && totalMs > 0 && (
                    <div className="pt-2 border-t border-zinc-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                      {(() => {
                        const nextMs = goal.milestones.find((m) => m.status !== 'completed');
                        if (!nextMs) {
                          return (
                            <span className="text-[11px] text-emerald-600 flex items-center gap-1 font-medium">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              <span>全部阶段已顺利达成</span>
                            </span>
                          );
                        }
                        return (
                          <>
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 flex-shrink-0">
                                当前攻坚
                              </span>
                              <span className="font-medium text-zinc-700 truncate text-[11px]">
                                {nextMs.title}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <button
                                onClick={() => onAdvanceMilestone(goal, nextMs)}
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-600 hover:text-rose-700 transition"
                              >
                                <Sparkles className="h-3 w-3" />
                                <span>推进此阶段</span>
                              </button>
                              <span className="text-zinc-300">·</span>
                              <button
                                onClick={() => toggleExpand(goal.id)}
                                className="text-[11px] text-zinc-400 hover:text-zinc-600 transition"
                              >
                                查看全部 {totalMs} 个阶段
                              </button>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>

                {/* 里程碑详细路线图展开区 */}
                {expanded && (
                  <div className="border-t border-zinc-100 bg-zinc-50/50 p-5 md:p-6 space-y-3">
                    <div className="flex items-center justify-between pb-1">
                      <h4 className="text-xs font-semibold text-zinc-700 flex items-center gap-1.5">
                        <Layers className="h-3.5 w-3.5 text-zinc-500" />
                        <span>阶段性里程碑路径</span>
                      </h4>
                      <span className="text-[11px] text-zinc-400">
                        点击右侧“推进此里程碑”即可呼唤智能体执行专项任务
                      </span>
                    </div>

                    {totalMs === 0 ? (
                      <p className="text-xs text-zinc-400 py-3 text-center">暂无里程碑，请点击右上角编辑进行添加或 AI 拆解</p>
                    ) : (
                      <div className="space-y-2.5">
                        {goal.milestones.map((ms, idx) => {
                          const isDone = ms.status === 'completed';
                          const isInProgress = ms.status === 'in_progress';

                          return (
                            <div
                              key={ms.id || idx}
                              className={`p-3.5 rounded-xl border transition flex flex-col md:flex-row md:items-center justify-between gap-3 ${
                                isDone
                                  ? 'bg-white/80 border-zinc-200/80 text-zinc-400'
                                  : isInProgress
                                  ? 'bg-white border-rose-200 shadow-2xs'
                                  : 'bg-white border-zinc-200/70'
                              }`}
                            >
                              {/* 里程碑左侧状态勾选 & 内容 */}
                              <div className="flex items-start gap-3 flex-1 min-w-0">
                                <button
                                  onClick={() => onToggleMilestone(goal.id, ms.id)}
                                  className="mt-0.5 text-zinc-400 hover:text-emerald-600 transition flex-shrink-0"
                                  title={isDone ? '标记为未完成' : '标记为已达成'}
                                >
                                  {isDone ? (
                                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                  ) : (
                                    <Circle className="h-4 w-4 text-zinc-300 hover:text-zinc-500" />
                                  )}
                                </button>

                                <div className="space-y-0.5 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`text-xs font-semibold ${
                                        isDone ? 'line-through text-zinc-400' : 'text-zinc-900'
                                      }`}
                                    >
                                      {ms.title}
                                    </span>
                                    {isInProgress && !isDone && (
                                      <span className="text-[9px] font-semibold px-1.5 py-0.2 rounded bg-rose-50 text-rose-600 border border-rose-200">
                                        进行中
                                      </span>
                                    )}
                                    {isDone && ms.completedAt && (
                                      <span className="text-[10px] text-zinc-400 font-mono">
                                        已于 {new Date(ms.completedAt).toLocaleDateString()} 达成
                                      </span>
                                    )}
                                  </div>

                                  {ms.description && (
                                    <p
                                      className={`text-[11px] leading-relaxed ${
                                        isDone ? 'text-zinc-400' : 'text-zinc-500'
                                      }`}
                                    >
                                      {ms.description}
                                    </p>
                                  )}
                                </div>
                              </div>

                              {/* 右侧：推进与执行按钮 */}
                              <div className="flex items-center gap-2 flex-shrink-0 self-end md:self-auto">
                                {!isDone ? (
                                  <button
                                    onClick={() => onAdvanceMilestone(goal, ms)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white text-[11px] font-medium shadow-2xs transition active:scale-[0.98]"
                                    title="在驾驶舱唤醒智能体执行此阶段攻坚任务"
                                  >
                                    <Sparkles className="h-3 w-3 text-amber-300" />
                                    <span>推进此里程碑</span>
                                    <ArrowRight className="h-3 w-3" />
                                  </button>
                                ) : (
                                  <span className="text-[11px] text-emerald-600 font-medium px-2 py-1 bg-emerald-50 rounded-lg">
                                    已达成
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </div>

      {/* 创建 / 编辑目标弹窗 */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fadeIn">
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-scaleIn">
            <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Target className="h-5 w-5 text-rose-500" />
                <h3 className="text-sm font-bold text-zinc-900">
                  {editingGoalId ? '编辑长期目标' : '设定新的长期目标'}
                </h3>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-700 text-lg leading-none"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleSaveSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* 标题 */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-700">目标愿景标题 *</label>
                <input
                  type="text"
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  placeholder="如：从零构建千万级架构系统、3个月攻克 Rust、打造全自动数字资产..."
                  required
                  className="w-full px-3.5 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-400"
                />
              </div>

              {/* 类别与目标期 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-700">所属领域分类</label>
                  <select
                    value={categoryInput}
                    onChange={(e) => setCategoryInput(e.target.value as any)}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-800 focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-400"
                  >
                    {Object.entries(CATEGORY_MAP).map(([k, info]) => (
                      <option key={k} value={k}>
                        {info.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-700">预期达成时间 (可选)</label>
                  <input
                    type="text"
                    value={targetDateInput}
                    onChange={(e) => setTargetDateInput(e.target.value)}
                    placeholder="如：2026年Q4、3个月内、本年度"
                    className="w-full px-3.5 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-400"
                  />
                </div>
              </div>

              {/* 详细描述 */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-700">目标详细背景与指标说明</label>
                <textarea
                  value={descInput}
                  onChange={(e) => setDescInput(e.target.value)}
                  placeholder="详细描述该目标的交付衡量标准、核心期望以及你面临的当前现状..."
                  rows={3}
                  className="w-full px-3.5 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-400"
                />
              </div>

              {/* 里程碑拆解区 */}
              <div className="space-y-3 pt-2 border-t border-zinc-100">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs font-semibold text-zinc-800 flex items-center gap-1.5">
                      <Flag className="h-3.5 w-3.5 text-rose-500" />
                      <span>阶段性里程碑拆解</span>
                    </label>
                    <p className="text-[11px] text-zinc-400">
                      科学的目标需细化为 3 至 4 个可闭环的阶段性成果
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleAIDecompose}
                    disabled={isDecomposing}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 text-xs font-medium transition disabled:opacity-50"
                  >
                    {isDecomposing ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>AI 智能拆解中...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5 text-rose-600" />
                        <span>AI 一键智能拆解</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="space-y-2.5">
                  {milestonesInput.map((m, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-xl border border-zinc-200 bg-zinc-50/60 space-y-2 relative group"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono font-bold text-zinc-400 px-1.5 py-0.5 rounded bg-zinc-200">
                          #{idx + 1}
                        </span>
                        <input
                          type="text"
                          value={m.title}
                          onChange={(e) => {
                            const val = e.target.value;
                            setMilestonesInput((prev) =>
                              prev.map((item, i) => (i === idx ? { ...item, title: val } : item))
                            );
                          }}
                          placeholder={`阶段 ${idx + 1} 名称`}
                          className="flex-1 px-2.5 py-1 rounded-lg border border-zinc-200 bg-white text-xs text-zinc-900 focus:outline-none focus:ring-1 focus:ring-rose-500"
                        />
                        {milestonesInput.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveMilestoneField(idx)}
                            className="p-1 text-zinc-400 hover:text-rose-600 transition"
                            title="删除此阶段"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>

                      <input
                        type="text"
                        value={m.description}
                        onChange={(e) => {
                          const val = e.target.value;
                          setMilestonesInput((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, description: val } : item))
                          );
                        }}
                        placeholder="阶段交付成果或关键行动指标（可选）"
                        className="w-full px-2.5 py-1 rounded-lg border border-zinc-200 bg-white text-[11px] text-zinc-600 focus:outline-none focus:ring-1 focus:ring-rose-500"
                      />
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={handleAddMilestoneField}
                  className="w-full py-1.5 border border-dashed border-zinc-300 rounded-xl text-xs text-zinc-600 hover:text-zinc-900 hover:border-zinc-400 hover:bg-zinc-50 transition flex items-center justify-center gap-1"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>添加下一个阶段</span>
                </button>
              </div>

              {/* 弹窗底部操作 */}
              <div className="pt-4 border-t border-zinc-100 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-zinc-200 text-xs font-medium text-zinc-600 hover:bg-zinc-50 transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-semibold shadow-sm transition active:scale-[0.98] disabled:opacity-50"
                >
                  {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  <span>{editingGoalId ? '保存修改' : '确认制定'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
