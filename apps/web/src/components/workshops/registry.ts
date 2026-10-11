/**
 * 工坊注册表 · 场景化的 Agent 任务模版中心
 *
 * 工坊 = 「我想完成一件事」的高频场景入口:表单收集结构化选项 → buildWorkshopRun
 * 生成 Prompt → 作为新任务交给 Agent 执行(与连接器页的凭证配置解耦)。
 * 每个工坊声明自己依赖的连接器(可选增强 / 必需),用于卡片上的数据源状态展示;
 * 新增工坊 = 在这里加一条注册项 + 一个表单组件(forms/) + run.ts 里一个分支。
 */
import {
  Share2,
  MessagesSquare,
  Video,
  Tv,
  Inbox,
  ClipboardList,
  TrendingUp,
  GraduationCap,
  Newspaper,
  type LucideIcon,
} from 'lucide-react';

export type WorkshopId =
  | 'xhs'
  | 'wechat_mp'
  | 'weibo'
  | 'video_douyin'
  | 'video_bilibili'
  | 'email_triage'
  | 'weekly'
  | 'invest'
  | 'edu';

export type WorkshopAccent = 'violet' | 'sky' | 'emerald' | 'indigo';

export interface WorkshopDep {
  /** 连接器 / MCP 连接器 id(用于查询连接状态) */
  id: string;
  name: string;
  /** 必需依赖:未连接时卡片给出去配置入口;默认为可选增强 */
  required?: boolean;
}

/** 工坊交付物声明(P0 仅声明性;渲染按输出解析驱动,此处为 P1 交付库注册预留) */
export interface ArtifactSpec {
  kind: 'note-package' | 'article-package';
  label: string;
}

export interface WorkshopDef {
  id: WorkshopId;
  name: string;
  category: string;
  /** 一句话价值主张(卡片副标题) */
  desc: string;
  icon: LucideIcon;
  accent: WorkshopAccent;
  deps: WorkshopDep[];
  /** 安全与流程说明(表单底部展示,来自各工坊的红线约定) */
  note: string;
  /** 场景档案槽位(scenario-loop §2):声明后首次使用触发档案引导,Prompt 自动注入档案 */
  profileSlot?: string;
  /** 结构化交付物声明 */
  artifacts?: ArtifactSpec[];
}

export const WORKSHOP_CATEGORIES: Array<{ key: string; label: string; accent: WorkshopAccent }> = [
  { key: 'content', label: '内容运营', accent: 'violet' },
  { key: 'office', label: '办公提效', accent: 'sky' },
  { key: 'invest', label: '投研辅助', accent: 'emerald' },
  { key: 'edu', label: '教研学习', accent: 'indigo' },
];

export const WORKSHOPS: WorkshopDef[] = [
  {
    id: 'xhs',
    name: '小红书图文工坊',
    category: 'content',
    desc: 'Agent 选题写文案配标签,你在手机 App 人工确认发布(合规半自动)',
    icon: Share2,
    accent: 'violet',
    deps: [
      { id: 'newsnow', name: '全网热榜' },
      { id: 'zhihu', name: '知乎' },
      { id: 'twitterapi_io', name: 'X / Twitter' },
      { id: 'exa', name: '网络搜索' },
    ],
    note: 'Agent 产出标题/正文/标签/配图建议。复制满意的一篇 → 连接器页小红书「真机唤起」→ 手机 App 粘贴、人工核对后发布。已连接热榜/搜索类连接器时选题走实时热点。',
    profileSlot: 'xhs',
    artifacts: [{ kind: 'note-package', label: '小红书笔记包' }],
  },
  {
    id: 'wechat_mp',
    name: '公众号文章工坊',
    category: 'content',
    desc: 'Agent 选题成稿投草稿箱,你逐次审批放行,公众平台后台人工发布',
    icon: Newspaper,
    accent: 'violet',
    deps: [
      { id: 'newsnow', name: '全网热榜' },
      { id: 'zhihu', name: '知乎' },
      { id: 'twitterapi_io', name: 'X / Twitter' },
      { id: 'exa', name: '网络搜索' },
    ],
    note: 'Agent 产出标题候选/摘要/Markdown 正文/封面建议/发布建议。满意的一篇点「投草稿箱」——经你逐次审批后写入公众号草稿箱(每日有次数上限),最终发布由你在公众平台后台人工完成,Agent 不碰任何发布/群发接口。凭证(AppID:AppSecret,需已认证公众号 + IP 白名单)在连接器页「微信公众号(草稿箱直连)」卡片配置,表单内可查看状态并测试连接。',
    profileSlot: 'wechat_mp',
    artifacts: [{ kind: 'article-package', label: '公众号文章包' }],
  },
  {
    id: 'weibo',
    name: '微博图文工坊',
    category: 'content',
    desc: '热点点评/干货/种草,Agent 创作你发布,前两行自带钩子',
    icon: MessagesSquare,
    accent: 'violet',
    deps: [
      { id: 'newsnow', name: '全网热榜' },
      { id: 'zhihu', name: '知乎' },
      { id: 'twitterapi_io', name: 'X / Twitter' },
      { id: 'exa', name: '网络搜索' },
    ],
    note: 'Agent 产出正文/话题标签/配图建议。复制满意的一条 → 表单底部「唤起微博」→ 手机 App 粘贴、人工核对后发布。已连接热榜/搜索类连接器时选题走实时热点。',
  },
  {
    id: 'video_douyin',
    name: '抖音脚本工坊',
    category: 'content',
    desc: '标题/分镜表/前 15 秒口播逐字稿/标签成套产出,竖屏快节奏',
    icon: Video,
    accent: 'violet',
    deps: [
      { id: 'newsnow', name: '全网热榜' },
      { id: 'zhihu', name: '知乎' },
      { id: 'twitterapi_io', name: 'X / Twitter' },
      { id: 'exa', name: '网络搜索' },
    ],
    note: 'Agent 产出标题/分镜脚本/口播稿/标签/封面文案。你拍摄剪辑后 → 表单底部「唤起抖音」→ App 上传、人工核对后发布。已连接热榜/搜索类连接器时选题走实时热点。',
  },
  {
    id: 'video_bilibili',
    name: 'B站脚本工坊',
    category: 'content',
    desc: '横屏信息密度优先,预留弹幕互动点,含投稿分区建议',
    icon: Tv,
    accent: 'violet',
    deps: [
      { id: 'newsnow', name: '全网热榜' },
      { id: 'zhihu', name: '知乎' },
      { id: 'twitterapi_io', name: 'X / Twitter' },
      { id: 'exa', name: '网络搜索' },
    ],
    note: 'Agent 产出标题/分镜脚本/口播稿/标签分区/封面文案。你拍摄剪辑后 → 表单底部「唤起哔哩哔哩」→ App 上传、人工核对后发布。已连接热榜/搜索类连接器时选题走实时热点。',
  },
  {
    id: 'email_triage',
    name: '邮件分诊',
    category: 'office',
    desc: '收件箱自动分四级优先级,高优邮件草拟回复,发送前逐封经你确认',
    icon: Inbox,
    accent: 'sky',
    deps: [{ id: 'email_imap', name: '邮箱收件 (IMAP)', required: true }],
    note: '生成后跳转任务页,Agent 用 email_list/email_read 读取收件箱,输出总览 + 四级分诊清单(🔴立即/🟠今日/🟡稍后/⚪可忽略)与回复草稿。发送任何回复、改动邮件状态都需你逐封确认。需先在「电子邮件收件 (IMAP)」配置凭证(或已配 SMTP 会自动复用)。',
  },
  {
    id: 'weekly',
    name: '周报生成',
    category: 'office',
    desc: '从已连接的 Jira/GitHub/飞书/邮箱自动取材,结构化周报一键成稿',
    icon: ClipboardList,
    accent: 'sky',
    deps: [
      { id: 'atlassian_mcp', name: 'Jira' },
      { id: 'github_mcp', name: 'GitHub' },
      { id: 'lark_suite', name: '飞书' },
      { id: 'dingtalk_mcp', name: '钉钉' },
      { id: 'email_imap', name: '邮箱' },
    ],
    note: '生成后跳转任务页,Agent 从你已连接的 Jira/GitHub/飞书/钉钉/腾讯会议/邮箱自动取材,输出结构化周报(概览/重点工作/数据看板/风险/下周计划)。先展示全文,投递(邮件/群机器人)需你确认;数据源都不可用时按补充要点整理。',
  },
  {
    id: 'invest',
    name: '投研工坊',
    category: 'invest',
    desc: '个股/基金体检 · 持仓组合体检 · 盘后复盘,数据带来源与时间戳',
    icon: TrendingUp,
    accent: 'emerald',
    deps: [
      { id: 'tushare', name: 'Tushare' },
      { id: 'a_stock', name: 'A股实时行情' },
      { id: 'alphavantage_mcp', name: 'Alpha Vantage' },
      { id: 'coingecko_mcp', name: 'CoinGecko' },
      { id: 'newsnow', name: '财经热榜' },
    ],
    note: '生成后跳转任务页,Agent 通过你已连接的行情连接器拉取实时行情与估值,财经热榜/网络搜索取新闻与市场热点,输出带来源与时间戳的结构化投研报告。全程只读:不执行任何交易、不动资金;报告经邮件/群机器人发送前需你确认。输出仅供参考,不构成投资建议。',
  },
  {
    id: 'edu',
    name: '教研工坊',
    category: 'edu',
    desc: '文献综述 · 论文精读 · 智能备课 · 学习卡片,引用附 DOI 严禁编造',
    icon: GraduationCap,
    accent: 'indigo',
    deps: [
      { id: 'openalex', name: 'OpenAlex' },
      { id: 'alphaxiv', name: 'alphaXiv' },
      { id: 'huggingface_mcp', name: 'Hugging Face' },
      { id: 'deepl_mcp', name: 'DeepL' },
    ],
    note: '生成后跳转任务页,Agent 通过你已连接的 OpenAlex / alphaXiv / Hugging Face / DeepL 连接器检索真实文献(缺失时降级为网络搜索并明示),按模式产出文献综述 / 论文精读卡 / 教案 / 学习卡片。每条引用附 DOI 或 arXiv ID、严禁编造参考文献;全程只读、不改你的文献库;成果经邮件/群机器人投递前需你确认。',
  },
];

export function getWorkshop(id: string): WorkshopDef | undefined {
  return WORKSHOPS.find((w) => w.id === id);
}
