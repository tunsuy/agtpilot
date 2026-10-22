'use client';

/**
 * 移动端「动态」tab 对话态:把 mission.steps 渲染成聊天流(读路径)。
 *
 * 照桌面 CockpitView 对话流(L836-1570)移植 —— 数据管线原样复用纯函数
 * (lib/cockpit-blocks 分块/轮次分组/折叠边界,不另写映射),呈现层做移动
 * 简化:
 * - 文档级滚动跟随(本 tab 现行模式,无内部滚动容器,window 贴底判定);
 * - 去掉:hover 复制按钮(原生长按覆盖)、KanbanPlanCard 钉挂(动态态卡
 *   头已有 mission.plan)、BackgroundChildPanel inline 展开
 *   (launch_background_task 行按普通工具行渲染,收尾仍走 notice 卡)、
 *   effNotes、用户头像;
 * - 其余与桌面同逻辑:排队气泡 / 轮首标记 + 左竖轨 / 「任务过程」折叠 /
 *   思考折叠 / 流式 shimmer / 答案渲染优先链(选题→novel→开源→文章→
 *   笔记→markdown)/ 内联角标与来源药丸 / FAILED 部分输出 + 重新生成 /
 *   后台子任务通知卡 / novel 渐进交付卡钉挂 / 「正在衔接下一步…」;
 * - 终态会话 wire 下发被 strip:loading 态等懒回水回填(发消息续聊不受
 *   影响,服务端读自己的存储,不依赖客户端 steps 副本)。
 * 硬约束:桌面 CockpitView 与后端零改动 —— 相似 JSX 移动端自维护,数据
 * 管线全共享。可测逻辑在 lib/mobile-chat.ts(vitest node 环境,组件渲染
 * 测试归 e2e)。
 */
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import {
  AlertCircle,
  ArrowDown,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Code,
  Globe,
  Layers,
  Loader2,
  RotateCw,
  Search,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { NotePackageList } from '../workshops/NotePackageCard';
import { parseNotePackages } from '../../workshops/xhs/note-package';
import { ArticlePackageList } from '../workshops/ArticlePackageCard';
import { parseArticlePackages } from '../../workshops/shared/article-package';
import { buildDraftDeliveryIndex } from '../../lib/draft-delivery';
import { TopicPickList } from '../workshops/TopicPickCard';
import { parseTopicPicks } from '../../workshops/xhs/topic-picks';
import { OssOpportunityList } from '../workshops/OssOpportunityCard';
import { parseOssOpportunities } from '../../workshops/oss_radar/opportunities';
import { NovelPackageCard, type NovelChainHandler } from '../workshops/NovelPackageCard';
import { parseNovelPackage, assembleNovelDelivery } from '../../workshops/novel/novel-package';
import { resolveDeliveryContract } from '../../workshops/novel/delivery';
import { collectWorkshopDeliveries } from '../../lib/workshop-delivery-view';
import { deliveredFieldsFromSteps, DELIVER_FIELD_TOOL } from '../../lib/workshop-delivery';
import { hasWorkshopDeliverable } from '../../workshops/deliverable';
import { resolveArtifactDraft } from '../../workshops/registry';
import {
  splitStepsIntoBlocks,
  groupBlocksIntoTurns,
  findRetryPrompt,
  findFinalAnswerIndex,
  type CockpitBlock,
} from '../../lib/cockpit-blocks';
import { sourcesForAnswer } from '../../lib/search-sources';
import { narrateStep, formatActivityDuration } from '../../lib/activity-narration';
import { chatAvailability, summarizeProcessBlocks } from '../../lib/mobile-chat';
import type { Mission } from '../../types/agent';

/**
 * 跳动的已耗时徽标(桌面 CockpitView 同款未导出,零桌面改动约束下本地
 * 复制):<60s 显示秒,超 1 分钟显示 m+s。叶子组件自持 1s 定时器,只重渲染
 * 自身 —— 慢模型首 token 前的长静默窗口持续有数字变化,不再「看似卡死」。
 */
function ElapsedTick({
  startedAt,
  className,
}: {
  startedAt?: number;
  className?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  const total = Math.floor(Math.max(0, now - startedAt) / 1000);
  return (
    <span className={className || 'font-mono'}>
      {total < 60 ? `${total}s` : `${Math.floor(total / 60)}m${total % 60}s`}
    </span>
  );
}

interface MobileConversationViewProps {
  mission: Mission;
  /** 回复出口:FAILED 重新生成 + 选题/文章/笔记卡续聊(勾选成稿/存草稿)。
   *  未提供时选题/文章分支跳过、落 markdown(动态态回复入口已由问题卡/
   *  审批/选题卡承担,避免双路径)。 */
  onRunMission?: (prompt: string, title?: string, missionId?: string) => void;
  /** notice 子任务卡「查看子任务」跳转 */
  onSelectMission: (id: string) => void;
  /** 小说包「下一步」出口(开书三段化串联):工坊载荷走服务端权威渲染,
   *  prompt 只作乐观气泡展示。不传则链式按钮不出现。 */
  onRunNovelChain?: NovelChainHandler;
  /** 发送新消息后父组件 +1:对话流重置贴底,跟随新一轮输出 */
  followToken?: number;
}

export function MobileConversationView({
  mission,
  onRunMission,
  onSelectMission,
  onRunNovelChain,
  followToken = 0,
}: MobileConversationViewProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // 小红书/知乎托管写操作状态(连接器页 opt-in):笔记包/文章包「存草稿箱」
  // 按钮的前提。判定与 xhs-managed 的 shouldInjectWriteTool 同规则
  // (enabled + riskAckAt)—— 照抄桌面两个 fetch effect,存草稿功能不缩水
  const [xhsDraftEnabled, setXhsDraftEnabled] = useState(false);
  const [zhihuDraftEnabled, setZhihuDraftEnabled] = useState(false);

  const stepsEndRef = useRef<HTMLDivElement>(null);
  /** 文档级滚动贴底判定:贴底才自动跟随,上翻阅读历史不被拽回 */
  const atBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/xhs-managed');
        const data = await res.json();
        if (data.success) {
          setXhsDraftEnabled(Boolean(data.record?.enabled && data.record?.riskAckAt));
        }
      } catch {
        // 未登录/后端未就绪时静默:按钮不出现即可,不阻断会话渲染
      }
    })();
    (async () => {
      try {
        const res = await fetch('/api/zhihu-managed');
        const data = await res.json();
        if (data.success) {
          setZhihuDraftEnabled(Boolean(data.record?.enabled && data.record?.riskAckAt));
        }
      } catch {
        // 同上:静默降级
      }
    })();
  }, []);

  // 切会话 / 父组件通知新消息发送(followToken +1)后:重置贴底态,
  // 跟随新一轮输出(点重试在 onClick 内同口径就地重置)
  useEffect(() => {
    atBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [mission.id, followToken]);

  // 贴底才自动滚动跟随新内容(与桌面智能跟随同语义,滚动容器换成文档)
  useEffect(() => {
    if (mission.steps?.length && atBottomRef.current) {
      stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [mission.steps]);

  // 文档级滚动监听(本 tab 现行模式):96px 内算贴底(移动端地址栏收放
  // 留余量);上翻时出「回到底部」,不强拽
  useEffect(() => {
    const onScroll = () => {
      const doc = document.scrollingElement || document.documentElement;
      const nearBottom = doc.scrollHeight - window.scrollY - window.innerHeight < 96;
      atBottomRef.current = nearBottom;
      setShowJumpToBottom(!nearBottom);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const jumpToBottom = () => {
    atBottomRef.current = true;
    setShowJumpToBottom(false);
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // ===== 数据管线(与桌面驾驶舱同源,纯函数复用,不另写映射) =====
  const steps = mission.steps ?? [];
  const { blocks } = splitStepsIntoBlocks(steps);
  // 投递目标按任务来源工坊路由(工坊包声明驱动):知乎工坊的文章包走知乎
  // 托管存草稿,其余文章包走公众号草稿箱;笔记包格式仅 xhs 产出。已落稿
  // 索引(防重复投递):落稿工具 DONE 且标题/正文命中本篇 → 按钮转「已存
  // 入草稿箱」
  const articleDraft = resolveArtifactDraft(mission.workshopId, 'article-package');
  const noteDraft = resolveArtifactDraft(mission.workshopId, 'note-package');
  const articleDelivered = buildDraftDeliveryIndex(steps, articleDraft?.deliverTool);
  const noteDelivered = buildDraftDeliveryIndex(steps, noteDraft?.deliverTool);
  // 逐字段交付(novel 设定包/大纲包)· mission 级渐进卡:契约经
  // mission.deliveryContract.id 现场重建,字段跨轮累积(steps 是持久事实源,
  // 注册表只是轮内缓存),卡只钉在最后一个含交付步的轮之后(一张、最新位置)
  const deliveryContract = mission.deliveryContract
    ? resolveDeliveryContract(mission.deliveryContract.id)
    : undefined;
  const deliveryProgress = collectWorkshopDeliveries(steps, deliveryContract);
  const deliveryPkg =
    deliveryProgress && deliveryContract
      ? assembleNovelDelivery(deliveryContract.id, deliveredFieldsFromSteps(steps))
      : null;
  const groupedTurns = groupBlocksIntoTurns(blocks);
  let lastDeliveryTurnKey: string | null = null;
  if (deliveryProgress) {
    for (const t of groupedTurns) {
      if (t.type !== 'agent') continue;
      const has = t.items.some(
        (b) => b.type === 'tools' && b.steps.some((s) => s.tool === DELIVER_FIELD_TOOL)
      );
      if (has) lastDeliveryTurnKey = t.key;
    }
  }

  const availability = chatAvailability(mission);

  return (
    <div className="space-y-3">
      {/* 会话定向锚:对话态保留标题行(监控内容与进度留在动态态) */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-zinc-900 truncate pr-2">{mission.title || '未命名任务'}</p>
        <span className="text-[11px] text-zinc-400 shrink-0">{Math.round(mission.progress || 0)}%</span>
      </div>

      {availability === 'loading' ? (
        /* 终态摘要(stripped,steps 已剥)等懒回水回填;发送续聊不受影响 */
        <div className="py-16 text-center space-y-2.5">
          <Loader2 className="mx-auto h-5 w-5 text-zinc-300 animate-spin" />
          <p className="text-sm text-zinc-500">正在拉取历史内容…</p>
          <p className="text-xs text-zinc-400">也可以直接发消息继续这个会话</p>
        </div>
      ) : availability === 'empty' ? (
        <div className="py-16 text-center text-zinc-400 space-y-3">
          <div className="mx-auto w-11 h-11 rounded-2xl bg-zinc-100 border border-zinc-200/60 flex items-center justify-center">
            <Bot className="h-5 w-5 text-zinc-500" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-semibold text-zinc-700">智能体待命就绪</p>
            <p className="text-xs leading-relaxed px-6">发一条消息,开始这个会话的第一轮对话。</p>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {groupedTurns.map((turn) => {
            // ================= 1. 用户提问气泡(右对齐,无头像) =================
            if (turn.type === 'user') {
              const st = turn.step;
              // 排队中的追问:置灰 + 「排队中」提示(不打断在飞轮次,下一步
              // 注入或轮末派发时由后端清除转正)
              const isQueued = Boolean(st.queued);
              return (
                <div key={st.id} className="flex justify-end pt-2">
                  <div
                    className={
                      isQueued
                        ? 'max-w-[85%] rounded-2xl bg-zinc-100 text-zinc-400 border border-zinc-200 px-4 py-2.5 shadow-sm text-sm leading-relaxed italic selection:bg-zinc-200'
                        : 'max-w-[85%] rounded-2xl bg-zinc-900 text-zinc-50 px-4 py-2.5 shadow-sm text-sm leading-relaxed selection:bg-zinc-700'
                    }
                  >
                    <p className="whitespace-pre-wrap font-normal">{st.userPrompt || st.title}</p>
                    {isQueued && (
                      <p className="mt-1 text-[10px] not-italic text-zinc-400 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        排队中，将在当前步骤完成后注入（不打断任务）
                      </p>
                    )}
                  </div>
                </div>
              );
            }

            // ======== 2. Agent 作答轮(Claude Code 式平铺流 + 左竖轨) ========
            // 空壳块(无文本也无流式)过滤后为空则整轮不渲染,不出白卡
            const renderable = turn.items.filter(
              (b) =>
                b.type === 'tools' ||
                b.type === 'notice' ||
                Boolean(b.step.answer || b.step.reasoning) ||
                b.step.status === 'RUNNING'
            );
            if (renderable.length === 0) return null;
            const turnStreaming = turn.items.some(
              (b) => b.type === 'assistant' && b.step.status === 'RUNNING'
            );
            // 整轮过程折叠边界:最后一个带正文的回复块(工坊成品豁免),
            // 语义在 cockpit-blocks 有测试锚定 —— 照桌面同款,别改语义
            const finalIdx = findFinalAnswerIndex(renderable, hasWorkshopDeliverable);
            const processRegion = finalIdx >= 0 ? renderable.slice(0, finalIdx) : renderable;
            const finalBlocks = finalIdx >= 0 ? renderable.slice(finalIdx) : [];
            // 后台任务通知卡不参与整轮过程折叠(常显系统事件);折叠边界
            // 之后的 notice 天然留在 finalBlocks(常显区)
            const processBlocks: CockpitBlock[] = processRegion.filter((b) => b.type !== 'notice');
            const pinnedNotices: CockpitBlock[] = processRegion.filter((b) => b.type === 'notice');
            const turnOpen = expanded[turn.key] ?? finalIdx < 0;
            // 摘要行计数/失败/耗时:口径抽在 lib/mobile-chat(与桌面逐字一致)
            const { count: processCount, failed: processFailed, elapsedMs } =
              summarizeProcessBlocks(processBlocks);
            const elapsedLabel =
              elapsedMs !== undefined ? formatActivityDuration(`${elapsedMs}ms`) : undefined;
            return (
              <div key={turn.key} className="space-y-2.5">
                {/* 轮首标记:轻量「谁在说话」锚(流式时蓝点亮起) */}
                <div className="flex items-center gap-1.5 pl-0.5">
                  <div className="h-5 w-5 rounded-lg bg-zinc-900 text-white flex items-center justify-center shadow-2xs">
                    <Bot className="h-3 w-3" />
                  </div>
                  {turnStreaming && (
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-600" />
                    </span>
                  )}
                </div>
                {/* 左竖线 rail:同轮块视觉连续(替代卡片边框),流式时变蓝 */}
                <div
                  className={`ml-2.5 pl-4 border-l space-y-2.5 transition-colors duration-300 ${
                    turnStreaming ? 'border-blue-300/70' : 'border-zinc-200/80'
                  }`}
                >
                  {/* novel 渐进交付卡:钉在最后一个含交付步的轮(不参与整轮
                      过程折叠 —— 交付进度受控播报开始吐正文后不能跟着收起) */}
                  {turn.key === lastDeliveryTurnKey && deliveryProgress && deliveryPkg && (
                    <NovelPackageCard
                      pkg={deliveryPkg}
                      onChain={onRunNovelChain}
                      progress={deliveryProgress}
                    />
                  )}
                  {/* 整轮过程折叠开关:final 一出(或历史轮已带答复)自动收成
                      一行,点开原地展开;notice 卡不计入(常显) */}
                  {finalIdx > 0 && processBlocks.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => ({
                          ...prev,
                          [turn.key]: !turnOpen,
                        }))
                      }
                      className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 active:text-zinc-700 select-none py-0.5"
                    >
                      <Wrench className="h-3 w-3 text-zinc-400" />
                      <span>任务过程 · {processCount} 项</span>
                      {elapsedLabel && (
                        <span className="text-[10px] text-zinc-400 font-mono">{elapsedLabel}</span>
                      )}
                      {processFailed > 0 && (
                        <span className="text-red-500">· {processFailed} 项失败</span>
                      )}
                      <ChevronDown
                        className={`h-3.5 w-3.5 text-zinc-400 transition-transform duration-200 ${
                          turnOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                  )}
                  {(turnOpen ? processBlocks : []).concat(pinnedNotices).concat(finalBlocks).map((block) => {
                    // ================= 2a. 工具活动时间线(逐行叙述) =================
                    // 每个动作一行,行内是用户可读的行动语言(与动态态同源
                    // narrateStep);失败行红显。launch_background_task 行
                    // 按普通工具行渲染(桌面此处 inline 展开子任务面板,移动
                    // 端收尾走 notice 卡 + 「查看子任务」跳转)
                    if (block.type === 'tools') {
                      const rows = block.steps.filter((s) => s.tool || s.status === 'FAILED');
                      return (
                        <div key={block.key} className="space-y-1">
                          {rows.map((st) => {
                            const narrated = narrateStep(st);
                            if (!narrated) return null;
                            const isRunning = st.status === 'RUNNING';
                            const isFailed = st.status === 'FAILED';
                            const getActivityIcon = () => {
                              if (isFailed) return <AlertCircle className="h-3 w-3 text-red-500" />;
                              if (isRunning) return <RotateCw className="h-3 w-3 text-blue-600 animate-spin" />;
                              if (narrated.kind === 'search') return <Search className="h-3 w-3 text-blue-500" />;
                              if (narrated.kind === 'browser') return <Globe className="h-3 w-3 text-indigo-500" />;
                              if (narrated.kind === 'sandbox') return <Code className="h-3 w-3 text-amber-500" />;
                              if (narrated.kind === 'background') return <Layers className="h-3 w-3 text-violet-500" />;
                              return <Wrench className="h-3 w-3 text-zinc-400" />;
                            };
                            return (
                              <div key={st.id} className="flex items-center gap-2 min-w-0 animate-fadeIn">
                                <div className="h-4.5 w-4.5 rounded bg-zinc-50 border border-zinc-100 flex items-center justify-center flex-shrink-0">
                                  {getActivityIcon()}
                                </div>
                                <span
                                  className={`text-[11px] font-medium truncate flex-shrink-0 ${
                                    isFailed ? 'text-red-600' : 'text-zinc-700'
                                  }`}
                                >
                                  {isRunning ? `正在${narrated.label}` : narrated.label}
                                </span>
                                {narrated.detail && (
                                  <span className="text-[10px] text-zinc-400 truncate">{narrated.detail}</span>
                                )}
                                <span className="ml-auto flex-shrink-0">
                                  {isRunning ? (
                                    <span className="text-[9px] text-blue-600 font-mono flex items-center gap-1">
                                      <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-pulse" />
                                      执行中
                                    </span>
                                  ) : isFailed ? (
                                    <span className="text-[9px] text-red-600 font-mono">失败</span>
                                  ) : (
                                    <span className="text-[9px] text-zinc-400 font-mono">
                                      {formatActivityDuration(st.duration) ?? '完成'}
                                    </span>
                                  )}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    }

                    // ======== 2n. 后台子任务收尾通知卡(常显系统事件) ========
                    // step_bg_ 步骤(bgNotice 载荷):完成/失败两态卡,摘要
                    // clamp-3 可展开,「查看子任务」打开完整子会话(逃生舱)
                    if (block.type === 'notice') {
                      const n = block.step.bgNotice!;
                      const failed = n.outcome === 'failed';
                      const noticeKey = `${block.step.id}_notice`;
                      const noticeOpen = expanded[noticeKey] ?? false;
                      const summary = (n.summary || '').trim();
                      const clampable = summary.length > 140 || summary.split('\n').length > 3;
                      return (
                        <div
                          key={block.step.id}
                          className={`rounded-xl border px-3.5 py-2.5 animate-fadeIn ${
                            failed ? 'border-red-200/70 bg-red-50/40' : 'border-zinc-200/80 bg-zinc-50/70'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {failed ? (
                              <AlertCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
                            ) : (
                              <Check className="h-3.5 w-3.5 text-emerald-600 flex-shrink-0" />
                            )}
                            <span
                              className={`text-[11px] font-medium truncate ${failed ? 'text-red-700' : 'text-zinc-700'}`}
                            >
                              {failed ? '后台任务失败' : '后台任务完成'} · {n.childTitle}
                            </span>
                            <button
                              type="button"
                              onClick={() => onSelectMission(n.childMissionId)}
                              className="ml-auto flex-shrink-0 flex items-center gap-0.5 text-[10px] text-zinc-400 active:text-zinc-700 transition"
                              title="打开子任务完整会话(含全部步骤与回复)"
                            >
                              查看子任务 <ChevronRight className="h-3 w-3" />
                            </button>
                          </div>
                          {summary && (
                            <div className="mt-1.5">
                              <p
                                className={`text-[11px] text-zinc-500 leading-relaxed whitespace-pre-wrap break-words ${
                                  noticeOpen || !clampable ? '' : 'line-clamp-3'
                                }`}
                              >
                                {summary}
                              </p>
                              {clampable && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpanded((prev) => ({ ...prev, [noticeKey]: !noticeOpen }))
                                  }
                                  className="mt-0.5 text-[10px] text-zinc-400 active:text-zinc-600 transition"
                                >
                                  {noticeOpen ? '收起' : '展开全文'}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    }

                    // ================= 3. 智能体回复块(思考可折叠) =================
                    if (block.type === 'assistant') {
                      const st = block.step;
                      // 流式中的 live step:shimmer 占位 / 打字光标 / 思考过程块
                      const isStreaming = st.status === 'RUNNING' && st.role === 'assistant';
                      // 思考过程折叠态复用 expanded(流式期间默认展开,正文
                      // 开始输出后随工具过程一起默认收起;手动操作后尊重选择)。
                      // 整轮收起时最终答复自带的思考流归入「任务过程」行;
                      // finalIdx ≤ 0(纯对话轮)不隐藏,思考流走自身折叠开关
                      const reasoningKey = `${st.id}_reasoning`;
                      const reasoningOpen = expanded[reasoningKey] ?? (isStreaming && !st.answer);
                      const reasoningInSection = turnOpen || finalIdx <= 0;
                      // 卡片续聊出口(勾选成稿/存草稿/重新生成);未提供时
                      // 选题/文章分支跳过、落 markdown
                      const reply = onRunMission;
                      // 流式期间不解析(文本不完整),流结束一次性切换,避免
                      // 原始 markdown → 卡片的闪烁;解析失败保持 markdown
                      const parsedNote = st.answer && !isStreaming ? parseNotePackages(st.answer) : null;
                      const noteResult = parsedNote && parsedNote.packages.length > 0 ? parsedNote : null;
                      // 每周选题勾选卡:onRunMission 缺席时跳过(勾选后
                      // 「成稿选中」续聊本 mission 是卡片的核心交互)
                      const parsedPicks = st.answer && !isStreaming && reply ? parseTopicPicks(st.answer) : null;
                      const pickResult = parsedPicks && parsedPicks.picks.length > 0 ? parsedPicks : null;
                      // 公众号文章包(草稿箱直投):【摘要】是互斥锚 —— article
                      // 必须先于 note 判定(渲染顺序固化);存草稿续聊走 reply
                      const parsedArticle = st.answer && !isStreaming && reply ? parseArticlePackages(st.answer) : null;
                      const articleResult =
                        parsedArticle && parsedArticle.packages.length > 0 ? parsedArticle : null;
                      // 开源贡献机会:字段头与其他四种格式互不相交,顺序不敏感
                      const parsedOss = st.answer && !isStreaming ? parseOssOpportunities(st.answer) : null;
                      const ossResult =
                        parsedOss && parsedOss.opportunities.length > 0 ? parsedOss : null;
                      // 小说包(novel 工坊):开书包锚【设定集】+【粗纲】,
                      // 续写包锚【书号】(nv_ 前缀)+【本章摘要】
                      const parsedNovelRaw = st.answer && !isStreaming ? parseNovelPackage(st.answer) : null;
                      // 去重护栏:逐字段交付已齐全且文本 fallback 又解析出同
                      // kind 包时跳过文本卡(防 wrap-up 复述渲染出双卡)
                      const parsedNovel =
                        parsedNovelRaw && deliveryProgress?.complete && deliveryPkg && deliveryPkg.kind === parsedNovelRaw.kind
                          ? null
                          : parsedNovelRaw;
                      // 搜索来源引用:最终答复收尾后的来源药丸 + 流式期间的
                      // 内联角标(序数同一顺序,药丸即图例)
                      const answerIndex = steps.findIndex((s) => s.id === st.id);
                      const searchSources =
                        st.messageKind === 'final' && st.answer && !isStreaming && answerIndex >= 0
                          ? sourcesForAnswer(steps, answerIndex)
                          : [];
                      const inlineSources =
                        (st.messageKind === 'final' || (isStreaming && st.role === 'assistant')) &&
                        st.answer &&
                        answerIndex >= 0
                          ? sourcesForAnswer(steps, answerIndex)
                          : [];
                      const inlineSourceIndex = new Map(inlineSources.map((s, i) => [s.url, i + 1]));

                      // 空壳卡(模型未产出任何文字就转入工具调用/收尾):不渲染
                      if (!st.answer && !st.reasoning && !isStreaming) return null;

                      return (
                        <div key={st.id} className="text-sm text-zinc-800 leading-relaxed">
                          {/* 思考过程(推理模型 reasoning 流,可折叠;左竖线轻量样式) */}
                          {st.reasoning && reasoningInSection && (
                            <div className="mb-3">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpanded((prev) => ({
                                    ...prev,
                                    [reasoningKey]: !reasoningOpen,
                                  }))
                                }
                                className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 active:text-zinc-700 select-none py-0.5"
                              >
                                <Sparkles className={`h-3 w-3 ${isStreaming ? 'text-blue-500' : 'text-zinc-400'}`} />
                                <span>思考过程</span>
                                {isStreaming && (
                                  <span className="h-1 w-1 rounded-full bg-blue-500 animate-pulse" />
                                )}
                                {/* 流式态补已耗时:思考稀疏流出时长静默窗口也能看出「活着」 */}
                                {isStreaming && st.startedAt && (
                                  <span className="text-[10px] font-mono text-zinc-400">
                                    · <ElapsedTick startedAt={st.startedAt} />
                                  </span>
                                )}
                                <ChevronDown
                                  className={`h-3.5 w-3.5 text-zinc-400 transition-transform duration-200 ${
                                    reasoningOpen ? 'rotate-180' : ''
                                  }`}
                                />
                              </button>
                              {reasoningOpen && (
                                <div className="mt-1 pl-3 border-l-2 border-zinc-200 text-[11px] text-zinc-500 leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto">
                                  {st.reasoning}
                                </div>
                              )}
                            </div>
                          )}

                          {/* 尚无任何输出:思考 shimmer 占位 + 跳动已耗时 */}
                          {isStreaming && !st.answer && !st.reasoning ? (
                            <div className="flex items-center gap-2 text-zinc-400 py-0.5">
                              <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600" />
                              </span>
                              <span className="text-[11px] font-medium">{st.title || '正在思考…'}</span>
                              {st.startedAt && (
                                <span className="text-[10px] font-mono text-zinc-400">
                                  · <ElapsedTick startedAt={st.startedAt} />
                                </span>
                              )}
                            </div>
                          ) : (
                            /* 正文渲染优先链:选题 → novel → 开源 → 文章 → 笔记 → markdown */
                            st.answer && pickResult && reply ? (
                              /* 每周选题:可勾选卡片,勾选后一键成稿续聊本任务 */
                              <TopicPickList
                                compact
                                result={pickResult}
                                missionId={mission.id}
                                onRunMission={reply}
                              />
                            ) : st.answer && parsedNovel ? (
                              /* 小说包(开书三段化):「存入书库」落状态库,「继续:下一步」串下一段任务 */
                              <NovelPackageCard pkg={parsedNovel} onChain={onRunNovelChain} />
                            ) : st.answer && ossResult ? (
                              /* 开源贡献机会:卡片可派发到本地(missionId 关联当前会话) */
                              <OssOpportunityList result={ossResult} missionId={mission.id} />
                            ) : st.answer && articleResult && reply ? (
                              /* 文章包:投草稿走续聊 + 审批门,投递目标按工坊路由 */
                              <ArticlePackageList
                                result={articleResult}
                                missionId={mission.id}
                                onRunMission={reply}
                                draft={articleDraft}
                                draftEnabled={articleDraft?.managedGate !== 'zhihu' || zhihuDraftEnabled}
                                missionStatus={mission.status}
                                draftDelivered={articleDelivered}
                              />
                            ) : st.answer && noteResult ? (
                              /* 小红书笔记包:字段级可复制卡片 + 开启托管写操作后的「存草稿箱」 */
                              <NotePackageList
                                result={noteResult}
                                missionId={mission.id}
                                onRunMission={onRunMission}
                                draft={noteDraft}
                                draftEnabled={noteDraft?.managedGate !== 'xhs' || xhsDraftEnabled}
                                missionStatus={mission.status}
                                draftDelivered={noteDelivered}
                              />
                            ) : (
                              st.answer && (
                                <div className="prose prose-zinc prose-chat max-w-none break-words">
                                  <ReactMarkdown
                                    remarkPlugins={[remarkGfm, remarkBreaks]}
                                    components={{
                                      /* 内联引用角标:URL 命中本轮来源集合时收成
                                         上标角标 [n](与底部来源药丸同序);其余按外链 */
                                      a: ({ href, children }) => {
                                        const num = href ? inlineSourceIndex.get(href) : undefined;
                                        if (num !== undefined) {
                                          return (
                                            <a
                                              href={href}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              title={inlineSources[num - 1].title}
                                              className="no-underline text-blue-600 hover:text-blue-700 text-[10px] align-super"
                                            >
                                              [{num}]
                                            </a>
                                          );
                                        }
                                        return (
                                          <a href={href} target="_blank" rel="noopener noreferrer">
                                            {children}
                                          </a>
                                        );
                                      },
                                    }}
                                  >
                                    {st.answer}
                                  </ReactMarkdown>
                                  {isStreaming && (
                                    <span className="inline-block w-1.5 h-3.5 bg-zinc-800 animate-pulse ml-0.5 align-text-bottom" />
                                  )}
                                </div>
                              )
                            )
                          )}

                          {/* 搜索来源药丸:编号 + favicon + 页面标题,新标签直达;
                              无搜索结果或流式中不渲染 */}
                          {searchSources.length > 0 && (
                            <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                              {searchSources.map((src, idx) => (
                                <a
                                  key={src.url}
                                  href={src.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={`${src.title} · ${src.host}`}
                                  className="flex items-center gap-1.5 max-w-[240px] px-2 py-0.5 rounded-full border border-zinc-200 bg-white active:bg-zinc-50 text-[11px] text-zinc-600 transition shadow-2xs"
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element -- 站点 favicon 走外部域名,无需 next/image 优化 */}
                                  <img
                                    src={`https://www.google.com/s2/favicons?domain=${src.host}&sz=32`}
                                    alt=""
                                    className="h-3.5 w-3.5 rounded-sm flex-shrink-0"
                                    onError={(e) => {
                                      e.currentTarget.style.display = 'none';
                                    }}
                                  />
                                  <span className="text-zinc-400 font-mono text-[9px] flex-shrink-0">{idx + 1}</span>
                                  <span className="truncate">{src.title}</span>
                                </a>
                              ))}
                            </div>
                          )}

                          {/* 中断标记:live step 失败时明确失败态(保留已流出的
                              部分文本)+ 重新生成入口(ACTIVE 时隐藏) */}
                          {st.status === 'FAILED' && st.role === 'assistant' && (
                            <div className="mt-2.5 flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 text-[11px] text-red-500">
                                <AlertCircle className="h-3.5 w-3.5" />
                                <span>回复已中断，以上为部分输出</span>
                              </div>
                              {(() => {
                                const retryPrompt = findRetryPrompt(steps, st.id);
                                if (!retryPrompt || mission.status === 'ACTIVE' || !reply) return null;
                                return (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      atBottomRef.current = true;
                                      setShowJumpToBottom(false);
                                      reply(retryPrompt, undefined, mission.id);
                                    }}
                                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-white text-zinc-700 border border-zinc-200 active:bg-zinc-50 transition shadow-2xs"
                                    title="用同一问题在本会话重新生成"
                                  >
                                    <RotateCw className="h-3 w-3" />
                                    <span>重新生成</span>
                                  </button>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    }

                    return null;
                  })}
                </div>
              </div>
            );
          })}

          {/* 步骤间隙的「任务还活着」指示:mission 仍在跑但此刻没有任何
              RUNNING 步骤(中转延迟/瞬时卡住可达数分钟),补一行持续跳动的
              衔接指示 + 间隙已耗时 */}
          {mission.status === 'ACTIVE' && !steps.some((s) => s.status === 'RUNNING') && (
            <div className="flex items-center gap-2 text-zinc-400 py-0.5 pl-[26px]">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600" />
              </span>
              <span className="text-[11px] font-medium">正在衔接下一步…</span>
              <span className="text-[10px] font-mono text-zinc-400">
                ·{' '}
                <ElapsedTick
                  startedAt={(() => {
                    for (let i = steps.length - 1; i >= 0; i--) {
                      if (!steps[i].startedAt) continue;
                      const ms = steps[i].duration
                        ? Number.parseInt(String(steps[i].duration).replace(/[^\d]/g, ''), 10)
                        : 0;
                      return steps[i].startedAt! + (Number.isFinite(ms) ? ms : 0);
                    }
                    return mission.startedAt;
                  })()}
                />
              </span>
            </div>
          )}
          {/* 流尾标记:scroll-mb 留出底部固定层(tab bar/输入框)的高度,
              贴底滚动停在可见区 */}
          <div ref={stepsEndRef} className="scroll-mb-40" />
        </div>
      )}

      {/* 上翻阅读历史时的「回到底部」浮动按钮(智能跟随:贴底才自动滚动)。
          抬高避让固定输入框:composer 坐在 tab bar 之上(3.5rem+safe-area),
          按钮再叠其上留 4.5rem */}
      {showJumpToBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="fixed left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 px-3 py-1.5 rounded-full bg-white border border-zinc-200 text-[11px] font-medium text-zinc-600 shadow-md active:bg-zinc-50 transition animate-fadeIn"
          style={{ bottom: 'calc(3.5rem + env(safe-area-inset-bottom, 0px) + 4.5rem)' }}
          title="回到最新消息"
        >
          <ArrowDown className="h-3 w-3" />
          <span>回到底部</span>
        </button>
      )}
    </div>
  );
}
