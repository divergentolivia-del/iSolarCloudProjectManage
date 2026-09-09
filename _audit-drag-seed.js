// 拖拽测试夹具：构造多根 + 多子的树，便于验证「同级换序 / 改父节点 / 环引用拒绝」
const fs = require('fs');

const st = (id, parentId, name) => ({
  id, parentId, name,
  owner: '', startDate: '', endDate: '',
  status: 'not-started', progress: 0, deliverable: '', note: ''
});

// A(root) ├A1 ├A2   B(root) ├B1   C(root)
const overview = [
  st('A', '', 'A根'), st('A1', 'A', 'A1子'), st('A2', 'A', 'A2子'),
  st('B', '', 'B根'), st('B1', 'B', 'B1子'),
  st('C', '', 'C根')
];

const plan = {
  id: 'drag-plan', name: '【拖拽测试】计划', projectId: '', projectName: '云平台',
  year: 2026, owner: '审计员', status: 'active',
  startDate: '2026-09-01', endDate: '2026-12-31', description: '拖拽自动化测试用',
  overview,
  tasks: [], references: [], marketPlan: [],
  milestones: ['M1', 'M2', 'M3'].map((n, i) => ({ id: 'ms' + i, name: n, date: '', status: 'pending', owner: '', desc: '' })),
  issues: [], risks: [], resources: [], members: []
};

fs.writeFileSync('data/plan/state.json', JSON.stringify({
  rev: 1, updatedAt: new Date().toISOString(), updatedBy: 'audit', plans: [plan]
}, null, 2));
console.log('seeded drag fixture: A[A1,A2] B[B1] C + 3 milestones');
