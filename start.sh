#!/usr/bin/env bash
# ============================================================
#  iSolarCloud 项目管理工作台 — 启动脚本（Linux/macOS）
#
#  用法：
#    ./start.sh              → 默认端口 8770，登录关闭（与旧版行为一致）
#    ./start.sh 8800         → 指定端口
#
#  启用真实登录（M1 验收后建议启用）：
#    AUTH_REQUIRED=1 ./start.sh
#  首次启用登录前，请先看启动日志里打印的 admin 一次性口令，
#  或确认已能登录，再打开该开关。详见 docs/ops-manual.md。
# ============================================================
set -e
cd "$(dirname "$0")"

PORT="${1:-${PORT:-8770}}"

# 部署到服务器时，把数据指向持久化路径（留空则用同目录 data/）：
# export DATA_DIR=/data/pmwork/data

echo "启动 iSolarCloud 项目管理工作台"
echo "  端口: $PORT"
echo "  数据: ${DATA_DIR:-（项目目录 data/）}"
echo "  登录: ${AUTH_REQUIRED:-（关闭）}"
echo

exec node server.js "$PORT"
