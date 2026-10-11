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

# qiaomu-bento-ppt skill(PPT 工坊 · bento 单文件 HTML 演示页生成,MIT):
# 纯 Python 标准库脚本 + 内置官方 bento shell 与规范快照,无需 pip 依赖;
# 固定 commit 55c63c8(与仓内 upstream.lock.json 校验的内置快照一致)。
# node:20-slim 无 git/curl,用 node 内置 fetch 下载 GitHub tarball 后解包;
# 层尾跑 skill 自带的 locate 自检,确保 shell/规范快照齐备才算构建成功。
# Agent 经 sandbox_run_command 以绝对路径调用(ppt-workshop.ts 契约)。
RUN node -e "fetch('https://codeload.github.com/joeseesun/qiaomu-bento-ppt/tar.gz/55c63c836f42bc9175757d077428c395cd93effe').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer()}).then(b=>require('node:fs').writeFileSync('/tmp/bento-skill.tgz',Buffer.from(b)))" && \
    mkdir -p /opt/skills/qiaomu-bento-ppt && \
    tar -xzf /tmp/bento-skill.tgz -C /opt/skills/qiaomu-bento-ppt --strip-components=1 && \
    rm -f /tmp/bento-skill.tgz && \
    chmod -R a+rX /opt/skills && \
    python3 /opt/skills/qiaomu-bento-ppt/scripts/bento_deck.py locate | grep -q '"standalone": true'

# ppt-master skill(PPT 工坊 · 真 .pptx 交付,MIT)+ 专用 venv + CJK 字体:
# - 固定 commit b4efe3d,tarball 里 skill 子树在 <repo>/skills/ppt-master/,
#   --strip-components=2 直接解到 /opt/skills/ppt-master(SKILL_DIR 契约路径);
# - 裁掉 templates/sounds(13MB,仅 narration 音频用,工坊契约禁用音频);
#   icons(49MB)保留 —— Quick 流程的图标池契约(templates/icons/README.md)要用;
# - 依赖只装 SVG→PPTX 核心六件(PyYAML/python-pptx/XlsxWriter/skia-pathops/
#   uharfbuzz/Pillow,2026-10-11 本机全链路冒烟验证);**严禁装 PyMuPDF(AGPL)**,
#   生图/搜索/音频/文档转换等可选依赖一律不装(工坊契约为离线手写 SVG 路线);
# - venv 不进 PATH(PATH 首位是 A股 venv),契约里命令显式用 /opt/ppt-master/bin/python3;
# - fonts-noto-cjk:text_measure.py calibrate 按系统字体实测中文字宽,缺字体则排版失准;
# - 层尾门禁:attribution_guard(skill 完整性)+ 核心依赖 import 双自检。
RUN node -e "fetch('https://codeload.github.com/hugohe3/ppt-master/tar.gz/b4efe3ddf237a97a42880164759162f8e2412f2f').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer()}).then(b=>require('node:fs').writeFileSync('/tmp/ppt-master.tgz',Buffer.from(b)))" && \
    mkdir -p /opt/skills/ppt-master && \
    tar -xzf /tmp/ppt-master.tgz -C /opt/skills/ppt-master --strip-components=3 --wildcards '*/skills/ppt-master/*' && \
    rm -f /tmp/ppt-master.tgz && \
    rm -rf /opt/skills/ppt-master/templates/sounds && \
    chmod -R a+rX /opt/skills && \
    apt-get update && \
    apt-get install -y --no-install-recommends fonts-noto-cjk && \
    rm -rf /var/lib/apt/lists/* && \
    python3 -m venv /opt/ppt-master && \
    /opt/ppt-master/bin/pip install --no-cache-dir \
      PyYAML "python-pptx>=0.6.21" XlsxWriter skia-pathops uharfbuzz Pillow && \
    /opt/ppt-master/bin/python3 /opt/skills/ppt-master/scripts/attribution_guard.py && \
    /opt/ppt-master/bin/python3 -c "import yaml, pptx, xlsxwriter, pathops, uharfbuzz, PIL; print('ppt-master deps ok')"

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
