import type { MissionStep } from '../types/agent';

/**
 * 执行活动叙述层（纯函数，便于单测）：把内部 loop 的 step / tool 翻译成
 * 用户能读懂的行动语言，供右侧工作台「执行动态」活动流渲染。
 *
 * 约定：label 是不含时态的动宾短语（如「搜索「xx」」「打开网页」），
 * 渲染层按 status 组装 —— RUNNING 加「正在」前缀，DONE 带 ✓ 与耗时。
 */
export type ActivityKind =
  | 'user'
  | 'think'
  | 'reply'
  | 'search'
  | 'browser'
  | 'sandbox'
  | 'artifact'
  | 'connector'
  | 'planner'
  | 'memory'
  | 'notify'
  | 'generic';

export interface NarratedActivity {
  kind: ActivityKind;
  /** 用户可读的行动短语（不含「正在」等时态前缀） */
  label: string;
  /** 补充细节：URL / 命令 / 文件路径 / 文档标题等，单行截断展示 */
  detail?: string;
}

const clip = (s: unknown, n = 80): string | undefined => {
  const t = typeof s === 'string' ? s.trim() : '';
  if (!t) return undefined;
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 工具步骤 → 人话动作。按真实工具名逐个映射，未识别的兜底为「执行任务」。 */
function narrateTool(tool: string, args: any = {}): NarratedActivity {
  const query = clip(args?.query || args?.q, 40);
  const url = clip(args?.url, 60);
  const command = clip(args?.command, 60);
  const path = clip(args?.path || args?.file_path || args?.filePath, 60);
  const title = clip(args?.title, 40);
  const text = clip(args?.text || args?.value || args?.action || args?.instruction, 60);

  // 前缀判定优先于宽松的 includes('search')：mcp_notion__search 这类
  // 连接器工具名内嵌 search 字样，不能被误归为搜索动作
  if (tool.startsWith('mcp_')) {
    return { kind: 'connector', label: '调用外部服务', detail: clip(tool, 50) };
  }
  if (tool.startsWith('notify_')) {
    return { kind: 'notify', label: '发送通知' };
  }

  if (tool.includes('search')) {
    return { kind: 'search', label: query ? `搜索「${query}」` : '搜索资料' };
  }

  switch (tool) {
    case 'browser_navigate':
      return { kind: 'browser', label: '打开网页', detail: url };
    case 'browser_firecrawl_scrape':
      return { kind: 'browser', label: '抓取网页内容', detail: url };
    case 'browser_screenshot':
      return { kind: 'browser', label: '截取页面快照' };
    case 'browser_click':
      return { kind: 'browser', label: '点击网页元素', detail: text };
    case 'browser_type':
    case 'browser_fill':
      return { kind: 'browser', label: '在网页中输入内容', detail: text };
    case 'browser_upload':
      return { kind: 'browser', label: '上传文件' };
    case 'browser_wait':
      return { kind: 'browser', label: '等待页面加载' };
    case 'browser_stagehand_observe':
      return { kind: 'browser', label: '观察页面结构' };
    case 'browser_stagehand_act':
      return { kind: 'browser', label: '在网页上执行操作', detail: text };
    case 'sandbox_run_command':
      return { kind: 'sandbox', label: '运行命令', detail: command };
    case 'sandbox_run_code':
      return { kind: 'sandbox', label: '运行代码' };
    case 'sandbox_http_request':
      return { kind: 'sandbox', label: '发起网络请求', detail: url };
    case 'sandbox_read_file':
      return { kind: 'sandbox', label: '读取文件', detail: path };
    case 'sandbox_write_file':
      return { kind: 'sandbox', label: '写入文件', detail: path };
    case 'sandbox_list_dir':
      return { kind: 'sandbox', label: '查看目录', detail: path };
    case 'artifact_render':
      return { kind: 'artifact', label: '生成交付文档', detail: title };
    case 'planner_create_plan':
      return { kind: 'planner', label: '创建任务看板' };
    case 'planner_update_task':
      return { kind: 'planner', label: '推进任务看板' };
    case 'connector_authorize':
      return { kind: 'connector', label: '发起连接器授权' };
    case 'memory_store':
      return { kind: 'memory', label: '沉淀长期记忆' };
    case 'memory_recall':
    case 'memory_list':
      return { kind: 'memory', label: '检索长期记忆' };
    case 'xhs_read_creator_data':
      return { kind: 'connector', label: '读取小红书创作数据' };
    case 'xhs_save_note_draft':
      return { kind: 'connector', label: '保存小红书笔记草稿' };
    case 'wechat_mp_create_draft':
      return { kind: 'connector', label: '写入公众号草稿箱' };
  }

  if (tool.startsWith('browser_')) {
    return { kind: 'browser', label: '操作网页' };
  }
  if (tool.startsWith('sandbox_')) {
    return { kind: 'sandbox', label: '沙盒执行' };
  }
  if (tool.startsWith('xhs_')) {
    return { kind: 'connector', label: '操作小红书' };
  }
  if (tool.startsWith('wechat_mp_')) {
    return { kind: 'connector', label: '操作公众号' };
  }
  return { kind: 'generic', label: '执行任务', detail: clip(tool, 50) };
}

/** 单个 step → 叙述条目；用户步骤作为轮次分隔行保留，其余 null 不展示。 */
export function narrateStep(step: MissionStep): NarratedActivity | null {
  if (step.role === 'user') {
    return { kind: 'user', label: '提出请求', detail: clip(step.userPrompt || step.title, 60) };
  }

  if (!step.tool) {
    // assistant 推理 / 回复步骤（live step 与最终答复）
    if (step.messageKind === 'final') {
      return { kind: 'reply', label: '交付最终答复' };
    }
    if (step.status === 'RUNNING') {
      if (step.answer) return { kind: 'reply', label: '撰写回复' };
      if (step.reasoning) return { kind: 'think', label: '深度思考' };
      // wrap-up 收尾轮的 live step 标题为「正在做最终总结…」
      if (step.title?.includes('总结')) return { kind: 'think', label: '整理最终结论' };
      return { kind: 'think', label: '思考' };
    }
    if (step.answer) return { kind: 'think', label: '完成阶段分析', detail: clip(step.answer, 60) };
    return { kind: 'think', label: '完成一轮推理' };
  }

  return narrateTool(step.tool, step.args);
}

/** duration("3200ms") → 人类可读("3.2s" / "1m05s")；无或非法返回 undefined */
export function formatActivityDuration(duration?: string): string | undefined {
  if (!duration) return undefined;
  const ms = Number.parseInt(String(duration).replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}
