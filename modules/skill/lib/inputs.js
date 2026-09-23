/* modules/skill/lib/inputs.js — Skill 输入采集的 provider 注册表
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────
 * 原先 collectInputs() 是 engine.js 里一个 110 行的函数，硬编码了 6 个数据源
 * （pradapter / iteration 偏差 / iteration 历史 / plan / knowledge / git 信号）。
 * 加一个数据源就要动这个函数，加一个 Skill 要动的地方更多，
 * 而且「某个源没采到」和「这个源本来就没数据」在返回值里长得一模一样。
 *
 * 这个文件把那 6 段拆成 6 个独立 provider，各自声明：
 *   id      —— 唯一标识
 *   label   —— 人看的名字（报错信息和自检接口都用它）
 *   deps    —— 依赖的其他 provider id；依赖没成功时不执行（否则必然抛错）
 *   enabled —— 默认是否启用
 *   load(ctx)—— 返回一个对象，浅合并进输入
 *
 * ── 一条不能破的规矩：不许静默失败 ────────────────────────────────
 * 2026-09-22 出过事故：裸 node 里跑 engine.run()（没经 server.js），
 * calc.js 依赖的全局 TEAMS 不存在 → 抛 ReferenceError → 被 catch 吞掉 →
 * deviations=[] → 三个 Skill 于是都产出 0 项 → 82 条待办全被标成 expired。
 * 用户看到的是「今天没风险」，真相是「输入压根没采集到」。
 *
 * 所以这里：provider 抛错 **不中断其他 provider**（一个源挂了不该连累全部），
 * 但错误必须被收集进 inputs.__errors（require 的、可选依赖的、禁用的分开记），
 * 并由自检接口和 engine 的返回值暴露出来。宁可吵，也不要静悄悄地说没事。
 *
 * ── 配置 ─────────────────────────────────────────────────────────
 * data/skill/inputs.json（可选，不存在则全用默认）：
 *   { "disabled": ["history"], "enabled": [] }
 * disabled 优先级高于 enabled —— 关掉某个源是临时排障动作，必须说了算。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* 仓库根：lib → skill → modules → root，四层 */
const ROOT = path.join(__dirname, '..', '..', '..');

function dataPath() {
  /* 允许测试指向别处，避免污染正在被同事使用的真实数据 */
  return process.env.SKILL_DATA_DIR
    ? path.resolve(process.env.SKILL_DATA_DIR)
    : path.join(ROOT, 'data', 'skill');
}

/** 失败即返回 null（沿用原 collectInputs 的容错口径：缺文件不算错） */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function loadConfig() {
  const cfg = readJson(path.join(dataPath(), 'inputs.json')) || {};
  return {
    disabled: Array.isArray(cfg.disabled) ? cfg.disabled.slice() : [],
    enabled: Array.isArray(cfg.enabled) ? cfg.enabled.slice() : []
  };
}

/* ══════════════════════════════════════════════════════════════
   Provider 定义
   每个 load(ctx) 拿到的 ctx 里有 root / inputs / dataPath / env，
   返回的对象会被 Object.assign 合并进 inputs。返回 null/undefined 表示本轮无数据。
   ══════════════════════════════════════════════════════════════ */

/* ---------- 1. pradapter：仓库统计特征（L3 脱敏口径，不含提交原文） ---------- */
const reposProvider = {
  id: 'repos',
  label: '代码仓库统计',
  enabled: true,
  load(ctx) {
    const pr = readJson(path.join(ctx.root, 'data', 'pradapter', 'state.json'));
    const prCfg = readJson(path.join(ctx.root, 'data', 'pradapter', 'config.json'));

    /* 仓库→团队显式映射（config.json repos[].teams），不靠仓库名猜 */
    const repoTeams = {};
    for (const r of (prCfg && prCfg.repos) || []) {
      if (r && r.id && Array.isArray(r.teams)) repoTeams[r.id] = r.teams.filter(Boolean);
    }
    const out = { evidenceConfigured: Object.keys(repoTeams).some(k => repoTeams[k].length > 0) };
    if (!pr || !pr.repos) return out;

    out.repos = pr.repos.map(r => ({
      id: r.id, name: r.name, ok: r.ok, error: r.error, lastCommitAt: r.lastCommitAt
    }));

    /* PR 佐证：只按显式映射聚合（未配置映射时 evidence 为空，不产生"无佐证"噪音） */
    const evidence = {};
    for (const c of pr.commits || []) {
      if (c.level !== 'L1' && c.level !== 'L2') continue;
      for (const t of repoTeams[c.repoId] || []) {
        evidence[t] = evidence[t] || { l1: 0, l2: 0 };
        if (c.level === 'L1') evidence[t].l1++;
        else evidence[t].l2++;
      }
    }
    out.evidence = evidence;

    /* git 信号块（Skill 5 用）：L1-L4 分布 + L2 待确认数（confirmed yes 的 hash 不计） */
    const confirmedHashes = new Set((pr.confirms || []).filter(c => c && c.yes).map(c => c.hash));
    out.git = {
      stats: pr.stats || {},
      lastRefreshAt: pr.lastRefreshAt || null,
      l2Pending: (pr.commits || []).filter(c => c.level === 'L2' && !confirmedHashes.has(c.hash)).length
    };
    return out;
  }
};

/* ---------- 2. deviations：迭代偏差（与平台核算同源） ---------- */
const deviationsProvider = {
  id: 'deviations',
  label: '迭代人力偏差',
  enabled: true,
  load(ctx) {
    const it = readJson(path.join(ctx.root, 'data', 'iteration', 'state.json'));
    /* 没有数据文件 = 这台机器还没导入过迭代数据，属于「本来就没数据」，
       安静返回 null。全新部署不该看到一串假的采集错误。 */
    if (!it) return null;

    /* 有数据却没 TEAMS，才是真的不对劲：calc.js 靠全局 TEAMS 算偏差
       （由 server.js 注入），裸 node 里 require 引擎就会走到这。
       这种情况必须吵 —— 静默下去就是 2026-09-22 那次 82 条待办误标的老路。 */
    if (typeof global.TEAMS === 'undefined') {
      throw new Error('全局 TEAMS 未注入（多半是没经 server.js 启动，直接 require 了引擎）');
    }

    const calc = require(path.join(ctx.root, 'calc.js'));
    const computed = calc.compute(it);

    return {
      deviations: (computed.deviation || []).map(d => ({
        team: d.team, workload: d.workload, head: d.head, capacity: d.capacity,
        over: d.over, ratio: d.ratio, verdict: d.verdict, workloadOverridden: d.workloadOverridden
      })),
      reconcile: computed.reconcile || [],
      iterations: it.iterations || [],
      /* plan 块（Skill WBS 生成用）：产品线×团队规划行 + 周期里程碑
         （共享团队会跨产品线，不强行拆树） */
      plan: {
        productLines: (global.PRODUCT_LINES || []).slice(),
        otherCategories: ((global.OTHER_CATEGORIES) || []).map(c => c.key),
        cycles: (it.cycles || []).map(c => ({ name: c.name, seal: c.seal, online: c.online, active: c.active })),
        board: (it.board || []).map(b => ({ line: b.productLine || '', team: b.team || '', est: b.est || 0 })),
        /* headcount：团队人头与负责人（charter / stakeholder 用；owner 只取人名，脱敏口径） */
        headcount: it.headcount || {}
      }
    };
  }
};

/* ---------- 3. history：趋势（最近 2 期归档快照的偏差） ---------- */
const historyProvider = {
  id: 'history',
  label: '迭代历史归档',
  enabled: true,
  load(ctx) {
    const histDir = path.join(ctx.root, 'data', 'iteration', 'history');
    let files;
    try { files = fs.readdirSync(histDir).sort().slice(-2); }
    catch (e) { return null; }   // 没有归档目录 = 没有趋势，不是错误

    const history = [];
    for (const f of files) {
      const h = readJson(path.join(histDir, f));
      if (!h) continue;
      history.push({
        at: h.updatedAt || f,
        deviations: (h.deviations || []).map(x => ({ ratio: x.ratio, verdict: x.verdict }))
      });
    }
    return { history };
  }
};

/* ---------- 4. plans：项目计划里程碑 ---------- */
const plansProvider = {
  id: 'plans',
  label: '项目计划里程碑',
  enabled: true,
  load(ctx) {
    const plan = readJson(path.join(ctx.root, 'data', 'plan', 'state.json'));
    if (!plan || !plan.plans) return null;
    return {
      plans: plan.plans.map(p => ({
        id: p.id,
        title: p.title || p.name || String(p.id),
        due: p.due || null,
        status_category: p.status_category || 'todo'
      }))
    };
  }
};

/* ---------- 5. knowledge：各 Skill 采纳率 + 历史产出类目分布 ---------- */
const knowledgeProvider = {
  id: 'knowledge',
  label: 'Skill 知识沉淀',
  enabled: true,
  load(ctx) {
    const sk = readJson(path.join(ctx.dataPath, 'state.json'));
    const catCount = {};
    for (const r of (sk && sk.results) || []) {
      for (const i of (r && r.items) || []) {
        if (i && i.category) catCount[i.category] = (catCount[i.category] || 0) + 1;
        /* 旧格式 items 无 category，归入综合（不丢数据也不虚构类目） */
        else if (i) catCount['综合'] = (catCount['综合'] || 0) + 1;
      }
    }
    return {
      knowledge: {
        stats: (sk && sk.stats) || {},
        categoryCount: catCount,
        resultCount: ((sk && sk.results) || []).length
      }
    };
  }
};

/* ══════════════════════════════════════════════════════════════
   注册表
   ══════════════════════════════════════════════════════════════ */

/* 顺序即执行顺序。新增数据源在这里加一项，engine.js 不用动。 */
const REGISTRY = [
  reposProvider,
  deviationsProvider,
  historyProvider,
  plansProvider,
  knowledgeProvider
];

/** 输入对象的初值 —— 也是「某个 provider 没跑时下游拿到的形状」的契约 */
function emptyInputs() {
  return {
    now: Date.now(),
    repos: [],
    deviations: [],
    reconcile: [],
    plans: [],
    history: [],
    evidence: {},
    plan: { productLines: [], otherCategories: [], cycles: [], board: [] }
  };
}

/**
 * 采集全部输入。
 * @param {object} [opts]
 * @param {string[]} [opts.only]  只跑这些 provider（排障用）
 * @returns {{inputs:object, errors:Array<{id,label,message}>, skipped:Array<{id,reason}>}}
 */
function collect(opts) {
  const o = opts || {};
  const env = process.env.SKILL_INPUT_MODE === 'empty' ? 'empty' : 'live';
  const cfg = loadConfig();
  const inputs = emptyInputs();
  const errors = [];
  const skipped = [];
  const done = new Set();

  const ctx = { root: ROOT, inputs, dataPath: dataPath(), env };

  for (const p of REGISTRY) {
    if (o.only && o.only.indexOf(p.id) < 0) { skipped.push({ id: p.id, reason: '未选中' }); continue; }
    if (cfg.disabled.indexOf(p.id) >= 0) { skipped.push({ id: p.id, reason: '已被 inputs.json 禁用' }); continue; }
    if (!p.enabled && cfg.enabled.indexOf(p.id) < 0) { skipped.push({ id: p.id, reason: '默认关闭' }); continue; }
    /* 依赖的 provider 没成功 → 跳过，避免必然抛错（原因已在 errors 里记着了） */
    const missDep = (p.deps || []).filter(d => !done.has(d));
    if (missDep.length) { skipped.push({ id: p.id, reason: '依赖未成功：' + missDep.join(', ') }); continue; }

    try {
      const out = p.load(ctx);
      if (out) Object.assign(inputs, out);
      done.add(p.id);
    } catch (e) {
      /* 关键：这里只把错误记下来，不改动 inputs 的既有值。
         静默吞掉才是灾难 —— 见文件头的 2026-09-22 事故。 */
      const message = (e && e.message) || String(e);
      errors.push({ id: p.id, label: p.label, message });
      console.warn('[skill][inputs] ' + p.label + '（' + p.id + '）采集失败：' + message);
    }
  }

  /* 挂到 inputs 上，让 engine 的返回值 / 自检接口能把它报出去 */
  inputs.__errors = errors;
  inputs.__skipped = skipped;
  return { inputs, errors, skipped };
}

/** 兼容原 engine.collectInputs()：只要输入对象 */
function collectInputs() {
  const r = collect();
  return r.inputs;
}

/** 自检：给运维看「哪个源通了、哪个没通、为什么」 */
function status() {
  const cfg = loadConfig();
  return {
    mode: process.env.SKILL_INPUT_MODE === 'empty' ? 'empty' : 'live',
    dataPath: dataPath(),
    disabled: cfg.disabled,
    providers: REGISTRY.map(p => ({
      id: p.id,
      label: p.label,
      deps: p.deps || [],
      enabled: cfg.disabled.indexOf(p.id) < 0 && (p.enabled || cfg.enabled.indexOf(p.id) >= 0)
    }))
  };
}

module.exports = {
  collect,
  collectInputs,
  status,
  emptyInputs,
  REGISTRY,
  _internal: { readJson, loadConfig }
};
