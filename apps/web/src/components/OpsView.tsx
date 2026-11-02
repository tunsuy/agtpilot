'use client';

/**
 * 运营看板(admin-only,桌面端)。数据源 /api/ops/overview(ops 流水聚合)。
 *
 * 隐私口径:只展示聚合指标与用户身份字段(昵称/邮箱/userId/活跃/用量),
 * 不展示任何任务标题或会话内容。
 *
 * 图表为手写 div 柱图(web 端无图表库,不新增依赖):
 * - 双系列堆叠(完成=蓝 #2a78d6 / 失败=红 #d03b3b,dataviz 校验器全过:
 *   CVD ΔE 23.8、对比度 ≥3:1),段间 2px 表面间隙、数据端 4px 圆角;
 * - 单轴(指标切换而非双 y 轴),悬停逐柱 tooltip,图例常驻;
 * - 文字一律 zinc 墨色 token,颜色只出现在 mark 上。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, RefreshCw, AlertTriangle } from 'lucide-react';

interface DailyPoint {
  date: string;
  missions: number;
  activeUsers: number;
  tokens: number;
  failures: number;
}

interface UserRow {
  userId: string;
  name?: string;
  email?: string;
  firstSeen: number;
  lastActive: number;
  missions: number;
  tokens: number;
  failed: number;
}

interface OpsData {
  daily: DailyPoint[];
  users: UserRow[];
  totals: {
    users: number;
    windowMissions: number;
    windowTokens: number;
    windowFailures: number;
    windowActiveUsers: number;
    todayMissions: number;
    todayActiveUsers: number;
    todayTokens: number;
    todayFailures: number;
  };
  bySource: Record<string, number>;
  byOutcome: Record<string, number>;
}

const SERIES_DONE = '#2a78d6';
const SERIES_FAILED = '#d03b3b';

type Metric = 'missions' | 'activeUsers' | 'tokens';

const METRIC_LABELS: Record<Metric, string> = {
  missions: '任务量',
  activeUsers: '活跃用户',
  tokens: 'Tokens',
};

const SOURCE_LABELS: Record<string, string> = {
  chat: '对话',
  workshop: '工坊',
  cron: '巡航',
  channel: 'IM 通道',
  background: '后台子任务',
};

const OUTCOME_LABELS: Record<string, string> = {
  done: '完成',
  failed: '失败',
  aborted: '用户终止',
  interrupted: '重启中断',
};

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shortId(userId: string): string {
  return userId.length > 14 ? `${userId.slice(0, 10)}…` : userId;
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'danger' }) {
  return (
    <div className="bg-white rounded-2xl border border-zinc-200/70 shadow-2xs px-5 py-4 flex flex-col gap-1">
      <span className="text-xs font-medium text-zinc-500">{label}</span>
      <span className={`text-2xl font-semibold tracking-tight ${accent === 'danger' ? 'text-red-600' : 'text-zinc-900'}`}>
        {value}
      </span>
      {sub && <span className="text-[11px] text-zinc-400">{sub}</span>}
    </div>
  );
}

/** 30 天逐日柱图(手写;堆叠双系列 + 悬停 tooltip) */
function DailyBarChart({ daily, metric }: { daily: DailyPoint[]; metric: Metric }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const values = useMemo(
    () =>
      daily.map((d) =>
        metric === 'missions' ? d.missions : metric === 'activeUsers' ? d.activeUsers : d.tokens
      ),
    [daily, metric]
  );
  const max = Math.max(1, ...values);

  return (
    <div className="relative">
      {/* 图例(双系列常驻;单指标时标题即系列名,但堆叠含失败段,图例必配) */}
      <div className="flex items-center gap-4 mb-3 text-[11px] text-zinc-500">
        {metric === 'missions' ? (
          <>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES_DONE }} />
              完成
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES_FAILED }} />
              失败
            </span>
          </>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES_DONE }} />
            {METRIC_LABELS[metric]}
          </span>
        )}
        <span className="ml-auto font-mono text-zinc-400">峰值 {fmtNum(max)}</span>
      </div>

      {/* 绘图区:网格线(弱化 hairline)+ 柱列 */}
      <div className="relative h-44">
        {/* 中线/基线 */}
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-zinc-100" />
        <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-zinc-100" />
        <div className="absolute inset-x-0 bottom-0 border-t border-zinc-200" />

        <div className="absolute inset-0 flex items-end gap-[3px]">
          {daily.map((d, i) => {
            const doneVal = metric === 'missions' ? d.missions - d.failures : metric === 'activeUsers' ? d.activeUsers : d.tokens;
            const failVal = metric === 'missions' ? d.failures : 0;
            const doneH = (Math.max(0, doneVal) / max) * 100;
            const failH = (failVal / max) * 100;
            const isHover = hoverIdx === i;
            return (
              <div
                key={d.date}
                className="relative flex-1 h-full flex flex-col justify-end cursor-default"
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
              >
                {/* 悬停列高亮(hit target 大于 mark) */}
                {isHover && <div className="absolute inset-0 rounded-md bg-zinc-900/[0.04]" />}
                {/* 失败段(顶,4px 圆角数据端) */}
                {failH > 0 && (
                  <div
                    className="w-full mx-auto"
                    style={{
                      height: `${failH}%`,
                      background: SERIES_FAILED,
                      borderRadius: '4px 4px 0 0',
                      maxWidth: 22,
                      alignSelf: 'center',
                    }}
                  />
                )}
                {/* 完成段(底;与失败段之间 2px 表面间隙,无失败段时顶端圆角) */}
                {doneH > 0 && (
                  <div
                    className="w-full"
                    style={{
                      height: `calc(${doneH}% - ${failH > 0 ? 2 : 0}px)`,
                      background: SERIES_DONE,
                      borderRadius: failH > 0 ? 0 : '4px 4px 0 0',
                      maxWidth: 22,
                      alignSelf: 'center',
                      marginTop: failH > 0 ? 2 : 0,
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* tooltip(跟随悬停列) */}
        {hoverIdx !== null && (
          <div
            className="absolute z-10 -top-1 pointer-events-none px-2.5 py-1.5 rounded-lg bg-zinc-900 text-white text-[11px] leading-relaxed shadow-lg whitespace-nowrap"
            style={{
              left: `${(hoverIdx / Math.max(1, daily.length)) * 100}%`,
              transform: `translateX(${hoverIdx > daily.length * 0.7 ? '-100%' : hoverIdx < daily.length * 0.3 ? '0' : '-50%'})`,
            }}
          >
            <div className="font-mono text-zinc-300">{daily[hoverIdx].date}</div>
            <div>任务 {daily[hoverIdx].missions}(失败 {daily[hoverIdx].failures})</div>
            <div>活跃用户 {daily[hoverIdx].activeUsers}</div>
            <div>tokens {fmtNum(daily[hoverIdx].tokens)}</div>
          </div>
        )}
      </div>

      {/* x 轴刻度(每 5 天一标,首尾必标) */}
      <div className="flex justify-between mt-1.5 text-[10px] font-mono text-zinc-400">
        {daily
          .map((d, i) => ({ d, i }))
          .filter(({ i }) => i % 5 === 0 || i === daily.length - 1)
          .map(({ d }) => (
            <span key={d.date}>{d.date.slice(5)}</span>
          ))}
      </div>
    </div>
  );
}

export function OpsView() {
  const [data, setData] = useState<OpsData | null>(null);
  const [metric, setMetric] = useState<Metric>('missions');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ops/overview?days=30');
      if (res.status === 403) {
        setError('无权限:运营看板仅对管理员开放。');
        return;
      }
      const json = await res.json();
      if (json?.success && json.ops) setData(json.ops as OpsData);
      else setError('数据加载失败。');
    } catch {
      setError('网络错误,请稍后重试。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const failureRate = useMemo(() => {
    if (!data || data.totals.windowMissions <= 0) return null;
    return ((data.totals.windowFailures / data.totals.windowMissions) * 100).toFixed(1);
  }, [data]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-zinc-900 flex items-center justify-center">
            <BarChart3 className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">运营看板</h1>
            <p className="text-xs text-zinc-500">近 30 天用户活跃 · 用量趋势 · 质量成本(仅聚合数据,不含任务内容)</p>
          </div>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-zinc-100 hover:bg-zinc-200/80 text-zinc-700 border border-zinc-200/70 transition shadow-2xs disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-24 text-sm text-zinc-400">加载中…</div>
      )}

      {data && (
        <>
          {/* KPI 行 */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="总用户" value={fmtNum(data.totals.users)} sub="账本内出现过的用户" />
            <StatCard label="今日活跃" value={fmtNum(data.totals.todayActiveUsers)} sub={`30 天活跃 ${fmtNum(data.totals.windowActiveUsers)}`} />
            <StatCard label="今日任务" value={fmtNum(data.totals.todayMissions)} sub={`30 天 ${fmtNum(data.totals.windowMissions)}`} />
            <StatCard label="今日 tokens" value={fmtNum(data.totals.todayTokens)} sub={`30 天 ${fmtNum(data.totals.windowTokens)}`} />
            <StatCard
              label="30 天失败率"
              value={failureRate === null ? '—' : `${failureRate}%`}
              sub={`失败 ${fmtNum(data.totals.windowFailures)} / 今日失败 ${data.totals.todayFailures}`}
              accent={failureRate !== null && Number(failureRate) >= 10 ? 'danger' : undefined}
            />
          </div>

          {/* 趋势图 */}
          <div className="bg-white rounded-2xl border border-zinc-200/70 shadow-2xs px-5 py-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-zinc-900">每日趋势</h2>
              {/* 指标切换(单轴;不同量纲不共轴,切换而非双 y 轴) */}
              <div className="flex items-center gap-1 bg-zinc-100 p-0.5 rounded-lg">
                {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMetric(m)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition ${
                      metric === m ? 'bg-white text-zinc-900 shadow-xs font-semibold' : 'text-zinc-500 hover:text-zinc-800'
                    }`}
                  >
                    {METRIC_LABELS[m]}
                  </button>
                ))}
              </div>
            </div>
            <DailyBarChart daily={data.daily} metric={metric} />
          </div>

          {/* 来源分布 + 结局分布 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="bg-white rounded-2xl border border-zinc-200/70 shadow-2xs px-5 py-4">
              <h2 className="text-sm font-semibold text-zinc-900 mb-3">任务来源(30 天)</h2>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.bySource)
                  .filter(([, n]) => n > 0)
                  .map(([src, n]) => (
                    <span key={src} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-50 border border-zinc-200/80 text-xs text-zinc-600">
                      {SOURCE_LABELS[src] || src}
                      <span className="font-mono font-semibold text-zinc-900">{n}</span>
                    </span>
                  ))}
                {Object.values(data.bySource).every((n) => n === 0) && (
                  <span className="text-xs text-zinc-400">暂无数据</span>
                )}
              </div>
            </div>
            <div className="bg-white rounded-2xl border border-zinc-200/70 shadow-2xs px-5 py-4">
              <h2 className="text-sm font-semibold text-zinc-900 mb-3">任务结局(30 天)</h2>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.byOutcome)
                  .filter(([, n]) => n > 0)
                  .map(([oc, n]) => (
                    <span
                      key={oc}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs ${
                        oc === 'failed'
                          ? 'bg-red-50 border-red-200 text-red-700'
                          : oc === 'done'
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                            : 'bg-zinc-50 border-zinc-200/80 text-zinc-600'
                      }`}
                    >
                      {OUTCOME_LABELS[oc] || oc}
                      <span className="font-mono font-semibold">{n}</span>
                    </span>
                  ))}
                {Object.values(data.byOutcome).every((n) => n === 0) && (
                  <span className="text-xs text-zinc-400">暂无数据</span>
                )}
              </div>
            </div>
          </div>

          {/* 用户表(表视图即图表数据的表格兜底;不含任务标题/内容) */}
          <div className="bg-white rounded-2xl border border-zinc-200/70 shadow-2xs overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100">
              <h2 className="text-sm font-semibold text-zinc-900">用户明细</h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">按最近活跃排序 · 累计口径为账本生命周期内(流水滚动截断后如实呈现)</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-zinc-400 border-b border-zinc-100">
                    <th className="px-5 py-2.5 font-medium">用户</th>
                    <th className="px-3 py-2.5 font-medium">userId</th>
                    <th className="px-3 py-2.5 font-medium">首次出现</th>
                    <th className="px-3 py-2.5 font-medium">最近活跃</th>
                    <th className="px-3 py-2.5 font-medium text-right">任务</th>
                    <th className="px-3 py-2.5 font-medium text-right">tokens</th>
                    <th className="px-5 py-2.5 font-medium text-right">失败</th>
                  </tr>
                </thead>
                <tbody className="[&_td]:tabular-nums">
                  {data.users.map((u) => (
                    <tr key={u.userId} className="border-b border-zinc-50 hover:bg-zinc-50/60 transition-colors">
                      <td className="px-5 py-2.5">
                        <div className="font-medium text-zinc-900">{u.name || '(未记录昵称)'}</div>
                        {u.email && <div className="text-[11px] text-zinc-400">{u.email}</div>}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-zinc-400" title={u.userId}>
                        {shortId(u.userId)}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-zinc-500">{fmtDate(u.firstSeen)}</td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-zinc-500">{fmtDate(u.lastActive)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-zinc-700">{u.missions}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-zinc-700">{fmtNum(u.tokens)}</td>
                      <td className={`px-5 py-2.5 text-right font-mono ${u.failed > 0 ? 'text-red-600 font-semibold' : 'text-zinc-300'}`}>
                        {u.failed}
                      </td>
                    </tr>
                  ))}
                  {data.users.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-5 py-8 text-center text-zinc-400">
                        暂无用户数据
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
