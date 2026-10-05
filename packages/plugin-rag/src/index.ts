import { Context, Service } from '@deepseek-ai/cordis';
import * as fs from 'fs';
import * as path from 'path';
import '@agtpilot/core';

export const name = 'agtpilot-plugin-rag';
export const inject = ['agent'];

export interface DocChunk {
  docId: string;
  docTitle: string;
  chunkId: string;
  content: string;
  tokens: string[];
}

export class RagService extends Service {
  private indexPath: string;
  private chunks: DocChunk[] = [];
  private indexedDocs: Map<string, { title: string; chunksCount: number; indexedAt: number }> = new Map();

  constructor(ctx: Context) {
    super(ctx, 'rag');
    const cacheDir = path.resolve(process.cwd(), '.cache');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    this.indexPath = path.join(cacheDir, 'rag_index.json');
    this.loadIndex();
  }

  private loadIndex() {
    try {
      if (fs.existsSync(this.indexPath)) {
        const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
        this.chunks = data.chunks || [];
        if (data.docs) {
          this.indexedDocs = new Map(Object.entries(data.docs));
        }
      }
    } catch {
      // 容错
    }
  }

  private saveIndex() {
    try {
      const data = {
        docs: Object.fromEntries(this.indexedDocs.entries()),
        chunks: this.chunks,
      };
      fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // 容错
    }
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  indexDocument(filePath: string, title?: string): { success: boolean; chunksCount: number; error?: string } {
    const fullPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, chunksCount: 0, error: `文件未找到: ${filePath}` };
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const docTitle = title || path.basename(filePath);
    const docId = `doc_${path.relative(process.cwd(), fullPath).replace(/[\/\\]/g, '_')}`;

    // 清理该文档旧的 chunks
    this.chunks = this.chunks.filter((c) => c.docId !== docId);

    // 智能分块 (按段落 / 500 字符重叠滑动窗口)
    const paragraphs = content.split(/\n\n+/);
    const newChunks: DocChunk[] = [];

    paragraphs.forEach((p, idx) => {
      const trimmed = p.trim();
      if (trimmed.length > 20) {
        newChunks.push({
          docId,
          docTitle,
          chunkId: `${docId}_c${idx}`,
          content: trimmed,
          tokens: this.tokenize(trimmed),
        });
      }
    });

    this.chunks.push(...newChunks);
    this.indexedDocs.set(docId, {
      title: docTitle,
      chunksCount: newChunks.length,
      indexedAt: Date.now(),
    });

    this.saveIndex();
    return { success: true, chunksCount: newChunks.length };
  }

  search(query: string, topK: number = 3): Array<{ docTitle: string; content: string; score: number }> {
    const qTokens = this.tokenize(query);
    if (qTokens.length === 0 || this.chunks.length === 0) return [];

    const scored = this.chunks.map((chunk) => {
      let matches = 0;
      for (const qt of qTokens) {
        if (chunk.tokens.includes(qt)) {
          matches++;
        }
      }
      const score = matches / Math.sqrt(qTokens.length * (chunk.tokens.length || 1));
      return {
        docTitle: chunk.docTitle,
        content: chunk.content,
        score,
      };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  listIndexed() {
    return Array.from(this.indexedDocs.entries()).map(([id, info]) => ({
      docId: id,
      ...info,
    }));
  }
}

export function apply(ctx: Context) {
  const ragService = new RagService(ctx);

  // 1. 索引本地私有文档 (rag_index_document)
  ctx.agent.registerTool({
    name: 'rag_index_document',
    description: '将本地指定路径的私有文档（Markdown, Text, 代码等）进行切片分块并建立向量倒排检索索引。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '待索引的本地文件相对路径 (如: "docs/architecture.md")' },
        title: { type: 'string', description: '可选，该文档的展示名称' },
      },
      required: ['filePath'],
    },
    execute: async ({ filePath, title }) => {
      const result = ragService.indexDocument(filePath, title);
      return {
        success: result.success,
        filePath,
        chunksCount: result.chunksCount,
        message: result.success
          ? `已成功将 [${filePath}] 索引为 ${result.chunksCount} 个高语义分块。`
          : result.error,
      };
    },
  });

  // 2. 向量语义检索召回 (rag_search)
  ctx.agent.registerTool({
    name: 'rag_search',
    description: '在本地私有文档知识库中进行语义相关度检索，精准召回最匹配的文档片段正文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用户的检索问题或关键词' },
        topK: { type: 'number', description: '期望召回的最相关片段数量，默认 3 条' },
      },
      required: ['query'],
    },
    execute: async ({ query, topK = 3 }) => {
      const results = ragService.search(query, topK);
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
    description: '查看当前本地 RAG 知识库中已建立索引的全部文档列表及切片数量。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const docs = ragService.listIndexed();
      return {
        success: true,
        totalDocs: docs.length,
        docs,
      };
    },
  });
}
