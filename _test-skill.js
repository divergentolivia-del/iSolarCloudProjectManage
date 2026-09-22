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
  /* 2026-09-22 降级：产能偏差是迭代版本板块自己算出来的结论，不再重复报成待确认。
     但它仍需作为引用性描述流进周报的风险节，所以 ref:true 而不是直接删掉。 */
  ck('产能不足 → 仍产出条目但标 ref（不进退待确认）',
    r.items.some(i => i.id === 'risk-cap-T1' && i.severity === '中' && i.ref === true), r.items);
  ck('缺人头数 → 高风险且标 ref', r.items.some(i => i.id === 'risk-cap-T2' && i.severity === '高' && i.ref === true), r.items);
  ck('产能富余不报', !r.items.some(i => i.id === 'risk-cap-T3'), r.items);
  ck('产能偏差类全部带 ref（一条都不许漏进待办）',
    r.items.filter(i => i.category === '人力产能').every(i => i.ref === true), r.items);
  ck('仓库静默/里程碑类不带 ref（真正的待确认只该是这些）',
    r.items.filter(i => i.category !== '人力产能').every(i => !i.ref), r.items);

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
  const a1 = variance.analyze({ deviations: devs, reconcile: [], history: [], evidence: { T1: { l1: 3, l2: 1 } }, evidenceConfigured: true });
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

console.log('\n[Skill3 偏差分析器 · 佐证映射配置开关]');
{
  const devs2 = [
    { team: 'T1', workload: 120, head: 5, capacity: 100, over: 20, ratio: 0.2, verdict: '产能不足', workloadOverridden: false },
    { team: 'T2', workload: 50, head: 0, capacity: 0, over: 50, ratio: 0, verdict: '缺人头数', workloadOverridden: false }
  ];
  const a3 = variance.analyze({ deviations: devs2, reconcile: [], history: [], evidence: {} });
  ck('未配置映射 → 不产生"缺 PR 佐证"噪音建议', !a3.suggestions.some(s => s.id === 'var-evidence'), a3.suggestions.map(s => s.id));
  ck('未配置映射 → 佐证列显示 —（不冒充"无佐证"）', a3.table.every(t => t.evidence === '—'), a3.table);
  const a4 = variance.analyze({ deviations: devs2, reconcile: [], history: [], evidence: { T1: { l1: 2 } }, evidenceConfigured: true });
  ck('已配置映射 + T2 无提交 → 触发缺佐证建议', a4.suggestions.some(s => s.id === 'var-evidence') && a4.suggestions.find(s => s.id === 'var-evidence').detail.indexOf('T2') >= 0, a4.suggestions);
  ck('已配置映射 + T1 有提交 → 佐证列正常', a4.table.find(t => t.team === 'T1').evidence.indexOf('有佐证') >= 0);
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

  /* 这个 fixture 需要至少 2 条待确认项（下面第 2 条用来验证驳回链路）。
     原来靠「产能不足」凑第 2 条，但产能偏差 2026-09-22 起标了 ref、不再进出待确认，
     所以换成第二个静默仓库 —— 仓库静默才是真正该由人拍板的那类。 */
  const inputs = {
    now,
    repos: [
      { id: 'r1', name: '仓库A', ok: true, lastCommitAt: new Date(now - 30 * DAY).toISOString() },
      { id: 'r2', name: '仓库B', ok: true, lastCommitAt: new Date(now - 18 * DAY).toISOString() }
    ],
    deviations: [{ team: 'T1', workload: 120, head: 5, capacity: 100, over: 20, ratio: 0.2, verdict: '产能不足', workloadOverridden: false }],
    reconcile: [], history: [], plans: [], evidence: {}
  };
  const r1 = engine.run('risk', inputs);
  ck('risk 运行成功', r1.ok && r1.result.items.length >= 2, r1);
  ck('待确认里没有产能偏差（已降级）', !r1.result.items.some(i => i.itemId === 'risk-cap-T1'), r1.result.items.map(i => i.itemId));
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

console.log('\n[运行时 · 周报风险节真实链路]');
{
  const inputs2 = {
    now,
    repos: [{ id: 'r9', name: '仓库B', ok: true, lastCommitAt: new Date(now - 30 * DAY).toISOString() }],
    deviations: [{ team: 'T1', workload: 120, head: 5, capacity: 100, over: 20, ratio: 0.2, verdict: '产能不足', workloadOverridden: false }],
    reconcile: [], history: [], plans: [], evidence: {}
  };
  const r3 = engine.run('report', inputs2);
  ck('run(report) 自动注入风险（不再永远是兑底文案）', r3.ok && r3.result.output.sections.risks.indexOf('仓库B') >= 0 && r3.result.output.sections.risks.indexOf('已 30 天无提交') >= 0, r3.result.output && r3.result.output.sections.risks);
  ck('待确认项来自偏差团队', r3.result.items.length >= 1 && r3.result.items[0].itemId === 'rp-T1', r3.result.items);
}

console.log('\n[运行时 · 重跑失效旧 pending（采纳率分母不虚高）]');
{
  const inputs3 = {
    now,
    repos: [],
    deviations: [{ team: 'TX', workload: 100, head: 5, capacity: 80, over: 20, ratio: 0.25, verdict: '产能不足', workloadOverridden: false }],
    reconcile: [], history: [], plans: [], evidence: {}
  };
  const rA = engine.run('variance', inputs3);
  const stats1 = engine.listSkills().find(s => s.id === 'variance').stats;
  ck('首跑：pendingCount = 本批条数', rA.result.items.length === 1 && stats1.pendingCount === 1, stats1);
  const rB = engine.run('variance', inputs3);
  const stats2 = engine.listSkills().find(s => s.id === 'variance').stats;
  ck('重跑：旧 pending 失效，pendingCount 仍只数最新一批', stats2.pendingCount === 1, stats2);
  ck('返回值带失效数', rB.expired === 1, rB.expired);
  const st = JSON.parse(fs.readFileSync(path.join(process.env.SKILL_DATA_DIR, 'state.json'), 'utf8'));
  const oldR = st.results.find(x => x.resultId === rA.result.resultId);
  ck('旧结果 item 标记为 expired（不再 pending）', oldR && oldR.items.every(i => i.status === 'expired'), oldR && oldR.items);
}

console.log('\n[运行时 · 引用性条目不进待确认，但仍在周报风险节]');
{
  /* 一批【只有】产能偏差的输入：风险清单里有条目，待确认里必须一条都没有 */
  const capOnly = {
    now, repos: [],
    deviations: [{ team: 'TC', workload: 120, head: 5, capacity: 80, over: 40, ratio: 0.5, verdict: '产能不足', workloadOverridden: false }],
    reconcile: [], history: [], plans: [], evidence: {}
  };
  const rc = engine.run('risk', capOnly);
  ck('risk 输出条目仍在（供周报引用）', rc.ok && (rc.result.output.items || []).some(i => i.id === 'risk-cap-TC'), rc.result.output.items);
  ck('★ 引用性条目一条都不进待确认队列', rc.result.items.length === 0, rc.result.items);

  const rr = engine.run('report', capOnly);
  ck('周报风险节仍引用了产能偏差', rr.ok && rr.result.output.sections.risks.indexOf('TC') >= 0,
    rr.result.output && rr.result.output.sections.risks);
}

console.log('\n[Skill4 健康度评估器 · 四维记分卡]');
{
  const health = require('./modules/skill/skills/health');

  const h1 = health.assess({ now, deviations: [], repos: [], risks: [] });
  ck('全正常 → 综合绿灯 100 分，4 维全绿，无待确认项',
    h1.card.overall.light === 'green' && h1.card.overall.score === 100 &&
    h1.card.dimensions.every(d => d.light === 'green') && h1.items.length === 0, h1.card);

  const h2 = health.assess({ now, repos: [], risks: [],
    deviations: [{ team: 'A', head: 2, ratio: 0.6, over: 40 }] });
  ck('最大偏差 60% → 进度维度红灯', h2.card.dimensions[0].light === 'red' && h2.card.dimensions[0].score <= 30, h2.card.dimensions[0]);

  const h3 = health.assess({ now, repos: [], risks: [],
    deviations: [{ team: 'A', head: 2, ratio: 0.3, over: 10 }] });
  ck('最大偏差 30% → 进度维度黄灯', h3.card.dimensions[0].light === 'yellow', h3.card.dimensions[0]);

  const h4 = health.assess({ now, repos: [], risks: [],
    deviations: [{ team: 'A', head: 0, ratio: 0 }, { team: 'B', head: 0, ratio: 0 }] });
  ck('2 队缺人头 → 人力维度黄灯', h4.card.dimensions[1].light === 'yellow', h4.card.dimensions[1]);

  const h5 = health.assess({ now, repos: [], risks: [],
    deviations: [{ team: 'A', head: 0, ratio: 0 }, { team: 'B', head: 0, ratio: 0 }, { team: 'C', head: 0, ratio: 0 }] });
  ck('3 队缺人头 → 人力维度红灯', h5.card.dimensions[1].light === 'red', h5.card.dimensions[1]);

  const h6 = health.assess({ now, risks: [],
    repos: [{ id: 'r1', name: '仓A', ok: true, lastCommitAt: new Date(now - 20 * DAY).toISOString() }] });
  ck('1 仓静默 20 天 → 代码维度黄灯', h6.card.dimensions[2].light === 'yellow', h6.card.dimensions[2]);

  const h7 = health.assess({ now, deviations: [], repos: [],
    risks: [{ severity: '中' }, { severity: '中' }] });
  ck('加权分：仅 2 条中风险 → 综合 96 分绿灯',
    h7.card.overall.score === 96 && h7.card.overall.light === 'green', h7.card.overall);

  const h8 = health.assess({ now, repos: [],
    deviations: [{ team: 'A', head: 1, ratio: 0.51, over: 10 }],
    risks: [{ severity: '高' }, { severity: '高' }, { severity: '高' }] });
  ck('进度红 + 风险红（双红）→ 综合强制红灯', h8.card.overall.light === 'red', h8.card);

  const h9 = health.assess({ now, repos: [],
    deviations: [{ team: 'A', head: 0, ratio: 0.51, over: 10 }], risks: [] });
  ck('非绿灯维度落待确认项（severity 随灯色）',
    h9.items.length === 2 && h9.items.some(i => i.severity === '高' && i.id === 'health-schedule') && h9.items.some(i => i.severity === '中' && i.id === 'health-capacity'), h9.items);
}

console.log('\n[Skill5 Git/PR 信号分析器 · 关联表 + 信号]');
{
  const gitsig = require('./modules/skill/skills/gitsignals');
  const activeRepo = { id: 'r1', name: '仓A', ok: true, lastCommitAt: new Date(now - 3 * DAY).toISOString() };

  const g1 = gitsig.analyze({ now, repos: [activeRepo], git: { stats: { byLevel: { L1: 5, L2: 0, L3: 3, L4: 0 }, commitCount: 8 }, l2Pending: 0 } });
  ck('全正常 → 0 信号 0 待确认项', g1.signals.length === 0 && g1.items.length === 0, g1.signals);

  const g2 = gitsig.analyze({ now, repos: [{ id: 'r1', name: '仓A', ok: true, lastCommitAt: new Date(now - 20 * DAY).toISOString() }], git: {} });
  ck('20 天无提交 → repo-stale 中', g2.signals.some(s => s.type === 'repo-stale' && s.severity === '中'), g2.signals);

  const g3 = gitsig.analyze({ now, repos: [{ id: 'r1', name: '仓A', ok: true, lastCommitAt: new Date(now - 25 * DAY).toISOString() }], git: {} });
  ck('25 天无提交 → repo-stale 高', g3.signals.some(s => s.type === 'repo-stale' && s.severity === '高'), g3.signals);

  const g4 = gitsig.analyze({ now, repos: [{ id: 'r1', name: '仓A', ok: false, error: 'ENOENT' }], git: {} });
  ck('采集失败 → repo-fail（不叠 repo-stale）', g4.signals.length === 1 && g4.signals[0].type === 'repo-fail', g4.signals);

  const g5 = gitsig.analyze({ now, repos: [activeRepo], git: { stats: { byLevel: { L4: 6 }, commitCount: 10 }, l2Pending: 0 } });
  ck('L4 占 60%（样本≥10）→ unmapped-pileup 关联缺口', g5.signals.some(s => s.type === 'unmapped-pileup'), g5.signals);

  const g6 = gitsig.analyze({ now, repos: [activeRepo], git: { stats: { byLevel: { L4: 4 }, commitCount: 5 }, l2Pending: 0 } });
  ck('样本 <10 不评关联率（小仓不报错）', !g6.signals.some(s => s.type === 'unmapped-pileup'), g6.signals);

  const g7 = gitsig.analyze({ now, repos: [activeRepo], git: { stats: { byLevel: {}, commitCount: 0 }, l2Pending: 2 } });
  ck('L2 待确认 2 条 → l2-stagnant 低', g7.signals.some(s => s.type === 'l2-stagnant' && s.severity === '低'), g7.signals);

  const g8 = gitsig.analyze({ now, repos: [activeRepo], git: { stats: { byLevel: { L1: 5, L2: 1, L3: 3, L4: 2 }, commitCount: 11 }, l2Pending: 0 } });
  ck('关联表四级分布合计 = commitCount', g8.mappingTable.reduce((a, x) => a + x.count, 0) === 11, g8.mappingTable);
  ck('诚实声明：PR/CI 未接入写入 notes', (g8.notes || []).some(n => n.indexOf('M2-C') >= 0), g8.notes);
}

console.log('\n[运行时 · 新 Skill（health/gitsignals）待确认接通]');
{
  const hIn = { now, repos: [], deviations: [{ team: 'A', head: 0, ratio: 0.6, over: 10 }], reconcile: [], history: [], plans: [], evidence: {} };
  const rh = engine.run('health', hIn);
  ck('run(health) 非绿灯维度进待确认队列（normalizeItems 已注册）', rh.ok && rh.result.items.length >= 2, rh.result.items);
  const rg = engine.run('gitsignals', { now, repos: [{ id: 'r1', name: '仓A', ok: true, lastCommitAt: new Date(now - 20 * DAY).toISOString() }], git: { stats: { byLevel: { L4: 6 }, commitCount: 10 }, l2Pending: 0 } });
  ck('run(gitsignals) 信号进待确认队列', rg.ok && rg.result.items.length >= 2, rg.result.items);
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);