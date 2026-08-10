/* migrate.js — 数据迁移逻辑
   将旧版单模块数据目录结构迁移至新版多模块目录结构。

   迁移条件：data/state.json 存在 且 data/iteration/state.json 不存在
   迁移结果：
     - data/state.json → data/iteration/state.json（复制）
     - data/history/* → data/iteration/history/（复制）
     - 创建 project/budget/token 模块的空 state 文件
     - 原 data/state.json 写入重定向标记

   特性：
     - 幂等：多次运行结果一致
     - 中断安全：下次启动重新执行
     - 单函数导出：migrate(dataDir) → { migrated, modules }
*/

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 确保目录存在（递归创建）
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 安全复制文件：仅当目标不存在时才复制（幂等）
 */
function safeCopy(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(src, dest);
  }
}

/**
 * 获取各模块的空状态模板
 */
function getEmptyState(moduleId) {
  const year = new Date().getFullYear();

  switch (moduleId) {
    case 'project':
      return {
        rev: 0,
        updatedAt: '',
        updatedBy: '',
        year: year,
        projects: []
      };

    case 'budget':
      return {
        rev: 0,
        updatedAt: '',
        updatedBy: '',
        year: year,
        plans: [],
        actuals: [],
        alerts: []
      };

    case 'token':
      return {
        rev: 0,
        updatedAt: '',
        updatedBy: '',
        summary: {
          totalTokens: 0,
          totalCost: 0,
          totalInvocations: 0,
          period: { from: '', to: '' }
        },
        agents: [],
        dailyLogs: [],
        budgetLimit: {
          monthly: 500,
          alertThreshold: 0.8
        }
      };

    default:
      return { rev: 0, updatedAt: '', updatedBy: '' };
  }
}

/**
 * migrate(dataDir) — 执行数据迁移
 *
 * @param {string} dataDir — 数据根目录路径（默认为 ./data）
 * @returns {{ migrated: boolean, modules: string[] }}
 *   - migrated: true 表示本次执行了迁移操作
 *   - modules: 涉及的模块 ID 列表
 */
function migrate(dataDir) {
  if (!dataDir) {
    dataDir = path.join(__dirname, 'data');
  }

  const oldStateFile = path.join(dataDir, 'state.json');
  const oldHistoryDir = path.join(dataDir, 'history');
  const iterDir = path.join(dataDir, 'iteration');
  const iterStateFile = path.join(iterDir, 'state.json');

  // 强制迁移检测：如果 data/state.json 有真实数据（非迁移标记），
  // 而 data/iteration/state.json 存在但 headcount 为空，
  // 说明 git pull 覆盖了 iteration/state.json 为空测试数据，需要用真实数据覆盖。
  if (fs.existsSync(oldStateFile) && fs.existsSync(iterStateFile)) {
    try {
      const oldContent = JSON.parse(fs.readFileSync(oldStateFile, 'utf8'));
      const iterContent = JSON.parse(fs.readFileSync(iterStateFile, 'utf8'));
      // 条件：旧文件非迁移标记、有真实 headcount 数据；新文件 headcount 为空
      if (!oldContent._migrated &&
          oldContent.headcount && Object.keys(oldContent.headcount).length > 0 &&
          (!iterContent.headcount || Object.keys(iterContent.headcount).length === 0)) {
        console.log('[migrate] 检测到 iteration/state.json 为空但 state.json 有真实数据，执行强制覆盖');
        const realData = Object.assign({}, oldContent);
        realData.rev = Math.max(Number(oldContent.rev || 0), Number(iterContent.rev || 0)) + 1;
        realData.updatedAt = new Date().toLocaleString('zh-CN');
        fs.writeFileSync(iterStateFile, JSON.stringify(realData, null, 2), 'utf8');
        console.log('[migrate]   已用真实数据覆盖 iteration/state.json (rev ' + realData.rev + ')');
      }
    } catch (e) {
      // 解析失败不影响正常流程
    }
  }

  // 检测是否需要迁移：
  // 条件：data/state.json 存在 且 data/iteration/state.json 不存在
  if (!fs.existsSync(oldStateFile) || fs.existsSync(iterStateFile)) {
    return { migrated: false, modules: [] };
  }

  // 额外检查：如果旧 state.json 已经是重定向标记，则不需要迁移
  try {
    const content = JSON.parse(fs.readFileSync(oldStateFile, 'utf8'));
    if (content && content._migrated === true) {
      return { migrated: false, modules: [] };
    }
  } catch (e) {
    // 解析失败说明文件存在但格式异常，仍尝试迁移
  }

  console.log('[migrate] 检测到需要数据迁移，开始执行…');

  // 1. 创建 iteration 模块目录结构
  ensureDir(iterDir);
  ensureDir(path.join(iterDir, 'history'));

  // 2. 复制 data/state.json → data/iteration/state.json
  safeCopy(oldStateFile, iterStateFile);
  console.log('[migrate]   data/state.json → data/iteration/state.json');

  // 3. 复制 data/history/* → data/iteration/history/
  if (fs.existsSync(oldHistoryDir)) {
    try {
      const historyFiles = fs.readdirSync(oldHistoryDir);
      let count = 0;
      for (const file of historyFiles) {
        const srcFile = path.join(oldHistoryDir, file);
        const destFile = path.join(iterDir, 'history', file);
        // 仅复制文件，跳过子目录
        try {
          const stat = fs.statSync(srcFile);
          if (stat.isFile()) {
            safeCopy(srcFile, destFile);
            count++;
          }
        } catch (e) {
          console.warn(`[migrate]   跳过 history/${file}: ${e.message}`);
        }
      }
      console.log(`[migrate]   data/history/ → data/iteration/history/ (${count} 个文件)`);
    } catch (e) {
      console.warn('[migrate]   复制 history 目录失败:', e.message);
    }
  }

  // 4. 创建其他模块的空 state 文件
  const newModules = ['project', 'budget', 'token'];
  for (const mod of newModules) {
    const modDir = path.join(dataDir, mod);
    ensureDir(modDir);
    ensureDir(path.join(modDir, 'history'));

    // token 模块额外创建 logs 目录
    if (mod === 'token') {
      ensureDir(path.join(modDir, 'logs'));
    }

    const modStateFile = path.join(modDir, 'state.json');
    if (!fs.existsSync(modStateFile)) {
      fs.writeFileSync(modStateFile, JSON.stringify(getEmptyState(mod), null, 2), 'utf8');
      console.log(`[migrate]   创建 data/${mod}/state.json (空状态)`);
    }
  }

  // 5. 在原 data/state.json 写入重定向标记
  const marker = {
    _migrated: true,
    _message: '数据已迁移至 data/iteration/，请更新客户端',
    _migratedAt: new Date().toISOString(),
    _modules: ['iteration', ...newModules]
  };
  fs.writeFileSync(oldStateFile, JSON.stringify(marker, null, 2), 'utf8');
  console.log('[migrate]   原 data/state.json 已写入重定向标记');

  const allModules = ['iteration', ...newModules];
  console.log(`[migrate] 迁移完成。涉及模块: ${allModules.join(', ')}`);

  return { migrated: true, modules: allModules };
}

module.exports = migrate;
