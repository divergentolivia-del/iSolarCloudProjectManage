/* modules/skill/lib/engine.js — Skill 运行时：输入注入 → 规则执行 → 待确认落库
   master §7.3 评测集 + §9 决策记录：
   - 输出统一落成「待确认项」，人确认后生效（决策 3）
   - 采纳率是唯一诚实的指标（决策 7）：adoptRate = 采纳 / 已确认
   - 输入全部走脱敏口径：代码仓库 = L3 只取统计特征，不传原文（m1 脱敏规范） */

'use strict';

const fs = require('fs');
const path = require('path');

const riskSkill = require('../skills/risk');
const varianceSkill = require('../skills/variance');
const reportSkill = require('../skills/report');
const healthSkill = require('../skills/health');
const gitsignalsSkill = require('../skills/gitsignals');
const workloadSkill = require('../skills/workload');

const DATA_DIR = process.env.SKILL_DATA_DIR || path.join(__dirname, '..', '..', '..', 'data', 'skill');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const EMPTY_STATE = { results: [], stats: {} };

/* ---------- 数据 ---------- */

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(EMPTY_STATE, null, 2), 'utf8');
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return JSON.parse(JSON.stringify(EMPTY_STATE)); }
}
function writeState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/* ---------- 输入注入（脱敏口径） ---------- */

function collectInputs() {
  const root = path.join(__dirname, '..', '..', '..');
  const inputs = { now: Date.now(), repos: [], deviations: [], reconcile: [], plans: [], history: [], evidence: {} };

  /* pradapter：仓库统计特征（L3，不含提交原文） */
  const pr = readJson(path.join(root, 'data', 'pradapter', 'state.json'));
  const prCfg = readJson(path.join(root, 'data', 'pradapter', 'config.json'));
  /* 仓库→团队显式映射（config.json repos[].teams），不靠仓库名猜 */
  const repoTeams = {};
  for (const r of (prCfg && prCfg.repos) || []) {
    if (r && r.id && Array.isArray(r.teams)) repoTeams[r.id] = r.teams.filter(Boolean);
  }
  inputs.evidenceConfigured = Object.keys(repoTeams).some(k => repoTeams[k].length > 0);
  if (pr && pr.repos) {
    inputs.repos = pr.repos.map(r => ({
      id: r.id, name: r.name, ok: r.ok, error: r.error, lastCommitAt: r.lastCommitAt
    }));
    /* PR 佐证：只按显式映射聚合（未配置映射时 evidence 为空，不产生"无佐证"噪音） */
    for (const c of pr.commits || []) {
      if (c.level !== 'L1' && c.level !== 'L2') continue;
      for (const t of repoTeams[c.repoId] || []) {
        inputs.evidence[t] = inputs.evidence[t] || { l1: 0, l2: 0 };
        if (c.level === 'L1') inputs.evidence[t].l1++;
        else inputs.evidence[t].l2++;
      }
    }
    /* git 信号块（Skill 5 用）：L1-L4 分布 + L2 待确认数（confirmed yes 的 hash 不计） */
    const confirmedHashes = new Set((pr.confirms || []).filter(c => c && c.yes).map(c => c.hash));
    inputs.git = {
      stats: pr.stats || {},
      lastRefreshAt: pr.lastRefreshAt || null,
      l2Pending: (pr.commits || []).filter(c => c.level === 'L2' && !confirmedHashes.has(c.hash)).length
    };
  }

  /* iteration：calc.compute 偏差（与平台核算同源） */
  const it = readJson(path.join(root, 'data', 'iteration', 'state.json'));
  if (it && typeof global.TEAMS !== 'undefined') {
    try {
      const calc = require(path.join(root, 'calc.js'));
      const computed = calc.compute(it);
      inputs.deviations = (computed.deviation || []).map(d => ({
        team: d.team, workload: d.workload, head: d.head, capacity: d.capacity,
        over: d.over, ratio: d.ratio, verdict: d.verdict, workloadOverridden: d.workloadOverridden
      }));
      inputs.reconcile = computed.reconcile || [];
      inputs.iterations = it.iterations || [];
      /* 趋势：最近 2 期历史快照的偏差（存档在 data/iteration/history/） */
      const histDir = path.join(root, 'data', 'iteration', 'history');
      try {
        const files = fs.readdirSync(histDir).sort().slice(-2);
        for (const f of files) {
          const h = readJson(path.join(histDir, f));
          if (!h) continue;
          inputs.history.push({ at: h.updatedAt || f, deviations: (h.deviations || []).map(x => ({
            ratio: x.ratio, verdict: x.verdict
          })) });
        }
      } catch (e) { /* 无历史则无趋势 */ }
      } catch (e) {
        /* 这里绝不能静默。
           2026-09-22 踩过：裸 node 里跑 engine.run()（没经过 server.js）时，
           calc.js 依赖的全局 TEAMS 不存在，require/调用抛 ReferenceError，
           被这个 catch 吞掉后 deviations=[]，三个 Skill 于是都产出 0 项 ——
           表面上"运行成功"，实际把 82 条待办全部标成 expired，
           用户看到的是"今天没风险"，而真相是"输入压根没采集到"。
           宁可吵，也要让这种失败在日志里露头。 */
        console.warn('[skill] 偏差输入采集失败，本轮的偏差类结论将为空：' + ((e && e.message) || e));
        console.warn('[skill] 常见原因：直接 require 引擎但未经 server.js 启动，全局 TEAMS 未注入。');
      }
  }

  /* plan：里程碑（可空） */
  const plan = readJson(path.join(root, 'data', 'plan', 'state.json'));
  if (plan && plan.plans) {
    inputs.plans = plan.plans.map(p => ({
      id: p.id, title: p.title || p.name || String(p.id),
      due: p.due || null, status_category: p.status_category || 'todo'
    }));
  }

  return inputs;
}

/* ---------- 执行与落库 ---------- */

const SKILLS = {
  risk: { meta: { id: 'risk', name: riskSkill.name, desc: riskSkill.desc }, run: riskSkill.identify },
  variance: { meta: { id: 'variance', name: varianceSkill.name, desc: varianceSkill.desc }, run: varianceSkill.analyze },
  report: { meta: { id: 'report', name: reportSkill.name, desc: reportSkill.desc }, run: reportSkill.generate },
  health: { meta: { id: 'health', name: healthSkill.name, desc: healthSkill.desc }, run: healthSkill.assess },
  gitsignals: { meta: { id: 'gitsignals', name: gitsignalsSkill.name, desc: gitsignalsSkill.desc }, run: gitsignalsSkill.analyze },
  workload: { meta: { id: 'workload', name: workloadSkill.name, desc: workloadSkill.desc }, run: workloadSkill.analyze }
};

function listSkills() {
  const st = readState();
  const results = st.results || [];
  return Object.keys(SKILLS).map(id => {
    const s = SKILLS[id];
    const raw = Object.assign({ runCount: 0, adoptCount: 0, rejectCount: 0, pendingCount: 0 }, st.stats[id]);
    const confirmed = raw.adoptCount + raw.rejectCount;
    /* pendingCount 从留存结果动态重算（即使历史被裁剪也不会虚高） */
    const pending = results
      .filter(r => r.skill === id)
      .reduce((a, r) => a + (r.items || []).filter(i => i.status === 'pending').length, 0);
    return Object.assign({}, s.meta, { stats: Object.assign({}, raw, {
      adoptRate: confirmed > 0 ? Math.round(100 * raw.adoptCount / confirmed) : null,
      pendingCount: pending
    }) });
  });
}

/**
 * 运行一个 Skill。
 * @param {string} id skill id
 * @param {object|null} overrideInputs 测试注入用（可空）
 * @returns {{ok:boolean, result:object, error?:string}}
 */
function run(id, overrideInputs) {
  const s = SKILLS[id];
  if (!s) return { ok: false, error: '未知 Skill：' + id };
  const inputs = overrideInputs || collectInputs();
  /* 周报的「风险」节与风险识别 Skill 同源：先跑一遍 risk，避免永远落到兑底文案；
     健康度的风险维同理由同源注入 */
  if (id === 'report' || id === 'health') inputs.risks = riskSkill.identify(inputs).items;
  let output;
  try { output = s.run(inputs); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  /* 输出规范 → 待确认项 */
  const st = readState();
  /* 同 Skill 重新运行 = 最新结果覆盖：旧结果的 pending 项标记为 expired（失效，不计入采纳率分母/待确认数） */
  const expiredCount = { n: 0 };
  for (const old of st.results || []) {
    if (old.skill !== id) continue;
    for (const it of old.items || []) {
      if (it.status === 'pending') {
        it.status = 'expired';
        it.expiredAt = new Date().toISOString();
        expiredCount.n++;
      }
    }
  }
  const resultId = id + '-' + Date.now();
  const items = normalizeItems(id, output, resultId);
  const result = {
    resultId, skill: id, at: new Date().toISOString(),
    inputs: summarizeInputs(inputs), output, items
  };
  st.results = (st.results || []).concat([result]).slice(-500);
  st.stats[id] = st.stats[id] || { runCount: 0, adoptCount: 0, rejectCount: 0, pendingCount: 0 };
  st.stats[id].runCount++;
  writeState(st);
  return { ok: true, result, expired: expiredCount.n };
}

/**
 * 确认/驳回待确认项（决策 3：人确认后生效；决策 7：采纳率回灌）。
 */
function confirm(resultId, itemId, yes, who) {
  const st = readState();
  const r = (st.results || []).find(x => x.resultId === resultId);
  if (!r) return { ok: false, error: '找不到结果 ' + resultId };
  const item = (r.items || []).find(i => i.itemId === itemId);
  if (!item) return { ok: false, error: '找不到待确认项 ' + itemId };
  if (item.status !== 'pending') return { ok: false, error: '该项已处理（' + item.status + '）' };

  item.status = yes ? 'adopted' : 'rejected';
  item.decidedAt = new Date().toISOString();
  item.decidedBy = who || '';

  const stat = st.stats[r.skill] = st.stats[r.skill] || { runCount: 0, adoptCount: 0, rejectCount: 0, pendingCount: 0 };
  if (yes) stat.adoptCount++; else stat.rejectCount++;
  stat.pendingCount = (r.items || []).filter(i => i.status === 'pending').length;
  const confirmed = stat.adoptCount + stat.rejectCount;
  stat.adoptRate = confirmed > 0 ? Math.round(100 * stat.adoptCount / confirmed) : null;
  writeState(st);

  return {
    ok: true,
    stats: {
      adoptCount: stat.adoptCount, rejectCount: stat.rejectCount, pendingCount: stat.pendingCount,
      adoptRate: stat.adoptCount + stat.rejectCount > 0
        ? Math.round(100 * stat.adoptCount / (stat.adoptCount + stat.rejectCount)) : null
    }
  };
}

function latest(id) {
  const st = readState();
  const r = (st.results || []).filter(x => x.skill === id).pop();
  return r || null;
}

/* ---------- 内部 ---------- */

/* 严重度归一化。
   各 Skill 的原始取值并不统一：risk.js 发中文「高/中/低」，report/variance 的
   待确认项压根不带 severity。若原样透传，下游（今日待确认页）拿到的就是
   「高」和「medium」两种词汇混在一起的值 —— 排序表只认英文，5 条真正的高风险
   会被当成未知值排到最后，高风险的计数还是 0，页面看起来"一条严重的都没有"。

   所以在这里收敛成唯一一套 canonical 值：high | medium | low。
   中文别名照收，避免以后有人照 risk.js 的写法再发中文。 */
const SEVERITY_ALIAS = {
  '高': 'high', '中': 'medium', '低': 'low',
  high: 'high', medium: 'medium', low: 'low',
  critical: 'high', high_risk: 'high', warn: 'medium', warning: 'medium'
};
function normalizeSeverity(v) {
  const k = String(v == null ? '' : v).trim().toLowerCase();
  return SEVERITY_ALIAS[k] || SEVERITY_ALIAS[v] || 'medium';
}

/* 引用性条目（ref:true）不进待确认队列。
   2026-09-22 用户拍板：AI 只该分析【还没被人整理过的原始信号】，不该复述
   【已经被算出来的结论】。迭代偏差就是已算出来的结论 —— 迭代版本页面上一眼看得见，
   线下本来就要照它开会，再发一条"待确认"只是让同一份数据在待办里再出现一次，
   除了稀释真正的待办，没有别的效果。
   这类条目仍留在 output 里（周报的风险节要引用），只是不落库成待办。 */
function normalizeItems(skillId, output, resultId) {
  const items = [];
  const push = o => {
    if (o.ref === true) return;
    items.push({
      resultId, skill: skillId, itemId: o.id || ('it-' + items.length),
      title: o.title, detail: o.detail || o.evidence || '', action: o.action || o.suggestion || '',
      severity: normalizeSeverity(o.severity), status: 'pending', createdAt: new Date().toISOString()
    });
  };
  if (skillId === 'risk') (output.items || []).forEach(o => push(o));
  if (skillId === 'variance') (output.suggestions || []).forEach(o => push(o));
  if (skillId === 'report') (output.pendingConfirm || []).forEach(o => push(o));
  /* health / gitsignals / workload 直接输出 items 字段（新增 Skill 时记得在这里注册） */
  if (skillId === 'health' || skillId === 'gitsignals' || skillId === 'workload') (output.items || []).forEach(o => push(o));
  return items;
}

function summarizeInputs(inputs) {
  return {
    repos: (inputs.repos || []).length,
    deviations: (inputs.deviations || []).map(d => ({ team: d.team, verdict: d.verdict })),
    plans: (inputs.plans || []).length,
    history: (inputs.history || []).length
  };
}

module.exports = { ensureData, listSkills, run, confirm, latest, collectInputs, _internal: { normalizeItems } };