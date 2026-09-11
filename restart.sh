#!/bin/bash
# 错题本 H5 重启脚本
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8322}"

if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  "$ROOT/stop.sh"
  sleep 1
fi
"$ROOT/start.sh"
