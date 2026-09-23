/* modules/skill/skills/stakeholder.js — Skill 10：干系人分析器（纯函数）
   输入：迭代规划表（产品线×团队）+ 平台核算偏差 + headcount 团队负责人。
   输出：干系人登记册（产品线/团队/版本 群体级）+ 关键干系人 TOP + 联系缺口提示。
   诚实声明：当前无任务级 owner/干系人登记数据，识别粒度=群体+团队负责人；
   个人级干系人（项目经理/产品负责人）待通讯录/任务数据接入后补充。 */

'use strict';

const RULES = {
  highPerHeadWorkload: 15,  // 人均人日 > 15 → 影响面大的团队（关注升级）
  topN: 5,                  // 关键干系人 TOP N
  keyLineRows: 20           // 规划行 ≥ 20 的产品线 → 高影响
};

function parseOwner(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const m = s.match(/^([^-]+)-\d{4}[-/.]/);
  return (m ? m[1] : s.split(/\s+/)[0]).trim();
}

/**
 * 干系人分析主函数。
 * @param {object} input
 *   plan: { cycles, board: [{line,team,est}], headcount: {team:{owner}} }
 *   deviations: [{team, workload, head, verdict}]
 * @returns {{name, desc, register, key, markdown, items}}
 */
function analyze(input) {
  const plan = input.plan || {};
  const board = plan.board || [];
  const cycles = plan.cycles || [];
  const active = cycles.find(c => c.active) || cycles[cycles.length - 1] || {};
  const headcount = plan.headcount || {};

  /* 产品线干系人（影响面 = 规划行） */
  const lineAgg = {};
  const boardTeams = new Set();
  for (const b of board) {
    const k = b.line || '（未填写所属项目）';
    const l = lineAgg[k] = lineAgg[k] || { name: k, rows: 0, est: 0, teams: {} };
    l.rows += 1;
    l.est += b.est || 0;
    if (b.team) {
      l.teams[b.team] = 1;
      boardTeams.add(b.team);
    }
  }
  const lines = Object.keys(lineAgg)
    .map(k => lineAgg[k])
    .sort((a, b) => b.rows - a.rows);

  /* 团队干系人：关注度 = 偏差判定 × 人均负载 */
  const devMap = {};
  for (const d of input.deviations || []) devMap[d.team] = d;
  const teams = [];
  for (const t of boardTeams) {
    const d = devMap[t] || {};
    const hc = headcount[t] || {};
    const owner = parseOwner(hc.owner);
    const workload = Math.round(d.workload || 0);
    const head = Number(d.head) || 0;
    const perHead = head > 0 ? workload / head : null;
    let attention = '低';
    if (d.verdict === '产能不足' || d.verdict === '缺人头数') attention = '高';
    else if (perHead !== null && perHead > RULES.highPerHeadWorkload) attention = '中';
    teams.push({
      name: t, type: '团队', owner, head, workload,
      perHead: perHead == null ? null : Math.round(perHead * 10) / 10,
      verdict: d.verdict || '', attention
    });
  }
  teams.sort((a, b) =>
    (b.attention === '高' ? 1 : 0) - (a.attention === '高' ? 1 : 0) || b.workload - a.workload);

  const keyTeams = teams.filter(t => t.attention === '高');
  const keyLines = lines.filter(l => l.rows >= RULES.keyLineRows);
  const missingOwner = teams.filter(t => !t.owner);

  /* 登记册（群体级） */
  const register = [
    ...lines.map(l => ({
      name: l.name, type: '产品线', owner: '',
      impact: `${l.rows} 行 / ${Object.keys(l.teams).length} 个团队`,
      attention: l.rows >= RULES.keyLineRows ? '高' : '中'
    })),
    ...teams.map(t => ({
      name: t.name, type: '团队', owner: t.owner || '（未登记）',
      impact: `${t.workload} 人日 / ${t.head} 人${t.perHead != null ? `（人均 ${t.perHead} 人日）` : ''}`,
      attention: t.attention
    })),
    {
      name: active.name || '（未命名迭代）', type: '版本', owner: '',
      impact: `封版 ${active.seal || '—'} / 上线 ${active.online || '—'}`,
      attention: keyTeams.length ? '高' : '低'
    }
  ];

  const md = [
    '# 干系人登记册（群体级）',
    '',
    `覆盖 ${lines.length} 条产品线、${teams.length} 个团队${active.name ? `、版本「${active.name}」` : ''}。`,
    `关注度判定：产能不足/缺人头=高；人均人日 > ${RULES.highPerHeadWorkload}=中；其余=低。`,
    '',
    '## 一、关键干系人（高关注）',
    ...(keyTeams.length
      ? keyTeams.slice(0, RULES.topN).map(t => `- **${t.name}**（团队）：${t.verdict}，${t.workload} 人日 / ${t.head} 人${t.owner ? `，负责人 ${t.owner}` : '，负责人未登记'}`)
      : ['- 当前无高关注团队（产能判定正常）']),
    '',
    '## 二、产品线',
    ...lines.slice(0, 10).map(l => `- **${l.name}**：${l.rows} 行 / ${Object.keys(l.teams).length} 个团队（影响 ${l.rows >= RULES.keyLineRows ? '高' : '中'}）`),
    ...(lines.length > 10 ? [`- …共 ${lines.length} 条产品线`] : []),
    '',
    '## 三、团队与负责人',
    ...teams.slice(0, 18).map(t => `- ${t.name}：${t.workload} 人日 / ${t.head} 人${t.owner ? `｜负责人 ${t.owner}` : '｜⚠ 负责人未登记'}（关注 ${t.attention}）`),
    ...(teams.length > 18 ? [`- …共 ${teams.length} 个团队`] : []),
    '',
    '## 四、联系缺口',
    ...(missingOwner.length
      ? missingOwner.slice(0, 10).map(t => `- ${t.name}：无负责人`)
      : ['- 无（参与规划的团队均已登记负责人）']),
    '',
    '> 粒度说明：当前登记册为产品线/团队/版本群体级；个人级干系人（项目经理、产品负责人）待通讯录数据接入后补充。'
  ].join('\n');

  const items = [];
  for (const t of keyTeams.slice(0, RULES.topN)) {
    items.push({
      id: 'stk-key-' + t.name, severity: '高', category: '干系人',
      title: `关键干系人「${t.name}」${t.verdict}（${t.workload} 人日 / ${t.head} 人）`,
      evidence: t.owner ? `负责人：${t.owner}` : '负责人未登记',
      suggestion: '干系人沟通计划优先覆盖该团队：资源缺口、进度同步频率',
      confidence: 0.75
    });
  }
  if (missingOwner.length) {
    items.push({
      id: 'stk-owner-gap', severity: '中', category: '干系人',
      title: `${missingOwner.length} 个团队未登记负责人`,
      evidence: missingOwner.slice(0, 8).map(t => t.name).join('、'),
      suggestion: '在迭代管理页补全团队负责人，干系人登记册才能落到个人',
      confidence: 0.9
    });
  }

  return {
    name: '干系人分析器',
    desc: '从规划表与团队负责人数据生成干系人登记册（群体级）+ 关键干系人 + 联系缺口',
    register,
    key: { teams: keyTeams, lines: keyLines, missingOwner },
    markdown: md,
    items
  };
}

module.exports = { name: '干系人分析器', desc: '从规划表与团队负责人数据生成干系人登记册', analyze };