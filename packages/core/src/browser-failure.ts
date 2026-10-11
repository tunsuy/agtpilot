/**
 * 易碎浏览器操作的失败分类与「下一步指引」（loop 执行优化 P4）。
 *
 * 背景：生产实测一次发布页改版，`xhs_save_note_draft` 选择器超时返回原始
 * Playwright 报错，agent 只能 browser_screenshot → browser_wait(30s 白等) →
 * 3 次 browser_navigate 盲诊，空转 8 轮。根因是错误信息没有告诉模型
 * 「这类失败不是你能自调试的」。
 *
 * 分类器把 Playwright 风格的报错归为环境级故障（页面改版/网络/会话断），
 * 并附带给模型的行动指引——纯函数，plugin-browser 与 apps/web 的托管工具
 * 共用；具体文案可由调用方按场景增强（如 xhs 存草稿引导用户接管浏览器）。
 */

export type BrowserFailureKind = 'page-structure' | 'network' | 'session' | 'unknown';

export interface BrowserFailureGuide {
  kind: BrowserFailureKind;
  /** 一句话归因（给模型判断用，不暴露堆栈） */
  reason: string;
  /** 下一步指引：明确"不要做什么"，阻断盲诊空转 */
  hint: string;
}

/** Playwright 报错文案 → 环境级故障分类 */
export function classifyBrowserFailure(message: string): BrowserFailureGuide {
  const msg = String(message || '');

  // 超时/等待选择器未出现：页面改版或加载过慢（agent 换姿势重试救不了）
  if (/timeout|timed?\s?out|exceeded|waiting for/i.test(msg) && !/net::|ERR_/i.test(msg)) {
    return {
      kind: 'page-structure',
      reason: '页面结构变化或加载过慢，等待的元素/条件未出现',
      hint:
        '这是页面环境级故障，不是参数问题——同样姿势重试大概率再失败。' +
        '最多用 browser_screenshot 看一次当前页面；页面明显异常就停止浏览器操作，' +
        '基于已收集的信息交付，并告知用户该页面暂时无法自动化。',
    };
  }
  // 网络层：目标站点不可达/DNS/连接重置
  if (/net::|ERR_|ECONN|ENOTFOUND|EAI_AGAIN|ECONNRESET|getaddrinfo|navigation failed|导航失败/i.test(msg)) {
    return {
      kind: 'network',
      reason: '目标站点不可达或网络层失败',
      hint: '换一个信息源或稍后再试，不要原地重试同一 URL；连续失败说明该站点当前不可达。',
    };
  }
  // 会话层：页面/上下文/浏览器已被关闭
  if (/target.*(?:page|context).*closed|browser.*closed|page.*closed|会话.*(关闭|断开)/i.test(msg)) {
    return {
      kind: 'session',
      reason: '浏览器会话或页面已被关闭',
      hint: '会话已断：先 browser_navigate 重新打开页面再继续操作。',
    };
  }
  return {
    kind: 'unknown',
    reason: '未分类失败',
    hint: '读完整报错判断：与页面结构相关的按环境级故障处理（停止浏览器操作并交付已有信息），不要盲目重试。',
  };
}
