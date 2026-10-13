import { describe, it, expect } from 'vitest';
import { parseOssOpportunities, buildOssOpportunityCopyText } from '../oss-opportunities';
import { parseArticlePackages } from '../article-package';
import { parseNotePackages } from '../note-package';
import { parseTopicPicks } from '../topic-picks';

/** 标准两条机会清单(契约格式:【机会 N】+ 八字段头 + --- 分隔) */
const standard = `【机会 1】
1
【项目】
vllm-project/vllm
【项目简介】
高吞吐 LLM 推理引擎,star 45k,近一周 80+ 次提交。
【机会类型】
good first issue
【机会链接】
https://github.com/vllm-project/vllm/issues/12345
https://github.com/vllm-project/vllm/blob/main/CONTRIBUTING.md
【为什么适合你】
你主力是 Python + PyTorch,该 Issue 只涉及采样参数解析。
【建议第一步】
读 CONTRIBUTING 开发环境一节,本地跑通单测后在 Issue 下留言认领。
【难度】
低
---
【机会 2】
2
【项目】
langgenius/dify
【项目简介】
LLM 应用开发平台,star 90k,发版节奏每两周一次。
【机会类型】
文档改进
【机会链接】
https://github.com/langgenius/dify/issues/67890
【为什么适合你】
TypeScript 前端文档站,与你技术栈直接匹配。
【建议第一步】
先看该 Issue 里维护者列出的两处过期截图。
【难度】
低`;

describe('parseOssOpportunities · 标准格式', () => {
  it('两条机会全部字段解析', () => {
    const { opportunities, fallback } = parseOssOpportunities(standard);
    expect(opportunities).toHaveLength(2);
    expect(fallback).toBeNull();

    const [a, b] = opportunities;
    expect(a.number).toBe(1);
    expect(a.project).toBe('vllm-project/vllm');
    expect(a.summary).toContain('高吞吐 LLM 推理引擎');
    expect(a.kind).toBe('good first issue');
    expect(a.links).toEqual([
      'https://github.com/vllm-project/vllm/issues/12345',
      'https://github.com/vllm-project/vllm/blob/main/CONTRIBUTING.md',
    ]);
    expect(a.fit).toContain('Python + PyTorch');
    expect(a.firstStep).toContain('CONTRIBUTING');
    expect(a.difficulty).toBe('低');
    expect(b.number).toBe(2);
    expect(b.project).toBe('langgenius/dify');
  });

  it('块内未声明编号 → 按出现顺序 1..n 递补', () => {
    const noNumbers = standard
      .replace(/【机会 \d】\n\d\n/g, '');
    const { opportunities } = parseOssOpportunities(noNumbers);
    expect(opportunities).toHaveLength(2);
    expect(opportunities.map((o) => o.number)).toEqual([1, 2]);
  });

  it('【项目简介】归 summary 而非 project(字段头顺序陷阱)', () => {
    const { opportunities } = parseOssOpportunities(standard);
    expect(opportunities[0].project).toBe('vllm-project/vllm');
    expect(opportunities[0].project).not.toContain('推理引擎');
  });
});

describe('parseOssOpportunities · 链接提取', () => {
  it('多行链接、尾随标点剥除、去重', () => {
    const text = `【项目】
owner/repo
【项目简介】
测试项目,近期活跃提交频繁。
【机会链接】
- https://github.com/owner/repo/issues/1。
- https://github.com/owner/repo/issues/1
- https://github.com/owner/repo/issues/2,
【难度】
低`;
    const { opportunities } = parseOssOpportunities(text);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].links).toEqual([
      'https://github.com/owner/repo/issues/1',
      'https://github.com/owner/repo/issues/2',
    ]);
  });

  it('链接字段里混有说明文字也能提取 URL', () => {
    const text = `【项目】
owner/repo
【项目简介】
测试项目说明。
【机会链接】
认领前先看 https://github.com/owner/repo/blob/main/CONTRIBUTING.md 的贡献流程
【难度】
中`;
    const { opportunities } = parseOssOpportunities(text);
    expect(opportunities[0].links).toEqual(['https://github.com/owner/repo/blob/main/CONTRIBUTING.md']);
  });
});

describe('parseOssOpportunities · 字段头变体', () => {
  it('【简介】【类型】【Issue 链接】【适合理由】【第一步】均可解析', () => {
    const text = `【机会 1】
1
【项目】
ggml-org/llama.cpp
【简介】
C/C++ 推理框架,量化生态核心。
【类型】
Bug 修复
【Issue 链接】
https://github.com/ggml-org/llama.cpp/issues/9999
【适合理由】
你熟悉 Go 与 C 混编,这个崩溃点在 cgo 边界。
【第一步】
按 Issue 里的最小复现脚本本地跑一遍。
【难度】
中(需要本地编译)`;
    const { opportunities } = parseOssOpportunities(text);
    expect(opportunities).toHaveLength(1);
    const o = opportunities[0];
    expect(o.summary).toContain('C/C++ 推理框架');
    expect(o.kind).toBe('Bug 修复');
    expect(o.links).toEqual(['https://github.com/ggml-org/llama.cpp/issues/9999']);
    expect(o.fit).toContain('cgo 边界');
    expect(o.firstStep).toContain('最小复现脚本');
    expect(o.difficulty).toBe('中(需要本地编译)');
  });
});

describe('parseOssOpportunities · fallback 与无效块', () => {
  it('首字段头之前的寒暄 → fallback,不丢内容', () => {
    const text = `好的,本周扫描结果如下(检索时间 2026-10-13):\n${standard}`;
    const { opportunities, fallback } = parseOssOpportunities(text);
    expect(opportunities).toHaveLength(2);
    expect(fallback).toContain('好的,本周扫描结果如下');
  });

  it('末尾检索时间与数据源说明块(无字段头)→ 整块进 fallback', () => {
    const text = `${standard}\n---\n数据检索时间:2026-10-13 09:30;数据源:GitHub MCP 搜索 + DeepWiki。`;
    const { opportunities, fallback } = parseOssOpportunities(text);
    expect(opportunities).toHaveLength(2);
    expect(fallback).toContain('数据检索时间');
    expect(fallback).toContain('GitHub MCP');
  });

  it('缺链接的块无效(直达链接是核心价值)→ 整块进 fallback', () => {
    const text = `【项目】
owner/repo
【项目简介】
一个项目。
【机会类型】
文档改进
【为什么适合你】
匹配。
【建议第一步】
看看。
【难度】
低`;
    const { opportunities, fallback } = parseOssOpportunities(text);
    expect(opportunities).toHaveLength(0);
    expect(fallback).toContain('owner/repo');
  });

  it('缺项目的块无效 → fallback', () => {
    const text = `【机会链接】
https://github.com/owner/repo/issues/1
【机会类型】
文档改进
【为什么适合你】
匹配。
【难度】
低`;
    const { opportunities, fallback } = parseOssOpportunities(text);
    expect(opportunities).toHaveLength(0);
    expect(fallback).toContain('issues/1');
  });

  it('命中字段过少(项目+链接仅 2 项,< 4)→ 无效', () => {
    const text = `【项目】
owner/repo
【机会链接】
https://github.com/owner/repo/issues/1`;
    const { opportunities } = parseOssOpportunities(text);
    expect(opportunities).toHaveLength(0);
  });

  it('有效块与无效块混合:有效的成卡,无效的进 fallback', () => {
    const broken = `【项目】
broken/repo
【难度】
低`;
    const { opportunities, fallback } = parseOssOpportunities(`${standard}\n---\n${broken}`);
    expect(opportunities).toHaveLength(2);
    expect(fallback).toContain('broken/repo');
  });

  it('纯文本(无【)→ 全量 fallback;空串 → 双空', () => {
    const plain = parseOssOpportunities('本周没有检索到匹配的机会,建议放宽关注方向。');
    expect(plain.opportunities).toHaveLength(0);
    expect(plain.fallback).toContain('建议放宽关注方向');

    expect(parseOssOpportunities('')).toEqual({ opportunities: [], fallback: null });
    expect(parseOssOpportunities('   \n  ')).toEqual({ opportunities: [], fallback: null });
  });
});

describe('buildOssOpportunityCopyText', () => {
  it('项目开头,类型·难度、简介、链接逐行、匹配点与第一步带前缀', () => {
    const { opportunities } = parseOssOpportunities(standard);
    const text = buildOssOpportunityCopyText(opportunities[0]);
    expect(text.startsWith('vllm-project/vllm')).toBe(true);
    expect(text).toContain('good first issue · 难度:低');
    expect(text).toContain('https://github.com/vllm-project/vllm/issues/12345\nhttps://github.com/vllm-project/vllm/blob/main/CONTRIBUTING.md');
    expect(text).toContain('为什么适合我:');
    expect(text).toContain('第一步:');
  });

  it('缺 kind/difficulty/fit 时不出现空段', () => {
    const { opportunities } = parseOssOpportunities(`【项目】
owner/repo
【项目简介】
简介内容。
【机会链接】
https://github.com/owner/repo/issues/1
【建议第一步】
复现一下。`);
    const text = buildOssOpportunityCopyText(opportunities[0]);
    expect(text).toBe(
      'owner/repo\n\n简介内容。\n\nhttps://github.com/owner/repo/issues/1\n\n第一步:复现一下。'
    );
  });
});

describe('与既有三种交付物格式互斥(双向锚定)', () => {
  // 机会清单 → 三个既有解析器都不得成包/成卡
  it('机会清单不被文章包/笔记包/选题清单误判', () => {
    expect(parseArticlePackages(standard).packages).toHaveLength(0);
    expect(parseNotePackages(standard).packages).toHaveLength(0);
    expect(parseTopicPicks(standard).picks).toHaveLength(0);
  });

  it('成品文章包(标题+摘要+正文)不被机会解析器误判', () => {
    // 文章包有效性要求 digest 非空且正文 ≥100 字(去空白),fixture 须达到门槛
    const article = `【标题】
终版文章标题
【摘要】
一百二十字摘要。
【正文】
${'正文段落内容,论述充分。'.repeat(12)}`;
    expect(parseArticlePackages(article).packages).toHaveLength(1);
    const r = parseOssOpportunities(article);
    expect(r.opportunities).toHaveLength(0);
    expect(r.fallback).toContain('终版文章标题');
  });

  it('成品笔记包(标题+封面文案+正文+标签)不被机会解析器误判', () => {
    // 笔记包有效性要求正文 ≥50 字(去空白)
    const note = `【标题】
终版笔记标题
【封面文案】
封面主标
【正文】
${'笔记正文内容,真实体验分享。'.repeat(6)}
【标签】
#AI #开源`;
    expect(parseNotePackages(note).packages).toHaveLength(1);
    const r = parseOssOpportunities(note);
    expect(r.opportunities).toHaveLength(0);
    expect(r.fallback).toContain('终版笔记标题');
  });

  it('选题清单(选题 N+方向+钩子+依据)不被机会解析器误判', () => {
    const picks = `【选题 1】
1
【选题方向】
秋冬通勤穿搭
【标题钩子】
早八人三分钟出门
【切入角度】
平价可复制
【依据】
近 7 天搜索热度上升`;
    expect(parseTopicPicks(picks).picks).toHaveLength(1);
    const r = parseOssOpportunities(picks);
    expect(r.opportunities).toHaveLength(0);
    expect(r.fallback).toContain('秋冬通勤穿搭');
  });
});
