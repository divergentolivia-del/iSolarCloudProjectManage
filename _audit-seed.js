// 审计用种子数据：含深层级（0~5 层）+ 各表使用合法枚举值，便于校验导出的字典翻译
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
      status: 'not-started', progress: 30, deliverable: '交付物', note: '备注'
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
    progress: x.progress, plannedHours: 123456, wbsCode: '', dependencies: ['T-1', 'T-2'],
    type: 'dev', priority: 'high', dept: '云平台', note: x.note
  })),
  references: chain('rf', 6).map(x => ({
    id: x.id, parentId: x.parentId, title: x.name, stage: 'TR4',
    status: 'submitted', dept: '系统部', owner: x.owner, date: '2026-09-15',
    requirement: '必选', link: 'https://example.com/tpl', note: x.note, type: 'design'
  })),
  marketPlan: chain('mk', 6),
  milestones: [{ id: 'ms-1', name: '里程碑一', date: '2026-10-01', status: 'in-progress', owner: '李四', desc: '首个交付节点' }],
  issues: [{ id: 'is-1', code: 'Q-01', desc: '遗留问题一', solution: '下版本修复', owner: '王五', dueDate: '2026-10-10', progress: '排查中', conclusion: '', status: 'processing' }],
  risks: [{ id: 'rk-1', type: 'schedule', desc: '风险一', solution: '增派人力', owner: '赵六', dueDate: '2026-11-01', status: 'watching', progress: '跟踪中' }],
  resources: [{ id: 'rs-1', name: '前端', kind: 'team', dept: 'WEB开发', total: 120, used: null, note: '' }],
  members: [{ id: 'mb-1', name: '陈丹萍', role: 'pm', dept: 'PMO', duty: '整体协调', contact: '' }]
};

fs.writeFileSync('data/plan/state.json', JSON.stringify({
  rev: 1, updatedAt: new Date().toISOString(), updatedBy: 'audit', plans: [plan]
}, null, 2));
console.log('seeded: 各表使用合法枚举值 + overview/tasks/references/marketPlan 各 6 层深度');
