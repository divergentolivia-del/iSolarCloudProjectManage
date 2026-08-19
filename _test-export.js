/* CLI 导出工具测试：验证 export-builder.js 和 export-cli.js 核心逻辑。
   不触碰仓库 data/ 目录，使用临时目录。 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isolar-export-test-'));

// Load config globals (needed by calc.js and export-builder.js)
const configSource = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
const configFn = new Function(configSource + '\nreturn { TEAMS, PRODUCT_LINES, OTHER_CATEGORIES, LOCK_ROLES, LOCK_ROLE_TO_TEAM, OWNER_LINES, DEVIATION_TOLERANCE, IGNORED_TEAM_PATTERNS, RECONCILE_TOLERANCE };');
const CONFIG = configFn();
Object.assign(global, CONFIG);

const { compute } = require('./calc');
const { buildWorkbook } = require('./export-builder');

function makeState() {
  return {
    cycles: [
      { name: '方案一', seal: '9.10', online: '9.17', workdays: 25, saturdays: 3, active: true, note: '' }
    ],
    headcount: {
      'APP开发-阳光云': { regular: 6, outsource: 2 },
      '后端开发-阳光云': { regular: 5, outsource: 2 }
    },
    locked: [
      { name: '专项A', roles: { 'APP': 2, '后端': 1 }, line: '', confirmer: '', confirmed: true, note: '' }
    ],
    totals: [
      { productLine: '', team: 'APP开发-阳光云', iteration: '阳光云2026-9月C版本迭代', story: 200, est: 30 },
      { productLine: '', team: '后端开发-阳光云', iteration: '阳光云2026-9月C版本迭代', story: 350, est: 0 }
    ],
    board: [
      { productLine: '智慧能源产品中心', team: 'APP开发-阳光云', iteration: '阳光云2026-9月C版本迭代', story: 150, est: 0 },
      { productLine: '智慧能源产品中心', team: '后端开发-阳光云', iteration: '阳光云2026-9月C版本迭代', story: 300, est: 0 }
    ],
    iterations: [
      { name: '阳光云2026-9月C版本迭代', weight: 550, selected: true }
    ],
    sources: {}
  };
}

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('buildWorkbook produces exactly 3 sheets with correct names', () => {
  const state = makeState();
  const result = compute(state);
  const wb = buildWorkbook(state, result);

  assert.equal(wb.SheetNames.length, 3, 'Should have 3 sheets');
  assert.match(wb.SheetNames[0], /产能数据/, 'Sheet 1 name contains 产能数据');
  assert.equal(wb.SheetNames[1], '规划与产能分析', 'Sheet 2 is 规划与产能分析');
  assert.equal(wb.SheetNames[2], '人力工时数据', 'Sheet 3 is 人力工时数据');
});

test('buildWorkbook is idempotent — same input produces identical output', () => {
  const state = makeState();
  const result = compute(state);
  const wb1 = buildWorkbook(state, result);
  const wb2 = buildWorkbook(state, result);

  // Compare sheet data cell by cell
  for (const name of wb1.SheetNames) {
    const s1 = wb1.Sheets[name];
    const s2 = wb2.Sheets[name];
    const keys1 = Object.keys(s1).filter(k => !k.startsWith('!')).sort();
    const keys2 = Object.keys(s2).filter(k => !k.startsWith('!')).sort();
    assert.deepEqual(keys1, keys2, `Sheet "${name}" cell keys should match`);
    for (const k of keys1) {
      assert.deepEqual(s1[k].v, s2[k].v, `Sheet "${name}" cell ${k} value should match`);
    }
  }
});

test('buildWorkbook handles empty state gracefully (no totals/board)', () => {
  const state = {
    cycles: [{ name: '方案一', seal: '', online: '9.17', workdays: 20, saturdays: 2, active: true, note: '' }],
    headcount: {},
    locked: [],
    totals: [],
    board: [],
    iterations: [],
    sources: {}
  };
  const result = compute(state);
  const wb = buildWorkbook(state, result);

  assert.equal(wb.SheetNames.length, 3, 'Still produces 3 sheets even with empty data');
});

test('Sheet 2 contains all 4 required section titles', () => {
  const state = makeState();
  const result = compute(state);
  const wb = buildWorkbook(state, result);
  const XLSX = require('xlsx');
  const sheet = wb.Sheets['规划与产能分析'];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const titles = aoa.map(row => row[0]).filter(Boolean);

  assert.ok(titles.some(t => String(t).includes('产品线版本工作量汇总')), 'Has 产品线版本工作量汇总');
  assert.ok(titles.some(t => String(t).includes('版本规划工作量汇总')), 'Has 版本规划工作量汇总');
  assert.ok(titles.some(t => String(t).includes('云团队产能明细')), 'Has 云团队产能明细');
  assert.ok(titles.some(t => String(t).includes('偏差分析')), 'Has 偏差分析');
});

test('CLI export-cli.js runs successfully on a test state file', () => {
  const state = makeState();
  const testFile = path.join(TMP, 'test-state.json');
  const outputFile = path.join(TMP, 'output.xlsx');
  fs.writeFileSync(testFile, JSON.stringify(state), 'utf8');

  const { execSync } = require('child_process');
  const result = execSync(
    `node export-cli.js "${testFile}" --output "${outputFile}" --quiet`,
    { cwd: __dirname, env: { ...process.env, PATH: process.env.PATH } }
  );

  assert.ok(fs.existsSync(outputFile), 'Output xlsx file created');
  const stat = fs.statSync(outputFile);
  assert.ok(stat.size > 1000, 'Output file has reasonable size (>1KB)');
});

test('CLI handles archive file format (meta + state)', () => {
  const archiveData = {
    meta: { id: 'test', name: '测试归档', archivedAt: '2026/8/19' },
    state: makeState()
  };
  const testFile = path.join(TMP, 'test-archive.json');
  const outputFile = path.join(TMP, 'archive-output.xlsx');
  fs.writeFileSync(testFile, JSON.stringify(archiveData), 'utf8');

  const { execSync } = require('child_process');
  execSync(
    `node export-cli.js "${testFile}" --output "${outputFile}" --quiet`,
    { cwd: __dirname, env: { ...process.env, PATH: process.env.PATH } }
  );

  assert.ok(fs.existsSync(outputFile), 'Archive export produces xlsx');
});

test('CLI exits with error for nonexistent file', () => {
  const { execSync } = require('child_process');
  let threw = false;
  try {
    execSync('node export-cli.js /nonexistent/file.json --quiet', {
      cwd: __dirname, env: { ...process.env, PATH: process.env.PATH }, stdio: 'pipe'
    });
  } catch (e) {
    threw = true;
    assert.ok(e.status !== 0, 'Exit code is non-zero');
  }
  assert.ok(threw, 'Should throw for nonexistent file');
});
