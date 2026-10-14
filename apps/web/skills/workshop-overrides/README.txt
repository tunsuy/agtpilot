工坊提示词 · 服务端覆盖目录(热修)
================================

用途:工坊提示词已迁 .md 模板(src/workshops/<id>/prompt.*.md)。
生产上发现某工坊提示词有问题(措辞、红线、流程)时,把修正后的全文放到这里:

    <workshopId>.md          # 例如 xhs.md、invest.md、oss_radar.md

生效规则:
- 文件名必须是注册表内的工坊 id(见 src/workshops/registry.ts);
- 内容 = 该工坊任务 prompt 的全文替换(不做模板变量渲染 —— 热修要的是
  对最终文本的完全掌控);
- 60 秒内生效(目录按 TTL 扫描),移除文件即回落打包模板;
- 只影响 /api/agent/run 的工坊任务(服务端权威渲染);cron 场景触发
  走注册表重建,不经此目录;
- 坏文件(空文件、未知 id、超 256KB)只记日志并跳过,不影响其他工坊。

目录位置:env AGTPILOT_WORKSHOP_OVERRIDE_DIR 可改;缺省即本目录
(dev = apps/web/skills/workshop-overrides,生产镜像 = /app/skills/workshop-overrides)。

注意:本说明刻意用 .txt 后缀 —— 扫描器只认 .md,README.md 会被当成
未知工坊 id 每 60 秒记一次警告。
