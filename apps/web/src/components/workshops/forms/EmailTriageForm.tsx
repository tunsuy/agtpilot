/**
 * 邮件分诊工坊表单:范围 / 特别关注 / 是否起草回复。
 */
import { useState } from 'react';
import { EMAIL_TRIAGE_SCOPES } from '../../../lib/office-workshops';
import type { WorkshopDef } from '../registry';
import { buildWorkshopRun } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ChipGroup, FieldLabel, WorkshopModalShell, inputClass } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string) => void | Promise<void>;
  onClose: () => void;
}

export function EmailTriageForm({ workshop, onRun, onClose }: Props) {
  const saved = lastRunOf(workshop.id)?.params || {};

  const [scope, setScope] = useState<string>(
    typeof saved.scope === 'string' ? saved.scope : 'unread'
  );
  const [focus, setFocus] = useState(typeof saved.focus === 'string' ? saved.focus : '');
  const [draft, setDraft] = useState(saved.draft !== false);

  const params = { scope, focus, draft };
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
      submitLabel="开始分诊"
      previewPrompt={preview.prompt}
    >
      <div className="space-y-1.5">
        <FieldLabel>分诊范围</FieldLabel>
        <ChipGroup
          options={EMAIL_TRIAGE_SCOPES.map((s) => ({ id: s.id, name: s.name }))}
          value={scope as never}
          onChange={setScope}
          accent={workshop.accent}
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel optional>特别关注</FieldLabel>
        <input
          type="text"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="如：老板的邮件、合同相关、面试候选人——命中的自动上调优先级"
          className={inputClass}
        />
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={draft}
          onChange={(e) => setDraft(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-zinc-300 accent-sky-600"
        />
        <span className="text-xs text-zinc-600">为高优邮件起草回复（发送前逐封经我确认）</span>
      </label>
    </WorkshopModalShell>
  );
}
