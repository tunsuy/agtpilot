# ==========================================
# 生产极简镜像 (Runner)
# 基于本地 Mac 高速构建出的 standalone 独立包，直接打包
# ==========================================
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# 创建运行安全用户。
# --create-home 是硬需求：stdio 型 MCP 连接器（全网热榜/X 数据/飞书/钉钉/语雀等）
# 经 `npx -y <pkg>` 拉起子进程，npm 必须有可写的 ~/.npm 缓存；HOME 目录不存在时
# npx 启动即崩退，SDK 只报 "MCP error -32000: Connection closed"，所有本地 stdio
# 连接器全灭。ENV HOME 兜底：Docker 不保证按 passwd 自动设置 HOME 环境变量。
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --create-home nextjs
ENV HOME=/home/nextjs

# 复制公共静态资源与 standalone 产物
COPY apps/web/public ./apps/web/public
COPY --chown=nextjs:nodejs apps/web/.next/standalone ./
COPY --chown=nextjs:nodejs apps/web/.next/static ./apps/web/.next/static

# Playwright 浏览器(浏览器自动化/小红书扫码登录;headless 模式用 chromium_headless_shell)。
# 版本必须与 apps/web 的 playwright 依赖一致(pnpm-lock 解析为 1.63.0,
# 对应 chromium_headless_shell-1243);升级 playwright 时同步改这里。
# 固定 PLAYWRIGHT_BROWSERS_PATH 到 /opt/ms-playwright,独立于运行用户的 HOME。
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npx -y playwright@1.63.0 install chromium --with-deps && \
    chmod -R a+rX /opt/ms-playwright

# 泄漏防护(置于浏览器层之后以免作废其层缓存):standalone 产物里被追踪带进来的
# 构建机 .cache 一并删除,运行期由 compose 卷提供。
RUN rm -rf /app/apps/web/.cache

USER nextjs

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
