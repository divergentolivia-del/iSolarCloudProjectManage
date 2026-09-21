/* modules/pradapter/lib/alert.js — 静默告警（纯函数）
   master §4.3 克制原则：PR/提交数据是"佐证"——有佐证安静，没佐证报警。
   告警 = 佐证缺失信号，不算完成度。 */

'use strict';

const MS_WEEK = 7 * 24 * 3600 * 1000;
const MS_DAY = 24 * 3600 * 1000;

/**
 * 计算告警。
 * @param {object} opts
 *   repos:      [{id, name, lastCommitAt}]（ISO 或 null）
 *   mappings:   [{repoId, taskId}]（L1/L2 确认过的任务↔仓库映射）
 *   tasks:      [{id, title, due, status_category}]（status_category ∈ todo/doing/done）
 *   staleWeeks: 默认 2；dueHorizonDays: 默认 14；now: 默认 Date.now()
 * @returns {Array<{kind, repoId, taskId?, lastCommitAt?, due?, level, message}>}
 */
function computeAlerts(opts) {
  const staleWeeks = opts.staleWeeks || 2;
  const dueHorizon = (opts.dueHorizonDays || 14) * MS_DAY;
  const now = opts.now || Date.now();
  const alerts = [];

  // 仓库静默：N 周无提交
  for (const repo of opts.repos || []) {
    const last = repo.lastCommitAt ? new Date(repo.lastCommitAt).getTime() : 0;
    if (!last) {
      alerts.push({
        kind: 'repo-stale', repoId: repo.id, lastCommitAt: null, level: 'warn',
        message: `仓库「${repo.name}」从未采集到提交`
      });
      continue;
    }
    if (now - last > staleWeeks * MS_WEEK) {
      alerts.push({
        kind: 'repo-stale', repoId: repo.id, lastCommitAt: repo.lastCommitAt, level: 'warn',
        message: `仓库「${repo.name}」已 ${Math.floor((now - last) / MS_DAY)} 天无提交`
      });
    }
  }

  // 任务静默：任务有关联仓库 + 临近到期 + 未完成 + 仓库 N 周无提交
  for (const m of opts.mappings || []) {
    const task = (opts.tasks || []).find(t => String(t.id) === String(m.taskId));
    if (!task || task.status_category === 'done' || !task.due) continue;
    const due = new Date(task.due).getTime();
    if (!isFinite(due) || due - now > dueHorizon) continue;   // 还早，不报
    const repo = (opts.repos || []).find(r => r.id === m.repoId);
    if (!repo || !repo.lastCommitAt) continue;
    const last = new Date(repo.lastCommitAt).getTime();
    if (now - last > staleWeeks * MS_WEEK) {
      alerts.push({
        kind: 'task-stale', repoId: m.repoId, taskId: m.taskId,
        due: task.due, lastCommitAt: repo.lastCommitAt, level: 'warn',
        message: `任务「${task.title || m.taskId}」${Math.max(1, Math.ceil((due - now) / MS_DAY))} 天后到期，关联仓库 ${staleWeeks} 周无提交`
      });
    }
  }

  return alerts;
}

module.exports = { computeAlerts };