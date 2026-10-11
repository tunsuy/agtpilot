/**
 * PPT 演示稿工坊表单:主题 / 材料 / 用途 / 风格 / 页数 / 输出形态。
 *
 * 输出形态双路线(S2 起全部开放):
 * - 网页演示页(bento,单文件 HTML,画布直接放映);
 * - PPTX 文件(ppt-master Quick 路线,原生可编辑 .pptx,画布下载卡片)。
 * 主题与材料都留空时不拦提交——Prompt 契约要求 Agent 先询问再动工。
 */
import { useState } from 'react';
import { PPT_PURPOSES, PPT_STYLES, PPT_PAGE_OPTIONS, PPT_OUTPUTS } from '../../../lib/ppt-workshop';
import type { WorkshopDef } from '../registry';
import { buildWorkshopRun } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ChipGroup, FieldLabel, WorkshopModalShell, inputClass, textareaClass } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string) => void | Promise<void>;
  onClose: () => void;
}

export function PptWorkshopForm({ workshop, onRun, onClose }: Props) {
  const saved = lastRunOf(workshop.id)?.params || {};

  const [topic, setTopic] = useState(typeof saved.topic === 'string' ? saved.topic : '');
  const [material, setMaterial] = useState(typeof saved.material === 'string' ? saved.material : '');
  const [purpose, setPurpose] = useState<string>(
    typeof saved.purpose === 'string' ? saved.purpose : PPT_PURPOSES[0].id
  );
  const [style, setStyle] = useState<string>(
    typeof saved.style === 'string' ? saved.style : PPT_STYLES[0].id
  );
  const [pages, setPages] = useState<number>(
    typeof saved.pages === 'number' ? saved.pages : 12
  );
  // 输出形态:bento 网页演示页(默认)/ pptx 真文件(S2 已接入)
  const [output, setOutput] = useState<string>(
    typeof saved.output === 'string' && PPT_OUTPUTS.some((o) => o.id === saved.output)
      ? saved.output
      : 'bento'
  );

  const params = { topic, material, purpose, style, pages, output };
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
      submitLabel="开始制作"
      previewPrompt={preview.prompt}
    >
      <div className="space-y-1.5">
        <FieldLabel optional>主题</FieldLabel>
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="如:Q3 业务复盘、AI 客服产品发布——留空则 Agent 先与你确认主题再动工"
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel optional>材料</FieldLabel>
        <textarea
          value={material}
          onChange={(e) => setMaterial(e.target.value)}
          rows={4}
          placeholder="可直接粘贴文档文字、要点或数据(内容以材料为准,Agent 不得改变事实与数据)"
          className={textareaClass}
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel>用途</FieldLabel>
        <ChipGroup
          options={PPT_PURPOSES.map((p) => ({ id: p.id, name: p.name }))}
          value={purpose}
          onChange={setPurpose}
          accent={workshop.accent}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <FieldLabel>风格</FieldLabel>
          <ChipGroup
            options={PPT_STYLES.map((s) => ({ id: s.id, name: s.name }))}
            value={style}
            onChange={setStyle}
            accent={workshop.accent}
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>页数(约)</FieldLabel>
          <ChipGroup
            options={PPT_PAGE_OPTIONS.map((n) => ({ id: n, name: `${n} 页` }))}
            value={pages}
            onChange={setPages}
            accent={workshop.accent}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <FieldLabel>输出形态</FieldLabel>
        <div className="flex flex-wrap gap-1.5">
          {PPT_OUTPUTS.map((o) => {
            const active = output === o.id;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => setOutput(o.id)}
                title={o.hint}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                  active
                    ? 'bg-sky-600 text-white border-sky-600'
                    : 'bg-white text-zinc-600 border-zinc-200 hover:border-sky-300 hover:text-sky-700'
                }`}
              >
                {o.name}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          {PPT_OUTPUTS.find((o) => o.id === output)?.hint}
        </p>
      </div>
    </WorkshopModalShell>
  );
}
