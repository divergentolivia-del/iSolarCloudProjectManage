/* modules/skill/skills/workload.js — Skill 6：资源负载分析器（纯函数）
   master §7 Skill 10：每周/里程碑前 → 按团队负载率分级 + 过载/超载/缺人头建议。
   数据源：calc.compute 偏差（与平台核算同源，含 workload/head/capacity）。
   克制：只对「缺人头 / 过载 / 超载」出待确认项；富余是正常排期缓冲，只展示不出项。 */

'use strict';

/** 规则常量（可调） */
const RULES = {
  headlessOverload: 0.5,   // 负载率 >= 0.5 但缺人头 → 高（有活儿没人干）
  overloadRatio: 1.2,      // 负载率 > 1.2 → 过载（高）
  busyRatio: 1.0,          // > 1.0 → 超载（中）
  idleRatio: 0.8           // < 0.8 → 富余（展示，不出项）
};

function loadRateOf(d) {
  if (d.capacity > 0) return d.workload / d.capacity;
  return d.workload > 0 ? Infinity : 0;
}

function stateOf(d, rate) {
  if (Number(d.head) === 0 && d.workload > 0) return 'headless';
  if (d.workload <= 0) return 'ok';   // 本期无工时：没得判，不算富余
  if (rate > RULES.overloadRatio) return 'overload';
  if (rate > RULES.busyRatio) return 'busy';
  if (rate < RULES.idleRatio) return 'idle';
  return 'ok';
}

const STATE_TEXT = {
  headless: '缺人头', overload: '过载', busy: '超载', idle: '富余', ok: '健康'
};

/**
 * 资源负载分析主函数。
 * @param {object} input
 *   deviations: calc 偏差数组（[{team, dept, head, workload, capacity, over, ratio, verdict}]）
 * @returns {{table, overall, suggestions, items}}
 */
function analyze(input) {
  const ds = (input.deviations || []).filter(d => d && d.team);
  const table = ds.map(d => {
    const rate = loadRateOf(d);
    const state = stateOf(d, rate);
    return {
      team: d.team, dept: d.dept || '', head: Number(d.head) || 0,
      workload: Math.round(d.workload || 0), capacity: Math.round(d.capacity || 0),
      loadRate: rate === Infinity ? null : Math.round(rate * 1000) / 1000,
      state, stateText: STATE_TEXT[state]
    };
  });

  const counted = table.filter(t => t.loadRate != null);
  const overall = {
    avgLoadRate: counted.length ? Math.round(counted.reduce((a, t) => a + t.loadRate, 0) / counted.length * 1000) / 1000 : null,
    overloaded: table.filter(t => t.state === 'overload').length,
    busy: table.filter(t => t.state === 'busy').length,
    headless: table.filter(t => t.state === 'headless').length,
    idle: table.filter(t => t.state === 'idle').length,
    capacityGap: Math.round(ds.reduce((a, d) => a + Math.max(0, (d.over || 0)), 0))
  };

  const suggestions = [];
  for (const t of table) {
    if (t.state === 'headless') {
      suggestions.push({ team: t.team, severity: '高',
        text: `${t.team} 有 ${t.workload} 人日工时但无人头数，产能无法核算 → 先补人头数` });
    } else if (t.state === 'overload') {
      const gap = Math.round(t.workload - t.capacity);
      suggestions.push({ team: t.team, severity: '高',
        text: `${t.team} 负载率 ${Math.round(t.loadRate * 100)}%（工时 ${t.workload} / 产能 ${t.capacity}，缺口 ${gap} 人日）→ 加人 ${Math.ceil(gap / (t.capacity / Math.max(1, t.head)))} 名或削减需求/拆分迭代` });
    } else if (t.state === 'busy') {
      suggestions.push({ team: t.team, severity: '中',
        text: `${t.team} 负载率 ${Math.round(t.loadRate * 100)}% 临界 → 关注下期排期，必要时提前协调资源` });
    }
  }

  const items = suggestions.map(s => ({
    id: 'workload-' + s.team,
    severity: s.severity, category: '资源负载',
    title: s.text.split('→')[0].trim(),
    evidence: s.text,
    suggestion: s.severity === '高' ? '处理后可重跑本 Skill 复核' : '列入下期排期观察',
    confidence: 0.9
  }));

  return { table, overall, suggestions, items };
}

module.exports = {
  id: 'workload',
  name: '资源负载分析器',
  desc: '按团队负载率分级（过载/超载/健康/富余）+ 产能缺口 + 逐队建议',
  analyze,
  RULES
};