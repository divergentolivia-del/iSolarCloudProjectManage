/* modules/skill/skills/risk.js — Skill 1：风险识别器（纯函数）
   master §7 Skill 1：新项目规划期、阶段评审前 → 风险清单 + TOP3 + 关联图。
   M2-B B1：输入 = 仓库活跃度 + 计划偏差 + 里程碑临近。
   克制：每条风险 = 待确认项（决策 3），规则可解释（evidence 引用数据源）。 */

'use strict';

const MS_DAY = 24 * 3600 * 1000;

/** 规则常量（可调） */
const RULES = {
  repoSilentDays: 14,      // 仓库 N 天无提交 → 风险
  repoSilentHighDays: 21,  // > N 天 → 高风险
  capacityRatio: 0.15,     // 产能偏差 > 15% → 风险
  milestoneHorizonDays: 14 // 里程碑临近窗口
};

/**
 * 风险识别主函数。
 * @param {object} input
 *   repos:      [{id, name, ok, error, lastCommitAt}]（pradapter 采集）
 *   deviations: calc.compute 的 deviation 数组（[{team, workload, head, capacity, over, ratio, verdict}]）
 *   plans:      [{id, title, due, status_category}]（可空）
 *   now:        Date.now() 默认
 * @returns {{items: Array, top: Array}}
 *   items: [{id, severity:'高'|'中'|'低', category, title, evidence, suggestion, confidence}]
 *   top: 按严重度排序取 3
 */
function identify(input) {
  const now = input.now || Date.now();
  const items = [];

  /* R1/R2 代码活跃度（数据源：pradapter，L3 统计特征） */
  for (const r of input.repos || []) {
    if (!r || r.ok === false || !r.lastCommitAt) {
      items.push({
        id: 'risk-repo-' + (r && r.id ? r.id : 'unknown'),
        severity: r && r.error ? '中' : '高',
        category: '数据接入',
        title: `仓库「${r ? r.name : '未知'}」采集异常`,
        evidence: r && r.error ? '采集错误：' + r.error : '从未采集到提交',
        suggestion: '检查仓库路径/权限，或确认仓库是否已停用',
        confidence: 0.9
      });
      continue;
    }
    const days = Math.floor((now - new Date(r.lastCommitAt).getTime()) / MS_DAY);
    if (days <= RULES.repoSilentDays) continue;
    items.push({
      id: 'risk-repo-' + r.id,
      severity: days > RULES.repoSilentHighDays ? '高' : '中',
      category: '代码活跃度',
      title: `仓库「${r.name}」已 ${days} 天无提交`,
      evidence: '最近提交：' + String(r.lastCommitAt).slice(0, 10),
      suggestion: days > RULES.repoSilentHighDays
        ? '确认是否已停滞：联系负责人或调整迭代排期'
        : '关注活跃度：建议本周内触发至少一次提交/评审',
      confidence: 0.85
    });
  }

  /* R3 人力产能偏差（数据源：iteration calc）
     ⚠ 这一条【不产生待确认项】，只作为周报里的引用性描述。原因（2026-09-22 用户拍板）：
       偏差是迭代版本板块自己算出来的结论，那个页面上一眼看得到，线下也就照这个开会。
       再让 AI「识别」一遍等于把同一份数据换个说法重复报一次，纯空转。
       AI 该做的是分析【还没被人整理过的原始信号】（仓库静默、里程碑临近、依赖阻塞），
       而不是复述【已经被算出来的结论】。打了 ref:true 的项由引擎从待确认队列里剔除，
       但仍会流进周报的风险节 —— 周报里提一句产能偏差是合理的。 */
  for (const d of input.deviations || []) {
    if (!d) continue;
    if (d.verdict === '缺人头数') {
      items.push({
        id: 'risk-cap-' + d.team,
        severity: '高',
        ref: true,
        category: '人力产能',
        title: `团队「${d.team}」缺人头数`,
        evidence: `工作量 ${fmt(d.workload)} 人天，产能 0（无登记人头）`,
        suggestion: '补充该团队人头数登记，或重新分配工作量',
        confidence: 0.92
      });
      continue;
    }
    if (d.verdict === '产能不足' && d.ratio > RULES.capacityRatio) {
      items.push({
        id: 'risk-cap-' + d.team,
        severity: d.ratio > 0.3 ? '高' : '中',
        ref: true,
        category: '人力产能',
        title: `团队「${d.team}」产能偏差 ${fmtRatio(d.ratio)}`,
        evidence: `工作量 ${fmt(d.workload)} 人天 vs 产能 ${fmt(d.capacity)} 人天，超 ${fmt(d.over)} 人天`,
        suggestion: d.ratio > 0.3 ? '建议立即复核排期，必要时申请加人' : '复核工作量估算，排查估算偏差来源',
        confidence: 0.88
      });
    }
  }

  /* R4 里程碑临近（数据源：plan，为空时跳过） */
  for (const p of input.plans || []) {
    if (!p || !p.due || p.status_category === 'done') continue;
    const due = new Date(p.due).getTime();
    if (!isFinite(due)) continue;
    const leftDays = Math.ceil((due - now) / MS_DAY);
    if (leftDays > RULES.milestoneHorizonDays) continue;
    items.push({
      id: 'risk-ms-' + p.id,
      severity: leftDays < 0 ? '高' : '中',
      category: '里程碑',
      title: `里程碑「${p.title || p.id}」${leftDays < 0 ? '已逾期 ' + (-leftDays) + ' 天' : leftDays + ' 天后到期'}`,
      evidence: '到期日：' + String(p.due).slice(0, 10),
      suggestion: leftDays < 0 ? '立即复盘逾期原因，更新里程碑计划' : '确认交付物状态，提前安排资源',
      confidence: 0.8
    });
  }

  /* 排序：高 > 中 > 低，同级别按置信度 */
  const order = { '高': 0, '中': 1, '低': 2 };
  items.sort((a, b) => (order[a.severity] - order[b.severity]) || (b.confidence - a.confidence));
  return { items, top: items.slice(0, 3) };
}

function fmt(n) { return Math.round(n * 10) / 10; }
function fmtRatio(r) { return (Math.round(r * 1000) / 10) + '%'; }

module.exports = { id: 'risk', name: '风险识别器', desc: '仓库活跃度 + 计划偏差 + 里程碑临近 → 风险清单', identify, RULES };