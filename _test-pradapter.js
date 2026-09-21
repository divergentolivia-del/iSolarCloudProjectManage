// _test-pradapter.js — pradapter 映射引擎 + 静默告警 单测（纯函数，不依赖服务）
const map = require('./modules/pradapter/lib/map');
const alert = require('./modules/pradapter/lib/alert');

let pass = 0, fail = 0;
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const TASKS = [
  { id: '101', title: '登录页超时修复' },
  { id: '102', title: '导出报表功能' },
  { id: '103', title: '阳光云迭代专项锁定页面' }
];

console.log('\n[映射引擎 L1 · 显式任务号]');
{
  ck('#123 标题 → L1/123', map.matchCommit({ subject: '修复崩溃 #123', branch: 'main' }, TASKS).level === 'L1'
    && map.matchCommit({ subject: '修复崩溃 #123', branch: 'main' }, TASKS).taskId === '123');
  ck('Closes #456 → L1/456', map.matchCommit({ subject: 'Closes #456', branch: 'main' }, TASKS).taskId === '456');
  ck('fixes 789 → L1/789', map.matchCommit({ subject: 'fixes 789 的布局', branch: 'main' }, TASKS).taskId === '789');
  ck('分支 321_abc → L1/321', map.matchCommit({ subject: '布局调整', branch: 'feature/321_abc' }, TASKS).taskId === '321');
  ck('L1 置信度 0.95', map.matchCommit({ subject: '#888 x', branch: 'main' }, TASKS).confidence === 0.95);
  const known = map.matchCommit({ subject: 'x #101', branch: 'main' }, TASKS);
  ck('L1 任务库已知标注', known.reason.indexOf('已收录') >= 0, known.reason);
  const unk = map.matchCommit({ subject: 'x #777', branch: 'main' }, TASKS);
  ck('L1 任务库未收录标注', unk.reason.indexOf('暂未收录') >= 0, unk.reason);
}

console.log('\n[映射引擎 L2 · 语义相似]');
{
  const r = map.matchCommit({ subject: '修复登录页超时问题', branch: 'main' }, TASKS);
  ck('相似标题 → L2/101', r.level === 'L2' && r.taskId === '101', r);
  ck('L2 置信度 ∈ (0,1)', r.confidence > 0 && r.confidence < 1, r.confidence);
  const r2 = map.matchCommit({ subject: '导出报表功能优化', branch: 'main' }, TASKS);
  ck('导出报表 → L2/102', r2.level === 'L2' && r2.taskId === '102', r2);
  const r3 = map.matchCommit({ subject: '专项锁定交互改进', branch: 'main' }, TASKS);
  ck('专项锁定 → L2/103', r3.level === 'L2' && r3.taskId === '103', r3);
}

console.log('\n[映射引擎 L4 · 无法关联]');
{
  const r = map.matchCommit({ subject: '重构基础设施配置优化', branch: 'main' }, TASKS);
  ck('无关提交 → L4', r.level === 'L4' && r.taskId === undefined, r);
  const r2 = map.matchCommit({ subject: '文档更新', branch: 'docs/update' }, []);
  ck('空任务库 → L4', r2.level === 'L4', r2);
  const r3 = map.matchCommit({ subject: 'fix(ui): 按钮样式微调', branch: 'main' }, TASKS);
  ck('常规 fix 无任务号 → L4', r3.level === 'L4', r3);
}

console.log('\n[告警 · 仓库静默]');
{
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const repoFresh = { id: 'r1', name: '活跃仓库', lastCommitAt: new Date(now - 3 * day).toISOString() };
  const repoStale = { id: 'r2', name: '沉默仓库', lastCommitAt: new Date(now - 30 * day).toISOString() };
  const repoNever = { id: 'r3', name: '新仓库', lastCommitAt: null };

  const a1 = alert.computeAlerts({ repos: [repoFresh], now });
  ck('3 天前有提交 → 无告警', a1.length === 0, a1);
  const a2 = alert.computeAlerts({ repos: [repoStale], now });
  ck('30 天无提交 → repo-stale', a2.length === 1 && a2[0].kind === 'repo-stale', a2);
  const a3 = alert.computeAlerts({ repos: [repoNever], now });
  ck('从未采集 → repo-stale(从未)', a3.length === 1 && a3[0].message.indexOf('从未') >= 0, a3);
}

console.log('\n[告警 · 任务静默（有任务数据后生效）]');
{
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const tasks = [
    { id: 't1', title: '临近任务', due: new Date(now + 5 * day).toISOString().slice(0, 10), status_category: 'doing' },
    { id: 't2', title: '已完成任务', due: new Date(now + 3 * day).toISOString().slice(0, 10), status_category: 'done' },
    { id: 't3', title: '远期任务', due: new Date(now + 40 * day).toISOString().slice(0, 10), status_category: 'doing' }
  ];
  const repos = [
    { id: 'r1', name: '关联仓库', lastCommitAt: new Date(now - 30 * day).toISOString() },
    { id: 'r2', name: '活跃仓库', lastCommitAt: new Date(now - 2 * day).toISOString() }
  ];
  const mappings = [
    { repoId: 'r1', taskId: 't1' },
    { repoId: 'r1', taskId: 't2' },
    { repoId: 'r1', taskId: 't3' },
    { repoId: 'r2', taskId: 't1' }
  ];
  const a = alert.computeAlerts({ repos, mappings, tasks, now });
  ck('临近+静默 → task-stale 一条', a.filter(x => x.kind === 'task-stale').length === 1, a);
  ck('告警落在 r1/t1', a.some(x => x.kind === 'task-stale' && x.repoId === 'r1' && x.taskId === 't1'), a);
  ck('done 不报 / 远期不报 / 活跃仓库不报', !a.some(x => x.taskId === 't2' || x.taskId === 't3' || x.repoId === 'r2'), a);
}

console.log('\n[tokens / similarity 基本正确]');
{
  ck('英文 token 小写', map.tokens('Feat: Export CSV').includes('export'));
  ck('中文 bigram 切分', map.tokens('登录页超时').includes('登录') && map.tokens('登录页超时').includes('超时'));
  const s = map.similarity(map.tokens('登录页超时修复'), map.tokens('登录页超时'));
  ck('相似文本 similarity > 0.5', s > 0.5, s);
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);