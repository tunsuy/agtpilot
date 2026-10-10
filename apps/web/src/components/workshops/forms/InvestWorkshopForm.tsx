/**
 * 投研工坊表单:模式(个股/组合/盘后) + 各模式专属字段 + 投递方式。
 */
import { useState } from 'react';
import {
  INVEST_MODES,
  REVIEW_MARKETS,
  RISK_PROFILES,
  INVEST_DELIVERIES,
} from '../../../lib/invest-workshops';
import type { WorkshopDef } from '../registry';
import { buildWorkshopRun } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ChipGroup, MultiChipGroup, FieldLabel, WorkshopModalShell, inputClass, textareaClass } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string) => void | Promise<void>;
  onClose: () => void;
}

export function InvestWorkshopForm({ workshop, onRun, onClose }: Props) {
  const saved = lastRunOf(workshop.id)?.params || {};

  const [mode, setMode] = useState<string>(
    typeof saved.mode === 'string' ? saved.mode : 'stock_check'
  );
  const [symbols, setSymbols] = useState(typeof saved.symbols === 'string' ? saved.symbols : '');
  const [focus, setFocus] = useState(typeof saved.focus === 'string' ? saved.focus : '');
  const [holdings, setHoldings] = useState(typeof saved.holdings === 'string' ? saved.holdings : '');
  const [risk, setRisk] = useState<string>(
    typeof saved.riskProfile === 'string' ? saved.riskProfile : 'balanced'
  );
  const [markets, setMarkets] = useState<string[]>(
    Array.isArray(saved.markets) ? (saved.markets as string[]) : ['a_share']
  );
  const [delivery, setDelivery] = useState<string>(
    typeof saved.delivery === 'string' ? saved.delivery : 'chat'
  );

  const toggleMarket = (id: string) =>
    setMarkets((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));

  const params = { mode, symbols, focus, holdings, riskProfile: risk, markets, delivery };
  const preview = buildWorkshopRun(workshop.id, params);

  const handleSubmit = () => {
    recordRun(workshop.id, preview.title, params);
    onRun(preview.prompt, preview.title);
  };

  return (
    <WorkshopModalShell
      def={workshop}
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel="开始分析"
      previewPrompt={preview.prompt}
    >
      <div className="space-y-1.5">
        <FieldLabel>投研模式</FieldLabel>
        <ChipGroup
          options={INVEST_MODES.map((m) => ({ id: m.id, name: m.name }))}
          value={mode as never}
          onChange={setMode}
          accent={workshop.accent}
        />
      </div>

      {mode === 'stock_check' && (
        <>
          <div className="space-y-1.5">
            <FieldLabel optional>体检标的</FieldLabel>
            <input
              type="text"
              value={symbols}
              onChange={(e) => setSymbols(e.target.value)}
              placeholder="逗号分隔，如：600519, 00700, AAPL, 110022, BTC（留空则任务里先问你）"
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel optional>额外关注点</FieldLabel>
            <input
              type="text"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="如：重点看分红稳定性、对比同行业估值、关注解禁压力"
              className={inputClass}
            />
          </div>
        </>
      )}

      {mode === 'portfolio_check' && (
        <>
          <div className="space-y-1.5">
            <FieldLabel optional>我的持仓</FieldLabel>
            <textarea
              value={holdings}
              onChange={(e) => setHoldings(e.target.value)}
              rows={3}
              placeholder={'自由格式，如：\n600519 100股 成本1680\nAAPL 50股\n110022 占比20%\nBTC 0.5个（留空则任务里先问你）'}
              className={textareaClass}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel>风险偏好</FieldLabel>
            <ChipGroup
              options={RISK_PROFILES.map((r) => ({ id: r.id, name: r.name }))}
              value={risk as never}
              onChange={setRisk}
              accent={workshop.accent}
            />
          </div>
        </>
      )}

      {mode === 'daily_review' && (
        <div className="space-y-1.5">
          <FieldLabel>覆盖市场（可多选）</FieldLabel>
          <MultiChipGroup
            options={REVIEW_MARKETS.map((m) => ({ id: m.id, name: m.name }))}
            values={markets}
            onToggle={toggleMarket}
            accent={workshop.accent}
          />
        </div>
      )}

      <div className="space-y-1.5">
        <FieldLabel>报告投递</FieldLabel>
        <ChipGroup
          options={INVEST_DELIVERIES.map((d) => ({ id: d.id, name: d.name }))}
          value={delivery as never}
          onChange={setDelivery}
          accent={workshop.accent}
        />
      </div>
    </WorkshopModalShell>
  );
}
