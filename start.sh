#!/usr/bin/env bash
# ============================================================
#  iSolarCloud 项目管理工作台 — 启动脚本（Linux/macOS）
#
#  用法：
#    ./start.sh              → 默认端口 9680，登录关闭（与旧版行为一致）
#    ./start.sh 8800         → 指定端口
#
#  ⚠ 端口 9680 是公司 SSO 回调白名单里登记的值（http://10.63.139.103:9680/sso/callback）。
#    改端口必须同步去「流程数字化中心」变更回调地址，否则 SSO 跳到旧端口会被拒绝。
#    详见 docs/plan-identity-and-dingtalk.md 与 docs/ops-server-deploy.md
#
#  启用真实登录（M1 验收后建议启用）：
#    AUTH_REQUIRED=1 ./start.sh
#  首次启用登录前，请先看启动日志里打印的 admin 一次性密码，
#  或确认已能登录，再打开该开关。详见 docs/ops-manual.md。
# ============================================================
set -e
cd "$(dirname "$0")"

PORT="${1:-${PORT:-9680}}"

# 部署到服务器时，把数据指向持久化路径（留空则用同目录 data/）：
# export DATA_DIR=/data/pmwork/data

echo "启动 iSolarCloud 项目管理工作台"
echo "  端口: $PORT"
echo "  数据: ${DATA_DIR:-（项目目录 data/）}"
echo "  登录: ${AUTH_REQUIRED:-（关闭）}"
echo

exec node server.js "$PORT"
