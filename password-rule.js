/* password-rule.js — 初始密码公式（单一出处）
 *
 * 为什么单独拎出来：这条公式现在有两个调用方 ——
 *   ① user-import.js（CSV 批量建号，命令行）
 *   ② modules/auth/routes.js（「系统设置 → 新建用户」表单，HTTP）
 * 抄两份的后果不是「代码不好看」，是两条路建出来的号密码格式会不一致：
 * 用户在界面上建一个、用 CSV 建一个，同一个人两边拿到的初始密码不同，
 * 而两边都不会报错。所以公式只留这一份。
 *
 * 配置源：data/auth-config.json（已 gitignore，不进代码）。
 *
 * ── 两种公式 ────────────────────────────────────────────────
 *  初始公式（由用户给出的 Cdp20267968 反推）：
 *    姓名缩写（首字母大写） + 年份 + 工号后 4 位
 *    例：陈丹萍 cdp + 2026 + 7968 = Cdp20267968
 *
 *  2026-10-14 新增 · 外包同事：
 *    姓名缩写（首字母大写） + outsourcedPasswordSuffix
 *    例：张三 zs + 20261024 = Zs20261024
 *
 * ── 外包为什么必须另起一条公式 ──────────────────────────────
 * 外包没有工号，公式里的「工号后 4 位」没有值可取。理论上可以退回
 * 「缩写 + 后缀」的老规则，但那会撞车：两个张磊缩写都是 zl，
 * 拼出来都是 Zl20261024 —— 内部员工的工号段本来就是拿来防这个的。
 *
 * 所以外包这档配的是【账号用姓名全拼】（zhangsan，不是 zs），
 * 密码撞了不影响登录，账号是唯一的。这一条写进路由层的注释里，
 * 免得以后有人看到「缩写都是 zs」以为规则写错了。
 *
 * ── 关于缩写从哪来 ──────────────────────────────────────────
 * 程序【不做拼音转换】（零依赖是硬约束，且多音字会错）。
 * CSV 路径从名单的「密码前缀」列取；表单路径由建号人自己填拼音。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* 已实现的公式。新增模式时这里和 buildPassword 一起改。 */
const SUPPORTED_MODES = ['initials+suffix', 'initials+suffix+last4'];

/* 配置文件和 db.js 同源：认 process.env.DATA_DIR（测试指向副本库），
   否则读写的是生产 data/ —— 干跑时看着干净，实际污染了生产配置。 */
const CONFIG_FILE = path.join(
  process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'),
  'auth-config.json'
);

const DEFAULT_CONFIG = {
  defaultPasswordSuffix: '2026',
  outsourcedPasswordSuffix: '20261024',
  defaultPasswordMode: 'initials+suffix+last4',
  forceChangeOnFirstLogin: false
};

/* 建号类型 → 公式分支。internal = 有工号；outsourced = 无工号（外包）。 */
const KINDS = ['internal', 'outsourced'];

/**
 * 读密码规则。
 * @param {{strict?:boolean}} [opts] strict=true 时【配置存在但非法】直接抛错
 *   （HTTP 路径用，让建号人当场知道配置坏了）；
 *   ⚠ 文件【不存在】时不抛 —— DEFAULT_CONFIG 里两条后缀都是完整的，
 *     缺文件照样能算出正确密码。若这里也抛，全新部署（data/ 里还没有
 *     auth-config.json）就会连一个号都建不出来，而管理员看不出哪里不对。
 */
function loadConfig(opts) {
  const strict = !!(opts && opts.strict);
  let cfg = DEFAULT_CONFIG;
  let missing = false;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg = Object.assign({}, DEFAULT_CONFIG, raw);
  } catch (e) {
    if (e.code === 'ENOENT') {
      missing = true;   // 缺文件：用默认值，不算错误
    } else {
      /* 文件在、但读不动（权限/损坏）—— 这个不能静默：
         静默回落到默认后缀，会按错误的规则给一批人发密码出去。 */
      if (strict) throw new Error('密码规则配置 ' + CONFIG_FILE + ' 读取失败：' + e.message);
      missing = true;
    }
    if (!strict && missing) {
      console.log('提示：' + (e.code === 'ENOENT' ? '未找到 ' + CONFIG_FILE : CONFIG_FILE + ' 读取失败（' + e.message + '）')
        + '，本次用内置默认规则（后缀 ' + DEFAULT_CONFIG.defaultPasswordSuffix + '）。');
    }
  }
  if (SUPPORTED_MODES.indexOf(cfg.defaultPasswordMode) < 0) {
    const msg = '不支持的 defaultPasswordMode：' + cfg.defaultPasswordMode
      + '，可选 ' + SUPPORTED_MODES.join(' / ');
    if (strict) throw new Error(msg);
    console.error('\n失败：' + msg);
    process.exit(1);
  }
  return cfg;
}

/** 姓名缩写规范化：cdp / CDP / Cdp → Cdp。空值回空串（调用方自行决定是否报错）。 */
function normalizeInitials(prefix) {
  const p = String(prefix == null ? '' : prefix).trim();
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
}

/**
 * 拼初始密码。
 * @param {string} prefix 姓名缩写（人工填，程序不转拼音）
 * @param {string} id     工号（外包为空）
 * @param {object} cfg    loadConfig() 的返回值
 * @param {string} [kind] 'internal' | 'outsourced'，缺省 internal
 *
 * 外包走【独立分支】，不是「internal 少一段」。理由见文件头：外包没有工号，
 * 硬套 internal 会把「工号后 4 位」拼成空串，悄悄产出 Zs2026 这种短密码。
 */
function buildPassword(prefix, id, cfg, kind) {
  const c = cfg || DEFAULT_CONFIG;
  const norm = normalizeInitials(prefix);
  const isOutsourced = String(kind || 'internal') === 'outsourced';

  if (isOutsourced) {
    return norm + String(c.outsourcedPasswordSuffix || DEFAULT_CONFIG.outsourcedPasswordSuffix);
  }

  const suffix = String(c.defaultPasswordSuffix || '');
  const mode = c.defaultPasswordMode || DEFAULT_CONFIG.defaultPasswordMode;
  if (mode === 'initials+suffix') {
    return norm + suffix;                     // 老规则，兼容已发出去的老密码
  }
  return norm + suffix + String(id || '').slice(-4);
}

/**
 * 校验建号入参，返回 { ok, error }。
 * 两条都在服务端做，因为表单是浏览器里的东西 —— 前端校验只防手滑，不防绕过。
 */
function validateNewUser({ id, name, prefix, kind }) {
  const k = String(kind || 'internal');
  if (KINDS.indexOf(k) < 0) return { ok: false, error: '类型非法，可选：' + KINDS.join(' / ') };
  if (!String(id || '').trim()) return { ok: false, error: '账号不能为空' };
  if (!String(name || '').trim()) return { ok: false, error: '姓名不能为空' };
  if (!normalizeInitials(prefix)) {
    return { ok: false, error: '姓名缩写不能为空 —— 它是密码的第一段，程序不做拼音转换，需要人工填（如 张三 → zs）' };
  }
  if (k === 'internal') {
    /* 内部员工走「工号后4位」，工号短于 4 位拼出来的密码会缺一段，
       而且看着还挺正常 —— 当场拦掉。 */
    const digits = String(id || '').replace(/\D/g, '');
    if (String(id || '').trim().length < 4) {
      return { ok: false, error: '内部员工的账号应是工号（至少 4 位）—— 密码公式要用它的后 4 位，账号太短拼不出密码' };
    }
    if (!digits) return { ok: false, error: '内部员工的工号里应含数字（密码取它的后 4 位）' };
  }
  return { ok: true, kind: k };
}

module.exports = {
  SUPPORTED_MODES, KINDS, CONFIG_FILE, DEFAULT_CONFIG,
  loadConfig, buildPassword, normalizeInitials, validateNewUser
};
