/**
 * 知乎专栏工坊表单
 * 主题/风格/篇数 → buildWorkshopRun 交给 Agent;场景档案自动注入(同公众号)。
 * 无凭证概念:托管前提 = 连接器页「知乎」卡片扫码登录 + 开启托管模式;
 * 本表单只展示登录/托管状态与今日用量,未开启不阻塞创作(可复制文本手动粘贴)。
 */
import { useCallback, useEffect, useState } from 'react';
import { QrCode } from 'lucide-react';
import { ZHIHU_ARTICLE_STYLES, ZHIHU_TOPIC_PRESETS } from '@/workshops/zhihu/context';
import type { ScenarioProfile } from '../../../lib/scenario-profile';
import type { WorkshopDef } from '../registry';
import { buildWorkshopRun, type WorkshopRunPayload } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ChipGroup, FieldLabel, WorkshopModalShell, inputClass } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string, workshop?: WorkshopRunPayload) => void | Promise<void>;
  onClose: () => void;
  /** 场景档案(WorkshopsView 预取下传);有值时注入 Prompt 并展示摘要条 */
  scenarioProfile?: ScenarioProfile | null;
  /** 点击摘要条「查看/编辑」打开档案向导 */
  onEditProfile?: () => void;
  /** 未登录/未托管时跳连接器页配置(知乎卡片) */
  onOpenConnectors?: (depId?: string) => void;
}

interface ManagedState {
  loggedIn: boolean;
  managed: boolean;
  dailyLimit?: number;
  todayCount?: number;
}

export function ZhihuWorkshopForm({ workshop, onRun, onClose, scenarioProfile, onEditProfile, onOpenConnectors }: Props) {
  const saved = lastRunOf(workshop.id)?.params || {};
  const [topic, setTopic] = useState(typeof saved.topic === 'string' ? saved.topic : '');
  const [style, setStyle] = useState<string>(
    typeof saved.style === 'string' ? saved.style : ZHIHU_ARTICLE_STYLES[0]
  );
  const [count, setCount] = useState<number>(typeof saved.count === 'number' ? saved.count : 1);

  // ---- 托管状态(只读;登录/开关都在连接器页,此处 GET /api/zhihu-managed 查状态) ----
  const [managed, setManaged] = useState<ManagedState | null>(null); // null = 加载中

  const loadManaged = useCallback(async () => {
    try {
      const res = await fetch('/api/zhihu-managed');
      const data = await res.json();
      if (data.success) {
        setManaged({
          loggedIn: Boolean(data.record?.lastLoginAt),
          managed: Boolean(data.record?.enabled && data.record?.riskAckAt),
          dailyLimit: data.dailyLimit,
          todayCount: data.todayCount,
        });
      } else {
        setManaged({ loggedIn: false, managed: false });
      }
    } catch {
      setManaged({ loggedIn: false, managed: false });
    }
  }, []);

  useEffect(() => {
    loadManaged();
  }, [loadManaged]);

  const params = { topic, style, count };
  const preview = buildWorkshopRun(
    workshop.id,
    params,
    scenarioProfile ? { scenarioProfile } : undefined
  );

  const handleSubmit = () => {
    recordRun(workshop.id, preview.title, params);
    onRun(preview.prompt, preview.title, { id: workshop.id, params });
  };

  return (
    <WorkshopModalShell
      def={workshop}
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel="开始创作"
      previewPrompt={preview.prompt}
    >
      {/* 档案摘要条:让用户看见「Agent 已经认识我」,可回访编辑 */}
      {scenarioProfile && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-violet-50/70 border border-violet-100">
          <span className="text-[11px] text-violet-700 leading-relaxed min-w-0 truncate">
            档案:{scenarioProfile.positioning.niche} · {scenarioProfile.positioning.audience}
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
        {/* 方向预设:点 chip 填入主题(Agent 在方向下挑具体新题),再点清空;仍可自由输入 */}
        <div className="flex flex-wrap gap-1.5">
          {ZHIHU_TOPIC_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setTopic(topic === p ? '' : p)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
                topic === p
                  ? 'bg-violet-600 text-white border-violet-600'
                  : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder={
            scenarioProfile?.positioning.niche
              ? `留空则按你的「${scenarioProfile.positioning.niche}」赛道调研热点选题`
              : '留空则由 Agent 调研热榜/知乎搜索热点自动选题,如:AI Agent 工程化实践'
          }
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel>文章风格</FieldLabel>
        <ChipGroup
          options={ZHIHU_ARTICLE_STYLES.map((s) => ({ id: s, name: s }))}
          value={style}
          onChange={setStyle}
          accent={workshop.accent}
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel>产出篇数</FieldLabel>
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

      {/* 托管状态行:登录/开关在连接器页;此处只看状态(未开启不阻塞创作) */}
      <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-700">
            <QrCode className="h-3.5 w-3.5 text-blue-500" />
            {managed === null ? (
              <span className="text-zinc-400 font-normal">托管状态加载中…</span>
            ) : managed.managed ? (
              <span className="text-zinc-500 font-normal">
                托管已开启 · 今日存草稿 {managed.todayCount ?? 0}/{managed.dailyLimit ?? 3} 次
              </span>
            ) : managed.loggedIn ? (
              <span className="text-zinc-500 font-normal">已扫码登录 · 托管模式未开启(存草稿按钮不会出现)</span>
            ) : (
              <span className="text-zinc-500 font-normal">知乎网页版未登录(存草稿按钮不会出现)</span>
            )}
          </span>
          {onOpenConnectors && (
            <button
              type="button"
              onClick={() => onOpenConnectors?.('zhihu')}
              className="shrink-0 px-3 py-1 rounded-lg text-[11px] font-medium text-violet-600 hover:text-violet-800 transition"
            >
              {managed?.managed ? '管理托管' : '去连接器页登录'}
            </button>
          )}
        </div>
        {managed && !managed.managed && (
          <p className="text-[10px] text-zinc-400 leading-relaxed">
            到连接器页「知乎」卡片扫码登录网页版并开启托管模式后,文章卡片会出现「存入知乎草稿」按钮(经你逐次审批,每日有上限);未开启时仍可复制文章文本手动粘贴。
          </p>
        )}
      </div>
    </WorkshopModalShell>
  );
}
