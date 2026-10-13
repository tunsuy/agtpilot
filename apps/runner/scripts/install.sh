#!/usr/bin/env bash
# AgtPilot 本地 runner 安装脚本(仓内开发者路径;正式渠道 npm i -g @agtpilot/runner 待 npmjs org 注册后启用)。
# 用法: bash apps/runner/scripts/install.sh   [安装前缀可用 PREFIX 覆写,默认 ~/.local/bin]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BIN_SRC="$REPO_ROOT/node_modules/.bin/tsx"
ENTRY="$REPO_ROOT/apps/runner/src/bin.ts"
PREFIX="${PREFIX:-$HOME/.local/bin}"

# 1. Node ≥ 20
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ 需要 Node ≥ 20(当前: $(node -v 2>/dev/null || echo '未安装'))" >&2
  exit 1
fi

# 2. 依赖已安装(tsx 可用)
if [ ! -x "$BIN_SRC" ]; then
  echo "✗ 未找到 tsx($BIN_SRC)。先在仓库根目录执行: pnpm install" >&2
  exit 1
fi

# 3. claude CLI(只检测不代装不碰凭据;缺失只警告,不阻塞安装)
if ! command -v claude >/dev/null 2>&1; then
  echo "⚠ 未检测到 claude CLI —— 任务执行需要它(安装: https://claude.com/claude-code);pair/status/logs 不受影响"
fi

# 4. 写包装命令
mkdir -p "$PREFIX"
TARGET="$PREFIX/agtpilot-runner"
cat > "$TARGET" <<EOF
#!/usr/bin/env sh
# 由 apps/runner/scripts/install.sh 生成;指向仓内 TS 源(tsx 运行)
exec "$BIN_SRC" "$ENTRY" "\$@"
EOF
chmod +x "$TARGET"

echo "✓ 已安装: $TARGET"
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "⚠ $PREFIX 不在 PATH 中,请加入(如: export PATH=\"\$HOME/.local/bin:\$PATH\")" ;;
esac
echo "下一步: agtpilot-runner pair --server https://<部署地址> --code <8位配对码>"
