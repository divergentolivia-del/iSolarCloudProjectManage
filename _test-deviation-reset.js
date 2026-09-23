// 回归测试：导入 / TB 同步后，偏差表里手工钉住的「版本工作量」必须作废
//
// 背景（2026-09-23 线上问题）：override 一旦写入就永久生效且优先级高于权威值，
// 上月手工调过的团队，本月导入新数据后会继续显示上月的数字 —— 数字合法、格式正常，
// 肉眼查不出来。这里把「清掉」这件事钉成测试，防止以后被改回去。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/* calc.js 依赖 config.js 的全局量（浏览器里由 <script src="config.js"> 提供），
   Node 下必须先挂到 global，否则 require('./calc') 会在 TEAMS 上炸 */
const configSource = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
const configFn = new Function(configSource +
  '\nreturn { TEAMS, PRODUCT_LINES, OTHER_CATEGORIES, LOCK_ROLES, LOCK_ROLE_TO_TEAM,' +
  ' OWNER_LINES, DEVIATION_TOLERANCE, IGNORED_TEAM_PATTERNS, RECONCILE_TOLERANCE };');
Object.assign(global, configFn());

let pass = 0, fail = 0;
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

/* ---------- 第一层：calc.clearWorkloadOverrides 本身 ---------- */
console.log('\n[1] clearWorkloadOverrides：只清 workload，不动 head');
{
  const calc = require('./calc');
  const state = {
    deviationOverrides: {
      '后端开发-阳光云': { workload: 323.5 },
      '后端开发-平台': { workload: 98.5, head: 12 },   // 同时钉了人头
      'Web开发-阳光云': { head: 9 },                    // 只钉人头 —— 不该被动
      '测试部-应用软件测试-云服务': { workload: 608 }
    }
  };
  const cleared = calc.clearWorkloadOverrides(state);
  ck('返回被清的 3 个团队', cleared.length === 3, cleared);
  ck('workload 已清', state.deviationOverrides['后端开发-阳光云'] === undefined,
    state.deviationOverrides);
  ck('同一条上的 head 保留', state.deviationOverrides['后端开发-平台'].head === 12,
    state.deviationOverrides['后端开发-平台']);
  ck('只钉 head 的条目不受影响',
    state.deviationOverrides['Web开发-阳光云'] && state.deviationOverrides['Web开发-阳光云'].head === 9,
    state.deviationOverrides['Web开发-阳光云']);
  ck('清空后的空对象已删除', state.deviationOverrides['后端开发-阳光云'] === undefined);
  ck('workload 清掉后 compute 取回权威值', (() => {
    const st = {
      deviationOverrides: { '后端开发-阳光云': { workload: 323.5 } },
      totals: [{ team: '后端开发-阳光云', iteration: '9月迭代', story: 29.25, est: 0 }],
      iterations: [{ name: '9月迭代', selected: true }],
      cycles: [{ name: '9月', workdays: 22, saturdays: 2, active: true }],
      headcount: { '后端开发-阳光云': { regular: 5, outsource: 0 } }
    };
    const before = calc.compute(st).deviation.find(d => d.team === '后端开发-阳光云').workload;
    calc.clearWorkloadOverrides(st);
    const after = calc.compute(st).deviation.find(d => d.team === '后端开发-阳光云').workload;
    return before === 323.5 && after === 29.25;
  })());

  // 幂等：没有 override 时返回空数组，不抛错
  const empty = calc.clearWorkloadOverrides({});
  ck('无色值时返回空数组且不抛错', Array.isArray(empty) && empty.length === 0);
}

/* ---------- 第二层：TB 同步写入路径 ---------- */
console.log('\n[2] TB applySyncToState：同步即清除，并回报被清的团队');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-devreset-'));
  process.env.DATA_DIR = tmp;
  fs.mkdirSync(path.join(tmp, 'iteration'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tb'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'iteration', 'state.json'), JSON.stringify({
    cycles: [{ name: '9月迭代-月末', workdays: 22, saturdays: 2, active: true }],
    headcount: {}, locked: [], totals: [], board: [], iterations: [],
    deviationOverrides: {
      '后端开发-阳光云': { workload: 323.5 },
      '后端开发-平台': { workload: 98.5 },
      'Web开发-阳光云': { workload: 232.5, head: 8 },
      '测试部-应用软件测试-云服务': { workload: 608 }
    },
    rev: 421
  }), 'utf8');

  const tbRoutes = require('./modules/tb/routes');
  const fakeResult = {
    cloudRows: [{ team: '后端开发-阳光云', iteration: '9月迭代', story: 29.25, est: 0 }],
    middleRows: [{ team: '后端开发-平台', iteration: '9月迭代', story: 132, est: 0 }],
    boardRows: [],
    stats: { cloud: { name: '云' }, middle: { name: '中' }, productLine: { name: '线' } }
  };
  const applied = tbRoutes.applySyncToState(fakeResult, '测试', {}, {});

  ck('返回对象带 rev', typeof applied.rev === 'number' && applied.rev === 422, applied);
  ck('回报 4 个团队的手工值被清', Array.isArray(applied.clearedOverrides)
    && applied.clearedOverrides.length === 4, applied.clearedOverrides);

  const written = JSON.parse(fs.readFileSync(path.join(tmp, 'iteration', 'state.json'), 'utf8'));
  ck('落盘后 workload 全部清空',
    Object.keys(written.deviationOverrides || {}).every(k => written.deviationOverrides[k].workload === undefined),
    written.deviationOverrides);
  ck('只钉 head 的那部分保留', written.deviationOverrides['Web开发-阳光云']
    && written.deviationOverrides['Web开发-阳光云'].head === 8, written.deviationOverrides);
  ck('新数据已写入 totals', written.totals.length === 2, written.totals.length);

  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  delete process.env.DATA_DIR;
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
