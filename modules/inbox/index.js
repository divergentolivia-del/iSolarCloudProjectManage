/* modules/inbox/index.js — 今日待确认
   视图：单页。
     ┌ 顶部数字条：待确认 N 件（其中高风险 M 件）· 累计采纳率 X%
     ├ 各 Skill 状态行：跑了多少次 / 采了多少 / 待确认多少 / 最近一次时间
     └ 待确认项卡片：按严重度排序，逐条「采纳 / 驳回」

   为什么要这个页面（路线图口径）：
     AI 的输出必须是「一个需要人点确认的待办」，不是「一堆需要人去读的报告」。
     skill 模块是「按 Skill 看」，用户要挨个点进去才知道有没有事；
     这里是「今天要你拍板的 N 件事」，跨 Skill 拉平到一处。
     采纳率是唯一诚实指标 —— 模型说得准不准，看人点「采纳」的比例，不看模型自评。

   写入口径：一律走 /api/inbox/confirm → skill 引擎的 confirm()，不在这里自己改状态。
   采纳率的分母只能有一处维护。 */

// eslint-disable-next-line no-unused-vars
const InboxModule = (() => {
  'use strict';

  let container = null;
  let data = null;              // GET /api/inbox 的响应
  let loading = true;
  let errorMsg = '';
  let busy = new Set();         // 正在提交的 itemId，防重复点击
  let filter = 'all';           // all | high

  const SEVERITY_LABEL = { high: '高', medium: '中', low: '低' };
  const SEVERITY_CLASS = { high: 'ib-sev-high', medium: 'ib-sev-med', low: 'ib-sev-low' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* 相对时间：待确认项的价值随时间衰减，绝对时间戳对「这事还新不新」没有帮助 */
  function relTime(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (isNaN(t)) return '—';
    const min = Math.floor((Date.now() - t) / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' 小时前';
    const d = Math.floor(h / 24);
    if (d < 31) return d + ' 天前';
    return iso.slice(0, 10);
  }

  async function fetchInbox() {
    loading = true;
    errorMsg = '';
    if (container) render();
    try {
      const r = await fetch('/api/inbox', { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        errorMsg = j.error || ('加载失败（HTTP ' + r.status + '）');
        data = null;
      } else {
        data = j;
      }
    } catch (e) {
      errorMsg = '加载失败：' + ((e && e.message) || e);
      data = null;
    }
    loading = false;
    render();
    updateBadge();
  }

  /* 侧栏红点：待确认件数。这是「用户不点进来也知道有事」的唯一途径。
     用平台自己的 setBadge（Platform 公开 API），不另造一套 —— 徽标样式与
     隐藏规则只该有一处实现。Platform 还没初始化时静默跳过。 */
  function updateBadge() {
    if (typeof Platform === 'undefined' || !Platform.setBadge) return;
    Platform.setBadge('inbox', data ? (data.total || 0) : 0);
  }

  async function decide(item, yes) {
    if (busy.has(item.itemId)) return;
    busy.add(item.itemId);
    render();
    try {
      const r = await fetch('/api/inbox/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resultId: item.resultId, itemId: item.itemId, yes: !!yes })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        busy.delete(item.itemId);
        render();
        alert(j.error || '操作失败');
        return;
      }
      /* 成功：本地就地移除，再静默重拉一次让统计数字同步。
         不整页重拉是因为整页闪一下很难看，而这一条本来就该消失。 */
      if (data && data.items) {
        data.items = data.items.filter(x => x.itemId !== item.itemId);
        data.total = data.items.length;
        data.high = data.items.filter(x => x.severity === 'high').length;
      }
      busy.delete(item.itemId);
      render();
      updateBadge();
      refreshStatsOnly();
    } catch (e) {
      busy.delete(item.itemId);
      render();
      alert('操作失败：' + ((e && e.message) || e));
    }
  }

  /* 只把顶部数字条刷新掉，不动列表（列表已经就地改过了） */
  async function refreshStatsOnly() {
    try {
      const r = await fetch('/api/inbox', { credentials: 'same-origin' });
      if (!r.ok) return;
      const j = await r.json();
      if (!data) return;
      data.bySkill = j.bySkill;
      data.adoptRate = j.adoptRate;
      data.generatedAt = j.generatedAt;
      render();
      updateBadge();
    } catch (e) { /* 静默：列表已经是正确的，统计数字晚一轮同步无妨 */ }
  }

  /* ---------- 渲染 ---------- */

  function renderStats() {
    const total = data ? (data.total || 0) : 0;
    const high = data ? (data.high || 0) : 0;
    const rate = data && data.adoptRate != null ? data.adoptRate + '%' : '—';
    return `
      <div class="ib-stats">
        <div class="ib-stat ${total > 0 ? 'ib-stat-active' : ''}">
          <div class="ib-stat-num">${total}</div>
          <div class="ib-stat-label">待确认</div>
        </div>
        <div class="ib-stat ${high > 0 ? 'ib-stat-danger' : ''}">
          <div class="ib-stat-num">${high}</div>
          <div class="ib-stat-label">其中高风险</div>
        </div>
        <div class="ib-stat">
          <div class="ib-stat-num">${rate}</div>
          <div class="ib-stat-label">累计采纳率</div>
        </div>
      </div>`;
  }

  function renderSkillRow(s) {
    const rate = s.adoptRate != null ? s.adoptRate + '%' : '—';
    return `
      <div class="ib-skill">
        <span class="ib-skill-name">${esc(s.name)}</span>
        <span class="ib-skill-meta">
          跑 ${s.runs} 次 · 采纳 ${s.adopted} · 驳回 ${s.rejected} · 采纳率 ${rate}
          ${s.lastAt ? ' · 最近 ' + esc(relTime(s.lastAt)) : ''}
        </span>
        <span class="ib-skill-pending ${s.pendingCount > 0 ? 'ib-pending-on' : ''}">
          ${s.pendingCount > 0 ? '待确认 ' + s.pendingCount : '无待办'}
        </span>
      </div>`;
  }

  function renderItem(it) {
    const isBusy = busy.has(it.itemId);
    return `
      <div class="ib-card ${it.severity === 'high' ? 'ib-card-high' : ''}">
        <div class="ib-card-head">
          <span class="ib-sev ${SEVERITY_CLASS[it.severity] || 'ib-sev-med'}">${SEVERITY_LABEL[it.severity] || '中'}</span>
          <span class="ib-card-title">${esc(it.title)}</span>
          <span class="ib-card-src">${esc(it.skillName)} · ${esc(relTime(it.createdAt))}</span>
        </div>
        ${it.detail ? `<div class="ib-card-detail">${esc(it.detail)}</div>` : ''}
        ${it.action ? `<div class="ib-card-action"><span class="ib-action-tip">建议动作</span>${esc(it.action)}</div>` : ''}
        <div class="ib-card-foot">
          <button class="ib-btn ib-btn-yes" data-yes="${esc(it.itemId)}" ${isBusy ? 'disabled' : ''}>采纳</button>
          <button class="ib-btn ib-btn-no" data-no="${esc(it.itemId)}" ${isBusy ? 'disabled' : ''}>驳回</button>
          ${isBusy ? '<span class="ib-busy">提交中…</span>' : ''}
        </div>
      </div>`;
  }

  function render() {
    if (!container) return;

    if (loading) {
      container.innerHTML = '<div class="ib-page"><div class="ib-loading">加载中…</div></div>';
      return;
    }
    if (errorMsg) {
      container.innerHTML = `<div class="ib-page"><div class="ib-error">${esc(errorMsg)}
        <div class="ib-error-hint">如果是「没有权限：inbox:read」，说明当前账号的角色没有这个权限点。</div>
      </div></div>`;
      return;
    }

    const all = (data && data.items) || [];
    const items = filter === 'high' ? all.filter(i => i.severity === 'high') : all;

    const filters = [
      { id: 'all', label: '全部 ' + all.length },
      { id: 'high', label: '仅高风险 ' + all.filter(i => i.severity === 'high').length }
    ].map(f => `<button class="ib-filter ${f.id === filter ? 'active' : ''}" data-filter="${f.id}">${esc(f.label)}</button>`).join('');

    const list = items.length
      ? items.map(renderItem).join('')
      : `<div class="ib-empty">
           <div class="ib-empty-icon">${all.length ? '🎯' : '✅'}</div>
           <div class="ib-empty-title">${all.length ? '当前筛选下没有待确认项' : '今天没有待你确认的事'}</div>
           <div class="ib-empty-hint">${all.length
             ? '切回「全部」看看其它严重度的项。'
             : 'AI Skill 每次运行后，新产生的建议都会出现在这里等你拍板。也可以在下方各 Skill 里手动触发一次运行。'}</div>
         </div>`;

    container.innerHTML = `
      <div class="ib-page">
        ${renderStats()}
        <div class="ib-section">
          <div class="ib-section-title">AI 能力现状</div>
          <div class="ib-skills">${((data && data.bySkill) || []).map(renderSkillRow).join('')}</div>
        </div>
        <div class="ib-section">
          <div class="ib-section-head">
            <div class="ib-section-title">待你拍板</div>
            <div class="ib-filters">${filters}</div>
          </div>
          <div class="ib-list">${list}</div>
        </div>
        <div class="ib-footnote">
          采纳率 = 采纳 /（采纳 + 驳回）。这是判断 AI 说得准不准的唯一指标 —— 不看模型自评，看人点没点「采纳」。
          ${data && data.generatedAt ? '<br>数据时间：' + esc(data.generatedAt.slice(0, 19).replace('T', ' ')) : ''}
        </div>
      </div>`;

    bind();
  }

  function bind() {
    container.querySelectorAll('.ib-filter').forEach(b => b.addEventListener('click', () => {
      filter = b.getAttribute('data-filter');
      render();
    }));
    const findItem = id => (((data && data.items) || []).find(x => x.itemId === id));
    container.querySelectorAll('[data-yes]').forEach(b => b.addEventListener('click', () => {
      const it = findItem(b.getAttribute('data-yes')); if (it) decide(it, true);
    }));
    container.querySelectorAll('[data-no]').forEach(b => b.addEventListener('click', () => {
      const it = findItem(b.getAttribute('data-no')); if (it) decide(it, false);
    }));
  }

  /* ---------- ModuleDefinition 接口 ---------- */
  return {
    id: 'inbox',
    name: '今日待确认',
    icon: '📥',
    order: 1,          // 排在 dashboard 之后、业务模块之前：它是每天第一个该点开的地方
    sidebar: true,

    init(el) {
      container = el;
      fetchInbox();
    },
    enter() {
      /* 每次进来都重拉：待确认项可能因为别人运行了 Skill 而变多 */
      fetchInbox();
    },
    leave() { },
    getSummary() {
      return { pending: data ? (data.total || 0) : 0, high: data ? (data.high || 0) : 0 };
    },
    refresh: fetchInbox
  };
})();
