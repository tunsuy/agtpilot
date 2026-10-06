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

# 创建运行安全用户
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 nextjs

# 复制公共静态资源与 standalone 产物
COPY apps/web/public ./apps/web/public
COPY --chown=nextjs:nodejs apps/web/.next/standalone ./
COPY --chown=nextjs:nodejs apps/web/.next/static ./apps/web/.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
