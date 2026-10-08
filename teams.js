/* teams.js — 团队分类口径（唯一来源：data/dingtalk/teams.json）

   ★ 这 19 个团队分类，和 users.department 不是一回事，别混：

     users.department  = 钉钉通讯录的【叶子部门名】，68 个值
                         （「阳光云组」「WEB组 WEB Team」「平台组」…）
     teams.json 的团队  = PMO 要的【团队分类】，19 个值
                         （「App开发部」「测试部」「微电网产品线」…）

   两个维度正交：「阳光云组」的人按产品线拆进了 App / 后端 / Web 三个开发部，
   所以「按部门筛人」必须以本文件为准，通讯录的 orgPath 只能作参考。
   来源：业务方 2026-09-24 交付的《智慧能源人员名单.csv》。

   为什么不把团队分类回填进 users.department：那是写生产库，而且会冲掉现有
   的钉钉部门名（要重新拉通讯录才能重建）。这里改成【按姓名反查】的只读派生 ——
   库里一个字节不动，改完 teams.json 重启即生效。

   姓名唯一性：372 名用户与 teams.json 严格一一对应，实测零重名、零遗漏
   （2026-10-08）。若将来出现重名，teamOf() 会返回 ''，而不是猜一个 ——
   猜错等于把人划到别的部门，比留空更糟。

   文件缺失时全程降级：all() 返回空数组、teamOf() 返回 ''，不抛异常。
   管理页面会提示「团队名单未就绪」，而不是整个页面白屏。 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const TEAMS_FILE = path.join(DATA_DIR, 'dingtalk', 'teams.json');

/* 带 mtime 的缓存：按姓名反查要走 372 条，每次请求都重新读盘没必要。
   mtime 变了就重读 —— 改完文件不用重启也能生效（虽然文档里写的是重启）。 */
let _cache = null;
let _mtime = 0;
let _loaded = false;

/** 读文件（带缓存）。返回 {teams, byName}；文件缺失/损坏时返回空结构。 */
function _load() {
  let mtime = 0;
  try {
    mtime = fs.statSync(TEAMS_FILE).mtimeMs;
  } catch (e) {
    _cache = { teams: [], byName: {}, total: 0, source: TEAMS_FILE, ready: false };
    _mtime = 0;
    _loaded = true;
    return _cache;
  }
  if (_loaded && mtime === _mtime && _cache) return _cache;

  try {
    const raw = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
    const byName = {};
    let dup = 0;
    for (const [team, list] of Object.entries(raw.members || {})) {
      for (const name of list || []) {
        /* 重名 → 置空而不是后写覆盖：宁可这个人在界面上「团队未知」，
           也不要把两个同名的人合并成一个部门。 */
        if (byName[name]) { byName[name] = ''; dup++; continue; }
        byName[name] = team;
      }
    }
    if (dup > 0) {
      console.warn('[teams] 名单里有 ' + dup + ' 个重名，这些人的团队分类将留空：' + TEAMS_FILE);
    }
    _cache = {
      teams: Array.isArray(raw.teams) ? raw.teams : [],
      byName: byName,
      total: raw.total || Object.keys(byName).length,
      generatedAt: raw.generatedAt || '',
      source: raw.source || '',
      ready: true
    };
  } catch (e) {
    console.warn('[teams] 解析失败，按「名单未就绪」处理：' + e.message);
    _cache = { teams: [], byName: {}, total: 0, source: TEAMS_FILE, ready: false };
  }
  _mtime = mtime;
  _loaded = true;
  return _cache;
}

/** 19 个团队元信息（含 declared 声明人数 / count 名单人数） */
function all() {
  return _load().teams;
}

/** 姓名 → 团队分类。查不到或重名返回 ''。 */
function teamOf(name) {
  return _load().byName[String(name || '')] || '';
}

/** 名单是否可用（文件存在且能解析） */
function ready() {
  return _load().ready;
}

/** 供诊断：总数 + 文件来源 */
function meta() {
  const c = _load();
  return { ready: c.ready, total: c.total, generatedAt: c.generatedAt, source: c.source, file: TEAMS_FILE };
}

module.exports = { all, teamOf, ready, meta, TEAMS_FILE };
