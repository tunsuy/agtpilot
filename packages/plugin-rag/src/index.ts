import { Context, Service } from '@deepseek-ai/cordis';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import '@agtpilot/core';

import { cosineSimilarity } from 'ai';

export const name = 'agtpilot-plugin-rag';
export const inject = ['agent'];

export interface DocChunk {
  docId: string;
  docTitle: string;
  chunkId: string;
  content: string;
  tokens: string[];
}

interface UserIndex {
  chunks: DocChunk[];
  docs: Map<string, { title: string; chunksCount: number; indexedAt: number }>;
}

/**
 * 按用户分域的本地知识库检索（bag-of-words 余弦相似度）。
 *
 * 隔离规则：索引按 userId 命名空间划分（CLI 单用户 = 'default'），
 * A 用户索引的私有文档对 B 用户的检索完全不可见 ——
 * 索引与检索都必须以工具 session.userId 为身份锚点。
 */
export class RagService extends Service {
  private cacheDir: string;
  private users: Map<string, UserIndex> = new Map();

  constructor(ctx: Context) {
    super(ctx, 'rag');
    this.cacheDir = path.resolve(process.cwd(), '.cache');
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /** 单用户默认命名空间（CLI 单用户场景；多用户 Web 必须传 session.userId） */
  static userKey(userId?: string): string {
    return (userId || 'default').replace(/[^\w-]/g, '_');
  }

  private indexPathFor(userKey: string): string {
    // 'default' 沿用旧文件名，兼容既有单机索引
    return path.join(this.cacheDir, userKey === 'default' ? 'rag_index.json' : `rag_index_${userKey}.json`);
  }

  private getIndex(userKey: string): UserIndex {
    let idx = this.users.get(userKey);
    if (!idx) {
      idx = { chunks: [], docs: new Map() };
      this.users.set(userKey, idx);
      this.loadIndex(userKey, idx);
    }
    return idx;
  }

  private loadIndex(userKey: string, idx: UserIndex) {
    try {
      const p = this.indexPathFor(userKey);
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        idx.chunks = data.chunks || [];
        if (data.docs) {
          idx.docs = new Map(Object.entries(data.docs));
        }
      }
    } catch (err: any) {
      console.error(`[plugin-rag] 加载索引失败 (${userKey}): ${err.message}`);
    }
  }

  private async saveIndex(userKey: string) {
    const idx = this.getIndex(userKey);
    try {
      const data = {
        docs: Object.fromEntries(idx.docs.entries()),
        chunks: idx.chunks,
      };
      await fsp.writeFile(this.indexPathFor(userKey), JSON.stringify(data, null, 2), 'utf-8');
    } catch (err: any) {
      console.error(`[plugin-rag] 保存索引失败 (${userKey}): ${err.message}`);
    }
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w一-龥]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  async indexDocument(
    userKey: string,
    filePath: string,
    title?: string
  ): Promise<{ success: boolean; chunksCount: number; error?: string }> {
    // 路径围栏：只允许工作区内文档（绝对路径逃逸 / ../ 穿越拒绝）
    const cwd = process.cwd();
    const fullPath = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);
    if (!fullPath.startsWith(cwd + path.sep)) {
      return { success: false, chunksCount: 0, error: `路径越界: ${filePath}（只允许工作区内文档）` };
    }
    try {
      const stat = await fsp.stat(fullPath);
      if (!stat.isFile()) {
        return { success: false, chunksCount: 0, error: `路径不是文件: ${filePath}` };
      }
    } catch {
      return { success: false, chunksCount: 0, error: `文件未找到: ${filePath}` };
    }

    const content = await fsp.readFile(fullPath, 'utf-8');
    const docTitle = title || path.basename(filePath);
    const docId = `doc_${path.relative(cwd, fullPath).replace(/[\/\\]/g, '_')}`;

    const idx = this.getIndex(userKey);
    // 清理该文档旧的 chunks
    idx.chunks = idx.chunks.filter((c) => c.docId !== docId);

    // 分块（按段落切分，过滤过短段落）
    const paragraphs = content.split(/\n\n+/);
    const newChunks: DocChunk[] = [];

    paragraphs.forEach((p, i) => {
      const trimmed = p.trim();
      if (trimmed.length > 20) {
        newChunks.push({
          docId,
          docTitle,
          chunkId: `${docId}_c${i}`,
          content: trimmed,
          tokens: this.tokenize(trimmed),
        });
      }
    });

    idx.chunks.push(...newChunks);
    idx.docs.set(docId, {
      title: docTitle,
      chunksCount: newChunks.length,
      indexedAt: Date.now(),
    });

    await this.saveIndex(userKey);
    return { success: true, chunksCount: newChunks.length };
  }

  search(
    userKey: string,
    query: string,
    topK: number = 3
  ): Array<{ docTitle: string; content: string; score: number }> {
    const idx = this.getIndex(userKey);
    const qTokens = this.tokenize(query);
    if (qTokens.length === 0 || idx.chunks.length === 0) return [];

    // 提取词表向量维度空间
    const vocabulary = Array.from(new Set([...qTokens, ...idx.chunks.flatMap((c) => c.tokens.slice(0, 15))]));
    const qVector = vocabulary.map((word) => (qTokens.includes(word) ? 1 : 0));

    const scored = idx.chunks.map((chunk) => {
      const cVector = vocabulary.map((word) => (chunk.tokens.includes(word) ? 1 : 0));
      const score = cosineSimilarity(qVector, cVector);
      return {
        docTitle: chunk.docTitle,
        content: chunk.content,
        score: Math.round(score * 100) / 100,
      };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  listIndexed(userKey: string) {
    const idx = this.getIndex(userKey);
    return Array.from(idx.docs.entries()).map(([id, info]) => ({
      docId: id,
      ...info,
    }));
  }
}

export function apply(ctx: Context) {
  // 工具路由自注册：prompt 命中知识库/检索类关键词时挂载本插件工具组
  ctx.agent.registerToolRoute({
    id: 'rag',
    prefixes: ['rag_'],
    test: /(知识库|倒排|索引文档|rag)/i,
  });

  const ragService = new RagService(ctx);

  // 1. 索引本地私有文档 (rag_index_document)
  ctx.agent.registerTool({
    name: 'rag_index_document',
    description: '将工作区内指定路径的私有文档（Markdown, Text, 代码等）按段落切分并建立关键词倒排索引（bag-of-words 余弦相似度召回）。索引归当前用户所有，其他用户不可见。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '待索引的本地文件路径 (如: "docs/architecture.md"，须位于当前工作区内)' },
        title: { type: 'string', description: '可选，该文档的展示名称' },
      },
      required: ['filePath'],
    },
    execute: async ({ filePath, title }, session?: any) => {
      const result = await ragService.indexDocument(RagService.userKey(session?.userId), String(filePath), title);
      return {
        success: result.success,
        filePath,
        chunksCount: result.chunksCount,
        message: result.success
          ? `已成功将 [${filePath}] 索引为 ${result.chunksCount} 个分块（归当前用户所有）。`
          : result.error,
      };
    },
  });

  // 2. 关键词检索召回 (rag_search)
  ctx.agent.registerTool({
    name: 'rag_search',
    description: '在当前用户的私有文档知识库中进行关键词相关度检索（bag-of-words 余弦相似度），召回最匹配的文档片段正文。只能检索到当前用户自己索引的文档。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用户的检索问题或关键词' },
        topK: { type: 'number', description: '期望召回的最相关片段数量，默认 3 条' },
      },
      required: ['query'],
    },
    execute: async ({ query, topK = 3 }, session?: any) => {
      const results = ragService.search(RagService.userKey(session?.userId), String(query), topK);
      return {
        success: true,
        query,
        count: results.length,
        results,
      };
    },
  });

  // 3. 列出已索引知识库清单 (rag_list_indexed)
  ctx.agent.registerTool({
    name: 'rag_list_indexed',
    description: '查看当前用户私有 RAG 知识库中已建立索引的全部文档列表及切片数量。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (_args, session?: any) => {
      const docs = ragService.listIndexed(RagService.userKey(session?.userId));
      return {
        success: true,
        totalDocs: docs.length,
        docs,
      };
    },
  });
}
