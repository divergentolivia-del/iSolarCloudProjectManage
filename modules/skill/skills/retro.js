/* modules/skill/skills/retro.js — Skill 12：复盘提取器（纯函数）
   输入：当前偏差 + 最近 2 期历史快照（趋势）+ 平台核算 + Skill 采纳率统计。
   输出：复盘草稿（目标 vs 实际 / 偏差 TOP / 环比趋势 / 经验教训）+ 待确认项。
   诚实声明：当前无任务级完成情况数据，「实际」= 平台核算工作量 vs 人头产能口径；
   经验教训来自 Skill 采纳率统计（数据可查），不编造定性结论。 */

'use strict';

const RULES = {
  topN: 5,              // 偏差 TOP N
  worseningEps: 0.05    // 环比 ratio 上升 > 5% 视为恶化
};

/**
 * 复盘提取主函数。
 * @param {object} input
 *   plan: { cycles, board, headcount }
 *   deviations: [{team, workload, head, capacity, over, ratio, verdict}]
 *   history: [{at, name, deviation:[{team, ratio, verdict, ...}]}]
 *   knowledge: { stats: {skillId: {runCount, adoptCount, rejectCount}} }
 * @returns {{name, desc, retro, markdown, items}}
 */
function extract(input) {
  const plan = (input && input.plan) || {};
  const cycles = plan.cycles || [];
  const active = cycles.find(c => c.active) || cycles[cycles.length - 1] || {};
  const devs = (input && input.deviations) || [];
  const history = (input && input.history) || [];
  const stats = ((input && input.knowledge) || {}).stats || {};

  /* 目标 vs 实际（核算口径） */
  const totals = {
    workload: Math.round(devs.reduce((a, d) => a + (d.workload || 0), 0)),
    head: Math.round(devs.reduce((a, d) => a + (Number(d.head) || 0), 0) * 10) / 10,
    capacity: Math.round(devs.reduce((a, d) => a + (d.capacity || 0), 0) * 10) / 10
  };
  const totalRatio = totals.capacity > 0 ? Math.round(totals.workload / totals.capacity * 100) / 100 : null;

  /* 偏差 TOP：产能不足/缺人头的团队，按超产幅度 ratio（=超/产能）降序 */
  const top = devs
    .filter(d => d.verdict === '产能不足' || d.verdict === '缺人头数')
    .sort((a, b) => (b.ratio || 0) - (a.ratio || 0))
    .slice(0, RULES.topN)
    .map(d => ({ team: d.team, verdict: d.verdict, over: Math.round(d.over || 0), ratio: d.ratio, head: Number(d.head) || 0 }));

  /* 环比趋势：上一期 ratio vs 当前 ratio（history 最后一条 = 上一期） */
  const prev = history.length ? history[history.length - 1] : null;
  const trend = [];
  if (prev && Array.isArray(prev.deviation)) {
    const prevMap = {};
    for (const d of prev.deviation) prevMap[d.team] = d;
    for (const d of devs) {
      const p = prevMap[d.team];
      if (!p) { trend.push({ team: d.team, direction: '新增', prev: null, now: d.ratio }); continue; }
      const diff = (d.ratio || 0) - (p.ratio || 0);
      const direction = diff > RULES.worseningEps ? '恶化' : (diff < -RULES.worseningEps ? '改善' : '持平');
      trend.push({ team: d.team, direction, prev: p.ratio, now: d.ratio });
    }
  }
  const worsening = trend.filter(t => t.direction === '恶化');
  const improving = trend.filter(t => t.direction === '改善');

  /* 经验教训：来自 Skill 采纳率（数据可查，不编造） */
  const skillStats = Object.keys(stats).map(id => {
    const s = stats[id] || {};
    const confirmed = (s.adoptCount || 0) + (s.rejectCount || 0);
    return {
      id,
      runCount: s.runCount || 0,
      adoptCount: s.adoptCount || 0,
      rejectCount: s.rejectCount || 0,
      adoptRate: confirmed > 0 ? Math.round((s.adoptCount || 0) / confirmed * 100) : null
    };
  }).filter(s => s.runCount > 0);
  const best = skillStats.slice().sort((a, b) => (b.adoptRate ?? -1) - (a.adoptRate ?? -1))[0];
  const worst = skillStats.filter(s => s.adoptRate !== null).sort((a, b) => a.adoptRate - b.adoptRate)[0];

  const md = [
    `# ${active.name || '（当前迭代）'} 复盘（草稿）`,
    '',
    '> 口径：目标=迭代规划表；实际=平台核算（工作量 vs 人头产能）；经验=Skill 采纳率统计。',
    '',
    '## 一、目标 vs 实际',
    `总工作量 ${totals.workload} 人日 / 人头 ${totals.head} / 产能 ${totals.capacity}，整体负载 ${totalRatio != null ? (totalRatio * 100) + '%' : '—'}。`,
    `产能缺口团队 ${top.length} 个（TOP ${Math.min(top.length, RULES.topN)}，ratio=超产能幅度）：`,
    ...top.map(t => `- ${t.team}（${t.verdict}）：超 ${t.over} 人日（超产能 ${Math.round((t.ratio || 0) * 100)}%，${t.head} 人）`),
    ...(top.length === 0 ? ['- 当前无超产能团队'] : []),
    '',
    '## 二、环比趋势',
    ...(prev
      ? [
          `对比 ${prev.name || '上一期'}：恶化 ${worsening.length} 队 / 改善 ${improving.length} 队 / 持平 ${trend.length - worsening.length - improving.length} 队。`,
          ...worsening.slice(0, 5).map(t => `- ⚠ ${t.team}：${t.prev} → ${t.now}（恶化）`),
          ...improving.slice(0, 5).map(t => `- ✓ ${t.team}：${t.prev} → ${t.now}（改善）`)
        ]
      : ['- （无上一期历史快照，趋势待数据积累后生成）']),
    '',
    '## 三、经验教训（来自 Skill 采纳率）',
    ...(best
      ? [`采纳最好的能力：${best.id}（采纳率 ${best.adoptRate}%，运行 ${best.runCount} 次）——这类建议确实被用起来。`]
      : []),
    ...(worst && worst.id !== bestId(best) && worst.adoptRate !== null
      ? [`采纳最低的能力：${worst.id}（采纳率 ${worst.adoptRate}%）——建议质量或触达方式需要改进。`]
      : []),
    ...(skillStats.length === 0 ? ['- （暂无 Skill 运行统计）'] : []),
    '',
    '## 四、下期动作建议',
    ...(worsening.length ? worsening.slice(0, 3).map(t => `- 对齐「${t.team}」的产能缺口（${t.now} 倍负载），确认加人/砍范围/延期`) : []),
    ...(top.length && !worsening.length ? '- 偏差 TOP 团队维持关注，封版前复核一次' : []),
    ...(improving.length ? `- 复盘「${improving[0].team}」改善做法（${improving[0].prev} → ${improving[0].now}），可复制经验` : []),
    '',
    '> 说明：任务级完成度数据接入后，本节将升级为「目标 vs 完成」口径。'
  ].join('\n');

  function bestId(b) { return b ? b.id : ''; }

  const items = [];
  if (worsening.length) {
    items.push({
      id: 'retro-worsening', severity: '高', category: '复盘',
      title: `${worsening.length} 个团队负载环比恶化`,
      evidence: worsening.slice(0, 5).map(t => `${t.team}（${t.prev}→${t.now}）`).join('、'),
      suggestion: '复盘会上优先对齐这些团队的缺口与调整方案',
      confidence: 0.8
    });
  }
  if (top.length) {
    items.push({
      id: 'retro-top', severity: '中', category: '复盘',
      title: `产能缺口团队 ${top.length} 个（${top[0].team} 超 ${top[0].over} 人日）`,
      evidence: top.slice(0, 5).map(t => `${t.team}（${t.verdict}）超${t.over}人日`).join('、'),
      suggestion: '复盘会确认加人/砍范围/延期中的一项',
      confidence: 0.8
    });
  }
  items.push({
    id: 'retro-draft', severity: '低', category: '复盘',
    title: `复盘草稿已生成（${active.name || '当前迭代'}：${totals.workload} 人日 / ${totals.head} 人，环比${prev ? `恶化${worsening.length}/改善${improving.length}` : '无基线'}）`,
    evidence: '目标=规划表；实际=平台核算；经验=采纳率统计',
    suggestion: '复盘会前过一遍草稿，把定性结论补进「经验教训」节',
    confidence: 0.7
  });

  return {
    name: '复盘提取器',
    desc: '从历史快照+偏差+采纳率生成迭代复盘草稿（目标vs实际/趋势/经验/动作）',
    retro: {
      period: active.name || '',
      totals,
      top,
      trendCount: trend.length,
      worsening: worsening.length,
      improving: improving.length,
      bestSkill: best ? best.id : null
    },
    markdown: md,
    items
  };
}

module.exports = { name: '复盘提取器', desc: '从历史快照+偏差+采纳率生成迭代复盘草稿', extract };