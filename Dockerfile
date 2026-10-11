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

# ---- 重型依赖层（与业务代码解耦，置于 COPY 之前）----
# 浏览器/Python 装一次几百 MB；放在 standalone COPY 之前，业务代码迭代时
# 这些层走缓存，只重建后面的薄层，重建从分钟级降到秒级。

# Playwright 浏览器(浏览器自动化/小红书扫码登录;headless 模式用 chromium_headless_shell)。
# 版本必须与 apps/web 的 playwright 依赖一致(pnpm-lock 解析为 1.63.0,
# 对应 chromium_headless_shell-1243);升级 playwright 时同步改这里。
# 固定 PLAYWRIGHT_BROWSERS_PATH 到 /opt/ms-playwright,独立于运行用户的 HOME。
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npx -y playwright@1.63.0 install chromium --with-deps && \
    chmod -R a+rX /opt/ms-playwright

# A股实时行情(AkShare)连接器:stdio 命令是 python3 -m a_stock_mcp_server,
# node:20-slim 无 python(spawn python3 ENOENT)。独立 venv 装在 /opt/a-stock
# 不动系统 python;PATH 前置后连接器的 `python3` 解析到 venv 解释器
# (buildStdioEnv 白名单透传 PATH)。--no-cache-dir 避免构建期缓存落盘。
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-venv && \
    python3 -m venv /opt/a-stock && \
    /opt/a-stock/bin/pip install --no-cache-dir a-stock-mcp-server && \
    rm -rf /var/lib/apt/lists/* && \
    chmod -R a+rX /opt/a-stock
ENV PATH="/opt/a-stock/bin:${PATH}"

# ---- 业务代码（standalone 产物；变更只作废以下薄层）----

# 复制公共静态资源与 standalone 产物
COPY apps/web/public ./apps/web/public
COPY --chown=nextjs:nodejs apps/web/.next/standalone ./
COPY --chown=nextjs:nodejs apps/web/.next/static ./apps/web/.next/static

# 泄漏防护:standalone 产物里被追踪带进来的构建机 .cache 一并删除,运行期由
# compose 卷提供。同层修复 npm 缓存属主:上方 npx 以 root 运行且 ENV HOME 已
# 指向 /home/nextjs,root 写出的 ~/.npm 若原样烙进镜像,运行期 nextjs(1001)
# 会报 EACCES(npm cache folder contains root-owned files),stdio 连接器拉子进程
# 即崩。一并删掉构建期缓存(纯镜像瘦身),并把整个 home 归还 nextjs。
RUN rm -rf /app/apps/web/.cache /home/nextjs/.npm /root/.npm && \
    chown -R nextjs:nodejs /home/nextjs

USER nextjs

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
