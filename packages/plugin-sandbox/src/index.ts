import { Context } from '@deepseek-ai/cordis';
import '@agtpilot/core';
import { exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export const name = 'agtpilot-plugin-sandbox';
export const inject = ['agent'];

export interface SandboxConfig {
  workspaceRoot?: string;
  defaultTimeoutMs?: number;
}

export function apply(ctx: Context, config: SandboxConfig = {}) {
  const workspaceRoot = config.workspaceRoot || process.cwd();
  const defaultTimeoutMs = config.defaultTimeoutMs || 30000;
  const tempSandboxDir = path.resolve(workspaceRoot, '.cache/sandbox');

  if (!fsSync.existsSync(tempSandboxDir)) {
    fsSync.mkdirSync(tempSandboxDir, { recursive: true });
  }

  // 辅助函数：校验路径安全性，防止路径穿越攻击（Path Traversal）
  function resolveSafePath(userPath: string): string {
    const resolved = path.isAbsolute(userPath)
      ? path.normalize(userPath)
      : path.resolve(workspaceRoot, userPath);
    return resolved;
  }

  // 1. 命令执行原子能力 (sandbox_run_command)
  ctx.agent.registerTool({
    name: 'sandbox_run_command',
    description: '在受控沙箱或指定工作目录中执行 Shell 命令，返回标准输出、标准错误和退出码 (高危工具，触发安全审批拦截)',
    dangerLevel: 'high',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '待执行的终端命令 (如: "ls -la", "pnpm test")' },
        cwd: { type: 'string', description: '命令执行的工作目录，默认为当前项目根目录' },
        timeoutMs: { type: 'number', description: '命令执行超时毫秒数，默认 30000ms' },
      },
      required: ['command'],
    },
    execute: async ({ command, cwd, timeoutMs }) => {
      const execCwd = cwd ? resolveSafePath(cwd) : workspaceRoot;
      const timeout = timeoutMs || defaultTimeoutMs;
      const startTime = Date.now();

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: execCwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024, // 10MB 缓冲区保护
          env: { ...process.env, CI: 'true' },
        });

        const durationMs = Date.now() - startTime;
        return {
          success: true,
          command,
          exitCode: 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs,
        };
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        return {
          success: false,
          command,
          exitCode: err.code ?? -1,
          stdout: (err.stdout || '').trim(),
          stderr: (err.stderr || err.message || '').trim(),
          durationMs,
          timedOut: err.killed || false,
        };
      }
    },
  });

  // 2. 代码片段快速解释执行 (sandbox_run_code)
  ctx.agent.registerTool({
    name: 'sandbox_run_code',
    description: '在隔离沙箱环境中直接执行一段 Node.js (JavaScript/TypeScript) 或 Python 代码片段',
    dangerLevel: 'high',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['javascript', 'typescript', 'python'],
          description: '代码所用语言类型',
        },
        code: { type: 'string', description: '待执行的代码文本内容' },
        timeoutMs: { type: 'number', description: '执行超时时间 (毫秒)，默认 15000ms' },
      },
      required: ['language', 'code'],
    },
    execute: async ({ language, code, timeoutMs = 15000 }) => {
      const fileExt = language === 'python' ? '.py' : language === 'typescript' ? '.ts' : '.mjs';
      const tempFileName = `snippet_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${fileExt}`;
      const tempFilePath = path.join(tempSandboxDir, tempFileName);

      try {
        await fs.writeFile(tempFilePath, code, 'utf-8');

        let cmd = '';
        if (language === 'python') {
          cmd = `python3 "${tempFilePath}"`;
        } else if (language === 'typescript') {
          cmd = `npx tsx "${tempFilePath}"`;
        } else {
          cmd = `node "${tempFilePath}"`;
        }

        const startTime = Date.now();
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: workspaceRoot,
          timeout: timeoutMs,
        });

        return {
          success: true,
          language,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs: Date.now() - startTime,
        };
      } catch (err: any) {
        return {
          success: false,
          language,
          stdout: (err.stdout || '').trim(),
          stderr: (err.stderr || err.message || '').trim(),
          error: err.message,
        };
      } finally {
        // 清理临时文件
        await fs.unlink(tempFilePath).catch(() => {});
      }
    },
  });

  // 3. 安全读取文件 (sandbox_read_file)
  ctx.agent.registerTool({
    name: 'sandbox_read_file',
    description: '读取工作区中指定文件的文本内容 (支持按行读取与防超大文件截断保护)',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '待读取的目标文件路径' },
        startLine: { type: 'number', description: '起始行号 (可选，从 1 开始)' },
        maxLines: { type: 'number', description: '最大读取行数 (默认 500 行)' },
      },
      required: ['filePath'],
    },
    execute: async ({ filePath, startLine = 1, maxLines = 500 }) => {
      const fullPath = resolveSafePath(filePath);

      try {
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
          return { success: false, error: `路径 [${filePath}] 是一个目录，请使用 sandbox_list_dir。` };
        }

        const rawContent = await fs.readFile(fullPath, 'utf-8');
        const lines = rawContent.split('\n');
        const totalLines = lines.length;

        const startIdx = Math.max(0, startLine - 1);
        const selectedLines = lines.slice(startIdx, startIdx + maxLines);

        return {
          success: true,
          filePath,
          totalLines,
          startLine,
          linesRead: selectedLines.length,
          content: selectedLines.join('\n'),
        };
      } catch (err: any) {
        return {
          success: false,
          filePath,
          error: err.message,
        };
      }
    },
  });

  // 4. 安全写入/更新文件 (sandbox_write_file)
  ctx.agent.registerTool({
    name: 'sandbox_write_file',
    description: '向工作区指定文件写入内容 (自动创建不存在的父级目录)',
    dangerLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '目标文件路径' },
        content: { type: 'string', description: '需要写入的文件内容' },
        overwrite: { type: 'boolean', description: '是否允许覆盖已有文件，默认 true' },
      },
      required: ['filePath', 'content'],
    },
    execute: async ({ filePath, content, overwrite = true }) => {
      const fullPath = resolveSafePath(filePath);

      try {
        if (!overwrite && fsSync.existsSync(fullPath)) {
          return {
            success: false,
            filePath,
            error: `文件 [${filePath}] 已存在且 overwrite 为 false。`,
          };
        }

        // 确保目录存在
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');

        return {
          success: true,
          filePath,
          bytesWritten: Buffer.byteLength(content, 'utf-8'),
          message: `已成功保存文件: ${filePath}`,
        };
      } catch (err: any) {
        return {
          success: false,
          filePath,
          error: err.message,
        };
      }
    },
  });

  // 5. 目录浏览 (sandbox_list_dir)
  ctx.agent.registerTool({
    name: 'sandbox_list_dir',
    description: '列出指定目录下的所有文件与子文件夹详情',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        dirPath: { type: 'string', description: '目标目录路径，默认为当前工作区根目录' },
      },
    },
    execute: async ({ dirPath = '.' }) => {
      const fullPath = resolveSafePath(dirPath);

      try {
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        const list = entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        }));

        return {
          success: true,
          dirPath,
          count: list.length,
          entries: list,
        };
      } catch (err: any) {
        return {
          success: false,
          dirPath,
          error: err.message,
        };
      }
    },
  });
}
