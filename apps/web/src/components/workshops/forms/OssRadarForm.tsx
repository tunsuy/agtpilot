/**
 * 开源贡献雷达工坊表单:技术栈 / 关注方向 / 机会类型 / 条数 → buildWorkshopRun 交给 Agent。
 * 贡献者档案自动注入(档案管「我的长期技术设定」,表单管「这次扫什么」,二者正交);
 * 并提供「每周自动扫描」订阅入口(scenario 型 cron 任务,触发时服务端按最新档案重建 prompt,
 * 与小红书每周选题同一套机制,只读不写)。
 */
import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { OSS_INTERESTS, OSS_CONTRIB_KINDS, buildOssRadarPrompt } from '@/workshops/oss_radar/context';
import type { ScenarioProfile } from '../../../lib/scenario-profile';
import type { CronJobItem } from '../../../types/agent';
import type { WorkshopDef } from '../registry';
import { buildWorkshopRun, type WorkshopRunPayload } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ChipGroup, MultiChipGroup, FieldLabel, WorkshopModalShell, inputClass } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string, workshop?: WorkshopRunPayload) => void | Promise<void>;
  onClose: () => void;
  /** 贡献者档案(WorkshopsView 预取下传);有值时注入 Prompt 并展示摘要条 */
  scenarioProfile?: ScenarioProfile | null;
  /** 点击摘要条「查看/编辑」打开档案向导 */
  onEditProfile?: () => void;
}

/** 订阅日 chip 选项(cron day-of-week:周日 = 0),与内容工坊同款 */
const SUBSCRIBE_DAYS = [
  { id: 1, name: '周一' },
  { id: 2, name: '周二' },
  { id: 3, name: '周三' },
  { id: 4, name: '周四' },
  { id: 5, name: '周五' },
  { id: 6, name: '周六' },
  { id: 0, name: '周日' },
];
const COUNT_OPTIONS = [
  { id: 3, name: '3 条' },
  { id: 5, name: '5 条' },
  { id: 7, name: '7 条' },
];
const ALL_INTEREST_IDS: readonly string[] = OSS_INTERESTS.map((i) => i.id);
const ALL_KIND_IDS: readonly string[] = OSS_CONTRIB_KINDS.map((k) => k.id);

const savedIds = (v: unknown, allowed: readonly string[]): string[] =>
  Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string' && allowed.includes(x)) : [];

export function OssRadarForm({ workshop, onRun, onClose, scenarioProfile, onEditProfile }: Props) {
  const saved = lastRunOf(workshop.id)?.params || {};

  const [stack, setStack] = useState<string>(typeof saved.stack === 'string' ? saved.stack : '');
  const [interests, setInterests] = useState<string[]>(() => savedIds(saved.interests, ALL_INTEREST_IDS));
  const [kinds, setKinds] = useState<string[]>(() => savedIds(saved.kinds, ALL_KIND_IDS));
  const [count, setCount] = useState<number>(
    typeof saved.count === 'number' && [3, 5, 7].includes(saved.count) ? saved.count : 5
  );

  // ---- 每周自动扫描订阅(scenario 型 cron 任务;同 key 全局至多一个) ----
  const [subsJob, setSubsJob] = useState<CronJobItem | null>(null);
  const [subsLoading, setSubsLoading] = useState(true);
  const [subsBusy, setSubsBusy] = useState(false);
  const [subDay, setSubDay] = useState(1);
  const [subTime, setSubTime] = useState('09:30');
  const [subCount, setSubCount] = useState(5);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/cron/jobs');
        const data = await res.json();
        if (data.success) {
          const job = (data.jobs || []).find(
            (j: CronJobItem) => j.scenario?.key === 'oss_radar_weekly' && j.status !== 'cancelled'
          );
          setSubsJob(job || null);
        }
      } catch {
        // 未登录/后端未就绪时静默
      } finally {
        setSubsLoading(false);
      }
    })();
  }, []);

  /** cron 表达式:分 时 * * 周(周日 = 0) */
  const subPattern = () => {
    const [h, m] = (subTime || '09:30').split(':').map((v) => Number(v) || 0);
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
        name: '开源贡献雷达周扫',
        pattern: subPattern(),
        // 存档的 prompt 仅作展示快照;触发时服务端按最新档案重建
        prompt: buildOssRadarPrompt({ stack, interests, kinds, count: subCount, profile: scenarioProfile ?? undefined }),
        scenario: { key: 'oss_radar_weekly', count: subCount },
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

  const params = { stack, interests, kinds, count };
  const preview = buildWorkshopRun(workshop.id, params, scenarioProfile ? { scenarioProfile } : undefined);

  const handleSubmit = () => {
    recordRun(workshop.id, preview.title, params);
    onRun(preview.prompt, preview.title, { id: workshop.id, params });
  };

  const toggle = (list: string[], setList: (v: string[]) => void) => (id: string) => {
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    setList(next); // 允许全不选 = 不限
  };

  return (
    <WorkshopModalShell
      def={workshop}
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel="开始扫描"
      previewPrompt={preview.prompt}
    >
      {/* 档案摘要条:让用户看见「Agent 已经认识我的技术设定」,可回访编辑 */}
      {scenarioProfile && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-sky-50/70 border border-sky-100">
          <span className="text-[11px] text-sky-700 leading-relaxed min-w-0 truncate">
            档案:{scenarioProfile.positioning.niche} · {scenarioProfile.positioning.audience}
          </span>
          {onEditProfile && (
            <button
              type="button"
              onClick={onEditProfile}
              className="shrink-0 text-[11px] font-medium text-sky-600 hover:text-sky-800 transition"
            >
              查看/编辑
            </button>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <FieldLabel optional>主力技术栈</FieldLabel>
        <input
          type="text"
          value={stack}
          onChange={(e) => setStack(e.target.value)}
          placeholder={
            scenarioProfile?.positioning.niche
              ? `留空则按档案里的「${scenarioProfile.positioning.niche}」`
              : '如:Go / TypeScript / Rust / Python,留空按 AI 通用方向'
          }
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel optional>关注方向</FieldLabel>
        <MultiChipGroup
          options={OSS_INTERESTS.map((i) => ({ id: i.id, name: i.name }))}
          values={interests}
          onToggle={toggle(interests, setInterests)}
          accent={workshop.accent}
        />
        <p className="text-[10px] text-zinc-400 leading-relaxed">不选 = AI 领域不限方向。</p>
      </div>

      <div className="space-y-1.5">
        <FieldLabel optional>机会类型</FieldLabel>
        <MultiChipGroup
          options={OSS_CONTRIB_KINDS.map((k) => ({ id: k.id, name: k.name }))}
          values={kinds}
          onToggle={toggle(kinds, setKinds)}
          accent={workshop.accent}
        />
        <p className="text-[10px] text-zinc-400 leading-relaxed">
          不选 = 不限类型;首次贡献建议勾「good first issue」和「文档改进」。
        </p>
      </div>

      <div className="space-y-1.5">
        <FieldLabel>产出条数</FieldLabel>
        <ChipGroup options={COUNT_OPTIONS} value={count} onChange={setCount} accent={workshop.accent} />
      </div>

      {/* 订阅 · 每周自动扫描(与小红书每周选题同款 scenario 机制,触发时按最新档案重建) */}
      {!subsLoading && (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-700 flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5 text-sky-500" />
              订阅 · 每周自动扫描
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
              已订阅{subsJob.scenario?.count ? ` · 每次出 ${subsJob.scenario.count} 条机会` : ''}
              {subsJob.nextRun
                ? ` · 下次 ${new Date(subsJob.nextRun).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                : ''}
              。触发时 Agent 按你的最新档案扫描,清单完成后推送给你。
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <ChipGroup options={SUBSCRIBE_DAYS} value={subDay} onChange={setSubDay} accent={workshop.accent} />
            <input
              type="time"
              value={subTime}
              onChange={(e) => setSubTime(e.target.value || '09:30')}
              className="w-24 px-2 py-1 rounded-lg border border-zinc-200 bg-white text-xs text-zinc-900 focus:outline-none focus:border-zinc-500"
            />
            <ChipGroup options={COUNT_OPTIONS} value={subCount} onChange={setSubCount} accent={workshop.accent} />
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-zinc-400 leading-relaxed">
              订阅任务只读不写:Agent 只调研出机会清单,不建 Issue / 不评论 / 不 fork。
            </span>
            <button
              type="button"
              onClick={handleSubscribe}
              disabled={subsBusy}
              className={`shrink-0 px-3 py-1 rounded-lg text-[11px] font-medium transition shadow-xs disabled:opacity-50 ${
                subsJob
                  ? 'bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300'
                  : 'bg-sky-600 hover:bg-sky-700 text-white'
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
