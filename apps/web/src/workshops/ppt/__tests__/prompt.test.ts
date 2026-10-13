import { describe, it, expect } from 'vitest';
import {
  buildPptWorkshopPrompt,
  BENTO_SKILL_DIR,
  PPT_MASTER_SKILL_DIR,
  PPT_MASTER_PYTHON,
  PPT_PURPOSES,
  PPT_STYLES,
  PPT_PAGE_OPTIONS,
  PPT_OUTPUTS,
} from '../prompt';

describe('buildPptWorkshopPrompt · skill 工作流契约', () => {
  it('固定 skill 路径、构建命令与关键参数写进 prompt', () => {
    const prompt = buildPptWorkshopPrompt({ topic: 'Q3 业务汇报', purpose: 'report', style: 'business', pages: 12 });
    expect(prompt).toContain(BENTO_SKILL_DIR);
    expect(prompt).toContain('scripts/bento_deck.py build ppt/deck.json');
    expect(prompt).toContain('--new-document');
    expect(prompt).toContain('ppt/reports/deck-validation.json');
    // 规范阅读清单(SKILL.md / format / 范例),防止凭记忆发明字段
    expect(prompt).toContain('SKILL.md');
    expect(prompt).toContain('bento-format.md');
    expect(prompt).toContain('Minimal valid document');
    expect(prompt).toContain('qiaomu-bento-ppt-intro.json');
  });

  it('发布走 ppt_publish_deck,严禁大 HTML 回显进 artifact_render', () => {
    const prompt = buildPptWorkshopPrompt({ topic: 'x', purpose: 'report', style: 'business', pages: 12 });
    expect(prompt).toContain('ppt_publish_deck');
    expect(prompt).toContain('ppt/deck.bento.html');
    expect(prompt).toContain('严禁把 .bento.html 内容粘贴进 artifact_render');
    // 环境自检 + 降级路线(本地开发无 skill 时仍可出片)
    expect(prompt).toContain('ppt_check_env');
    expect(prompt).toContain('降级路线');
    expect(prompt).toContain('type=html');
  });

  it('bento 格式硬约束进 prompt:纯 JSON chart / 离线 / docId 交给构建', () => {
    const prompt = buildPptWorkshopPrompt({ topic: 'x', purpose: 'data', style: 'dark', pages: 20 });
    expect(prompt).toContain('纯 JSON');
    expect(prompt).toContain('禁止函数 formatter');
    expect(prompt).toContain('严禁外链图片/字体/媒体');
    expect(prompt).toContain('不手写 docId');
    expect(prompt).toContain('1280×720');
    expect(prompt).toContain('speaker notes');
  });
});

describe('buildPptWorkshopPrompt · 用户选项映射', () => {
  it('主题/用途/风格/页数逐项落入 prompt', () => {
    const prompt = buildPptWorkshopPrompt({ topic: 'AI 客服产品发布', purpose: 'launch', style: 'dark', pages: 20 });
    expect(prompt).toContain('主题:AI 客服产品发布');
    expect(prompt).toContain('产品发布');
    expect(prompt).toContain('叙事型');
    expect(prompt).toContain('深色');
    expect(prompt).toContain('约 20 页');
  });

  it('页数非法值钳回默认 12', () => {
    const prompt = buildPptWorkshopPrompt({ topic: 'x', purpose: 'report', style: 'business', pages: 999 });
    expect(prompt).toContain('约 12 页');
  });

  it('材料段:有材料时原文入 prompt 且约束「不得改变事实」', () => {
    const prompt = buildPptWorkshopPrompt({
      topic: '季度复盘',
      material: '本季度 GMV 1.2 亿,同比 +18%。',
      purpose: 'report',
      style: 'business',
      pages: 8,
    });
    expect(prompt).toContain('本季度 GMV 1.2 亿,同比 +18%。');
    expect(prompt).toContain('不得改变事实与数据');
  });

  it('无主题:要求先问用户,不许凭空自拟;无材料:声明数据须真实', () => {
    const prompt = buildPptWorkshopPrompt({ purpose: 'report', style: 'business', pages: 12 });
    expect(prompt).toContain('主题:未指定');
    expect(prompt).toContain('先在对话里问我');
    expect(prompt).toContain('材料:未提供');
    expect(prompt).toContain('数据必须真实');
  });

  it('pptx 选项:走 ppt-master Quick 契约(路径/命令/无交互声明齐备)', () => {
    const prompt = buildPptWorkshopPrompt({ topic: 'x', purpose: 'report', style: 'business', pages: 12, output: 'pptx' });
    expect(prompt).toContain('【PPT 演示稿工坊 · PPTX 文件(ppt-master)】');
    expect(prompt).toContain(PPT_MASTER_SKILL_DIR);
    expect(prompt).toContain(PPT_MASTER_PYTHON);
    // Quick Generate:全程无交互,不生成 spec/lock
    expect(prompt).toContain('Quick Generate');
    expect(prompt).toContain('全程无交互');
    expect(prompt).toContain('design_spec.md / spec_lock.md');
    // 完整性门禁 + 执行权威文档
    expect(prompt).toContain('attribution_guard.py');
    expect(prompt).toContain('quick-generate.md');
    // 关键命令链(已在真 skill 上冒烟验证)
    expect(prompt).toContain('init deck --quick-generate --dir ppt');
    expect(prompt).toContain('import-sources');
    expect(prompt).toContain('text_measure.py calibrate');
    expect(prompt).toContain('--quick-generate --canonical-authoring --stage final --json');
    expect(prompt).toContain('total_md_split.py');
    expect(prompt).toContain('svg_to_pptx.py <project_path> --quick-generate --with-notes');
    expect(prompt).toContain('exports/*.pptx');
    // 页数 ≥7 的早期质检门
    expect(prompt).toContain('--stage early');
  });

  it('pptx 选项:发布走 ppt_publish_pptx,严禁二进制回显;SVG 画布契约进 prompt', () => {
    const prompt = buildPptWorkshopPrompt({ topic: 'x', purpose: 'report', style: 'business', pages: 12, output: 'pptx' });
    expect(prompt).toContain('ppt_publish_pptx');
    expect(prompt).toContain('严禁用 artifact_render 回显 .pptx 内容或 base64');
    expect(prompt).toContain('viewBox="0 0 1280 720"');
    expect(prompt).toContain('data-pptx-page-role');
    expect(prompt).toContain('lang="zh-CN"');
    expect(prompt).toContain('禁止 foreignObject');
    expect(prompt).toContain('Noto Sans CJK SC');
  });

  it('pptx 选项:附加红线(禁 finalize/音频/装依赖)+ 降级路线回退 bento', () => {
    const prompt = buildPptWorkshopPrompt({ topic: 'x', purpose: 'report', style: 'business', pages: 12, output: 'pptx' });
    expect(prompt).toContain('禁止运行 finalize_svg.py');
    expect(prompt).toContain('禁止生成 narration/音频/视频');
    expect(prompt).toContain('不装任何新依赖');
    // 环境缺失降级:先探测 bento,再走网页演示页流程
    expect(prompt).toContain('降级路线');
    expect(prompt).toContain('ppt_check_env');
    expect(prompt).toContain('ppt_publish_deck');
    expect(prompt).toContain(BENTO_SKILL_DIR);
    // 内容红线两条路线共用
    expect(prompt).toContain('内容红线');
    expect(prompt).toContain('不得编造');
    expect(prompt).toContain('missing evidence');
  });

  it('pptx 选项:用户选项段照常映射(主题/用途/风格/页数/材料)', () => {
    const prompt = buildPptWorkshopPrompt({
      topic: '季度复盘',
      material: '本季度 GMV 1.2 亿。',
      purpose: 'data',
      style: 'dark',
      pages: 20,
      output: 'pptx',
    });
    expect(prompt).toContain('主题:季度复盘');
    expect(prompt).toContain('数据看板型');
    expect(prompt).toContain('深色');
    expect(prompt).toContain('约 20 页');
    expect(prompt).toContain('本季度 GMV 1.2 亿。');
    expect(prompt).toContain('不得改变事实与数据');
  });

  it('bento 选项(默认):不携带 ppt-master 契约,保持原网页演示页流程', () => {
    const prompt = buildPptWorkshopPrompt({ topic: 'x', purpose: 'report', style: 'business', pages: 12 });
    expect(prompt).not.toContain(PPT_MASTER_SKILL_DIR);
    expect(prompt).not.toContain('ppt_publish_pptx');
    expect(prompt).toContain('【PPT 演示稿工坊 · 网页演示页(bento)】');
    const explicit = buildPptWorkshopPrompt({ topic: 'x', purpose: 'report', style: 'business', pages: 12, output: 'bento' });
    expect(explicit).toContain('【PPT 演示稿工坊 · 网页演示页(bento)】');
  });
});

describe('buildPptWorkshopPrompt · 内容红线', () => {
  it('红线四则齐备:不编造/注来源/大纲先行/离线单文件', () => {
    const prompt = buildPptWorkshopPrompt({ topic: 'x', purpose: 'report', style: 'business', pages: 12 });
    expect(prompt).toContain('内容红线');
    expect(prompt).toContain('不得编造');
    expect(prompt).toContain('数据来源或标注「示意数据」');
    expect(prompt).toContain('大纲先行');
    expect(prompt).toContain('deck-plan');
    expect(prompt).toContain('单文件离线可用');
    // missing evidence 诚实交付
    expect(prompt).toContain('missing evidence');
    expect(prompt).toContain('不得写成「已验证」');
  });
});

describe('PPT 工坊选项常量契约', () => {
  it('四个用途、三种风格、三档页数、两种输出形态,各自 id 不重复', () => {
    expect(PPT_PURPOSES).toHaveLength(4);
    expect(new Set(PPT_PURPOSES.map((p) => p.id)).size).toBe(4);
    expect(PPT_STYLES).toHaveLength(3);
    expect(new Set(PPT_STYLES.map((s) => s.id)).size).toBe(3);
    expect(PPT_PAGE_OPTIONS).toEqual([8, 12, 20]);
    expect(PPT_OUTPUTS.map((o) => o.id)).toEqual(['bento', 'pptx']);
  });
});
