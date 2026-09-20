/* backup.js — 数据备份脚本
   备份整个 DATA_DIR（各模块 JSON + platform.db）。
   先对 platform.db 做 WAL checkpoint（TRUNCATE），把 -wal 日志合并回主库，
   保证复制出来的 platform.db 是自洽完整的（WAL 文件可能还含未合并的写入）。

   用法：
     node backup.js                      → 备份到 ./backups/backup-<时间戳>/
     set BACKUP_DIR=E:\pm-backups && node backup.js
   建议：定时任务每天跑一次（计划任务 / cron），备份目录放独立磁盘。 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DEST = path.join(
  process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(__dirname, 'backups'),
  'backup-' + TS
);

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error('数据目录不存在：' + DATA_DIR);
    process.exit(1);
  }
  fs.mkdirSync(DEST, { recursive: true });

  /* 1. WAL checkpoint：合并 platform.db-wal，保证副本一致 */
  const dbFile = path.join(DATA_DIR, process.env.DB_FILE || 'platform.db');
  if (fs.existsSync(dbFile)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbFile);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
      console.log('WAL 已合并：' + dbFile);
    } catch (e) {
      console.warn('警告：WAL checkpoint 失败（继续备份，但 db 副本可能不含最近写入）：' + e.message);
    }
  } else {
    console.log('platform.db 不存在（M1 Step 1 未执行过？），跳过 WAL 合并');
  }

  /* 2. 整目录复制 */
  fs.cpSync(DATA_DIR, DEST, { recursive: true });

  /* 3. 校验：关键文件存在且非空 */
  const critical = ['platform.db', 'platform.json'];
  const missing = critical.filter(f => {
    const p = path.join(DEST, f);
    return !(fs.existsSync(p) && fs.statSync(p).size > 0);
  });
  if (missing.length) {
    console.warn('警告：以下关键文件缺失或为空：' + missing.join(', '));
  }
  const files = countFiles(DEST);
  const bytes = dirSize(DEST);
  console.log('备份完成：' + DEST);
  console.log('  文件数：' + files + '，大小：' + Math.round(bytes / 1024) + ' KB');

  /* 4. 只保留最近 30 份，避免无限增长 */
  const root = path.dirname(DEST);
  const old = fs.readdirSync(root)
    .filter(d => d.startsWith('backup-'))
    .sort()
    .slice(0, -30);
  old.forEach(d => {
    try { fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  });
  if (old.length) console.log('已清理 ' + old.length + ' 份过期备份（保留最近 30 份）');
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

function dirSize(dir) {
  let s = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    s += e.isDirectory() ? dirSize(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size;
  }
  return s;
}

main();
