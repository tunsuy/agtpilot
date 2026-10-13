/**
 * PPT 工坊 · 演示稿交付工具(任务级注入,同 buildWechatMpTools 模式)
 *
 * - ppt_check_env:探测镜像内 qiaomu-bento-ppt skill 与 python3 是否就绪 ——
 *   Agent 据此决定走正式构建路线还是降级路线(本地开发环境无 skill);
 * - ppt_publish_deck:把沙箱工作区里构建好的 .bento.html 直接读文件挂上中央画布
 *   (ArtifactService,type=html)。服务端读文件发布是关键设计:.bento.html 内联
 *   官方 shell 后约 600KB+,绝不能让模型经 artifact_render 回显内容(撑爆上下文);
 * - ppt_publish_pptx(S2,ppt-master 路线):把工作区内导出的 .pptx 收进服务端
 *   文件库(artifact-files.ts,按用户隔离),再以 type='file' 产物挂画布 ——
 *   二进制不进 mission JSON,前端凭 fileMeta.fileId 走 /api/artifacts/file 下载。
 *
 * 路径围栏与 plugin-sandbox 同语义:只接受 workspaceRoot(默认 process.cwd(),
 * 与 sandbox 插件无 config 挂载时一致)内的相对/绝对路径,拒绝 ../ 越界。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '@agtpilot/core';
import { BENTO_SKILL_DIR } from '@/workshops/ppt/paths';

const execFileAsync = promisify(execFile);

/** 单文件 deck 体积上限:官方 shell 约 600KB,留足富余;超限拒绝并提示精简 */
export const MAX_DECK_BYTES = 8 * 1024 * 1024;

/** .pptx 交付件体积上限(与 artifact-files.ts 文件库上限一致) */
export const MAX_PPTX_BYTES = 32 * 1024 * 1024;

/** .pptx MIME(Office Open XML 演示文稿) */
export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** 可发布的演示页扩展名(.bento.html 落在 .html 分支) */
export const HTML_EXT_RE = /\.html?$/i;

/** 可发布的 PPTX 扩展名 */
export const PPTX_EXT_RE = /\.pptx$/i;

/**
 * 把用户/Agent 传入的路径解析并围栏到 workspaceRoot 内。
 * 越界(../ 逃逸、指向工作区外的绝对路径)或扩展名不符返回 null。
 * 导出供单测直接覆盖围栏语义。
 */
export function resolveDeckPath(
  workspaceRoot: string,
  input: string,
  extRe: RegExp = HTML_EXT_RE
): string | null {
  const p = String(input || '').trim();
  if (!p) return null;
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  if (!extRe.test(resolved)) return null;
  return resolved;
}

export interface PptDeckToolDeps {
  /** 沙箱工作区根(与 plugin-sandbox 无 config 时一致,默认 process.cwd()) */
  workspaceRoot?: string;
  /** skill 安装目录(默认镜像固定路径 BENTO_SKILL_DIR;单测可注入临时目录) */
  skillDir?: string;
  /** 发布产物:agent-backend 注入 ctx.artifact.createOrUpdateArtifact 的包装 */
  createArtifact: (
    data: {
      title: string;
      type: 'html' | 'file';
      content: string;
      description?: string;
      fileMeta?: { fileId: string; fileName: string; mime: string; sizeBytes: number };
    },
    taskId?: string
  ) => { id: string; title: string };
  /**
   * 二进制文件入库(S2):agent-backend 注入 artifact-files.saveArtifactFile
   * 的用户级包装(闭包内已绑定 userId)。缺失时 ppt_publish_pptx 拒发并说明原因。
   */
  storeFile?: (input: {
    fileName: string;
    mime: string;
    data: Buffer;
  }) => { fileId: string; sizeBytes: number };
}

export function buildPptDeckTools(deps: PptDeckToolDeps): ToolDefinition[] {
  const workspaceRoot = deps.workspaceRoot || process.cwd();
  const skillDir = deps.skillDir || BENTO_SKILL_DIR;

  const checkEnv: ToolDefinition = {
    name: 'ppt_check_env',
    description:
      'PPT 工坊环境自检:探测 bento 演示稿 skill(qiaomu-bento-ppt)与 python3 是否就绪。制作网页演示页前必须先调用本工具——ready=true 时走 skill 构建路线(bento_deck.py build);skill 缺失时按工坊 Prompt 的「降级路线」自行编写自包含 HTML 演示页。只读探测,无副作用。',
    dangerLevel: 'low',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const scriptPath = path.join(skillDir, 'scripts', 'bento_deck.py');
      const shellPath = path.join(skillDir, 'assets', 'bento', 'Bento_Slides.bento.html');
      const [scriptOk, shellOk] = await Promise.all([
        fs.access(scriptPath).then(() => true).catch(() => false),
        fs.access(shellPath).then(() => true).catch(() => false),
      ]);
      let python3: string | null = null;
      try {
        const { stdout } = await execFileAsync('python3', ['--version'], { timeout: 5000 });
        python3 = stdout.trim() || 'unknown';
      } catch {
        python3 = null;
      }
      const ready = scriptOk && shellOk && python3 !== null;
      return {
        success: true,
        ready,
        skillDir,
        skillScript: scriptOk,
        skillShell: shellOk,
        python3,
        workspaceRoot,
        message: ready
          ? `环境就绪:skill(${skillDir})与 ${python3} 可用,按工坊流程用 sandbox_run_command 构建 deck,完成后调用 ppt_publish_deck 发布。`
          : '环境不完整(skill 或 python3 缺失,常见于本地开发环境):请按工坊 Prompt 的「降级路线」自行编写自包含 HTML 演示页并用 artifact_render(type=html)发布。',
      };
    },
  };

  const publishDeck: ToolDefinition = {
    name: 'ppt_publish_deck',
    description:
      '把沙箱工作区内构建完成的演示页 HTML 文件(通常是 bento_deck.py 产出的 .bento.html,约 600KB 单文件)读取并发布到用户中央画布(type=html,实时广播、随任务持久化,可下载离线放映)。服务端直接读文件,不经过模型上下文——严禁改用 artifact_render 粘贴 HTML 内容。path 为工作区内相对路径(如 ppt/deck.bento.html);仅接受 .html/.htm,超过 8MB 拒绝。',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '演示页文件路径(工作区内相对路径,如 ppt/deck.bento.html)',
        },
        title: { type: 'string', description: '可选,产物标题;缺省用文件名' },
        description: { type: 'string', description: '可选,产物说明(页数/风格/验证结果摘要)' },
      },
      required: ['path'],
    },
    execute: async (args: any, session?: any) => {
      const resolved = resolveDeckPath(workspaceRoot, args?.path);
      if (!resolved) {
        return {
          success: false,
          error: `路径无效或越界: ${args?.path}(只允许工作区 ${workspaceRoot} 内的 .html/.htm 文件)`,
        };
      }
      let stat;
      try {
        stat = await fs.stat(resolved);
      } catch {
        return { success: false, error: `文件不存在: ${args.path}(先确认 bento_deck.py build 已成功产出)` };
      }
      if (!stat.isFile()) return { success: false, error: `不是文件: ${args.path}` };
      if (stat.size > MAX_DECK_BYTES) {
        return {
          success: false,
          error: `文件过大(${(stat.size / 1024 / 1024).toFixed(1)}MB > ${MAX_DECK_BYTES / 1024 / 1024}MB):请精简内嵌媒体后重新 build`,
        };
      }
      if (stat.size === 0) return { success: false, error: '文件为空,请先完成构建' };
      const content = await fs.readFile(resolved, 'utf8');
      const baseName = path.basename(resolved).replace(/\.bento\.html$/i, '').replace(/\.html?$/i, '');
      const title = (typeof args?.title === 'string' && args.title.trim()) || baseName || '演示稿';
      const isBento = content.includes('bento-doc') || /\.bento\.html$/i.test(resolved);
      const artifact = deps.createArtifact(
        {
          title,
          type: 'html',
          content,
          description:
            (typeof args?.description === 'string' && args.description.trim()) ||
            (isBento
              ? 'bento 单文件演示页:画布内直接放映;下载 .bento.html 双击可离线放映与继续编辑'
              : '自包含 HTML 演示页:画布内直接放映,可下载离线打开'),
        },
        session?.taskId
      );
      return {
        success: true,
        artifactId: artifact.id,
        title: artifact.title,
        sizeKB: Math.round(stat.size / 1024),
        bento: isBento,
        message: `演示页 [${artifact.title}](${Math.round(stat.size / 1024)}KB)已发布到中央画布,用户可实时放映与下载。`,
      };
    },
  };

  const publishPptx: ToolDefinition = {
    name: 'ppt_publish_pptx',
    description:
      '把沙箱工作区内导出的 .pptx 文件(ppt-master svg_to_pptx.py 产物,通常在项目 exports/ 目录)收进服务端文件库并发布到用户中央画布(type=file,随任务持久化,前端出下载卡片)。服务端直接读二进制文件,不经过模型上下文——严禁用 artifact_render 回显或 base64 粘贴 .pptx 内容。path 为工作区内相对路径(如 ppt/deck_20261011/exports/deck.pptx);仅接受 .pptx,超过 32MB 拒绝。',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '.pptx 文件路径(工作区内相对路径,指向 svg_to_pptx.py 的导出产物)',
        },
        title: { type: 'string', description: '可选,产物标题;缺省用文件名(去 .pptx 后缀)' },
        description: { type: 'string', description: '可选,产物说明(页数/画布/质检结果摘要)' },
      },
      required: ['path'],
    },
    execute: async (args: any, session?: any) => {
      if (!deps.storeFile) {
        return {
          success: false,
          error: '当前部署未挂文件库(storeFile 缺失),无法发布 .pptx;可降级用 ppt_publish_deck 发布网页演示页。',
        };
      }
      const resolved = resolveDeckPath(workspaceRoot, args?.path, PPTX_EXT_RE);
      if (!resolved) {
        return {
          success: false,
          error: `路径无效或越界: ${args?.path}(只允许工作区 ${workspaceRoot} 内的 .pptx 文件)`,
        };
      }
      let stat;
      try {
        stat = await fs.stat(resolved);
      } catch {
        return { success: false, error: `文件不存在: ${args.path}(先确认 svg_to_pptx.py 已成功导出)` };
      }
      if (!stat.isFile()) return { success: false, error: `不是文件: ${args.path}` };
      if (stat.size > MAX_PPTX_BYTES) {
        return {
          success: false,
          error: `文件过大(${(stat.size / 1024 / 1024).toFixed(1)}MB > ${MAX_PPTX_BYTES / 1024 / 1024}MB):请精简图片资源后重新导出`,
        };
      }
      if (stat.size === 0) return { success: false, error: '文件为空,请先完成导出' };
      const data = await fs.readFile(resolved);
      // zip 魔数校验:pptx 本质是 zip(PK\x03\x04),挡下明显不对的路径
      if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
        return { success: false, error: `不是有效的 .pptx 文件(缺少 zip 魔数): ${args.path}` };
      }
      const baseName = path.basename(resolved).replace(/\.pptx$/i, '');
      const title = (typeof args?.title === 'string' && args.title.trim()) || baseName || '演示稿';
      const fileName = `${title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'deck'}.pptx`;
      let stored;
      try {
        stored = deps.storeFile({ fileName, mime: PPTX_MIME, data });
      } catch (e: any) {
        return { success: false, error: `文件入库失败: ${e?.message || e}` };
      }
      const description =
        (typeof args?.description === 'string' && args.description.trim()) ||
        'ppt-master 导出的原生可编辑 .pptx:下载后可用 PowerPoint / WPS / Keynote 打开继续编辑';
      const artifact = deps.createArtifact(
        {
          title,
          type: 'file',
          // content 只放人类可读摘要(二进制本体在文件库),前端文件卡片与交付说明用
          content: `**${fileName}**(${(stored.sizeBytes / 1024).toFixed(0)} KB)\n\n${description}\n\n下载后可用 PowerPoint / WPS / Keynote 直接打开编辑。`,
          description,
          fileMeta: {
            fileId: stored.fileId,
            fileName,
            mime: PPTX_MIME,
            sizeBytes: stored.sizeBytes,
          },
        },
        session?.taskId
      );
      return {
        success: true,
        artifactId: artifact.id,
        fileId: stored.fileId,
        title: artifact.title,
        fileName,
        sizeKB: Math.round(stored.sizeBytes / 1024),
        message: `PPTX [${artifact.title}](${Math.round(stored.sizeBytes / 1024)}KB)已发布,用户可在画布下载卡片一键保存 .pptx。`,
      };
    },
  };

  return [checkEnv, publishDeck, publishPptx];
}

/** 工具提供方注册表条目(tool-providers.ts);artifact 闭包由 agent-backend 接线 */
export const TOOL_PROVIDER: import('./tool-providers').ToolProvider = {
  id: 'ppt',
  deps: ['artifact'], // uid 绑定在 agent-backend 的 storeFile 闭包里,provider 本身不消费
  // 闭包类型收窄:注册表上下文里为可选,agent-backend 唯一调用点必然接线
  build: ({ createArtifact, storeFile }) =>
    buildPptDeckTools({ createArtifact: createArtifact as any, storeFile: storeFile as any }),
};
