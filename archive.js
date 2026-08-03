/* 迭代归档模块：管理归档的创建、查询、校验。
   归档是迭代之间的"检查点"——在人力会确认偏差解决后执行归档，
   冻结当前迭代数据，为次日开始新迭代做准备。
   仅使用 Node.js 内置模块，保持零外部依赖。 */

const fs = require('fs');
const path = require('path');

/* 数据目录配置，与 server.js 保持一致 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

/* ID 格式校验：仅允许 ASCII 字母数字、点、中划线、下划线 */
const VALID_ID_PATTERN = /^[\w.\-]+$/;

/* ---------- 工具函数 ---------- */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ---------- createArchive ---------- */

/**
 * 创建一条迭代归档（检查点）
 * @param {object} state          - 当前 state.json 的完整内容
 * @param {object} meta           - { name: string, note: string, archivedBy: string }
 * @param {object} computeResult  - calc.compute(state) 的返回值（由调用方传入，避免全局依赖）
 * @returns {{ ok: boolean, id: string, path: string } | { error: string }}
 */
function createArchive(state, meta, computeResult) {
  const cycle = (state.cycles || []).find(c => c.active) || (state.cycles || [])[0] || {};
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const onlineTag = String(cycle.online || 'unnamed').replace(/[^\w.\-]/g, '_');
  const id = `${yearMonth}-${onlineTag}`;
  const filePath = path.join(ARCHIVE_DIR, `${id}.json`);

  // 防重复检查
  if (fs.existsSync(filePath)) {
    return { error: `本月已存在归档「${id}」，如需覆盖请先删除原归档` };
  }

  // 计算关键指标摘要（用于列表展示时免加载完整 state）
  let summary;
  if (computeResult && computeResult.totals) {
    const totals = computeResult.totals;
    summary = {
      totalWorkload: totals.workload || 0,
      totalCapacity: totals.capacity || 0,
      overallDeviation: totals.capacity
        ? (totals.workload - totals.capacity) / totals.capacity
        : 0,
      teamCount: computeResult.deviation ? computeResult.deviation.length : 0
    };
  } else {
    summary = { totalWorkload: 0, totalCapacity: 0, overallDeviation: 0, teamCount: 0 };
  }

  // 构建归档记录
  const record = {
    meta: {
      id: id,
      name: meta.name || `${yearMonth} 迭代`,
      archivedAt: now.toLocaleString('zh-CN'),
      archivedBy: meta.archivedBy || '未署名',
      note: meta.note || '',
      cycle: {
        seal: cycle.seal || '',
        online: cycle.online || '',
        workdays: cycle.workdays || 0,
        saturdays: cycle.saturdays || 0
      },
      iterations: (state.iterations || []).filter(i => i.selected).map(i => i.name),
      summary: summary,
      rev: state.rev || 0,
      stateUpdatedAt: state.updatedAt || ''
    },
    state: JSON.parse(JSON.stringify(state)) // 深拷贝，冻结快照
  };

  // 确保目录存在
  ensureDir(ARCHIVE_DIR);

  // 原子写入：先写临时文件再 rename，避免写到一半断电导致损坏
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);

  return { ok: true, id: id, path: filePath };
}

/* ---------- initNextIteration ---------- */

/**
 * 初始化下一迭代：清空工时数据，保留团队骨架
 * 归档成功后可选调用，为次日新迭代填报做准备。
 * 不修改输入对象。
 * @param {object} currentState - 当前 state
 * @returns {object} - 新的空白 state
 */
function initNextIteration(currentState) {
  return {
    // 保留: 周期方案骨架（active 全部重置为 false，等待用户设定新周期）
    cycles: (currentState.cycles || []).map(c => ({
      name: c.name || '',
      seal: c.seal || '',
      online: c.online || '',
      workdays: c.workdays || 0,
      saturdays: c.saturdays || 0,
      active: false,
      note: c.note || ''
    })),
    // 保留: 团队人头数（深拷贝）
    headcount: JSON.parse(JSON.stringify(currentState.headcount || {})),
    // 保留: 专项锁定项目（深拷贝）
    locked: JSON.parse(JSON.stringify(currentState.locked || [])),
    // 清空: 工时数据（新迭代需要重新导入）
    totals: [],
    board: [],
    // 清空: 迭代选择（新迭代有新的迭代名称）
    iterations: [],
    // 清空: 数据源记录
    sources: {},
    // 递增版本号
    rev: (currentState.rev || 0) + 1,
    updatedAt: new Date().toLocaleString('zh-CN'),
    updatedBy: '系统(初始化新迭代)'
  };
}

/* ---------- listArchives ---------- */

/**
 * 列出所有归档（仅元数据，不加载完整 state）
 * @returns {Array<object>} meta 数组，按 archivedAt 降序
 */
function listArchives() {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];

  let files;
  try {
    files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json'));
  } catch (e) {
    return [];
  }

  const archives = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(ARCHIVE_DIR, file), 'utf8');
      const parsed = JSON.parse(content);
      if (parsed.meta) {
        archives.push(parsed.meta);
      }
    } catch (e) {
      // 文件损坏则跳过，不影响其他归档的展示
    }
  }

  // 按归档时间降序排列
  archives.sort((a, b) => {
    const ta = new Date(a.archivedAt).getTime() || 0;
    const tb = new Date(b.archivedAt).getTime() || 0;
    return tb - ta;
  });

  return archives;
}

/* ---------- getArchive ---------- */

/**
 * 读取单条归档的完整数据
 * @param {string} id - 归档 ID (文件名去 .json)
 * @returns {{ meta: object, state: object } | null}
 */
function getArchive(id) {
  // 校验 ID 格式，防止路径穿越
  if (!id || !VALID_ID_PATTERN.test(id)) return null;

  const filePath = path.join(ARCHIVE_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/* ---------- deleteArchive ---------- */

/**
 * 删除归档（仅管理员操作）
 * @param {string} id - 归档 ID
 * @returns {{ ok: boolean } | { error: string }}
 */
function deleteArchive(id) {
  // 校验 ID 格式，防止路径穿越
  if (!id || !VALID_ID_PATTERN.test(id)) {
    return { error: '归档 ID 格式无效' };
  }

  const filePath = path.join(ARCHIVE_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    return { error: `归档「${id}」不存在` };
  }

  try {
    fs.unlinkSync(filePath);
    return { ok: true };
  } catch (e) {
    return { error: '删除失败：' + e.message };
  }
}

module.exports = { createArchive, initNextIteration, listArchives, getArchive, deleteArchive };
