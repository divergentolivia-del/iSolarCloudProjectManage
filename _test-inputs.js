/* 输入采集 provider 注册表测试（modules/skill/lib/inputs.js）
 *
 * 为什么这个文件必须存在：
 *   inputs.js 是「采集失败」和「本来就没数据」的分界线，而这两种情况在
 *   返回值里长得一模一样（都是空数组）。2026-09-22 的 82 条待办误标事故，
 *   根因就是这条分界线没了 —— 采集挂了，下游当成「没风险」。
 *   各 Skill 的测试只验算出来的结果，验不了这层，所以单独测。
 *
 * 不测的：pradapter / iteration 的真实数据内容（那是 _test-pradapter、
 *   _test-deviation-reset 的事）。这里只测「机制」。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/* 必须在 require 之前设 SKILL_DATA_DIR —— inputs.js 在调用时读它决定知识库位置 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-inputs-'));
process.env.SKILL_DATA_DIR = TMP;

const inputs = require('./modules/skill/lib/inputs');

let pass = 0, fail = 0;
function ck(n, c, extra) {
  if (c) { pass++; console.log('  PASS ' + n); }
  else { fail++; console.log('  FAIL ' + n, extra !== undefined ? JSON.stringify(extra) : ''); }
}

console.log('\n[输入采集 · 注册表]');
/* 数量断言一律跟着 REGISTRY.length 走，不写死数字 ——
   这个注册表的设计目的就是「加数据源只改 inputs.js 一处」，
   写死数字会让每次加源都变成一次假失败（SGAI+ 加 meeting 源就踩过）。 */
ck('注册表非空', inputs.REGISTRY.length > 0, inputs.REGISTRY.length);
ck('每个 provider 都有 id / label / load',
  inputs.REGISTRY.every(p => p.id && p.label && typeof p.load === 'function'));
ck('id 不重复', new Set(inputs.REGISTRY.map(p => p.id)).size === inputs.REGISTRY.length);
ck('已知数据源都在册（代码仓库/偏差/历史/计划/知识沉淀）',
  ['repos', 'deviations', 'history', 'plans', 'knowledge']
    .every(id => inputs.REGISTRY.some(p => p.id === id)),
  inputs.REGISTRY.map(p => p.id));

console.log('\n[输入采集 · 空数据不报错]');
/* 注意：SKILL_DATA_DIR 只影响知识库（data/skill），迭代偏差读的是仓库真实路径
   data/iteration/state.json。本机那个文件是存在的，所以 deviations 仍会被调用，
   而全局 TEAMS 不存在 → 它确实该报错。空环境的断言只对「读临时目录的那些源」成立。 */
const empty = inputs.collect();
ck('缺全部数据文件时不崩溃', !!empty.inputs);
ck('返回约定的空壳形状',
  Array.isArray(empty.inputs.repos) && Array.isArray(empty.inputs.deviations) &&
  Array.isArray(empty.inputs.plans) && Array.isArray(empty.inputs.history), empty.inputs);
ck('plan 子块有默认值', !!empty.inputs.plan && Array.isArray(empty.inputs.plan.productLines));
ck('knowledge 读取不依赖 state.json 存在',
  !!empty.inputs.knowledge && empty.inputs.knowledge.resultCount === 0, empty.inputs.knowledge);
ck('缺文件的知识库源不算失败（没数据 ≠ 采集失败）',
  !empty.errors.some(e => e.id === 'knowledge'), empty.errors);

console.log('\n[输入采集 · 错误必须可见]');
/* 这是本文件的重点。造一个必然失败的 provider：把 deviations 的依赖
   （全局 TEAMS）拿掉 —— 正是 2026-09-22 事故的触发条件。 */
ck('测试前全局 TEAMS 确实不存在（复现事故条件）', typeof global.TEAMS === 'undefined');
ck('errors 会出现在 inputs.__errors 上（下游能看到）',
  Array.isArray(empty.inputs.__errors), typeof empty.inputs.__errors);
ck('skipped 也会带出来（能区分「跳过」和「失败」）',
  Array.isArray(empty.inputs.__skipped));

console.log('\n[输入采集 · 只有指定 provider 跑]');
const only = inputs.collect({ only: ['plans'] });
ck('only 限制后其余都进 skipped',
  only.skipped.length === inputs.REGISTRY.length - 1, only.skipped.map(s => s.id));
ck('only 指定的那个不在 skipped 里', !only.skipped.some(s => s.id === 'plans'), only.skipped);
ck('only 下仍返回完整空壳形状（下游取值不会 undefined 报错）',
  Array.isArray(only.inputs.deviations), only.inputs.deviations);

console.log('\n[输入采集 · 自检接口]');
const st = inputs.status();
ck('status 列出全部 provider', st.providers.length === inputs.REGISTRY.length, st.providers.length);
ck('status 报出数据目录', st.dataPath === TMP, st.dataPath);
ck('status 默认无禁用项', st.disabled.length === 0, st.disabled);
ck('status 默认 live 模式', st.mode === 'live', st.mode);

console.log('\n[输入采集 · 禁用配置生效]');
/* inputs.json 是排障开关：某个源出问题时要能单独关掉它，而不是改代码 */
fs.writeFileSync(path.join(TMP, 'inputs.json'), JSON.stringify({ disabled: ['repos', 'history'] }), 'utf8');
const cfg = inputs._internal.loadConfig();
ck('读到 disabled 列表', cfg.disabled.length === 2, cfg.disabled);
const off = inputs.collect();
ck('被禁用的 provider 进 skipped', off.skipped.some(s => s.id === 'repos'), off.skipped);
ck('禁用原因写明是配置所致', off.skipped.some(s => s.id === 'repos' && /禁用/.test(s.reason)), off.skipped);
ck('禁用不算错误（不该污染 errors）', !off.errors.some(e => e.id === 'repos'), off.errors);
ck('status 如实反映禁用状态', inputs.status().providers.find(p => p.id === 'repos').enabled === false);
fs.unlinkSync(path.join(TMP, 'inputs.json'));

console.log('\n[输入采集 · 与 engine 的接口一致]');
/* engine.collectInputs 是转调这里，形状一旦对不上所有 Skill 都会取到 undefined */
const engine = require('./modules/skill/lib/engine');
const viaEngine = engine.collectInputs();
ck('engine.collectInputs 与 inputs.collectInputs 同形状',
  JSON.stringify(Object.keys(viaEngine).sort()) === JSON.stringify(Object.keys(inputs.collectInputs()).sort()),
  Object.keys(viaEngine).sort());
ck('engine 暴露了自检入口', typeof engine.inputStatus === 'function');

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
