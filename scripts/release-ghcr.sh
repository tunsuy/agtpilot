#!/usr/bin/env bash
set -e

# ==============================================================================
# AgtPilot 本地构建并推送镜像至 GitHub Container Registry (ghcr.io)
# ==============================================================================

IMAGE_REPO="ghcr.io/tunsuy/agtpilot"
TAG="${1:-latest}"
PLATFORM="linux/amd64" # 阿里云/主流云服务器架构

echo "🚀 [1/3] 检查 GitHub 容器凭据..."
if ! docker info 2>/dev/null | grep -q "ghcr.io"; then
  echo "🔑 正在使用 gh token 登录 ghcr.io ..."
  if command -v gh >/dev/null 2>&1; then
    gh auth token | docker login ghcr.io -u tunsuy --password-stdin
  else
    echo "⚠️ 请确保已通过 'echo \$CR_PAT | docker login ghcr.io -u <username> --password-stdin' 登录！"
  fi
fi

echo "📦 [2/3] 本地多架构构建生产镜像 ($PLATFORM)..."
docker buildx build \
  --platform "$PLATFORM" \
  -t "${IMAGE_REPO}:${TAG}" \
  -t "${IMAGE_REPO}:latest" \
  --push \
  -f Dockerfile .

echo "✅ [3/3] 镜像推送完成！"
echo "🌐 镜像地址: ${IMAGE_REPO}:${TAG}"
echo ""
echo "👉 在你的服务器上只需执行："
echo "   docker pull ${IMAGE_REPO}:${TAG}"
echo "   docker compose -f docker-compose.prod.yml up -d"
