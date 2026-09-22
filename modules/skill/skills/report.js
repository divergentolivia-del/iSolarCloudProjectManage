/* modules/skill/skills/report.js — Skill 2：周报生成器（纯函数）
   master §6.3 周报 Prompt 模板：进展 / 风险 / 下周计划 / 需协调 四节式。
   M2-B B2：数据自动注入（迭代偏差 + 风险 + 仓库活跃度），脱敏（人员用角色/团队称呼），
   产出"改一改就能发"的草稿；发出去之前由人工确认（待确认项）。 */

'use strict';

const riskSkill = require('./risk');
const MS_DAY = 24 * 3600 * 1000;

/**
 * 周报生成主函数。
 * @param {object} input
 *   deviations: calc.compute 的 deviation 数组
 *   risks:      风险识别器 items（未解决）
 *   repos:      [{name, lastCommitAt}]
 *   plans:      [{title, due, status_category}]（可空）
 *   weekLabel:  '第 N 周'（默认取当前周）
 * @returns {{markdown: string, sections: {progress, risks, nextWeek, coordination}, pendingConfirm: Array}}
 */
function generate(input) {
  const devs = input.deviations || [];
  const risks = input.risks || [];
  const repos = input.repos || [];
  const plans = input.plans || [];
  const week = input.weekLabel || weekLabel(input.now || Date.now());

  /* 进展：人力投入 + 偏差概览 */
  const totalHead = devs.reduce((a, d) => a + (Number(d.head) || 0), 0);
  const totalWork = devs.reduce((a, d) => a + (Number(d.workload) || 0), 0);
  const nBad = devs.filter(d => d.verdict === '产能不足').length;
  const nNoHead = devs.filter(d => d.verdict === '缺人头数').length;
  const progressLines = [
    `本周投入人力 ${round1(totalHead)} 人天，登记工作量 ${round1(totalWork)} 人天。`,
    `偏差概览：${devs.length} 个团队中，产能不足 ${nBad} 个、缺人头数 ${nNoHead} 个、其余正常。`
  ];
  if (nBad || nNoHead) {
    const bad = devs.filter(d => d.verdict !== '正常').map(d => `${d.team}(${d.verdict})`).join('、');
    progressLines.push('重点关注：' + bad + '。');
  }
  const progress = progressLines.join('\n');

  /* 风险：未解决风险清单（脱敏：不含人名） */
  const riskSection = risks.length
    ? risks.map(r => `- 【${r.severity}】${r.title}：${r.evidence}。建议：${r.suggestion}`).join('\n')
    : '本周未识别到高风险项，保持关注。';

  /* 下周计划：plan 未完成项；空则按迭代排期 */
  const openPlans = plans.filter(p => p.status_category !== 'done');
  const nextWeek = openPlans.length
    ? openPlans.map(p => `- ${p.title}${p.due ? '（到期 ' + String(p.due).slice(0, 10) + '）' : ''}`).join('\n')
    : '- 按当前迭代排期推进，重点消化产能偏差团队的工作量。';

  /* 需协调：偏差大 + 佐证缺失 + 仓库静默 */
  const coord = [];
  for (const d of devs) {
    if (d.verdict === '产能不足' || d.verdict === '缺人头数') {
      coord.push(`- ${d.team}：${d.verdict}，偏差 ${Math.round(d.ratio * 1000) / 10}%（${round1(d.over)} 人天），需复核排期或调配资源。`);
    }
  }
  for (const r of repos || []) {
    if (r && r.lastCommitAt && (Date.now() - new Date(r.lastCommitAt).getTime()) > riskSkill.RULES.repoSilentDays * MS_DAY) {
      coord.push(`- 仓库「${r.name}」近 ${riskSkill.RULES.repoSilentDays} 天无提交，请确认是否停滞。`);
    }
  }
  const coordination = coord.length ? coord.join('\n') : '- 暂无跨团队协调事项。';

  const markdown = [
    `# ${week} 周报`,
    '',
    '## 进展',
    progress,
    '',
    '## 风险',
    riskSection,
    '',
    '## 下周计划',
    nextWeek,
    '',
    '## 需协调',
    coordination,
    ''
  ].join('\n');

  /* 待确认项：本周偏差团队是否已复核（发报前确认） */
  const pendingConfirm = devs
    .filter(d => d.verdict !== '正常')
    .map(d => ({
      id: 'rp-' + d.team,
      title: `确认「${d.team}」偏差描述无误`,
      detail: `${d.verdict} ${Math.round(d.ratio * 1000) / 10}%`,
      action: '确认/修改'
    }));

  return {
    markdown,
    sections: { progress, risks: riskSection, nextWeek, coordination },
    pendingConfirm
  };
}

function weekLabel(now) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - start) / 86400000) + start.getDay() + 1) / 7);
  return '第' + week + '周';
}
function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

module.exports = { id: 'report', name: '周报生成器', desc: '四节式周报草稿（进展/风险/下周计划/需协调），改一改就能发', generate, weekLabel };