/* export-builder.js — Excel 构建层
   纯函数模块，接收 state 和计算结果，返回与原始 Excel 格式一致的 3-Sheet XLSX Workbook。
   输出对标原始文件「云平台-2026年7月人力情况.xlsx」的排版。 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

/* ─── Load config values (TEAMS, PRODUCT_LINES, etc.) ───
   config.js uses top-level `const` without module.exports (shared with browser).
   We wrap it in a Function to extract the values. */
const configSource = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
const configFn = new Function(configSource + '\nreturn { TEAMS, PRODUCT_LINES, OTHER_CATEGORIES, LOCK_ROLES, LOCK_ROLE_TO_TEAM, OWNER_LINES, DEVIATION_TOLERANCE };');
const CONFIG = configFn();
const { TEAMS, PRODUCT_LINES, OTHER_CATEGORIES, LOCK_ROLES, LOCK_ROLE_TO_TEAM } = CONFIG;

/* ─── Helpers ─── */

/** Group TEAMS by dept, preserving order */
function groupByDept(teams) {
  const groups = [];
  const seen = {};
  teams.forEach(t => {
    if (!seen[t.dept]) {
      seen[t.dept] = { name: t.dept, teams: [] };
      groups.push(seen[t.dept]);
    }
    seen[t.dept].teams.push(t);
  });
  return groups;
}

/** Extract short direction name from full team key (remove dept prefix) */
function shortName(team) {
  const idx = team.key.indexOf('-');
  return idx >= 0 ? team.key.slice(idx + 1) : team.key;
}

/** Derive month label (e.g. "7月") from active cycle's online date */
function deriveMonthLabel(cycle) {
  if (!cycle) return '';
  const online = String(cycle.online || '');
  // online format is like "8.13" — the month part before the dot
  const m = online.match(/^(\d+)\./);
  if (m) {
    // The online month indicates the delivery month; the capacity data is for the preceding month
    const onlineMonth = parseInt(m[1], 10);
    const dataMonth = onlineMonth > 1 ? onlineMonth - 1 : 12;
    return dataMonth + '月';
  }
  return '';
}

/** Sum all team values in a row object */
function rowTotal(values) {
  return TEAMS.reduce((s, t) => s + (Number(values[t.key]) || 0), 0);
}


/* ═══════════════════════════════════════════════════════════════
   Sheet 1: {月份}产能数据
   上部: 部门×方向 正式/外包/总人数矩阵
   下部: 版本周期方案表
   右侧: 专项锁定项目列表
   ═══════════════════════════════════════════════════════════════ */

function buildCapacitySheet(state, computeResult) {
  const aoa = [];
  const depts = groupByDept(TEAMS);

  // --- Row 0: Department header row (merged-style display) ---
  const deptRow = [''];
  depts.forEach(dept => {
    deptRow.push(dept.name);
    for (let i = 1; i < dept.teams.length; i++) deptRow.push('');
  });
  deptRow.push('云平台总人数');
  aoa.push(deptRow);

  // --- Row 1: Team direction subheader ---
  const dirRow = [''];
  depts.forEach(dept => {
    dept.teams.forEach(t => dirRow.push(shortName(t)));
  });
  dirRow.push('');
  aoa.push(dirRow);

  // --- Row 2: 正式人数 ---
  const regularRow = ['正式人数'];
  let regularTotal = 0;
  TEAMS.forEach(t => {
    const h = (state.headcount || {})[t.key] || {};
    const v = Number(h.regular) || 0;
    regularRow.push(v || '');
    regularTotal += v;
  });
  regularRow.push(regularTotal);
  aoa.push(regularRow);

  // --- Row 3: 外包人数 ---
  const outsourceRow = ['外包人数'];
  let outsourceTotal = 0;
  TEAMS.forEach(t => {
    const h = (state.headcount || {})[t.key] || {};
    const v = Number(h.outsource) || 0;
    outsourceRow.push(v || '');
    outsourceTotal += v;
  });
  outsourceRow.push(outsourceTotal);
  aoa.push(outsourceRow);

  // --- Row 4: 总人数 ---
  const totalRow = ['总人数'];
  let grandTotal = 0;
  TEAMS.forEach(t => {
    const v = computeResult.heads[t.key] || 0;
    totalRow.push(v || '');
    grandTotal += v;
  });
  totalRow.push(grandTotal);
  aoa.push(totalRow);

  // --- Empty rows separator ---
  aoa.push([]);
  aoa.push([]);

  // --- Locked projects section (right-side in original Excel, here below headcount) ---
  aoa.push(['专项锁定人力']);
  const lockHeader = ['项目名称'];
  LOCK_ROLES.forEach(r => lockHeader.push(r));
  lockHeader.push('备注');
  aoa.push(lockHeader);

  (state.locked || []).forEach(item => {
    const row = [item.name || ''];
    LOCK_ROLES.forEach(r => {
      const v = (item.roles || {})[r];
      row.push(v || '');
    });
    row.push(item.note || '');
    aoa.push(row);
  });

  // --- Empty rows separator ---
  aoa.push([]);
  aoa.push([]);

  // --- Version cycle plan table ---
  aoa.push(['版本上线时间']);
  aoa.push(['封版时间', '上线时间', '工作日', '周六天数', '开发周期', '是否采用']);
  (state.cycles || []).forEach(c => {
    aoa.push([
      c.seal || '',
      c.online || '',
      c.workdays || 0,
      c.saturdays || 0,
      (Number(c.workdays) || 0) + (Number(c.saturdays) || 0),
      c.active ? '是' : ''
    ]);
  });

  // Conclusion note
  const activeCycle = (state.cycles || []).find(c => c.active) || (state.cycles || [])[0];
  if (activeCycle && activeCycle.note) {
    aoa.push([activeCycle.note]);
  }

  // Build worksheet and set column widths
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Set column widths: first column wider, team columns standard
  const cols = [{ wch: 14 }];
  TEAMS.forEach(() => cols.push({ wch: 10 }));
  cols.push({ wch: 12 });
  ws['!cols'] = cols;

  return ws;
}


/* ═══════════════════════════════════════════════════════════════
   Sheet 2: 规划与产能分析
   4 个区块纵向排列:
     Section 1: 产品线版本工作量汇总
     Section 2: 版本规划工作量汇总
     Section 3: 云团队产能明细
     Section 4: 偏差分析
   ═══════════════════════════════════════════════════════════════ */

function buildPlanningSheet(state, computeResult) {
  const aoa = [];
  const teamHeaders = TEAMS.map(t => t.key);

  // ─── Section 1: 产品线版本工作量汇总 ───
  aoa.push(['产品线版本工作量汇总']);
  aoa.push(['产线'].concat(teamHeaders).concat(['版本工作量（人天）']));

  (computeResult.lineRows || []).forEach(r => {
    const row = [r.key];
    TEAMS.forEach(t => row.push(r.values[t.key] || 0));
    row.push(rowTotal(r.values));
    aoa.push(row);
  });

  // Summary row
  const lineSummaryRow = ['产品线汇总'];
  TEAMS.forEach(t => lineSummaryRow.push((computeResult.lineSummary || {})[t.key] || 0));
  lineSummaryRow.push(rowTotal(computeResult.lineSummary || {}));
  aoa.push(lineSummaryRow);

  // Separator
  aoa.push([]);
  aoa.push([]);

  // ─── Section 2: 版本规划工作量汇总 ───
  aoa.push(['版本规划工作量汇总']);
  aoa.push(['分类'].concat(teamHeaders).concat(['需求总人力（人天）']));

  (computeResult.planRows || []).forEach(r => {
    const row = [r.key];
    TEAMS.forEach(t => row.push(r.values[t.key] || 0));
    row.push(rowTotal(r.values));
    aoa.push(row);
  });

  // Plan total row
  const planTotalRow = ['合计'];
  TEAMS.forEach(t => planTotalRow.push((computeResult.planTotal || {})[t.key] || 0));
  planTotalRow.push(rowTotal(computeResult.planTotal || {}));
  aoa.push(planTotalRow);

  // Separator
  aoa.push([]);
  aoa.push([]);

  // ─── Section 3: 云团队产能明细 ───
  aoa.push(['云团队产能明细']);
  aoa.push(['员工类型'].concat(teamHeaders).concat(['总人数', '研发天数', '总产能（人天）']));

  const days = computeResult.days || 0;

  // Regular headcount row
  const regRow = ['正式'];
  let regSum = 0;
  TEAMS.forEach(t => {
    const h = (state.headcount || {})[t.key] || {};
    const v = Number(h.regular) || 0;
    regRow.push(v);
    regSum += v;
  });
  regRow.push(regSum, '', '');
  aoa.push(regRow);

  // Outsource headcount row
  const outRow = ['外包'];
  let outSum = 0;
  TEAMS.forEach(t => {
    const h = (state.headcount || {})[t.key] || {};
    const v = Number(h.outsource) || 0;
    outRow.push(v);
    outSum += v;
  });
  outRow.push(outSum, '', '');
  aoa.push(outRow);

  // Total headcount row with capacity computation
  const sumRow = ['汇总（产能）'];
  let headSum = 0;
  let capSum = 0;
  TEAMS.forEach(t => {
    const head = computeResult.heads[t.key] || 0;
    sumRow.push(head);
    headSum += head;
  });
  capSum = headSum * days;
  sumRow.push(headSum, days, capSum);
  aoa.push(sumRow);

  // Per-team capacity row
  const capRow = ['各团队产能'];
  TEAMS.forEach(t => {
    const head = computeResult.heads[t.key] || 0;
    capRow.push(head * days);
  });
  capRow.push('', '', '');
  aoa.push(capRow);

  // Separator
  aoa.push([]);
  aoa.push([]);

  // ─── Section 4: 团队版本工作量与团队产能偏差分析 ───
  aoa.push(['团队版本工作量与团队产能偏差分析']);
  aoa.push(['团队', '版本工作量（人天）', '总产能（人天）', '超出工作量', '超出比例', '结论']);

  (computeResult.deviation || []).forEach(d => {
    aoa.push([
      d.team,
      d.workload,
      d.capacity,
      d.over,
      d.ratio !== 0 ? (d.ratio * 100).toFixed(1) + '%' : '0%',
      d.verdict
    ]);
  });

  // Totals summary row for deviation
  const devTotals = computeResult.totals || {};
  aoa.push([
    '合计',
    devTotals.workload || 0,
    devTotals.capacity || 0,
    (devTotals.workload || 0) - (devTotals.capacity || 0),
    devTotals.capacity ? (((devTotals.workload || 0) - (devTotals.capacity || 0)) / devTotals.capacity * 100).toFixed(1) + '%' : '0%',
    ''
  ]);

  // Footnotes
  aoa.push([]);
  aoa.push(['备注：']);
  aoa.push(['1、超出工作量 = 团队版本工作量 - 团队产能']);
  aoa.push(['2、超出工作量为负数说明产能富余；为正数说明产能不足']);
  aoa.push(['3、超出比例±10%以内属于正常偏差']);

  // Build worksheet and set column widths
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // First column wider for labels, team columns auto
  const cols = [{ wch: 22 }];
  teamHeaders.forEach(() => cols.push({ wch: 10 }));
  cols.push({ wch: 18 }); // totals column
  ws['!cols'] = cols;

  return ws;
}


/* ═══════════════════════════════════════════════════════════════
   Sheet 3: 人力工时数据
   原始迭代故事点数据，按「所属项目(层级1)」分组
   列: 所属项目(层级1) | 所在团队 | 迭代1(故事点/预估) | 迭代2(故事点/预估) ...
   ═══════════════════════════════════════════════════════════════ */

function buildStoryPointSheet(state) {
  const aoa = [];
  const selectedIters = (state.iterations || []).filter(i => i.selected).map(i => i.name);

  // --- Header Row 1: iteration names (each spans 2 columns) ---
  const headerRow1 = ['所属项目(层级1)', '所在团队'];
  selectedIters.forEach(iter => {
    headerRow1.push(iter, '');
  });
  headerRow1.push('', '项目_公式辅助列');
  aoa.push(headerRow1);

  // --- Header Row 2: sub-headers ---
  const headerRow2 = ['', ''];
  selectedIters.forEach(() => {
    headerRow2.push('故事点 (求和)', '预估故事点 (求和)');
  });
  headerRow2.push('', '');
  aoa.push(headerRow2);

  // --- Group data by project (层级1) ---
  // Use board data which has productLine field, plus totals data
  // Merge both sources and group by productLine (project)
  const grouped = groupStoryData(state, selectedIters);

  grouped.forEach(group => {
    group.rows.forEach((row, idx) => {
      const dataRow = [idx === 0 ? group.project : '', row.team];
      selectedIters.forEach(iter => {
        dataRow.push(row.storyByIter[iter] || 0, row.estByIter[iter] || 0);
      });
      dataRow.push('', idx === 0 ? group.project : '');
      aoa.push(dataRow);
    });
  });

  // Build worksheet and set column widths
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const cols = [{ wch: 24 }, { wch: 22 }];
  selectedIters.forEach(() => {
    cols.push({ wch: 12 }, { wch: 14 });
  });
  cols.push({ wch: 4 }, { wch: 24 });
  ws['!cols'] = cols;

  return ws;
}

/**
 * Group story point data by project (productLine from board data).
 * For totals data without productLine, group under '(总计表)'.
 * Each group contains rows per team with story/est by iteration.
 */
function groupStoryData(state, selectedIters) {
  const selectedSet = {};
  selectedIters.forEach(n => { selectedSet[n.trim().toLowerCase()] = n; });

  // Normalize iteration name for matching
  function normIter(s) {
    return String(s || '').trim().toLowerCase();
  }

  // Accumulate: { project -> { team -> { iter -> { story, est } } } }
  const map = {};

  // Process board data (has productLine)
  (state.board || []).forEach(row => {
    const iterKey = normIter(row.iteration);
    const iterName = selectedSet[iterKey];
    if (!iterName) return; // skip unselected iterations

    const project = (row.productLine || '').trim() || '(未分类)';
    const team = (row.team || '').trim();
    if (!team) return;

    if (!map[project]) map[project] = {};
    if (!map[project][team]) map[project][team] = {};
    if (!map[project][team][iterName]) map[project][team][iterName] = { story: 0, est: 0 };

    map[project][team][iterName].story += Number(row.story) || 0;
    map[project][team][iterName].est += Number(row.est) || 0;
  });

  // Convert map to sorted array of groups
  const projects = Object.keys(map).sort((a, b) => {
    // Known product lines first, then others
    const ai = PRODUCT_LINES.indexOf(a);
    const bi = PRODUCT_LINES.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b, 'zh');
  });

  return projects.map(project => {
    const teamMap = map[project];
    const teams = Object.keys(teamMap).sort((a, b) => a.localeCompare(b, 'zh'));
    const rows = teams.map(team => {
      const iterData = teamMap[team];
      const storyByIter = {};
      const estByIter = {};
      selectedIters.forEach(iter => {
        const d = iterData[iter] || { story: 0, est: 0 };
        storyByIter[iter] = d.story;
        estByIter[iter] = d.est;
      });
      return { team, storyByIter, estByIter };
    });
    return { project, rows };
  });
}


/* ═══════════════════════════════════════════════════════════════
   Main Entry: buildWorkbook
   ═══════════════════════════════════════════════════════════════ */

/**
 * 构建与原始 Excel 格式一致的 3-Sheet 工作簿
 * @param {object} state         - 完整 state 对象
 * @param {object} computeResult - calc.compute(state) 的返回值
 * @returns {object}             - XLSX Workbook 对象 (3 Sheets)
 */
function buildWorkbook(state, computeResult) {
  const wb = XLSX.utils.book_new();
  const cycle = (state.cycles || []).find(c => c.active) || (state.cycles || [])[0];
  const monthLabel = deriveMonthLabel(cycle);

  // Sheet 1: {月份}产能数据
  XLSX.utils.book_append_sheet(wb, buildCapacitySheet(state, computeResult), `${monthLabel}产能数据`);

  // Sheet 2: 规划与产能分析
  XLSX.utils.book_append_sheet(wb, buildPlanningSheet(state, computeResult), '规划与产能分析');

  // Sheet 3: 人力工时数据
  XLSX.utils.book_append_sheet(wb, buildStoryPointSheet(state), '人力工时数据');

  return wb;
}


module.exports = { buildWorkbook, buildCapacitySheet, buildPlanningSheet, buildStoryPointSheet };
