// 审计用：生成一份含深层级（0~5 层）的计划数据，用于压测缩进渲染是否溢出
const fs = require('fs');
let n = 0;
const uid = p => `${p}-${++n}`;

// 生成一条 depth 链：root -> 1.1 -> 1.1.1 -> ... 共 levels 层
function chain(prefix, levels, extra) {
  const out = [];
  let parentId = '';
  for (let d = 0; d < levels; d++) {
    const id = uid(prefix);
    out.push(Object.assign({
      id, parentId,
      name: d === 0 ? `顶层阶段（第0层）` : `第${d}层子项名称占位文字加长一点看会不会溢出`,
      owner: '张三', startDate: '2026-09-01', endDate: '2026-09-30',
      status: 'not-started', progress: 0, deliverable: '交付物', note: '备注'
    }, extra || {}));
    parentId = id;
  }
  return out;
}

const plan = {
  id: 'audit-plan-1',
  name: '【审计】深层级渲染压测计划',
  projectId: '', projectName: '云平台',
  year: 2026, owner: '陈丹萍', status: 'active',   // 计划状态合法值：draft/active/completed/archived
  startDate: '2026-09-01', endDate: '2026-12-31',
  description: '自动化审计用，验收后删除',
  overview: chain('ov', 6),
  tasks: chain('tk', 6).map(x => ({
    id: x.id, parentId: x.parentId, name: x.name, owner: x.owner,
    startDate: x.startDate, endDate: x.endDate, status: x.status,
    progress: x.progress, plannedHours: 123456, wbsCode: '', dependsOn: '', note: x.note
  })),
  references: chain('rf', 6).map(x => ({
    id: x.id, parentId: x.parentId, title: x.name, stage: '立项',
    submitted: false, owner: x.owner, url: '', note: x.note
  })),
  marketPlan: chain('mk', 6),
  milestones: [{ id: 'ms-1', name: '里程碑一', date: '2026-10-01', status: 'not-started', owner: '李四', note: '' }],
  issues: [{ id: 'is-1', title: '遗留问题一', status: 'open', owner: '王五', dueDate: '2026-10-10', note: '' }],
  risks: [{ id: 'rk-1', title: '风险一', status: 'open', owner: '赵六', mitigation: '缓解措施', note: '' }],
  resources: [{ id: 'rs-1', name: '前端', role: '开发', allocation: 50, note: '' }],
  members: [{ id: 'mb-1', name: '陈丹萍', role: '项目经理', dept: 'PMO', contact: '', note: '' }]
};

fs.writeFileSync('data/plan/state.json', JSON.stringify({
  rev: 1, updatedAt: new Date().toISOString(), updatedBy: 'audit', plans: [plan]
}, null, 2));
console.log('seeded: overview/tasks/references/marketPlan 各 6 层深度');
