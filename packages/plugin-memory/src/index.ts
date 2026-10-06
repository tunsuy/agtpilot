import { Context, Service } from '@deepseek-ai/cordis';
import * as fs from 'fs';
import * as path from 'path';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-memory';
export const inject = ['agent'];

export interface MemoryRecord {
  id: string;
  category: 'preference' | 'project' | 'fact' | 'rule';
  title: string;
  content: string;
  confidence: number;
  updatedAt: number;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService;
  }
}

export class MemoryService extends Service {
  private memoryFilePath: string;
  private memories: Map<string, MemoryRecord> = new Map();

  constructor(ctx: Context) {
    super(ctx, 'memory');
    const cacheDir = path.resolve(process.cwd(), '.cache');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    this.memoryFilePath = path.join(cacheDir, 'long_term_memory.json');
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(this.memoryFilePath)) {
        const raw = fs.readFileSync(this.memoryFilePath, 'utf-8');
        const list: MemoryRecord[] = JSON.parse(raw);
        for (const item of list) {
          this.memories.set(item.id, item);
        }
      }
    } catch {
      // 容错处理
    }
  }

  private saveToDisk() {
    try {
      const list = Array.from(this.memories.values());
      fs.writeFileSync(this.memoryFilePath, JSON.stringify(list, null, 2), 'utf-8');
    } catch {
      // 容错处理
    }
  }

  storeMemory(
    title: string,
    content: string,
    category: MemoryRecord['category'] = 'fact',
    id?: string
  ): MemoryRecord {
    const memoryId = id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const record: MemoryRecord = {
      id: memoryId,
      title,
      content,
      category,
      confidence: 1.0,
      updatedAt: Date.now(),
    };

    this.memories.set(memoryId, record);
    this.saveToDisk();
    return record;
  }

  deleteMemory(id: string): boolean {
    const existed = this.memories.delete(id);
    if (existed) {
      this.saveToDisk();
    }
    return existed;
  }

  clearMemories(): void {
    this.memories.clear();
    this.saveToDisk();
  }

  recall(query: string, category?: MemoryRecord['category']): MemoryRecord[] {
    const q = query.toLowerCase().trim();
    const results: MemoryRecord[] = [];

    for (const item of this.memories.values()) {
      if (category && item.category !== category) continue;
      if (
        item.title.toLowerCase().includes(q) ||
        item.content.toLowerCase().includes(q) ||
        q.includes(item.title.toLowerCase())
      ) {
        results.push(item);
      }
    }

    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listAll(): MemoryRecord[] {
    return Array.from(this.memories.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getPromptContext(): string {
    const items = this.listAll().slice(0, 10);
    if (items.length === 0) return '';
    return (
      '【已沉淀的长期个人与项目记忆】:\n' +
      items.map((m) => `- [${m.category.toUpperCase()}] ${m.title}: ${m.content}`).join('\n')
    );
  }
}

export function apply(ctx: Context) {
  const memoryService = new MemoryService(ctx);

  // 1. 存储长期记忆 (memory_store)
  ctx.agent.registerTool({
    name: 'memory_store',
    description: '长期记住用户的习惯偏好、技术栈规范、专属业务知识或踩坑经验。存储后的记忆会持久化到磁盘并在未来的跨会话任务中永久生效。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '记忆简短标题 (例如: "代码风格偏好", "阿里云ECS配置规范", "项目构建脚本习惯")' },
        content: { type: 'string', description: '要牢记的核心知识点或偏好细节' },
        category: {
          type: 'string',
          enum: ['preference', 'project', 'fact', 'rule'],
          description: '记忆类型：preference (用户个人偏好), project (项目背景), fact (关键事实), rule (执行红线与规则)',
        },
      },
      required: ['title', 'content'],
    },
    execute: async ({ title, content, category }) => {
      const record = memoryService.storeMemory(title, content, category);
      return {
        success: true,
        memoryId: record.id,
        title: record.title,
        category: record.category,
        message: `已成功将记忆 [${record.title}] 永久固化到长期记忆知识库中。`,
      };
    },
  });

  // 2. 检索长期记忆 (memory_recall)
  ctx.agent.registerTool({
    name: 'memory_recall',
    description: '在执行任务前检索长期记忆库，主动获取过去沉淀的用户偏好、项目知识与历史踩坑规则。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词 (如: "部署习惯", "前端规范", "Python环境")' },
        category: {
          type: 'string',
          enum: ['preference', 'project', 'fact', 'rule'],
          description: '可选，限定检索的记忆类型',
        },
      },
      required: ['query'],
    },
    execute: async ({ query, category }) => {
      const results = memoryService.recall(query, category);
      return {
        success: true,
        query,
        count: results.length,
        memories: results.map((r) => ({
          title: r.title,
          content: r.content,
          category: r.category,
        })),
      };
    },
  });

  // 3. 列出所有沉淀的记忆 (memory_list)
  ctx.agent.registerTool({
    name: 'memory_list',
    description: '列出当前长期记忆库中所有已记录的用户偏好和项目知识清单。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const list = memoryService.listAll();
      return {
        success: true,
        total: list.length,
        memories: list.map((m) => ({
          id: m.id,
          title: m.title,
          category: m.category,
          updatedAt: new Date(m.updatedAt).toISOString(),
        })),
      };
    },
  });
}
