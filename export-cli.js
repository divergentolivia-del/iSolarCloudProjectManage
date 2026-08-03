#!/usr/bin/env node
/* export-cli.js — CLI 兜底导出工具
   在服务不可用时将 JSON 状态文件还原为与原始 Excel 格式一致的 3-Sheet .xlsx 文件。
   独立于 HTTP 服务运行，运维人员直接在服务器终端执行即可获得可读 Excel 报表。

   用法:
     node export-cli.js                                → 默认读 data/state.json
     node export-cli.js data/history/8.13-rev48.json   → 导出特定快照
     node export-cli.js --output /tmp/report.xlsx      → 指定输出路径
     node export-cli.js --all-archives                 → 批量导出所有归档
     node export-cli.js --quiet                        → 静默模式，不输出摘要
*/

'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

/* ─── 数据目录配置，与 server.js 保持一致 ─── */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

/* ─── 加载 config.js 全局变量供 calc.js 使用 ─── */
const configSource = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
const configFn = new Function(configSource + '\nreturn { TEAMS, PRODUCT_LINES, OTHER_CATEGORIES, LOCK_ROLES, LOCK_ROLE_TO_TEAM, OWNER_LINES, DEVIATION_TOLERANCE, IGNORED_TEAM_PATTERNS, RECONCILE_TOLERANCE };');
const CONFIG = configFn();
Object.assign(global, CONFIG); // Make globals available for calc.js

/* ─── 加载计算与构建模块 ─── */
const { compute } = require('./calc');
const { buildWorkbook } = require('./export-builder');

/* ─── state 校验所需的空白默认值 ─── */
const EMPTY_STATE = {
  cycles: [{ name: '方案一', seal: '', online: '', workdays: 0, saturdays: 0, active: true, note: '' }],
  headcount: {},
  locked: [],
  totals: [],
  iterations: [],
  board: [],
  sources: {},
  rev: 0,
  updatedAt: '',
  updatedBy: ''
};

/* ─── 命令行参数解析 ─── */
function parseArgs(argv) {
  const args = {
    input: path.join(DATA_DIR, 'state.json'),
    output: null,
    quiet: false,
    allArchives: false
  };

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--output' || a === '-o') {
      i++;
      if (i < argv.length) {
        args.output = argv[i];
      }
    } else if (a === '--quiet' || a === '-q') {
      args.quiet = true;
    } else if (a === '--all-archives') {
      args.allArchives = true;
    } else if (!a.startsWith('-')) {
      // Positional argument = input file path
      args.input = a;
    }
    i++;
  }

  return args;
}

/* ─── 输出文件名自动推导 ─── */
function deriveOutputPath(state, inputPath) {
  const cycle = (state.cycles || []).find(c => c.active) || (state.cycles || [])[0];
  const tag = (cycle && cycle.online) || path.basename(inputPath, '.json');
  return path.join(path.dirname(inputPath), `云平台人力产能-${tag}.xlsx`);
}

/* ─── state 结构完整性校验 ─── */
function validateState(state) {
  const required = ['cycles', 'headcount', 'locked', 'totals', 'iterations'];
  const missing = required.filter(k => !(k in state));

  if (missing.length > 0) {
    process.stderr.write(`警告: state 缺少字段: ${missing.join(', ')}，对应区块将为空\n`);
    // Fill in defaults for missing fields
    missing.forEach(k => {
      if (!state[k]) {
        state[k] = Array.isArray(EMPTY_STATE[k]) ? [] : (typeof EMPTY_STATE[k] === 'object' ? {} : EMPTY_STATE[k]);
      }
    });
  }

  if (!Array.isArray(state.cycles) || state.cycles.length === 0) {
    throw new Error('cycles 必须为非空数组');
  }
}

/* ─── 摘要输出 ─── */
function printSummary(state, result, outputPath) {
  const cycle = result.cycle || {};
  const cycleName = (state.cycles || []).find(c => c.active);
  const name = cycleName ? cycleName.name : '未知方案';
  const days = result.days || 0;
  const rev = state.rev || 0;

  console.log(`✓ 已生成: ${outputPath}`);
  console.log(`摘要: ${name} | 封版 ${cycle.seal || '?'} 上线 ${cycle.online || '?'} | ${days}天 | rev ${rev}`);
  console.log(`      包含: ${getSheetSummary()}`);
}

function getSheetSummary() {
  // Derive month from active cycle for sheet name
  return '产能数据 | 规划与产能分析 | 人力工时数据';
}

/* ─── 单文件导出 ─── */
function exportSingle(inputPath, args) {
  // 1. 验证文件存在
  if (!fs.existsSync(inputPath)) {
    process.stderr.write(`错误: 文件不存在 — ${inputPath}\n`);
    process.stderr.write(`提示: 请检查文件路径是否正确。\n`);
    process.exit(1);
  }

  // 2. 读取并解析 JSON
  let raw;
  try {
    raw = fs.readFileSync(inputPath, 'utf8');
  } catch (e) {
    process.stderr.write(`错误: 无法读取文件 — ${e.message}\n`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`错误: JSON 解析失败 — ${e.message}\n`);
    process.stderr.write(`提示: 文件可能已损坏，请尝试 data/history/ 目录下的历史快照。\n`);
    process.exit(1);
  }

  // 3. 检测归档文件格式（含 meta + state 字段）并提取 state
  const state = (data.meta && data.state) ? data.state : data;

  // 4. 验证 state 结构
  validateState(state);

  // 5. 计算
  const result = compute(state);

  // 6. 构建工作簿 (3 Sheet 原始格式)
  const wb = buildWorkbook(state, result);

  // 7. 推导输出路径
  const outputPath = args.output || deriveOutputPath(state, inputPath);

  // 8. 确保输出目录存在
  const outputDir = path.dirname(outputPath);
  if (outputDir && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 9. 写入文件
  XLSX.writeFile(wb, outputPath);

  // 10. 输出摘要
  if (!args.quiet) {
    printSummary(state, result, outputPath);
  }

  return outputPath;
}

/* ─── 批量导出所有归档 ─── */
function exportAllArchives(args) {
  const archiveDir = path.join(DATA_DIR, 'archive');

  if (!fs.existsSync(archiveDir)) {
    process.stderr.write(`错误: 归档目录不存在 — ${archiveDir}\n`);
    process.stderr.write(`提示: 尚未创建任何归档，请先通过界面执行「归档本迭代」操作。\n`);
    process.exit(1);
  }

  const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));

  if (files.length === 0) {
    process.stderr.write(`提示: 归档目录为空，没有可导出的归档文件。\n`);
    process.exit(0);
  }

  let count = 0;
  let errors = 0;

  for (const file of files) {
    const inputPath = path.join(archiveDir, file);
    try {
      const outPath = exportSingle(inputPath, { output: null, quiet: true });
      if (!args.quiet) {
        console.log(`✓ ${file} → ${outPath}`);
      }
      count++;
    } catch (e) {
      process.stderr.write(`✗ ${file}: ${e.message}\n`);
      errors++;
    }
  }

  if (!args.quiet) {
    console.log(`\n完成: 成功导出 ${count} 个归档` + (errors > 0 ? `，${errors} 个失败` : ''));
  }
}

/* ─── 主流程 ─── */
function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.allArchives) {
    exportAllArchives(args);
  } else {
    exportSingle(args.input, args);
  }
}

main();
