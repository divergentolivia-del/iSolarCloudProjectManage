/* modules/skill/skills/knowledge.js — Skill 8：知识沉淀器（纯函数）
   master §7 Skill 12：把 AI 输出的采纳/驳回反馈沉淀为可复用知识：
   各 Skill 采纳率、高频风险类目、待确认积压。
   数据源：knowledge 块（skill state 的 stats + 历史 items 类目统计，只取统计特征）。
   克制：知识卡是「佐证型」输出，不落待确认项（ref: true，决策 3 不要求人工确认统计事实）。 */

'use strict';

/** 规则常量（可调） */
const RULES = {
  backlogWarn: 10      // 单 Skill 待确认 > 10 → 积压提示
};

/**
 * 知识沉淀主函数。
 * @param {object} input
 *   knowledge: { stats: {<skill>: {runCount, adoptCount, rejectCount, pendingCount, adoptRate}},
 *                categoryCount: {<category>: n}, resultCount }
 * @returns {{cards, topCategories, backlog, note, items}}
 */
function accumulate(input) {
  const k = input.knowledge || {};
  const stats = k.stats || {};
  const cards = Object.keys(stats).map(id => {
    const s = stats[id] || {};
    const total = (s.adoptCount || 0) + (s.rejectCount || 0);
    return {
      skill: id,
      runCount: s.runCount || 0,
      adoptCount: s.adoptCount || 0,
      rejectCount: s.rejectCount || 0,
      pendingCount: s.pendingCount || 0,
      adoptRate: total ? Math.round((s.adoptCount || 0) / total * 100) : null
    };
  }).sort((a, b) => b.runCount - a.runCount);

  const topCategories = Object.keys(k.categoryCount || {})
    .map(c => ({ category: c, count: k.categoryCount[c] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const backlog = cards.filter(c => c.pendingCount > RULES.backlogWarn)
    .map(c => ({ skill: c.skill, pending: c.pendingCount }));

  const totalAdopt = cards.reduce((a, c) => a + c.adoptCount, 0);
  const totalReject = cards.reduce((a, c) => a + c.rejectCount, 0);
  const totalPending = cards.reduce((a, c) => a + c.pendingCount, 0);

  const note = `累计运行 ${k.resultCount || 0} 次，人工采纳 ${totalAdopt} / 驳回 ${totalReject}，当前待确认 ${totalPending}。采纳率只统计已决策项（expired 不计入分母）。数据为统计特征，不含原始条目内容（脱敏规范）。`;

  const items = [{
    id: 'knowledge-card', severity: '低', category: '知识沉淀',
    title: `知识卡更新：${cards.length} 个 Skill 累计运行 ${k.resultCount || 0} 次，已决策 ${totalAdopt + totalReject} 条（采纳 ${totalAdopt}）`,
    evidence: cards.map(c => `${c.skill}：跑 ${c.runCount} / 采纳 ${c.adoptCount} / 待确认 ${c.pendingCount}${c.adoptRate != null ? `（采纳率 ${c.adoptRate}%）` : ''}`).join('；'),
    suggestion: '采纳率持续偏低的 Skill 建议检查规则阈值',
    confidence: 0.9,
    ref: true   // 佐证型：统计事实，不需要人工确认
  }];

  return { cards, topCategories, backlog, note, items };
}

module.exports = {
  id: 'knowledge',
  name: '知识沉淀器',
  desc: '各 Skill 采纳率 + 高频风险类目 + 待确认积压 → 知识卡',
  accumulate,
  RULES
};
