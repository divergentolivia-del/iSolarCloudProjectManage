/* 归档模块回归测试：归档快照不可变、重复归档保护、初始化下一迭代。
   测试只写入系统临时目录，不触碰仓库 data/ 目录。 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'isolar-archive-test-'));
process.env.DATA_DIR = DATA_DIR;

const archive = require('./archive');

function makeState() {
  return {
    cycles: [{
      name: '方案一', seal: '8.10', online: '8.13', workdays: 20,
      saturdays: 1, active: true, note: ''
    }],
    headcount: { 'APP开发-阳光云': { regular: 5, outsource: 1 } },
    locked: [{ name: '专项项目', confirmed: true }],
    totals: [{ team: 'APP开发-阳光云', workload: 10 }],
    board: [{ id: 'board-1' }],
    iterations: [{ name: '迭代A', selected: true }],
    sources: { totals: { fileName: 'totals.csv' } },
    rev: 7,
    updatedAt: '2026/8/19 10:00:00',
    updatedBy: '测试用户'
  };
}

function resetArchiveDir() {
  fs.rmSync(path.join(DATA_DIR, 'archive'), { recursive: true, force: true });
}

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('createArchive freezes a deep snapshot and rejects duplicate ids', () => {
  resetArchiveDir();
  const state = makeState();
  const result = archive.createArchive(state, {
    name: '8.13 迭代', note: '评审通过', archivedBy: '测试用户'
  }, {
    totals: { workload: 10, capacity: 12 },
    deviation: [{ key: 'APP开发-阳光云' }]
  });

  assert.equal(result.ok, true);
  assert.equal(typeof result.id, 'string');

  state.headcount['APP开发-阳光云'].regular = 99;
  state.totals[0].workload = 99;
  const saved = archive.getArchive(result.id);

  assert.equal(saved.state.headcount['APP开发-阳光云'].regular, 5);
  assert.equal(saved.state.totals[0].workload, 10);
  assert.equal(saved.meta.summary.totalWorkload, 10);
  assert.equal(saved.meta.summary.totalCapacity, 12);

  const duplicate = archive.createArchive(makeState(), {
    name: '重复归档', archivedBy: '测试用户'
  }, { totals: { workload: 1, capacity: 1 }, deviation: [] });
  assert.match(duplicate.error, /已存在归档/);
});

test('initNextIteration preserves the staffing skeleton and clears work data', () => {
  const state = makeState();
  const next = archive.initNextIteration(state);

  assert.notEqual(next, state);
  assert.deepEqual(next.headcount, state.headcount);
  assert.deepEqual(next.locked, state.locked);
  assert.deepEqual(next.cycles.map(c => c.active), [false]);
  assert.deepEqual(next.totals, []);
  assert.deepEqual(next.board, []);
  assert.deepEqual(next.iterations, []);
  assert.deepEqual(next.sources, {});
  assert.equal(next.rev, state.rev + 1);

  next.headcount['APP开发-阳光云'].regular = 100;
  assert.equal(state.headcount['APP开发-阳光云'].regular, 5);
});

test('listArchives skips corrupted files and rejects unsafe ids', () => {
  resetArchiveDir();
  const archiveDir = path.join(DATA_DIR, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'broken.json'), '{not-json', 'utf8');

  assert.deepEqual(archive.listArchives(), []);
  assert.equal(archive.getArchive('../state'), null);
  assert.match(archive.deleteArchive('../state').error, /格式无效/);
});
