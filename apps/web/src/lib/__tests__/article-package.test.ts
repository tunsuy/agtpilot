import { describe, it, expect } from 'vitest';
import { parseArticlePackages, buildArticlePackageCopyText, buildArticlePackageReplyText } from '../article-package';
import { parseNotePackages } from '../note-package';

const LONG_BODY = '这是一篇关于大模型落地实践的深度长文正文,讨论工程化路径与真实收益,内容必须超过一百字才能被判定为有效的文章包,所以这里把正文写得足够长以便通过有效性校验。'.repeat(
  2
);

const singlePackage = `【标题候选】
1. 大模型落地:别再谈概念了
2. 从 demo 到生产的三道坎
3. 工程化视角看 LLM
【摘要】
大模型落地的关键不在模型本身,而在工程化路径的选择。
【正文】
${LONG_BODY}
【封面建议】
深色背景 + 抽象神经网络线条,理性克制。
【发布建议】
工作日晚 8-10 点,科技读者活跃时段。`;

describe('parseArticlePackages · 标准格式', () => {
  it('单篇全字段解析:标题去序号、摘要必中、正文完整', () => {
    const { packages, fallback } = parseArticlePackages(singlePackage);
    expect(fallback).toBeNull();
    expect(packages).toHaveLength(1);
    const pkg = packages[0];
    expect(pkg.index).toBe(1);
    expect(pkg.titles).toEqual(['大模型落地:别再谈概念了', '从 demo 到生产的三道坎', '工程化视角看 LLM']);
    expect(pkg.digest).toBe('大模型落地的关键不在模型本身,而在工程化路径的选择。');
    expect(pkg.body).toContain(LONG_BODY);
    expect(pkg.coverIdea).toContain('深色背景');
    expect(pkg.publishAdvice).toContain('晚 8-10 点');
  });

  it('两篇以 --- 分隔,篇号递增', () => {
    const text = [singlePackage, singlePackage].join('\n---\n');
    const { packages, fallback } = parseArticlePackages(text);
    expect(fallback).toBeNull();
    expect(packages.map((p) => p.index)).toEqual([1, 2]);
  });

  it('开头寒暄归 fallback;不丢内容', () => {
    const text = `好的,以下是本期的文章包:\n---\n${singlePackage}`;
    const { packages, fallback } = parseArticlePackages(text);
    expect(packages).toHaveLength(1);
    expect(fallback).toBe('好的,以下是本期的文章包:');
  });

  it('字段头变体:【标题】【内容摘要】【封面文案】【发布提示】均能识别', () => {
    const variant = `【标题】
变体标题
【内容摘要】
变体摘要一句话。
【正文】
${LONG_BODY}
【封面文案】
封面一句话
【发布提示】
周五晚发布`;
    const { packages } = parseArticlePackages(variant);
    expect(packages).toHaveLength(1);
    expect(packages[0].titles).toEqual(['变体标题']);
    expect(packages[0].digest).toBe('变体摘要一句话。');
    expect(packages[0].coverIdea).toBe('封面一句话');
    expect(packages[0].publishAdvice).toBe('周五晚发布');
  });

  it('可选字段缺失(封面/发布建议)仍成包', () => {
    const minimal = `【标题候选】
只有标题的包
【摘要】
必须有摘要。
【正文】
${LONG_BODY}`;
    const { packages } = parseArticlePackages(minimal);
    expect(packages).toHaveLength(1);
    expect(packages[0].coverIdea).toBeUndefined();
    expect(packages[0].publishAdvice).toBeUndefined();
  });
});

describe('parseArticlePackages · 与笔记包互斥(渲染顺序锚)', () => {
  it('反证①:笔记包形状(无【摘要】)→ parseArticlePackages 不产出文章包', () => {
    // 笔记包字段头:标题候选/封面文案/正文/标签/发布建议,缺摘要键
    const noteShape = `【标题候选】
1. 平价通勤穿搭
【封面文案】
3 件单品穿一周
【正文】
${'笔记包正文,与文章包字段头高度重合,但没有摘要字段。'.repeat(4)}
【标签】
#穿搭 #ootd
【发布建议】
早高峰发布`;
    const { packages } = parseArticlePackages(noteShape);
    expect(packages).toHaveLength(0);
  });

  it('反证②:文章包样例喂 parseNotePackages 会被误判为笔记包 → 渲染必须 article 先于 note', () => {
    // 四个字段头(标题候选/封面建议/正文/发布建议)全在 note-package 的 FIELD_HEADERS 里,
    // 仅【摘要】不在 → 若 note 先判定,文章包会被误渲染成笔记包(缺标签降级)。此用例固化顺序约定。
    const { packages: notePackages } = parseNotePackages(singlePackage);
    expect(notePackages).toHaveLength(1);
    expect(notePackages[0].tags).toEqual([]); // 文章包无标签字段,note 侧拿不到
    // 而文章包侧能完整解析 → CockpitView 判定顺序 picks → article → note 是唯一正确顺序
    const { packages: articlePackages } = parseArticlePackages(singlePackage);
    expect(articlePackages).toHaveLength(1);
    expect(articlePackages[0].digest).toBeTruthy();
  });
});

describe('parseArticlePackages · 容错', () => {
  it('正文去空白不足 100 字的块不成文章包,整体进 fallback', () => {
    const short = `【标题候选】
标题
【摘要】
摘要。
【正文】
太短了
【发布建议】
随时`;
    const { packages, fallback } = parseArticlePackages(short);
    expect(packages).toHaveLength(0);
    expect(fallback).not.toBeNull();
    expect(fallback).toContain('太短了');
  });

  it('纯自由文本(无字段头)→ packages 为空、fallback 全文(调用方降级)', () => {
    const text = '今天聊一下大模型落地,首先要看……' + '没有结构的长文本。'.repeat(10);
    const { packages, fallback } = parseArticlePackages(text);
    expect(packages).toHaveLength(0);
    expect(fallback).toBe(text.trim());
  });

  it('空文本返回空结果', () => {
    expect(parseArticlePackages('')).toEqual({ packages: [], fallback: null });
    expect(parseArticlePackages('   \n  ')).toEqual({ packages: [], fallback: null });
  });
});

describe('buildArticlePackageCopyText', () => {
  const pkg = parseArticlePackages(singlePackage).packages[0];

  it('默认取第一个标题,按 标题-摘要-正文 顺序空行分隔(封面/发布建议不进整卡)', () => {
    const text = buildArticlePackageCopyText(pkg);
    expect(text).toBe(`大模型落地:别再谈概念了\n\n大模型落地的关键不在模型本身,而在工程化路径的选择。\n\n${LONG_BODY}`);
    expect(text).not.toContain('深色背景');
  });

  it('可指定标题索引;索引越界回落末位', () => {
    expect(buildArticlePackageCopyText(pkg, 1).startsWith('从 demo 到生产的三道坎')).toBe(true);
    expect(buildArticlePackageCopyText(pkg, 99).startsWith('工程化视角看 LLM')).toBe(true);
  });
});

describe('buildArticlePackageReplyText(投草稿箱续聊指令)', () => {
  const pkg = parseArticlePackages(singlePackage).packages[0];

  it('含工具名/审批确认/人工发布,以及逐字内嵌的 title/digest/markdown', () => {
    const text = buildArticlePackageReplyText(pkg, 0);
    expect(text).toContain('wechat_mp_create_draft');
    expect(text).toContain('审批确认');
    expect(text).toContain('人工完成');
    expect(text).toContain('title:大模型落地:别再谈概念了');
    expect(text).toContain('digest:大模型落地的关键不在模型本身,而在工程化路径的选择。');
    expect(text).toContain(`markdown:\n${LONG_BODY}`);
    // 不传 cover_url 的指示(封面自动生成)
    expect(text).toContain('不传 cover_url');
  });

  it('titleIndex 选中哪条标题,内嵌的就是哪条', () => {
    expect(buildArticlePackageReplyText(pkg, 2)).toContain('title:工程化视角看 LLM');
  });
});
