import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distillMissionMemories, distillAgentExperience } from '@/lib/memory-service';

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
});
