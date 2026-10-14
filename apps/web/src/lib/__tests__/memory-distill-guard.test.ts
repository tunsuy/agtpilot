import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  distillMissionMemories,
  distillAgentExperience,
  upsertManualMemory,
  listActiveMemories,
} from '@/lib/memory-service';

/**
 * 工坊任务的记忆蒸馏守卫(生产实例驱动):
 * wechat_mp 工坊单次表单选择(定位类型「AI行业观察与判断」/文风「热点解读」)
 * 曾被蒸馏成持久记忆「公众号定位与文风」并召回 10 次 —— 首条 user 消息是
 * 表单参数拼装的提示词,不是用户亲口自述。带 workshopId 时必须在喂给
 * 记忆管理器的对话摘录里显式排除;普适防线(「单次配置不沉淀」)恒在。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-mem-distill-'));
const savedUserDataDir = process.env.USER_DATA_DIR;
process.env.USER_DATA_DIR = path.join(tmpRoot, 'user-data');
fs.mkdirSync(process.env.USER_DATA_DIR, { recursive: true });

afterAll(() => {
  if (savedUserDataDir === undefined) delete process.env.USER_DATA_DIR;
  else process.env.USER_DATA_DIR = savedUserDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** stub 模型:返回空操作数组,捕获实际喂进去的 system / userMessage */
function buildCtx() {
  const calls: Array<{ system: string; userMessage: string }> = [];
  const ctx = {
    model: {
      invokeStep: async (req: any) => {
        calls.push({ system: String(req.system), userMessage: String(req.messages?.[0]?.content) });
        return { text: '[]', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } };
      },
    },
  };
  return { ctx, calls };
}

/** stub 模型:固定返回一段 JSON 操作数组(模型「决定 add」的场景) */
function buildAddCtx(addJson: string) {
  const calls: Array<{ system: string; userMessage: string }> = [];
  const ctx = {
    model: {
      invokeStep: async (req: any) => {
        calls.push({ system: String(req.system), userMessage: String(req.messages?.[0]?.content) });
        return { text: addJson, finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } };
      },
    },
  };
  return { ctx, calls };
}

const messages = [
  {
    role: 'user',
    content:
      '【公众号写作 · 热点解读】\n我的公众号定位:AI行业观察与判断,文章风格为热点解读。\n主题:xxx\n产出:1 篇',
  },
  { role: 'assistant', content: '好的,已按热点解读风格完成初稿。' },
];

describe('distillMissionMemories · 工坊表单参数防误沉淀', () => {
  it('带 workshopId:对话摘录标注「表单参数拼装,严禁沉淀」,工坊 id 可见', async () => {
    const { ctx, calls } = buildCtx();
    await distillMissionMemories(ctx, {
      userId: 'usr_test',
      goal: '写一篇公众号文章',
      messages,
      missionId: 'm1',
      workshopId: 'wechat_mp',
    });
    expect(calls.length).toBe(1);
    expect(calls[0].userMessage).toContain('wechat_mp');
    expect(calls[0].userMessage).toContain('表单参数');
    expect(calls[0].userMessage).toContain('不是用户的长期定位或偏好');
    expect(calls[0].userMessage).toContain('严禁');
  });

  it('不带 workshopId:无工坊标注(手输任务的用户原话不受影响)', async () => {
    const { ctx, calls } = buildCtx();
    await distillMissionMemories(ctx, {
      userId: 'usr_test',
      goal: '写一篇公众号文章',
      messages,
      missionId: 'm2',
    });
    expect(calls.length).toBe(1);
    expect(calls[0].userMessage).not.toContain('表单参数拼装');
    expect(calls[0].userMessage).toContain('AI行业观察与判断'); // 原话照常进摘录
  });

  it('普适防线恒在:系统提示词含「单次配置不沉淀」规则(两条路径都受益)', async () => {
    for (const workshopId of [undefined, 'xhs']) {
      const { ctx, calls } = buildCtx();
      await distillMissionMemories(ctx, {
        userId: 'usr_test',
        goal: 'g',
        messages,
        missionId: 'm3',
        workshopId,
      });
      expect(calls[0].system).toContain('单次任务的参数化选择');
      expect(calls[0].system).toContain('不是用户的长期定位或偏好');
    }
  });

  it('寒暄级对话(<12 字符)不调模型', async () => {
    const { ctx, calls } = buildCtx();
    await distillMissionMemories(ctx, {
      userId: 'usr_test',
      goal: 'g',
      messages: [{ role: 'user', content: '你好' }],
      missionId: 'm4',
      workshopId: 'wechat_mp',
    });
    expect(calls.length).toBe(0);
  });
});

describe('distillAgentExperience · 环境状态防绝对断言(生产实例:Firecrawl 未配置)', () => {
  const mission = {
    id: 'm5',
    steps: [
      {
        tool: 'browser_firecrawl_scrape',
        role: 'tool',
        status: 'FAILED',
        output: '未配置 FIRECRAWL_API_KEY',
      },
      { tool: 'browser_navigate', role: 'tool', status: 'DONE', output: '已打开 openai.com' },
      { tool: 'search_web', role: 'tool', status: 'DONE', output: 'ok' },
    ],
  };

  it('环境状态必须条件式 + 失效条件;轨迹矛盾时必须更新旧经验', async () => {
    const { ctx, calls } = buildCtx();
    await distillAgentExperience(ctx, {
      userId: 'usr_test',
      goal: '抓取网页正文',
      mission,
      efficiency: { stepsCount: 3, toolCalls: 3, failedCalls: 1, skippedCalls: 0, effectiveRate: 0.67 },
      missionId: 'm5',
    });
    expect(calls.length).toBe(1);
    // 条件式书写规则(密钥未配置会随用户配置改变,严禁绝对断言)
    expect(calls[0].system).toContain('条件式');
    expect(calls[0].system).toContain('失效条件');
    expect(calls[0].system).toContain('严禁绝对断言');
    // 自我纠偏:轨迹与旧环境事实矛盾 → 必须更新/删除
    expect(calls[0].system).toContain('矛盾');
    expect(calls[0].system).toContain('必须更新或删除');
    // 轨迹照常进摘录(失败优先可见)
    expect(calls[0].userMessage).toContain('browser_firecrawl_scrape');
    expect(calls[0].userMessage).toContain('FIRECRAWL_API_KEY');
  });

  it('纯闲聊任务(工具调用不足且无失败)不调模型', async () => {
    const { ctx, calls } = buildCtx();
    await distillAgentExperience(ctx, {
      userId: 'usr_test',
      goal: 'g',
      mission: { id: 'm6', steps: [{ tool: 'search_web', role: 'tool', status: 'DONE', output: 'ok' }] },
      missionId: 'm6',
    });
    expect(calls.length).toBe(0);
  });

  it('带 workshopId:系统提示词标注「工坊模板规则严禁照抄」', async () => {
    const { ctx, calls } = buildCtx();
    await distillAgentExperience(ctx, {
      userId: 'usr_test',
      goal: 'g',
      mission: { id: 'm7', workshopId: 'xhs', steps: mission.steps },
      efficiency: { stepsCount: 3, toolCalls: 3, failedCalls: 1, skippedCalls: 0, effectiveRate: 0.67 },
      missionId: 'm7',
    });
    expect(calls[0].system).toContain('xhs');
    expect(calls[0].system).toContain('工坊模板');
    expect(calls[0].system).toContain('严禁照抄');
  });
});

describe('runMemoryDecision · add 语义近重复拦截(生产实例:同一规则换措辞被重复沉淀)', () => {
  // 独立 userId,避免与其他用例的存储互相污染
  const DEDUP_USER = 'usr_dedup';

  it('近重复 add(换措辞的同一规则)被拦截,不落库', async () => {
    upsertManualMemory(DEDUP_USER, {
      title: '公众号发布走草稿箱',
      content: '微信公众号文章必须通过草稿箱接口 add_draft 投递,严禁 freepublish 直接群发,直接群发会绕过用户确认环节。',
      category: 'rule',
      subject: 'user',
    });
    // 模型输出:同一件事的近义改写(非精确/非子串 —— 精确去重拦不住这种)
    const { ctx } = buildAddCtx(
      JSON.stringify([
        {
          op: 'add',
          title: '公众号发文必须走草稿箱',
          content: '微信公众号文章发布应当使用草稿箱 add_draft 接口投递,不要调用 freepublish 直接群发。',
          category: 'rule',
        },
      ])
    );
    const outcome = await distillMissionMemories(ctx, {
      userId: DEDUP_USER,
      goal: '发布公众号文章',
      messages,
      missionId: 'm_dedup_1',
    });
    expect(outcome.added.length).toBe(0);
    expect(listActiveMemories(DEDUP_USER).length).toBe(1); // 库里仍只有原来那条
  });

  it('领域相近但不同主题的 add 正常放行(阈值不能误伤)', async () => {
    upsertManualMemory(DEDUP_USER, {
      title: '小红书笔记封面规范',
      content: '小红书笔记首图用 3:4 竖版,封面文字要大,标题不超过封面宽度的一半。',
      category: 'preference',
      subject: 'user',
    });
    const { ctx } = buildAddCtx(
      JSON.stringify([
        {
          op: 'add',
          title: '小红书投递走草稿箱',
          content: '小红书笔记通过 xhs_save_note_draft 保存为草稿,由用户在 App 内确认发布,Agent 不直接发布。',
          category: 'rule',
        },
      ])
    );
    const outcome = await distillMissionMemories(ctx, {
      userId: DEDUP_USER,
      goal: '发小红书笔记',
      messages,
      missionId: 'm_dedup_2',
    });
    expect(outcome.added.length).toBe(1);
    // 同 userId 前一用例已种 1 条,此处再种 1 条 + 放行 1 条 = 3
    expect(listActiveMemories(DEDUP_USER).length).toBe(3);
  });

  it('同批次内第二条 add 与第一条语义重合也被拦截(batchNorms 之外的批内防线)', async () => {
    const userId = 'usr_dedup_batch';
    const { ctx } = buildAddCtx(
      JSON.stringify([
        {
          op: 'add',
          title: '知乎检索用全局搜索',
          content: '知乎站内搜索覆盖不全,检索资料时改用全局全网搜索再过滤知乎来源。',
          category: 'fact',
        },
        {
          op: 'add',
          title: '知乎查资料用全网搜索',
          content: '知乎站内搜索结果不全,查资料时应该用全网搜索然后按知乎来源过滤。',
          category: 'fact',
        },
      ])
    );
    const outcome = await distillMissionMemories(ctx, {
      userId,
      goal: 'g',
      messages,
      missionId: 'm_dedup_3',
    });
    expect(outcome.added.length).toBe(1); // 第二条是第一条的近义改写,拦掉
  });
});
