#!/usr/bin/env bash
# iSolarCloud 项目管理工作台 — 数据备份（Linux/macOS）
# 用法：
#   ./backup.sh                     → 备份到项目目录 backups/
#   BACKUP_DIR=/data/pm-backups ./backup.sh
# 建议：crontab 每天跑一次，例如
#   0 2 * * * cd /path/to/iSolarCloudProjectManage && ./backup.sh >> /var/log/pm-backup.log 2>&1
cd "$(dirname "$0")"
exec node backup.js "$@"
