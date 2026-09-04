/* modules/tb/sync.js — TB 同步核心：拉任务 → 读字段 → 转成 iteration 行数据
   产出的行结构与手动导入完全一致，下游 calc.js 无需任何改动：
     { productLine, team, iteration, story, est }   // 一行 = 一个任务

   三个看板：
     cloud       → 团队维度，无三级任务筛选     → 喂 _totalsCloud
     middle      → 团队维度，带三级任务筛选     → 喂 _totalsMiddle
     productLine → 产品线维度，带三级任务筛选   → 喂 board（productLine 填充）
*/

'use strict';

const client = require('./client');
const {
  TB_PROJECT_ID,
  TB_FIELDS,
  TB_TASK_LEVEL_VALUE,
  TB_TEAM_SOURCE,
  TB_BOARDS,
  CLOUD_TEAMS,
  MIDDLE_TEAMS
} = require('../../tb-config');

/**
 * 解析迭代名：优先用调用方传入的 sprintMap（state.tbSprintMap 前端配置），
 * 其次回退到 tb-config 的 TB_SPRINTS 默认值。
 * @param {string} sprintId
 * @param {object} sprintMap { sprintId: 迭代名 }
 * @returns {string} 迭代名
 */
function resolveSprintName(sprintId, sprintMap) {
  if (sprintMap && sprintMap[sprintId]) return sprintMap[sprintId];
  try {
    const { TB_SPRINTS } = require('../../tb-config');
    if (TB_SPRINTS[sprintId]) return TB_SPRINTS[sprintId];
  } catch (e) { /* 默认缺失时回退到 id 本身 */ }
  return sprintId;
}

/**
 * 读取自定义字段的原始值对象（含 id/title）。
 * TB 团队/产品线这类层级字段的 value 形如 [{ id, title }]，取第一个。
 * @returns {object|null} value[0]（含 id 与 title），无值时 null
 */
function readCfValue(task, cfId) {
  const fields = task.customfields || task.customFields || [];
  const id = cfId.replace(/^cf:/, '');
  for (const c of fields) {
    const cid = String(c.cfId || c.customfieldId || c.id || '').replace(/^cf:/, '');
    if (cid !== id) continue;
    const val = c.value;
    if (Array.isArray(val) && val.length) return val[0] || null;
    if (val != null && typeof val === 'object') return val;
    if (val != null) return { title: String(val) };
    return null;
  }
  return null;
}

/**
 * 从任务详情的 customfields 里按 cfId 取值（下拉/层级＝取 title）。
 * @returns {string} 文本值
 */
function readCf(task, cfId) {
  const v = readCfValue(task, cfId);
  if (!v) return '';
  return String(v.title != null ? v.title : v).trim();
}

/**
 * 读取自定义字段的下拉 option id（稳定唯一键）。
 * @returns {string|null} value[0].id，无则 null
 */
function readCfId(task, cfId) {
  const v = readCfValue(task, cfId);
  if (!v || v.id == null) return null;
  return String(v.id);
}

/**
 * 读取「所属产品线（层级）」的层级1（「/」之前），如「智慧能源产品中心 / RDP2601..」→「智慧能源产品中心」。
 * TB 层级字段 value 是单个 { title: '层级1 / 层级2' }，截图③按层级1聚合，故只取第一层。
 * @returns {string} 层级1，空则 ''
 */
function readPl1(task) {
  const v = readCfValue(task, TB_FIELDS.productLine);
  if (!v) return '';
  const full = String(v.title != null ? v.title : v).trim();
  if (!full) return '';
  return full.split('/')[0].trim();
}

/** 读数值字段（故事点/预估故事点） */
function readCfNum(task, cfId) {
  const t = readCf(task, cfId);
  const n = parseFloat(String(t).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}

/**
 * 团队名规范化：TB 里存在「同名但含损坏字符（U+FFFD 替换符）」的团队，
 * 视口统计把它们算进正常团队名（如「后端开发-阳光云」302 = 正常301 + 1条脏数据）。
 * 这里把去掉 U+FFFD 后与白名单团队完全同名的脏名，归一为干净团队名。
 * @param {string} name 原始团队名
 * @param {string[]} knownTeams 本看板团队白名单
 * @returns {string} 规范化后的团队名
 */
function normalizeTeam(name, knownTeams) {
  if (!name || !/�/.test(name)) return name;
  const clean = name.replace(/�/g, '');
  for (const t of knownTeams) {
    if (clean === t) return t;
  }
  // 前缀匹配：如「后端开���-阳光云」清污后是「后端开发-阳光云」，命中白名单
  for (const t of knownTeams) {
    if (clean.replace(/[-\s]/g, '').startsWith(t.replace(/[-\s]/g, '').slice(0, 4))) return t;
  }
  return name;
}

/**
 * 产品线「层级1」清洗：TB 的所属产品线层级字段同样存在 U+FFFD 脏字符（位置随机，字数不定），
 * 截图③按「层级1」聚合（如「户用及分布式监控」），脏层级1必须归并到干净层级1。
 * 策略：去 U+FFFD 后，先精确匹配；再按「包含」匹配（脏后缀被吞时取干净超集）；
 * 最后退化为最长公共子串比例匹配，避免脏「户用及布式监控」被甩成独立分组。
 * @param {string} raw 层级1原始串
 * @param {string[]} cleanSet 本批已出现的干净层级1集合
 * @returns {string} 归一后的层级1
 */
function normalizePl1(raw, cleanSet) {
  if (!raw || !/[�]/.test(raw)) return raw;
  const c = raw.replace(/[�]/g, '');
  for (const clean of cleanSet) {
    if (clean === c) return clean;
  }
  for (const clean of cleanSet) {
    if (clean.indexOf(c) >= 0 || c.indexOf(clean) >= 0) return clean;
  }
  let best = null, bestScore = 0;
  for (const clean of cleanSet) {
    const score = lcsRatio(c, clean);
    if (score > bestScore) { bestScore = score; best = clean; }
  }
  return bestScore >= 0.5 ? best : raw;
}

/** 最长公共子序列占较长串的比例（0~1，用于脏名模糊匹配） */
function lcsRatio(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  const dp = Array(m + 1).fill().map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n] / Math.max(m, n);
}

/**
 * 构造 TQL。
 * 统一基线：只取未归档任务（isArchived = false）——这与 TB 统计看板的「任务」口径一致，
 * 否则会把已归档的历史任务也统计进来（如阳光云8月C迭代 838 → 814）。
 * @param {string[]|null} teams 团队白名单，null = 不限团队
 * @param {string} sprintId
 * @param {boolean} filterTaskLevel 是否加三级任务筛选
 */
function buildTql(teams, sprintId, filterTaskLevel) {
  const clauses = [`projectId = '${TB_PROJECT_ID}'`, `isArchived = false`];
  if (sprintId) clauses.push(`sprintId = '${sprintId}'`);
  if (filterTaskLevel) {
    clauses.push(`${TB_FIELDS.taskLevel} = '${TB_TASK_LEVEL_VALUE}'`);
  }
  if (teams && teams.length) {
    const inList = teams.map(t => `'${t.replace(/'/g, "\\'")}'`).join(', ');
    clauses.push(`${TB_FIELDS.team} IN (${inList})`);
  }
  return clauses.join(' AND ');
}

/** 团队取数口径：story/est 两列独立求和（截图①②③ 每行「故事点」「预估故事点」各自累计，
    二者互不干扰——一个任务可同时贡献 story 与 est，不能因团队取数口径而把另一列强制归零）。 */
function pickValueForTeam(task, team) {
  return {
    story: readCfNum(task, TB_FIELDS.storyPoint),
    est: readCfNum(task, TB_FIELDS.estStoryPoint)
  };
}

/**
 * 同步单个看板 → 返回 { rows, stats }
 * rows: [{ productLine, team, iteration, story, est }]
 * @param {object} board 模板（TB_BOARDS 之一）
 * @param {string} token
 * @param {object} overrides { sprintId?, sprintIds?, sprintMap? } 前端可覆盖 sprintId
 */
async function syncBoard(board, token, overrides) {
  overrides = overrides || {};
  const sprintMap = overrides.sprintMap || {};

  // 解析本次要查的 sprint 列表（覆盖优先）
  let sprintIds;
  if (overrides.sprintIds && overrides.sprintIds.length) sprintIds = overrides.sprintIds;
  else if (overrides.sprintId) sprintIds = [overrides.sprintId];
  else if (board.sprintIds && board.sprintIds.length) sprintIds = board.sprintIds;
  else if (board.sprintId) sprintIds = [board.sprintId];
  else sprintIds = [''];

  // 迭代名（板级兜底）：单 sprint 用主 sprint 映射名，多 sprint 用「合并名」作总览。
  // ⚠️ 注意：这只是 stats.iterationName 与「无 sprintId 任务」的兜底；
  //    每行实际迭代名由任务自身 sprintId 解析（见行循环），因为截图③把两迭代分开成不同行。
  const iterationName = sprintIds.length === 1
    ? resolveSprintName(sprintIds[0], sprintMap)
    : (sprintMap[sprintIds[0]] || board.sprintName || board.name);

  // 1) 分页拉全部任务 id（多 sprint 合并去重）
  const idSet = new Set();
  for (const sid of sprintIds) {
    const tql = buildTql(board.teams, sid, board.filterTaskLevel);
    const ids = await client.searchAllTaskIds(tql, token);
    ids.forEach(id => idSet.add(id));
  }
  const allIds = Array.from(idSet);

  // 2) 批量查详情
  const tasks = await client.queryTaskDetails(allIds, token);

  // 3) 逐任务转行
  // 团队白名单：用于脏名归一（productLine 不限团队时，用「全部团队」归一）
  const knownTeams = board.teams && board.teams.length
    ? board.teams
    : Object.keys(TB_TEAM_SOURCE).concat(CLOUD_TEAMS, MIDDLE_TEAMS);

  // ▍用 option id 作为团队唯一键（TB 返回的 title 脏/干净不稳定，id 稳定唯一）。
  // 先扫一遍：收集每个 option id 对应的一条「干净 title」，作为 id→团队名的映射。
  // 同一个 option id 的所有任务在逻辑上必属同一团队，故 id→cleanTitle 唯一。
  const idToTeam = new Map();
  for (const task of tasks) {
    const oid = readCfId(task, TB_FIELDS.team);
    if (oid == null || idToTeam.has(oid)) continue;
    const title = readCf(task, TB_FIELDS.team);
    if (title && !/[�]/.test(title)) idToTeam.set(oid, title);
  }
  // 再用白名单校验：把映射值限定为已知团队（avoid 映射到无关脏团队）
  const cleanIdToTeam = new Map();
  for (const [oid, title] of idToTeam) {
    const t = knownTeams.find(k => k === title) || normalizeTeam(title, knownTeams);
    if (t) cleanIdToTeam.set(oid, t);
  }

  // ▍产品线模式：收集「干净层级1」集合，供脏层级1归一（截图③按层级1聚合）。
  // 层级1 = 完整产品线串「/」前的部分；脏字符可能出现在层级1（如「户用及���布式监控」）。
  const cleanPl1Set = [];
  if (board.dimension === 'productLine') {
    for (const task of tasks) {
      const pl = readPl1(task);
      if (pl && !/[�]/.test(pl) && cleanPl1Set.indexOf(pl) < 0) cleanPl1Set.push(pl);
    }
  }

  const rows = [];
  let skipped = 0;
  for (const task of tasks) {
    const oid = readCfId(task, TB_FIELDS.team);
    let team;
    if (oid != null && cleanIdToTeam.has(oid)) {
      // 稳定路径：按 option id 归队（规避 title 脏/干净不稳定）
      team = cleanIdToTeam.get(oid);
    } else {
      // 兜底：按 title 归一（读不到 id 或 id 不在映射中的情况，如历史数据）
      team = normalizeTeam(readCf(task, TB_FIELDS.team), knownTeams);
    }
    if (!team) { skipped++; continue; }
    const { story, est } = pickValueForTeam(task, team);
    // ⚠️ 任务数要按「所有任务」计（截图①的 taskcount），不能因无故事点而跳过；
    //    无数值的任务 story/est 为 0，不影响求和，但必须保留占位以计入任务数。

    const productLine = board.dimension === 'productLine'
      ? normalizePl1(readPl1(task), cleanPl1Set) || '未填写'
      : '';

    // ▍每行迭代名 = 任务自身 sprintId 解析（截图③把两迭代分成不同行，不能用板级合并名）。
    //    任务自带 sprintId（sprintId / _sprintId），按 sprintMap/tb-config 映射成迭代名；
    //    map 缺失时回退到板级 iterationName（单 sprint 场景等价）。
    const rowIt = task.sprintId || task._sprintId
      ? (resolveSprintName(task.sprintId || task._sprintId, sprintMap) || iterationName)
      : iterationName;

    rows.push({
      productLine: productLine,
      team: team,
      iteration: rowIt,
      story: story,
      est: est
    });
  }

  // 汇总统计（供前端展示 & 对账）
  const totalStory = rows.reduce((s, r) => s + (r.story || 0), 0);
  const totalEst = rows.reduce((s, r) => s + (r.est || 0), 0);

  return {
    rows: rows,
    stats: {
      board: board.key,
      name: board.name,
      taskCount: rows.length,
      skipped: skipped,
      totalStory: Math.round(totalStory * 100) / 100,
      totalEst: Math.round(totalEst * 100) / 100,
      totalPoints: Math.round((totalStory + totalEst) * 100) / 100,
      sprintIds: sprintIds,
      iterationName: iterationName
    }
  };
}

/**
 * 全量同步：三个看板并行拉取，返回可直接写入 state 的结果。
 * @param {string} token
 * @param {object} boardOverrides { cloud:{sprintId}, middle:{sprintId}, productLine:{sprintIds} }
 * @param {object} sprintMap 迭代映射 { sprintId: 迭代名 }（来自 state.tbSprintMap，前端配置）
 */
async function syncAll(token, boardOverrides, sprintMap) {
  boardOverrides = boardOverrides || {};
  const common = { sprintMap: sprintMap || {} };

  const [cloud, middle, productLine] = await Promise.all([
    syncBoard(TB_BOARDS.cloud, token, Object.assign({}, common, boardOverrides.cloud)),
    syncBoard(TB_BOARDS.middle, token, Object.assign({}, common, boardOverrides.middle)),
    syncBoard(TB_BOARDS.productLine, token, Object.assign({}, common, boardOverrides.productLine))
  ]);

  return {
    cloudRows: cloud.rows,
    middleRows: middle.rows,
    boardRows: productLine.rows,
    stats: {
      cloud: cloud.stats,
      middle: middle.stats,
      productLine: productLine.stats
    }
  };
}

/**
 * 只同步指定看板（前端可能只想刷新其中一个）。
 * @param {string} boardKey cloud|middle|productLine
 */
async function syncOne(boardKey, token, overrides) {
  const board = TB_BOARDS[boardKey];
  if (!board) throw new Error('未知看板: ' + boardKey);
  return syncBoard(board, token, overrides);
}

module.exports = {
  readCf,
  readCfId,
  readCfValue,
  readCfNum,
  readPl1,
  buildTql,
  normalizeTeam,
  normalizePl1,
  resolveSprintName,
  syncBoard,
  syncAll,
  syncOne
};
