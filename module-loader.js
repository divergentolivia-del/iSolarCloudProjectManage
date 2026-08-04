/* module-loader.js — 服务端动态模块加载器
   扫描 modules/ 目录，加载每个子目录的 routes.js，
   按 URL 前缀注册路由处理器并分发请求。

   每个模块导出：
   {
     id: 'project',
     prefix: '/api/project',
     handle(req, res, url) {},
     ensureData() {}
   }
*/

'use strict';

const fs = require('fs');
const path = require('path');

const MODULES_DIR = path.join(__dirname, 'modules');

// 已注册模块列表（按 prefix 长度降序排列）
let registered = [];

/**
 * loadAll() — 扫描 modules/ 目录，require 每个子目录的 routes.js
 * 注册模块路由、调用 ensureData()、验证前缀唯一性、按前缀长度排序。
 * 如果 modules/ 目录不存在，静默返回空列表。
 */
function loadAll() {
  registered = [];

  // modules/ 目录不存在时优雅处理
  if (!fs.existsSync(MODULES_DIR)) {
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(MODULES_DIR, { withFileTypes: true });
  } catch (e) {
    console.warn('[module-loader] 无法读取 modules/ 目录:', e.message);
    return [];
  }

  const prefixMap = new Map(); // prefix -> moduleId（用于冲突检测）

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const modulePath = path.join(MODULES_DIR, entry.name, 'routes.js');

    // 尝试加载模块
    let mod;
    try {
      mod = require(modulePath);
    } catch (e) {
      console.warn(`[module-loader] 加载模块 "${entry.name}" 失败，已跳过: ${e.message}`);
      continue;
    }

    // 验证模块导出格式
    if (!mod || !mod.id || !mod.prefix || typeof mod.handle !== 'function') {
      console.warn(`[module-loader] 模块 "${entry.name}" 导出格式不正确，已跳过（需要 id, prefix, handle）`);
      continue;
    }

    // 检查前缀冲突
    if (prefixMap.has(mod.prefix)) {
      const conflict = prefixMap.get(mod.prefix);
      throw new Error(
        `[module-loader] URL 前缀冲突: 模块 "${mod.id}" 和 "${conflict}" 都声明了前缀 "${mod.prefix}"`
      );
    }
    prefixMap.set(mod.prefix, mod.id);

    // 调用 ensureData() 初始化数据目录
    if (typeof mod.ensureData === 'function') {
      try {
        mod.ensureData();
      } catch (e) {
        console.warn(`[module-loader] 模块 "${mod.id}" ensureData() 失败: ${e.message}`);
      }
    }

    registered.push({
      id: mod.id,
      prefix: mod.prefix,
      handle: mod.handle,
      module: mod
    });
  }

  // 按 prefix 长度降序排列（longest-prefix-first matching）
  registered.sort((a, b) => b.prefix.length - a.prefix.length);

  if (registered.length > 0) {
    console.log(`[module-loader] 已加载 ${registered.length} 个模块: ${registered.map(m => m.id).join(', ')}`);
  }

  return registered.map(m => ({ id: m.id, prefix: m.prefix }));
}

/**
 * dispatch(req, res, url) — 将请求路径匹配到已注册模块的前缀，
 * 调用匹配模块的 handle() 方法。
 * 返回 true 表示已匹配到模块并处理，false 表示无匹配。
 */
function dispatch(req, res, url) {
  const pathname = url.pathname || url.path || '';

  for (const entry of registered) {
    // 精确匹配前缀：路径以 prefix 开头，且后续字符为 '/' 或路径结束
    if (pathname === entry.prefix || pathname.startsWith(entry.prefix + '/')) {
      entry.handle(req, res, url);
      return true;
    }
  }

  return false;
}

/**
 * list() — 返回已注册模块的元数据数组
 */
function list() {
  return registered.map(m => ({
    id: m.id,
    prefix: m.prefix
  }));
}

module.exports = { loadAll, dispatch, list };
