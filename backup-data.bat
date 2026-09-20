@echo off
rem iSolarCloud 项目管理工作台 — 数据备份（Windows）
rem 用法：
rem   backup-data.bat                    → 备份到项目目录 backups\
rem   set BACKUP_DIR=E:\pm-backups && backup-data.bat
setlocal
cd /d %~dp0
node backup.js
endlocal
