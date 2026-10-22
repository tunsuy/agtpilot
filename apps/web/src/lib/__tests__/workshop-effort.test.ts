/**
 * 工坊思考深度 · 任务级覆盖链(configOverride 合并点)。
 *
 * 优先级:工坊设置(user-store,agent-backend 现读合并)> 连接器全局
 * (buildUserModelOverride)> env > 分支缺省。内核侧 resolveThinkingEffort
 * 只收口后三层(见 plugin-model/thinking.test.ts);本组用例钉住 web 层
 * 合并语义 —— 工坊档必须压过连接器档,无工坊档时连接器档原样通过。
 */
import { describe, it, expect } from 'vitest';

// buildUserModelOverride 是纯函数,直接 import 钉连接器档语义;
// 工坊档合并点在 runMission(重 IO),这里用同一合并表达式语义做镜像断言。
import { buildUserModelOverride } from '../agent-backend';

describe('工坊思考深度 · 连接器全局档(buildUserModelOverride)', () => {
  it('连接器卡片档位进 override(工坊未设时它就是最终档)', () => {
    const { override } = buildUserModelOverride({
      activeModelId: 'custom_llm',
      configs: { CUSTOM_LLM_API_KEY: 'k', CUSTOM_LLM_REASONING_EFFORT: 'low' },
    });
    expect(override.reasoningEffort).toBe('low');
  });

  it('连接器未设 = undefined(不下发,回落 env/分支缺省)', () => {
    const { override } = buildUserModelOverride({
      activeModelId: 'custom_llm',
      configs: { CUSTOM_LLM_API_KEY: 'k' },
    });
    expect(override.reasoningEffort).toBeUndefined();
  });
});

describe('工坊思考深度 · 任务级合并(工坊档 > 连接器档)', () => {
  // runMission 的合并语义(镜像自 agent-backend「工坊级思考深度」段):
  // const effort = getWorkshopModelSettings(uid)[workshopId]?.reasoningEffort;
  // if (effort) userConfigOverride = { ...userConfigOverride, reasoningEffort: effort };
  const merge = (override: any, workshopEffort?: 'low' | 'medium' | 'high' | 'none') =>
    workshopEffort ? { ...override, reasoningEffort: workshopEffort } : override;

  it('工坊档压过连接器档(日更场景:全局 high,工坊 low)', () => {
    const { override } = buildUserModelOverride({
      activeModelId: 'custom_llm',
      configs: { CUSTOM_LLM_API_KEY: 'k', CUSTOM_LLM_REASONING_EFFORT: 'high' },
    });
    expect(merge(override, 'low').reasoningEffort).toBe('low');
  });

  it('工坊关思考(none)压过连接器档 —— 全局 medium 也拦不住,输出预算全留给正文', () => {
    const { override } = buildUserModelOverride({
      activeModelId: 'custom_llm',
      configs: { CUSTOM_LLM_API_KEY: 'k', CUSTOM_LLM_REASONING_EFFORT: 'medium' },
    });
    expect(merge(override, 'none').reasoningEffort).toBe('none');
  });

  it('工坊档填补连接器未设(未设 custom_llm 缺省不下发 → 工坊档是唯一下发源)', () => {
    const { override } = buildUserModelOverride({
      activeModelId: 'custom_llm',
      configs: { CUSTOM_LLM_API_KEY: 'k' },
    });
    expect(merge(override, 'low').reasoningEffort).toBe('low');
  });

  it('工坊未设档 = 连接器档原样通过(不产生覆盖)', () => {
    const { override } = buildUserModelOverride({
      activeModelId: 'custom_llm',
      configs: { CUSTOM_LLM_API_KEY: 'k', CUSTOM_LLM_REASONING_EFFORT: 'high' },
    });
    expect(merge(override, undefined)).toBe(override);
    expect(merge(override, undefined).reasoningEffort).toBe('high');
  });

  it('非工坊任务(无 workshopId)不触发合并,行为与旧版一致', () => {
    const { override } = buildUserModelOverride({
      activeModelId: 'custom_llm',
      configs: { CUSTOM_LLM_API_KEY: 'k', CUSTOM_LLM_REASONING_EFFORT: 'medium' },
    });
    expect(merge(override, undefined)).toBe(override);
  });
});
