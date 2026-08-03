/* 纯计算层：输入 state，输出汇总与偏差结果，不触碰 DOM
   两个数据源：
     totals   —「阳光云迭代工作量统计」原始导出，团队 × 迭代，作为产能偏差的唯一权威口径
     board    —「月底版本项目人力看板」，产线 × 团队 × 迭代，仅用于产线维度分布
   两者按团队自动对账，差异超阈值时提示。 */

/* 团队名归一化。导出里写作「WEB开发-阳光云」，配置里是「Web开发-阳光云」，
   Excel 的 SUMIFS 不区分大小写才没暴露，这里必须显式归一，否则该列静默为 0 */
function normTeam(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
}
function normLine(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, '');
}

const TEAM_INDEX = (function () {
  const m = {};
  TEAMS.forEach(t => { m[normTeam(t.key)] = t; });
  return m;
})();

/* 非核算主体团队：静默忽略，不计入未识别告警 */
function isIgnoredTeam(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return true;
  return IGNORED_TEAM_PATTERNS.some(p => s.indexOf(p) >= 0);
}

/* 单条记录按团队口径取值 */
function pickValue(row, team) {
  return team.source === 'est' ? (Number(row.est) || 0) : (Number(row.story) || 0);
}

function emptyRow() {
  const o = {};
  TEAMS.forEach(t => { o[t.key] = 0; });
  return o;
}
function addRow(a, b) {
  const o = {};
  TEAMS.forEach(t => { o[t.key] = (a[t.key] || 0) + (b[t.key] || 0); });
  return o;
}
function rowTotal(r) {
  return TEAMS.reduce((s, t) => s + (r[t.key] || 0), 0);
}

/* 本期选中的迭代集合 */
function selectedIterations(state) {
  return (state.iterations || []).filter(i => i.selected).map(i => i.name);
}

/* 总计表 → 各团队本期工时（产能偏差的权威口径） */
function totalsByTeam(state) {
  const picked = {};
  selectedIterations(state).forEach(n => { picked[normLine(n)] = true; });
  const out = emptyRow();
  (state.totals || []).forEach(row => {
    if (!picked[normLine(row.iteration)]) return;
    const team = TEAM_INDEX[normTeam(row.team)];
    if (!team) return;
    out[team.key] += pickValue(row, team);
  });
  return out;
}

/* 看板 → { 分类 -> { 团队 -> 工时 } }（产线分布口径） */
function boardByLine(state) {
  const picked = {};
  selectedIterations(state).forEach(n => { picked[normLine(n)] = true; });
  const byLine = {};
  (state.board || []).forEach(row => {
    if (!picked[normLine(row.iteration)]) return;
    const team = TEAM_INDEX[normTeam(row.team)];
    if (!team) return;
    const line = normLine(row.productLine);
    if (!byLine[line]) byLine[line] = emptyRow();
    byLine[line][team.key] += pickValue(row, team);
  });
  return byLine;
}

function sumLines(byLine, names) {
  let out = emptyRow();
  (names || []).forEach(n => {
    const b = byLine[normLine(n)];
    if (b) out = addRow(out, b);
  });
  return out;
}

function activeCycle(state) {
  const list = state.cycles || [];
  return list.find(c => c.active) || list[0] || null;
}
function cycleDays(c) {
  if (!c) return 0;
  return (Number(c.workdays) || 0) + (Number(c.saturdays) || 0);
}

/* 各团队可投入迭代人数 = 正式 + 外包 */
function headcountTotals(state) {
  const out = {};
  TEAMS.forEach(t => {
    const h = (state.headcount || {})[t.key] || {};
    out[t.key] = (Number(h.regular) || 0) + (Number(h.outsource) || 0);
  });
  return out;
}

function lockedTotals(state) {
  const out = emptyRow();
  (state.locked || []).forEach(item => {
    LOCK_ROLES.forEach(role => {
      const k = LOCK_ROLE_TO_TEAM[role];
      if (k) out[k] += Number((item.roles || {})[role]) || 0;
    });
  });
  return out;
}

/* 主计算入口 */
function compute(state) {
  const authoritative = totalsByTeam(state);
  const byLine = boardByLine(state);

  // 产品线版本工作量汇总
  const lineRows = PRODUCT_LINES.map(n => ({ key: n, values: sumLines(byLine, [n]) }));
  const lineSummary = lineRows.reduce((a, r) => addRow(a, r.values), emptyRow());

  // 版本规划工作量汇总 = 产品线汇总 + 其他分类
  const planRows = [{ key: '产品线汇总', values: lineSummary }].concat(
    OTHER_CATEGORIES.map(c => ({ key: c.key, values: sumLines(byLine, c.match) }))
  );
  const planTotal = planRows.reduce((a, r) => addRow(a, r.values), emptyRow());

  // 产能与偏差：工作量取总计表口径
  const cycle = activeCycle(state);
  const days = cycleDays(cycle);
  const heads = headcountTotals(state);
  const locked = lockedTotals(state);

  const deviation = TEAMS.map(t => {
    const workload = authoritative[t.key] || 0;
    const head = heads[t.key] || 0;
    const capacity = head * days;
    const over = workload - capacity;
    const ratio = capacity ? over / capacity : 0;
    let verdict = '正常';
    if (capacity === 0 && workload > 0) verdict = '缺人头数';
    else if (ratio > DEVIATION_TOLERANCE) verdict = '产能不足';
    else if (ratio < -DEVIATION_TOLERANCE) verdict = '产能富余';
    return {
      team: t.key, dept: t.dept, workload: workload, head: head,
      lockedHead: locked[t.key] || 0, capacity: capacity,
      over: over, ratio: ratio, verdict: verdict
    };
  });

  // 总计表 vs 看板 逐团队对账
  const reconcile = TEAMS.map(t => {
    const a = authoritative[t.key] || 0;
    const b = planTotal[t.key] || 0;
    return { team: t.key, totals: a, board: b, diff: b - a };
  }).filter(r => Math.abs(r.diff) > RECONCILE_TOLERANCE);

  // 未识别团队（已排除非核算主体）
  const unknown = {};
  (state.totals || []).concat(state.board || []).forEach(r => {
    const n = String(r.team || '').trim();
    if (!n || TEAM_INDEX[normTeam(n)] || isIgnoredTeam(n)) return;
    unknown[n] = (unknown[n] || 0) + 1;
  });

  // 看板里出现但未归入任何分类的「所属项目(层级1)」
  const known = {};
  PRODUCT_LINES.forEach(n => { known[normLine(n)] = true; });
  OTHER_CATEGORIES.forEach(c => c.match.forEach(n => { known[normLine(n)] = true; }));
  const unmapped = Object.keys(byLine).filter(k => !known[k])
    .map(k => ({ name: k, value: rowTotal(byLine[k]) }));

  return {
    cycle: cycle, days: days, iterations: selectedIterations(state),
    lineRows: lineRows, lineSummary: lineSummary,
    planRows: planRows, planTotal: planTotal,
    authoritative: authoritative,
    heads: heads, locked: locked, deviation: deviation,
    reconcile: reconcile,
    totals: {
      workload: rowTotal(authoritative),
      boardWorkload: rowTotal(planTotal),
      capacity: deviation.reduce((s, d) => s + d.capacity, 0),
      head: TEAMS.reduce((s, t) => s + (heads[t.key] || 0), 0)
    },
    unknownTeams: Object.keys(unknown).map(k => ({ name: k, count: unknown[k] })),
    unmappedLines: unmapped
  };
}

if (typeof module !== 'undefined') {
  module.exports = { compute: compute, normTeam: normTeam, rowTotal: rowTotal };
}
