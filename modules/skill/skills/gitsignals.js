/* modules/skill/skills/gitsignals.js — Skill 5：Git/PR 信号分析器（纯函数）
   master §7 Skill 5：每日 → 任务-代码关联表 + 停滞/评审阻塞/CI 反复失败信号。
   数据现实（诚实声明）：当前 pradapter 只采 git log（L3 统计特征），
   无 PR 评审/CI 数据 → 评审阻塞/CI 信号本期不出，在 note 里写明，等 M2-C 接真实仓库。
   克制：所有信号 = 待确认项（决策 3）。 */

'use strict';

const riskSkill = require('./risk');

const MS_DAY = 24 * 3600 * 1000;

/** 规则常量（可调） */
const RULES = {
  repoSilentDays: riskSkill.RULES.repoSilentDays,   // 14 天无提交 → 停滞（中）
  repoSilentHighDays: riskSkill.RULES.repoSilentHighDays, // 21 天 → 高
  unmappedMinCommits: 10,    // 提交数 < 10 不评关联率（样本太小）
  unmappedPileupRatio: 0.5   // L4 占比 > 50% → 关联缺口信号
};

/**
 * Git/PR 信号分析主函数。
 * @param {object} input
 *   repos: [{id, name, ok, error, lastCommitAt}]
 *   git:   { stats: {byLevel, commitCount}, lastRefreshAt, l2Pending }（engine 注入）
 *   now:   Date.now() 默认
 * @returns {{signals, mappingTable, notes, items}}
 */
function analyze(input) {
  const now = input.now || Date.now();
  const signals = [];
  const git = input.git || {};
  const byLevel = (git.stats && git.stats.byLevel) || {};
  const commitCount = (git.stats && git.stats.commitCount) || 0;

  /* S1 仓库停滞（数据源：pradapter，L3 统计特征） */
  for (const r of input.repos || []) {
    if (!r || r.ok === false) continue;
    if (!r.lastCommitAt) {
      signals.push({
        type: 'repo-stale', severity: '中', repo: r.id,
        title: `仓库「${r.name}」从未采集到提交`,
        detail: 'git log 无结果或仓库为空，确认仓库路径/分支是否正确'
      });
      continue;
    }
    const days = (now - new Date(r.lastCommitAt).getTime()) / MS_DAY;
    if (days > RULES.repoSilentDays) {
      const high = days > RULES.repoSilentHighDays;
      signals.push({
        type: 'repo-stale', severity: high ? '高' : '中', repo: r.id,
        title: `仓库「${r.name}」已 ${Math.floor(days)} 天无提交`,
        detail: `最近提交 ${String(r.lastCommitAt).slice(0, 10)}，超过 ${high ? RULES.repoSilentHighDays : RULES.repoSilentDays} 天阈值`
      });
    }
  }

  /* S2 采集异常 */
  for (const r of input.repos || []) {
    if (r && r.ok === false) {
      signals.push({
        type: 'repo-fail', severity: '中', repo: r.id,
        title: `仓库「${r.name}」采集失败`,
        detail: String(r.error || '未知错误')
      });
    }
  }

  /* S3 关联缺口：L4 占比过高（提交进不了任务-代码关联表） */
  const l4 = byLevel.L4 || 0;
  if (commitCount >= RULES.unmappedMinCommits && l4 / commitCount > RULES.unmappedPileupRatio) {
    signals.push({
      type: 'unmapped-pileup', severity: '中', repo: null,
      title: `任务-代码关联缺口：${l4}/${commitCount} 条提交（${Math.round(l4 / commitCount * 100)}%）无法关联任务`,
      detail: '在提交标题里带 #任务号（L1），或到「映射确认」里采纳 L2 建议（确认后固化为 L1）'
    });
  }

  /* S4 语义映射确认积压（L2 建议等人工确认） */
  if (git.l2Pending > 0) {
    signals.push({
      type: 'l2-stagnant', severity: '低', repo: null,
      title: `${git.l2Pending} 条语义映射建议等待确认`,
      detail: 'L2 建议长期不确认，佐证覆盖无法提升；到「映射确认」逐条采纳/驳回'
    });
  }

  /* 任务-代码关联表（四级分布，L3 仓库级只计活跃度不碰任务） */
  const mappingTable = [
    { level: 'L1', name: '显式关联', count: byLevel.L1 || 0, desc: '提交带 #任务号，自动记变更日志' },
    { level: 'L2', name: '语义关联', count: byLevel.L2 || 0, desc: 'AI 建议，待人确认' },
    { level: 'L3', name: '仓库级', count: byLevel.L3 || 0, desc: '只更新模块活跃度' },
    { level: 'L4', name: '未关联', count: byLevel.L4 || 0, desc: '仅进原始日志' }
  ];

  const notes = [
    '评审阻塞 / CI 反复失败信号依赖 PR 系统（GitHub/GitLab API）数据，当前 adapter 只采 git log，未接入后不出这两类信号（M2-C 接真实仓库时补）。',
    '人员只出现角色/工号口径，提交者原文不进入本 Skill 输出（L3 脱敏规范）。'
  ];

  const items = signals.map(s => ({
    id: 'gitsig-' + s.type + (s.repo ? '-' + s.repo : ''),
    severity: s.severity,
    category: '代码信号',
    title: s.title,
    evidence: s.detail,
    suggestion: s.type === 'repo-stale' ? '确认仓库是否仍在开发；已冻结的仓库在 config.json 里标记或移除'
      : s.type === 'repo-fail' ? '检查仓库路径/权限后点「重新采集」'
      : s.type === 'unmapped-pileup' ? '推动团队在提交标题带 #任务号；采纳 L2 建议可提升 L1 占比'
      : '到「映射确认」逐条处理 L2 建议',
    confidence: 0.85
  }));

  return { signals, mappingTable, notes, items };
}

module.exports = {
  id: 'gitsignals',
  name: 'Git/PR 信号分析器',
  desc: '任务-代码关联表 + 仓库停滞/采集异常/关联缺口/确认积压信号',
  analyze,
  RULES
};
