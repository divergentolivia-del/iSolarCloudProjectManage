// _test-skill.js — Skill 评测集（master §7.3）：risk / variance / report / engine
// 纯函数评测 + 运行时确认流程（SKILL_DATA_DIR 隔离，不碰真实数据）
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
process.env.SKILL_DATA_DIR = TMP;

const risk = require('./modules/skill/skills/risk');
const variance = require('./modules/skill/skills/variance');
const report = require('./modules/skill/skills/report');
const engine = require('./modules/skill/lib/engine');
engine.ensureData();

let pass = 0, fail = 0;
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const DAY = 24 * 3600 * 1000;
const now = Date.now();

console.log('\n[Skill1 风险识别器 · 代码活跃度]');
{
  const r1 = risk.identify({
    now,
    repos: [{ id: 'r1', name: '仓库A', ok: true, lastCommitAt: new Date(now - 20 * DAY).toISOString() }],
    deviations: [], plans: []
  });
  ck('20 天无提交 → 中风险', r1.items.length === 1 && r1.items[0].severity === '中' && r1.items[0].category === '代码活跃度', r1.items);

  const r2 = risk.identify({
    now,
    repos: [{ id: 'r1', name: '仓库A', ok: true, lastCommitAt: new Date(now - 35 * DAY).toISOString() }],
    deviations: [], plans: []
  });
  ck('35 天无提交 → 高风险', r2.items.length === 1 && r2.items[0].severity === '高', r2.items);

  const r3 = risk.identify({
    now,
    repos: [{ id: 'r1', name: '仓库A', ok: true, lastCommitAt: new Date(now - 3 * DAY).toISOString() }],
    deviations: [], plans: []
  });
  ck('3 天前有提交 → 无风险', r3.items.length === 0, r3.items);

  const r4 = risk.identify({
    now,
    repos: [{ id: 'r1', name: '仓库A', ok: false, error: 'repository not found', lastCommitAt: null }],
    deviations: [], plans: []
  });
  ck('采集异常 → 数据接入风险', r4.items.length === 1 && r4.items[0].category === '数据接入', r4.items);
}

console.log('\n[Skill1 风险识别器 · 人力产能 / 里程碑 / TOP3]');
{
  const devs = [
    { team: 'T1', workload: 120, head: 5, capacity: 100, over: 20, ratio: 0.2, verdict: '产能不足' },
    { team: 'T2', workload: 50, head: 0, capacity: 0, over: 50, ratio: 0, verdict: '缺人头数' },
    { team: 'T3', workload: 80, head: 4, capacity: 90, over: -10, ratio: -0.11, verdict: '产能富余' }
  ];
  const r = risk.identify({ now, repos: [], deviations: devs, plans: [] });
  ck('产能不足>15% → 人力产能风险', r.items.some(i => i.id === 'risk-cap-T1' && i.severity === '中'), r.items);
  ck('缺人头数 → 高风险', r.items.some(i => i.id === 'risk-cap-T2' && i.severity === '高'), r.items);
  ck('产能富余不报', !r.items.some(i => i.id === 'risk-cap-T3'), r.items);

  const p1 = risk.identify({
    now,
    repos: [], deviations: [],
    plans: [{ id: 'p1', title: 'C版本发布', due: new Date(now + 5 * DAY).toISOString().slice(0, 10), status_category: 'doing' }]
  });
  ck('里程碑 5 天后 → 中风险', p1.items.length === 1 && p1.items[0].category === '里程碑' && p1.items[0].severity === '中', p1.items);

  const p2 = risk.identify({
    now,
    repos: [], deviations: [],
    plans: [{ id: 'p1', title: 'C版本发布', due: new Date(now + 5 * DAY).toISOString().slice(0, 10), status_category: 'done' }]
  });
  ck('已完成的里程碑跳过', p2.items.length === 0, p2.items);

  const mixed = risk.identify({
    now,
    repos: [{ id: 'r1', name: '仓库A', ok: true, lastCommitAt: new Date(now - 30 * DAY).toISOString() }],
    deviations: devs, plans: []
  });
  ck('TOP3 按严重度排序（高在前）', mixed.top.length === 3
    && mixed.top.every((x, i) => i === 0 || order(mixed.top[i - 1].severity) <= order(x.severity)), mixed.top);
  function order(s) { return { '高': 0, '中': 1, '低': 2 }[s]; }
}

console.log('\n[Skill3 偏差分析器 · 偏差表/建议/佐证]');
{
  const devs = [
    { team: 'T1', workload: 120, head: 5, capacity: 100, over: 20, ratio: 0.2, verdict: '产能不足', workloadOverridden: false },
    { team: 'T2', workload: 50, head: 0, capacity: 0, over: 50, ratio: 0, verdict: '缺人头数', workloadOverridden: false },
    { team: 'T3', workload: 80, head: 4, capacity: 90, over: -10, ratio: -0.11, verdict: '产能富余', workloadOverridden: false },
    { team: 'T4', workload: 60, head: 3, capacity: 66, over: -6, ratio: -0.09, verdict: '正常', workloadOverridden: false }
  ];
  const a1 = variance.analyze({ deviations: devs, reconcile: [], history: [], evidence: { T1: { l1: 3, l2: 1 } } });
  ck('偏差表 4 行', a1.table.length === 4, a1.table.length);
  ck('T1 有佐证', a1.table.find(t => t.team === 'T1').evidence.indexOf('有佐证') >= 0);
  ck('T2 缺佐证', a1.table.find(t => t.team === 'T2').evidence === '无佐证');
  ck('产能不足建议', a1.suggestions.some(s => s.id === 'var-T1-cap'), a1.suggestions);
  ck('缺人头建议', a1.suggestions.some(s => s.id === 'var-T2-head'));
  ck('富余建议', a1.suggestions.some(s => s.id === 'var-T3-free'));
  ck('缺佐证汇总建议', a1.suggestions.some(s => s.id === 'var-evidence'));
  ck('归因 TOP3 排序正确（|over| 降序，首为 T2）且含 T1',
    a1.attribution.topOver.length === 3 && a1.attribution.topOver[0].team === 'T2'
    && a1.attribution.topOver.some(x => x.team === 'T1'), a1.attribution);
  ck('趋势含本期', a1.trend.length >= 1 && a1.trend[a1.trend.length - 1].at === '本期', a1.trend);
}

console.log('\n[Skill3 偏差分析器 · 正常/对账]');
{
  const a1 = variance.analyze({
    deviations: [{ team: 'T4', workload: 60, head: 3, capacity: 66, over: -6, ratio: -0.09, verdict: '正常', workloadOverridden: false }],
    reconcile: [], history: [], evidence: {}
  });
  ck('全正常 → 无建议', a1.suggestions.length === 0, a1.suggestions);
  const a2 = variance.analyze({
    deviations: [], reconcile: [{ team: 'T5', totals: 10, board: 14, diff: 4 }], history: [], evidence: {}
  });
  ck('对账差异 → 核对建议', a2.suggestions.some(s => s.id === 'var-rec-T5'), a2.suggestions);
}

console.log('\n[Skill2 周报生成器 · 四节结构与内容]');
{
  const devs = [
    { team: 'T1', workload: 120, head: 5, capacity: 100, over: 20, ratio: 0.2, verdict: '产能不足' },
    { team: 'T4', workload: 60, head: 3, capacity: 66, over: -6, ratio: -0.09, verdict: '正常' }
  ];
  const risks = [{ id: 'x1', severity: '高', title: '仓库A 已 30 天无提交', evidence: '最近提交：2026-08-20', suggestion: '确认是否停滞' }];
  const r = report.generate({ deviations: devs, risks, repos: [], plans: [], now, weekLabel: '第 38 周' });
  ck('标题：第 38 周 周报', r.markdown.indexOf('# 第 38 周 周报') === 0);
  ck('四节齐全', ['## 进展', '## 风险', '## 下周计划', '## 需协调'].every(s => r.markdown.indexOf(s) >= 0), r.sections);
  ck('进展含投入人天', r.sections.progress.indexOf('8 人天') >= 0, r.sections.progress);
  ck('风险节含风险标题', r.sections.risks.indexOf('仓库A 已 30 天无提交') >= 0);
  ck('需协调含偏差团队', r.sections.coordination.indexOf('T1') >= 0, r.sections.coordination);
  ck('待确认只含偏差团队', r.pendingConfirm.length === 1 && r.pendingConfirm[0].id === 'rp-T1', r.pendingConfirm);
}

console.log('\n[Skill2 周报生成器 · 降级/脱敏]');
{
  const r1 = report.generate({ deviations: [], risks: [], repos: [], plans: [], now, weekLabel: '第 38 周' });
  ck('无风险 → 兜底文案', r1.sections.risks.indexOf('未识别到高风险') >= 0);
  ck('无计划 → 降级文案', r1.sections.nextWeek.indexOf('按当前迭代排期推进') >= 0);
  ck('全正常 → 无待确认', r1.pendingConfirm.length === 0);
  const r2 = report.generate({
    deviations: [{ team: '后端开发', workload: 100, head: 4, capacity: 88, over: 12, ratio: 0.14, verdict: '产能不足' }],
    risks: [], repos: [], plans: [], now, weekLabel: '第 38 周'
  });
  ck('脱敏：无个人姓名（只团队名）', !/[\u4e00-\u9fa5]{2,3}-\d{3,}/.test(r2.markdown), r2.markdown.slice(0, 100));
}

console.log('\n[运行时 · 执行/确认/采纳率]');
{
  const r0 = engine.run('no-such');
  ck('未知 Skill → error', r0.ok === false && r0.error.indexOf('未知') >= 0, r0);

  const inputs = {
    now,
    repos: [{ id: 'r1', name: '仓库A', ok: true, lastCommitAt: new Date(now - 30 * DAY).toISOString() }],
    deviations: [{ team: 'T1', workload: 120, head: 5, capacity: 100, over: 20, ratio: 0.2, verdict: '产能不足', workloadOverridden: false }],
    reconcile: [], history: [], plans: [], evidence: {}
  };
  const r1 = engine.run('risk', inputs);
  ck('risk 运行成功', r1.ok && r1.result.items.length >= 1, r1);
  const item = r1.result.items[0];

  const c1 = engine.confirm(r1.result.resultId, item.itemId, true, '测试员');
  ck('采纳 → adoptCount=1', c1.ok && c1.stats.adoptCount === 1 && c1.stats.adoptRate === 100, c1);

  const c2 = engine.confirm(r1.result.resultId, item.itemId, false, '测试员');
  ck('重复确认被拒', c2.ok === false && c2.error.indexOf('已处理') >= 0, c2);

  const r2 = engine.run('risk', inputs);
  const vItem = r2.result.items[1];
  const c3 = engine.confirm(r2.result.resultId, vItem.itemId, false, '测试员');
  ck('同 skill 驳回到 50% 采纳率', c3.ok && c3.stats.adoptCount === 1 && c3.stats.rejectCount === 1 && c3.stats.adoptRate === 50, c3);

  const latest = engine.latest('risk');
  ck('latest 返回最近结果', latest && latest.resultId === r2.result.resultId);
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);