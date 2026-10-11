/**
 * 内容工坊表单 · 小红书/微博图文 + 抖音/B站短视频脚本
 * 主题/类型/时长/篇数 → buildWorkshopRun 交给 Agent。
 * 小红书:场景档案自动注入(档案管「我是谁」,表单管「这次写什么」,二者正交);
 * 并提供「每周自动出选题」订阅入口(scenario-loop P2 模块 3,创建 scenario 型 cron 任务,
 * 触发时服务端按最新档案重建选题 prompt,结果以 DONE 任务交付并推送)。
 */
import { useEffect, useState } from 'react';
import { CalendarClock, Lightbulb, Loader2, Smartphone } from 'lucide-react';
import { XHS_WORKSHOP_STYLES, buildXhsWeeklyTopicsPrompt } from '../../../lib/xhs-workshop';
import {
  WEIBO_WORKSHOP_STYLES,
  VIDEO_SCRIPT_DURATIONS,
} from '../../../lib/content-workshops';
import {
  findLatestTopicPicks,
  hasRunningTopicMission,
  type TopicPicksMissionLike,
} from '../../../lib/topic-picks';
import { openAppScheme, isNativePlatform } from '../../../utils/nativeBridge';
import type { ScenarioProfile } from '../../../lib/scenario-profile';
import type { CronJobItem, Mission } from '../../../types/agent';
import type { WorkshopDef } from '../registry';
import { TopicPickList } from '../TopicPickCard';
import { buildWorkshopRun } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ChipGroup, FieldLabel, WorkshopModalShell, inputClass } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string) => void | Promise<void>;
  onClose: () => void;
  /** 场景档案(WorkshopsView 预取下传);有值时注入 Prompt 并展示摘要条 */
  scenarioProfile?: ScenarioProfile | null;
  /** 点击摘要条「查看/编辑」打开档案向导 */
  onEditProfile?: () => void;
  /** 全量任务列表(WorkshopsView 下传):弹窗内嵌最近一次选题清单的可勾选卡片 */
  missions?: Mission[];
}

/** 真机唤起配置(scenario-loop:免凭证平台卡片从连接器页搬进对应工坊;X 无工坊不迁) */
const APP_LAUNCH: Record<string, { scheme: string; name: string; fallback: string }> = {
  weibo: { scheme: 'sinaweibo://', name: '微博', fallback: 'https://m.weibo.cn' },
  video_douyin: { scheme: 'snssdk1128://', name: '抖音', fallback: 'https://www.douyin.com' },
  video_bilibili: { scheme: 'bilibili://', name: '哔哩哔哩', fallback: 'https://www.bilibili.com' },
};

/** 订阅日 chip 选项(cron day-of-week:周日 = 0) */
const SUBSCRIBE_DAYS = [
  { id: 1, name: '周一' },
  { id: 2, name: '周二' },
  { id: 3, name: '周三' },
  { id: 4, name: '周四' },
  { id: 5, name: '周五' },
  { id: 6, name: '周六' },
  { id: 0, name: '周日' },
];
const SUBSCRIBE_COUNTS = [
  { id: 5, name: '5 条' },
  { id: 7, name: '7 条' },
  { id: 10, name: '10 条' },
];

export function ContentWorkshopForm({ workshop, onRun, onClose, scenarioProfile, onEditProfile, missions }: Props) {
  const isVideo = workshop.id === 'video_douyin' || workshop.id === 'video_bilibili';
  const isWeibo = workshop.id === 'weibo';
  const isXhs = workshop.id === 'xhs';
  const saved = lastRunOf(workshop.id)?.params || {};

  const [topic, setTopic] = useState(typeof saved.topic === 'string' ? saved.topic : '');
  const [style, setStyle] = useState<string>(
    typeof saved.style === 'string' ? saved.style : isWeibo ? WEIBO_WORKSHOP_STYLES[0] : XHS_WORKSHOP_STYLES[0]
  );
  const [duration, setDuration] = useState<string>(
    typeof saved.duration === 'string' ? saved.duration : VIDEO_SCRIPT_DURATIONS[1]
  );
  const [count, setCount] = useState<number>(
    typeof saved.count === 'number' ? saved.count : 1
  );

  // ---- 真机唤起(免凭证平台):手机端可拉起已登录的原生 App;桌面端 scheme 打不开,给灰提示 ----
  const launch = APP_LAUNCH[workshop.id];
  const [mobileCtx, setMobileCtx] = useState(false);
  useEffect(() => {
    let native = false;
    try {
      native = isNativePlatform();
    } catch {
      // Capacitor 桥未就绪时按 UA 兜底
    }
    const uaMobile =
      typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    setMobileCtx(native || uaMobile);
  }, []);

  // ---- 小红书订阅(scenario 型 cron 任务;同 key 全局至多一个) ----
  const [subsJob, setSubsJob] = useState<CronJobItem | null>(null);
  const [subsLoading, setSubsLoading] = useState(isXhs);
  const [subsBusy, setSubsBusy] = useState(false);
  const [subDay, setSubDay] = useState(1);
  const [subTime, setSubTime] = useState('09:00');
  const [subCount, setSubCount] = useState(7);

  useEffect(() => {
    if (!isXhs) return;
    (async () => {
      try {
        const res = await fetch('/api/cron/jobs');
        const data = await res.json();
        if (data.success) {
          const job = (data.jobs || []).find(
            (j: CronJobItem) => j.scenario?.key === 'xhs_weekly_topics' && j.status !== 'cancelled'
          );
          setSubsJob(job || null);
        }
      } catch {
        // 未登录/后端未就绪时静默
      } finally {
        setSubsLoading(false);
      }
    })();
  }, [isXhs]);

  /** cron 表达式:分 时 * * 周(周日 = 0) */
  const subPattern = () => {
    const [h, m] = (subTime || '09:00').split(':').map((v) => Number(v) || 0);
    return `${m} ${h} * * ${subDay}`;
  };

  const postCron = (body: Record<string, unknown>) =>
    fetch('/api/cron/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  /** 开通/修改订阅:同 key 先取消旧任务再建新任务(保证 pattern/count 一致) */
  const handleSubscribe = async () => {
    setSubsBusy(true);
    try {
      if (subsJob) {
        await postCron({ action: 'cancel', id: subsJob.id });
      }
      const data = await postCron({
        action: 'create',
        name: '小红书每周选题',
        pattern: subPattern(),
        // 存档的 prompt 仅作展示快照;触发时服务端按最新档案重建
        prompt: buildXhsWeeklyTopicsPrompt({ count: subCount, profile: scenarioProfile ?? undefined }),
        scenario: { key: 'xhs_weekly_topics', count: subCount },
      });
      if (data.success) setSubsJob(data.newJob || null);
    } catch {
      // 网络异常静默,按钮恢复可点即可重试
    } finally {
      setSubsBusy(false);
    }
  };

  const handleUnsubscribe = async () => {
    if (!subsJob) return;
    setSubsBusy(true);
    try {
      await postCron({ action: 'cancel', id: subsJob.id });
      setSubsJob(null);
    } finally {
      setSubsBusy(false);
    }
  };

  const params = { topic, style, duration, count };
  const preview = buildWorkshopRun(
    workshop.id,
    params,
    scenarioProfile ? { scenarioProfile } : undefined
  );

  // ---- 本周选题:弹窗内「立即出选题 + 勾选成稿」(闭环从会话页搬进弹窗) ----
  const topicPicks = isXhs ? findLatestTopicPicks((missions || []) as TopicPicksMissionLike[]) : null;
  const topicRunning = isXhs ? hasRunningTopicMission(missions || []) : false;
  /** 发起选题任务:与订阅同款 prompt(已托管登录则读小红书热门话题,否则降级),标题带标记供弹窗回查 */
  const launchTopics = () =>
    onRun(
      buildXhsWeeklyTopicsPrompt({ count: subCount, profile: scenarioProfile ?? undefined }),
      '小红书每周选题·手动'
    );

  const handleSubmit = () => {
    recordRun(workshop.id, preview.title, params);
    onRun(preview.prompt, preview.title);
  };

  const topicPlaceholder = isVideo
    ? '留空则由 Agent 抓知乎热榜/搜索热点自动选题,如：AI 工具月度盘点'
    : isXhs && scenarioProfile?.positioning.niche
    ? `留空则按你的「${scenarioProfile.positioning.niche}」赛道调研热点选题`
    : '留空则由 Agent 抓知乎热榜/搜索热点自动选题,如：秋冬通勤穿搭';

  return (
    <WorkshopModalShell
      def={workshop}
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel="开始创作"
      previewPrompt={preview.prompt}
    >
      {/* 档案摘要条:让用户看见「Agent 已经认识我」,可回访编辑 */}
      {isXhs && scenarioProfile && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-violet-50/70 border border-violet-100">
          <span className="text-[11px] text-violet-700 leading-relaxed min-w-0 truncate">
            档案:{scenarioProfile.positioning.niche} · {scenarioProfile.positioning.audience}
            {scenarioProfile.cadence.postsPerWeek ? ` · 每周 ${scenarioProfile.cadence.postsPerWeek} 篇` : ''}
          </span>
          {onEditProfile && (
            <button
              type="button"
              onClick={onEditProfile}
              className="shrink-0 text-[11px] font-medium text-violet-600 hover:text-violet-800 transition"
            >
              查看/编辑
            </button>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <FieldLabel optional>主题</FieldLabel>
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder={topicPlaceholder}
          className={inputClass}
        />
      </div>

      {(workshop.id === 'xhs' || isWeibo) && (
        <div className="space-y-1.5">
          <FieldLabel>{isWeibo ? '微博类型' : '笔记类型'}</FieldLabel>
          <ChipGroup
            options={(isWeibo ? WEIBO_WORKSHOP_STYLES : XHS_WORKSHOP_STYLES).map((s) => ({ id: s, name: s }))}
            value={style}
            onChange={setStyle}
            accent={workshop.accent}
          />
        </div>
      )}

      {isVideo && (
        <div className="space-y-1.5">
          <FieldLabel>视频时长</FieldLabel>
          <ChipGroup
            options={VIDEO_SCRIPT_DURATIONS.map((d) => ({ id: d, name: d }))}
            value={duration}
            onChange={setDuration}
            accent={workshop.accent}
          />
        </div>
      )}

      <div className="space-y-1.5">
        <FieldLabel>{isVideo ? '产出脚本数' : '产出篇数'}</FieldLabel>
        <div className="flex gap-1.5">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setCount(n)}
              className={`w-10 py-1 rounded-lg text-xs font-medium border transition ${
                count === n
                  ? 'bg-violet-600 text-white border-violet-600'
                  : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* 本周选题:立即出选题 + 弹窗内勾选成稿(不用回会话页;定时订阅与任务页手动触发保留) */}
      {isXhs && (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 space-y-2">
          {topicRunning ? (
            <p className="text-[11px] text-zinc-500 flex items-center gap-1.5 leading-relaxed">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500 shrink-0" />
              选题任务进行中,完成后重开工坊即可在这里勾选清单。
            </p>
          ) : topicPicks ? (
            <>
              <TopicPickList
                result={topicPicks.result}
                missionId={null}
                compact
                onRunMission={(prompt) => onRun(prompt, '小红书成稿·勾选选题')}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-zinc-400 leading-relaxed">
                  清单来自最近一次选题任务;想换一批点「重新生成」。
                </span>
                <button
                  type="button"
                  onClick={launchTopics}
                  className="shrink-0 text-[11px] font-medium text-zinc-500 hover:text-violet-600 transition"
                >
                  重新生成
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                拉取小红书本周热门话题(需已开托管登录;未开则降级知乎热榜/搜索)生成选题清单,
                勾 1-3 条一键成稿。发起后去任务页看执行,完成清单回到这里勾选。
              </p>
              <button
                type="button"
                onClick={launchTopics}
                className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium transition shadow-xs"
              >
                <Lightbulb className="h-3.5 w-3.5" />
                立即出选题
              </button>
            </>
          )}
        </div>
      )}

      {/* 真机唤起 · 免凭证发布(手机端拉起原生 App;桌面端灰提示) */}
      {launch && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2.5">
          <span className="text-[11px] text-zinc-500 leading-relaxed min-w-0">
            {isVideo ? '剪辑完成后' : '复制满意的内容后'}唤起{launch.name} App 粘贴,人工核对后发布。
          </span>
          {mobileCtx ? (
            <button
              type="button"
              onClick={() => openAppScheme(launch.scheme, launch.fallback)}
              className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition"
              title={`在手机端直接唤起已登录的${launch.name} App`}
            >
              <Smartphone className="h-3 w-3" />
              <span>唤起{launch.name}</span>
            </button>
          ) : (
            <span
              className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] text-zinc-400 bg-white border border-zinc-200"
              title="真机唤起仅在手机浏览器或 Capacitor App 内可用"
            >
              <Smartphone className="h-3 w-3" />
              <span>手机端可用</span>
            </span>
          )}
        </div>
      )}

      {/* 订阅 · 每周自动出选题(scenario-loop P2):创建 scenario 型 cron 任务 */}
      {isXhs && !subsLoading && (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-700 flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5 text-violet-500" />
              订阅 · 每周自动出选题
            </span>
            {subsJob && (
              <button
                type="button"
                onClick={handleUnsubscribe}
                disabled={subsBusy}
                className="text-[11px] text-zinc-400 hover:text-red-500 transition disabled:opacity-50"
              >
                取消订阅
              </button>
            )}
          </div>

          {subsJob && (
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              已订阅{subsJob.scenario?.count ? ` · 每次出 ${subsJob.scenario.count} 条选题` : ''}
              {subsJob.nextRun ? ` · 下次 ${new Date(subsJob.nextRun).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
              。触发时 Agent 按你的最新档案调研热点,选题完成后推送给你,勾选后用工坊成稿。
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <ChipGroup options={SUBSCRIBE_DAYS} value={subDay} onChange={setSubDay} accent={workshop.accent} />
            <input
              type="time"
              value={subTime}
              onChange={(e) => setSubTime(e.target.value || '09:00')}
              className="w-24 px-2 py-1 rounded-lg border border-zinc-200 bg-white text-xs text-zinc-900 focus:outline-none focus:border-zinc-500"
            />
            <ChipGroup options={SUBSCRIBE_COUNTS} value={subCount} onChange={setSubCount} accent={workshop.accent} />
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-zinc-400 leading-relaxed">
              订阅任务只读不写:Agent 只调研出选题清单,不碰发布与草稿。
            </span>
            <button
              type="button"
              onClick={handleSubscribe}
              disabled={subsBusy}
              className={`shrink-0 px-3 py-1 rounded-lg text-[11px] font-medium transition shadow-xs disabled:opacity-50 ${
                subsJob
                  ? 'bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300'
                  : 'bg-violet-600 hover:bg-violet-700 text-white'
              }`}
            >
              {subsBusy ? '保存中…' : subsJob ? '保存修改' : '开通订阅'}
            </button>
          </div>
        </div>
      )}
    </WorkshopModalShell>
  );
}
