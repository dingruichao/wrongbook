#!/bin/bash
# 错题本 H5 停止脚本
set -u
PORT="${PORT:-8322}"

PID=$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)
if [ -z "$PID" ]; then
  echo "端口 $PORT 没有运行中的服务。"
  exit 0
fi

echo "正在停止 PID: $PID"
kill $PID 2>/dev/null || true
sleep 1
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "未响应，强制结束..."
  kill -9 $PID 2>/dev/null || true
  sleep 0.5
fi

if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "❌ 停止失败"
  exit 1
else
  echo "✅ 已停止"
fi
