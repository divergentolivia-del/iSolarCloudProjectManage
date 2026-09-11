/* 用真实钉钉导出文件验证「解析 → 预览数据 → 落库」这条链路的每一段。
   只跑服务端能做的那半段（内核 + 计数），预览页 DOM 由人工验证。 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const core = require('./modules/plan/import-core.js');

const files = [
  'E:/PMWork/Project Materials/iSolarCloudProject/Agent智能体项目/Agent平台智能体项目管理计划.xlsx'
];

/* 与前端 importCounts() 保持一致的统计口径：预览页「共 N 行」就取这个和 */
function importCounts(plan) {
  const keys = ['overview', 'milestones', 'tasks', 'marketPlan', 'issues', 'risks', 'resources', 'members', 'references'];
  const out = {};
  keys.forEach(k => { out[k] = ((plan || {})[k] || []).length; });
  return out;
}

let bad = 0;
const check = (ok, msg) => { if (!ok) { bad++; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

files.forEach(f => {
  if (!fs.existsSync(f)) { console.log('!! 文件不存在: ' + f); return; }
  console.log('\n========================================');
  console.log('文件: ' + path.basename(f));
  let r;
  try { r = core.parseWorkbook(fs.readFileSync(f), XLSX, { planName: 'Agent 平台智能体项目计划' }); }
  catch (e) { console.log('解析异常: ' + e.message + '\n' + e.stack); bad++; return; }

  console.log('来源识别: ' + r.source);
  const counts = importCounts(r.plan);
  console.log('表单填充: ' + JSON.stringify(counts));
  console.log('计划名: ' + r.plan.name + ' | 负责人: ' + r.plan.owner + ' | 起止: ' + r.plan.startDate + ' ~ ' + r.plan.endDate);

  /* 1) 每张已归属的表，行数必须和导入后的条目数一致（差一即丢数据） */
  console.log('\n-- 行数一致性 --');
  (r.sheets || []).forEach(s => {
    const got = (r.plan[s.form] || []).length;
    check(got === s.rows, `${s.label}「${s.sheetName}」表里 ${s.rows} 行 → 表单 ${got} 条`);
  });

  /* 2) 预览页要展示的东西必须齐（缺一个前端就白屏） */
  console.log('\n-- 预览字段完备性 --');
  (r.sheets || []).forEach(s => {
    const miss = ['form', 'label', 'sheetName', 'rows', 'tier', 'confidence', 'mappedCols', 'unmatchedHeaders']
      .filter(k => s[k] === undefined || s[k] === null);
    check(miss.length === 0, `「${s.sheetName}」缺字段: ${miss.join(',') || '无'}`);
  });
  (r.skipped || []).forEach(s => {
    check(!!s.sheetName && !!s.reason, `跳过表「${s.sheetName}」有表名和原因`);
  });
  (r.diagnostics || []).forEach(d => {
    check(['dangling', 'selfRef', 'cycle', 'ambiguous'].indexOf(d.kind) >= 0, `诊断类型合法: ${d.kind}`);
  });

  /* 3) 层级：子行的 parentId 必须能指向同表内的真实 id */
  console.log('\n-- 层级完整性 --');
  ['tasks', 'overview', 'marketPlan', 'references'].forEach(k => {
    const list = r.plan[k] || [];
    const ids = {};
    list.forEach(x => { ids[x.id] = true; });
    const orphan = list.filter(x => x.parentId && !ids[x.parentId]);
    check(orphan.length === 0, `${k}: ${list.length} 条，悬空 parentId ${orphan.length} 条`);
    const roots = list.filter(x => !x.parentId).length;
    console.log(`     ${k}: 根 ${roots} / 子 ${list.length - roots}`);
  });

  if (bad) { console.log('\n❌ 失败 ' + bad + ' 项'); process.exit(1); }
  console.log('\n✅ 全部通过');
});
