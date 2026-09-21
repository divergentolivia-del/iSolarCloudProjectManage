#!/usr/bin/env node
/* user-cli.js — 账号维护 CLI（服务未启动时使用）

   为什么需要它：db.js 只在「库里一个账号都没有」时建默认管理员，并把随机口令打印在启动日志里；
   该口令取过一次就清空（takeInitialAdmin），之后控制台再也不会显示。
   于是库里已有账号、又没记下口令的机器，从页面上是无路可进的 —— 只能由运维在终端重置。

   用法:
     node user-cli.js list                          → 列出全部账号
     node user-cli.js pass <账号> <新口令>            → 重置指定账号口令
     node user-cli.js pass admin                    → 随机生成一个 12 位口令并打印
     node user-cli.js role <账号> <角色>              → 改角色（admin/pm/dev/viewer）
     node user-cli.js add  <账号> <姓名> <角色> <口令>  → 新建账号

   注意：本脚本直接读写平台数据库，请先停掉服务再执行，避免写入竞争。
*/

'use strict';

const crypto = require('crypto');
const db = require('./db');

/* 与 db.js 一致的账号库位置提示 */
const DB_DESC = process.env.DATA_DIR
  ? process.env.DATA_DIR + '/' + (process.env.DB_FILE || 'platform.db')
  : './data/' + (process.env.DB_FILE || 'platform.db');

const ROLES = ['admin', 'pm', 'dev', 'viewer'];

function usage(code) {
  console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, ''));
  process.exit(code || 0);
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') usage(0);

  console.log('账号库：' + DB_DESC);

  if (cmd === 'list') {
    const users = db.listUsers();
    if (!users.length) return console.log('库里没有任何账号。');
    console.log('');
    for (const u of users) {
      console.log(
        '  ' + String(u.id).padEnd(14) +
        String(u.name).padEnd(12) +
        String(u.role).padEnd(8) +
        (u.enabled ? '启用' : '停用') +
        '  创建于 ' + (u.created_at || '-')
      );
    }
    console.log('\n共 ' + users.length + ' 个账号。');
    return;
  }

  if (cmd === 'pass') {
    const id = args[0];
    if (!id) return usage(1);
    if (!db.findUser(id)) return fail('账号不存在：' + id);
    /* 未给口令则随机生成。用 base64url 去掉易混淆字符后截 12 位，足够强且能对着屏幕手抄。 */
    const pwd = args[1] || crypto.randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, 12);
    if (pwd.length < 6) return fail('口令太短，至少 6 位。');
    db.setPassword(id, pwd);
    console.log('\n已重置口令：');
    console.log('  账号：' + id);
    console.log('  口令：' + pwd);
    console.log('\n请登录后立即通过「修改口令」改成自己的，并妥善保存。');
    return;
  }

  if (cmd === 'role') {
    const [id, role] = args;
    if (!id || !role) return usage(1);
    if (!db.findUser(id)) return fail('账号不存在：' + id);
    if (!ROLES.includes(role)) return fail('角色非法，可选：' + ROLES.join(' / '));
    db.setRole(id, role);
    console.log('\n已把 ' + id + ' 的角色改为：' + role);
    return;
  }

  if (cmd === 'add') {
    const [id, name, role, pwd] = args;
    if (!id || !name || !role) return usage(1);
    if (!ROLES.includes(role)) return fail('角色非法，可选：' + ROLES.join(' / '));
    if (db.findUser(id)) return fail('账号已存在：' + id);
    const password = pwd || crypto.randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, 12);
    db.createUser({ id, name, role, password });
    console.log('\n已新建账号：');
    console.log('  账号：' + id + '   姓名：' + name + '   角色：' + role);
    console.log('  口令：' + password);
    return;
  }

  usage(1);
}

function fail(msg) {
  console.error('\n✗ ' + msg);
  process.exit(1);
}

main();
