import { describe, it, expect } from 'vitest';
import { resolveWorkshopActiveTools } from '../registry';
import { WORKSHOPS } from '../registry';
import type { WorkshopId } from '../types';

/**
 * 工坊工具白名单 · 四层派生断言(docs/design/token-consumption-and-tool-loading.md §9.1)。
 *
 * 背景:雷达选题任务被关键词路由「正则磁铁」拖到 80~100 个工具挂载、单步
 * schema 10~27k tokens(73 万事件最大单项放大器)。白名单 = A(baseline,内核
 * routing.resolveExplicitTools 自动并入,不在本表)∪ B(searchGroup 检索组)
 * ∪ C(deps → mcp_<id>_* 映射 + 特例表)∪ D(meta.activeTools 追加)。
 *
 * 本测试钉死每坊的关键包含/排除项与派生规则,防止:
 * 1. GitHub MCP 整台(前缀通配)回流任何工坊白名单;
 * 2. 检索组裁剪口径漂移(novel/ppt=web、email_triage/weekly=none、其余=research;
 *    2026-10-19 降载后 full 档已删除,社媒热榜 MCP 只准经 deps C 层进入);
 * 3. deps 特例映射腐烂(email→固定三件、tomato_writer→空)。
 */

const ALL_IDS = WORKSHOPS.map((w) => w.id);

describe('resolveWorkshopActiveTools · 派生规则', () => {
  it('每个注册工坊都能解析出非空白名单(新工坊漏配会在编译期/这里暴露)', () => {
    for (const id of ALL_IDS) {
      const tools = resolveWorkshopActiveTools(id);
      expect(tools, `${id} 白名单不应为空`).toBeTruthy();
      expect(tools!.length, `${id} 白名单不应为空数组`).toBeGreaterThan(0);
    }
  });

  it('未知工坊 id → undefined(手输任务/历史任务走原路由)', () => {
    expect(resolveWorkshopActiveTools('not_a_workshop' as WorkshopId)).toBeUndefined();
  });

  it('deps 缺省映射:连接器 id → mcp_<id>_* 前缀通配', () => {
    const invest = resolveWorkshopActiveTools('invest')!;
    expect(invest).toContain('mcp_tushare_*');
    expect(invest).toContain('mcp_a_stock_*');
    expect(invest).toContain('mcp_alphavantage_mcp_*');
    expect(invest).toContain('mcp_coingecko_mcp_*');
    const edu = resolveWorkshopActiveTools('edu')!;
    expect(edu).toContain('mcp_openalex_*');
    expect(edu).toContain('mcp_deepl_mcp_*');
  });

  it('deps 特例:email → 固定三件;tomato_writer/github_mcp → 空(整台禁入)', () => {
    const triage = resolveWorkshopActiveTools('email_triage')!;
    expect(triage).toContain('email_list');
    expect(triage).toContain('email_read');
    expect(triage).toContain('email_send');
    expect(triage.some((t) => t.startsWith('mcp_email'))).toBe(false);
    const novel = resolveWorkshopActiveTools('novel')!;
    expect(novel.some((t) => t.includes('tomato'))).toBe(false);
    expect(novel).toContain('mcp_fanqie_radar_*');
    // GitHub MCP 整台通配不得出现在任何工坊
    for (const id of ALL_IDS) {
      expect(resolveWorkshopActiveTools(id)!, `${id} 不得含 GitHub MCP 整台通配`).not.toContain(
        'mcp_github_mcp_*'
      );
    }
  });
});

describe('resolveWorkshopActiveTools · 检索组口径(B 层)', () => {
  it('research 档(内容/调研工坊):search 三件套 + 调研增强件,社媒热榜不再 B 层直挂', () => {
    for (const id of ['xhs', 'wechat_mp', 'zhihu', 'weibo', 'video_douyin', 'video_bilibili', 'follow_builders', 'invest', 'edu'] as WorkshopId[]) {
      const tools = resolveWorkshopActiveTools(id)!;
      expect(tools, id).toContain('search_web');
      expect(tools, id).toContain('search_exa');
      expect(tools, id).toContain('search_tavily');
      expect(tools, id).toContain('research_subagent');
      expect(tools, id).toContain('browser_firecrawl_scrape');
      expect(tools, id).toContain('read_reference_material');
    }
  });

  it('社媒热榜 MCP 只经 deps(C 层)进入:声明社媒 deps 的工坊照旧拿到,功能零损失', () => {
    // 六坊 deps 均声明 newsnow/zhihu/twitterapi_io(降载前后挂载集合不变)
    for (const id of ['xhs', 'wechat_mp', 'zhihu', 'weibo', 'video_douyin', 'video_bilibili'] as WorkshopId[]) {
      const tools = resolveWorkshopActiveTools(id)!;
      expect(tools, id).toContain('mcp_newsnow_*');
      expect(tools, id).toContain('mcp_zhihu_*');
      expect(tools, id).toContain('mcp_twitterapi_io_*');
    }
    // follow_builders deps 只有 twitterapi_io:推特保留,热榜/知乎不再白背
    const fb = resolveWorkshopActiveTools('follow_builders')!;
    expect(fb).toContain('mcp_twitterapi_io_*');
    expect(fb).not.toContain('mcp_newsnow_*');
    expect(fb).not.toContain('mcp_zhihu_*');
  });

  it('invest/edu:社媒热榜不再整组白背(降载主收益,每步省 2~8k schema)', () => {
    // invest deps 自己声明了 newsnow(财经热榜)→ C 层照给;知乎/推特不再挂
    const invest = resolveWorkshopActiveTools('invest')!;
    expect(invest).toContain('mcp_newsnow_*');
    expect(invest.some((t) => t.startsWith('mcp_zhihu'))).toBe(false);
    expect(invest.some((t) => t.startsWith('mcp_twitterapi'))).toBe(false);
    // edu deps 全是学术源:社媒热榜通配一个不挂
    const edu = resolveWorkshopActiveTools('edu')!;
    expect(edu.some((t) => t.startsWith('mcp_newsnow'))).toBe(false);
    expect(edu.some((t) => t.startsWith('mcp_zhihu'))).toBe(false);
    expect(edu.some((t) => t.startsWith('mcp_twitterapi'))).toBe(false);
  });

  it('research 档(oss_radar):search 三件套 + 调研件,不挂社媒热榜', () => {
    const radar = resolveWorkshopActiveTools('oss_radar')!;
    expect(radar).toContain('search_web');
    expect(radar).toContain('research_subagent');
    expect(radar).toContain('browser_firecrawl_scrape');
    expect(radar).not.toContain('mcp_newsnow_*');
    expect(radar).not.toContain('mcp_zhihu_*');
    expect(radar).not.toContain('mcp_twitterapi_io_*');
  });

  it('web 档(novel/ppt):仅 search 三件套', () => {
    for (const id of ['novel', 'ppt'] as WorkshopId[]) {
      const tools = resolveWorkshopActiveTools(id)!;
      expect(tools, id).toContain('search_web');
      expect(tools, id).not.toContain('research_subagent');
      expect(tools, id).not.toContain('browser_firecrawl_scrape');
      expect(tools, id).not.toContain('mcp_newsnow_*');
    }
  });

  it('none 档(email_triage/weekly):不挂任何检索组', () => {
    for (const id of ['email_triage', 'weekly'] as WorkshopId[]) {
      const tools = resolveWorkshopActiveTools(id)!;
      expect(tools, id).not.toContain('search_web');
      expect(tools, id).not.toContain('research_subagent');
      expect(tools.some((t) => t.startsWith('mcp_newsnow')), id).toBe(false);
    }
  });
});

describe('resolveWorkshopActiveTools · 工坊专属(D 层)', () => {
  it('oss_radar:github_scan + GitHub MCP 只读精确名 3 个 + DeepWiki 整组(deps)', () => {
    const radar = resolveWorkshopActiveTools('oss_radar')!;
    expect(radar).toContain('github_scan');
    expect(radar).toContain('mcp_github_mcp_search_issues');
    expect(radar).toContain('mcp_github_mcp_get_issue');
    expect(radar).toContain('mcp_github_mcp_list_commits');
    expect(radar).toContain('mcp_deepwiki_*');
    expect(radar).toContain('mcp_exa_*');
    // 只读红线:写操作类工具一律不进(建 Issue/PR、评论、fork)
    for (const banned of ['mcp_github_mcp_create_issue', 'mcp_github_mcp_create_pull_request', 'sandbox_run_command', 'git_apply_patch', 'browser_navigate']) {
      expect(radar, `雷达白名单不得含 ${banned}`).not.toContain(banned);
    }
  });

  it('weekly:GitHub 只读精确名 5 个 + Jira/飞书/钉钉整组(deps) + email 三件(特例)', () => {
    const weekly = resolveWorkshopActiveTools('weekly')!;
    expect(weekly).toContain('mcp_github_mcp_list_commits');
    expect(weekly).toContain('mcp_github_mcp_list_pull_requests');
    expect(weekly).toContain('mcp_atlassian_mcp_*');
    expect(weekly).toContain('mcp_lark_suite_*');
    expect(weekly).toContain('mcp_dingtalk_mcp_*');
    expect(weekly).toContain('email_send');
  });

  it('内容工坊:投递固定工具随坊声明(续聊投递同 mission 继承)', () => {
    expect(resolveWorkshopActiveTools('xhs')!).toEqual(
      expect.arrayContaining(['xhs_read_creator_data', 'xhs_save_note_draft'])
    );
    expect(resolveWorkshopActiveTools('wechat_mp')!).toEqual(
      expect.arrayContaining(['wechat_mp_check_setup', 'wechat_mp_create_draft'])
    );
    expect(resolveWorkshopActiveTools('zhihu')!).toContain('zhihu_save_article_draft');
    expect(resolveWorkshopActiveTools('follow_builders')!).toContain('follow_builders_fetch_feed');
  });

  it('ppt:三件发布工具 + sandbox 两件(全产品唯一保留 sandbox 的工坊)', () => {
    const ppt = resolveWorkshopActiveTools('ppt')!;
    expect(ppt).toEqual(
      expect.arrayContaining([
        'ppt_check_env',
        'ppt_publish_deck',
        'ppt_publish_pptx',
        'sandbox_run_command',
        'sandbox_write_file',
      ])
    );
    // 除 ppt 外任何工坊不得挂 sandbox(73 万事件的执行组放大器)
    for (const id of ALL_IDS.filter((i) => i !== 'ppt')) {
      const tools = resolveWorkshopActiveTools(id)!;
      expect(tools.some((t) => t.startsWith('sandbox_')), `${id} 不得含 sandbox`).toBe(false);
    }
  });

  it('invest/edu:email_send 投递通道在列', () => {
    expect(resolveWorkshopActiveTools('invest')!).toContain('email_send');
    expect(resolveWorkshopActiveTools('edu')!).toContain('email_send');
  });
});

describe('resolveWorkshopActiveTools · 挂载面规模(准确率安全线)', () => {
  it('白名单声明数全部 ≤35(业界 30~40 退化线内;实际挂载还受已连服务器收敛)', () => {
    for (const id of ALL_IDS) {
      const tools = resolveWorkshopActiveTools(id)!;
      expect(tools.length, `${id} 声明数 ${tools.length} 超安全线`).toBeLessThanOrEqual(35);
    }
  });

  it('白名单无重复项(Set 派生去重)', () => {
    for (const id of ALL_IDS) {
      const tools = resolveWorkshopActiveTools(id)!;
      expect(new Set(tools).size, id).toBe(tools.length);
    }
  });
});
