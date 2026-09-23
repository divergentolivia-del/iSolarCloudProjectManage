/* modules/skill/skills/wbs.js — Skill 7：WBS 生成器（纯函数）
   master §7 Skill 6：项目启动/迭代规划时 → 从迭代规划表生成 WBS 大纲。
   数据源：plan 块（board 规划行，按「所属项目(层级1)」聚合）+ deviations（团队工作量/人头）。
   诚实声明：共享团队会同时服务多条产品线（实测 17 队中 10 队跨线），
   WBS 不强行拆成树——产品线看「规划行分布」，团队看「平台核算工作量」，两个视图并列。
   任务级 WBS 需要任务清单数据（当前规划表只到 产品线×团队 粒度），note 里写明。 */

'use strict';

/** 规则常量（可调） */
const RULES = {
  minRowsForLine: 1   // 产品线规划行 < 1 → 提示项
};

/**
 * WBS 生成主函数。
 * @param {object} input
 *   plan: { productLines, otherCategories, cycles: [{name,seal,online,active}], board: [{line,team,est}] }
 *   deviations: [{team, workload, head, capacity, verdict}]
 * @returns {{outline, milestones, markdown, note, items}}
 */
function generate(input) {
  const plan = input.plan || {};
  const board = plan.board || [];
  const cycles = plan.cycles || [];
  const active = cycles.find(c => c.active) || cycles[cycles.length - 1] || {};
  const devMap = {};
  for (const d of input.deviations || []) devMap[d.team] = d;

  /* 产品线视图：规划行分布（行数 + est）+ 涉及团队 */
  const lineAgg = {};
  for (const b of board) {
    const k = b.line || '（未填写所属项目）';
    const l = lineAgg[k] = lineAgg[k] || { line: k, rows: 0, est: 0, teams: {} };
    l.rows += 1;
    l.est += b.est || 0;
    if (b.team) l.teams[b.team] = (l.teams[b.team] || 0) + 1;
  }
  const knownLines = (plan.productLines || []).concat(plan.otherCategories || []);
  const lines = knownLines.filter(n => lineAgg[n]).map(n => lineAgg[n]);
  for (const k of Object.keys(lineAgg)) if (!knownLines.includes(k)) lines.push(lineAgg[k]);
  lines.sort((a, b) => b.rows - a.rows);

  /* 团队视图：平台核算工作量 + 人头 */
  const teams = (input.deviations || [])
    .map(d => ({ team: d.team, workload: Math.round(d.workload || 0), head: Number(d.head) || 0, capacity: Math.round(d.capacity || 0) }))
    .sort((a, b) => b.workload - a.workload);

  const totalWorkload = teams.reduce((a, t) => a + t.workload, 0);
  const milestones = cycles.map(c => ({ name: c.name, seal: c.seal, online: c.online, active: !!c.active }));

  /* 大纲（层级结构，供前端渲染） */
  const outline = [
    { level: 1, name: (active.name || '当前迭代') + '（WBS 大纲）', workload: totalWorkload },
    ...lines.map(l => ({
      level: 2, name: l.line, rows: l.rows, est: Math.round(l.est * 10) / 10,
      teams: Object.keys(l.teams).sort()
    })),
    { level: 2, name: '── 团队工作量（平台核算，含共享团队）──', workload: totalWorkload },
    ...teams.map(t => ({ level: 3, name: t.team, workload: t.workload, head: t.head }))
  ];

  const md = [
    `# ${active.name || '当前迭代'} WBS 大纲`,
    '',
    `总工作量 ${totalWorkload} 人日，覆盖 ${teams.length} 个团队、${lines.length} 条产品线。`,
    '',
    '## 一、产品线分布（按规划行）',
    ...lines.map(l => `- **${l.line}**：${l.rows} 行${l.est ? `，est ${l.est} 人日` : ''}（${l.teams && Object.keys(l.teams).slice(0, 6).join('、')}${Object.keys(l.teams || {}).length > 6 ? ' 等' : ''}）`),
    '',
    '## 二、团队工作量（平台核算）',
    ...teams.map(t => `- ${t.team}：${t.workload} 人日 / ${t.head} 人${t.capacity ? `（产能 ${t.capacity}）` : ''}`),
    '',
    '## 三、里程碑',
    ...milestones.map(m => `- ${m.name}${m.active ? '（当前）' : ''}：封版 ${m.seal || '—'}，上线 ${m.online || '—'}`)
  ].join('\n');

  const note = '粒度说明：WBS 大纲来自迭代规划表（产品线×团队）与平台核算工作量，未含任务级分解——规划表没有逐任务行数据；共享团队在多条产品线间复用，不重复计算工作量。';

  /* 待确认项：结构确认 + 空产品线提示 */
  const items = [{
    id: 'wbs-outline', severity: '低', category: 'WBS',
    title: `WBS 大纲已按当前规划生成（${lines.length} 条产品线 / ${teams.length} 个团队 / ${totalWorkload} 人日）`,
    evidence: '产品线分布与团队工作量见大纲；共享团队未重复计算',
    suggestion: '确认结构与实际管理口径一致；需要任务级 WBS 时补充规划表的逐任务行',
    confidence: 0.7
  }];
  for (const n of plan.productLines || []) {
    const l = lineAgg[n];
    if (!l || l.rows < RULES.minRowsForLine) {
      items.push({
        id: 'wbs-empty-' + n, severity: '中', category: 'WBS',
        title: `产品线「${n}」本期无规划行`,
        evidence: '迭代规划表（board）中未找到该产品线的行',
        suggestion: '确认该产品线本期是否暂停，或在规划表补录',
        confidence: 0.8
      });
    }
  }

  return { outline, milestones, markdown: md, note, items };
}

module.exports = {
  id: 'wbs',
  name: 'WBS 生成器',
  desc: '从迭代规划表生成 WBS 大纲（产品线分布 + 团队工作量 + 里程碑）',
  generate,
  RULES
};
