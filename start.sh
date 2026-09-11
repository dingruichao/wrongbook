#!/bin/bash
# 错题本 H5 启动脚本（幂等：端口已占用则直接提示，不重复启动）
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-/Users/dingrc/.workbuddy/binaries/node/versions/22.22.2-2/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)"
# pg 驱动装在隔离的 node workspace 里，不在项目本地（保持项目零 npm install）
export NODE_PATH="${NODE_PATH:-/Users/dingrc/.workbuddy/binaries/node/workspace/node_modules}"
PORT="${PORT:-8322}"
HOST="${HOST:-0.0.0.0}"

if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️  端口 $PORT 已有服务在运行，无需重复启动。"
  echo "    访问: http://127.0.0.1:$PORT"
  echo "    如需重启请运行: ./restart.sh"
  exit 0
fi

cd "$ROOT" || exit 1
mkdir -p uploads
nohup "$NODE" server.js > server.log 2>&1 &
PID=$!
echo "🚀 已后台启动错题本 (PID $PID)"
sleep 1.5
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✅ 启动成功: http://127.0.0.1:$PORT"
  LAN=$(ipconfig getifaddr en0 2>/dev/null || true)
  [ -n "$LAN" ] && echo "   手机访问: http://$LAN:$PORT"
else
  echo "❌ 启动失败，请查看 server.log："
  tail -n 20 server.log 2>/dev/null
fi
