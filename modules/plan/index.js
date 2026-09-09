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
  let currentTab = 'overview';         // 详情页当前 tab: overview | wbs | gantt | milestone | resource | exec | ai
  let currentFormTab = 'basic';        // 新建/编辑表单当前 tab: basic|overview|milestone|wbs|market|issue|risk|resource|member|reference
  let dirtyForm = null;                // 编辑中的表单草稿（含 tasks/milestones/resources/overview...）
  let expandedWbs = new Set();         // 已展开的 wbs 节点 id
  let filterText = '';
  let isSaving = false;
  let planConfig = { rpdTemplateUrl: '' };   // 本机配置（GET /api/plan/config）

  /* ---------- 常量表 ---------- */
  const PLAN_STATUS_LABELS = { draft: '草稿', active: '进行中', completed: '已完成', archived: '已归档' };
  const PLAN_STATUS_CLASS = { draft: 'status-planned', active: 'status-active', completed: 'status-done', archived: 'status-hold' };
  const TASK_STATUS_LABELS = { 'not-started': '未开始', 'in-progress': '进行中', completed: '已完成', blocked: '受阻' };
  const TASK_STATUS_CLASS = { 'not-started': 'status-planned', 'in-progress': 'status-active', completed: 'status-done', blocked: 'status-hold' };
  const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' };
  const TASK_TYPE_LABELS = { dev: '开发', test: '测试', design: '设计', doc: '文档', ops: '运维', other: '其他' };
  /* 行拖拽把手：树形表直接复用「序号」列当把手（不额外占宽度），
     平铺表没有序号列，插一列 28px 窄把手。语义见 applyRowDrop 上方注释。 */
  const DRAG_TIP = '按住拖动：上/下沿=同级换序，中间=成为子项&#10;键盘：Alt+↑/↓ 换序，Alt+→ 缩进，Alt+← 升级';
  const DRAG_TIP_FLAT = '按住拖动调整顺序&#10;键盘：Alt+↑/↓';
  const DRAG_TH = '<th class="pl-drag-th"></th>';
  const DRAG_TD = `<td class="pl-drag pl-drag-cell" tabindex="0" role="button" aria-label="拖动调整顺序，或按 Alt 加上下方向键" title="${DRAG_TIP_FLAT}"><span class="pl-grip">⠿</span></td>`;
  const MILESTONE_STATUS_LABELS = { pending: '待完成', 'in-progress': '进行中', done: '已完成' };
  const MILESTONE_STATUS_CLASS = { pending: 'status-planned', 'in-progress': 'status-active', done: 'status-done' };
  const RES_KIND_LABELS = { team: '团队', person: '个人' };
  const MEMBER_ROLE_LABELS = { pm: '项目经理', product: '产品经理', system: '系统经理', dev: '研发', test: '测试', design: '设计', other: '其他' };
  const REF_TYPE_LABELS = { requirement: '需求文档', design: '设计文档', test: '测试文档', api: '接口文档', other: '其他' };
  /* ★ RPD 规范文档模板库（部门级知识库链接）
     —— 链接不写在源码里，而是存本机 data/plan/config.json（已 .gitignore），
        由 GET /api/plan/config 提供。这样你维护链接不会与 git 拉取冲突。 */
  // 取生效链接：优先用计划自带（历史数据/特殊项目覆盖），否则用本机配置
  function rpdUrlOf(obj) { return String((obj && obj.rpdTemplateUrl) || (planConfig && planConfig.rpdTemplateUrl) || '').trim(); }

  /* 参考文档 / 交付件（评审阶段 + 提交状态） */
  const REF_STAGE_LABELS = { TR2: 'TR2', TR3: 'TR3', TR4: 'TR4', TR5: 'TR5', other: '其他' };
  const REF_DOC_STATUS_LABELS = { pending: '待提交', submitted: '已提交', reviewing: '评审中', passed: '已通过', na: '不适用' };
  const REF_DOC_STATUS_CLASS = { pending: 'status-planned', submitted: 'status-active', reviewing: 'status-active', passed: 'status-done', na: 'status-hold' };
  /* 遗留问题 / 项目风险（二阶段） */
  const ISSUE_STATUS_LABELS = { pending: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' };
  const ISSUE_STATUS_CLASS = { pending: 'status-hold', processing: 'status-active', resolved: 'status-done', closed: 'status-planned' };
  const RISK_TYPE_LABELS = { tech: '技术风险', market: '市场风险', quality: '质量风险', schedule: '进度风险', resource: '资源风险', other: '其他风险' };
  const RISK_STATUS_LABELS = { occurring: '发生中', watching: '观察中', mitigated: '已缓解', closed: '已关闭' };
  const RISK_STATUS_CLASS = { occurring: 'status-hold', watching: 'status-active', mitigated: 'status-done', closed: 'status-planned' };

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
  // 读取本机配置（RPD 模板库链接等）。失败不影响主流程，只是按钮置灰。
  async function fetchConfig() {
    try {
      const resp = await fetch('/api/plan/config');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const cfg = await resp.json();
      planConfig = { rpdTemplateUrl: (cfg && cfg.rpdTemplateUrl) || '' };
    } catch (e) {
      planConfig = { rpdTemplateUrl: '' };
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
  /* ==========================================================
     通用多层级树工具（项目总览 / WBS任务 / 上市计划 / 参考文档 共用）
     支持无限层级：1 → 1.1 → 1.1.1 → 1.1.1.1 …
     ========================================================== */
  // 取节点显示名（不同板块字段名不同）
  function nodeLabel(x) { return x.name || x.title || '(未命名)'; }
  // 按 parentId 组树，返回「树序」平铺结果：[{ item, depth, code, index }]
  // index = 该项在原数组中的下标（供 data-*-idx 与 syncFormFromDom 定位）
  function treeOrder(list) {
    const arr = Array.isArray(list) ? list : [];
    const idxOf = {};
    arr.forEach((x, i) => { idxOf[x.id] = i; });
    const childrenOf = {};
    const roots = [];
    arr.forEach(x => {
      const pid = (x.parentId && x.parentId !== x.id && idxOf[x.parentId] !== undefined) ? x.parentId : '';
      if (pid) (childrenOf[pid] = childrenOf[pid] || []).push(x);
      else roots.push(x);
    });
    const out = [];
    const seen = new Set();
    const walk = (nodes, depth, prefix) => {
      nodes.forEach((x, k) => {
        if (seen.has(x.id)) return;          // 防御环引用
        seen.add(x.id);
        const code = prefix ? prefix + '.' + (k + 1) : String(k + 1);
        out.push({ item: x, depth: depth, code: code, index: idxOf[x.id] });
        walk(childrenOf[x.id] || [], depth + 1, code);
      });
    };
    walk(roots, 0, '');
    // 兜底：环引用等异常导致未收录的行，按原序追加到末尾，避免"数据在但看不见"
    arr.forEach((x, i) => {
      if (!seen.has(x.id)) out.push({ item: x, depth: 0, code: String(out.length + 1), index: i });
    });
    return out;
  }
  /* 层级缩进包裹：缩进必须加在「外层容器的 padding」上，不能加在输入框的 margin 上。
     输入框是 width:100%（已占满单元格），再给它 margin-left 会让总宽变成 100%+缩进，
     直接溢出单元格、压到右边那一列上。包一层 div 把缩进吃进 padding，
     输入框的 100% 就是基于收窄后的内容宽度算的，任何层级都不会溢出。
     步长与层级上限保持保守：缩进吃掉的是可输入宽度，太深会窄到没法编辑。 */
  const IND_STEP = 16, IND_MAX_LVL = 6;
  function indWrap(d, inner) {
    const ind = Math.min(Number(d) || 0, IND_MAX_LVL) * IND_STEP;
    return `<div class="pl-ind"${ind ? ` style="padding-left:${ind}px"` : ''}>${inner}</div>`;
  }
  // 某节点的全部后代 id（父级下拉需排除，避免选成自己的子孙形成环）
  function descendantIds(list, id) {
    const arr = Array.isArray(list) ? list : [];
    const set = new Set();
    const walk = (pid) => {
      arr.forEach(x => { if (x.parentId === pid && !set.has(x.id)) { set.add(x.id); walk(x.id); } });
    };
    walk(id);
    return set;
  }
  // 父级下拉选项（缩进 + 层级编号；排除自身与后代）
  function parentOptions(list, selfId, selected, topLabel) {
    const bad = descendantIds(list, selfId);
    bad.add(selfId);
    const opts = treeOrder(list).filter(o => !bad.has(o.item.id)).map(o =>
      `<option value="${esc(o.item.id)}" ${o.item.id === selected ? 'selected' : ''}>${esc('　'.repeat(o.depth) + o.code + ' ' + nodeLabel(o.item))}</option>`
    ).join('');
    return `<option value="">${esc(topLabel || '— 顶层 —')}</option>` + opts;
  }
  // 删除某行时连带删除其所有后代（树语义），返回新数组
  function removeWithDescendants(list, idx) {
    const arr = Array.isArray(list) ? list : [];
    const target = arr[idx];
    if (!target) return arr.slice();
    const kill = descendantIds(arr, target.id);
    kill.add(target.id);
    return arr.filter(x => !kill.has(x.id));
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
  /* ---------- Dashboard ① 4 个 KPI（只保留有决策价值的口径） ---------- */
  function renderMetricStrip() {
    const agg = (summary && summary.agg) || {};
    const overdueMs = agg.overdueMilestoneTotal || 0;
    const cards = [
      { icon: '▶️', value: `${fmtNum(agg.activeCount)}<small> / ${fmtNum(agg.planCount)}</small>`, label: '进行中计划', sub: '当前在推 / 总数', color: 'blue' },
      { icon: '🚨', value: fmtNum(agg.attentionCount), label: '需关注计划', sub: '逾期或未闭环', color: (agg.attentionCount > 0) ? 'pink' : 'green' },
      { icon: '🎯', value: fmtNum(agg.milestoneThisMonth), label: '本月待达成里程碑', sub: overdueMs ? `其中 ${fmtNum(overdueMs)} 项已逾期` : '本月节点', color: overdueMs ? 'orange' : 'teal' },
      { icon: '📌', value: fmtNum(agg.openItemsTotal), label: '待闭环事项', sub: `问题 ${fmtNum(agg.openIssueTotal)} · 风险 ${fmtNum(agg.openRiskTotal)}`, color: (agg.openItemsTotal > 0) ? 'purple' : 'green' }
    ];
    return `<div class="cs-metric-grid pl-kpi-grid">${cards.map(c => `
      <div class="cs-metric cs-metric-${c.color}">
        <div class="cs-metric-top"><span class="cs-metric-icon">${c.icon}</span><span class="cs-metric-trend">${esc(c.sub)}</span></div>
        <div class="cs-metric-value">${c.value}</div>
        <div class="cs-metric-label">${esc(c.label)}</div>
      </div>`).join('')}</div>`;
  }

  /* ---------- Dashboard 空态：说明各区块建计划后会呈现什么，避免首屏看起来"坏了" ---------- */
  function renderDashboardEmptyGuide() {
    const blocks = [
      { ic: '🚨', t: '需要关注的计划', d: '按关注度排序（逾期里程碑×3 + 逾期/受阻任务×2 + 未闭环风险 + 待办问题），带「当前阶段」，点击直达详情。' },
      { ic: '🎯', t: '近期里程碑', d: '未来 30 天跨全部计划的节点时间线，逾期标红——用来发现多个项目节点撞车。' },
      { ic: '📊', t: '阶段分布', d: '进行中/草稿计划分别处在标准 8 阶段的哪一步，暴露部门产能瓶颈环节。' }
    ];
    return `
    <div class="cs-panel pl-dash-panel pl-dash-guide">
      <h4>指挥台预览</h4>
      <div class="pl-guide-grid">
        ${blocks.map(b => `
          <div class="pl-guide-item">
            <span class="pl-guide-ic">${b.ic}</span>
            <div class="pl-guide-text"><b>${esc(b.t)}</b><p>${esc(b.d)}</p></div>
          </div>`).join('')}
      </div>
      <div class="section-note">数据来源：各计划的「项目总览 / WBS任务 / 里程碑 / 遗留问题 / 项目风险」标签页，填写后本页自动聚合，无需额外维护。</div>
    </div>`;
  }

  /* ---------- Dashboard ② 需要关注的计划（按关注度排序） ---------- */
  function renderAttentionTable(plans) {
    const list = plans.filter(s => (s.attentionScore || 0) > 0)
      .slice().sort((a, b) => (b.attentionScore || 0) - (a.attentionScore || 0));
    if (!list.length) {
      return `<div class="cs-panel pl-dash-panel">
        <h4>需要关注的计划 <small>逾期 / 受阻 / 未闭环</small></h4>
        <div class="pl-none-risks">✓ 暂无需要关注的计划，所有节点与事项均在控</div>
      </div>`;
    }
    const rows = list.map(s => {
      const wbs = s.wbs || {};
      const next = (s.upcomingMilestones || [])[0];
      const nextTxt = next
        ? `${esc(fmtDate(next.date))} ${esc(next.name || '')}${(next.date && next.date < s.today) ? ' <span class="pl-overdue">已逾期</span>' : ''}`
        : '—';
      return `
      <tr class="pl-attention-row" data-plan-id="${esc(s.id)}">
        <td class="txt"><b>${esc(s.name || s.id)}</b></td>
        <td class="txt">${esc(s.owner || '未指派')}</td>
        <td class="txt">${s.currentStage ? `<span class="pl-chip">${esc(s.currentStage)}</span>` : '—'}</td>
        <td class="pl-progress-cell">${progressBadge(wbs.overallProgress || 0)}</td>
        <td>${(s.risks || []).length ? `<b class="pl-danger">${fmtNum((s.risks || []).length)}</b>` : '0'}</td>
        <td>${s.overdueMilestones ? `<b class="pl-danger">${fmtNum(s.overdueMilestones)}</b>` : '0'}</td>
        <td>${s.projectRiskOpen ? `<b class="pl-danger">${fmtNum(s.projectRiskOpen)}</b>` : '0'}</td>
        <td>${s.issueOpen ? `<b class="pl-warnnum">${fmtNum(s.issueOpen)}</b>` : '0'}</td>
        <td class="txt">${nextTxt}</td>
      </tr>`;
    }).join('');
    return `
    <div class="cs-panel pl-dash-panel">
      <h4>需要关注的计划 <small>按关注度排序（逾期里程碑×3 + 逾期/受阻任务×2 + 未闭环风险 + 待办问题）</small></h4>
      <div class="table-wrapper pl-attention-wrap">
        <table class="data-table pl-attention-table">
          <thead><tr>
            <th class="txt" style="min-width:180px">计划</th><th class="txt">负责人</th><th class="txt" style="min-width:120px">当前阶段</th>
            <th style="min-width:110px">整体进度</th><th>逾期/受阻任务</th><th>逾期里程碑</th><th>未闭环风险</th><th>待办问题</th>
            <th class="txt" style="min-width:200px">最近里程碑</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="section-note">点击任意行进入该计划详情。</div>
    </div>`;
  }

  /* ---------- Dashboard ③ 近期里程碑时间线（未来 30 天，跨全部计划） ---------- */
  function renderMilestoneTimeline(plans) {
    const today = todayStamp();
    const horizon = today + 30 * 86400000;
    const items = [];
    plans.forEach(s => (s.upcomingMilestones || []).forEach(m => {
      const ts = dateStamp(m.date);
      if (ts == null) return;
      if (ts <= horizon) items.push({ ts: ts, date: m.date, name: m.name || '', plan: m.planName || s.name || '', overdue: ts < today });
    }));
    items.sort((a, b) => a.ts - b.ts);
    const body = items.length ? items.slice(0, 12).map(x => `
      <div class="pl-tl-row ${x.overdue ? 'overdue' : ''}">
        <span class="pl-tl-date">${esc(fmtDate(x.date))}</span>
        <span class="pl-tl-dot"></span>
        <span class="pl-tl-name">${esc(x.name)}</span>
        <span class="pl-tl-plan">${esc(x.plan)}</span>
        ${x.overdue ? '<span class="pl-overdue">逾期</span>' : ''}
      </div>`).join('') : '<div class="pl-none">未来 30 天内没有待达成里程碑</div>';
    return `
    <div class="cs-panel pl-dash-panel">
      <h4>近期里程碑 <small>未来 30 天 · 跨全部计划（可看节点撞车）</small></h4>
      <div class="pl-tl-list">${body}</div>
      ${items.length > 12 ? `<div class="section-note">仅显示最近 12 项，共 ${fmtNum(items.length)} 项。</div>` : ''}
    </div>`;
  }

  /* ---------- Dashboard ④ 阶段分布（部门盘子全景，看瓶颈卡在哪一环） ---------- */
  function renderStageDistribution(plans) {
    const actives = plans.filter(s => s.status === 'active' || s.status === 'draft');
    const counts = {};
    actives.forEach(s => {
      const k = s.currentStage || '未设置总览';
      counts[k] = (counts[k] || 0) + 1;
    });
    // 按标准 8 阶段顺序排列，其余追加在后
    const order = OVERVIEW_STAGES.map(s => s.name);
    const keys = Object.keys(counts).sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const max = Math.max(1, ...keys.map(k => counts[k]));
    const body = keys.length ? keys.map(k => `
      <div class="pl-stage-row">
        <span class="pl-stage-name">${esc(k)}</span>
        <div class="pl-stage-bar"><div class="pl-stage-fill" style="width:${Math.round(counts[k] / max * 100)}%"></div></div>
        <span class="pl-stage-num">${fmtNum(counts[k])}</span>
      </div>`).join('') : '<div class="pl-none">暂无进行中/草稿计划</div>';
    return `
    <div class="cs-panel pl-dash-panel">
      <h4>阶段分布 <small>进行中/草稿计划当前所处阶段（部门瓶颈一目了然）</small></h4>
      <div class="pl-stage-bars">${body}</div>
    </div>`;
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
    const hasPlans = plans.length > 0;
    return `
    <div class="cs-view-head">
      <div class="cs-view-head-left">
        <h3>项目计划</h3>
        <p class="pl-head-desc">部门项目执行指挥台：先看要出事的，再看最近要交的</p>
      </div>
      <button class="btn primary" id="plNewPlan">＋ 新建计划</button>
    </div>
    ${renderMetricStrip()}
    ${hasPlans ? `
      ${renderAttentionTable(plans)}
      <div class="pl-dash-grid">
        ${renderMilestoneTimeline(plans)}
        ${renderStageDistribution(plans)}
      </div>
    ` : ''}
    <div class="pl-allplans-head">
      <h4>全部计划 <span class="pl-count-pill">${fmtNum(plans.length)}</span></h4>
      <div class="pl-list-bar pl-list-bar-inline">
        <div class="pl-search">
          <span class="pl-search-ic">🔍</span>
          <input type="text" id="plFilter" class="pl-search-input" placeholder="按计划名 / 项目 / 负责人筛选" value="${esc(filterText)}">
        </div>
        <div class="pl-list-count">${filtered.length !== plans.length ? `匹配 ${fmtNum(filtered.length)} / ${fmtNum(plans.length)}` : `共 ${fmtNum(plans.length)} 个`}</div>
      </div>
    </div>
    ${filtered.length === 0 ? `<div class="pl-empty"><div class="pl-empty-ic">🗓️</div><p>${plans.length === 0 ? '还没有计划，点击右上角「新建计划」开始' : '没有匹配的计划'}</p></div>`
      : `<div class="pl-card-grid">${filtered.map(s => renderPlanCard(s)).join('')}</div>`}
    ${plans.length === 0 ? renderDashboardEmptyGuide() : ''}`;
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
    const MAX = 8;
    const items = refs.slice(0, MAX).map(r => {
      const label = REF_STAGE_LABELS[r.stage] || REF_TYPE_LABELS[r.type] || '';
      const link = r.link ? `<a class="pl-ref-link" href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : `<span>${esc(r.title)}</span>`;
      return `<span class="pl-ref-item">${label ? `<span class="pl-chip">${esc(label)}</span>` : ''}${link}</span>`;
    }).join('');
    const more = refs.length > MAX ? `<span class="pl-ref-more">共 ${refs.length} 项，编辑计划查看全部</span>` : '';
    const rpd = plan.rpdTemplateUrl ? `<a class="pl-ref-link pl-rpd-inline" href="${esc(plan.rpdTemplateUrl)}" target="_blank" rel="noopener">📚 RPD 模板库 ↗</a>` : '';
    return `<div class="pl-detail-block"><span class="pl-block-label">📎 交付件</span><div class="pl-ref-list">${items}${more}${rpd}</div></div>`;
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
      { key: 'overview', label: '项目总览', icon: '📋' },
      { key: 'wbs', label: 'WBS 任务', icon: '🌳' },
      { key: 'gantt', label: '甘特图', icon: '📊' },
      { key: 'milestone', label: '里程碑', icon: '🎯' },
      { key: 'resource', label: '资源负荷', icon: '👥' },
      { key: 'exec', label: '高管视图', icon: '📊' },
      { key: 'ai', label: 'AI 规则', icon: '🤖' }
    ];
    return `<div class="cs-topnav">${tabs.map(t => `<button class="cs-tab ${currentTab === t.key ? 'active' : ''}" data-tab="${t.key}"><span class="cs-tab-icon">${t.icon}</span>${t.label}</button>`).join('')}</div>`;
  }

  /* ---------- 详情页 Tab 0：项目总览（只读展示，编辑在新建/编辑表单里） ---------- */
  function renderOverviewTab(plan) {
    const stages = plan.overview || [];
    if (stages.length === 0) {
      return `<div class="pl-wrap"><div class="pl-empty"><div class="pl-empty-ic">📋</div><p>暂无项目总览。点击右下角「编辑计划」，在「项目总览」标签页维护 8 阶段大纲。</p></div></div>`;
    }
    const rows = treeOrder(stages).map(o => {
      const s = o.item, d = o.depth;
      const pct = Number(s.progress || 0);
      return `
      <tr data-depth="${d}">
        <td class="pl-ov-seq">${o.code}</td>
        <td class="txt" style="padding-left:${6 + d * 20}px${d ? '' : ';font-weight:600'}">${esc(s.name)}</td>
        <td class="txt">${esc(s.owner || '—')}</td>
        <td class="txt">${esc(fmtDate(s.startDate))}</td>
        <td class="txt">${esc(fmtDate(s.endDate))}</td>
        <td><span class="badge ${pc(s.status)}">${esc(TASK_STATUS_LABELS[s.status] || s.status || '未开始')}</span></td>
        <td class="pl-progress-cell">${progressBadge(pct)}</td>
        <td class="txt">${esc(s.deliverable || '—')}</td>
        <td class="txt">${esc(s.note || '—')}</td>
      </tr>`;
    }).join('');
    return `
    <div class="pl-wrap">
      <div class="pl-sect-head">
        <h4>项目总览 <span class="pl-count-pill">${stages.filter(s => !s.parentId).length} 阶段</span></h4>
        <span class="pl-hint">项目级大纲；编辑请点右下角「编辑计划」→「项目总览」标签页</span>
      </div>
      <div class="table-wrapper pl-ov-table-wrap">
        <table class="data-table pl-ov-table">
          <thead><tr>
            <th style="min-width:44px">#</th><th class="txt">阶段 / 子流程</th><th class="txt">负责人</th>
            <th class="txt">开始</th><th class="txt">结束</th><th>状态</th><th style="min-width:110px">进度</th>
            <th class="txt">交付物</th><th class="txt">备注</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
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
      case 'overview': tabHtml = renderOverviewTab(plan); break;
      case 'wbs': tabHtml = renderWbsTab(plan); break;
      case 'gantt': tabHtml = renderGanttTab(plan); break;
      case 'milestone': tabHtml = renderMilestoneTab(plan); break;
      case 'resource': tabHtml = renderResourceTab(plan); break;
      case 'exec': tabHtml = renderExecView(plan, msum); break;
      case 'ai': tabHtml = renderAiTab(plan); break;
      default: tabHtml = renderOverviewTab(plan);
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
  // 参考文档/交付件：支持多层级(parentId)，字段对齐部门交付件清单
  function blankReference(parentId) {
    return { id: 'rf-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), parentId: parentId || '', title: '', stage: 'TR2', dept: '', owner: '', date: '', status: 'pending', requirement: '', link: '', note: '', type: 'requirement' };
  }
  /* VRC 版本项目交付时的标准交付件清单模板（支持用户增删改；层级用 subs 表达） */
  const REF_DOC_TEMPLATE = [
    { title: '产品规格书/需求规格说明书', stage: 'TR2', dept: '系统工程师' },
    { title: '项目任务书', stage: 'other', dept: '项目经理' },
    { title: '立项材料', stage: 'other', dept: '项目经理', subs: [
      { title: '立项评审汇报材料', stage: 'other', dept: '项目经理' },
      { title: '立项评审会议纪要', stage: 'other', dept: '项目经理' }
    ] },
    { title: '系统方案设计报告/系统方案设计说明书', stage: 'TR2', dept: '系统工程师' },
    { title: '【系统部内控】系统方案准出checklist', stage: 'TR2', dept: '系统工程师' },
    { title: '知识产权分析与计划', stage: 'other', dept: '系统工程师' },
    { title: '测试方案/软件测试方案', stage: 'TR3', dept: '智慧能源TSE' },
    { title: '【智慧能源测试部内控】测试方案准出checklist', stage: 'TR3', dept: '智慧能源TSE' },
    { title: '【研发内控】代码安全检查报告', stage: 'TR4', dept: '软件工程师' },
    { title: '【应用软件】软件测试用例', stage: 'TR4', dept: '测试代表' },
    { title: '【应用软件】前端软件详细设计', stage: 'TR4', dept: '软件工程师' },
    { title: '【应用软件】接口软件详细设计', stage: 'TR4', dept: '软件工程师' },
    { title: '【应用软件】数据软件详细设计', stage: 'TR4', dept: '软件工程师' },
    { title: '【应用软件】算法软件详细设计', stage: 'TR4', dept: '软件工程师' },
    { title: '【应用软件】软件测试报告', stage: 'TR4', dept: '智慧能源测试代表' },
    { title: 'TR5结项材料', stage: 'TR5', dept: '项目经理', subs: [
      { title: 'TR5技术评审汇报', stage: 'TR5', dept: '项目经理' },
      { title: 'TR5技术评审会议纪要', stage: 'TR5', dept: '项目经理' }
    ] }
  ];
  function seedReferenceDocs() {
    const out = [];
    const push = (def, parentId) => {
      const r = blankReference(parentId);
      r.title = def.title; r.stage = def.stage || 'other'; r.dept = def.dept || '';
      out.push(r);
      (def.subs || []).forEach(sub => push(sub, r.id));
    };
    REF_DOC_TEMPLATE.forEach(def => push(def, ''));
    return out;
  }

  /* ==========================================================
     项目总览：固定 8 阶段项目级大纲（独立于 WBS 任务，数据存 plan.overview[]）
     标准 8 阶段：需求传递 / 环境准备 / 方案设计 / 技术详设设计 /
                 研发计划 / 测试计划 / 实证 / 上市交付
     （与需求清单彻底解耦；需求清单用于将来的「详细计划」）
     ========================================================== */
  // 测试计划阶段固定的 6 条子流程
  const TEST_PLAN_SUBS = ['测试方案设计', '测试用例编写', '敏捷测试', '系统测试一轮', '系统测试二轮', '可用性测试(实证测试)'];
  const OVERVIEW_STAGES = [
    { name: '需求传递', deliverable: '需求评审纪要' },
    { name: '环境准备', deliverable: '开发/测试环境就绪' },
    { name: '方案设计', deliverable: '总体方案文档' },
    { name: '技术详设设计', deliverable: '详细设计文档' },
    { name: '研发计划', deliverable: '功能实现' },
    { name: '测试计划', deliverable: '测试报告', subs: TEST_PLAN_SUBS },
    { name: '实证', deliverable: '现场实证报告' },
    { name: '上市交付', deliverable: '交付/上市材料' }
  ];
  // 阶段行：parentId 为空=一级阶段；非空=子流程行（如测试计划下的 6 条）
  function blankStage(parentId) {
    return { id: 'ov-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), parentId: parentId || '', name: '', owner: '', startDate: '', endDate: '', status: 'not-started', progress: 0, deliverable: '', note: '' };
  }
  // 用标准 8 阶段初始化一版项目总览大纲（测试计划自动挂 6 条固定子流程）
  function seedOverviewStages() {
    const out = [];
    OVERVIEW_STAGES.forEach(s => {
      const st = blankStage('');
      st.name = s.name; st.deliverable = s.deliverable;
      out.push(st);
      if (s.subs) s.subs.forEach(sub => {
        const c = blankStage(st.id);
        c.name = sub;
        out.push(c);
      });
    });
    return out;
  }

  /* ==========================================================
     二阶段板块：遗留问题 / 项目风险 / 上市计划
     ========================================================== */
  function blankIssue() {
    return { id: 'is-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), code: '', desc: '', solution: '', owner: '', dueDate: '', progress: '', conclusion: '', status: 'pending' };
  }
  function blankRisk() {
    return { id: 'rk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), type: 'other', desc: '', solution: '', owner: '', dueDate: '', status: 'occurring', progress: '' };
  }
  // 上市计划任务行：parentId 为空=阶段；非空=阶段下的子任务
  function blankMarketTask(parentId) {
    return { id: 'mk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), parentId: parentId || '', name: '', startDate: '', endDate: '', owner: '', status: 'not-started', note: '' };
  }
  // 标准上市计划模板（5 阶段 + 子任务，参考钉钉模板）
  const MARKET_STAGES = [
    { name: '上市策略阶段', subs: ['上市策略明确（同业竞品分析）'] },
    { name: '上市计划阶段', subs: ['上市计划编制', '上市计划对齐'] },
    { name: '上市准备阶段', subs: ['上市资料信息准备', '产品推广', '培训', '内容体验', '可用性测试'] },
    { name: '产品试销阶段', subs: ['分批上线', '灰度'] },
    { name: '产品上线阶段', subs: ['上线跟踪跟测', '满意度调研'] }
  ];
  function seedMarketPlan() {
    const out = [];
    MARKET_STAGES.forEach(s => {
      const st = blankMarketTask('');
      st.name = s.name;
      out.push(st);
      (s.subs || []).forEach(sub => {
        const c = blankMarketTask(st.id);
        c.name = sub;
        out.push(c);
      });
    });
    return out;
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
      // 参考文档/交付件：默认直接带出 VRC 标准清单（新建自动生成；编辑时为空也补一版）
      references: (p && p.references && p.references.length ? p.references.map(r => ({ ...r })) : seedReferenceDocs()),
      // 项目总览：新建计划时自动初始化标准 8 阶段（含测试计划的 6 条固定子流程）；编辑时保留原有大纲，若为空也补一版
      overview: (p && p.overview && p.overview.length ? p.overview.map(o => ({ ...o })) : seedOverviewStages()),
      // RPD 规范文档模板库链接（部门知识库，可自定义）
      rpdTemplateUrl: (p && p.rpdTemplateUrl) || '',
      // 上市计划：默认直接带出标准 5 阶段模板（新建自动生成；编辑时为空也补一版）
      marketPlan: (p && p.marketPlan && p.marketPlan.length ? p.marketPlan.map(x => ({ ...x })) : seedMarketPlan()),
      issues: (p && p.issues ? p.issues : []).map(x => ({ ...x })),
      risks: (p && p.risks ? p.risks : []).map(x => ({ ...x })),
      aiConfig: (p && p.aiConfig) || {}
    };
  }

  /* 父任务下拉已统一改用通用 parentOptions（带缩进层级编号 + 排除后代防成环） */

  function renderFormTasks(draft) {
    if (!draft.tasks.length) {
      return `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">🌳</div><p>暂无任务，点击「添加任务」</p></div>`;
    }
    // 按树序展示（支持无限层级），层级编号由 treeOrder 计算，保存时 buildWbsCodes 再写入 wbsCode
    const rows = treeOrder(draft.tasks).map(o => {
      const t = o.item, i = o.index, d = o.depth;
      return `
      <tr data-task-idx="${i}" data-depth="${d}">
        <td class="pl-ov-seq pl-drag" tabindex="0" role="button" aria-label="拖动调整顺序与层级，或按 Alt 加方向键" title="${DRAG_TIP}">${o.code}</td>
        <td>${indWrap(d, `<input class="pl-f-name" data-f="name" value="${esc(t.name)}" placeholder="任务名称"${d ? '' : ' style="font-weight:600"'}>`)}</td>
        <td><select data-f="type">${Object.keys(TASK_TYPE_LABELS).map(k => `<option value="${k}" ${t.type === k ? 'selected' : ''}>${TASK_TYPE_LABELS[k]}</option>`).join('')}</select></td>
        <td><select data-f="status">${Object.keys(TASK_STATUS_LABELS).map(k => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${TASK_STATUS_LABELS[k]}</option>`).join('')}</select></td>
        <td><select data-f="priority">${Object.keys(PRIORITY_LABELS).map(k => `<option value="${k}" ${t.priority === k ? 'selected' : ''}>${PRIORITY_LABELS[k]}</option>`).join('')}</select></td>
        <td><input data-f="owner" value="${esc(t.owner)}" placeholder="负责人"></td>
        <td><input data-f="dept" value="${esc(t.dept)}" placeholder="主责部门"></td>
        <td><input type="number" data-f="plannedHours" value="${esc(t.plannedHours)}" placeholder="人天" min="0" step="0.1"></td>
        <td><input type="number" data-f="progress" value="${esc(t.progress)}" placeholder="0-100" min="0" max="100"></td>
        <td><input type="text" class="pl-date" readonly placeholder="选择日期" data-f="startDate" value="${esc(t.startDate)}"></td>
        <td><input type="text" class="pl-date" readonly placeholder="选择日期" data-f="endDate" value="${esc(t.endDate)}"></td>
        <td><select data-f="parentId" class="pl-f-parent">${parentOptions(draft.tasks, t.id, t.parentId, '— 顶层 —')}</select></td>
        <td><input data-f="deps" value="${esc((t.dependencies || []).join(', '))}" placeholder="依赖任务WBS"></td>
        <td><button type="button" class="pl-row-del pl-del-task" data-del-task="${i}" title="删除（连带子任务）"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6.5 1.5h3a.5.5 0 0 1 .5.5v1H6V2a.5.5 0 0 1 .5-.5Zm-1.5 2V2A1.5 1.5 0 0 1 6.5.5h3A1.5 1.5 0 0 1 11 2v1.5h2.5a.5.5 0 0 1 0 1h-.53l-.6 8.4A2 2 0 0 1 10.38 15H5.62a2 2 0 0 1-1.99-1.85l-.6-8.4H2.5a.5.5 0 0 1 0-1H5Zm-.96 1 .59 8.33a1 1 0 0 0 1 .92h4.74a1 1 0 0 0 1-.92l.59-8.33H4.04ZM6.75 6a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/></svg></button></td>
      </tr>`;
    }).join('');
    return `<div class="table-wrapper pl-form-table-wrap"><table class="data-table pl-form-table"><thead><tr>
        <th style="min-width:58px">#</th><th class="txt" style="min-width:260px">任务名称</th><th>类型</th><th>状态</th><th>优先级</th>
        <th class="txt">负责人</th><th class="txt">主责部门</th><th style="min-width:70px">人天</th><th style="min-width:60px">进度%</th>
        <th class="txt">开始</th><th class="txt">结束</th><th class="txt" style="min-width:170px">父任务</th><th class="txt">依赖</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function renderFormResources(draft) {
    if (!draft.resources.length) {
      return `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">👥</div><p>暂无资源，点击「添加资源」</p></div>`;
    }
    const rows = draft.resources.map((r, i) => `
      <tr data-res-idx="${i}">
        ${DRAG_TD}
        <td><input data-f="name" value="${esc(r.name)}" placeholder="资源名"></td>
        <td><select data-f="kind">${Object.keys(RES_KIND_LABELS).map(k => `<option value="${k}" ${r.kind === k ? 'selected' : ''}>${RES_KIND_LABELS[k]}</option>`).join('')}</select></td>
        <td><input data-f="dept" value="${esc(r.dept)}" placeholder="部门"></td>
        <td><input type="number" data-f="total" value="${esc(r.total)}" placeholder="总容量(人天)" min="0" step="0.1"></td>
        <td><button type="button" class="pl-row-del pl-del-res" data-del-res="${i}" title="删除"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6.5 1.5h3a.5.5 0 0 1 .5.5v1H6V2a.5.5 0 0 1 .5-.5Zm-1.5 2V2A1.5 1.5 0 0 1 6.5.5h3A1.5 1.5 0 0 1 11 2v1.5h2.5a.5.5 0 0 1 0 1h-.53l-.6 8.4A2 2 0 0 1 10.38 15H5.62a2 2 0 0 1-1.99-1.85l-.6-8.4H2.5a.5.5 0 0 1 0-1H5Zm-.96 1 .59 8.33a1 1 0 0 0 1 .92h4.74a1 1 0 0 0 1-.92l.59-8.33H4.04ZM6.75 6a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/></svg></button></td>
      </tr>`);
    return `<div class="table-wrapper"><table class="data-table"><thead><tr>${DRAG_TH}<th class="txt">资源</th><th>类型</th><th class="txt">部门</th><th style="min-width:120px">总容量(人天)</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function renderFormMilestones(draft) {
    if (!draft.milestones.length) {
      return `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">🎯</div><p>暂无里程碑，点击「添加里程碑」</p></div>`;
    }
    const rows = draft.milestones.map((m, i) => `
      <tr data-ms-idx="${i}">
        ${DRAG_TD}
        <td><input data-f="name" value="${esc(m.name)}" placeholder="里程碑名称"></td>
        <td><input type="text" class="pl-date" readonly placeholder="选择日期" data-f="date" value="${esc(m.date)}"></td>
        <td><select data-f="status">${Object.keys(MILESTONE_STATUS_LABELS).map(k => `<option value="${k}" ${m.status === k ? 'selected' : ''}>${MILESTONE_STATUS_LABELS[k]}</option>`).join('')}</select></td>
        <td><input data-f="owner" value="${esc(m.owner)}" placeholder="负责人"></td>
        <td><input data-f="desc" value="${esc(m.desc)}" placeholder="说明"></td>
        <td><button type="button" class="pl-row-del pl-del-ms" data-del-ms="${i}" title="删除"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6.5 1.5h3a.5.5 0 0 1 .5.5v1H6V2a.5.5 0 0 1 .5-.5Zm-1.5 2V2A1.5 1.5 0 0 1 6.5.5h3A1.5 1.5 0 0 1 11 2v1.5h2.5a.5.5 0 0 1 0 1h-.53l-.6 8.4A2 2 0 0 1 10.38 15H5.62a2 2 0 0 1-1.99-1.85l-.6-8.4H2.5a.5.5 0 0 1 0-1H5Zm-.96 1 .59 8.33a1 1 0 0 0 1 .92h4.74a1 1 0 0 0 1-.92l.59-8.33H4.04ZM6.75 6a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/></svg></button></td>
      </tr>`);
    return `<div class="table-wrapper"><table class="data-table"><thead><tr>${DRAG_TH}<th class="txt" style="min-width:190px">里程碑</th><th class="txt">日期</th><th>状态</th><th class="txt">负责人</th><th class="txt">说明</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function renderFormMembers(draft) {
    if (!draft.members.length) {
      return `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">🧑‍🤝‍🧑</div><p>暂无团队成员，点击「添加成员」</p></div>`;
    }
    const rows = draft.members.map((m, i) => `
      <tr data-member-idx="${i}">
        ${DRAG_TD}
        <td><input data-f="name" value="${esc(m.name)}" placeholder="姓名"></td>
        <td><select data-f="role">${Object.keys(MEMBER_ROLE_LABELS).map(k => `<option value="${k}" ${m.role === k ? 'selected' : ''}>${MEMBER_ROLE_LABELS[k]}</option>`).join('')}</select></td>
        <td><input data-f="dept" value="${esc(m.dept)}" placeholder="部门/团队"></td>
        <td><input data-f="duty" value="${esc(m.duty)}" placeholder="职责分工"></td>
        <td><input data-f="contact" value="${esc(m.contact)}" placeholder="联系方式(可选)"></td>
        <td><button type="button" class="pl-row-del pl-del-member" data-del-member="${i}" title="删除"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6.5 1.5h3a.5.5 0 0 1 .5.5v1H6V2a.5.5 0 0 1 .5-.5Zm-1.5 2V2A1.5 1.5 0 0 1 6.5.5h3A1.5 1.5 0 0 1 11 2v1.5h2.5a.5.5 0 0 1 0 1h-.53l-.6 8.4A2 2 0 0 1 10.38 15H5.62a2 2 0 0 1-1.99-1.85l-.6-8.4H2.5a.5.5 0 0 1 0-1H5Zm-.96 1 .59 8.33a1 1 0 0 0 1 .92h4.74a1 1 0 0 0 1-.92l.59-8.33H4.04ZM6.75 6a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/></svg></button></td>
      </tr>`);
    return `<div class="table-wrapper"><table class="data-table"><thead><tr>${DRAG_TH}<th class="txt">姓名</th><th>角色</th><th class="txt">部门/团队</th><th class="txt" style="min-width:180px">职责分工</th><th class="txt" style="min-width:150px">联系方式</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function renderFormReferences(draft) {
    const list = draft.references || [];
    const rows = treeOrder(list).map(o => {
      const r = o.item, i = o.index, d = o.depth;
      return `
      <tr data-ref-idx="${i}" data-depth="${d}">
        <td class="pl-ov-seq pl-drag" tabindex="0" role="button" aria-label="拖动调整顺序与层级，或按 Alt 加方向键" title="${DRAG_TIP}">${o.code}</td>
        <td>${indWrap(d, `<input data-f="title" value="${esc(r.title)}" placeholder="${d ? '子项名称' : '交付产物'}"${d ? '' : ' style="font-weight:600"'}>`)}</td>
        <td><select data-f="stage">${Object.keys(REF_STAGE_LABELS).map(k => `<option value="${k}" ${r.stage === k ? 'selected' : ''}>${REF_STAGE_LABELS[k]}</option>`).join('')}</select></td>
        <td><input data-f="dept" value="${esc(r.dept)}" placeholder="责任部门/人"></td>
        <td><input data-f="owner" value="${esc(r.owner)}" placeholder="提交人员"></td>
        <td><input type="text" class="pl-date" readonly placeholder="选择日期" data-f="date" value="${esc(r.date)}"></td>
        <td><select data-f="status">${Object.keys(REF_DOC_STATUS_LABELS).map(k => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${REF_DOC_STATUS_LABELS[k]}</option>`).join('')}</select></td>
        <td><textarea data-f="requirement" rows="2" placeholder="评审要求（必选/可选及范围）">${esc(r.requirement)}</textarea></td>
        <td><input data-f="link" value="${esc(r.link)}" placeholder="模板/文档链接"></td>
        <td><select data-f="parentId">${parentOptions(list, r.id, r.parentId, '— 顶层 —')}</select></td>
        <td><button type="button" class="pl-row-del pl-del-ref" data-del-ref="${i}" title="删除（连带子项）"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6.5 1.5h3a.5.5 0 0 1 .5.5v1H6V2a.5.5 0 0 1 .5-.5Zm-1.5 2V2A1.5 1.5 0 0 1 6.5.5h3A1.5 1.5 0 0 1 11 2v1.5h2.5a.5.5 0 0 1 0 1h-.53l-.6 8.4A2 2 0 0 1 10.38 15H5.62a2 2 0 0 1-1.99-1.85l-.6-8.4H2.5a.5.5 0 0 1 0-1H5Zm-.96 1 .59 8.33a1 1 0 0 0 1 .92h4.74a1 1 0 0 0 1-.92l.59-8.33H4.04ZM6.75 6a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/></svg></button></td>
      </tr>`;
    }).join('');
    const table = list.length ? `
      <div class="table-wrapper pl-ref-table-wrap">
        <table class="data-table pl-ref-table">
          <thead><tr>
            <th style="min-width:58px">#</th>
            <th class="txt" style="min-width:260px">交付产物</th>
            <th style="min-width:88px">评审阶段</th>
            <th class="txt" style="min-width:130px">责任部门(人)</th>
            <th class="txt" style="min-width:110px">提交人员</th>
            <th class="txt" style="min-width:150px">提交日期</th>
            <th style="min-width:110px">状态</th>
            <th class="txt" style="min-width:200px">评审要求</th>
            <th class="txt" style="min-width:200px">模板链接</th>
            <th class="txt" style="min-width:170px">上级</th>
            <th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">📎</div><p>暂无交付件，点击「一键初始化标准交付件清单」按 VRC 流程生成，或「添加文档」自定义</p></div>`;
    return `
    <div class="cs-form-section">
      ${renderRpdCard(draft)}
      <div class="cs-form-section-head">
        <div class="cs-form-section-title">参考文档 / 交付件 <span class="pl-count-pill">${list.filter(r => !r.parentId).length} 项 / ${list.length} 行</span></div>
        <div class="pl-form-actions">
          <button type="button" class="btn pl-add-btn" id="plAddReference">＋ 添加文档</button>
          <button type="button" class="btn" id="plRefSeed">↻ 一键初始化标准交付件清单</button>
        </div>
      </div>
      <div class="pl-form-note">按评审阶段（TR2/TR3/TR4/TR5）梳理项目交付件：责任部门、提交人员、提交日期、状态、评审要求与模板链接。<b>支持无限层级</b>（如「立项材料」下挂汇报材料/会议纪要）。模板为 VRC 版本常用清单，可自由增删改。</div>
      ${table}
    </div>`;
  }

  // RPD 规范文档模板库入口卡片（链接内置为部门级常量，无需逐个项目填写）
  function renderRpdCard(draft) {
    const url = rpdUrlOf(draft);
    return `
    <div class="pl-rpd-card">
      <div class="pl-rpd-main">
        <span class="pl-rpd-ic">📚</span>
        <div class="pl-rpd-text">
          <h4>RPD 规范文档模板库</h4>
          <p>${url
            ? '部门内部项目文档模板与规范知识库，团队可直接查阅各交付件的标准模板样式。'
            : '尚未配置知识库链接。打开本机 <code>data/plan/config.json</code>，把链接填到 <code>rpdTemplateUrl</code> 后刷新页面即可（该文件已 gitignore，不会提交、也不会与拉取代码冲突）。'}</p>
        </div>
      </div>
      <div class="pl-rpd-actions">
        <button type="button" class="btn primary" id="plRpdOpen" ${url ? '' : 'disabled'}>打开模板库 ↗</button>
      </div>
    </div>`;
  }

  /* ---------- 表单 Tab 定义 ---------- */
  const FORM_TABS = [
    { key: 'basic', label: '基本信息', icon: '📝' },
    { key: 'overview', label: '项目总览', icon: '📋' },
    { key: 'milestone', label: '里程碑', icon: '🎯' },
    { key: 'wbs', label: 'WBS任务', icon: '🌳' },
    { key: 'market', label: '上市计划', icon: '🚀' },
    { key: 'issue', label: '遗留问题', icon: '📌' },
    { key: 'risk', label: '项目风险', icon: '⚠️' },
    { key: 'resource', label: '资源', icon: '👥' },
    { key: 'member', label: '团队成员', icon: '🧑‍🤝‍🧑' },
    { key: 'reference', label: '参考文档', icon: '📎' }
  ];
  function buildFormTabs() {
    return `<div class="pl-form-topnav">${FORM_TABS.map(t =>
      `<button type="button" class="cs-tab pl-form-tab ${currentFormTab === t.key ? 'active' : ''}" data-form-tab="${t.key}"><span class="cs-tab-icon">${t.icon}</span>${t.label}</button>`
    ).join('')}</div>`;
  }

  /* ---------- 各表单 Tab 内容 ---------- */
  function renderFormBasic(draft) {
    return `
    <div class="cs-form-section">
      <div class="cs-form-grid">
        <div class="cs-field"><label>计划名称 <span class="req">*</span></label><input type="text" data-f="name" value="${esc(draft.name)}" placeholder="如：2026 阳光云平台迭代计划"></div>
        <div class="cs-field"><label>年度</label><input type="number" data-f="year" value="${esc(draft.year)}" min="2020" max="2100"></div>
        <div class="cs-field"><label>状态</label><select data-f="status">${Object.keys(PLAN_STATUS_LABELS).map(k => `<option value="${k}" ${draft.status === k ? 'selected' : ''}>${PLAN_STATUS_LABELS[k]}</option>`).join('')}</select></div>
        <div class="cs-field"><label>负责人</label><input type="text" data-f="owner" value="${esc(draft.owner)}" placeholder="计划负责人"></div>
        <div class="cs-field"><label>项目 ID</label><input type="text" data-f="projectId" value="${esc(draft.projectId)}" placeholder="关联项目ID（可选）"></div>
        <div class="cs-field"><label>项目名称</label><input type="text" data-f="projectName" value="${esc(draft.projectName)}" placeholder="关联项目名称（可选）"></div>
        <div class="cs-field"><label>计划开始</label><input type="text" class="pl-date" readonly placeholder="选择日期" data-f="startDate" value="${esc(draft.startDate)}"></div>
        <div class="cs-field"><label>计划结束</label><input type="text" class="pl-date" readonly placeholder="选择日期" data-f="endDate" value="${esc(draft.endDate)}"></div>
        <div class="cs-field cs-field-wide"><label>计划描述 / 目标</label><textarea data-f="description" rows="3" placeholder="描述计划目标、范围、验收标准">${esc(draft.description)}</textarea></div>
      </div>
    </div>`;
  }

  // 项目总览（表单内）：标准 8 阶段大纲，支持无限层级（1 / 1.1 / 1.1.1 …）
  function renderFormOverview(draft) {
    const stages = draft.overview || [];
    const rows = treeOrder(stages).map(o => {
      const s = o.item, i = o.index, d = o.depth;
      return `
      <tr data-ov-idx="${i}" data-depth="${d}">
        <td class="pl-ov-seq pl-drag" tabindex="0" role="button" aria-label="拖动调整顺序与层级，或按 Alt 加方向键" title="${DRAG_TIP}">${o.code}</td>
        <td>${indWrap(d, `<input data-f="name" value="${esc(s.name)}" placeholder="${d ? '子项名称' : '阶段名称'}"${d ? '' : ' style="font-weight:600"'}>`)}</td>
        <td><input data-f="owner" value="${esc(s.owner)}" placeholder="负责人"></td>
        <td><input type="text" class="pl-date" readonly placeholder="选择日期" data-f="startDate" value="${esc(s.startDate)}"></td>
        <td><input type="text" class="pl-date" readonly placeholder="选择日期" data-f="endDate" value="${esc(s.endDate)}"></td>
        <td><select data-f="status">${Object.keys(TASK_STATUS_LABELS).map(k => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${TASK_STATUS_LABELS[k]}</option>`).join('')}</select></td>
        <td><input type="number" data-f="progress" value="${esc(s.progress)}" min="0" max="100" placeholder="0-100"></td>
        <td><input data-f="deliverable" value="${esc(s.deliverable)}" placeholder="交付物"></td>
        <td><input data-f="note" value="${esc(s.note)}" placeholder="备注"></td>
        <td><select data-f="parentId" class="pl-f-parent">${parentOptions(stages, s.id, s.parentId, '— 顶层阶段 —')}</select></td>
        <td><button type="button" class="pl-row-del pl-del-ov" data-del-ov="${i}" title="删除（连带子项）"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6.5 1.5h3a.5.5 0 0 1 .5.5v1H6V2a.5.5 0 0 1 .5-.5Zm-1.5 2V2A1.5 1.5 0 0 1 6.5.5h3A1.5 1.5 0 0 1 11 2v1.5h2.5a.5.5 0 0 1 0 1h-.53l-.6 8.4A2 2 0 0 1 10.38 15H5.62a2 2 0 0 1-1.99-1.85l-.6-8.4H2.5a.5.5 0 0 1 0-1H5Zm-.96 1 .59 8.33a1 1 0 0 0 1 .92h4.74a1 1 0 0 0 1-.92l.59-8.33H4.04ZM6.75 6a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/></svg></button></td>
      </tr>`;
    }).join('');
    const body = stages.length ? `
      <div class="table-wrapper pl-ov-table-wrap">
        <table class="data-table pl-ov-table">
          <thead><tr>
            <th style="min-width:58px">#</th><th class="txt" style="min-width:260px">阶段 / 子项</th><th class="txt">负责人</th>
            <th class="txt">开始</th><th class="txt">结束</th><th>状态</th><th style="min-width:70px">进度%</th>
            <th class="txt" style="min-width:150px">交付物</th><th class="txt" style="min-width:140px">备注</th>
            <th class="txt" style="min-width:170px">上级</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">📋</div><p>暂无阶段，点击「重置为标准 8 阶段」生成</p></div>`;
    return `
    <div class="cs-form-section">
      <div class="cs-form-section-head">
        <div class="cs-form-section-title">项目总览 <span class="pl-count-pill">${stages.filter(s => !s.parentId).length} 阶段 / ${stages.length} 行</span></div>
        <div class="pl-form-actions">
          <button type="button" class="btn pl-add-btn" id="plAddStage">＋ 添加阶段</button>
          <button type="button" class="btn" id="plOvReset">↻ 重置为标准 8 阶段</button>
        </div>
      </div>
      <div class="pl-form-note">项目级大纲：默认标准 8 阶段（测试计划内置 6 条子流程）。<b>支持无限层级</b>——用「上级」下拉把任意行挂到别的行下面，可形成 1 / 1.1 / 1.1.1 …；删除某行会连带删除其子项。</div>
      ${body}
    </div>`;
  }

  // WBS 任务（表单内）：含「从需求清单导入」次要入口
  function renderFormWbs(draft) {
    return `
    <div class="cs-form-section">
      <div class="cs-form-section-head">
        <div class="cs-form-section-title">WBS 任务 <span class="pl-count-pill">${draft.tasks.length} 项</span></div>
        <div class="pl-form-actions">
          <button type="button" class="btn pl-import-btn" id="plImportReq">📥 从需求清单导入</button>
          <button type="button" class="btn pl-add-btn" id="plAddTask">＋ 添加任务</button>
        </div>
      </div>
      <div class="pl-form-note">详细任务分解。可手动逐条添加，或「从需求清单导入」批量生成（追加，不覆盖）。父任务、依赖用于生成树与甘特。</div>
      ${renderFormTasks(draft)}
    </div>`;
  }

  function renderFormMilestoneTab(draft) {
    return `
    <div class="cs-form-section">
      <div class="cs-form-section-head">
        <div class="cs-form-section-title">里程碑 <span class="pl-count-pill">${draft.milestones.length} 项</span></div>
        <div class="pl-form-actions"><button type="button" class="btn pl-add-btn" id="plAddMilestone">＋ 添加里程碑</button></div>
      </div>
      ${renderFormMilestones(draft)}
    </div>`;
  }
  function renderFormResourceTab(draft) {
    return `
    <div class="cs-form-section">
      <div class="cs-form-section-head">
        <div class="cs-form-section-title">资源 <span class="pl-count-pill">${draft.resources.length} 项</span></div>
        <div class="pl-form-actions"><button type="button" class="btn pl-add-btn" id="plAddResource">＋ 添加资源</button></div>
      </div>
      ${renderFormResources(draft)}
    </div>`;
  }
  function renderFormMemberTab(draft) {
    return `
    <div class="cs-form-section">
      <div class="cs-form-section-head">
        <div class="cs-form-section-title">团队成员 <span class="pl-count-pill">${draft.members.length} 人</span></div>
        <div class="pl-form-actions"><button type="button" class="btn pl-add-btn" id="plAddMember">＋ 添加成员</button></div>
      </div>
      <div class="pl-form-note">登记项目关键角色与职责分工（产品经理 / 系统经理 / 项目经理 / 研发 / 测试等），便于责任到人。</div>
      ${renderFormMembers(draft)}
    </div>`;
  }
  /* 参考文档 Tab 直接由 renderFormReferences 输出完整分区（含 RPD 卡片与操作条），无需再包一层 */
  /* ---------- 遗留问题 Tab ---------- */
  function renderFormIssues(draft) {
    const list = draft.issues || [];
    const body = list.length ? `
      <div class="table-wrapper pl-issue-table-wrap">
        <table class="data-table pl-issue-table">
          <thead><tr>
            ${DRAG_TH}
            <th style="min-width:72px">问题编号</th>
            <th class="txt" style="min-width:220px">遗留问题描述</th>
            <th class="txt" style="min-width:200px">应对方案</th>
            <th class="txt" style="min-width:100px">责任人</th>
            <th class="txt" style="min-width:150px">预计闭环时间</th>
            <th class="txt" style="min-width:180px">当前进展</th>
            <th class="txt" style="min-width:180px">结论</th>
            <th style="min-width:110px">当前状态</th>
            <th></th>
          </tr></thead>
          <tbody>${list.map((x, i) => `
            <tr data-issue-idx="${i}">
              ${DRAG_TD}
              <td><input data-f="code" value="${esc(x.code)}" placeholder="${i + 1}"></td>
              <td><textarea data-f="desc" rows="2" placeholder="问题描述">${esc(x.desc)}</textarea></td>
              <td><textarea data-f="solution" rows="2" placeholder="应对方案">${esc(x.solution)}</textarea></td>
              <td><input data-f="owner" value="${esc(x.owner)}" placeholder="责任人"></td>
              <td><input type="text" class="pl-date" readonly placeholder="选择日期" data-f="dueDate" value="${esc(x.dueDate)}"></td>
              <td><textarea data-f="progress" rows="2" placeholder="当前进展">${esc(x.progress)}</textarea></td>
              <td><textarea data-f="conclusion" rows="2" placeholder="结论">${esc(x.conclusion)}</textarea></td>
              <td><select data-f="status">${Object.keys(ISSUE_STATUS_LABELS).map(k => `<option value="${k}" ${x.status === k ? 'selected' : ''}>${ISSUE_STATUS_LABELS[k]}</option>`).join('')}</select></td>
              <td><button type="button" class="pl-row-del pl-del-issue" data-del-issue="${i}" title="删除"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6.5 1.5h3a.5.5 0 0 1 .5.5v1H6V2a.5.5 0 0 1 .5-.5Zm-1.5 2V2A1.5 1.5 0 0 1 6.5.5h3A1.5 1.5 0 0 1 11 2v1.5h2.5a.5.5 0 0 1 0 1h-.53l-.6 8.4A2 2 0 0 1 10.38 15H5.62a2 2 0 0 1-1.99-1.85l-.6-8.4H2.5a.5.5 0 0 1 0-1H5Zm-.96 1 .59 8.33a1 1 0 0 0 1 .92h4.74a1 1 0 0 0 1-.92l.59-8.33H4.04ZM6.75 6a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/></svg></button></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>` : `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">📌</div><p>暂无遗留问题，点击「添加问题」</p></div>`;
    return `
    <div class="cs-form-section">
      <div class="cs-form-section-head">
        <div class="cs-form-section-title">遗留问题 <span class="pl-count-pill">${list.length} 项</span></div>
        <div class="pl-form-actions"><button type="button" class="btn pl-add-btn" id="plAddIssue">＋ 添加问题</button></div>
      </div>
      <div class="pl-form-note">记录项目推进中的遗留问题与闭环情况：问题描述、应对方案、责任人、预计闭环时间、当前进展、结论与状态。</div>
      ${body}
    </div>`;
  }

  /* ---------- 项目风险 Tab ---------- */
  function renderFormRisks(draft) {
    const list = draft.risks || [];
    const body = list.length ? `
      <div class="table-wrapper pl-risk-table-wrap">
        <table class="data-table pl-risk-table">
          <thead><tr>
            ${DRAG_TH}
            <th style="min-width:110px">风险类型</th>
            <th class="txt" style="min-width:230px">风险描述</th>
            <th class="txt" style="min-width:210px">应对方案</th>
            <th class="txt" style="min-width:100px">责任人</th>
            <th class="txt" style="min-width:150px">计划闭环时间</th>
            <th style="min-width:110px">风险状态</th>
            <th class="txt" style="min-width:180px">进展状态</th>
            <th></th>
          </tr></thead>
          <tbody>${list.map((x, i) => `
            <tr data-risk-idx="${i}">
              ${DRAG_TD}
              <td><select data-f="type">${Object.keys(RISK_TYPE_LABELS).map(k => `<option value="${k}" ${x.type === k ? 'selected' : ''}>${RISK_TYPE_LABELS[k]}</option>`).join('')}</select></td>
              <td><textarea data-f="desc" rows="2" placeholder="风险描述">${esc(x.desc)}</textarea></td>
              <td><textarea data-f="solution" rows="2" placeholder="应对方案">${esc(x.solution)}</textarea></td>
              <td><input data-f="owner" value="${esc(x.owner)}" placeholder="责任人"></td>
              <td><input type="text" class="pl-date" readonly placeholder="选择日期" data-f="dueDate" value="${esc(x.dueDate)}"></td>
              <td><select data-f="status">${Object.keys(RISK_STATUS_LABELS).map(k => `<option value="${k}" ${x.status === k ? 'selected' : ''}>${RISK_STATUS_LABELS[k]}</option>`).join('')}</select></td>
              <td><textarea data-f="progress" rows="2" placeholder="进展状态">${esc(x.progress)}</textarea></td>
              <td><button type="button" class="pl-row-del pl-del-risk" data-del-risk="${i}" title="删除"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6.5 1.5h3a.5.5 0 0 1 .5.5v1H6V2a.5.5 0 0 1 .5-.5Zm-1.5 2V2A1.5 1.5 0 0 1 6.5.5h3A1.5 1.5 0 0 1 11 2v1.5h2.5a.5.5 0 0 1 0 1h-.53l-.6 8.4A2 2 0 0 1 10.38 15H5.62a2 2 0 0 1-1.99-1.85l-.6-8.4H2.5a.5.5 0 0 1 0-1H5Zm-.96 1 .59 8.33a1 1 0 0 0 1 .92h4.74a1 1 0 0 0 1-.92l.59-8.33H4.04ZM6.75 6a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/></svg></button></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>` : `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">⚠️</div><p>暂无项目风险，点击「添加风险」</p></div>`;
    return `
    <div class="cs-form-section">
      <div class="cs-form-section-head">
        <div class="cs-form-section-title">项目风险 <span class="pl-count-pill">${list.length} 项</span></div>
        <div class="pl-form-actions"><button type="button" class="btn pl-add-btn" id="plAddRisk">＋ 添加风险</button></div>
      </div>
      <div class="pl-form-note">识别与跟踪项目风险：按类型（技术/市场/质量/进度/资源/其他）登记描述、应对方案、责任人、计划闭环时间与状态。</div>
      ${body}
    </div>`;
  }

  /* ---------- 上市计划 Tab（树形：阶段 + 子任务） ---------- */
  function renderFormMarket(draft) {
    const list = draft.marketPlan || [];
    const body = list.length ? `
      <div class="table-wrapper pl-market-table-wrap">
        <table class="data-table pl-market-table">
          <thead><tr>
            <th style="min-width:52px">#</th>
            <th class="txt" style="min-width:260px">任务</th>
            <th class="txt" style="min-width:150px">计划开始时间</th>
            <th class="txt" style="min-width:150px">计划结束时间</th>
            <th class="txt" style="min-width:110px">任务执行人</th>
            <th style="min-width:110px">状态</th>
            <th class="txt" style="min-width:170px">备注</th>
            <th class="txt" style="min-width:150px">所属阶段</th>
            <th></th>
          </tr></thead>
          <tbody>${treeOrder(list).map(o => {
            const x = o.item, i = o.index, d = o.depth;
            return `
            <tr data-market-idx="${i}" data-depth="${d}">
              <td class="pl-ov-seq pl-drag" tabindex="0" role="button" aria-label="拖动调整顺序与层级，或按 Alt 加方向键" title="${DRAG_TIP}">${o.code}</td>
              <td>${indWrap(d, `<input data-f="name" value="${esc(x.name)}" placeholder="${d ? '子任务名称' : '阶段名称'}"${d ? '' : ' style="font-weight:600"'}>`)}</td>
              <td><input type="text" class="pl-date" readonly placeholder="选择日期" data-f="startDate" value="${esc(x.startDate)}"></td>
              <td><input type="text" class="pl-date" readonly placeholder="选择日期" data-f="endDate" value="${esc(x.endDate)}"></td>
              <td><input data-f="owner" value="${esc(x.owner)}" placeholder="执行人"></td>
              <td><select data-f="status">${Object.keys(TASK_STATUS_LABELS).map(k => `<option value="${k}" ${x.status === k ? 'selected' : ''}>${TASK_STATUS_LABELS[k]}</option>`).join('')}</select></td>
              <td><input data-f="note" value="${esc(x.note)}" placeholder="备注"></td>
              <td><select data-f="parentId">${parentOptions(list, x.id, x.parentId, '— 阶段(顶层) —')}</select></td>
              <td><button type="button" class="pl-row-del pl-del-market" data-del-market="${i}" title="删除（连带子项）"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6.5 1.5h3a.5.5 0 0 1 .5.5v1H6V2a.5.5 0 0 1 .5-.5Zm-1.5 2V2A1.5 1.5 0 0 1 6.5.5h3A1.5 1.5 0 0 1 11 2v1.5h2.5a.5.5 0 0 1 0 1h-.53l-.6 8.4A2 2 0 0 1 10.38 15H5.62a2 2 0 0 1-1.99-1.85l-.6-8.4H2.5a.5.5 0 0 1 0-1H5Zm-.96 1 .59 8.33a1 1 0 0 0 1 .92h4.74a1 1 0 0 0 1-.92l.59-8.33H4.04ZM6.75 6a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/></svg></button></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>` : `<div class="pl-empty pl-empty-sm"><div class="pl-empty-ic">🚀</div><p>暂无上市计划，点击「一键初始化标准上市计划」或「添加任务」</p></div>`;
    return `
    <div class="cs-form-section">
      <div class="cs-form-section-head">
        <div class="cs-form-section-title">上市计划 <span class="pl-count-pill">${list.filter(x => !x.parentId).length} 阶段 / ${list.length} 行</span></div>
        <div class="pl-form-actions">
          <button type="button" class="btn pl-add-btn" id="plAddMarket">＋ 添加任务</button>
          <button type="button" class="btn" id="plMarketSeed">↻ 一键初始化标准上市计划</button>
        </div>
      </div>
      <div class="pl-form-note">上市全流程阶段化管理：上市策略 → 上市计划 → 上市准备 → 产品试销 → 产品上线。<b>支持无限层级</b>——用「所属阶段」把任务挂到任意行下面；删除某行会连带删除其子项。</div>
      ${body}
    </div>`;
  }

  // 二阶段占位 Tab
  function renderFormPlaceholder(title, icon, desc) {
    return `
    <div class="cs-form-section">
      <div class="pl-placeholder">
        <div class="pl-placeholder-ic">${icon}</div>
        <h4>${esc(title)}</h4>
        <p>${esc(desc)}</p>
        <span class="pl-chip">二阶段设计中</span>
      </div>
    </div>`;
  }

  // 渲染当前 form tab 的内容体
  function renderFormTabBodyHtml(draft) {
    switch (currentFormTab) {
      case 'basic': return renderFormBasic(draft);
      case 'overview': return renderFormOverview(draft);
      case 'milestone': return renderFormMilestoneTab(draft);
      case 'wbs': return renderFormWbs(draft);
      case 'market': return renderFormMarket(draft);
      case 'issue': return renderFormIssues(draft);
      case 'risk': return renderFormRisks(draft);
      case 'resource': return renderFormResourceTab(draft);
      case 'member': return renderFormMemberTab(draft);
      case 'reference': return renderFormReferences(draft);
      default: return renderFormBasic(draft);
    }
  }

  /* ---------- 从需求清单导入 WBS（灵活版：粘贴/上传，智能识别一二级，追加不覆盖） ---------- */
  // 解析需求清单文本 → [{name, parent}]，支持「父<TAB>子」或缩进/编号表示层级
  function parseRequirementText(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
    const items = [];
    let lastTop = null;
    lines.forEach(raw => {
      // 识别「父\t子」或「父,子」两列（制表符/多空格/逗号分隔且第一列非空）
      const tabM = raw.split(/\t|，|,|\s{2,}/).map(s => s.trim()).filter(Boolean);
      const indented = /^\s+|^[·•\-*]/.test(raw) || /^\s*\d+\.\d+/.test(raw); // 缩进/子项符号/1.1 编号 → 子任务
      const clean = (s) => s.replace(/^\s*(\d+(\.\d+)*\s*[.、)．]\s*|[·•\-*]\s*)/, '').trim();
      if (tabM.length >= 2) {
        const parent = clean(tabM[0]);
        const child = clean(tabM.slice(1).join(' '));
        if (parent) { if (!items.find(x => x.name === parent && !x.parent)) items.push({ name: parent, parent: null }); lastTop = parent; }
        if (child) items.push({ name: child, parent: parent || lastTop });
      } else {
        const name = clean(raw);
        if (!name) return;
        if (indented && lastTop) items.push({ name, parent: lastTop });
        else { items.push({ name, parent: null }); lastTop = name; }
      }
    });
    return items;
  }
  // 把解析结果追加为 tasks（建立父子 parentId）
  function appendRequirementTasks(items) {
    const nameToId = {};
    // 先建一级，拿到 id 供子级挂靠
    items.filter(it => !it.parent).forEach(it => {
      const t = blankTask(); t.name = it.name; t.parentId = ''; dirtyForm.tasks.push(t); nameToId[it.name] = t.id;
    });
    items.filter(it => it.parent).forEach(it => {
      const t = blankTask(); t.name = it.name;
      t.parentId = nameToId[it.parent] || '';
      dirtyForm.tasks.push(t);
    });
  }
  function openRequirementImport() {
    const body = `
      <div class="pl-decompose">
        <p class="pl-dec-desc">粘贴需求清单（一行一条），或上传 .txt / .csv / .xlsx。系统智能识别层级：<b>「父&lt;Tab&gt;子」或两列</b>→ 一二级任务；<b>缩进/1.1 编号/项目符号</b>→ 子任务；识别不出则全部作为一级任务。生成后<b>追加</b>到 WBS，不覆盖已有，可继续手动增删改。需求清单非必须。</p>
        <div class="pl-dec-toolbar">
          <label class="pl-dec-upload btn">📎 上传文件<input type="file" id="plReqFile" accept=".txt,.csv,.xlsx,.xls" hidden></label>
          <span class="pl-dec-filehint" id="plReqFileHint"></span>
        </div>
        <textarea id="plReqInput" class="pl-dec-input" rows="9" placeholder="示例（一级）：&#10;开放平台与集成&#10;智能体配置平台&#10;&#10;示例（两列，父&lt;Tab&gt;子）：&#10;研发计划&#9;开放平台与集成&#10;研发计划&#9;记忆库管理"></textarea>
        <div class="pl-dec-preview" id="plReqPreview"></div>
      </div>`;
    SharedUI.confirm('从需求清单导入 WBS', body, () => {
      const input = document.getElementById('plReqInput');
      const items = parseRequirementText(input ? input.value : '');
      if (!items.length) { SharedUI.toast('未解析到需求条目', 'warning'); return; }
      appendRequirementTasks(items);
      renderFormTabBody();
      const tops = items.filter(i => !i.parent).length, subs = items.length - tops;
      SharedUI.toast(`已追加 ${items.length} 个任务（${tops} 个一级${subs ? `、${subs} 个子任务` : ''}）`, 'success');
    }, { confirmText: '解析并追加', cancelText: '取消' });

    setTimeout(() => {
      const fileEl = document.getElementById('plReqFile');
      const hint = document.getElementById('plReqFileHint');
      const input = document.getElementById('plReqInput');
      const preview = document.getElementById('plReqPreview');
      const refresh = () => {
        if (!preview) return;
        const items = parseRequirementText(input ? input.value : '');
        const tops = items.filter(i => !i.parent).length, subs = items.length - tops;
        preview.innerHTML = `<div class="pl-dec-preview-head">预览：将追加 <b>${items.length}</b> 个任务（${tops} 一级 / ${subs} 子任务）</div>`;
      };
      if (input) input.addEventListener('input', refresh);
      if (fileEl) fileEl.addEventListener('change', () => {
        const f = fileEl.files && fileEl.files[0];
        if (!f) return;
        if (hint) hint.textContent = '解析中…';
        parseRequirementFileToText(f, (text) => { if (input) { input.value = text; refresh(); } if (hint) hint.textContent = `✓ 已解析 ${f.name}，请核对后追加`; },
          (err) => { if (hint) hint.textContent = '✗ ' + err.message; });
      });
      refresh();
    }, 0);
  }
  // 文件 → 文本（.txt/.csv 直读；.xlsx 用 SheetJS：优先取前两列拼成「父\t子」，否则第一列）
  function parseRequirementFileToText(file, onDone, onError) {
    const name = (file.name || '').toLowerCase();
    if (/\.(txt|csv)$/.test(name)) {
      const reader = new FileReader();
      reader.onerror = () => onError(new Error('文件读取失败'));
      reader.onload = e => {
        let text = String(e.target.result || '');
        if (/\.csv$/.test(name)) text = text.split(/\r?\n/).map(line => line.split(',').map(s => s.replace(/^"|"$/g, '').trim()).filter(Boolean).join('\t')).join('\n');
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
          const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
          // 跳过疑似表头行（含"需求/功能/标题/任务/编号"），其余行取前两个非空列拼 \t
          const lines = [];
          aoa.forEach((row, i) => {
            const cells = (row || []).map(c => String(c == null ? '' : c).trim());
            if (i === 0 && cells.join('').match(/需求|功能|标题|任务|编号|清单/)) return;
            const nonEmpty = cells.filter(Boolean);
            if (nonEmpty.length) lines.push(nonEmpty.slice(0, 2).join('\t'));
          });
          onDone(lines.join('\n'));
        } catch (err) { onError(new Error('Excel 解析失败：' + err.message)); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      onError(new Error('暂支持 .txt / .csv / .xlsx，其他请粘贴文本'));
    }
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
      ${buildFormTabs()}
      <div class="cs-form-body">
        <div class="cs-form pl-form-tab-body">${renderFormTabBodyHtml(draft)}</div>
        <div class="pl-form-tab-foot">
          <button type="button" class="btn" id="plStashTab">暂存本页</button>
          <button type="button" class="btn primary" id="plFormSave2">💾 保存计划</button>
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
    // 项目总览阶段表
    const ovRows = el.querySelectorAll('tr[data-ov-idx]');
    ovRows.forEach(row => {
      const idx = Number(row.getAttribute('data-ov-idx'));
      const s = dirtyForm.overview[idx];
      if (!s) return;
      row.querySelectorAll('[data-f]').forEach(inp => {
        const f = inp.getAttribute('data-f');
        if (f === 'progress') { s.progress = inp.value === '' ? 0 : Math.max(0, Math.min(100, Number(inp.value))); return; }
        s[f] = inp.value;
      });
    });
    // 遗留问题表
    el.querySelectorAll('tr[data-issue-idx]').forEach(row => {
      const x = dirtyForm.issues[Number(row.getAttribute('data-issue-idx'))];
      if (!x) return;
      row.querySelectorAll('[data-f]').forEach(inp => { x[inp.getAttribute('data-f')] = inp.value; });
    });
    // 项目风险表
    el.querySelectorAll('tr[data-risk-idx]').forEach(row => {
      const x = dirtyForm.risks[Number(row.getAttribute('data-risk-idx'))];
      if (!x) return;
      row.querySelectorAll('[data-f]').forEach(inp => { x[inp.getAttribute('data-f')] = inp.value; });
    });
    // 上市计划表
    el.querySelectorAll('tr[data-market-idx]').forEach(row => {
      const x = dirtyForm.marketPlan[Number(row.getAttribute('data-market-idx'))];
      if (!x) return;
      row.querySelectorAll('[data-f]').forEach(inp => { x[inp.getAttribute('data-f')] = inp.value; });
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
      ...r, title: String(r.title).trim(), type: r.type || 'other',
      parentId: r.parentId || '', stage: r.stage || 'other', status: r.status || 'pending'
    }));
    const plan = {
      id: dirtyForm.id, name: String(dirtyForm.name).trim(), year: Number(dirtyForm.year) || new Date().getFullYear(),
      status: dirtyForm.status || 'draft', owner: dirtyForm.owner || '', projectId: dirtyForm.projectId || '',
      projectName: dirtyForm.projectName || '', startDate: dirtyForm.startDate || '', endDate: dirtyForm.endDate || '',
      description: dirtyForm.description || '',
      rpdTemplateUrl: dirtyForm.rpdTemplateUrl || '',
      overview: (dirtyForm.overview || []).filter(s => s.name && String(s.name).trim()).map(s => ({
        ...s, name: String(s.name).trim(), progress: Math.max(0, Math.min(100, Math.round(num(s.progress)))), status: s.status || 'not-started', parentId: s.parentId || ''
      })),
      // 上市计划 / 遗留问题 / 项目风险：过滤空行并归一枚举
      marketPlan: (dirtyForm.marketPlan || []).filter(x => x.name && String(x.name).trim()).map(x => ({
        ...x, name: String(x.name).trim(), status: x.status || 'not-started', parentId: x.parentId || ''
      })),
      issues: (dirtyForm.issues || []).filter(x => (x.desc && String(x.desc).trim()) || (x.code && String(x.code).trim())).map(x => ({
        ...x, desc: String(x.desc || '').trim(), status: x.status || 'pending'
      })),
      risks: (dirtyForm.risks || []).filter(x => x.desc && String(x.desc).trim()).map(x => ({
        ...x, desc: String(x.desc).trim(), type: x.type || 'other', status: x.status || 'occurring'
      })),
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
      await Promise.all([fetchState(), fetchSummary()]);
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
    syncSidebarByCrowding();
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
      case 'overview': tabHtml = renderOverviewTab(plan); break;
      case 'wbs': tabHtml = renderWbsTab(plan); break;
      case 'gantt': tabHtml = renderGanttTab(plan); break;
      case 'milestone': tabHtml = renderMilestoneTab(plan); break;
      case 'resource': tabHtml = renderResourceTab(plan); break;
      case 'exec': tabHtml = renderExecView(plan, msum); break;
      case 'ai': tabHtml = renderAiTab(plan); break;
      default: tabHtml = renderOverviewTab(plan);
    }
    const tbody = el.querySelector('.pl-tab-body');
    if (tbody) tbody.innerHTML = tabHtml;
    bindTabEvents(); // 只重绑 tab body 内的 toggle / 事件，避免整视图重复绑定
    syncSidebarByCrowding();
  }

  /* ==========================================================
     轻量日期选择器（零依赖，替代原生 input[type=date] 的默认样式）
     结构：顶部当前值 → 月份导航 → 周一起始的日网格 → 清除/确定
     用法：任意 <input class="pl-date" readonly> 点击即弹出
     ========================================================== */
  const DP_WEEK = ['一', '二', '三', '四', '五', '六', '日'];
  const DP_MONTH = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  let dpPanel = null;      // 面板 DOM（懒创建、全局复用）
  let dpInput = null;      // 当前关联的输入框
  let dpViewY = 0, dpViewM = 0;  // 当前浏览的年/月
  let dpTemp = '';         // 待确认的选中值（YYYY-MM-DD）

  function dpFmt(y, m, d) {
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  function dpParse(v) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(v || '').trim());
    if (!m) return null;
    return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
  }
  function ensureDpPanel() {
    if (dpPanel) return dpPanel;
    dpPanel = document.createElement('div');
    dpPanel.className = 'pl-dp';
    dpPanel.setAttribute('role', 'dialog');
    document.body.appendChild(dpPanel);
    // 面板内交互（事件委托，面板整体复用）
    dpPanel.addEventListener('mousedown', (e) => e.preventDefault()); // 防止输入框失焦导致面板先关
    dpPanel.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-dp-nav]');
      if (nav) {
        const step = Number(nav.getAttribute('data-dp-nav'));
        dpViewM += step;
        if (dpViewM < 0) { dpViewM = 11; dpViewY--; }
        else if (dpViewM > 11) { dpViewM = 0; dpViewY++; }
        renderDpPanel();
        return;
      }
      const day = e.target.closest('[data-dp-day]');
      if (day) {
        dpTemp = day.getAttribute('data-dp-day');
        renderDpPanel();
        return;
      }
      if (e.target.closest('[data-dp-clear]')) { dpCommit(''); return; }
      if (e.target.closest('[data-dp-ok]')) { dpCommit(dpTemp); return; }
    });
    return dpPanel;
  }
  function renderDpPanel() {
    const first = new Date(dpViewY, dpViewM, 1);
    const offset = (first.getDay() + 6) % 7;           // 周一为一周起点
    const start = new Date(dpViewY, dpViewM, 1 - offset);
    const todayStr = (() => { const n = new Date(); return dpFmt(n.getFullYear(), n.getMonth(), n.getDate()); })();
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const val = dpFmt(d.getFullYear(), d.getMonth(), d.getDate());
      const outside = d.getMonth() !== dpViewM;
      const cls = ['pl-dp-day'];
      if (outside) cls.push('outside');
      if (val === dpTemp) cls.push('selected');
      if (val === todayStr) cls.push('today');
      cells += `<button type="button" class="${cls.join(' ')}" data-dp-day="${val}">${d.getDate()}</button>`;
      // 满 6 行即止；若第 5 行已覆盖整月则提前结束，避免空行
      if (i === 34 && new Date(start.getFullYear(), start.getMonth(), start.getDate() + 35).getMonth() !== dpViewM) break;
    }
    dpPanel.innerHTML = `
      <div class="pl-dp-value">${esc(dpTemp || '未选择日期')}</div>
      <div class="pl-dp-head">
        <button type="button" class="pl-dp-nav" data-dp-nav="-1" title="上一月">‹</button>
        <span class="pl-dp-title">${DP_MONTH[dpViewM]} ${dpViewY}</span>
        <button type="button" class="pl-dp-nav" data-dp-nav="1" title="下一月">›</button>
      </div>
      <div class="pl-dp-week">${DP_WEEK.map(w => `<span>${w}</span>`).join('')}</div>
      <div class="pl-dp-grid">${cells}</div>
      <div class="pl-dp-foot">
        <button type="button" class="pl-dp-btn ghost" data-dp-clear>清除</button>
        <button type="button" class="pl-dp-btn primary" data-dp-ok ${dpTemp ? '' : 'disabled'}>确定</button>
      </div>`;
  }
  function dpCommit(val) {
    if (dpInput) {
      dpInput.value = val;
      dpInput.dispatchEvent(new Event('input', { bubbles: true }));
      dpInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeDatePicker();
  }
  function openDatePicker(input) {
    dpInput = input;
    const cur = dpParse(input.value);
    const now = new Date();
    dpTemp = cur ? input.value.trim() : '';
    dpViewY = cur ? cur.y : now.getFullYear();
    dpViewM = cur ? cur.m : now.getMonth();
    const p = ensureDpPanel();
    p.classList.add('open');
    renderDpPanel();
    // 定位：默认贴输入框下方；空间不足则上翻；右侧溢出则右对齐
    const r = input.getBoundingClientRect();
    const pw = p.offsetWidth || 300, ph = p.offsetHeight || 340;
    let left = r.left + window.scrollX;
    let top = r.bottom + window.scrollY + 6;
    if (left + pw > window.scrollX + document.documentElement.clientWidth - 8) {
      left = window.scrollX + document.documentElement.clientWidth - pw - 8;
    }
    if (r.bottom + ph + 8 > document.documentElement.clientHeight && r.top - ph - 6 > 0) {
      top = r.top + window.scrollY - ph - 6;
    }
    p.style.left = Math.max(8, left) + 'px';
    p.style.top = top + 'px';
  }
  function closeDatePicker() {
    if (dpPanel) dpPanel.classList.remove('open');
    dpInput = null;
  }
  // 全局关闭：点击面板与输入框以外区域、Esc、滚动容器变化
  if (!window._plDpBound) {
    window._plDpBound = true;
    document.addEventListener('mousedown', (e) => {
      if (!dpPanel || !dpPanel.classList.contains('open')) return;
      if (e.target.closest('.pl-dp') || e.target.closest('.pl-date')) return;
      closeDatePicker();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDatePicker(); });
  }

  /* ---------- 宽表拥挤时自动收起左侧功能抽屉（与「阳光云迭代项目」一致的体验） ----------
     判断依据：本模块内任一横向滚动容器出现溢出（内容宽度 > 可视宽度）即视为拥挤。
     只在「侧栏当前展开」时请求收起；不再拥挤则请求恢复（Platform 内部只会恢复"自动收起"的情况，
     用户手动收起不会被打扰）。 */
  let crowdRaf = 0;
  function syncSidebarByCrowding() {
    if (!el || typeof Platform === 'undefined') return;
    if (crowdRaf) cancelAnimationFrame(crowdRaf);
    // 等布局稳定后再测量，避免刚 innerHTML 完宽度还没算好
    crowdRaf = requestAnimationFrame(() => {
      crowdRaf = 0;
      const wraps = el.querySelectorAll('.table-wrapper, .pl-gantt-scroll');
      let crowded = false;
      wraps.forEach(w => { if (w.scrollWidth - w.clientWidth > 4) crowded = true; });
      try {
        if (crowded) Platform.collapseSidebar && Platform.collapseSidebar();
        else Platform.expandSidebar && Platform.expandSidebar();
      } catch (e) { /* 忽略 */ }
    });
  }

  /* ==========================================================
     行拖拽排序（表单内 9 张表格通用）
     语义：树形表 = 上/下沿放开→与目标同级换序，中间放开→成为目标的子项；
           平铺表 = 只有上/下沿（无层级概念）。
     两个必须遵守的约束：
     1) 落点生效前必须先 syncFormFromDom()，把用户尚未回写的输入救回 dirtyForm。
        因为 data-*-idx 是「数组下标」，数组一动下标就错位，而 syncFormFromDom 里
        取不到元素时是**静默 return**，顺序反了会悄悄把值写到别的行上、且不报错。
     2) 环引用必须自己校验：parentOptions 的防环只作用在下拉选项上，拖拽绕过了它。
     ========================================================== */
  const DRAG_TABLES = [
    { attr: 'data-ov-idx', key: 'overview', tree: true },
    { attr: 'data-task-idx', key: 'tasks', tree: true },
    { attr: 'data-market-idx', key: 'marketPlan', tree: true },
    { attr: 'data-ref-idx', key: 'references', tree: true },
    { attr: 'data-ms-idx', key: 'milestones', tree: false },
    { attr: 'data-issue-idx', key: 'issues', tree: false },
    { attr: 'data-risk-idx', key: 'risks', tree: false },
    { attr: 'data-res-idx', key: 'resources', tree: false },
    { attr: 'data-member-idx', key: 'members', tree: false }
  ];
  const DRAG_ROW_SEL = DRAG_TABLES.map(t => `tr[${t.attr}]`).join(',');
  function dragCfgOf(tr) { return tr ? (DRAG_TABLES.find(t => tr.hasAttribute(t.attr)) || null) : null; }
  function dragLabelOf(x) { return (x && (x.name || x.title || x.desc)) || '(未命名)'; }

  let dragCtx = null;

  /* 被拖动的整块：树形表 = 自身 + 全部后代（按树序取，保证子树在数组里连续）
     平铺表 = 仅自身。treeOrder 里子树是「深度 > 自身」的连续段。 */
  function subtreeBlock(list, id, tree) {
    const self = (list || []).find(x => x.id === id);
    if (!self) return [];
    if (!tree) return [self];
    const ord = treeOrder(list);
    const at = ord.findIndex(o => o.item.id === id);
    if (at < 0) return [self];
    const base = ord[at].depth;
    const block = [ord[at].item];
    for (let k = at + 1; k < ord.length && ord[k].depth > base; k++) block.push(ord[k].item);
    return block;
  }

  /* 落点应用。mode: before | after | child
     before -> 插到 target 之前，与 target 同级
     after  -> 插到 target 整棵子树之后，与 target 同级
     child  -> 成为 target 的最后一个子项
     返回 false = 非法落点（拖到自己身上，或拖进自己的子孙里） */
  function applyRowDrop(cfg, dragId, targetId, mode) {
    const list = dirtyForm && dirtyForm[cfg.key];
    if (!Array.isArray(list)) return false;
    const drag = list.find(x => x.id === dragId);
    const target = list.find(x => x.id === targetId);
    if (!drag || !target || dragId === targetId) return false;
    if (cfg.tree && descendantIds(list, dragId).has(targetId)) return false;

    const block = subtreeBlock(list, dragId, cfg.tree);
    const blockIds = new Set(block.map(x => x.id));
    if (cfg.tree) drag.parentId = (mode === 'child') ? target.id : (target.parentId || '');

    const rest = list.filter(x => !blockIds.has(x.id));
    let at;
    if (mode === 'before') {
      at = rest.findIndex(x => x.id === targetId);
    } else {
      const tb = subtreeBlock(rest, targetId, cfg.tree);
      const lastId = tb.length ? tb[tb.length - 1].id : targetId;
      at = rest.findIndex(x => x.id === lastId) + 1;
    }
    if (at < 0) at = rest.length;
    rest.splice(at, 0, ...block);
    dirtyForm[cfg.key] = rest;
    return true;
  }

  function clearDropMarks() {
    if (!el) return;
    el.querySelectorAll('.pl-drop-before,.pl-drop-after,.pl-drop-child,.pl-drop-deny')
      .forEach(r => r.classList.remove('pl-drop-before', 'pl-drop-after', 'pl-drop-child', 'pl-drop-deny'));
  }
  // 找最近的可纵向滚动祖先，拖到边缘时自动滚动（表单体在滚动，不一定是 window）
  function scrollParentOf(node) {
    let p = node && node.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight - p.clientHeight > 4) return p;
      p = p.parentElement;
    }
    return null;
  }
  function dragAutoScroll(y) {
    const M = 56, S = 14;
    const sp = dragCtx && dragCtx.scroller;
    if (sp) {
      const r = sp.getBoundingClientRect();
      if (y < r.top + M) sp.scrollTop -= S;
      else if (y > r.bottom - M) sp.scrollTop += S;
      return;
    }
    if (y < M) window.scrollBy(0, -S);
    else if (y > window.innerHeight - M) window.scrollBy(0, S);
  }

  function endRowDrag() {
    if (dragCtx) {
      dragCtx.srcRows.forEach(r => r.classList.remove('pl-dragging'));
      if (dragCtx.ghost && dragCtx.ghost.parentNode) dragCtx.ghost.remove();
    }
    clearDropMarks();
    document.removeEventListener('pointermove', onRowDragMove, true);
    document.removeEventListener('pointerup', onRowDragUp, true);
    document.removeEventListener('pointercancel', endRowDrag, true);
    document.removeEventListener('keydown', onRowDragKey, true);
    document.body.classList.remove('pl-dragging-active');
    dragCtx = null;
  }

  function startRowDrag(e, tr, cfg) {
    const list = (dirtyForm && dirtyForm[cfg.key]) || [];
    const idx = Number(tr.getAttribute(cfg.attr));
    const item = list[idx];
    if (!item) return;
    const block = subtreeBlock(list, item.id, cfg.tree);
    const srcRows = block
      .map(b => el.querySelector(`tr[${cfg.attr}="${list.indexOf(b)}"]`))
      .filter(Boolean);

    const ghost = document.createElement('div');
    ghost.className = 'pl-drag-ghost';
    ghost.textContent = dragLabelOf(item).slice(0, 28) + (block.length > 1 ? `（含 ${block.length - 1} 个子项）` : '');

    dragCtx = {
      cfg, dragId: item.id, srcRows, ghost,
      descIds: cfg.tree ? descendantIds(list, item.id) : new Set(),
      startX: e.clientX, startY: e.clientY,
      active: false, drop: null,
      scroller: scrollParentOf(tr)
    };
    document.addEventListener('pointermove', onRowDragMove, true);
    document.addEventListener('pointerup', onRowDragUp, true);
    document.addEventListener('pointercancel', endRowDrag, true);
    document.addEventListener('keydown', onRowDragKey, true);
  }

  function onRowDragMove(e) {
    if (!dragCtx) return;
    e.preventDefault();
    // 超过 4px 才真正开始拖，避免单击把手时界面闪一下
    if (!dragCtx.active) {
      if (Math.abs(e.clientY - dragCtx.startY) < 4 && Math.abs(e.clientX - dragCtx.startX) < 4) return;
      dragCtx.active = true;
      dragCtx.srcRows.forEach(r => r.classList.add('pl-dragging'));
      document.body.classList.add('pl-dragging-active');
      document.body.appendChild(dragCtx.ghost);
    }
    dragCtx.ghost.style.left = (e.clientX + 14) + 'px';
    dragCtx.ghost.style.top = (e.clientY + 12) + 'px';

    clearDropMarks();
    dragCtx.drop = null;
    dragAutoScroll(e.clientY);

    const under = document.elementFromPoint(e.clientX, e.clientY);
    const tr = (under && under.closest) ? under.closest(`tr[${dragCtx.cfg.attr}]`) : null;
    if (!tr) return;
    const list = (dirtyForm && dirtyForm[dragCtx.cfg.key]) || [];
    const target = list[Number(tr.getAttribute(dragCtx.cfg.attr))];
    if (!target || target.id === dragCtx.dragId) return;
    if (dragCtx.cfg.tree && dragCtx.descIds.has(target.id)) { tr.classList.add('pl-drop-deny'); return; }

    const r = tr.getBoundingClientRect();
    const p = (e.clientY - r.top) / (r.height || 1);
    const mode = dragCtx.cfg.tree
      ? (p < 0.3 ? 'before' : p > 0.7 ? 'after' : 'child')
      : (p < 0.5 ? 'before' : 'after');
    tr.classList.add('pl-drop-' + mode);
    dragCtx.drop = { targetId: target.id, mode };
  }

  function onRowDragKey(e) {
    if (e.key === 'Escape' && dragCtx) { e.preventDefault(); endRowDrag(); }
  }

  /* ---------- 键盘换序（把手聚焦后 Alt + 方向键） ----------
     长表格用鼠标精确拖拽很费劲，键盘更快；也让不便使用鼠标的人可用。
     Alt+↑/↓ 同级上下移；Alt+→ 缩进为上一个同级的子项；Alt+← 升级为父级的下一个同级。 */
  // parentId 归一化：与 treeOrder 的判定保持一致（指向不存在的 id 或自己都视为顶层）
  function normPid(list, x) {
    const pid = x && x.parentId;
    if (!pid || pid === x.id) return '';
    return list.some(y => y.id === pid) ? pid : '';
  }
  function siblingsOf(list, item, tree) {
    if (!tree) return list.slice();
    const pid = normPid(list, item);
    return list.filter(y => normPid(list, y) === pid);
  }
  function moveRowByKey(cfg, id, action) {
    const list = (dirtyForm && dirtyForm[cfg.key]) || [];
    const item = list.find(x => x.id === id);
    if (!item) return false;
    const sibs = siblingsOf(list, item, cfg.tree);
    const at = sibs.findIndex(x => x.id === id);
    if (action === 'up') {
      if (at <= 0) return false;                                   // 已是第一个，静默不动
      return applyRowDrop(cfg, id, sibs[at - 1].id, 'before');
    }
    if (action === 'down') {
      if (at < 0 || at >= sibs.length - 1) return false;            // 已是最后一个
      return applyRowDrop(cfg, id, sibs[at + 1].id, 'after');
    }
    if (!cfg.tree) return false;                                    // 平铺表没有层级
    if (action === 'indent') {
      if (at <= 0) return false;                                    // 没有上一个同级可挂
      return applyRowDrop(cfg, id, sibs[at - 1].id, 'child');
    }
    if (action === 'outdent') {
      const pid = normPid(list, item);
      if (!pid) return false;                                       // 已是顶层
      return applyRowDrop(cfg, id, pid, 'after');
    }
    return false;
  }
  // 重渲染后把焦点还给刚移动的那一行（DOM 已被替换，需按 id 重新定位）
  function refocusHandle(cfg, id) {
    const list = (dirtyForm && dirtyForm[cfg.key]) || [];
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return;
    const tr = el.querySelector(`tr[${cfg.attr}="${i}"]`);
    const h = tr && tr.querySelector('.pl-drag');
    if (!h) return;
    h.focus();
    if (h.scrollIntoView) h.scrollIntoView({ block: 'nearest' });
  }

  function onRowDragUp() {
    if (!dragCtx) return;
    const cfg = dragCtx.cfg, dragId = dragCtx.dragId, drop = dragCtx.drop, active = dragCtx.active;
    endRowDrag();
    if (!active || !drop) return;          // 只是点了一下把手，没真拖
    syncFormFromDom();                     // ★ 顺序关键：先回写，再动数组
    if (!applyRowDrop(cfg, dragId, drop.targetId, drop.mode)) {
      SharedUI.toast('不能移到这里：目标是它自己的子项', 'warning');
      return;
    }
    renderFormTabBody();
  }

  // 仅刷新表单当前 tab 的内容体（不整页重绘，保留其他 tab 已填内容于 dirtyForm）
  function renderFormTabBody() {
    if (currentView !== 'new' && currentView !== 'edit') return;
    el.querySelectorAll('.pl-form-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-form-tab') === currentFormTab));
    const body = el.querySelector('.pl-form-tab-body');
    if (body) body.innerHTML = renderFormTabBodyHtml(dirtyForm);
    bindFormTabEvents();
    syncSidebarByCrowding();
  }

  function bindEvents() {
    if (!el) return;
    if (currentView === 'list') {
      el.querySelector('#plNewPlan')?.addEventListener('click', () => { dirtyForm = initFormDraft(null); currentFormTab = 'basic'; currentView = 'new'; render(); });
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
            currentTab = 'overview'; currentView = 'detail';
            expandAuto(); render();
          }));
        }
      });
      el.querySelectorAll('.pl-card').forEach(card => card.addEventListener('click', () => {
        currentPlanId = card.getAttribute('data-plan-id');
        currentTab = 'overview'; currentView = 'detail';
        expandAuto(); render();
      }));
      // Dashboard「需要关注的计划」行 → 进入该计划详情
      el.querySelectorAll('.pl-attention-row').forEach(row => row.addEventListener('click', () => {
        currentPlanId = row.getAttribute('data-plan-id');
        currentTab = 'overview'; currentView = 'detail';
        expandAuto(); render();
      }));
    } else if (currentView === 'detail') {
      el.querySelector('#plBack')?.addEventListener('click', () => { currentView = 'list'; render(); });
      el.querySelector('#plEditPlan')?.addEventListener('click', () => { dirtyForm = initFormDraft(getPlan(currentPlanId)); currentFormTab = 'basic'; currentView = 'edit'; render(); });
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
      // 顶部/底部通用按钮
      el.querySelector('#plFormCancel')?.addEventListener('click', () => { dirtyForm = null; currentView = currentPlanId ? 'detail' : 'list'; render(); });
      el.querySelector('#plFormCancel2')?.addEventListener('click', () => { dirtyForm = null; currentView = currentPlanId ? 'detail' : 'list'; render(); });
      el.querySelector('#plFormSave')?.addEventListener('click', submitPlan);
      el.querySelector('#plFormSave2')?.addEventListener('click', submitPlan);
      // 暂存本页：把当前 tab 的 DOM 值收回 dirtyForm（不落库），给出反馈
      el.querySelector('#plStashTab')?.addEventListener('click', () => {
        syncFormFromDom();
        SharedUI.toast('本页已暂存（切换标签不丢失，最终点「保存计划」才落库）', 'success');
      });
      // 表单 Tab 切换：切换前先把当前 tab 的 DOM 值收回 dirtyForm，避免丢失
      el.querySelectorAll('.pl-form-tab').forEach(tab => tab.addEventListener('click', () => {
        const k = tab.getAttribute('data-form-tab');
        if (k === currentFormTab) return;
        syncFormFromDom();
        currentFormTab = k;
        renderFormTabBody();
      }));
      // 首次渲染也绑定当前 tab body 内的事件
      bindFormTabEvents();
    }
  }

  // 绑定表单当前 tab body 内的增删/导入/重置等事件（在整页渲染与 tab 切换刷新时都调用）
  function bindFormTabEvents() {
    if (!el) return;
    // 添加行
    el.querySelector('#plAddTask')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.tasks.push(blankTask()); renderFormTabBody(); });
    el.querySelector('#plAddMilestone')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.milestones.push(blankMilestone()); renderFormTabBody(); });
    el.querySelector('#plAddResource')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.resources.push(blankResource()); renderFormTabBody(); });
    el.querySelector('#plAddMember')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.members.push(blankMember()); renderFormTabBody(); });
    el.querySelector('#plAddReference')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.references.push(blankReference('')); renderFormTabBody(); });
    // 一键初始化标准交付件清单（VRC 常用）
    el.querySelector('#plRefSeed')?.addEventListener('click', () => {
      const doSeed = () => { dirtyForm.references = seedReferenceDocs(); renderFormTabBody(); };
      if ((dirtyForm.references || []).length) {
        SharedUI.confirm('初始化交付件清单', '<p>确认用 VRC 标准交付件清单覆盖当前内容？</p>', doSeed, { confirmText: '覆盖', confirmClass: 'danger' });
      } else { doSeed(); }
    });
    // 打开 RPD 模板库（链接来自部门级常量 RPD_TEMPLATE_URL）
    el.querySelector('#plRpdOpen')?.addEventListener('click', () => {
      const url = rpdUrlOf(dirtyForm);
      if (!url) { SharedUI.toast('尚未配置 RPD 模板库链接：请在本机 data/plan/config.json 填写 rpdTemplateUrl 后刷新', 'warning'); return; }
      if (!/^https?:\/\//i.test(url)) { SharedUI.toast('链接需以 http:// 或 https:// 开头', 'warning'); return; }
      window.open(url, '_blank', 'noopener');
    });
    el.querySelector('#plAddStage')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.overview.push(blankStage('')); renderFormTabBody(); });
    el.querySelector('#plAddIssue')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.issues.push(blankIssue()); renderFormTabBody(); });
    el.querySelector('#plAddRisk')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.risks.push(blankRisk()); renderFormTabBody(); });
    el.querySelector('#plAddMarket')?.addEventListener('click', () => { syncFormFromDom(); dirtyForm.marketPlan.push(blankMarketTask('')); renderFormTabBody(); });
    // 一键初始化标准上市计划
    el.querySelector('#plMarketSeed')?.addEventListener('click', () => {
      const doSeed = () => { dirtyForm.marketPlan = seedMarketPlan(); renderFormTabBody(); };
      if ((dirtyForm.marketPlan || []).length) {
        SharedUI.confirm('初始化上市计划', '<p>确认用标准模板（5 阶段及子任务）覆盖当前上市计划内容？</p>', doSeed, { confirmText: '覆盖', confirmClass: 'danger' });
      } else { doSeed(); }
    });
    // 项目总览重置为标准 8 阶段
    el.querySelector('#plOvReset')?.addEventListener('click', () => {
      SharedUI.confirm('重置项目总览', '<p>确认重置为标准 8 阶段（含测试计划 6 条子流程）？当前阶段将被覆盖。</p>', () => {
        dirtyForm.overview = seedOverviewStages();
        renderFormTabBody();
      }, { confirmText: '重置', confirmClass: 'danger' });
    });
    // WBS 从需求清单导入
    el.querySelector('#plImportReq')?.addEventListener('click', () => { syncFormFromDom(); openRequirementImport(); });
    // 删除行
    el.querySelectorAll('.pl-del-task').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); dirtyForm.tasks = removeWithDescendants(dirtyForm.tasks, Number(btn.getAttribute('data-del-task'))); renderFormTabBody(); }));
    el.querySelectorAll('.pl-del-ms').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); dirtyForm.milestones.splice(Number(btn.getAttribute('data-del-ms')), 1); renderFormTabBody(); }));
    el.querySelectorAll('.pl-del-res').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); dirtyForm.resources.splice(Number(btn.getAttribute('data-del-res')), 1); renderFormTabBody(); }));
    el.querySelectorAll('.pl-del-member').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); dirtyForm.members.splice(Number(btn.getAttribute('data-del-member')), 1); renderFormTabBody(); }));
    el.querySelectorAll('.pl-del-ref').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); dirtyForm.references = removeWithDescendants(dirtyForm.references, Number(btn.getAttribute('data-del-ref'))); renderFormTabBody(); }));
    el.querySelectorAll('.pl-del-ov').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); dirtyForm.overview = removeWithDescendants(dirtyForm.overview, Number(btn.getAttribute('data-del-ov'))); renderFormTabBody(); }));
    el.querySelectorAll('.pl-del-issue').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); dirtyForm.issues.splice(Number(btn.getAttribute('data-del-issue')), 1); renderFormTabBody(); }));
    el.querySelectorAll('.pl-del-risk').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); dirtyForm.risks.splice(Number(btn.getAttribute('data-del-risk')), 1); renderFormTabBody(); }));
    el.querySelectorAll('.pl-del-market').forEach(btn => btn.addEventListener('click', () => { syncFormFromDom(); dirtyForm.marketPlan = removeWithDescendants(dirtyForm.marketPlan, Number(btn.getAttribute('data-del-market'))); renderFormTabBody(); }));
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
      currentFormTab = 'basic';
      dirtyForm = initFormDraft(null);
    } else if (parts[0] === 'detail' && parts[1]) {
      currentView = 'detail';
      currentPlanId = parts[1];
      if (parts[2] && ['overview', 'wbs', 'gantt', 'milestone', 'resource', 'exec', 'ai'].includes(parts[2])) currentTab = parts[2]; else currentTab = 'overview';
      dirtyForm = null;
    } else if (parts[0] === 'edit' && parts[1]) {
      currentView = 'edit';
      currentPlanId = parts[1];
      currentFormTab = 'basic';
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
    // 离开模块：关闭日期面板，并把因本模块宽表而自动收起的侧栏恢复回去
    closeDatePicker();
    try { if (typeof Platform !== 'undefined' && Platform.expandSidebar) Platform.expandSidebar(); } catch (e) { }
  }
  function getSummary() {
    return summary && summary.agg || null;
  }

  /* ---------- 初始化加载 ---------- */
  async function init(el_, context) {
    container = el_;
    el = el_;
    el.innerHTML = `<div class="cs-loading">加载项目计划…</div>`;
    // 日期输入用事件委托绑定一次即可（后续 innerHTML 重绘不会丢失）
    if (!el._plDateDelegated) {
      el._plDateDelegated = true;
      el.addEventListener('click', (e) => {
        const inp = e.target.closest('input.pl-date');
        if (inp) { e.preventDefault(); openDatePicker(inp); }
      });
    }
    /* 行拖拽 + 「上级」下拉，同样用委托绑一次。
       绝不能绑在 .pl-form-tab-body / table / tr 上：renderFormTabBody() 会把它们
       整个 innerHTML 替换掉，监听器会连根消失。只有 el 自身永不被替换。 */
    if (!el._plDragDelegated) {
      el._plDragDelegated = true;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !dirtyForm) return;
        if (currentView !== 'new' && currentView !== 'edit') return;
        const handle = e.target.closest('.pl-drag');
        if (!handle) return;
        const tr = handle.closest(DRAG_ROW_SEL);
        const cfg = dragCfgOf(tr);
        if (!cfg) return;
        e.preventDefault();               // 防止拖动时选中页面文字
        startRowDrag(e, tr, cfg);
      });
      // 键盘换序：把手聚焦后 Alt + 方向键
      el.addEventListener('keydown', (e) => {
        if (!dirtyForm || !e.altKey) return;
        if (currentView !== 'new' && currentView !== 'edit') return;
        const action = { ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'indent', ArrowLeft: 'outdent' }[e.key];
        if (!action) return;
        const handle = e.target.closest && e.target.closest('.pl-drag');
        if (!handle) return;
        const tr = handle.closest(DRAG_ROW_SEL);
        const cfg = dragCfgOf(tr);
        if (!cfg) return;
        e.preventDefault();
        const list = dirtyForm[cfg.key] || [];
        const item = list[Number(tr.getAttribute(cfg.attr))];
        if (!item) return;
        const id = item.id;
        syncFormFromDom();                       // 同拖拽：先回写再动数组
        if (!moveRowByKey(cfg, id, action)) return;
        renderFormTabBody();
        refocusHandle(cfg, id);
      });
      /* 「上级」下拉原来没有任何监听：改完不重排、不缩进，要等切 tab 或增删行才生效。
         补一个 change，让层级变更立刻可见（与拖拽改父节点行为一致）。 */
      el.addEventListener('change', (e) => {
        if (!dirtyForm) return;
        if (currentView !== 'new' && currentView !== 'edit') return;
        if (!e.target.closest('select[data-f="parentId"]')) return;
        syncFormFromDom();
        renderFormTabBody();
      });
    }
    await Promise.all([fetchState(), fetchSummary(), fetchConfig()]);
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
