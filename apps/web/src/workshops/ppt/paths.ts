/**
 * PPT skill 包路径契约(bento / ppt-master 双路线的目录与解释器)
 *
 * 沙箱技能包统一经 plugin-skill 的 pack 注册表发现(扫 AGTPILOT_SKILL_PACK_DIRS,
 * 缺省 /opt/skills,读 SKILL.md frontmatter 元数据;60s 缓存)。注册表查不到
 * (如 dev 机没有 /opt/skills)时回落镜像固定路径 —— 生产镜像上两者同值。
 * 抽成独立模块:ppt-deck 工具(服务端)引用路径时不必拖上整个 prompt 构建器。
 */
import { createSkillService } from '@agtpilot/plugin-skill';

/** 镜像内 bento skill 固定安装路径(Dockerfile 层 tarball 固定 commit 解包于此);pack 注册表查不到时兜底 */
export const BENTO_SKILL_DIR = '/opt/skills/qiaomu-bento-ppt';

/** 镜像内 ppt-master skill 固定安装路径(SKILL_DIR 契约:命令一律用此绝对路径展开);pack 注册表查不到时兜底 */
export const PPT_MASTER_SKILL_DIR = '/opt/skills/ppt-master';

// 沙箱技能包统一经 plugin-skill 的 pack 注册表发现(扫 AGTPILOT_SKILL_PACK_DIRS,
// 缺省 /opt/skills,读 SKILL.md frontmatter 元数据;60s 缓存)。注册表查不到
// (如 dev 机没有 /opt/skills)时回落上面的镜像固定路径 —— 生产镜像上两者同值。
const skillPacks = createSkillService();

/** 按目录名(优先)或 frontmatter name 查 pack 实际路径;查不到用 fallback */
function resolvePackDir(folder: string, fallback: string): string {
  const packs = skillPacks.listPacks();
  const hit = packs.find((p) => p.dir.endsWith(`/${folder}`)) || skillPacks.getPack(folder);
  return hit?.dir || fallback;
}

/** bento skill 目录(注册表解析,ppt-deck/环境自检/工坊 prompt 共用) */
export function bentoSkillDir(): string {
  return resolvePackDir('qiaomu-bento-ppt', BENTO_SKILL_DIR);
}

/** ppt-master skill 目录(注册表解析) */
export function pptMasterSkillDir(): string {
  return resolvePackDir('ppt-master', PPT_MASTER_SKILL_DIR);
}

/**
 * ppt-master 专用 venv 解释器(装有 python-pptx/skia-pathops/uharfbuzz 等)。
 * 不进 PATH(PATH 首位是 A股 venv),契约里全部命令显式用该绝对路径。
 */
export const PPT_MASTER_PYTHON = '/opt/ppt-master/bin/python3';
