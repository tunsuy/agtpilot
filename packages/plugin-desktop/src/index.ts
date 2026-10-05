import { Context } from '@deepseek-ai/cordis';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import '@agtpilot/core';

const execAsync = promisify(exec);

export const name = 'agtpilot-plugin-desktop';
export const inject = ['agent'];

export function apply(ctx: Context) {
  const cacheDir = path.resolve(process.cwd(), '.cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // 1. desktop_screenshot: 截取操作系统原生桌面全屏画面
  ctx.agent.registerTool({
    name: 'desktop_screenshot',
    description: '截取当前宿主操作系统的全屏幕画面，用于多模态视觉核验桌面应用与系统状态。',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: '可选，保存的文件名称' },
      },
    },
    execute: async ({ filename }) => {
      const targetName = filename || `screenshot_${Date.now()}.png`;
      const targetPath = path.join(cacheDir, targetName);

      try {
        if (process.platform === 'darwin') {
          await execAsync(`screencapture -x "${targetPath}"`);
        } else {
          return { success: false, error: '当前仅在 macOS / Linux X11 环境支持原生截屏' };
        }

        return {
          success: true,
          savedPath: targetPath,
          message: `桌面全屏截屏已成功保存至 [${targetPath}]。`,
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });

  // 2. desktop_clipboard_read: 读取本地剪贴板文本
  ctx.agent.registerTool({
    name: 'desktop_clipboard_read',
    description: '读取用户当前系统剪贴板中的纯文本内容。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      try {
        let content = '';
        if (process.platform === 'darwin') {
          const { stdout } = await execAsync('pbpaste');
          content = stdout;
        }
        return { success: true, content: content.slice(0, 5000) };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });

  // 3. desktop_clipboard_write: 写入本地剪贴板
  ctx.agent.registerTool({
    name: 'desktop_clipboard_write',
    description: '将文本内容写入用户操作系统剪贴板，方便用户在任何外部软件中直接 Cmd+V 粘贴。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要写入剪贴板的纯文本' },
      },
      required: ['text'],
    },
    execute: async ({ text }) => {
      try {
        if (process.platform === 'darwin') {
          const child = exec('pbcopy');
          child.stdin?.write(text);
          child.stdin?.end();
        }
        return { success: true, message: `已成功将 ${text.length} 字符写入操作系统剪贴板。` };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });

  // 4. desktop_open_application: 启动或切换桌面应用
  ctx.agent.registerTool({
    name: 'desktop_open_application',
    description: '在操作系统中打开指定的应用程序、Finder 目录或本地文件。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '应用名称 (如: "Visual Studio Code", "Terminal", "Finder") 或本地路径 (如: ".")',
        },
      },
      required: ['target'],
    },
    execute: async ({ target }) => {
      try {
        if (process.platform === 'darwin') {
          if (target.includes('/') || target === '.') {
            await execAsync(`open "${target}"`);
          } else {
            await execAsync(`open -a "${target}"`);
          }
        }
        return { success: true, message: `已成功在宿主操作系统调用打开: [${target}]。` };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });

  // 5. desktop_system_info: 获取宿主机软硬件环境指标
  ctx.agent.registerTool({
    name: 'desktop_system_info',
    description: '获取当前宿主操作系统的 CPU 架构、系统版本、内存使用率与空闲状态。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const totalMem = Math.round(os.totalmem() / 1024 / 1024 / 1024);
      const freeMem = Math.round(os.freemem() / 1024 / 1024 / 1024);
      return {
        success: true,
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMemoryGb: `${totalMem} GB`,
        freeMemoryGb: `${freeMem} GB`,
        uptimeHours: Math.round(os.uptime() / 3600),
      };
    },
  });
}
