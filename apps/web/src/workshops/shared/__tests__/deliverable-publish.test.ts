import { describe, it, expect } from 'vitest';
import { buildWorkshopDeliverable } from '../deliverable-publish';
import { resolveDeliverableKind } from '../../registry';

/**
 * 内容工坊成品 → 交付库自动落地(收尾发布)契约测试。
 *
 * 锁两件事:
 * 1. buildWorkshopDeliverable:按 kind 用对应解析器抽成品、渲染成干净 Markdown;
 *    单篇标题=成品标题、多篇=任务名兜底;非成品格式(自由文本/选题清单/空答复)
 *    一律 null —— 绝不把非成品当交付件发布。
 * 2. resolveDeliverableKind:声明驱动,只有声明了包类交付物的内容工坊
 *    (知乎/公众号=文章包,小红书=笔记包)才参与,其余工坊/手输任务 → null。
 */

const LONG_BODY =
  '这是一篇关于大模型落地实践的深度长文正文,讨论工程化路径与真实收益,内容必须超过一百字才能被判定为有效的文章包,所以这里把正文写得足够长以便通过有效性校验。'.repeat(
    2
  );

const article = (title: string, digest: string, body = LONG_BODY) =>
  `【标题】\n${title}\n【摘要】\n${digest}\n【正文】\n${body}`;

describe('buildWorkshopDeliverable · article-package(知乎/公众号)', () => {
  it('单篇:标题=成品标题,正文含 H1 标题 + 引用摘要 + 正文,count=1', () => {
    const text = article('大模型落地:别再谈概念了', '关键不在模型本身,而在工程化路径。');
    const d = buildWorkshopDeliverable('article-package', text, '知乎专栏工坊 · 技术长文');
    expect(d).not.toBeNull();
    expect(d!.count).toBe(1);
    expect(d!.title).toBe('大模型落地:别再谈概念了');
    expect(d!.content).toContain('# 大模型落地:别再谈概念了');
    expect(d!.content).toContain('> 关键不在模型本身,而在工程化路径。');
    expect(d!.content).toContain(LONG_BODY);
  });

  it('多篇:标题回落任务名,正文以 --- 合并,count=篇数', () => {
    const text = [
      article('第一篇标题', '第一篇摘要一句话。'),
      article('第二篇标题', '第二篇摘要一句话。'),
    ].join('\n---\n');
    const d = buildWorkshopDeliverable('article-package', text, '知乎专栏工坊 · 技术长文')!;
    expect(d.count).toBe(2);
    expect(d.title).toBe('知乎专栏工坊 · 技术长文');
    expect(d.content).toContain('# 第一篇标题');
    expect(d.content).toContain('# 第二篇标题');
    expect(d.content).toContain('\n\n---\n\n');
  });

  it('自由文本(无字段头)/空答复 → null(绝不发布非成品)', () => {
    expect(
      buildWorkshopDeliverable('article-package', '今天聊一下大模型落地……' + '没有结构的长文本。'.repeat(10), 't')
    ).toBeNull();
    expect(buildWorkshopDeliverable('article-package', '', 't')).toBeNull();
  });

  it('笔记包形状喂 article kind:无【摘要】互斥锚 → null(绝不误投)', () => {
    const noteShape = `【标题】\n通勤穿搭\n【封面文案】\n3 件单品穿一周\n【正文】\n${'笔记正文与文章包字段头高度重合但没有摘要字段。'.repeat(
      6
    )}\n【标签】\n#穿搭 #ootd`;
    expect(buildWorkshopDeliverable('article-package', noteShape, 't')).toBeNull();
  });
});

describe('buildWorkshopDeliverable · note-package(小红书)', () => {
  const note = (title: string, body: string, tags: string) =>
    `【标题】\n${title}\n【封面文案】\n封面一句话\n【正文】\n${body}\n【标签】\n${tags}`;

  it('单篇笔记:标题=笔记标题,正文含 H1 标题 + 正文 + 标签串', () => {
    const text = note('平价通勤穿搭', '笔记正文内容足够长以便通过有效性校验。'.repeat(6), '#穿搭 #ootd');
    const d = buildWorkshopDeliverable('note-package', text, '小红书笔记工坊')!;
    expect(d).not.toBeNull();
    expect(d.count).toBe(1);
    expect(d.title).toBe('平价通勤穿搭');
    expect(d.content).toContain('# 平价通勤穿搭');
    expect(d.content).toContain('#穿搭 #ootd');
  });

  it('选题清单(非笔记包)→ null(xhs 每周选题是中间产物,绝不当交付件)', () => {
    const picks = `【选题 1】\n秋冬通勤穿搭\n【选题 2】\n周末露营装备清单`;
    expect(buildWorkshopDeliverable('note-package', picks, 't')).toBeNull();
  });
});

describe('resolveDeliverableKind(声明驱动:仅声明结构化交付物的工坊参与自动落地)', () => {
  it('知乎/公众号 → article-package;小红书 → note-package', () => {
    expect(resolveDeliverableKind('zhihu')).toBe('article-package');
    expect(resolveDeliverableKind('wechat_mp')).toBe('article-package');
    expect(resolveDeliverableKind('xhs')).toBe('note-package');
  });

  it('开源雷达声明机会清单 → oss-opportunity(收尾落库,交付库渲派发卡)', () => {
    expect(resolveDeliverableKind('oss_radar')).toBe('oss-opportunity');
  });

  it('视频/微博声明纯文本成品 → text-deliverable(收尾原样落库)', () => {
    expect(resolveDeliverableKind('video_douyin')).toBe('text-deliverable');
    expect(resolveDeliverableKind('video_bilibili')).toBe('text-deliverable');
    expect(resolveDeliverableKind('weibo')).toBe('text-deliverable');
  });

  it('未声明交付物的工坊 → null(PPT/小说/邮件/周报等)', () => {
    for (const id of ['ppt', 'novel', 'email_triage', 'weekly']) {
      expect(resolveDeliverableKind(id)).toBeNull();
    }
  });

  it('无 workshopId / 未知 id → null(手输任务、历史任务不参与)', () => {
    expect(resolveDeliverableKind(undefined)).toBeNull();
    expect(resolveDeliverableKind('not_a_workshop')).toBeNull();
  });
});

/** 单条机会块(契约格式:【机会 N】+ 字段头,与 opportunities 解析器测试同构) */
const oppBlock = (n: number, project: string) =>
  [
    `【机会 ${n}】`,
    `${n}`,
    '【项目】',
    project,
    '【项目简介】',
    `项目 ${n} 简介:AI infra 方向活跃仓库,发版节奏稳定。`,
    '【机会类型】',
    'good first issue',
    '【机会链接】',
    `https://github.com/${project}/issues/${100 + n}`,
    '【为什么适合你】',
    '你主力是 Go + TypeScript,该 Issue 只涉及参数解析。',
    '【难度】',
    '低',
  ].join('\n');

const OSS_LIST = [oppBlock(1, 'google/ax'), '---', oppBlock(2, 'vllm-project/vllm')].join('\n');
const OSS_PROSE = '调研完成,看板已收尾。清单与卡片均已交付(2 条机会),随时可以指定一条。';

describe('buildWorkshopDeliverable · oss-opportunity(开源贡献雷达)', () => {
  it('清单:content 原样保留契约格式,count=机会数,标题=任务名', () => {
    const d = buildWorkshopDeliverable('oss-opportunity', OSS_LIST, '只读深挖指定仓库 google/ax');
    expect(d).not.toBeNull();
    expect(d!.count).toBe(2);
    expect(d!.title).toBe('只读深挖指定仓库 google/ax');
    expect(d!.content).toContain('【项目】');
    expect(d!.content).toContain('https://github.com/google/ax/issues/101');
  });

  it('收尾倒扫 steps:final 是散文、清单在中间步骤 → 取清单', () => {
    const d = buildWorkshopDeliverable(
      'oss-opportunity',
      OSS_PROSE,
      '只读深挖指定仓库 google/ax',
      ['开始检索 open issues…', OSS_LIST, OSS_PROSE]
    );
    expect(d).not.toBeNull();
    expect(d!.count).toBe(2);
    expect(d!.content).toContain('【机会 1】');
  });

  it('散文/空答复且 steps 无清单 → null,绝不发布', () => {
    expect(buildWorkshopDeliverable('oss-opportunity', OSS_PROSE, '任务名')).toBeNull();
    expect(buildWorkshopDeliverable('oss-opportunity', '', '任务名', ['检索中…'])).toBeNull();
  });
});

describe('resolveDeliverableKind · 开源雷达参与收尾自动落地', () => {
  it('oss_radar → oss-opportunity;未声明工坊/手输任务 → null', () => {
    expect(resolveDeliverableKind('oss_radar')).toBe('oss-opportunity');
    expect(resolveDeliverableKind('novel')).toBeNull();
    expect(resolveDeliverableKind(undefined)).toBeNull();
  });
});

describe('buildWorkshopDeliverable · text-deliverable(视频脚本/微博文案)', () => {
  const videoScript = [
    '【标题】',
    '3 分钟看懂大模型落地',
    '【脚本分镜】',
    '| 时间 | 画面 | 台词/口播 | 字幕要点 |',
    '|---|---|---|---|',
    `| 0-15s | 实拍开场 | ${'钩子口播逐字稿内容。'.repeat(4)} | 痛点 |`,
    '【口播开头】',
    '你还在为大模型落地发愁吗?'.repeat(4),
    '【标签与分区】',
    '#大模型 #AI落地 · 知识区',
    '【封面文案】',
    '主标题:大模型落地 / 副标题:三道坎',
    '【发布提示】',
    '工作日晚 8 点发布;拍摄难度低,可用现成素材。',
  ].join('\n');

  const weiboPost = [
    '【正文】',
    '今天聊聊大模型落地的真相:大多数团队卡在工程化,不是模型本身。'.repeat(3),
    '【话题标签】',
    '#大模型# #AI落地#',
    '【配图建议】',
    '3 张:架构图 + 数据对比 + 现场图',
    '【发布提示】',
    '午间 12 点发布;涉行业数据以官方通报为准。',
  ].join('\n');

  it('单条视频脚本:标题取【标题】锚行,正文原样落库不重渲染,count=1', () => {
    const d = buildWorkshopDeliverable('text-deliverable', videoScript, '抖音短视频脚本工坊 · 60 秒');
    expect(d).not.toBeNull();
    expect(d!.count).toBe(1);
    expect(d!.title).toBe('3 分钟看懂大模型落地');
    expect(d!.content).toBe(videoScript.trim());
    expect(d!.content).toContain('【脚本分镜】');
  });

  it('微博文案无【标题】字段 → 标题回落任务名;【正文】锚即可入库', () => {
    const d = buildWorkshopDeliverable('text-deliverable', weiboPost, '微博内容工坊 · 热点点评');
    expect(d).not.toBeNull();
    expect(d!.title).toBe('微博内容工坊 · 热点点评');
    expect(d!.content).toBe(weiboPost.trim());
  });

  it('多条以 --- 分隔:count=条数,标题回落任务名(集合语义,同包类)', () => {
    const two = `${weiboPost}\n---\n${weiboPost.replace('大模型落地', '智能体落地')}`;
    const d = buildWorkshopDeliverable('text-deliverable', two, '微博内容工坊 · 干货分享');
    expect(d!.count).toBe(2);
    expect(d!.title).toBe('微博内容工坊 · 干货分享');
    expect(d!.content).toContain('---');
  });

  it('过短(不足 80 字符)/无契约锚(散文总结)/空答复 → null,绝不发布非成品', () => {
    expect(buildWorkshopDeliverable('text-deliverable', '【标题】\n太短了', 't')).toBeNull();
    expect(
      buildWorkshopDeliverable(
        'text-deliverable',
        '好的,我已经完成了本次任务的检索与整理,以下是过程说明。'.repeat(5),
        't'
      )
    ).toBeNull();
    expect(buildWorkshopDeliverable('text-deliverable', '', 't')).toBeNull();
  });

  it('收尾倒扫 steps:final 是散文、成品在中间步骤 → 取带锚成品(oss 同款)', () => {
    const prose = '脚本已经写完了,你可以在上面的步骤里看到完整内容。'.repeat(4);
    const d = buildWorkshopDeliverable('text-deliverable', prose, '抖音短视频脚本工坊', [
      '开始检索热点…',
      videoScript,
      prose,
    ]);
    expect(d).not.toBeNull();
    expect(d!.title).toBe('3 分钟看懂大模型落地');
    expect(d!.content).toBe(videoScript.trim());
  });

  it('steps 里也没有带锚成品 → null(强制总结轮不产出交付件)', () => {
    const prose = '很抱歉,本次任务未能完成脚本创作。'.repeat(4);
    expect(
      buildWorkshopDeliverable('text-deliverable', prose, 't', ['检索中…', '检索失败'])
    ).toBeNull();
  });
});
