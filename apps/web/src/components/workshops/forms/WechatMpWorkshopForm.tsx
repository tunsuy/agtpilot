/**
 * 公众号文章工坊表单(scenario-loop:凭证彻底搬离连接器页)
 * 主题/风格/篇数 → buildWorkshopRun 交给 Agent;场景档案自动注入(同小红书)。
 * 凭证区:GET /api/wechat-mp 状态;保存并测试(save→check)、清除(撤销授权);
 * 未配置不阻塞创作——投草稿时 wechat_mp_create_draft 会给出白话引导。
 */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { WECHAT_MP_ARTICLE_STYLES, WECHAT_MP_TOPIC_PRESETS } from '../../../lib/wechat-mp-workshop';
import type { ScenarioProfile } from '../../../lib/scenario-profile';
import type { WorkshopDef } from '../registry';
import { buildWorkshopRun } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ChipGroup, FieldLabel, WorkshopModalShell, inputClass } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string) => void | Promise<void>;
  onClose: () => void;
  scenarioProfile?: ScenarioProfile | null;
  onEditProfile?: () => void;
}

interface CredState {
  configured: boolean;
  appId?: string | null;
  dailyLimit?: number;
  todayCount?: number;
}

export function WechatMpWorkshopForm({ workshop, onRun, onClose, scenarioProfile, onEditProfile }: Props) {
  const saved = lastRunOf(workshop.id)?.params || {};
  const [topic, setTopic] = useState(typeof saved.topic === 'string' ? saved.topic : '');
  const [style, setStyle] = useState<string>(
    typeof saved.style === 'string' ? saved.style : WECHAT_MP_ARTICLE_STYLES[0]
  );
  const [count, setCount] = useState<number>(typeof saved.count === 'number' ? saved.count : 1);

  // ---- 凭证区(专用 /api/wechat-mp route;secret 永不回传) ----
  const [cred, setCred] = useState<CredState | null>(null); // null = 加载中
  const [credential, setCredential] = useState('');
  const [credBusy, setCredBusy] = useState(false);
  const [credOk, setCredOk] = useState<string | null>(null);
  const [credErr, setCredErr] = useState<string | null>(null);

  const loadCred = useCallback(async () => {
    try {
      const res = await fetch('/api/wechat-mp');
      const data = await res.json();
      if (data.success) {
        setCred({
          configured: Boolean(data.configured),
          appId: data.appId,
          dailyLimit: data.dailyLimit,
          todayCount: data.todayCount,
        });
      } else {
        setCred({ configured: false });
      }
    } catch {
      setCred({ configured: false });
    }
  }, []);

  useEffect(() => {
    loadCred();
  }, [loadCred]);

  const postCred = (body: Record<string, unknown>) =>
    fetch('/api/wechat-mp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  /** 保存并测试:save(格式校验前置)→ check(真实打微信接口,错误白话回显) */
  const handleSaveAndCheck = async () => {
    setCredBusy(true);
    setCredOk(null);
    setCredErr(null);
    try {
      const saved = await postCred({ action: 'save', credential: credential.trim() });
      if (!saved.success) {
        setCredErr(saved.error || '保存失败');
        return;
      }
      const checked = await postCred({ action: 'check' });
      if (checked.ok) {
        setCredOk(`凭证有效 · AppID ${checked.appId || ''}`);
        setCredential('');
        await loadCred();
      } else {
        setCredErr(checked.error || '凭证校验未通过,请核对后重试');
      }
    } catch {
      setCredErr('请求失败,请稍后重试');
    } finally {
      setCredBusy(false);
    }
  };

  const handleCheck = async () => {
    setCredBusy(true);
    setCredOk(null);
    setCredErr(null);
    try {
      const checked = await postCred({ action: 'check' });
      if (checked.ok) setCredOk(`凭证有效 · AppID ${checked.appId || ''}`);
      else setCredErr(checked.error || '凭证校验未通过');
    } catch {
      setCredErr('请求失败,请稍后重试');
    } finally {
      setCredBusy(false);
    }
  };

  const handleClear = async () => {
    setCredBusy(true);
    setCredOk(null);
    setCredErr(null);
    try {
      await postCred({ action: 'clear' });
      setCredOk(null);
      await loadCred();
    } catch {
      setCredErr('请求失败,请稍后重试');
    } finally {
      setCredBusy(false);
    }
  };

  const params = { topic, style, count };
  const preview = buildWorkshopRun(
    workshop.id,
    params,
    scenarioProfile ? { scenarioProfile } : undefined
  );

  const handleSubmit = () => {
    recordRun(workshop.id, preview.title, params);
    onRun(preview.prompt, preview.title);
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
          {WECHAT_MP_TOPIC_PRESETS.map((p) => (
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
              : '留空则由 Agent 抓知乎热榜/搜索热点自动选题,如:AI 工具月度盘点'
          }
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel>文章风格</FieldLabel>
        <ChipGroup
          options={WECHAT_MP_ARTICLE_STYLES.map((s) => ({ id: s, name: s }))}
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

      {/* 凭证配置区(scenario-loop:从连接器页搬入工坊;secret 永不回传) */}
      <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 space-y-2.5">
        <div className="flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5 text-violet-500" />
          <span className="text-xs font-medium text-zinc-700">公众号凭证 · 草稿箱直投</span>
        </div>

        {credErr && (
          <p className="text-[11px] text-red-600 leading-relaxed break-all">{credErr}</p>
        )}
        {credOk && (
          <p className="text-[11px] text-emerald-600 leading-relaxed break-all">{credOk}</p>
        )}

        {cred?.configured ? (
          <div className="space-y-2">
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              已配置{cred.appId ? ` · AppID ${cred.appId}` : ''}
              {typeof cred.dailyLimit === 'number' ? ` · 今日投草稿 ${cred.todayCount ?? 0}/${cred.dailyLimit} 次` : ''}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCheck}
                disabled={credBusy}
                className="px-3 py-1 rounded-lg text-[11px] font-medium bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300 transition disabled:opacity-50"
              >
                {credBusy ? '测试中…' : '测试连接'}
              </button>
              <button
                type="button"
                onClick={handleClear}
                disabled={credBusy}
                className="px-3 py-1 rounded-lg text-[11px] text-zinc-400 hover:text-red-500 transition disabled:opacity-50"
              >
                清除凭证
              </button>
            </div>
          </div>
        ) : cred ? (
          <div className="space-y-2">
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder="AppID:AppSecret"
              className={inputClass}
              autoComplete="off"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-zinc-400 leading-relaxed">
                需已认证公众号;服务器 IP 需加入公众平台 IP 白名单。未配置不阻塞创作,投草稿时 Agent 会提示。
              </span>
              <button
                type="button"
                onClick={handleSaveAndCheck}
                disabled={credBusy || !credential.trim()}
                className="shrink-0 px-3 py-1 rounded-lg text-[11px] font-medium text-white bg-violet-600 hover:bg-violet-700 transition shadow-xs disabled:opacity-50"
              >
                {credBusy ? '测试中…' : '保存并测试'}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-zinc-400">凭证状态加载中…</p>
        )}
      </div>
    </WorkshopModalShell>
  );
}
