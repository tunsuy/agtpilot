/**
 * 统一只读文档工具 doc_read —— 合并三处"读文本"能力:
 * - source=reference:本次任务参考资料(art_* 交付物 / upl_* 上传件,PDF/Word 已抽文本);
 * - source=tool_output:超长工具输出的窗口续读(截断指针 ref=<callId>);
 * - source=skill_pack:已安装技能包内文本(SKILL.md / 参考文档 / 脚本源码)。
 *
 * 三者的共同点是"只读、返回文本、可分页";差异只在存储域与鉴权,
 * 由 source 参数分派,不再各占一个工具名。skill_pack 仅在本任务显式
 * 引用了技能包时进 schema(渐进披露:第三方内容只在用户点名时进场)。
 */
import type { ToolDefinition } from '@agtpilot/core';
import { resolveReferenceMaterial, REFERENCE_CONTENT_LIMIT } from './reference-materials';
import { readToolOutput, TOOL_OUTPUT_READ_LIMIT } from './tool-output-store';
import { readSkillPackFile } from './skill-center';

export type DocSource = 'reference' | 'skill_pack' | 'tool_output';

export interface DocReadOptions {
  /** 本任务是否显式引用了技能包(决定 skill_pack 是否进 schema) */
  allowSkillPack?: boolean;
}

export function buildDocReadTools(userId: string, options: DocReadOptions = {}): ToolDefinition[] {
  const sources: DocSource[] = ['reference', 'tool_output'];
  if (options.allowSkillPack) sources.unshift('skill_pack');

  return [
    {
      name: 'doc_read',
      description:
        '统一只读文档读取:source=reference 读本次任务【参考资料】列出的资料全文(materialId 形如 art_* / upl_*,' +
        'PDF/Word 上传件已抽取为文本,超长用 offset 续读);source=tool_output 续读被全量保存的超长工具输出(callId = 截断指针 ref= 后面的 id,' +
        'offset/limit 窗口);source=skill_pack 读已安装技能包文本(pack 必填,file 缺省 SKILL.md,仅当本任务指定了技能包时可用)。' +
        '只能读你自己名下的内容;脚本执行与工作区文件请走 sandbox_exec / sandbox_file。',
      dangerLevel: 'low',
      readOnly: true, // 只读并行门控:三源均为无副作用读取
      // baseline:内核路由基线自动并入(指针文案与工坊白名单退化场景都必须能续读)
      baseline: true,
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            enum: sources,
            description: '文档来源',
          },
          materialId: {
            type: 'string',
            description: 'source=reference:引用 id(【资料N】括号内的 materialId)',
          },
          offset: {
            type: 'number',
            description: 'source=reference/tool_output:起始字符位置(默认 0;上次返回 nextOffset 时用它继续)',
          },
          callId: {
            type: 'string',
            description: 'source=tool_output:输出引用 id(截断指针标记中 ref= 后面的 call_xxx)',
          },
          limit: {
            type: 'number',
            description: `source=tool_output:本次读取字符数(默认 ${TOOL_OUTPUT_READ_LIMIT})`,
          },
          pack: {
            type: 'string',
            description: 'source=skill_pack:技能包名(见 system prompt「用户指定技能包」)',
          },
          file: {
            type: 'string',
            description: 'source=skill_pack:包内相对路径,缺省 SKILL.md',
          },
        },
        required: ['source'],
      },
      execute: async (args: any) => {
        const source = String(args?.source || '') as DocSource;
        const offset =
          Number.isFinite(Number(args?.offset)) && Number(args.offset) > 0
            ? Math.floor(Number(args.offset))
            : 0;

        if (source === 'reference') {
          const materialId = String(args?.materialId || '').trim();
          if (!materialId) return { success: false, error: 'source=reference 需要 materialId' };
          const body = resolveReferenceMaterial(userId, materialId);
          if (!body) {
            return {
              success: false,
              error:
                `引用 ${materialId} 解析失败(任务不存在、无交付物、上传文件已删除或正文不可读)。` +
                '降级路径:按 prompt 其它要求与联网调研继续创作,并在成稿处注明该引用不可用。',
            };
          }
          const full = body.content;
          const slice = full.slice(offset, offset + REFERENCE_CONTENT_LIMIT);
          const end = offset + slice.length;
          return {
            success: true,
            source,
            id: body.id,
            title: body.title,
            ...(body.missionTitle ? { missionTitle: body.missionTitle } : {}),
            content: slice,
            truncated: end < full.length,
            ...(end < full.length
              ? { nextOffset: end, hint: `还有剩余内容,用 offset=${end} 继续读` }
              : {}),
          };
        }

        if (source === 'tool_output') {
          const callId = String(args?.callId || '');
          const result = readToolOutput(
            userId,
            callId,
            offset,
            Number(args?.limit) || TOOL_OUTPUT_READ_LIMIT,
          );
          return { source, ...result };
        }

        if (source === 'skill_pack') {
          if (!options.allowSkillPack) {
            return { success: false, error: '本任务没有显式引用技能包,source=skill_pack 不可用' };
          }
          const pack = String(args?.pack || '').trim();
          if (!pack) return { success: false, error: 'source=skill_pack 需要 pack' };
          const result = readSkillPackFile(userId, pack, args?.file);
          return { source, ...result };
        }

        return {
          success: false,
          error: `source 无效: ${source}（可选 ${sources.join(' / ')}）`,
        };
      },
    },
  ];
}
