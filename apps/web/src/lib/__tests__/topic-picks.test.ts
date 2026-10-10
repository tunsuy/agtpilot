import { describe, it, expect } from 'vitest';
import {
  parseTopicPicks,
  buildTopicPickReplyText,
  findLatestTopicPicks,
  hasRunningTopicMission,
  MAX_TOPIC_PICKS,
  TOPIC_MISSION_TITLE_MARK,
  type TopicPick,
  type TopicPicksMissionLike,
} from '../topic-picks';

/** 标准 7 字段输出样例(与 buildXhsWeeklyTopicsPrompt 的格式契约一致) */
const STANDARD_TEXT = `本周选题会开完,以下是 7 条候选。

【选题 1】
1
【选题方向】
秋冬通勤穿搭的 3 个显高公式
【标题钩子】
1. 150 小个子这样穿腿长+10cm
- 通勤外套别再配牛仔裤了
【切入角度】
用真实身高对比图,不用模特图
【依据】
hot_topics 页「通勤穿搭」本周热度上升 40%
【配图建议】
地铁口全身镜实拍
【建议发布日】
周三晚(档案经验:周三晚 8 点打开率最高)

---

【选题 2】
2
【选题方向】
羽绒服显瘦穿法
【标题钩子】
1. 羽绒服穿成球?这 3 招救
2. 微胖女生羽绒服闭眼抄
【切入角度】
按身材类型分场景给方案
【依据】
站内搜索「羽绒服 显瘦」近 30 天笔记 1.2 万篇
【配图建议】
三种身材对比九宫格
【建议发布日】
周五午休

---

本周题材分布均衡,建议周一三五一晚各发一条。`;

describe('parseTopicPicks · 标准解析', () => {
  it('解析出 2 条选题,七字段全部归位', () => {
    const { picks, fallback } = parseTopicPicks(STANDARD_TEXT);
    expect(picks).toHaveLength(2);

    expect(picks[0].number).toBe(1);
    expect(picks[0].direction).toBe('秋冬通勤穿搭的 3 个显高公式');
    // 序号前缀(「1. 」「- 」)被剥掉
    expect(picks[0].hooks).toEqual(['150 小个子这样穿腿长+10cm', '通勤外套别再配牛仔裤了']);
    expect(picks[0].angle).toBe('用真实身高对比图,不用模特图');
    expect(picks[0].basis).toBe('hot_topics 页「通勤穿搭」本周热度上升 40%');
    expect(picks[0].imageIdea).toBe('地铁口全身镜实拍');
    expect(picks[0].publishDay).toBe('周三晚(档案经验:周三晚 8 点打开率最高)');

    expect(picks[1].number).toBe(2);
    expect(picks[1].direction).toBe('羽绒服显瘦穿法');
  });

  it('开场寒暄与结尾总评进 fallback,内容不丢', () => {
    const { picks, fallback } = parseTopicPicks(STANDARD_TEXT);
    expect(picks.length).toBeGreaterThan(0);
    expect(fallback).toContain('本周选题会开完');
    expect(fallback).toContain('本周题材分布均衡');
  });
});

describe('parseTopicPicks · 健壮性', () => {
  it('块内未声明编号时按出现顺序 1..n 递补', () => {
    const text = `【选题方向】
第一条
【标题钩子】
钩子A
【切入角度】
角度
【依据】
来源

---

【选题方向】
第二条
【标题钩子】
钩子B
【切入角度】
角度2
【依据】
来源2`;
    const { picks } = parseTopicPicks(text);
    expect(picks).toHaveLength(2);
    expect(picks[0].number).toBe(1);
    expect(picks[1].number).toBe(2);
  });

  it('变体字段头(方向/标题/配图/发布日)同样命中', () => {
    const text = `【选题 1】
1
【方向】
变体方向
【标题】
变体钩子
【依据】
变体依据
【配图】
变体配图
【发布日】
周日`;
    const { picks } = parseTopicPicks(text);
    expect(picks).toHaveLength(1);
    expect(picks[0].direction).toBe('变体方向');
    expect(picks[0].hooks).toEqual(['变体钩子']);
    expect(picks[0].imageIdea).toBe('变体配图');
    expect(picks[0].publishDay).toBe('周日');
  });

  it('缺【选题方向】的块整体进 fallback(不产出半残卡)', () => {
    const text = `【选题 1】
1
【标题钩子】
只有钩子没有方向
【依据】
有依据`;
    const { picks, fallback } = parseTopicPicks(text);
    expect(picks).toHaveLength(0);
    expect(fallback).toContain('只有钩子没有方向');
  });

  it('纯文本(无【)整体 fallback,picks 为空 → 调用方降级 markdown', () => {
    const { picks, fallback } = parseTopicPicks('这只是一段普通回复,不是选题清单。');
    expect(picks).toHaveLength(0);
    expect(fallback).toBe('这只是一段普通回复,不是选题清单。');
  });

  it('笔记包格式不误判:字段头不相交,picks 为空', () => {
    const notePackage = `【标题候选】
1. 标题一
2. 标题二
【封面文案】
封面主文案
【正文】
正文内容……
【标签】
#穿搭 #通勤
【发布建议】
周三晚 8 点`;
    const { picks } = parseTopicPicks(notePackage);
    // 【标题候选】匹配 hooks 的变体「标题」?——正则为 ^【\s*(?:标题钩子|标题)\s*[^】]*】,【标题候选】不命中
    expect(picks).toHaveLength(0);
  });

  it('空输入返回空结果', () => {
    expect(parseTopicPicks('')).toEqual({ picks: [], fallback: null });
    expect(parseTopicPicks('   \n  ')).toEqual({ picks: [], fallback: null });
  });
});

describe('buildTopicPickReplyText', () => {
  const picks: TopicPick[] = [
    {
      number: 1,
      direction: '通勤显高公式',
      hooks: ['钩子一', '钩子二'],
      angle: '角度A',
      basis: 'hot_topics',
    },
    {
      number: 3,
      direction: '羽绒服显瘦',
      hooks: ['钩子三'],
      basis: 'search:羽绒服',
    },
    {
      number: 5,
      direction: '第五条',
      hooks: ['钩子五'],
      basis: '热榜',
    },
    {
      number: 6,
      direction: '第六条',
      hooks: ['钩子六'],
    },
  ];

  it('逐字引用勾选原文:编号+方向+钩子', () => {
    const text = buildTopicPickReplyText([picks[0], picks[1]]);
    expect(text).toContain('第 1 条、第 3 条');
    expect(text).toContain('第 1 条:选题方向「通勤显高公式」;标题钩子:「钩子一」「钩子二」');
    expect(text).toContain('第 3 条:选题方向「羽绒服显瘦」;标题钩子:「钩子三」');
    expect(text).toContain('共 2 篇');
  });

  it('内嵌笔记包字段规格(续答可被 parseNotePackages 渲染)+ --- 分隔', () => {
    const text = buildTopicPickReplyText([picks[0]]);
    for (const header of ['【标题候选】', '【封面文案】', '【正文】', '【标签】', '【发布建议】']) {
      expect(text).toContain(header);
    }
    expect(text).toContain('单独一行的 --- 分隔');
  });

  it('声明延续档案/红线/只读边界,禁止写操作', () => {
    const text = buildTopicPickReplyText([picks[0]]);
    expect(text).toContain('账号档案');
    expect(text).toContain('只读边界');
    expect(text).toContain('不要调用任何写操作类工具');
  });

  it('超过 MAX_TOPIC_PICKS 条只取前 3', () => {
    const text = buildTopicPickReplyText(picks);
    expect(text).toContain('共 3 篇');
    expect(text).not.toContain('第六条');
    expect(text).toContain('第 1 条、第 3 条、第 5 条');
  });

  it('MAX_TOPIC_PICKS = 3(勾选上限契约)', () => {
    expect(MAX_TOPIC_PICKS).toBe(3);
  });
});

describe('findLatestTopicPicks · 弹窗内嵌勾选卡的数据源', () => {
  const mission = (
    id: string,
    title: string,
    status: string,
    startedAt: number,
    answers: Array<string | undefined> = [STANDARD_TEXT]
  ): TopicPicksMissionLike => ({
    id,
    title,
    status,
    startedAt,
    steps: answers.map((answer, i) => ({ role: 'assistant', status: 'DONE', answer, id: `${id}-s${i}` } as any)),
  });

  it('标题标记 + DONE + 最新优先:取 startedAt 最大的完成任务', () => {
    const old = mission('m1', '【自动巡航】小红书每周选题', 'DONE', 1000);
    const fresh = mission('m2', '小红书每周选题·手动', 'DONE', 2000);
    const found = findLatestTopicPicks([old, fresh]);
    expect(found?.missionId).toBe('m2');
    expect(found?.result.picks).toHaveLength(2);
  });

  it('非 DONE / 标题不含标记的任务被忽略', () => {
    const running = mission('m1', '小红书每周选题·手动', 'ACTIVE', 3000);
    const unrelated = mission('m2', '小红书成稿·勾选选题', 'DONE', 2500);
    expect(findLatestTopicPicks([running, unrelated])).toBeNull();
  });

  it('任务内从后往前找第一个可解析答案(末步是空壳卡时回退上一步)', () => {
    const m = mission('m1', '小红书每周选题·手动', 'DONE', 1000, [STANDARD_TEXT, undefined]);
    const found = findLatestTopicPicks([m]);
    expect(found?.missionId).toBe('m1');
    expect(found?.result.picks).toHaveLength(2);
  });

  it('答案解析不出选题(普通答复)→ null,调用方降级为「立即出选题」', () => {
    const m = mission('m1', '小红书每周选题·手动', 'DONE', 1000, ['这周没什么好题,随便写写吧。']);
    expect(findLatestTopicPicks([m])).toBeNull();
  });

  it('无任务 → null;空列表不崩溃', () => {
    expect(findLatestTopicPicks([])).toBeNull();
  });

  it('标题标记常量与两种发起入口的标题都兼容', () => {
    expect('【自动巡航】小红书每周选题'.includes(TOPIC_MISSION_TITLE_MARK)).toBe(true);
    expect('小红书每周选题·手动'.includes(TOPIC_MISSION_TITLE_MARK)).toBe(true);
  });
});

describe('hasRunningTopicMission · 弹窗防重复发起', () => {
  it('ACTIVE/QUEUED 命中,DONE/INTERRUPTED 不命中', () => {
    const mk = (status: string): TopicPicksMissionLike => ({
      id: status,
      title: '小红书每周选题·手动',
      status,
      startedAt: 1,
      steps: [],
    });
    expect(hasRunningTopicMission([mk('ACTIVE')])).toBe(true);
    expect(hasRunningTopicMission([mk('QUEUED')])).toBe(true);
    expect(hasRunningTopicMission([mk('DONE'), mk('INTERRUPTED')])).toBe(false);
  });

  it('标题不含标记的进行中任务不算选题任务', () => {
    expect(
      hasRunningTopicMission([{ id: 'x', title: '小红书成稿·勾选选题', status: 'ACTIVE', startedAt: 1, steps: [] }])
    ).toBe(false);
  });
});
