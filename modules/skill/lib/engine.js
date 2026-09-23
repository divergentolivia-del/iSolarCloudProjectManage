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
const wbsSkill = require('../skills/wbs');
const knowledgeSkill = require('../skills/knowledge');
const charterSkill = require('../skills/charter');
const stakeholderSkill = require('../skills/stakeholder');
const meetingSkill = require('../skills/meeting');
const retroSkill = require('../skills/retro');
const inputsProvider = require('./inputs');

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

/* ---------- 输入注入 ----------
 * 采集逻辑已拆到 lib/inputs.js 的 provider 注册表：加数据源改那个文件，
 * 这个函数不用动。这里只做转调。
 *
 * ⚠ 不要在这里加 try/catch 把错误吞掉。2026-09-22 的事故就是这么来的：
 *   采集整段失败被静默吞掉 → deviations=[] → 三个 Skill 各产出 0 项 →
 *   82 条待办被标成 expired，用户看到「今天没风险」，真相是「压根没采到」。
 *   inputs.js 里单个 provider 失败会记进 inputs.__errors 并打 warn，
 *   是「部分失败可见」；这里再包一层 catch 就又变回「整体静默」了。
 */
function collectInputs() {
  return inputsProvider.collectInputs();
}

/* ---------- 执行与落库 ---------- */

const SKILLS = {
  risk: { meta: { id: 'risk', name: riskSkill.name, desc: riskSkill.desc }, run: riskSkill.identify },
  variance: { meta: { id: 'variance', name: varianceSkill.name, desc: varianceSkill.desc }, run: varianceSkill.analyze },
  report: { meta: { id: 'report', name: reportSkill.name, desc: reportSkill.desc }, run: reportSkill.generate },
  health: { meta: { id: 'health', name: healthSkill.name, desc: healthSkill.desc }, run: healthSkill.assess },
  gitsignals: { meta: { id: 'gitsignals', name: gitsignalsSkill.name, desc: gitsignalsSkill.desc }, run: gitsignalsSkill.analyze },
  workload: { meta: { id: 'workload', name: workloadSkill.name, desc: workloadSkill.desc }, run: workloadSkill.analyze },
  wbs: { meta: { id: 'wbs', name: wbsSkill.name, desc: wbsSkill.desc }, run: wbsSkill.generate },
  knowledge: { meta: { id: 'knowledge', name: knowledgeSkill.name, desc: knowledgeSkill.desc }, run: knowledgeSkill.accumulate },
  charter: { meta: { id: 'charter', name: charterSkill.name, desc: charterSkill.desc }, run: charterSkill.generate },
  stakeholder: { meta: { id: 'stakeholder', name: stakeholderSkill.name, desc: stakeholderSkill.desc }, run: stakeholderSkill.analyze },
  meeting: { meta: { id: 'meeting', name: meetingSkill.name, desc: meetingSkill.desc }, run: meetingSkill.extract },
  retro: { meta: { id: 'retro', name: retroSkill.name, desc: retroSkill.desc }, run: retroSkill.extract }
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
  /* health / gitsignals / workload / wbs / knowledge 直接输出 items 字段（新增 Skill 时记得在这里注册；ref:true 的佐证项自动跳过） */
  if (['health', 'gitsignals', 'workload', 'wbs', 'knowledge', 'charter', 'stakeholder', 'meeting', 'retro'].includes(skillId)) (output.items || []).forEach(o => push(o));
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

module.exports = { ensureData, listSkills, run, confirm, latest, collectInputs, inputStatus: inputsProvider.status, _internal: { normalizeItems } };