/* modules/skill/skills/variance.js — Skill 3：偏差分析器（纯函数）
   master §7 Skill 3：每日/迭代末 → 偏差表 + 趋势 + 归因 + 建议动作。
   M2-B B3：偏差基于迭代工时核算（calc.compute），PR 只做佐证（可信度），
   不硬算完成度（决策 2）。每条建议 = 待确认项。 */

'use strict';

const TOP_N = 3;

/**
 * 偏差分析主函数。
 * @param {object} input
 *   deviations:  calc.compute 的 deviation 数组（[{team, workload, head, capacity, over, ratio, verdict, workloadOverridden}]）
 *   reconcile:   [{team, totals, board, diff}]（总计表 vs 看板对账）
 *   history:     [{at, deviations}] 历史快照（可空，最多取 3 期算趋势）
 *   evidence:    {repoByTeam: {team: {l1: n, l2: n}}}（PR 佐证：团队关联仓库的 L1/L2 提交数）
 * @returns {{table: Array, trend: Array, attribution: Array, suggestions: Array}}
 */
function analyze(input) {
  const devs = input.deviations || [];
  const configured = !!input.evidenceConfigured; // 仓库→团队映射是否已配置（config.json repos[].teams）
  const table = devs.map(d => ({
    team: d.team, workload: round1(d.workload), head: round1(d.head),
    capacity: round1(d.capacity), over: round1(d.over),
    ratio: Math.round(d.ratio * 1000) / 10, verdict: d.verdict,
    evidence: evidenceOf(input.evidence, d.team, configured)
  }));

  /* 趋势：最近 3 期偏差（含本期），每期取"偏差团队数"与"最大正偏差" */
  const trend = ((input.history || []).slice(-2).map(h => ({
    at: String(h.at || '').slice(0, 10),
    overTeams: (h.deviations || []).filter(d => d.verdict === '产能不足' || d.verdict === '缺人头数').length,
    maxRatio: maxRatioOf(h.deviations)
  }))).concat([{
    at: '本期', overTeams: devs.filter(d => d.verdict === '产能不足' || d.verdict === '缺人头数').length,
    maxRatio: maxRatioOf(devs)
  }]);

  /* 归因：按 |over| 排序取 TOP3 + 缺人头团队 */
  const byOver = devs.slice().sort((a, b) => Math.abs(b.over) - Math.abs(a.over));
  const attribution = {
    topOver: byOver.slice(0, TOP_N).map(d => ({
      team: d.team, over: round1(d.over), ratio: Math.round(d.ratio * 1000) / 10, verdict: d.verdict
    })),
    noHead: devs.filter(d => d.verdict === '缺人头数').map(d => d.team),
    reconcile: (input.reconcile || []).map(r => ({ team: r.team, diff: round1(r.diff) }))
  };

  /* 建议动作（每条 = 待确认项） */
  const suggestions = [];
  for (const d of devs) {
    if (d.verdict === '产能不足' && d.ratio > 0.1) {
      suggestions.push({
        id: 'var-' + d.team + '-cap',
        title: `复核「${d.team}」工作量与排期`,
        detail: `偏差 ${Math.round(d.ratio * 1000) / 10}%，超 ${round1(d.over)} 人天` + (d.workloadOverridden ? '（工作量已被人工覆盖，复核覆盖值）' : ''),
        action: '复核或调整'
      });
    } else if (d.verdict === '缺人头数') {
      suggestions.push({
        id: 'var-' + d.team + '-head',
        title: `补充「${d.team}」人头数登记`,
        detail: `有 ${round1(d.workload)} 人天工作量但无产能`,
        action: '补登记'
      });
    } else if (d.verdict === '产能富余') {
      suggestions.push({
        id: 'var-' + d.team + '-free',
        title: `「${d.team}」产能富余，考虑支援或提前排期`,
        detail: `富余 ${round1(-d.over)} 人天`,
        action: '调配'
      });
    }
  }
  for (const r of input.reconcile || []) {
    suggestions.push({
      id: 'var-rec-' + r.team,
      title: `「${r.team}」总计表与看板差 ${round1(r.diff)} 人天`,
      detail: '来源：每日对账，差异超容差',
      action: '核对'
    });
  }
  // 佐证缺失提示（仅当映射已配置才有意义；未配置时不产生噪音建议）
  const noEvidence = configured ? devs.filter(d => d.verdict !== '正常' && !hasEvidence(input.evidence, d.team)) : [];
  if (noEvidence.length) {
    suggestions.push({
      id: 'var-evidence',
      title: `${noEvidence.length} 个偏差团队缺 PR 佐证`,
      detail: noEvidence.map(d => d.team).join('、') + '：有偏差但关联仓库无 L1/L2 提交，无法交叉验证',
      action: '补充佐证'
    });
  }

  return { table, trend, attribution, suggestions };
}

function hasEvidence(evidence, team) {
  const e = (evidence || {})[team];
  return !!(e && ((e.l1 || 0) + (e.l2 || 0) > 0));
}
function evidenceOf(evidence, team, configured) {
  if (!configured) return '—';
  return hasEvidence(evidence, team) ? `有佐证（L1/L2 提交 ${((evidence || {})[team].l1 || 0) + ((evidence || {})[team].l2 || 0)} 条）` : '无佐证';
}
function maxRatioOf(devs) {
  const bad = (devs || []).filter(d => d.ratio > 0).map(d => d.ratio);
  return bad.length ? Math.round(Math.max.apply(null, bad) * 1000) / 10 : 0;
}
function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

module.exports = { id: 'variance', name: '偏差分析器', desc: '迭代工时偏差 + 趋势 + 归因 + 建议（PR 佐证可信度）', analyze };