import { Context } from '@deepseek-ai/cordis';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import '@agtpilot/core';

import * as Diff from 'diff';

const execAsync = promisify(exec);

export const name = 'agtpilot-plugin-git';
export const inject = ['agent'];

export function apply(ctx: Context) {
  const cwd = process.cwd();

  // 1. git_status: 查看当前 Git 工作区与分支状态
  ctx.agent.registerTool({
    name: 'git_status',
    description: '查看当前工程代码库的 Git 状态（当前分支、未提交的文件变动、新增未跟踪文件）。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      try {
        const { stdout: status } = await execAsync('git status -s', { cwd });
        const { stdout: branch } = await execAsync('git branch --show-current', { cwd });
        return {
          success: true,
          branch: branch.trim(),
          changedFiles: status.trim() ? status.trim().split('\n') : [],
          clean: !status.trim(),
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });

  // 2. git_diff: 获取修改对比 Diff
  ctx.agent.registerTool({
    name: 'git_diff',
    description: '获取代码库中工作区与暂存区的详细 Git Diff 补丁内容，用于精准代码审查。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '可选，限定审查特定文件的 diff' },
        staged: { type: 'boolean', description: '是否查看已暂存(staged)的 diff，默认 false' },
      },
    },
    execute: async ({ file, staged }) => {
      try {
        const cmd = `git diff ${staged ? '--staged' : ''} ${file ? `-- "${file}"` : ''}`;
        const { stdout } = await execAsync(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 });
        return {
          success: true,
          diff: stdout.trim() || '（当前无改动）',
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });

  // 3. git_apply_patch: 精准应用 Unified Diff / 局部补丁 (基于官方 jsdiff 引擎)
  ctx.agent.registerTool({
    name: 'git_apply_patch',
    description: '集成全球标准 diff 库与 Aider 补丁引擎：对目标文件应用标准 Unified Diff 补丁或指定查找块替换，支持 hunk 行号容差对齐，避免全文件重写丢失代码。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '要修改的文件相对路径' },
        patchString: { type: 'string', description: '可选，标准 Unified Diff 补丁文本（包含 @@ -l,s +l,s @@ hunk 头）' },
        searchBlock: { type: 'string', description: '可选，原文件中要被替换的代码段（必须匹配上下文）' },
        replaceBlock: { type: 'string', description: '可选，替换后的新代码段' },
      },
      required: ['filePath'],
    },
    execute: async ({ filePath, patchString, searchBlock, replaceBlock }) => {
      const fullPath = path.resolve(cwd, filePath);
      if (!fs.existsSync(fullPath)) {
        return { success: false, error: `文件未找到: ${filePath}` };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');

      // 方案 A: 如果提供了标准 Unified Diff，使用业界顶级的 jsdiff.applyPatch
      if (patchString) {
        const patched = Diff.applyPatch(content, patchString, { fuzzFactor: 2 });
        if (typeof patched === 'string') {
          fs.writeFileSync(fullPath, patched, 'utf-8');
          return {
            success: true,
            filePath,
            engine: 'jsdiff',
            message: `标准 Unified Diff 已通过官方 diff 引擎成功应用至 [${filePath}]。`,
          };
        }
      }

      // 方案 B: 精准匹配块替换
      if (searchBlock !== undefined && replaceBlock !== undefined) {
        if (!content.includes(searchBlock)) {
          return {
            success: false,
            error: `无法在 [${filePath}] 中匹配到原代码段 searchBlock，请先核验文件最新内容。`,
          };
        }
        const updated = content.replace(searchBlock, replaceBlock);
        fs.writeFileSync(fullPath, updated, 'utf-8');
        return {
          success: true,
          filePath,
          engine: 'fuzzy-block',
          message: `局部代码块已安全替换更新至 [${filePath}]。`,
        };
      }

      return { success: false, error: '必须提供 patchString 或 (searchBlock + replaceBlock)' };
    },
  });

  // 4. git_create_patch: 使用 diff 库生成两个文本版本的 Unified Diff
  ctx.agent.registerTool({
    name: 'git_create_patch',
    description: '使用官方 diff 库比较原文本与修改文本，生成标准的 Unified Diff 补丁字符串。',
    parameters: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: '展示的文件名' },
        oldContent: { type: 'string', description: '修改前的原始内容' },
        newContent: { type: 'string', description: '修改后的最新内容' },
      },
      required: ['fileName', 'oldContent', 'newContent'],
    },
    execute: async ({ fileName, oldContent, newContent }) => {
      const patch = Diff.createTwoFilesPatch(
        fileName,
        fileName,
        oldContent,
        newContent,
        'original',
        'modified'
      );
      return {
        success: true,
        fileName,
        patch,
      };
    },
  });

  // 5. git_create_checkpoint: 建立安全快照分支
  ctx.agent.registerTool({
    name: 'git_create_checkpoint',
    description: '在进行大型重构或危险修改前，创建临时快照备份分支，支持随时一键回滚。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '快照标识名称 (如: refactor_auth)' },
      },
      required: ['name'],
    },
    execute: async ({ name }) => {
      try {
        const branchName = `checkpoint/${name}_${Date.now()}`;
        await execAsync(`git branch "${branchName}"`, { cwd });
        return {
          success: true,
          checkpointBranch: branchName,
          message: `已建立安全备份分支 [${branchName}]。若后续操作异常可快速还原。`,
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });

  // 5. codebase_search_symbols: 全局代码符号与关键词检索
  ctx.agent.registerTool({
    name: 'codebase_search_symbols',
    description: '在整个代码工程中高速全文检索符号、函数、类定义或关键字符串，自动忽略 node_modules、.git 等噪音目录。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索的符号名或正则表达式 (如: "export function apply", "OrchestratorService")' },
        extension: { type: 'string', description: '可选，限定文件后缀 (如: "ts", "tsx", "py", "json")' },
      },
      required: ['query'],
    },
    execute: async ({ query, extension }) => {
      try {
        const extFilter = extension ? `--include="*.${extension}"` : '';
        const cmd = `grep -rn -I --exclude-dir={node_modules,.git,.next,dist,build} ${extFilter} "${query}" . | head -n 30`;
        const { stdout } = await execAsync(cmd, { cwd });
        const matches = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const parts = line.split(':');
            return {
              file: parts[0],
              line: parts[1],
              text: parts.slice(2).join(':').trim(),
            };
          });

        return {
          success: true,
          query,
          count: matches.length,
          matches,
        };
      } catch {
        return {
          success: true,
          query,
          count: 0,
          matches: [],
          message: '未搜索到匹配项',
        };
      }
    },
  });
}
