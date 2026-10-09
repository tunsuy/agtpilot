import { Context, Service } from '@deepseek-ai/cordis';
import { ArtifactData } from '@agtpilot/protocol';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-artifact';
export const inject = ['agent'];

declare module '@deepseek-ai/cordis' {
  interface Context {
    artifact: ArtifactService;
  }
}

export class ArtifactService extends Service {
  /** 产物上限：超限淘汰最旧 —— 防长驻进程无界增长 */
  private static readonly MAX_ARTIFACTS = 50;
  private artifacts: Map<string, ArtifactData> = new Map();
  private latestArtifactId: string | null = null;

  constructor(ctx: Context) {
    super(ctx, 'artifact');
  }

  createOrUpdateArtifact(
    data: Omit<ArtifactData, 'id' | 'timestamp'> & { id?: string },
    taskId?: string
  ): ArtifactData {
    const id = data.id || `art_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const artifact: ArtifactData = {
      ...data,
      id,
      timestamp: Date.now(),
      ...(taskId ? { taskId } : {}),
    };

    // 同 id 更新不重复计数
    if (!this.artifacts.has(id) && this.artifacts.size >= ArtifactService.MAX_ARTIFACTS) {
      const oldest = Array.from(this.artifacts.values()).sort((a, b) => a.timestamp - b.timestamp)[0];
      if (oldest) this.artifacts.delete(oldest.id);
    }

    this.artifacts.set(id, artifact);
    if (this.latestArtifactId && !this.artifacts.has(this.latestArtifactId)) {
      this.latestArtifactId = null;
    }
    this.latestArtifactId = id;

    // 产物经 AgentEvent 流（type: 'artifact'）广播给前端 —— 这是唯一送达路径
    this.ctx.agent.emitEvent({
      type: 'artifact',
      payload: artifact,
      timestamp: artifact.timestamp,
    });

    return artifact;
  }

  getArtifact(id: string): ArtifactData | undefined {
    return this.artifacts.get(id);
  }

  getLatestArtifact(taskId?: string): ArtifactData | undefined {
    if (taskId) {
      const scoped = Array.from(this.artifacts.values())
        .filter((a) => a.taskId === taskId)
        .sort((a, b) => b.timestamp - a.timestamp);
      return scoped[0];
    }
    if (!this.latestArtifactId) return undefined;
    return this.artifacts.get(this.latestArtifactId);
  }

  listArtifacts(taskId?: string): ArtifactData[] {
    const all = Array.from(this.artifacts.values());
    return (taskId ? all.filter((a) => a.taskId === taskId) : all).sort(
      (a, b) => b.timestamp - a.timestamp
    );
  }
}

export function apply(ctx: Context) {
  const artifactService = new ArtifactService(ctx);

  // 注册核心原子工具：artifact_render
  ctx.agent.registerTool({
    name: 'artifact_render',
    baseline: true,
    description: '在中心画布(Canvas/Artifact)中渲染高保真产物。支持代码高亮(code)、富文本报告(markdown)、交互式HTML/React组件(html)以及Mermaid架构/流程图(chart)。当生成完整代码、编写综合调研报告、绘制架构图或制作前端页面时务必调用此工具呈现。',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '产物标题 (例如: "快速排序算法实现", "GitHub AI 趋势分析周报", "微服务架构时序图", "智能体驾驶舱组件")',
        },
        type: {
          type: 'string',
          enum: ['code', 'html', 'markdown', 'chart'],
          description: '产物类型：code (编程语言源代码), html (独立网页/可交互组件), markdown (图文长篇报告/表格), chart (Mermaid 流程/架构/时序图)',
        },
        content: {
          type: 'string',
          description: '产物的完整文本内容。如果是 code 则为纯源码，html 则为完整 HTML，chart 则为合法 Mermaid 语法，markdown 则为标准 Markdown 文本。',
        },
        language: {
          type: 'string',
          description: '可选，仅在 type 为 code 时指定语言 (如: typescript, python, json, bash, sql, rust)',
        },
        description: {
          type: 'string',
          description: '可选，对该产物的设计思路、核心特性或使用方式的简要说明',
        },
      },
      required: ['title', 'type', 'content'],
    },
    execute: async (args, session?: any) => {
      const artifact = artifactService.createOrUpdateArtifact(
        {
          title: args.title,
          type: args.type,
          content: args.content,
          language: args.language,
          description: args.description,
        },
        session?.taskId
      );

      return {
        success: true,
        artifactId: artifact.id,
        title: artifact.title,
        type: artifact.type,
        message: `已成功在用户中心画布实时呈现产物 [${artifact.title}] (${artifact.type})。`,
      };
    },
  });
}
