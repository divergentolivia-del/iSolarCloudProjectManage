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
  if (pr && pr.repos) {
    inputs.repos = pr.repos.map(r => ({
      id: r.id, name: r.name, ok: r.ok, error: r.error, lastCommitAt: r.lastCommitAt
    }));
    /* PR 佐证：按团队名匹配仓库名（含"团队名"片段的仓库视为关联） */
    const teamRepo = {};
    for (const r of pr.repos) {
      const n = r.name || '';
      for (const t of ['APP开发', '后端开发', 'Web开发', '测试部', '前端', '平台']) {
        if (n.indexOf(t) >= 0) teamRepo[t] = r.id;
      }
    }
    const byLevel = pr.commits || [];
    for (const c of byLevel) {
      if (c.level !== 'L1' && c.level !== 'L2') continue;
      for (const t of Object.keys(teamRepo)) {
        if (teamRepo[t] === c.repoId) {
          inputs.evidence[t] = inputs.evidence[t] || { l1: 0, l2: 0 };
          if (c.level === 'L1') inputs.evidence[t].l1++;
          else inputs.evidence[t].l2++;
        }
      }
    }
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
    } catch (e) { /* calc 依赖 config 常量，缺失时偏差为空 */ }
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
  report: { meta: { id: 'report', name: reportSkill.name, desc: reportSkill.desc }, run: reportSkill.generate }
};

function listSkills() {
  const st = readState();
  return Object.keys(SKILLS).map(id => {
    const s = SKILLS[id];
    const raw = Object.assign({ runCount: 0, adoptCount: 0, rejectCount: 0, pendingCount: 0 }, st.stats[id]);
    const confirmed = raw.adoptCount + raw.rejectCount;
    return Object.assign({}, s.meta, { stats: Object.assign({}, raw, {
      adoptRate: confirmed > 0 ? Math.round(100 * raw.adoptCount / confirmed) : null
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
  let output;
  try { output = s.run(inputs); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  /* 输出规范 → 待确认项 */
  const st = readState();
  const resultId = id + '-' + Date.now();
  const items = normalizeItems(id, output, resultId);
  const result = {
    resultId, skill: id, at: new Date().toISOString(),
    inputs: summarizeInputs(inputs), output, items
  };
  st.results = (st.results || []).concat([result]).slice(-50);
  st.stats[id] = st.stats[id] || { runCount: 0, adoptCount: 0, rejectCount: 0, pendingCount: 0 };
  st.stats[id].runCount++;
  st.stats[id].pendingCount = items.filter(i => i.status === 'pending').length;
  writeState(st);
  return { ok: true, result };
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

function normalizeItems(skillId, output, resultId) {
  const items = [];
  const push = o => items.push({
    resultId, skill: skillId, itemId: o.id || ('it-' + items.length),
    title: o.title, detail: o.detail || o.evidence || '', action: o.action || o.suggestion || '',
    severity: o.severity || '', status: 'pending', createdAt: new Date().toISOString()
  });
  if (skillId === 'risk') (output.items || []).forEach(o => push(o));
  if (skillId === 'variance') (output.suggestions || []).forEach(o => push(o));
  if (skillId === 'report') (output.pendingConfirm || []).forEach(o => push(o));
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