/* modules/skill/skills/health.js — Skill 4：健康度评估器（纯函数）
   master §7 Skill 4：每周一/里程碑前 → 四维得分卡 + 红黄绿灯 + 异常摘要。
   四维：进度（偏差）/ 人力（人头数）/ 代码活跃度（pradapter）/ 风险（risk Skill 同源）。
   克制：分数只反映规则命中，不硬算"完成度"；每个非绿灯维度落成待确认项（决策 3）。 */

'use strict';

const riskSkill = require('./risk');

const MS_DAY = 24 * 3600 * 1000;

/** 规则常量（可调） */
const RULES = {
  weights: { schedule: 0.35, capacity: 0.30, code: 0.15, risk: 0.20 },
  scheduleYellowRatio: 0.20,  // 最大 |偏差率| > 20% → 黄
  scheduleRedRatio: 0.50,     // > 50% → 红
  capacityYellowNoHead: 1,    // 缺人头团队 1-2 个 → 黄
  capacityRedNoHead: 3,       // >= 3 个 → 红
  codeStaleYellow: 1,         // 静默仓库 >=1 → 黄，>=3 → 红（绝对数，防单仓 100% 误判红）
  overallGreenScore: 80,
  overallYellowScore: 60,
  repoSilentDays: riskSkill.RULES.repoSilentDays
};

function clamp100(x) { return Math.max(0, Math.min(100, Math.round(x))); }

/* ---------- 四维 ---------- */

function scheduleDim(deviations) {
  const ds = (deviations || []).filter(d => d && d.ratio != null);
  if (!ds.length) return { light: 'green', score: 100, detail: '本期无偏差数据' };
  const maxAbs = Math.max(...ds.map(d => Math.abs(d.ratio || 0)));
  const overCount = ds.filter(d => (d.ratio || 0) > 0).length;
  const light = maxAbs > RULES.scheduleRedRatio ? 'red'
    : maxAbs > RULES.scheduleYellowRatio ? 'yellow' : 'green';
  const score = clamp100(100 - maxAbs * 130); // 100% 偏差 → 0 分
  return { light, score, detail: `${ds.length} 个团队参评，最大偏差 ${Math.round(maxAbs * 100)}%（超 ${overCount} / 欠 ${ds.length - overCount}）` };
}

function capacityDim(deviations) {
  const ds = (deviations || []).filter(d => d && d.head != null);
  const noHead = ds.filter(d => Number(d.head) === 0).length;
  if (!ds.length) return { light: 'green', score: 100, detail: '本期无团队数据' };
  const light = noHead >= RULES.capacityRedNoHead ? 'red'
    : noHead >= RULES.capacityYellowNoHead ? 'yellow' : 'green';
  const score = clamp100(100 - noHead * 25);
  return { light, score, detail: noHead
    ? `${noHead}/${ds.length} 个团队缺人头数（产能无法核算）`
    : `全部 ${ds.length} 个团队人头数齐备` };
}

function codeDim(repos, now) {
  const rs = (repos || []).filter(r => r && r.ok !== false);
  if (!rs.length) return { light: 'green', score: 100, detail: '未接入代码仓库（不扣分）' };
  const stale = rs.filter(r => r.lastCommitAt && (now - new Date(r.lastCommitAt).getTime()) > RULES.repoSilentDays * MS_DAY).length;
  const failed = (repos || []).filter(r => r && r.ok === false).length;
  const ratio = stale / rs.length;
  /* 用绝对数而非比例：只有 1 个仓库时静默=100%，不应直接红灯 */
  let light = stale >= 3 ? 'red' : stale >= RULES.codeStaleYellow ? 'yellow' : 'green';
  if (light === 'green' && failed > 0) light = 'yellow';
  const score = clamp100(100 - stale * 20 - (failed ? 10 : 0));
  const parts = [];
  if (stale) parts.push(`${stale} 个仓库超 ${RULES.repoSilentDays} 天无提交`);
  if (failed) parts.push(`${failed} 个仓库采集异常`);
  return { light, score, detail: parts.length ? parts.join('；') : `全部 ${rs.length} 个仓库活跃` };
}

function riskDim(risks) {
  const list = risks || [];
  const high = list.filter(x => x.severity === '高').length;
  const mid = list.filter(x => x.severity === '中').length;
  const light = high >= 3 ? 'red' : high >= 1 ? 'yellow' : 'green';
  const score = clamp100(100 - high * 25 - mid * 10);
  return { light, score, detail: `风险共 ${list.length} 条（高 ${high} / 中 ${mid}）` };
}

/**
 * 健康度评估主函数。
 * @param {object} input
 *   deviations: calc 偏差数组（[{team, head, ratio, ...}]）
 *   repos:      pradapter 仓库统计（[{id, name, ok, lastCommitAt}]）
 *   risks:      risk Skill 输出 items（engine 同源注入）
 *   now:        Date.now() 默认
 * @returns {{card, anomalies, items}}
 *   card:    { overall: {score, light}, dimensions: [{key, name, light, score, detail}] }
 *   anomalies: 非绿灯维度的摘要
 *   items:   待确认项（每个非绿灯维度一条）
 */
function assess(input) {
  const now = input.now || Date.now();
  const dims = [
    { key: 'schedule', name: '进度', ...scheduleDim(input.deviations) },
    { key: 'capacity', name: '人力', ...capacityDim(input.deviations) },
    { key: 'code', name: '代码活跃度', ...codeDim(input.repos, now) },
    { key: 'risk', name: '风险', ...riskDim(input.risks) }
  ];

  const w = RULES.weights;
  const score = clamp100(
    w.schedule * dims[0].score + w.capacity * dims[1].score +
    w.code * dims[2].score + w.risk * dims[3].score
  );
  const redCount = dims.filter(d => d.light === 'red').length;
  let overall = score >= RULES.overallGreenScore ? 'green'
    : score >= RULES.overallYellowScore ? 'yellow' : 'red';
  if (redCount >= 2) overall = 'red';
  else if (redCount === 1 && overall === 'green') overall = 'yellow';

  const lightName = { green: '🟢 绿灯', yellow: '🟡 黄灯', red: '🔴 红灯' };
  const anomalies = dims.filter(d => d.light !== 'green').map(d => ({
    dimension: d.name, light: d.light, text: `${d.name}维度${lightName[d.light]}：${d.detail}`
  }));

  const items = dims.filter(d => d.light !== 'green').map(d => ({
    id: 'health-' + d.key,
    severity: d.light === 'red' ? '高' : '中',
    category: '健康度',
    title: `${d.name}维度${lightName[d.light]}（${d.score} 分）`,
    evidence: d.detail,
    suggestion: d.light === 'red' ? '优先处理该维度，处理后可重跑本 Skill 复核' : '列入本期观察项，下次评估前复查',
    confidence: 0.9
  }));

  return {
    card: { overall: { score, light: overall, label: lightName[overall] }, dimensions: dims },
    anomalies,
    items
  };
}

module.exports = {
  id: 'health',
  name: '健康度评估器',
  desc: '进度/人力/代码/风险四维 → 得分卡 + 红黄绿灯 + 异常摘要',
  assess,
  RULES
};
