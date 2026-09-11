/* 项目计划 · Excel 导入内核自测（modules/plan/import-core.js）

   覆盖三类来源，都是纯函数级测试（不落库、不起服务）：
     1) 平台自己导出的文件 → 必须 1:1 往返（层级、枚举、人天、关联都不丢）
     2) 钉钉多维表导出     → 按表头智能映射，废弃/草稿/备份表跳过
     3) 完全无关的表格     → 支持导入但只填能对上的列，且不静默占用表单

   为什么单独测这一层：解析器是全流程里唯一「猜」的地方（列名→字段、表名→表单），
   猜错不会报错，只会静默丢数据，所以必须有断言盯着。 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const XLSX = require('xlsx');

const core = require('./import-core.js');

/* ─── 造一个平台导出格式的工作簿（含 _元信息 表，触发平台解析分支） ─── */
function platformWorkbook() {
  const wb = XLSX.utils.book_new();
  const put = (name, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);

  put('基本信息', [
    ['字段', '值'],
    ['计划名称', '平台导出往返测试'],
    ['负责人', '张三'],
    ['开始日期', '2026-03-01'],
    ['结束日期', '2026-09-30'],
    ['状态', '进行中']
  ]);
  put('里程碑', [
    ['里程碑', '日期', '状态', '负责人', '说明', '_id'],
    ['TR2 评审', '2026-04-15', '已完成', '张三', '规格书冻结', 'm1'],
    ['TR3 评审', '2026-06-20', '进行中', '李四', '', 'm2']
  ]);
  put('WBS任务', [
    ['层级', '名称', '类型', '状态', '优先级', '负责人', '主责部门', '人天', '进度%', '开始', '结束', 'WBS编码', '依赖', '备注', '_id', '_parentId'],
    ['1', '需求开发', '开发', '进行中', '高', '张三', '研发', 10, 50, '2026-03-01', '2026-04-30', '1', '', '', 't1', ''],
    ['1.1', '　接口联调', '开发', '未开始', '中', '李四', '研发', 5, 0, '2026-05-01', '2026-05-20', '1.1', '', '', 't2', 't1']
  ]);
  put('遗留问题', [
    ['问题编号', '遗留问题描述', '应对方案', '责任人', '预计闭环时间', '当前进展', '结论', '当前状态', '_id'],
    ['1', '工单系统对接路径有争议', '已裁剪该需求', '王五', '2026-07-31', '已闭环', '不再跟进', '已关闭', 'is1']
  ]);
  put('项目风险', [
    ['风险类型', '风险描述', '应对方案', '责任人', '计划闭环时间', '风险状态', '进展状态', '_id'],
    ['进度风险', '人力不足', '申请外协', '赵六', '2026-08-31', '观察中', '跟进中', 'rk1']
  ]);
  put('_元信息', [
    ['键', '值'],
    ['schema', '1'],
    ['planId', 'plan-orig-1'],
    ['planName', '平台导出往返测试'],
    ['exportedAt', '2026-03-01T10:00:00Z'],
    ['exportedBy', '张三'],
    ['说明', '本表仅供平台自身识别，导入时忽略']
  ]);
  return wb;
}

function dingtalkWorkbook() {
  const wb = XLSX.utils.book_new();
  const put = (name, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);

  put('项目总览', [
    ['任务名称', '负责人', '计划开始时间', '计划完成时间', '需求状态', '进度', 'Parent Record'],
    ['Agent 平台建设', '陆伟', '2026-07-21', '2027-06-30', '进行中', '37%', ''],
    ['第一阶段', '陆伟', '2026-07-21', '2026-12-31', '未开始', '0%', 'Agent 平台建设']
  ]);
  put('团队分工与执行计划', [
    ['能力名称', '能力类型', '需求状态', '负责人', '主责部门', '计划工时（人天）', '进度', '计划开始时间', '计划完成时间', 'Parent Record'],
    ['开放平台与集成', '开发', '未开始', '陆伟', '后端', 20, '0%', '2026-08-01', '2026-08-31', ''],
    ['Skill 管理', '开发', '已完成', '陆伟', '后端', 8, '100%', '2026-08-01', '2026-08-31', '开放平台与集成']
  ]);
  put('遗留问题', [
    ['问题编号', '遗留问题描述', '应对方案', '责任人', '预计闭环时间', '当前状态'],
    ['1', '工单对接路径争议', '已裁剪', '邓荣', '2026-08-31', '待处理']
  ]);
  put('项目风险', [
    ['风险类型', '风险描述', '应对方案', '责任人', '计划闭环时间', '风险状态'],
    ['其他风险', '职责分工不明确', '输出责任矩阵', '黄义祥', '2026-08-30', '观察中']
  ]);
  put('资源需求', [
    ['部门团队', '资源需求（人月）'],
    ['SE', 6],
    ['后端', 12]
  ]);
  put('能力目录（废弃）', [['能力名称'], ['不该被导入']]);
  put('依赖关系（草稿）', [['前置'], ['不该被导入']]);
  put('功能拆解 (备份)', [['功能'], ['不该被导入']]);
  return wb;
}

function unrelatedWorkbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['客户名称', '合同金额', '账期', '状态'],
    ['某公司', 100000, '30天', '已完成']
  ]), '应收账款');
  return wb;
}

const toBuf = wb => XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
const parse = wb => core.parseWorkbook(toBuf(wb), XLSX, {});

/* ─────────────────────── 1. 平台导出 1:1 往返 ─────────────────────── */
test('平台导出的文件能被识别并 1:1 读回', () => {
  const r = parse(platformWorkbook());
  assert.equal(r.source, 'platform-export');
  assert.equal(r.plan.name, '平台导出往返测试');
  assert.equal(r.plan.owner, '张三');
  assert.equal(r.plan.startDate, '2026-03-01');
  assert.equal(r.plan.endDate, '2026-09-30');
});

test('往返不丢层级：_id / _parentId 原样带过', () => {
  const r = parse(platformWorkbook());
  const t1 = r.plan.tasks.find(t => t.name === '需求开发');
  const t2 = r.plan.tasks.find(t => t.name === '接口联调');   // 导出带全角缩进，须被剥掉
  assert.ok(t1 && t2, '两条任务都应在');
  assert.equal(t1.id, 't1', '平台导出必须原样保留 _id，否则回导后关联会断');
  assert.equal(t2.id, 't2');
  assert.equal(t2.parentId, 't1', '子任务的 parentId 应指向父任务的 id');
  assert.equal(t1.parentId, '');
});

test('往返不丢枚举：中文标签反查回英文枚举', () => {
  const r = parse(platformWorkbook());
  const inprog = r.plan.tasks.find(t => t.name === '需求开发');
  assert.equal(inprog.status, 'in-progress');
  assert.equal(inprog.priority, 'high');
  assert.equal(inprog.type, 'dev');
  const ms = r.plan.milestones.find(m => m.name === 'TR2 评审');
  assert.equal(ms.status, 'done');
  const iss = r.plan.issues[0];
  assert.equal(iss.status, 'closed');
  const rk = r.plan.risks[0];
  assert.equal(rk.type, 'schedule');
  assert.equal(rk.status, 'watching');
});

test('往返不丢数值：人天 / 进度解析成数字', () => {
  const r = parse(platformWorkbook());
  const t1 = r.plan.tasks.find(t => t.name === '需求开发');
  assert.equal(t1.plannedHours, 10);
  assert.equal(t1.progress, 50);
});

/* ─────────────────────── 2. 钉钉导出映射 ─────────────────────── */
test('钉钉导出按表头映射到各表单', () => {
  const r = parse(dingtalkWorkbook());
  assert.equal(r.source, 'dingtalk');
  assert.equal(r.summary.tasks, 2);
  assert.equal(r.summary.overview, 2);
  assert.equal(r.summary.issues, 1);
  assert.equal(r.summary.risks, 1);
  assert.equal(r.summary.resources, 2);
});

test('钉钉导出的废弃 / 草稿 / 备份表一律跳过', () => {
  const r = parse(dingtalkWorkbook());
  const skippedNames = r.skipped.map(s => s.sheetName);
  ['能力目录（废弃）', '依赖关系（草稿）', '功能拆解 (备份)'].forEach(n => {
    assert.ok(skippedNames.indexOf(n) >= 0, n + ' 应被跳过');
  });
  // 更要紧的是：这三张表的数据一行都不能漏进任何表单
  const all = [].concat(r.plan.tasks, r.plan.overview, r.plan.milestones)
    .map(x => x.name || x.title || '');
  assert.ok(all.indexOf('不该被导入') < 0, '废弃表的数据不应出现在任何表单里');
});

test('钉钉的表名判别词直接给出强匹配', () => {
  const r = parse(dingtalkWorkbook());
  const bySheet = {};
  r.sheets.forEach(s => { bySheet[s.sheetName] = s; });
  assert.equal(bySheet['项目总览'].form, 'overview');
  assert.equal(bySheet['团队分工与执行计划'].form, 'tasks');
  assert.equal(bySheet['资源需求'].form, 'resources');
  assert.equal(bySheet['项目风险'].form, 'risks');
  assert.equal(bySheet['项目总览'].tier, 'strong');
});

test('钉钉的「Parent Record」父名能还原成层级', () => {
  const r = parse(dingtalkWorkbook());
  const parent = r.plan.tasks.find(t => t.name === '开放平台与集成');
  const child = r.plan.tasks.find(t => t.name === 'Skill 管理');
  assert.equal(child.parentId, parent.id);
});

/* ─────────────────────── 3. 无关表格 ─────────────────────── */
test('无关表格不会静默占用平台表单', () => {
  const r = parse(unrelatedWorkbook());
  // 「客户名称」只蹭到通用别名「名称」，判别列不足 → 整表该被跳过
  assert.equal(r.sheets.length, 0, '不应有表被自动归属');
  assert.ok(r.skipped.length >= 1, '应出现在跳过列表里，供用户手动指定');
});

/* ─────────────────────── 4. 手动指定归属 ─────────────────────── */
test('手动指定能把被跳过的表强行绑到某个表单', () => {
  const wb = unrelatedWorkbook();
  const forced = core.parseWorkbook(toBuf(wb), XLSX, {
    sheetOverrides: { '应收账款': 'references' }
  });
  assert.equal(forced.sheets.length, 1);
  assert.equal(forced.sheets[0].form, 'references');
  assert.equal(forced.plan.references.length, 1, '1 行应收数据应变成 1 条参考文档');
});

/* ─────────────────────── 5. 容错 ─────────────────────── */
test('空工作簿不抛异常，返回空结果', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['随便什么']]), 'Sheet1');
  const r = core.parseWorkbook(toBuf(wb), XLSX, {});
  assert.ok(r.plan, '应返回 plan 对象而不是抛错');
  assert.equal(r.sheets.length, 0);
});
