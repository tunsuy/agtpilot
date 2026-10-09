import { Context } from '@deepseek-ai/cordis';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import '@agtpilot/core';

const execFileAsync = promisify(execFile);

export const name = 'agtpilot-plugin-desktop';
export const inject = ['agent'];

export function apply(ctx: Context) {
  // 工具路由自注册：prompt 命中文件/桌面操作类关键词时挂载本插件工具组
  ctx.agent.registerToolRoute({
    id: 'desktop',
    prefixes: ['desktop_'],
    test: /(文件|目录|读写|截图|剪贴板|桌面|file|directory|screenshot|clipboard|desktop)/i,
  });

  const cacheDir = path.resolve(process.cwd(), '.cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const requireDarwin = () =>
    process.platform === 'darwin'
      ? null
      : `当前平台 ${process.platform} 不支持该桌面能力（仅 macOS）`;

  // 1. desktop_screenshot: 截取操作系统原生桌面全屏画面
  ctx.agent.registerTool({
    name: 'desktop_screenshot',
    dangerLevel: 'high',
    description: '截取当前宿主操作系统的全屏幕画面并保存为 PNG 文件，供用户在产物目录查看（模型自身不可见画面像素内容）。读取宿主桌面画面属于敏感操作，需用户确认。',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: '可选，保存的文件名称（自动限制在缓存目录内）' },
      },
    },
    execute: async ({ filename }) => {
      const unsupported = requireDarwin();
      if (unsupported) return { success: false, error: unsupported };

      // 文件名围栏：只取 basename 并清掉分隔符/穿越序列，强制落在 cacheDir 内
      const targetName =
        String(filename || `screenshot_${Date.now()}.png`).replace(/[/\\]/g, '_').replace(/\.\./g, '_') ||
        `screenshot_${Date.now()}.png`;
      const targetPath = path.join(cacheDir, path.basename(targetName));

      try {
        // execFile 数组参数：不经 shell，路径作为 screencapture 的普通参数传递
        await execFileAsync('screencapture', ['-x', targetPath]);
        return {
          success: true,
          savedPath: targetPath,
          message: `桌面全屏截屏已成功保存至 [${targetPath}]（用户可在该路径查看）。`,
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });

  // 2. desktop_clipboard_read: 读取本地剪贴板文本
  ctx.agent.registerTool({
    name: 'desktop_clipboard_read',
    dangerLevel: 'high',
    description: '读取用户当前系统剪贴板中的纯文本内容。剪贴板可能含密码等敏感信息，属于宿主级读取操作，需用户确认。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const unsupported = requireDarwin();
      if (unsupported) return { success: false, error: unsupported };
      try {
        const { stdout } = await execFileAsync('pbpaste', { maxBuffer: 5 * 1024 * 1024 });
        return { success: true, content: stdout.slice(0, 5000) };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });

  // 3. desktop_clipboard_write: 写入本地剪贴板
  ctx.agent.registerTool({
    name: 'desktop_clipboard_write',
    dangerLevel: 'high',
    description: '将文本内容写入用户操作系统剪贴板，方便用户在任何外部软件中直接 Cmd+V 粘贴。修改宿主剪贴板属于敏感操作，需用户确认。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要写入剪贴板的纯文本' },
      },
      required: ['text'],
    },
    execute: async ({ text }) => {
      const unsupported = requireDarwin();
      if (unsupported) return { success: false, error: unsupported };
      try {
        // execFile + stdin 写入：等待子进程退出，写失败/进程崩溃会真实抛错
        await new Promise<void>((resolve, reject) => {
          const child = execFile('pbcopy', [], (err) => (err ? reject(err) : resolve()));
          child.stdin?.on('error', reject);
          child.stdin?.write(String(text));
          child.stdin?.end();
        });
        return { success: true, message: `已成功将 ${String(text).length} 字符写入操作系统剪贴板。` };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });

  // 4. desktop_open_application: 启动或切换桌面应用
  ctx.agent.registerTool({
    name: 'desktop_open_application',
    dangerLevel: 'high',
    description: '在操作系统中打开指定的应用程序、Finder 目录或本地文件。在宿主系统上启动进程/打开文件属于敏感操作，需用户确认。',
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
      const unsupported = requireDarwin();
      if (unsupported) return { success: false, error: unsupported };
      try {
        const t = String(target);
        // execFile 数组参数：不经 shell，target 中的任何字符都只是 open 的普通参数
        if (t.includes('/') || t === '.') {
          await execFileAsync('open', [t]);
        } else {
          await execFileAsync('open', ['-a', t]);
        }
        return { success: true, message: `已成功在宿主操作系统调用打开: [${t}]。` };
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
