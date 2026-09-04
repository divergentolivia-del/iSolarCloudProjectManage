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
  TB_BOARDS
} = require('../../tb-config');

/**
 * 从任务详情的 customfields 里按 cfId 取值。
 * TB 自定义字段值形如 [{ title: '...' }]，取第一个 title。
 * @returns {string} 文本值（下拉/层级）
 */
function readCf(task, cfId) {
  const fields = task.customfields || task.customFields || [];
  const id = cfId.replace(/^cf:/, '');
  for (const c of fields) {
    const cid = String(c.cfId || c.customfieldId || c.id || '').replace(/^cf:/, '');
    if (cid !== id) continue;
    const val = c.value;
    if (Array.isArray(val) && val.length) {
      return String(val[0].title != null ? val[0].title : val[0]).trim();
    }
    if (val != null && typeof val === 'object' && val.title != null) return String(val.title).trim();
    if (val != null) return String(val).trim();
    return '';
  }
  return '';
}

/** 读数值字段（故事点/预估故事点） */
function readCfNum(task, cfId) {
  const t = readCf(task, cfId);
  const n = parseFloat(String(t).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}

/**
 * 构造 TQL。
 * @param {string[]|null} teams 团队白名单，null = 不限团队
 * @param {string} sprintId
 * @param {boolean} filterTaskLevel 是否加三级任务筛选
 */
function buildTql(teams, sprintId, filterTaskLevel) {
  const clauses = [`projectId = '${TB_PROJECT_ID}'`];
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

/** 团队取数口径：默认 story，配置里指定 est 的团队取预估故事点 */
function pickValueForTeam(task, team) {
  const source = TB_TEAM_SOURCE[team] || 'story';
  if (source === 'est') {
    return { story: 0, est: readCfNum(task, TB_FIELDS.estStoryPoint) };
  }
  return { story: readCfNum(task, TB_FIELDS.storyPoint), est: 0 };
}

/**
 * 同步单个看板 → 返回 { rows, stats }
 * rows: [{ productLine, team, iteration, story, est }]
 * @param {object} board 模板（TB_BOARDS 之一）
 * @param {string} token
 * @param {object} overrides { sprintId?, sprintIds? } 前端可覆盖 sprintId
 */
async function syncBoard(board, token, overrides) {
  overrides = overrides || {};
  const iterationName = board.sprintName || board.name;

  // 解析本次要查的 sprint 列表（覆盖优先）
  let sprintIds;
  if (overrides.sprintIds && overrides.sprintIds.length) sprintIds = overrides.sprintIds;
  else if (overrides.sprintId) sprintIds = [overrides.sprintId];
  else if (board.sprintIds && board.sprintIds.length) sprintIds = board.sprintIds;
  else if (board.sprintId) sprintIds = [board.sprintId];
  else sprintIds = [''];

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
  const rows = [];
  let skipped = 0;
  for (const task of tasks) {
    const team = readCf(task, TB_FIELDS.team);
    if (!team) { skipped++; continue; }
    const { story, est } = pickValueForTeam(task, team);
    if (!story && !est) { skipped++; continue; }

    const productLine = board.dimension === 'productLine'
      ? (readCf(task, TB_FIELDS.productLine) || '未填写')
      : '';

    rows.push({
      productLine: productLine,
      team: team,
      iteration: iterationName,
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
 */
async function syncAll(token, boardOverrides) {
  boardOverrides = boardOverrides || {};

  const [cloud, middle, productLine] = await Promise.all([
    syncBoard(TB_BOARDS.cloud, token, boardOverrides.cloud),
    syncBoard(TB_BOARDS.middle, token, boardOverrides.middle),
    syncBoard(TB_BOARDS.productLine, token, boardOverrides.productLine)
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
  readCfNum,
  buildTql,
  syncBoard,
  syncAll,
  syncOne
};
