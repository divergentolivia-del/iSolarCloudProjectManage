/* modules/skill/skills/charter.js — Skill 9：项目章程生成器（纯函数）
   输入：当前迭代 cycles + 迭代规划表（产品线×团队）+ 平台核算偏差 + 团队人头/负责人。
   输出：章程草稿（概述/目标/范围/里程碑/资源/风险/干系人/验收口径）+ 待确认项。
   诚实声明：当前数据只有「产品线×团队」粒度，无任务级目标/验收条目——
   章程是管理口径草稿（供结构确认），不是可签批的正式文档；目标来自产品线规划行分布。 */

'use strict';

const RULES = {
  sealRiskDays: 14,   // 封版前 ≤14 天 → 里程碑风险升级
  minRowsPerLine: 1   // 规划行 < 1 的产品线 → 提示项
};

function parseOwner(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  /* "王亚-2026-08-17 14:24" → 王亚；"方德财" → 方德财 */
  const m = s.match(/^([^-]+)-\d{4}[-/.]/);
  return (m ? m[1] : s.split(/\s+/)[0]).trim();
}

/**
 * 项目章程生成主函数。
 * @param {object} input
 *   plan: { productLines, cycles: [{name,seal,online,active}], board: [{line,team,est}], headcount: {team:{owner}} }
 *   deviations: [{team, workload, head, verdict}]
 *   now: 时间戳（可空）
 * @returns {{name, desc, charter, markdown, items}}
 */
function generate(input) {
  const plan = input.plan || {};
  const board = plan.board || [];
  const cycles = plan.cycles || [];
  const active = cycles.find(c => c.active) || cycles[cycles.length - 1] || {};
  const headcount = plan.headcount || {};
  const now = input.now || Date.now();

  /* 范围：产品线 × 规划行 */
  const lineAgg = {};
  for (const b of board) {
    const k = b.line || '（未填写所属项目）';
    const l = lineAgg[k] = lineAgg[k] || { line: k, rows: 0, est: 0, teams: {} };
    l.rows += 1;
    l.est += b.est || 0;
    if (b.team) l.teams[b.team] = 1;
  }
  const lines = Object.keys(lineAgg)
    .map(k => lineAgg[k])
    .sort((a, b) => b.rows - a.rows);

  /* 资源：团队工作量/人头/负责人/判定 */
  const teams = (input.deviations || [])
    .map(d => ({
      team: d.team,
      workload: Math.round(d.workload || 0),
      head: Number(d.head) || 0,
      verdict: d.verdict || '',
      owner: parseOwner(headcount[d.team] && headcount[d.team].owner)
    }))
    .sort((a, b) => b.workload - a.workload);
  const totalWorkload = teams.reduce((a, t) => a + t.workload, 0);
  const totalHead = teams.reduce((a, t) => a + t.head, 0);

  /* 里程碑 + 封版临近判定（seal 形如 "10.26"，按当年解析） */
  function parseSeal(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{1,2})\.(\d{1,2})$/);
    if (!m) return null;
    return new Date(new Date().getFullYear(), Number(m[1]) - 1, Number(m[2]));
  }
  const sealDate = parseSeal(active.seal);
  const daysToSeal = sealDate ? Math.ceil((sealDate.getTime() - now) / 86400000) : null;
  const sealRisk = daysToSeal !== null && daysToSeal <= RULES.sealRiskDays;

  /* 风险：产能不足/缺人头的团队（章程视角汇总，不逐条重复 risk skill） */
  const weakTeams = teams.filter(t => t.verdict === '产能不足' || t.verdict === '缺人头数');
  const emptyLines = lines.filter(l => l.rows < RULES.minRowsPerLine);

  const milestones = cycles.map(c => ({
    name: c.name, seal: c.seal, online: c.online, active: !!c.active
  }));

  const md = [
    `# ${active.name || '（未命名迭代）'} 项目章程（草稿）`,
    '',
    `> 生成：${new Date(now).toISOString().slice(0, 10)} ｜ 口径：迭代规划表 + 平台核算（产品线×团队粒度）`,
    '',
    '## 一、项目概述',
    `版本 ${active.name || '—'}，共 ${lines.length} 条产品线、${teams.length} 个团队、${board.length} 行规划。`,
    `封版 ${active.seal || '—'}${daysToSeal !== null ? `（距今 ${daysToSeal} 天）` : ''}，上线 ${active.online || '—'}。`,
    '',
    '## 二、目标与范围',
    ...lines.map(l => `- **${l.line}**：${l.rows} 行${l.est ? `，est ${l.est} 人日` : ''}，涉及 ${Object.keys(l.teams).length} 个团队`),
    ...(lines.length === 0 ? ['- （规划表暂无产品线行，范围待补充）'] : []),
    '',
    '## 三、里程碑',
    ...milestones.map(m => `- ${m.name}${m.active ? '（当前）' : ''}：封版 ${m.seal || '—'}，上线 ${m.online || '—'}`),
    ...(milestones.length === 0 ? ['- （未配置迭代周期）'] : []),
    '',
    '## 四、资源',
    `总工作量 ${totalWorkload} 人日 / 人头 ${totalHead} 人。`,
    ...teams.slice(0, 12).map(t => `- ${t.team}：${t.workload} 人日 / ${t.head} 人${t.owner ? `（负责人 ${t.owner}）` : ''}${t.verdict ? `（${t.verdict}）` : ''}`),
    ...(teams.length > 12 ? [`- …共 ${teams.length} 个团队，其余见平台核算`] : []),
    '',
    '## 五、风险（启动基线）',
    ...(weakTeams.length
      ? weakTeams.slice(0, 10).map(t => `- **${t.team}**：${t.verdict}（${t.workload} 人日 / ${t.head} 人）`)
      : ['- 当前无产能不足团队（以平台核算判定为准）']),
    ...(sealRisk ? [`- **里程碑**：距封版 ${daysToSeal} 天，存在产能不足团队，需关注收敛计划`] : []),
    '',
    '## 六、干系人（群体级）',
    ...lines.slice(0, 8).map(l => `- 产品线「${l.line}」：${Object.keys(l.teams).length} 个团队参与`),
    '> 干系人登记册见「干系人分析器」；负责人缺失项会在该 Skill 中提示。',
    '',
    '## 七、验收口径',
    '本版本以迭代规划表为准：产品线完成度 = 规划行落实；团队产能 = 平台核算偏差；',
    '周报与偏差分析器提供过程跟踪，WBS 提供结构基线。'
  ].join('\n');

  const items = [{
    id: 'charter-draft', severity: '低', category: '章程',
    title: `章程草稿已按当前口径生成（${active.name || '未命名'}：${lines.length} 条产品线 / ${teams.length} 个团队 / ${totalWorkload} 人日）`,
    evidence: '目标=产品线规划行分布；资源=平台核算；里程碑=迭代配置',
    suggestion: '确认章程结构与实际管理口径一致；任务级目标/验收条目待任务数据接入后补充',
    confidence: 0.7
  }];
  if (weakTeams.length) {
    items.push({
      id: 'charter-risk-capacity', severity: sealRisk ? '高' : '中', category: '章程',
      title: `启动基线存在 ${weakTeams.length} 个产能不足/缺人头团队${sealRisk ? `，且距封版仅 ${daysToSeal} 天` : ''}`,
      evidence: weakTeams.slice(0, 6).map(t => `${t.team}（${t.verdict}）`).join('、'),
      suggestion: '章程评审时优先对齐这些团队的资源缺口与收敛计划',
      confidence: 0.8
    });
  }
  for (const l of emptyLines) {
    items.push({
      id: 'charter-empty-' + l.line, severity: '中', category: '章程',
      title: `产品线「${l.line}」本期无规划行`,
      evidence: '迭代规划表（board）中未找到该产品线的行',
      suggestion: '确认该产品线本期是否纳入版本范围；若纳入需补规划行',
      confidence: 0.7
    });
  }

  return {
    name: '项目章程生成器',
    desc: '从迭代规划表生成项目章程草稿（概述/范围/里程碑/资源/风险/干系人/验收口径）',
    charter: {
      name: active.name || '',
      lines: lines.length,
      teams: teams.length,
      rows: board.length,
      totalWorkload,
      totalHead,
      daysToSeal
    },
    markdown: md,
    items
  };
}

module.exports = { name: '项目章程生成器', desc: '从迭代规划表生成项目章程草稿', generate };