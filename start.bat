@echo off
rem ============================================================
rem  iSolarCloud 项目管理工作台 — 启动脚本（Windows）
rem
rem  用法：
rem    双击运行                      → 默认端口 8770，登录关闭（与旧版行为一致）
rem    start.bat 8800                → 指定端口
rem
rem  启用真实登录（M1 验收后建议启用）：
rem    set AUTH_REQUIRED=1
rem    start.bat
rem  首次启用登录前，请先看启动日志里打印的 admin 一次性口令，
rem  或确认已能登录，再打开该开关。详见 docs/ops-manual.md。
rem ============================================================
setlocal
cd /d %~dp0

set PORT=%~1
if "%PORT%"=="" set PORT=8770

rem 部署到服务器时，把数据指向持久化路径（留空则用同目录 data/）：
rem set DATA_DIR=D:\pmwork\data

echo 启动 iSolarCloud 项目管理工作台
echo   端口: %PORT%
echo   数据: %DATA_DIR% (空 = 项目目录 data^)
echo   登录: %AUTH_REQUIRED% (1 = 启用登录，空 = 关闭)
echo.

node server.js %PORT%

endlocal
