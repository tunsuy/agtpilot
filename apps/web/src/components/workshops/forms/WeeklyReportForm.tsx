/**
 * 周报生成工坊表单:周期 / 读者 / 投递 / 口述补充要点。
 */
import { useState } from 'react';
import {
  WEEKLY_REPORT_PERIODS,
  WEEKLY_REPORT_AUDIENCES,
  WEEKLY_REPORT_DELIVERIES,
} from '../../../lib/office-workshops';
import type { WorkshopDef } from '../registry';
import { buildWorkshopRun } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ChipGroup, FieldLabel, WorkshopModalShell, textareaClass } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string) => void | Promise<void>;
  onClose: () => void;
}

export function WeeklyReportForm({ workshop, onRun, onClose }: Props) {
  const saved = lastRunOf(workshop.id)?.params || {};

  const [period, setPeriod] = useState<string>(
    typeof saved.period === 'string' ? saved.period : 'this_week'
  );
  const [audience, setAudience] = useState<string>(
    typeof saved.audience === 'string' ? saved.audience : 'leader'
  );
  const [delivery, setDelivery] = useState<string>(
    typeof saved.delivery === 'string' ? saved.delivery : 'chat'
  );
  const [extras, setExtras] = useState(typeof saved.extras === 'string' ? saved.extras : '');

  const params = { period, audience, delivery, extras };
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
      submitLabel="生成周报"
      previewPrompt={preview.prompt}
    >
      <div className="space-y-1.5">
        <FieldLabel>周报周期</FieldLabel>
        <ChipGroup
          options={WEEKLY_REPORT_PERIODS.map((p) => ({ id: p.id, name: p.name }))}
          value={period as never}
          onChange={setPeriod}
          accent={workshop.accent}
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel>写给谁看</FieldLabel>
        <ChipGroup
          options={WEEKLY_REPORT_AUDIENCES.map((a) => ({ id: a.id, name: a.name }))}
          value={audience as never}
          onChange={setAudience}
          accent={workshop.accent}
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel>投递方式</FieldLabel>
        <ChipGroup
          options={WEEKLY_REPORT_DELIVERIES.map((d) => ({ id: d.id, name: d.name }))}
          value={delivery as never}
          onChange={setDelivery}
          accent={workshop.accent}
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel optional>补充要点</FieldLabel>
        <textarea
          value={extras}
          onChange={(e) => setExtras(e.target.value)}
          rows={2}
          placeholder="口述数据源里没有的工作，直接纳入周报，如：本周主导了 X 项目上线、协调了 Y 部门…"
          className={textareaClass}
        />
      </div>
    </WorkshopModalShell>
  );
}
