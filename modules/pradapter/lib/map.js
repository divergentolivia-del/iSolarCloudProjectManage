/* modules/pradapter/lib/map.js — Git 提交 → 任务/项目 映射推理引擎（纯函数）
   master §4.3：L1 显式关联 / L2 语义关联 / L3 仓库关联 / L4 无法关联。
   克制原则：映射结果只是"佐证"，不计算完成度。 */

'use strict';

/** 标题内任务号：'#123'、'Closes #123'、'fixes 123' */
const TASK_NUM_RE = /(?:^|\s)#(\d{1,9})|(?:^|\s)(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s*#?(\d{1,9})/i;
/** 分支内任务号：'123_xxx'、'feature/123-abc'、'123' */
const BRANCH_TASK_RE = /(?:^|\/)(\d{1,9})(?:_|-|\.|$)/;

/**
 * 从标题/分支提取任务号。
 * @returns {string|null}
 */
function extractTaskNo(text) {
  if (!text) return null;
  const m = TASK_NUM_RE.exec(text);
  if (m) return m[1] || m[2] || null;
  const b = BRANCH_TASK_RE.exec(text);
  return b ? b[1] : null;
}

/** token 化：中文按相邻二字 bigram，英文按 ≥2 字符单词 */
function tokens(s) {
  const t = String(s || '').toLowerCase();
  const zh = (t.match(/[\u4e00-\u9fa5]+/g) || []).flatMap(w => {
    const out = [];
    for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    if (w.length === 1) out.push(w);
    return out;
  });
  const en = t.match(/[a-z0-9]{2,}/g) || [];
  return Array.from(new Set([...zh, ...en]));
}

/** 相似度 = max(覆盖率, Dice)。
    覆盖率（交集/|A|）适合「提交标题 ⊆ 任务标题」；
    Dice 适合「两边都长」；取 max 对两种场景都稳。 */
function similarity(a, b) {
  const sa = new Set(a), sb = new Set(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  sa.forEach(x => { if (sb.has(x)) inter++; });
  const coverage = inter / sa.size;
  const dice = (2 * inter) / (sa.size + sb.size);
  return Math.max(coverage, dice);
}

/**
 * L2 语义匹配：文本 vs 任务标题列表，返回最佳候选。
 * @returns {{taskId:string, score:number}|null}
 */
function semanticMatch(text, tasks) {
  const tt = tokens(text);
  if (!tt.length) return null;
  let best = null;
  for (const t of tasks || []) {
    const title = t && (t.title || t.name || '');
    if (!title) continue;
    const s = similarity(tt, tokens(title));
    if (!best || s > best.score) best = { taskId: String(t.id), score: s };
  }
  return best && best.score >= 0.35 ? best : null;
}

/**
 * 四级映射入口（纯函数）。
 * @param {{subject:string, branch:string}} commit
 * @param {Array<{id:string, title?:string, name?:string}>} tasks 平台任务库（可空）
 * @returns {{level:'L1'|'L2'|'L4', taskId?:string, confidence:number, reason:string}}
 *   L3 由调用方按仓库 module 配置标注（本函数不知道仓库配置）。
 */
function matchCommit(commit, tasks) {
  const subject = String(commit.subject || '').trim();
  const branch = String(commit.branch || '').trim();

  // L1 显式关联：标题或分支含任务号
  const no = extractTaskNo(subject) || extractTaskNo(branch);
  if (no) {
    const known = (tasks || []).some(t => String(t.id) === no);
    return {
      level: 'L1',
      taskId: no,
      confidence: 0.95,
      reason: known
        ? `标题/分支含任务号 #${no}，平台任务库已收录`
        : `标题/分支含任务号 #${no}（任务库暂未收录，仍按 L1 记）`
    };
  }

  // L2 语义关联：标题/分支与任务标题相似
  const best = semanticMatch(subject + ' ' + branch, tasks);
  if (best) {
    return {
      level: 'L2',
      taskId: best.taskId,
      confidence: Math.round(best.score * 100) / 100,
      reason: `标题/分支与任务「${best.taskId}」相似度 ${best.score.toFixed(2)}，需人工确认`
    };
  }

  return { level: 'L4', confidence: 0, reason: '无显式/语义关联，仅进原始日志' };
}

module.exports = { matchCommit, extractTaskNo, semanticMatch, similarity, tokens };