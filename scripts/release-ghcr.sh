#!/usr/bin/env bash
set -e

# ==============================================================================
# AgtPilot 本地构建并推送镜像至 GitHub Container Registry (ghcr.io)
# ==============================================================================

IMAGE_REPO="ghcr.io/tunsuy/agtpilot"
TAG="${1:-latest}"
PLATFORM="linux/amd64" # 阿里云/主流云服务器架构

echo "📦 [1/4] 本地高性能 CPU 编译 Standalone 产物..."
pnpm build

echo "🔑 [2/4] 检查 GitHub 容器登录凭据..."
if command -v gh >/dev/null 2>&1; then
  gh auth token | docker login ghcr.io -u tunsuy --password-stdin
fi

echo "🐳 [3/4] 构建生产镜像 ($PLATFORM)..."
docker buildx build \
  --platform "$PLATFORM" \
  -t "${IMAGE_REPO}:${TAG}" \
  -t "${IMAGE_REPO}:latest" \
  --push \
  -f Dockerfile .

echo "✅ [4/4] 镜像已成功推送到 GHCR！"
echo "🌐 镜像地址: ${IMAGE_REPO}:${TAG}"
echo ""
echo "👉 在你的云服务器上运行："
echo "   docker pull ${IMAGE_REPO}:${TAG}"
echo "   docker compose -f docker-compose.prod.yml up -d"
