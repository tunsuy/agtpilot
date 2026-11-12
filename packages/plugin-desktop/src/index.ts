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

  // 1. desktop_inspect: 宿主只读探测(截屏 / 读剪贴板)。读取宿主桌面/剪贴板属敏感操作,需确认
  ctx.agent.registerTool({
    name: 'desktop_inspect',
    dangerLevel: 'high',
    description:
      '宿主操作系统只读探测。action=screenshot:截取全屏画面并保存为 PNG 文件供用户在产物目录查看(模型不可见像素内容);action=clipboard_read:读取用户当前剪贴板纯文本(可能含敏感信息)。读取宿主屏幕/剪贴板属于敏感操作,需用户确认。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'clipboard_read'],
          description: 'screenshot = 全屏截图;clipboard_read = 读取剪贴板文本',
        },
        filename: { type: 'string', description: 'action=screenshot:可选,保存的文件名称(自动限制在缓存目录内)' },
      },
      required: ['action'],
    },
    execute: async (args: any) => {
      const action = String(args?.action || '');
      const unsupported = requireDarwin();
      if (unsupported) return { success: false, error: unsupported };

      if (action === 'screenshot') {
        // 文件名围栏：只取 basename 并清掉分隔符/穿越序列，强制落在 cacheDir 内
        const targetName =
          String(args?.filename || `screenshot_${Date.now()}.png`).replace(/[/\\]/g, '_').replace(/\.\./g, '_') ||
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
      }
      if (action === 'clipboard_read') {
        try {
          const { stdout } = await execFileAsync('pbpaste', { maxBuffer: 5 * 1024 * 1024 });
          return { success: true, content: stdout.slice(0, 5000) };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      }
      return { success: false, error: `action 无效: ${action}（可选 screenshot / clipboard_read）` };
    },
  });

  // 2. desktop_action: 宿主写操作(写剪贴板 / 打开应用)。修改宿主状态属敏感操作,需确认
  ctx.agent.registerTool({
    name: 'desktop_action',
    dangerLevel: 'high',
    description:
      '宿主操作系统写操作。action=clipboard_write:将文本写入用户剪贴板(方便 Cmd+V 粘贴);action=open_application:在操作系统中打开指定的应用程序、Finder 目录或本地文件。修改宿主剪贴板/启动进程属于敏感操作,需用户确认。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['clipboard_write', 'open_application'],
          description: 'clipboard_write = 写剪贴板;open_application = 打开应用/目录/文件',
        },
        text: { type: 'string', description: 'action=clipboard_write:要写入剪贴板的纯文本' },
        target: {
          type: 'string',
          description: 'action=open_application:应用名称 (如: "Visual Studio Code", "Terminal", "Finder") 或本地路径 (如: ".")',
        },
      },
      required: ['action'],
    },
    execute: async (args: any) => {
      const action = String(args?.action || '');
      const unsupported = requireDarwin();
      if (unsupported) return { success: false, error: unsupported };

      if (action === 'clipboard_write') {
        const text = String(args?.text ?? '');
        if (!text) return { success: false, error: 'action=clipboard_write 需要 text' };
        try {
          // execFile + stdin 写入：等待子进程退出，写失败/进程崩溃会真实抛错
          await new Promise<void>((resolve, reject) => {
            const child = execFile('pbcopy', [], (err) => (err ? reject(err) : resolve()));
            child.stdin?.on('error', reject);
            child.stdin?.write(text);
            child.stdin?.end();
          });
          return { success: true, message: `已成功将 ${text.length} 字符写入操作系统剪贴板。` };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      }
      if (action === 'open_application') {
        const t = String(args?.target || '');
        if (!t) return { success: false, error: 'action=open_application 需要 target' };
        try {
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
      }
      return { success: false, error: `action 无效: ${action}（可选 clipboard_write / open_application）` };
    },
  });

  // 3. desktop_system_info: 获取宿主机软硬件环境指标(只读低危,独立保留)
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
