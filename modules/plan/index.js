/* modules/plan/index.js — 项目计划
   视图：计划列表(平铺卡片) / 计划详情(WBS · 甘特 · 里程碑 · 资源 · 高管视图 · AI预留规则) / 新建+编辑(第二页表单)
   数据源：/api/plan（独立于 iteration，绝不触碰真实工时数据）
   ★ 三条硬性 UX 红线（贯穿全部 view）：
     ① 输入框不截断 —— 5~6 位人天、长结论文本完整展示，不 truncate
     ② 平铺完整展示 —— 内容平铺展开，不做折叠式省略
     ③ 宽表 / 甘特横向可滚动 —— 不挤压布局，横向滚动条承载超宽内容
*/

// eslint-disable-next-line no-unused-vars
const PlanModule = (() => {
  'use strict';

  let container = null;
  let el = null;
  let state = null;
  let summary = null;
  let currentView = 'list';            // list | detail | new | edit
  let currentPlanId = null;
  let currentTab = 'wbs';              // wbs | gantt | milestone | resource | exec | ai
  let dirtyForm = null;                // 编辑中的表单草稿（含 tasks/milestones/resources）
  let expandedWbs = new Set();         // 已展开的 wbs 节点 id
  let filterText = '';
  let isSaving = false;

  /* ---------- 常量表 ---------- */
  const PLAN_STATUS_LABELS = { draft: '草稿', active: '进行中', completed: '已完成', archived: '已归档' };
  const PLAN_STATUS_CLASS = { draft: 'status-planned', active: 'status-active', completed: 'status-done', archived: 'status-hold' };
  const TASK_STATUS_LABELS = { 'not-started': '未开始', 'in-progress': '进行中', completed: '已完成', blocked: '受阻' };
  const TASK_STATUS_CLASS = { 'not-started': 'status-planned', 'in-progress': 'status-active', completed: 'status-done', blocked: 'status-hold' };
  const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' };
  const TASK_TYPE_LABELS = { dev: '开发', test: '测试', design: '设计', doc: '文档', ops: '运维', other: '其他' };
  const MILESTONE_STATUS_LABELS = { pending: '待完成', 'in-progress': '进行中', done: '已完成' };
  const MILESTONE_STATUS_CLASS = { pending: 'status-planned', 'in-progress': 'status-active', done: 'status-done' };
  const RES_KIND_LABELS = { team: '团队', person: '个人' };
  const MEMBER_ROLE_LABELS = { pm: '项目经理', product: '产品经理', system: '系统经理', dev: '研发', test: '测试', design: '设计', other: '其他' };
  const REF_TYPE_LABELS = { requirement: '需求文档', design: '设计文档', test: '测试文档', api: '接口文档', other: '其他' };

  const esc = (t) => (typeof SharedUI !== 'undefined' ? SharedUI.esc(t) : String(t == null ? '' : t));
  const whoami = () => (typeof Platform !== 'undefined' && Platform.whoami ? Platform.whoami() : '未署名');

  /* ==========================================================
     工具函数
     ========================================================== */
  function fmtNum(v, d) {
    if (v == null || isNaN(v)) return '0';
    return Number(v).toLocaleString('zh-CN', d ? { minimumFractionDigits: d, maximumFractionDigits: d } : undefined);
  }
  function round1(v) {
    if (v == null || isNaN(v)) return '0';
    const n = Number(v);
    return Math.abs(n) >= 100 ? Math.round(n).toString() : (Math.round(n * 10) / 10).toString();
  }
  function dateStamp(v) {
    if (!v) return null;
    const t = String(v).trim();
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const date = new Date(y, mo - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return date.getTime();
  }
  function fmtDate(v) {
    if (!v) return '—';
    const t = String(v).trim();
    if (t.length >= 10) return t.slice(0, 10);
    return t;
  }
  function todayStamp() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  }
  function daysBetween(a, b) { return Math.round(Math.abs((a || 0) - (b || 0)) / 86400000); }
  function uid(prefix) {
    return (prefix || 'p') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  function pc(status) { return TASK_STATUS_CLASS[status] || 'status-planned'; }
  function prClass(p) { return PRIORITY_LABELS[p] ? (p === 'high' ? 'risk-badge high' : p === 'medium' ? 'risk-badge medium' : 'risk-badge low') : 'risk-badge low'; }

  function progressWarn(p) {
    // 进度异常：已结束但 <100 或 未开始却 >0（仅提示，不做硬性判定）
    if (p == null || isNaN(p)) return false;
    return Number(p) < 0 || Number(p) > 100;
  }
  function progressFill(p) {
    const v = Math.max(0, Math.min(100, Number(p) || 0));
    return `<div class="progress-bar"><div class="progress-fill ${v >= 100 ? '' : v >= 60 ? '' : ''}" style="width:${v}%"></div></div>`;
  }
  function progressBadge(p) {
    const v = Number(p) || 0;
    return `<div class="progressbar-inline">${progressFill(v)}<span class="progressval">${v}%</span></div>`;
  }

  /* ==========================================================
     数据获取 / 保存（统一走 /api/plan）
     ========================================================== */
  async function fetchState() {
    try {
      const resp = await fetch('/api/plan/state');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      state = await resp.json();
      if (!Array.isArray(state.plans)) state.plans = [];
      return state;
    } catch (e) {
      console.error('[plan] 获取数据失败:', e.message);
      state = { rev: 0, plans: [] };
      return null;
    }
  }
  async function fetchSummary() {
    try {
      const resp = await fetch('/api/plan/summary');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      summary = await resp.json();
    } catch (e) {
      console.error('[plan] 获取汇总失败:', e.message);
      summary = null;
    }
  }
  async function saveState(newState) {
    if (isSaving) return false;
    isSaving = true;
    try {
      const resp = await fetch('/api/plan/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRev: state ? state.rev : 0, state: newState, by: whoami() })
      });
      const result = await resp.json();
      if (resp.status === 409) { SharedUI.toast('数据冲突，请刷新后重试', 'warning'); return false; }
      if (!resp.ok) { SharedUI.toast(result.error || '保存失败', 'error'); return false; }
      // 服务端只回 {ok, rev, updatedAt}，本地同步新 rev，避免下次提交因 baseRev 过期而 409
      state = Object.assign({}, newState, { rev: result.rev, updatedAt: result.updatedAt });
      SharedUI.toast('保存成功', 'success');
      return true;
    } catch (e) {
      SharedUI.toast('网络错误: ' + e.message, 'error');
      return false;
    } finally {
      isSaving = false;
    }
  }
  function getPlan(id) {
    return (state && state.plans || []).find(p => p.id === id) || null;
  }
  function findSummary(id) {
    return (summary && summary.plans || []).find(s => s.id === id) || null;
  }

  /* ==========================================================
     WBS 树构建
     ========================================================== */
  function buildWbsTree(tasks) {
    const list = tasks || [];
    const byId = {};
    list.forEach(t => { byId[t.id] = { ...t, children: [] }; });
    const roots = [];
    list.forEach(t => {
      const node = byId[t.id];
      const parent = t.parentId && byId[t.parentId];
      if (parent) parent.children.push(node);
      else roots.push(node);
    });
    // 按 wbsCode / 名称排序
    const sortFn = (a, b) => String(a.wbsCode || '').localeCompare(String(b.wbsCode || ''), 'zh-CN');
    const deepSort = (arr) => { arr.sort(sortFn); arr.forEach(n => deepSort(n.children)); };
    deepSort(roots);
    return roots;
  }
  function wbsDepth(plan) {
    // 计算 wbs 编码深度：根=1
    if (!plan || !plan.tasks || !plan.tasks.length) return 1;
    const byId = {};
    plan.tasks.forEach(t => { byId[t.id] = t; });
    const depthOf = (t, seen) => {
      if (seen.has(t.id)) return 1;
      seen.add(t.id);
      const p = t.parentId && byId[t.parentId];
      return p ? depthOf(p, seen) + 1 : 1;
    };
    return Math.max(...plan.tasks.map(t => depthOf(t, new Set())));
  }

  /* ==========================================================
     计划列表页（平铺卡片 + 指标条）
     ========================================================== */
  function renderMetricStrip() {
    const agg = (summary && summary.agg) || {};
    const cards = [
      { icon: '📋', value: fmtNum(agg.planCount), label: '计划总数', sub: '全部计划', color: 'green' },
      { icon: '▶️', value: fmtNum(agg.activeCount), label: '进行中', sub: '当前推进', color: 'blue' },
      { icon: '🗂️', value: fmtNum(agg.totalTasks), label: '任务总数', sub: 'WBS 任务', color: 'purple' },
      { icon: '⏱️', value: round1(agg.totalHours) + ' 人天', label: '计划工时', sub: '合计投入', color: 'orange' },
      { icon: '📈', value: (agg.avgProgress || 0) + '%', label: '平均进度', sub: '加权', color: 'teal' },
      { icon: '⚠️', value: fmtNum(agg.riskCount), label: '风险项', sub: '逾期/受阻', color: agg.riskCount > 0 ? 'red' : 'green' }
    ];
    return `<div class="cs-metric-grid">${cards.map(c => `
      <div class="cs-metric cs-metric-${c.color}">
        <div class="cs-metric-top"><span class="cs-metric-icon">${c.icon}</span><span class="cs-metric-trend">${esc(c.sub)}</span></div>
        <div class="cs-metric-value">${c.value}</div>
        <div class="cs-metric-label">${esc(c.label)}</div>
      </div>`).join('')}</div>`;
  }

  function renderPlanCard(s) {
    const wbs = s.wbs || {};
    const ms = s.milestone || {};
    const res = s.resource || {};
    const risks = wbs.risks || s.risks || [];
    const riskCount = (s.risks || []).length;
    const phaseChips = (wbs.phases || []).map(ph => {
      const pct = ph.total ? Math.round((ph.completed || 0) / ph.total * 100) : 0;
      return `<span class="pl-phase-chip"><i>${esc(ph.name)}</i><b>${pct}%</b></span>`;
    }).join('');
    return `
    <div class="pl-card" data-plan-id="${esc(s.id)}">
      <div class="pl-card-head">
        <div class="pl-card-title">
          <span class="pl-card-icon">🗓️</span>
          <div class="pl-card-name">
            <h4>${esc(s.name || s.id)}</h4>
            <span class="pl-card-sub">${esc(s.projectName || '未关联项目')} · ${esc(s.owner || '未指派')}</span>
          </div>
        </div>
        <span class="badge ${PLAN_STATUS_CLASS[s.status] || 'status-planned'}">${esc(PLAN_STATUS_LABELS[s.status] || s.status)}</span>
      </div>
      <div class="pl-card-meta">
        <span>📅 ${esc(fmtDate(s.startDate))} — ${esc(fmtDate(s.endDate))}</span>
        <span class="pl-card-year">${esc(s.year || '')} 年度</span>
      </div>
      <div class="pl-card-progress">
        <div class="pl-progress-label"><span>整体进度</span><b>${wbs.overallProgress || 0}%</b></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${wbs.overallProgress || 0}%"></div></div>
      </div>
      <div class="pl-card-stats">
        <div class="pl-stat"><b>${fmtNum(wbs.total)}</b><span>任务</span></div>
        <div class="pl-stat"><b>${fmtNum(ms.total)}</b><span>里程碑</span></div>
        <div class="pl-stat"><b>${round1(wbs.sumHours)}</b><span>人天</span></div>
        <div class="pl-stat">${res.overloaded ? `<b class="pl-danger">${fmtNum(res.overloaded)}</b><span>资源超载</span>` : `<b>${fmtNum(res.total)}</b><span>资源</span>`}</div>
      </div>
      ${phaseChips ? `<div class="pl-phase-chips">${phaseChips}</div>` : ''}
      ${riskCount ? `<div class="pl-card-risk"><span class="cs-risk-badge">⚠ ${fmtNum(riskCount)} 项风险</span>${(s.risks || []).slice(0, 3).map(r => `<span class="pl-risk-item">${esc(r.name || r.id)}</span>`).join('')}</div>` : '<div class="pl-card-risk pl-card-risk-empty">风险 0 项</div>'}
      <div class="pl-card-foot">
        <span class="pl-card-owner">👤 ${esc(s.owner || '未指派')}</span>
        <span class="pl-card-link">查看详情 →</span>
      </div>
    </div>`;
  }

  function renderListView() {
    const stat = (summary && summary.agg) || {};
    const plans = (summary && summary.plans || []);
    const filtered = plans.filter(s => {
      if (!filterText) return true;
      const q = filterText.toLowerCase();
      return [s.name, s.id, s.owner, s.projectName].filter(Boolean).some(v => String(v).toLowerCase().includes(q));
    });
    return `
    <div class="cs-view-head">
      <div class="cs-view-head-left">
        <h3>项目计划</h3>
        <p class="pl-head-desc">任务 WBS · 里程碑 · 资源 · 甘特 · 高管视图，平铺完整展示</p>
      </div>
      <button class="btn primary" id="plNewPlan">＋ 新建计划</button>
    </div>
    ${renderMetricStrip()}
    <div class="pl-list-bar">
      <div class="pl-search">
        <span class="pl-search-ic">🔍</span>
        <input type="text" id="plFilter" class="pl-search-input" placeholder="按计划名 / 项目 / 负责人筛选" value="${esc(filterText)}">
      </div>
      <div class="pl-list-count">共 ${fmtNum(plans.length)} 个计划${filtered.length !== plans.length ? `，匹配 ${fmtNum(filtered.length)}` : ''}</div>
    </div>
    ${filtered.length === 0 ? `<div class="pl-empty"><div class="pl-empty-ic">🗓️</div><p>${plans.length === 0 ? '还没有计划，点击右上角「新建计划」开始' : '没有匹配的计划'}</p></div>`
      : `<div class="pl-card-grid">${filtered.map(s => renderPlanCard(s)).join('')}</div>`}
    ${plans.length === 0 ? `<div class="section-note">新建计划后，可在详情页维护 WBS 任务树、里程碑、资源负荷，并生成高管视图与 AI 规则建议。</div>` : ''}`;
  }

  /* ==========================================================
     计划详情 —— 顶部概览 + Tab 切换
     ========================================================== */
  function renderDetailMembers(plan) {
    const members = plan.members || [];
    if (!members.length) return '';
    const chips = members.map(m => `<span class="pl-member-chip"><b>${esc(m.name)}</b><i>${esc(MEMBER_ROLE_LABELS[m.role] || m.role || '')}</i>${m.duty ? `<span class="pl-member-duty">${esc(m.duty)}</span>` : ''}</span>`).join('');
    return `<div class="pl-detail-block"><span class="pl-block-label">🧑‍🤝‍🧑 团队成员</span><div class="pl-member-chips">${chips}</div></div>`;
  }
  function renderDetailReferences(plan) {
    const refs = plan.references || [];
    if (!refs.length) return '';
    const items = refs.map(r => {
      const label = `${REF_TYPE_LABELS[r.type] || r.type || ''}`;
      const link = r.link ? `<a class="pl-ref-link" href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : `<span>${esc(r.title)}</span>`;
      return `<span class="pl-ref-item"><span class="pl-chip">${esc(label)}</span>${link}${r.note ? `<i class="pl-ref-note">${esc(r.note)}</i>` : ''}</span>`;
    }).join('');
    return `<div class="pl-detail-block"><span class="pl-block-label">📎 参考文档</span><div class="pl-ref-list">${items}</div></div>`;
  }
  function renderDetailHeader(plan, ms) {
    const wbs = ms.wbs || {};
    const riskCount = (ms.risks || []).length;
    return `
    <div class="cs-close-bar pl-detail-head">
      <button class="back-btn" id="plBack">← 返回列表</button>
    </div>
    <div class="pl-detail-meta">
      <div class="pl-detail-title-row">
        <h2>${esc(plan.name)}</h2>
        <span class="badge ${PLAN_STATUS_CLASS[plan.status] || 'status-planned'}">${esc(PLAN_STATUS_LABELS[plan.status] || plan.status)}</span>
      </div>
      <div class="pl-detail-tags">
        <span class="pl-tag">📅 ${esc(fmtDate(plan.startDate))} — ${esc(fmtDate(plan.endDate))}</span>
        <span class="pl-tag">🏷️ ${esc(plan.year || '')} 年度</span>
        <span class="pl-tag">👤 ${esc(plan.owner || '未指派')}</span>
        ${plan.projectName ? `<span class="pl-tag">🏢 ${esc(plan.projectName)}</span>` : ''}
      </div>
      ${plan.description ? `<p class="pl-desc">${esc(plan.description)}</p>` : ''}
      ${renderDetailMembers(plan)}
      ${renderDetailReferences(plan)}
    </div>
    <div class="pl-detail-stats">
      <div class="pl-detail-stat"><span>任务</span><b>${fmtNum(wbs.total)}</b></div>
      <div class="pl-detail-stat"><span>已完成</span><b class="pl-ok">${fmtNum(wbs.completed)}</b></div>
      <div class="pl-detail-stat"><span>进行中</span><b class="pl-active">${fmtNum(wbs.inProgress)}</b></div>
      <div class="pl-detail-stat"><span>受阻</span><b class="${(wbs.blocked || 0) > 0 ? 'pl-danger' : ''}">${fmtNum(wbs.blocked)}</b></div>
      <div class="pl-detail-stat"><span>计划人天</span><b>${round1(wbs.sumHours)}</b></div>
      <div class="pl-detail-stat"><span>整体进度</span><b>${wbs.overallProgress || 0}%</b></div>
    </div>
    ${(riskCount) ? `<div class="pl-risk-banner">⚠ 该计划存在 <b>${fmtNum(riskCount)}</b> 项风险（逾期/受阻），建议在高管视图核查。</div>` : ''}`;
  }

  function buildTabs() {
    const tabs = [
      { key: 'wbs', label: 'WBS 任务', icon: '🌳' },
      { key: 'gantt', label: '甘特图', icon: '📊' },
      { key: 'milestone', label: '里程碑', icon: '🎯' },
      { key: 'resource', label: '资源负荷', icon: '👥' },
      { key: 'exec', label: '高管视图', icon: '📊' },
      { key: 'ai', label: 'AI 规则', icon: '🤖' }
    ];
    return `<div class="cs-topnav">${tabs.map(t => `<button class="cs-tab ${currentTab === t.key ? 'active' : ''}" data-tab="${t.key}"><span class="cs-tab-icon">${t.icon}</span>${t.label}</button>`).join('')}</div>`;
  }

  /* ---------- Tab 1：WBS 树表 ---------- */
  function renderWbsTab(plan) {
    const roots = buildWbsTree(plan.tasks);
    const total = (plan.tasks || []).length;
    if (total === 0) {
      return `<div class="pl-wrap"><div class="pl-empty"><div class="pl-empty-ic">🌳</div><p>暂无任务，点击「编辑计划」维护 WBS 任务分解</p></div></div>`;
    }
    const rows = [];
    const walk = (nodes, depth) => {
      nodes.forEach(node => {
        const isExpanded = expandedWbs.has(node.id);
        const hasChildren = node.children.length > 0;
        const pct = Number(node.progress || 0);
        rows.push(`
        <tr class="pl-wbs-row" data-node-id="${esc(node.id)}">
          <td class="pl-wbs-code">${esc(node.wbsCode || node.id)}</td>
          <td class="txt pl-wbs-name">
            <span class="pl-tree-toggle ${hasChildren ? '' : 'leaf'}" style="margin-left:${depth * 22}px" data-toggle-id="${esc(node.id)}">${hasChildren ? (isExpanded ? '▾' : '▸') : '·'}</span>
            ${esc(node.name)}
          </td>
          <td><span class="pl-chip">${esc(TASK_TYPE_LABELS[node.type] || node.type || '其他')}</span></td>
          <td><span class="badge ${pc(node.status)}">${esc(TASK_STATUS_LABELS[node.status] || node.status)}</span></td>
          <td><span class="${prClass(node.priority)}">${esc(PRIORITY_LABELS[node.priority] || node.priority || '中')}</span></td>
          <td class="txt">${esc(node.owner || '—')}</td>
          <td class="txt">${esc(node.dept || '—')}</td>
          <td><b>${round1(node.plannedHours)}</b></td>
          <td class="pl-progress-cell">${progressBadge(pct)}</td>
          <td class="txt">${esc(fmtDate(node.startDate))}</td>
          <td class="txt">${esc(fmtDate(node.endDate))}</td>
          <td class="txt pl-deps">${esc((node.dependencies || []).map(d => typeof d === 'object' ? (d.name || d.id) : d).join(', ') || '—')}</td>
        </tr>`);
        if (hasChildren && isExpanded) walk(node.children, depth + 1);
      });
    };
    walk(roots, 0);
    return `
    <div class="pl-wrap">
      <div class="pl-sect-head"><h4>WBS 任务分解 <span class="pl-count-pill">${fmtNum(total)} 项</span></h4><span class="pl-hint">点击 ▸ 展开/收起子任务</span></div>
      <div class="table-wrapper pl-table-wide">
        <table class="data-table pl-wbs-table">
          <thead>
            <tr>
              <th class="txt">WBS</th><th class="txt" style="min-width:230px">任务名称</th><th>类型</th><th>状态</th><th>优先级</th>
              <th class="txt">负责人</th><th class="txt">主责部门</th><th>人天</th><th style="min-width:110px">进度</th>
              <th class="txt">开始</th><th class="txt">结束</th><th class="txt" style="min-width:120px">依赖</th>
            </tr>
          </thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* ---------- Tab 2：甘特图 ---------- */
  function renderGanttTab(plan) {
    const tasks = (plan.tasks || []).filter(t => t.startDate && t.endDate).map(t => ({
      ...t, _start: dateStamp(t.startDate), _end: dateStamp(t.endDate)
    }));
    if (tasks.length === 0) {
      return `<div class="pl-wrap"><div class="pl-empty"><div class="pl-empty-ic">📊</div><p>暂无含起止日期的任务，无法绘制甘特图</p></div></div>`;
    }
    const spanStart = Math.min(...tasks.map(t => t._start));
    const spanEnd = Math.max(...tasks.map(t => t._end));
    const span = Math.max(spanEnd - spanStart, 1);
    // 月份刻度
    const monthMarkers = [];
    const startDate = new Date(spanStart);
    const endDate = new Date(spanEnd);
    const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    while (cursor.getTime() <= endDate.getTime()) {
      const left = (cursor.getTime() - spanStart) / span * 100;
      monthMarkers.push({ left, label: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}` });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    const leftOf = (stamp) => (stamp - spanStart) / span * 100;
    const widthOf = (t) => Math.max(2, Math.min(100, ((t._end - t._start) / span * 100 + 1)));
    const rows = tasks.map(t => {
      const left = leftOf(t._start), w = widthOf(t);
      const cls = t.status === 'completed' ? 'completed' : t.status === 'blocked' ? 'suspended' : t.status === 'in-progress' ? 'in-progress' : 'planned';
      const pct = Number(t.progress || 0);
      return `
      <div class="pl-gantt-row">
        <div class="pl-gantt-name" title="${esc(t.name)}">${esc(t.name)}</div>
        <div class="pl-gantt-track">
          <div class="pl-gantt-mark" style="left:0%"></div>
          <div class="pl-gantt-bar gantt-${cls}" style="left:${left}%;width:${w}%" title="${esc(t.name)} ${pct}%">
            <span class="pl-gantt-bar-fill" style="width:${pct}%"></span>
          </div>
        </div>
      </div>`;
    }).join('');
    return `
    <div class="pl-wrap">
      <div class="pl-sect-head"><h4>甘特图 <span class="pl-count-pill">${fmtNum(tasks.length)} 项</span></h4><span class="pl-hint">横向滚动查看时间轴</span></div>
      <div class="pl-gantt-scroll">
        <div class="pl-gantt">
          <div class="pl-gantt-header">
            <div class="pl-gantt-name pl-gantt-name-head">任务</div>
            <div class="pl-gantt-track">
              ${monthMarkers.map(m => `<span class="pl-gantt-month" style="left:${m.left}%">${m.label}</span>`).join('')}
            </div>
          </div>
          ${rows}
        </div>
      </div>
      <div class="pl-gantt-legend">
        <span><i class="gantt-planned"></i>未开始</span>
        <span><i class="gantt-in-progress"></i>进行中</span>
        <span><i class="gantt-completed"></i>已完成</span>
        <span><i class="gantt-suspended"></i>受阻</span>
      </div>
    </div>`;
  }

  /* ---------- Tab 3：里程碑 ---------- */
  function renderMilestoneTab(plan) {
    const mss = (plan.milestones || []).slice().sort((a, b) => (dateStamp(a.date) || 0) - (dateStamp(b.date) || 0));
    if (mss.length === 0) {
      return `<div class="pl-wrap"><div class="pl-empty"><div class="pl-empty-ic">🎯</div><p>暂无里程碑</p></div></div>`;
    }
    const today = todayStamp();
    const items = mss.map(ms => {
      const isDone = ms.status === 'done';
      const isToday = dateStamp(ms.date) === today;
      const overdue = !isDone && dateStamp(ms.date) < today;
      return `
      <div class="pl-ms-item">
        <div class="pl-ms-dot ${isDone ? 'done' : overdue ? 'overdue' : 'pending'}"></div>
        <div class="pl-ms-body">
          <div class="pl-ms-head">
            <span class="badge ${MILESTONE_STATUS_CLASS[ms.status] || 'status-planned'}">${esc(MILESTONE_STATUS_LABELS[ms.status] || ms.status)}</span>
            <span class="pl-ms-name">${esc(ms.name)}</span>
            ${overdue ? '<span class="pl-overdue">已逾期</span>' : ''}${isToday ? '<span class="pl-today">今日</span>' : ''}
          </div>
          <div class="pl-ms-meta">📅 ${esc(fmtDate(ms.date))}${ms.owner ? ` · 👤 ${esc(ms.owner)}` : ''}${ms.desc ? ` · ${esc(ms.desc)}` : ''}</div>
        </div>
      </div>`;
    }).join('');
    return `
    <div class="pl-wrap">
      <div class="pl-sect-head"><h4>里程碑 <span class="pl-count-pill">${fmtNum(mss.length)} 项</span></h4></div>
      <div class="pl-ms-timeline">${items}</div>
    </div>`;
  }

  /* ---------- Tab 4：资源负荷 ---------- */
  function renderResourceTab(plan) {
    const res = (plan.resources || []);
    const tasks = (plan.tasks || []);
    if (res.length === 0 && tasks.length === 0) {
      return `<div class="pl-wrap"><div class="pl-empty"><div class="pl-empty-ic">👥</div><p>暂无资源与任务</p></div></div>`;
    }
    // 汇总每个资源的计划负荷
    const loadMap = {};
    tasks.forEach(t => {
      const name = t.owner;
      if (!name) return;
      loadMap[name] = (loadMap[name] || 0) + (Number(t.plannedHours) || 0);
    });
    const rows = res.map(r => {
      const load = loadMap[r.name] || 0;
      const pct = r.total > 0 ? Math.round(load / r.total * 100) : (load > 0 ? 100 : 0);
      const over = pct > 100;
      const barCls = over ? 'fill-over' : pct >= 80 ? 'fill-warn' : '';
      return `
      <tr>
        <td class="txt"><b>${esc(r.name)}</b></td>
        <td><span class="pl-chip">${esc(RES_KIND_LABELS[r.kind] || r.kind || '团队')}</span></td>
        <td class="txt">${esc(r.dept || '—')}</td>
        <td><span class="pl-ceil">${fmtNum(r.total)} 人天</span></td>
        <td><span class="pl-used">${round1(load)} 人天</span></td>
        <td><div class="pl-load-bar"><div class="pl-load-fill ${barCls}" style="width:${Math.min(100, pct)}%"></div></div></td>
        <td><span class="${over ? 'cs-risk-badge' : 'pl-ok-badge'}">${over ? '⚠ 超载 ' : ''}${pct}%</span></td>
      </tr>`;
    }).join('');
    // 未被资源表登记但出现在任务的负责人
    const registered = new Set(res.map(r => r.name));
    const unregistered = tasks.filter(t => t.owner && !registered.has(t.owner));
    const unregRows = unregistered.map(t => {
      const load = loadMap[t.owner] || 0;
      return `<tr><td class="txt"><b>${esc(t.owner)}</b></td><td><span class="pl-chip">未登记</span></td><td class="txt">${esc(t.dept || '—')}</td><td><span class="pl-ceil">—</span></td><td><span class="pl-used">${round1(load)} 人天</span></td><td><div class="pl-load-bar"><div class="pl-load-fill fill-warn" style="width:100%"></div></div></td><td><span class="pl-warn-badge">待登记容量</span></td></tr>`;
    }).join('');
    return `
    <div class="pl-wrap">
      <div class="pl-sect-head"><h4>资源负荷 <span class="pl-count-pill">${fmtNum(res.length)} 个资源</span></h4><span class="pl-hint">负荷 = 任务计划工时 / 资源总容量，>100% 即超载</span></div>
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr><th class="txt">资源</th><th>类型</th><th class="txt">部门</th><th>总容量</th><th>计划负荷</th><th style="min-width:160px">负荷率</th><th>状态</th></tr></thead>
          <tbody>${rows}${unregRows}</tbody>
        </table>
      </div>
      <div class="section-note">建议：超载资源拆分任务或外派；未登记容量的负责人请在「编辑计划 → 资源」中登记总容量，才能自动判定是否超载。</div>
    </div>`;
  }

  /* ---------- Tab 5：高管视图（本地规则计算） ---------- */
  function renderExecView(plan, msum) {
    const wbs = msum.wbs || {};
    const rootSummary = wbs.topLevel || [];
    const phases = wbs.phases || [];
    const msObjects = (plan.milestones || []).slice().sort((a, b) => (dateStamp(a.date) || 0) - (dateStamp(b.date) || 0));
    const today = todayStamp();
    const upcoming = (msum.upcomingMilestones || []).slice(0, 5);
    const risks = msum.risks || [];
    const resStat = msum.resource || {};
    // 阶段进度卡
    const phaseCards = phases.map(ph => {
      const pct = ph.total ? Math.round((ph.completed || 0) / ph.total * 100) : 0;
      return `<div class="pl-phase-card">
        <div class="pl-phase-card-head"><span>${esc(ph.name)}</span><b>${pct}%</b></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="pl-phase-card-sub">${fmtNum(ph.completed)}/${fmtNum(ph.total)} 任务 · ${round1(ph.sumHours)} 人天</div>
      </div>`;
    }).join('');
    // 里程碑状态条
    const msSeg = (msum.milestone || {});
    const msTotal = msSeg.total || 0;
    const seg = (v) => msTotal ? Math.round((v || 0) / msTotal * 100) : 0;
    const riskList = risks.length ? risks.map(r => `
      <div class="pl-risk-row">
        <span class="cs-risk-badge ${r.type === 'overdue' ? 'high' : 'medium'}">${r.type === 'overdue' ? '逾期' : '受阻'}</span>
        <span class="pl-risk-name">${esc(r.name)}</span>
        <span class="pl-risk-meta">${esc(r.owner || '')} · ${esc(fmtDate(r.endDate))}</span>
        <span class="pl-risk-pct">${r.progress || 0}%</span>
      </div>`).join('') : '<div class="pl-none-risks">✓ 无逾期/受阻风险</div>';
    return `
    <div class="pl-wrap pl-exec">
      <div class="pl-sect-head"><h4>高管视图 · ${esc(plan.name)}</h4><span class="pl-hint">由本地规则即时计算，无外部调用</span></div>
      <div class="pl-exec-kpis">
        <div class="pl-exec-kpi"><span>整体完成率</span><b>${wbs.overallProgress || 0}%</b></div>
        <div class="pl-exec-kpi"><span>任务完成率</span><b>${wbs.taskDoneRate || 0}%</b></div>
        <div class="pl-exec-kpi"><span>里程碑完成</span><b>${fmtNum(msSeg.done)}/${fmtNum(msTotal)}</b></div>
        <div class="pl-exec-kpi"><span>资源超载</span><b class="${resStat.overloaded ? 'pl-danger' : 'pl-ok'}">${fmtNum(resStat.overloaded)}</b></div>
        <div class="pl-exec-kpi"><span>风险项</span><b class="${risks.length ? 'pl-danger' : 'pl-ok'}">${fmtNum(risks.length)}</b></div>
      </div>
      <div class="pl-exec-grid">
        <div class="cs-panel">
          <h4>阶段推进 <small>按阶段汇总任务</small></h4>
          ${phaseCards || '<div class="pl-none">暂未划分阶段</div>'}
        </div>
        <div class="cs-panel">
          <h4>里程碑完成度</h4>
          <div class="pl-ms-statusbar">
            <div class="pl-ms-seg"><div class="pl-ms-fill" style="width:${seg(msSeg.done)}%"></div></div>
            <div class="pl-ms-legend">
              <span><i class="dot-done"></i>已完成 ${fmtNum(msSeg.done)}</span>
              <span><i class="dot-inprog"></i>进行中 ${fmtNum(msSeg.inProgress)}</span>
              <span><i class="dot-pending"></i>待完成 ${fmtNum(msSeg.pending)}</span>
            </div>
          </div>
          <h4 class="pl-upcoming-title">近期里程碑</h4>
          ${upcoming.length ? upcoming.map(u => `<div class="pl-upcoming-row"><span class="pl-upcoming-date">${esc(fmtDate(u.date))}</span><span>${esc(u.name)}</span><span class="pl-upcoming-owner">${esc(u.owner || '')}</span></div>`).join('') : '<div class="pl-none">暂无近期里程碑</div>'}
        </div>
      </div>
      <div class="cs-panel pl-exec-risk"><h4>风险清单 <small>逾期 / 受阻任务</small></h4>${riskList}</div>
      <div class="pl-exec-footnote">数据来源：计划状态文件（/api/plan），本地规则计算，不依赖外部 AI 服务。</div>
    </div>`;
  }

  /* ---------- Tab 6：AI 规则（本地规则生成，预留 AI 入口） ---------- */
  function renderAiTab(plan) {
    const rules = generateRules(plan);
    return `
    <div class="pl-wrap">
      <div class="pl-sect-head"><h4>AI 智能规则 <span class="pl-count-pill">本地规则</span></h4>
        <span class="pl-hint">当前为本地规则引擎生成，预留 AI 接入位</span></div>
      <div class="pl-ai-cards">
        <div class="cs-panel pl-ai-card">
          <div class="pl-ai-card-head"><span class="pl-ai-icon">🧩</span><h4>WBS 任务模板</h4><span class="badge status-active">规则</span></div>
          <div class="pl-ai-body">${rules.wbs}</div>
        </div>
        <div class="cs-panel pl-ai-card">
          <div class="pl-ai-card-head"><span class="pl-ai-icon">📉</span><h4>资源缺口分析</h4><span class="badge status-active">规则</span></div>
          <div class="pl-ai-body">${rules.resource}</div>
        </div>
        <div class="cs-panel pl-ai-card">
          <div class="pl-ai-card-head"><span class="pl-ai-icon">📝</span><h4>周报模板</h4><span class="badge status-active">规则</span></div>
          <div class="pl-ai-body">${rules.report}</div>
        </div>
      </div>
      <div class="pl-ai-reserved">
        <div class="pl-ai-reserved-icon">🤖</div>
        <div class="pl-ai-reserved-body">
          <h4>AI 智能助手（预留）</h4>
          <p>此入口预留给 AI 生成 / 优化计划：自动生成 WBS 分解、识别资源瓶颈、生成周报摘要。当前为本地规则计算结果，接入 AI 后可切换为模型生成。</p>
          <div class="pl-ai-reserved-tags"><span class="pl-chip">即将上线</span><span class="pl-chip">预留接口</span></div>
        </div>
      </div>
    </div>`;
  }

  /* ---------- 本地规则生成 ---------- */
  function generateRules(plan) {
    const tasks = plan.tasks || [];
    const res = plan.resources || [];
    // WBS 模板：按类型分组
    const byType = {};
    tasks.forEach(t => {
      const ty = t.type || 'other';
      (byType[ty] = byType[ty] || []).push(t);
    });
    const typeOrder = ['dev', 'test', 'design', 'doc', 'ops', 'other'];
    const totalH = tasks.reduce((s, t) => s + (Number(t.plannedHours) || 0), 0);
    const wbsHtml = Object.keys(byType).sort((a, b) => {
      const ia = typeOrder.indexOf(a), ib = typeOrder.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    }).map(ty => {
      const arr = byType[ty];
      const h = arr.reduce((s, t) => s + (Number(t.plannedHours) || 0), 0);
      const pct = totalH ? Math.round(h / totalH * 100) : 0;
      return `<div class="pl-rule-row"><span class="pl-rule-type">${esc(TASK_TYPE_LABELS[ty] || ty)}</span><span class="pl-rule-name">${fmtNum(arr.length)} 项</span><span class="pl-rule-val">${round1(h)} 人天 · ${pct}%</span></div>`;
    }).join('') || '<div class="pl-none">暂无任务</div>';

    // 资源缺口：任务负荷 vs 资源容量
    const loadMap = {};
    tasks.forEach(t => { if (t.owner) loadMap[t.owner] = (loadMap[t.owner] || 0) + (Number(t.plannedHours) || 0); });
    const resHtml = res.length ? res.map(r => {
      const load = loadMap[r.name] || 0;
      const pct = r.total > 0 ? Math.round(load / r.total * 100) : (load > 0 ? 100 : 0);
      const over = pct > 100;
      const gap = pct > 100 ? (load - r.total) : 0;
      return `<div class="pl-rule-row ${over ? 'pl-rule-over' : ''}">
        <span class="pl-rule-type">${esc(r.name)}</span>
        <span class="pl-rule-name">${esc(RES_KIND_LABELS[r.kind] || '')}</span>
        <span class="pl-rule-val">${round1(load)}/${round1(r.total)} 人天${over ? ` · 缺口 ${round1(gap)}` : ''}</span>
      </div>`;
    }).join('') : '<div class="pl-none">未登记资源容量，请到「编辑计划 → 资源」完善</div>';

    // 周报模板：本周新增/完成/进行中/风险
    const completed = tasks.filter(t => t.status === 'completed').length;
    const inProg = tasks.filter(t => t.status === 'in-progress').length;
    const blocked = tasks.filter(t => t.status === 'blocked').length;
    const notStarted = tasks.filter(t => t.status === 'not-started').length;
    const risks = tasks.filter(t => t.status === 'blocked' || (t.status !== 'completed' && t.endDate && dateStamp(t.endDate) < todayStamp()));
    const report = `
      <div class="pl-report">
        <p><b>一、本周目标回顾</b></p>
        <p>整体进度 ${Math.round(tasks.length ? tasks.reduce((s, t) => s + (Number(t.progress) || 0), 0) / tasks.length : 0)}%，共 ${fmtNum(tasks.length)} 项任务。</p>
        <p><b>二、本周完成</b>：${fmtNum(completed)} 项</p>
        <p><b>三、进行中</b>：${fmtNum(inProg)} 项</p>
        <p><b>四、风险与阻塞</b>：${fmtNum(blocked + risks.filter(t => t.status !== 'blocked').length)} 项${risks.length ? `，重点：${risks.slice(0, 3).map(t => esc(t.name)).join('、')}` : ''}</p>
        <p><b>五、下周计划</b>：优先推进 ${fmtNum(notStarted)} 项未开始任务。</p>
      </div>`;
    return { wbs: wbsHtml, resource: resHtml, report };
  }

  /* ---------- 详情页渲染 ---------- */
  function renderDetailView() {
    const plan = getPlan(currentPlanId);
    if (!plan) {
      currentView = 'list';
      return renderListView();
    }
    const msum = findSummary(currentPlanId) || {};
    let tabHtml = '';
    switch (currentTab) {
      case 'wbs': tabHtml = renderWbsTab(plan); break;
      case 'gantt': tabHtml = renderGanttTab(plan); break;
      case 'milestone': tabHtml = renderMilestoneTab(plan); break;
      case 'resource': tabHtml = renderResourceTab(plan); break;
      case 'exec': tabHtml = renderExecView(plan, msum); break;
      case 'ai': tabHtml = renderAiTab(plan); break;
      default: tabHtml = renderWbsTab(plan);
    }
    return `
      <div class="pl-detail">
        ${renderDetailHeader(plan, msum || {})}
        ${buildTabs()}
        <div class="pl-tab-body">${tabHtml}</div>
        <div class="pl-detail-actions">
          <button class="btn" id="plDeletePlan">🗑 删除计划</button>
          <button class="btn primary" id="plEditPlan">✏️ 编辑计划</button>
        </div>
      </div>`;
  }

  /* ==========================================================
     新建 / 编辑 —— 第二页表单
     ========================================================== */
  function blankTask() {
    return { id: 't-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), parentId: '', wbsCode: '', name: '', type: 'dev', status: 'not-started', priority: 'medium', progress: 0, plannedHours: '', owner: '', dept: '', startDate: '', endDate: '', dependencies: [], note: '' };
  }
  function blankMilestone() {
    return { id: 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: '', date: '', status: 'pending', owner: '', desc: '' };
  }
  function blankResource() {
    return { id: 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: '', kind: 'team', dept: '', total: '', used: null, note: '' };
  }
  function blankMember() {
    return { id: 'mb-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: '', role: 'dev', dept: '', duty: '', contact: '' };
  }
  function blankReference() {
    return { id: 'rf-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: '', type: 'requirement', link: '', note: '' };
  }

  /* ==========================================================
     需求清单 → 项目总览 WBS 拆解（本地规则，零依赖 / 离线）
     ------------------------------------------------------------
     标准 8 阶段：需求传递 / 环境准备 / 方案设计 / 技术详设设计 /
                 研发计划(按需求逐条展开) / 测试计划(固定6条子流程) /
                 实证 / 上市交付
     ========================================================== */
  const OVERVIEW_STAGES = [
    { name: '需求传递', type: 'doc', deliverable: '需求评审纪要', mode: 'placeholder' },
    { name: '环境准备', type: 'ops', deliverable: '开发/测试环境就绪', mode: 'placeholder' },
    { name: '方案设计', type: 'design', deliverable: '总体方案文档', mode: 'placeholder' },
    { name: '技术详设设计', type: 'design', deliverable: '详细设计文档', mode: 'placeholder' },
    { name: '研发计划', type: 'dev', deliverable: '功能实现', mode: 'perRequirement' },
    { name: '测试计划', type: 'test', deliverable: '测试报告', mode: 'fixedChildren',
      children: ['测试方案设计', '测试用例编写', '敏捷测试', '系统测试一轮', '系统测试二轮', '可用性测试(实证测试)'] },
    { name: '实证', type: 'ops', deliverable: '现场实证报告', mode: 'placeholder' },
    { name: '上市交付', type: 'other', deliverable: '交付/上市材料', mode: 'placeholder' }
  ];

  // 解析需求清单文本：一行一条，去空行，去行首编号/项目符号前缀
  function parseRequirementLines(text) {
    if (!text) return [];
    return String(text)
      .split(/\r?\n/)
      .map(s => s.replace(/^\s*(\d+(\.\d+)*\s*[.、)．]\s*|[-*·•]\s*)/, '').trim())
      .filter(Boolean);
  }

  // 依据 8 阶段 + 需求列表构建任务树（parentId 建好；wbsCode 留空，保存时 buildWbsCodes 自动编号）
  function decomposeOverview(reqs) {
    const tasks = [];
    const mk = (name, type, parentId, deliverable) => {
      const t = blankTask();
      t.name = name; t.type = type || 'other'; t.parentId = parentId || '';
      t.phase = name && !parentId ? name : undefined;
      if (deliverable) t.deliverable = deliverable;
      return t;
    };
    OVERVIEW_STAGES.forEach(stage => {
      const parent = mk(stage.name, stage.type, '', stage.deliverable);
      parent.phase = stage.name;
      tasks.push(parent);
      if (stage.mode === 'perRequirement') {
        if (reqs.length) {
          reqs.forEach(r => { const c = mk(r, stage.type, parent.id); c.phase = stage.name; tasks.push(c); });
        } else {
          const c = mk('（待补充需求）', stage.type, parent.id); c.phase = stage.name; tasks.push(c);
        }
      } else if (stage.mode === 'fixedChildren') {
        stage.children.forEach(cn => { const c = mk(cn, stage.type, parent.id); c.phase = stage.name; tasks.push(c); });
      }
      // placeholder 模式：只保留一级阶段任务，不建子任务
    });
    return tasks;
  }

  // 解析上传文件为需求文本（.txt/.csv 走文本；.xlsx 走内置 SheetJS，取首个非空列）
  function parseRequirementFile(file, onDone, onError) {
    const name = (file.name || '').toLowerCase();
    if (/\.(txt|csv)$/.test(name)) {
      const reader = new FileReader();
      reader.onerror = () => onError(new Error('文件读取失败'));
      reader.onload = e => {
        let text = String(e.target.result || '');
        if (/\.csv$/.test(name)) {
          // CSV：取每行第一个字段（简单按逗号切，够用；复杂 CSV 用户可粘贴文本）
          text = text.split(/\r?\n/).map(line => (line.split(',')[0] || '').replace(/^"|"$/g, '').trim()).join('\n');
        }
        onDone(text);
      };
      reader.readAsText(file, 'UTF-8');
    } else if (/\.(xlsx|xls)$/.test(name)) {
      if (typeof XLSX === 'undefined') { onError(new Error('Excel 解析库未加载，请改用粘贴文本')); return; }
      const reader = new FileReader();
      reader.onerror = () => onError(new Error('文件读取失败'));
      reader.onload = e => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
          // 找出"需求/功能/标题/任务"列，找不到则用第一列；跳过疑似表头行
          let col = 0;
          const header = (aoa[0] || []).map(c => String(c == null ? '' : c));
          const hit = header.findIndex(h => /需求|功能|标题|任务|条目|清单/.test(h));
          let startRow = 0;
          if (hit >= 0) { col = hit; startRow = 1; }
          const lines = [];
          for (let i = startRow; i < aoa.length; i++) {
            const v = (aoa[i] || [])[col];
            const s = String(v == null ? '' : v).trim();
            if (s) lines.push(s);
          }
          onDone(lines.join('\n'));
        } catch (err) { onError(new Error('Excel 解析失败：' + err.message)); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      onError(new Error('暂支持 .txt / .csv / .xlsx，其他格式请粘贴文本'));
    }
  }

  // 拆解面板（弹窗）：粘贴需求 / 上传文件 / 生成预览 / 采用
  function openDecomposePanel() {
    const existingCount = (dirtyForm.tasks || []).length;
    const body = `
      <div class="pl-decompose">
        <p class="pl-dec-desc">粘贴产品需求清单（一行一条），或上传 .txt / .csv / .xlsx 文件。系统将按标准 <b>8 阶段</b> 生成一版「项目总览」计划，其中「研发计划」按需求逐条展开、「测试计划」内置 6 条固定子流程。</p>
        <div class="pl-dec-toolbar">
          <label class="pl-dec-upload btn">📎 上传文件<input type="file" id="plDecFile" accept=".txt,.csv,.xlsx,.xls" hidden></label>
          <span class="pl-dec-filehint" id="plDecFileHint"></span>
        </div>
        <textarea id="plDecInput" class="pl-dec-input" rows="9" placeholder="示例：&#10;1. 支持多语言切换&#10;2. 新增设备离线告警推送&#10;3. 报表导出 PDF"></textarea>
        ${existingCount ? `<label class="pl-dec-replace"><input type="checkbox" id="plDecReplace" checked> 替换当前已有的 ${existingCount} 个任务（取消勾选则追加）</label>` : ''}
        <div class="pl-dec-preview" id="plDecPreview"></div>
      </div>`;
    SharedUI.confirm('需求清单拆解 → 项目总览', body, () => {
      // "生成/采用"按钮回调：读输入 → 生成 → 写入 dirtyForm
      const input = document.getElementById('plDecInput');
      const reqs = parseRequirementLines(input ? input.value : '');
      const generated = decomposeOverview(reqs);
      const replaceEl = document.getElementById('plDecReplace');
      const doReplace = !existingCount || (replaceEl && replaceEl.checked);
      syncFormFromDom();
      dirtyForm.tasks = doReplace ? generated : (dirtyForm.tasks || []).concat(generated);
      renderFormBody();
      SharedUI.toast(`已生成项目总览：${generated.length} 个任务（研发 ${reqs.length} 条需求）`, 'success');
    }, { confirmText: '生成并填入', cancelText: '取消' });

    // 绑定文件上传（在弹窗渲染后）
    setTimeout(() => {
      const fileEl = document.getElementById('plDecFile');
      const hint = document.getElementById('plDecFileHint');
      const input = document.getElementById('plDecInput');
      const preview = document.getElementById('plDecPreview');
      const refreshPreview = () => {
        if (!preview) return;
        const reqs = parseRequirementLines(input ? input.value : '');
        preview.innerHTML = `<div class="pl-dec-preview-head">预览：将生成 <b>8</b> 个阶段，研发计划展开 <b>${reqs.length}</b> 条需求，测试计划 6 条子流程</div>`;
      };
      if (input) input.addEventListener('input', refreshPreview);
      if (fileEl) fileEl.addEventListener('change', () => {
        const f = fileEl.files && fileEl.files[0];
        if (!f) return;
        if (hint) hint.textContent = '解析中…';
        parseRequirementFile(f, (text) => {
          if (input) { input.value = text; refreshPreview(); }
          if (hint) hint.textContent = `✓ 已解析 ${f.name}，请核对下方内容后生成`;
        }, (err) => { if (hint) hint.textContent = '✗ ' + err.message; });
      });
      refreshPreview();
    }, 0);
  }
  function initFormDraft(plan) {
    const p = plan || null;
    return {
      id: p ? p.id : ('plan-' + Date.now().toString(36)),
      name: p ? p.name : '', year: p ? p.year : new Date().getFullYear(),
      status: p ? p.status : 'draft', owner: p ? p.owner : '',
      projectId: p ? p.projectId : '', projectName: p ? p.projectName : '',
      startDate: p ? p.startDate : '', endDate: p ? p.endDate : '',
      description: p ? p.description : '', goals: p ? p.goals : '',
      tasks: (p && p.tasks ? p.tasks : []).map(t => ({ ...t })),
      milestones: (p && p.milestones ? p.milestones : []).map(m => ({ ...m })),
      resources: (p && p.resources ? p.resources : []).map(r => ({ ...r })),
      members: (p && p.members ? p.members : []).map(m => ({ ...m })),
      references: (p && p.references ? p.references : []).map(r => ({ ...r })),
      aiConfig: (p && p.aiConfig) || {}
    };
  }

  function taskOptions(draft, selectedId, selfId) {
    // 供选择父任务；排除自身，避免自引用
    return draft.tasks.filter(t => t.id !== selfId).map(t => {
      const label = (t.wbsCode ? t.wbsCode + ' ' : '') + (t.name || '(未命名任务)');
      return `<option value="${esc(t.id)}" ${t.id === selectedId ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
  }
  function taskNameOf(draft, id) { const t = draft.tasks.find(x => x.id === id); return t ? t.name : ''; }

  function renderFormTasks(draft) {
    if (!draft.tasks.length) {
      return `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">🌳</div><p>暂无任务，点击「添加任务」</p></div>`;
    }
    // WBS 编码在保存时由 buildWbsCodes 依据「父任务」层级自动生成，无需手填，故不展示 WBS 列
    const rows = draft.tasks.map((t, i) => `
      <tr data-task-idx="${i}">
        <td><input class="pl-f-name" data-f="name" value="${esc(t.name)}" placeholder="任务名称"></td>
        <td><select data-f="type">${Object.keys(TASK_TYPE_LABELS).map(k => `<option value="${k}" ${t.type === k ? 'selected' : ''}>${TASK_TYPE_LABELS[k]}</option>`).join('')}</select></td>
        <td><select data-f="status">${Object.keys(TASK_STATUS_LABELS).map(k => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${TASK_STATUS_LABELS[k]}</option>`).join('')}</select></td>
        <td><select data-f="priority">${Object.keys(PRIORITY_LABELS).map(k => `<option value="${k}" ${t.priority === k ? 'selected' : ''}>${PRIORITY_LABELS[k]}</option>`).join('')}</select></td>
        <td><input data-f="owner" value="${esc(t.owner)}" placeholder="负责人"></td>
        <td><input data-f="dept" value="${esc(t.dept)}" placeholder="主责部门"></td>
        <td><input type="number" data-f="plannedHours" value="${esc(t.plannedHours)}" placeholder="人天" min="0" step="0.1"></td>
        <td><input type="number" data-f="progress" value="${esc(t.progress)}" placeholder="0-100" min="0" max="100"></td>
        <td><input type="date" data-f="startDate" value="${esc(t.startDate)}"></td>
        <td><input type="date" data-f="endDate" value="${esc(t.endDate)}"></td>
        <td><select data-f="parentId" class="pl-f-parent"><option value="">— 顶层 —</option>${taskOptions(draft, t.parentId, t.id)}</select></td>
        <td><input data-f="deps" value="${esc((t.dependencies || []).join(', '))}" placeholder="依赖任务WBS"></td>
        <td><button type="button" class="cs-del-btn pl-del-task" data-del-task="${i}" title="删除">✕</button></td>
      </tr>`);
    return `<div class="table-wrapper pl-form-table-wrap"><table class="data-table pl-form-table"><thead><tr>
        <th class="txt" style="min-width:200px">任务名称</th><th>类型</th><th>状态</th><th>优先级</th>
        <th class="txt">负责人</th><th class="txt">主责部门</th><th style="min-width:70px">人天</th><th style="min-width:60px">进度%</th>
        <th class="txt">开始</th><th class="txt">结束</th><th class="txt">父任务</th><th class="txt">依赖</th><th></th>
      </tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function renderFormResources(draft) {
    if (!draft.resources.length) {
      return `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">👥</div><p>暂无资源，点击「添加资源」</p></div>`;
    }
    const rows = draft.resources.map((r, i) => `
      <tr data-res-idx="${i}">
        <td><input data-f="name" value="${esc(r.name)}" placeholder="资源名"></td>
        <td><select data-f="kind">${Object.keys(RES_KIND_LABELS).map(k => `<option value="${k}" ${r.kind === k ? 'selected' : ''}>${RES_KIND_LABELS[k]}</option>`).join('')}</select></td>
        <td><input data-f="dept" value="${esc(r.dept)}" placeholder="部门"></td>
        <td><input type="number" data-f="total" value="${esc(r.total)}" placeholder="总容量(人天)" min="0" step="0.1"></td>
        <td><button type="button" class="cs-del-btn pl-del-res" data-del-res="${i}" title="删除">✕</button></td>
      </tr>`);
    return `<div class="table-wrapper"><table class="data-table"><thead><tr><th class="txt">资源</th><th>类型</th><th class="txt">部门</th><th style="min-width:120px">总容量(人天)</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function renderFormMilestones(draft) {
    if (!draft.milestones.length) {
      return `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">🎯</div><p>暂无里程碑，点击「添加里程碑」</p></div>`;
    }
    const rows = draft.milestones.map((m, i) => `
      <tr data-ms-idx="${i}">
        <td><input data-f="name" value="${esc(m.name)}" placeholder="里程碑名称"></td>
        <td><input type="date" data-f="date" value="${esc(m.date)}"></td>
        <td><select data-f="status">${Object.keys(MILESTONE_STATUS_LABELS).map(k => `<option value="${k}" ${m.status === k ? 'selected' : ''}>${MILESTONE_STATUS_LABELS[k]}</option>`).join('')}</select></td>
        <td><input data-f="owner" value="${esc(m.owner)}" placeholder="负责人"></td>
        <td><input data-f="desc" value="${esc(m.desc)}" placeholder="说明"></td>
        <td><button type="button" class="cs-del-btn pl-del-ms" data-del-ms="${i}" title="删除">✕</button></td>
      </tr>`);
    return `<div class="table-wrapper"><table class="data-table"><thead><tr><th class="txt" style="min-width:190px">里程碑</th><th class="txt">日期</th><th>状态</th><th class="txt">负责人</th><th class="txt">说明</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function renderFormMembers(draft) {
    if (!draft.members.length) {
      return `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">🧑‍🤝‍🧑</div><p>暂无团队成员，点击「添加成员」</p></div>`;
    }
    const rows = draft.members.map((m, i) => `
      <tr data-member-idx="${i}">
        <td><input data-f="name" value="${esc(m.name)}" placeholder="姓名"></td>
        <td><select data-f="role">${Object.keys(MEMBER_ROLE_LABELS).map(k => `<option value="${k}" ${m.role === k ? 'selected' : ''}>${MEMBER_ROLE_LABELS[k]}</option>`).join('')}</select></td>
        <td><input data-f="dept" value="${esc(m.dept)}" placeholder="部门/团队"></td>
        <td><input data-f="duty" value="${esc(m.duty)}" placeholder="职责分工"></td>
        <td><input data-f="contact" value="${esc(m.contact)}" placeholder="联系方式(可选)"></td>
        <td><button type="button" class="cs-del-btn pl-del-member" data-del-member="${i}" title="删除">✕</button></td>
      </tr>`);
    return `<div class="table-wrapper"><table class="data-table"><thead><tr><th class="txt">姓名</th><th>角色</th><th class="txt">部门/团队</th><th class="txt" style="min-width:180px">职责分工</th><th class="txt" style="min-width:150px">联系方式</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function renderFormReferences(draft) {
    if (!draft.references.length) {
      return `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">📎</div><p>暂无参考文档，点击「添加文档」</p></div>`;
    }
    const rows = draft.references.map((r, i) => `
      <tr data-ref-idx="${i}">
        <td><input data-f="title" value="${esc(r.title)}" placeholder="文档名称"></td>
        <td><select data-f="type">${Object.keys(REF_TYPE_LABELS).map(k => `<option value="${k}" ${r.type === k ? 'selected' : ''}>${REF_TYPE_LABELS[k]}</option>`).join('')}</select></td>
        <td><input data-f="link" value="${esc(r.link)}" placeholder="链接 / 路径"></td>
        <td><input data-f="note" value="${esc(r.note)}" placeholder="说明"></td>
        <td><button type="button" class="cs-del-btn pl-del-ref" data-del-ref="${i}" title="删除">✕</button></td>
      </tr>`);
    return `<div class="table-wrapper"><table class="data-table"><thead><tr><th class="txt" style="min-width:190px">文档名称</th><th>类型</th><th class="txt" style="min-width:220px">链接/路径</th><th class="txt">说明</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function renderFormView() {
    const draft = dirtyForm;
    const isEdit = currentView === 'edit';
    return `
    <div class="cs-form-page pl-form-page">
      <div class="cs-form-topbar">
        <div class="cs-form-topbar-left">
          <button class="back-btn" id="plFormCancel">← 返回</button>
          <span class="cs-form-title">${isEdit ? '编辑计划' : '新建计划'}</span>
        </div>
        <div class="cs-form-topbar-right">
          <button class="btn" id="plFormCancel2">取消</button>
          <button class="btn primary" id="plFormSave">💾 保存计划</button>
        </div>
      </div>
      <div class="cs-form-body">
        <div class="cs-form">
          <div class="cs-form-section">
            <div class="cs-form-section-title">基本信息</div>
            <div class="cs-form-grid">
              <div class="cs-field"><label>计划名称 <span class="req">*</span></label><input type="text" data-f="name" value="${esc(draft.name)}" placeholder="如：2026 阳光云平台迭代计划"></div>
              <div class="cs-field"><label>年度</label><input type="number" data-f="year" value="${esc(draft.year)}" min="2020" max="2100"></div>
              <div class="cs-field"><label>状态</label><select data-f="status">${Object.keys(PLAN_STATUS_LABELS).map(k => `<option value="${k}" ${draft.status === k ? 'selected' : ''}>${PLAN_STATUS_LABELS[k]}</option>`).join('')}</select></div>
              <div class="cs-field"><label>负责人</label><input type="text" data-f="owner" value="${esc(draft.owner)}" placeholder="计划负责人"></div>
              <div class="cs-field"><label>项目 ID</label><input type="text" data-f="projectId" value="${esc(draft.projectId)}" placeholder="关联项目ID（可选）"></div>
              <div class="cs-field"><label>项目名称</label><input type="text" data-f="projectName" value="${esc(draft.projectName)}" placeholder="关联项目名称（可选）"></div>
              <div class="cs-field"><label>计划开始</label><input type="date" data-f="startDate" value="${esc(draft.startDate)}"></div>
              <div class="cs-field"><label>计划结束</label><input type="date" data-f="endDate" value="${esc(draft.endDate)}"></div>
              <div class="cs-field cs-field-wide"><label>计划描述 / 目标</label><textarea data-f="description" rows="3" placeholder="描述计划目标、范围、验收标准">${esc(draft.description)}</textarea></div>
            </div>
          </div>

          <div class="cs-form-section">
            <div class="cs-form-section-head">
              <div class="cs-form-section-title">任务 WBS <span class="pl-count-pill">${draft.tasks.length} 项</span></div>
              <div class="pl-form-actions">
                <button type="button" class="btn pl-decompose-btn" id="plDecompose">⚡ 需求清单拆解总览</button>
                <button type="button" class="btn pl-add-btn" id="plAddTask">＋ 添加任务</button>
              </div>
            </div>
            <div class="pl-form-note">提示：任务平铺展示、人天可输入 5~6 位数字不截断；WBS 编码、父任务、依赖用于生成树与甘特。可点「需求清单拆解总览」按标准 8 阶段自动生成一版项目总览计划。</div>
            ${renderFormTasks(draft)}
          </div>

          <div class="cs-form-section">
            <div class="cs-form-section-head">
              <div class="cs-form-section-title">里程碑 <span class="pl-count-pill">${draft.milestones.length} 项</span></div>
              <div class="pl-form-actions"><button type="button" class="btn pl-add-btn" id="plAddMilestone">＋ 添加里程碑</button></div>
            </div>
            ${renderFormMilestones(draft)}
          </div>

          <div class="cs-form-section">
            <div class="cs-form-section-head">
              <div class="cs-form-section-title">资源 <span class="pl-count-pill">${draft.resources.length} 项</span></div>
              <div class="pl-form-actions"><button type="button" class="btn pl-add-btn" id="plAddResource">＋ 添加资源</button></div>
            </div>
            ${renderFormResources(draft)}
          </div>

          <div class="cs-form-section">
            <div class="cs-form-section-head">
              <div class="cs-form-section-title">团队成员 <span class="pl-count-pill">${draft.members.length} 人</span></div>
              <div class="pl-form-actions"><button type="button" class="btn pl-add-btn" id="plAddMember">＋ 添加成员</button></div>
            </div>
            <div class="pl-form-note">登记项目关键角色与职责分工（产品经理 / 系统经理 / 项目经理 / 研发 / 测试等），便于责任到人。</div>
            ${renderFormMembers(draft)}
          </div>

          <div class="cs-form-section">
            <div class="cs-form-section-head">
              <div class="cs-form-section-title">参考文档 <span class="pl-count-pill">${draft.references.length} 项</span></div>
              <div class="pl-form-actions"><button type="button" class="btn pl-add-btn" id="plAddReference">＋ 添加文档</button></div>
            </div>
            <div class="pl-form-note">关联需求清单、设计方案、测试方案、接口文档等，统一沉淀，方便团队查阅。</div>
            ${renderFormReferences(draft)}
          </div>
        </div>
      </div>
    </div>`;
  }

  function syncFormFromDom() {
    if (!dirtyForm || !el) return;
    // 基本信息（限定在 .cs-field 内取值，避免读到表格行的 data-f）
    const basicKeys = ['name', 'year', 'status', 'owner', 'projectId', 'projectName', 'startDate', 'endDate', 'description'];
    el.querySelectorAll('.cs-field [data-f]').forEach(inp => {
      const f = inp.getAttribute('data-f');
      if (!basicKeys.includes(f)) return;
      if (f === 'year') dirtyForm.year = Number(inp.value) || new Date().getFullYear();
      else dirtyForm[f] = inp.value;
    });
    // 任务表
    const taskRows = el.querySelectorAll('tr[data-task-idx]');
    taskRows.forEach(row => {
      const idx = Number(row.getAttribute('data-task-idx'));
      const t = dirtyForm.tasks[idx];
      if (!t) return;
      row.querySelectorAll('[data-f]').forEach(inp => {
        const f = inp.getAttribute('data-f');
        if (f === 'deps') { t.dependencies = inp.value.split(/[,，]/).map(s => s.trim()).filter(Boolean); return; }
        if (f === 'plannedHours') { t.plannedHours = inp.value === '' ? '' : Number(inp.value); return; }
        if (f === 'progress') { t.progress = inp.value === '' ? 0 : Math.max(0, Math.min(100, Number(inp.value))); return; }
        if (f === 'parentId') { t.parentId = inp.value; return; }
        t[f] = inp.value;
      });
    });
    // 里程碑表
    const msRows = el.querySelectorAll('tr[data-ms-idx]');
    msRows.forEach(row => {
      const idx = Number(row.getAttribute('data-ms-idx'));
      const m = dirtyForm.milestones[idx];
      if (!m) return;
      row.querySelectorAll('[data-f]').forEach(inp => { const f = inp.getAttribute('data-f'); m[f] = inp.value; });
    });
    // 资源表
    const resRows = el.querySelectorAll('tr[data-res-idx]');
    resRows.forEach(row => {
      const idx = Number(row.getAttribute('data-res-idx'));
      const r = dirtyForm.resources[idx];
      if (!r) return;
      row.querySelectorAll('[data-f]').forEach(inp => {
        const f = inp.getAttribute('data-f');
        if (f === 'total') { r.total = inp.value === '' ? '' : Number(inp.value); return; }
        r[f] = inp.value;
      });
    });
    // 团队成员表
    const memberRows = el.querySelectorAll('tr[data-member-idx]');
    memberRows.forEach(row => {
      const idx = Number(row.getAttribute('data-member-idx'));
      const m = dirtyForm.members[idx];
      if (!m) return;
      row.querySelectorAll('[data-f]').forEach(inp => { m[inp.getAttribute('data-f')] = inp.value; });
    });
    // 参考文档表
    const refRows = el.querySelectorAll('tr[data-ref-idx]');
    refRows.forEach(row => {
      const idx = Number(row.getAttribute('data-ref-idx'));
      const r = dirtyForm.references[idx];
      if (!r) return;
      row.querySelectorAll('[data-f]').forEach(inp => { r[inp.getAttribute('data-f')] = inp.value; });
    });
  }

  function validateDraft() {
    if (!dirtyForm.name || !String(dirtyForm.name).trim()) { SharedUI.toast('请填写计划名称', 'warning'); return false; }
    if (dirtyForm.startDate && dirtyForm.endDate && dateStamp(dirtyForm.startDate) > dateStamp(dirtyForm.endDate)) { SharedUI.toast('计划开始日期不能晚于结束日期', 'warning'); return false; }
    for (const t of dirtyForm.tasks) {
      if (t.startDate && t.endDate && dateStamp(t.startDate) > dateStamp(t.endDate)) { SharedUI.toast(`任务「${t.name || t.wbsCode}」开始晚于结束`, 'warning'); return false; }
    }
    return true;
  }

  function buildWbsCodes(draft) {
    // 依据 parentId 自动编号：根=1,2,3；子=1.1, 1.2...
    const byId = {};
    draft.tasks.forEach(t => { byId[t.id] = t; });
    const assign = (t, prefix, depth) => {
      const code = prefix ? prefix + '.' + depth : String(depth);
      t.wbsCode = code;
      const children = draft.tasks.filter(x => x.parentId === t.id);
      children.forEach((c, i) => assign(c, code, i + 1));
    };
    const roots = draft.tasks.filter(t => !t.parentId || !byId[t.parentId]);
    roots.forEach((t, i) => assign(t, '', i + 1));
  }

  async function submitPlan() {
    syncFormFromDom();
    if (!validateDraft()) return;
    buildWbsCodes(dirtyForm);
    // 整理：去除空任务/空里程碑/空资源，并把数值字段归一为 number（服务端强校验类型）
    const num = (v) => { const n = Number(v); return isFinite(n) && n >= 0 ? n : 0; };
    const tasks = dirtyForm.tasks.filter(t => t.name && String(t.name).trim()).map(t => ({
      ...t,
      name: String(t.name).trim(),
      plannedHours: num(t.plannedHours),
      progress: Math.max(0, Math.min(100, Math.round(num(t.progress)))),
      parentId: t.parentId || '',
      startDate: t.startDate || '',
      endDate: t.endDate || '',
      dependencies: Array.isArray(t.dependencies) ? t.dependencies : []
    }));
    const milestones = dirtyForm.milestones.filter(m => m.name && String(m.name).trim()).map(m => ({
      ...m, name: String(m.name).trim(), date: m.date || '', status: m.status || 'pending'
    }));
    const resources = dirtyForm.resources.filter(r => r.name && String(r.name).trim()).map(r => ({
      ...r, name: String(r.name).trim(), kind: r.kind || 'team', total: num(r.total)
    }));
    const members = (dirtyForm.members || []).filter(m => m.name && String(m.name).trim()).map(m => ({
      ...m, name: String(m.name).trim(), role: m.role || 'other'
    }));
    const references = (dirtyForm.references || []).filter(r => r.title && String(r.title).trim()).map(r => ({
      ...r, title: String(r.title).trim(), type: r.type || 'other'
    }));
    const plan = {
      id: dirtyForm.id, name: String(dirtyForm.name).trim(), year: Number(dirtyForm.year) || new Date().getFullYear(),
      status: dirtyForm.status || 'draft', owner: dirtyForm.owner || '', projectId: dirtyForm.projectId || '',
      projectName: dirtyForm.projectName || '', startDate: dirtyForm.startDate || '', endDate: dirtyForm.endDate || '',
      description: dirtyForm.description || '',
      tasks, milestones, resources, members, references, aiConfig: dirtyForm.aiConfig || {}
    };
    // 合并到 state.plans
    const plans = Array.isArray(state.plans) ? state.plans.slice() : [];
    const idx = plans.findIndex(p => p.id === plan.id);
    if (idx >= 0) plans[idx] = plan; else plans.push(plan);
    const ok = await saveState({ rev: state.rev, plans });
    if (ok) {
      currentView = 'list';
      dirtyForm = null;
      await fetchSummary();
      render();
    }
  }

  /* ==========================================================
     主渲染 + 事件绑定
     ========================================================== */
  function render() {
    if (!container) return;
    let html = '';
    if (currentView === 'list') html = renderListView();
    else if (currentView === 'detail') html = renderDetailView();
    else if (currentView === 'new' || currentView === 'edit') html = renderFormView();
    container.innerHTML = html;
    bindEvents();
  }
  function renderTabBody() {
    // 仅刷新 tab body（WBS/甘特/里程碑/资源/高管/AI 各 tab 内容区）
    if (currentView !== 'detail') return;
    el.querySelectorAll('.cs-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === currentTab));
    const plan = getPlan(currentPlanId);
    if (!plan) return;
    const msum = findSummary(currentPlanId) || {};
    let tabHtml = '';
    switch (currentTab) {
      case 'wbs': tabHtml = renderWbsTab(plan); break;
      case 'gantt': tabHtml = renderGanttTab(plan); break;
      case 'milestone': tabHtml = renderMilestoneTab(plan); break;
      case 'resource': tabHtml = renderResourceTab(plan); break;
      case 'exec': tabHtml = renderExecView(plan, msum); break;
      case 'ai': tabHtml = renderAiTab(plan); break;
      default: tabHtml = renderWbsTab(plan);
    }
    const tbody = el.querySelector('.pl-tab-body');
    if (tbody) tbody.innerHTML = tabHtml;
    bindTabEvents(); // 只重绑 tab body 内的 toggle / 事件，避免整视图重复绑定
  }

  function bindEvents() {
    if (!el) return;
    if (currentView === 'list') {
      el.querySelector('#plNewPlan')?.addEventListener('click', () => { dirtyForm = initFormDraft(null); currentView = 'new'; render(); });
      el.querySelector('#plFilter')?.addEventListener('input', (e) => {
        filterText = e.target.value.trim();
        const grid = el.querySelector('.pl-card-grid');
        const countEl = el.querySelector('.pl-list-count');
        const plans = (summary && summary.plans) || [];
        const q = filterText.toLowerCase();
        const filtered = plans.filter(s => !q || [s.name, s.id, s.owner, s.projectName].filter(Boolean).some(v => String(v).toLowerCase().includes(q)));
        if (countEl) countEl.textContent = `共 ${fmtNum(plans.length)} 个计划${filtered.length !== plans.length ? `，匹配 ${fmtNum(filtered.length)}` : ''}`;
        if (grid) {
          grid.innerHTML = filtered.map(s => renderPlanCard(s)).join('');
          grid.querySelectorAll('.pl-card').forEach(card => card.addEventListener('click', () => {
            currentPlanId = card.getAttribute('data-plan-id');
            currentTab = 'wbs'; currentView = 'detail';
            expandAuto(); render();
          }));
        }
      });
      el.querySelectorAll('.pl-card').forEach(card => card.addEventListener('click', () => {
        currentPlanId = card.getAttribute('data-plan-id');
        currentTab = 'wbs'; currentView = 'detail';
        expandAuto(); render();
      }));
    } else if (currentView === 'detail') {
      el.querySelector('#plBack')?.addEventListener('click', () => { currentView = 'list'; render(); });
      el.querySelector('#plEditPlan')?.addEventListener('click', () => { dirtyForm = initFormDraft(getPlan(currentPlanId)); currentView = 'edit'; render(); });
      el.querySelector('#plDeletePlan')?.addEventListener('click', () => {
        const plan = getPlan(currentPlanId);
        if (!plan) return;
        SharedUI.confirm('删除计划', `<p>确认删除计划「<b>${esc(plan.name)}</b>」？该操作不可撤销。</p>`, async () => {
          const plans = (state.plans || []).filter(p => p.id !== plan.id);
          const ok = await saveState({ rev: state.rev, plans });
          if (ok) { currentView = 'list'; await fetchSummary(); render(); }
        }, { confirmText: '确认删除', confirmClass: 'danger' });
      });
      el.querySelectorAll('.cs-tab').forEach(tab => tab.addEventListener('click', () => {
        const k = tab.getAttribute('data-tab');
        if (k === currentTab) return;
        currentTab = k;
        renderTabBody(); // renderTabBody 内部会刷新 active 态与 tab body
      }));
      bindTabEvents();
    } else if (currentView === 'new' || currentView === 'edit') {
      el.querySelector('#plFormCancel')?.addEventListener('click', () => { dirtyForm = null; currentView = currentPlanId ? 'detail' : 'list'; render(); });
      el.querySelector('#plFormCancel2')?.addEventListener('click', () => { dirtyForm = null; currentView = currentPlanId ? 'detail' : 'list'; render(); });
      el.querySelector('#plFormSave')?.addEventListener('click', submitPlan);
      el.querySelector('#plDecompose')?.addEventListener('click', () => { syncFormFromDom(); openDecomposePanel(); });
      el.querySelector('#plAddTask')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.tasks.push(blankTask()); renderFormBody(); });
      el.querySelector('#plAddMilestone')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.milestones.push(blankMilestone()); renderFormBody(); });
      el.querySelector('#plAddResource')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.resources.push(blankResource()); renderFormBody(); });
      el.querySelector('#plAddMember')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.members.push(blankMember()); renderFormBody(); });
      el.querySelector('#plAddReference')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.references.push(blankReference()); renderFormBody(); });
      el.querySelectorAll('.pl-del-task').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); const i = Number(btn.getAttribute('data-del-task')); dirtyForm.tasks.splice(i, 1); renderFormBody(); }));
      el.querySelectorAll('.pl-del-ms').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); const i = Number(btn.getAttribute('data-del-ms')); dirtyForm.milestones.splice(i, 1); renderFormBody(); }));
      el.querySelectorAll('.pl-del-res').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); const i = Number(btn.getAttribute('data-del-res')); dirtyForm.resources.splice(i, 1); renderFormBody(); }));
      el.querySelectorAll('.pl-del-member').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); const i = Number(btn.getAttribute('data-del-member')); dirtyForm.members.splice(i, 1); renderFormBody(); }));
      el.querySelectorAll('.pl-del-ref').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); const i = Number(btn.getAttribute('data-del-ref')); dirtyForm.references.splice(i, 1); renderFormBody(); }));
    }
  }
  function bindTabEvents() {
    if (!el) return;
    el.querySelectorAll('.pl-tree-toggle:not(.leaf)').forEach(tg => tg.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = tg.getAttribute('data-toggle-id');
      if (expandedWbs.has(id)) expandedWbs.delete(id); else expandedWbs.add(id);
      renderTabBody();
    }));
  }
  function renderFormBody() {
    // 表单区结构随 tasks/milestones/resources 增删而变，直接整视图重绘（dirtyForm 为唯一数据源）
    render();
  }

  /* ==========================================================
     生命周期
     ========================================================== */
  async function enter(subPath) {
    applySubPath(subPath);
  }
  function applySubPath(subPath) {
    const parts = (subPath || '').split('/').filter(Boolean);
    if (parts.length === 0) {
      currentView = 'list';
      currentPlanId = null;
      dirtyForm = null;
    } else if (parts[0] === 'new') {
      currentView = 'new';
      currentPlanId = null;
      dirtyForm = initFormDraft(null);
    } else if (parts[0] === 'detail' && parts[1]) {
      currentView = 'detail';
      currentPlanId = parts[1];
      if (parts[2] && ['wbs', 'gantt', 'milestone', 'resource', 'exec', 'ai'].includes(parts[2])) currentTab = parts[2]; else currentTab = 'wbs';
      dirtyForm = null;
    } else if (parts[0] === 'edit' && parts[1]) {
      currentView = 'edit';
      currentPlanId = parts[1];
      dirtyForm = initFormDraft(getPlan(currentPlanId));
    } else {
      currentView = 'list';
      currentPlanId = null;
    }
    expandAuto();
  }
  function expandAuto() {
    // 默认完整展开第一层（平铺展示），根节点全部展开
    if (currentView === 'detail') {
      const plan = getPlan(currentPlanId);
      if (plan && plan.tasks) plan.tasks.forEach(t => { if (!t.parentId || !plan.tasks.find(x => x.id === t.parentId)) expandedWbs.add(t.id); });
    }
  }
  function leave() {
    // 无副作用
  }
  function getSummary() {
    return summary && summary.agg || null;
  }

  /* ---------- 初始化加载 ---------- */
  async function init(el_, context) {
    container = el_;
    el = el_;
    el.innerHTML = `<div class="cs-loading">加载项目计划…</div>`;
    await Promise.all([fetchState(), fetchSummary()]);
    render();
  }

  // 暴露内部 debug 钩子
  const api = {
    moduleId: 'plan',
    refresh: async () => { await Promise.all([fetchState(), fetchSummary()]); render(); }
  };
  if (!window._planApi) window._planApi = api;

  // ModuleDefinition
  return {
    id: 'plan',
    name: '项目计划',
    icon: '🗓️',
    order: 3,
    sidebar: true,
    init,
    enter,
    leave,
    getSummary
  };
})();
