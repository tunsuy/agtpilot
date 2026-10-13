/**
 * PPT 演示稿工坊 · skill 包清单(平移自 components/workshops/{registry,run}.ts)。
 * skill 目录常量(BENTO_SKILL_DIR 等)也在此导出,ppt-deck 工具模块引用。
 */
import { Presentation } from 'lucide-react';
import { buildPptWorkshopPrompt, PPT_PURPOSES } from './context';
import { str, num } from '../shared/params';
import type { WorkshopSkill } from '../types';

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'ppt',
    name: 'PPT 演示稿工坊',
    category: 'office',
    desc: '主题/材料一键成稿:网页演示页画布直接放映,或 ppt-master 导出原生可编辑 .pptx',
    icon: Presentation,
    accent: 'sky',
    deps: [],
    note: '生成后跳转任务页,双路线按「输出形态」选择:① 网页演示页——镜像内置 qiaomu-bento-ppt skill(MIT,构建全程无需联网)产出单文件 .bento.html,中央画布直接放映,下载后双击离线放映、浏览器内可继续编辑;② PPTX 文件——镜像内置 ppt-master skill(MIT,Quick 无交互流程)手写 SVG 经质检导出原生可编辑 .pptx,画布下载卡片一键保存,PowerPoint/WPS/Keynote 可直接二改。大纲先行再排版;数据必须真实并注明来源,严禁编造;不引用外链媒体,保持交付物离线可用。',
  },
  run: (params) => {
    const purpose = str(params.purpose, 'report');
    return {
      prompt: buildPptWorkshopPrompt({
        topic: str(params.topic),
        material: str(params.material),
        purpose,
        style: str(params.style, 'business'),
        pages: num(params.pages, 12),
        output: str(params.output, 'bento'),
      }),
      title: `PPT 演示稿 · ${PPT_PURPOSES.find((p) => p.id === purpose)?.name || '演示页'}`,
    };
  },
};
