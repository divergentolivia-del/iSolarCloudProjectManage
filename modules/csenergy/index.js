/* modules/csenergy/index.js — 工商储项目管理客户端模块
   四个视图：立项管理看板 / 项目全景图 / 风险全景图 / 资源管理
   图表全部用纯 CSS + 内联 SVG 实现，零第三方依赖。
*/

// eslint-disable-next-line no-unused-vars
const CsEnergyModule = (() => {
  'use strict';

  let container = null;
  let state = null;
  let summary = null;
  let currentView = 'board'; // board | overview | risk | resource
  let filterYear = new Date().getFullYear();

  const NODE_KEYS = ['BR0', 'BR1', 'BR2', 'BR3', 'BR4', 'TR1', 'TR2', 'TR3', 'TR4', 'TR5', 'TR6'];
  const STATUS_LABELS = { planned: '计划中', 'in-progress': '进行中', completed: '已完成', suspended: '已暂停' };
  const STATUS_CLASS = { planned: 'status-planned', 'in-progress': 'status-active', completed: 'status-done', suspended: 'status-hold' };
  const RISK_LABELS = { high: '高', medium: '中', low: '低' };

  const esc = (t) => (typeof SharedUI !== 'undefined' ? SharedUI.esc(t) : String(t == null ? '' : t));

  /* ---------- 数据获取 ---------- */
  async function fetchAll() {
    try {
      const [s, sum] = await Promise.all([
        fetch('/api/csenergy/state').then(r => r.ok ? r.json() : null),
        fetch('/api/csenergy/summary').then(r => r.ok ? r.json() : null)
      ]);
      state = s;
      summary = sum;
    } catch (e) {
      console.error('[csenergy] 数据获取失败:', e.message);
      state = null;
      summary = null;
    }
  }

  /* ---------- SVG 环形图 ---------- */
  function renderDonut(segments, centerLabel, centerValue) {
    // segments: [{ value, color, label }]
    const total = segments.reduce((s, x) => s + (x.value || 0), 0);
    const r = 52, cx = 70, cy = 70, sw = 16;
    const circ = 2 * Math.PI * r;
    let offset = 0;
    let arcs = '';

    if (total > 0) {
      segments.forEach(seg => {
        const frac = (seg.value || 0) / total;
        const len = frac * circ;
        arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${sw}"
          stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
        offset += len;
      });
    } else {
      arcs = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"></circle>`;
    }

    return `
      <div class="cs-donut">
        <svg viewBox="0 0 140 140" width="140" height="140">${arcs}</svg>
        <div class="cs-donut-center">
          <strong>${esc(centerValue)}</strong>
          <span>${esc(centerLabel)}</span>
        </div>
      </div>`;
  }

  function renderLegend(items) {
    return `<div class="cs-legend">${items.map(i =>
      `<span class="cs-legend-item"><i style="background:${i.color}"></i>${esc(i.label)} <b>${esc(i.value)}</b></span>`
    ).join('')}</div>`;
  }

  /* ============================================================
     视图 1：立项管理看板
     ============================================================ */
  function renderBoard() {
    const m = (summary && summary.metrics) || {};
    const pr = (summary && summary.progressRisk) || { high: 0, medium: 0, low: 0 };
    const rc = (summary && summary.riskClosure) || { closeRate: 0, closed: 0, open: 0, total: 0 };
    const ms = (summary && summary.milestoneStats) || [];
    const gantt = (summary && summary.ganttProjects) || [];
    const overdue = (summary && summary.overdueRisks) || [];
    const upcoming = (summary && summary.upcomingRisks) || [];

    // 6 指标卡
    const metricCards = [
      { icon: '📁', value: m.approved || 0, label: '已立项项目数(总)', sub: `本年度 (${filterYear})`, color: 'green' },
      { icon: '⏳', value: m.pending || 0, label: '待立项项目数', sub: '状态：未开始/立项中', color: 'orange' },
      { icon: '🚀', value: m.inProgress || 0, label: '进行中项目数', sub: '状态：进行中', color: 'blue' },
      { icon: '👤', value: m.managerCount || 0, label: '立项项目经理人数', sub: '进行中项目不重复项目经理', color: 'purple' },
      { icon: '👥', value: m.humanProjects || 0, label: '人力项目数', sub: '进行中项目名录 × 项目经理', color: 'pink' },
      { icon: '📈', value: m.efficiency || 0, label: '人均效能数', sub: '项目数 ÷ 项目经理人数', color: 'teal' }
    ].map((c, i) => `
      <div class="cs-metric cs-metric-${c.color}">
        <div class="cs-metric-top">
          <span class="cs-metric-icon">${c.icon}</span>
          <span class="cs-metric-trend">🎯</span>
        </div>
        <div class="cs-metric-value">${esc(c.value)}</div>
        <div class="cs-metric-label">${esc(c.label)}</div>
        <div class="cs-metric-sub">${esc(c.sub)}</div>
      </div>`).join('');

    // 里程碑柱状图
    const maxMs = Math.max(1, ...ms.map(x => x.count));
    const bars = ms.map(x => `
      <div class="cs-bar-col">
        <div class="cs-bar" style="--h:${Math.round((x.count / maxMs) * 100)}%" data-v="${x.count}"></div>
        <span class="cs-bar-label">${esc(x.node)}</span>
      </div>`).join('');

    // 进度风险环图
    const progSegs = [
      { value: pr.high, color: 'var(--warn)', label: '高风险' },
      { value: pr.medium, color: 'var(--hold)', label: '中风险' },
      { value: pr.low, color: 'var(--ok)', label: '低风险' }
    ];
    const progTotal = pr.high + pr.medium + pr.low;

    // 闭环率环图
    const closureSegs = [
      { value: rc.closed, color: 'var(--ok)', label: '已闭环' },
      { value: rc.open, color: 'var(--hold)', label: '未闭环' }
    ];

    // 甘特图
    let ganttHtml;
    if (gantt.length === 0) {
      ganttHtml = `<div class="cs-empty">暂无进行中的项目里程碑数据</div>`;
    } else {
      ganttHtml = gantt.map(p => {
        const bars = (p.milestones || []).map(mile => {
          const done = mile.status === 'done';
          const cls = done ? 'done' : 'pending';
          return `<span class="cs-gantt-node ${cls}" title="${esc(mile.name)} · ${esc(mile.date)}">
            ${esc(mile.node)}<small>${esc((mile.date || '').slice(5))}</small></span>`;
        }).join('');
        return `<div class="cs-gantt-row">
          <div class="cs-gantt-name">${esc(p.name)}</div>
          <div class="cs-gantt-track">${bars || '<span class="cs-gantt-empty">无节点</span>'}</div>
        </div>`;
      }).join('');
    }

    // 风险提醒
    const overdueHtml = overdue.length === 0
      ? `<div class="cs-risk-ok">🎉 暂无超时未闭环风险，继续保持！</div>`
      : overdue.map(r => `<div class="cs-risk-line cs-risk-${r.level}">
          <span class="cs-risk-dot"></span>
          <span class="cs-risk-text">${esc(r.desc)}</span>
          <span class="cs-risk-date">${esc(r.planCloseDate)}</span></div>`).join('');

    const upcomingHtml = upcoming.length === 0
      ? `<div class="cs-risk-ok">近一周暂无待闭环风险</div>`
      : upcoming.map(r => `<div class="cs-risk-line cs-risk-${r.level}">
          <span class="cs-risk-dot"></span>
          <span class="cs-risk-text">${esc(r.desc)}</span>
          <span class="cs-risk-date">${esc(r.planCloseDate)}</span></div>`).join('');

    return `
      <div class="cs-view-head">
        <h3>立项管理看板</h3>
        <div class="cs-year-switch">
          <button class="btn" data-year="${filterYear - 1}">◀ 上一年</button>
          <span class="cs-year-chip">${filterYear}</span>
          <button class="btn" data-year="${filterYear + 1}">下一年 ▶</button>
        </div>
      </div>

      <div class="cs-metric-grid">${metricCards}</div>

      <div class="cs-chart-row">
        <div class="cs-chart-card">
          <h4>📊 当月里程碑统计</h4>
          <div class="cs-bar-chart">${bars}</div>
        </div>
        <div class="cs-chart-card">
          <h4>🔴 项目进度风险分布 <small>(进行中项目)</small></h4>
          <div class="cs-donut-wrap">
            ${renderDonut(progSegs, '进行中', progTotal)}
            ${renderLegend([
              { color: 'var(--warn)', label: '高风险', value: pr.high },
              { color: 'var(--hold)', label: '中风险', value: pr.medium },
              { color: 'var(--ok)', label: '低风险', value: pr.low }
            ])}
          </div>
        </div>
        <div class="cs-chart-card">
          <h4>🔄 当月风险闭环率</h4>
          <div class="cs-donut-wrap">
            ${renderDonut(closureSegs, '闭环率', rc.closeRate + '%')}
            ${renderLegend([
              { color: 'var(--ok)', label: '已闭环', value: rc.closed },
              { color: 'var(--hold)', label: '未闭环', value: rc.open }
            ])}
          </div>
        </div>
      </div>

      <div class="cs-panel">
        <div class="cs-panel-head"><h4>📅 里程碑甘特图 <small>(仅显示进行中项目)</small></h4></div>
        <div class="cs-gantt">${ganttHtml}</div>
      </div>

      <div class="cs-chart-row cs-chart-row-2">
        <div class="cs-panel">
          <div class="cs-panel-head"><h4>⚠️ 超时未闭环风险 <small>(计划闭环时间已过，按超期天数倒排)</small></h4></div>
          <div class="cs-risk-list">${overdueHtml}</div>
        </div>
        <div class="cs-panel">
          <div class="cs-panel-head"><h4>🚨 近一周内需要闭环的风险 <small>(按风险等级排序)</small></h4></div>
          <div class="cs-risk-list">${upcomingHtml}</div>
        </div>
      </div>`;
  }

  /* ============================================================
     视图 2：项目全景图
     ============================================================ */
  function renderOverview() {
    const projects = (state && state.projects) || [];
    const filtered = projects; // 年份筛选可后续接入

    const rows = filtered.length === 0
      ? `<tr><td colspan="9" class="cs-table-empty">暂无数据</td></tr>`
      : filtered.map((p, i) => {
        const riskBadge = `<span class="cs-risk-badge cs-risk-${p.progressRisk || 'low'}">${RISK_LABELS[p.progressRisk] || '低'}</span>`;
        const nodesCells = ['BR0', 'TR3', 'TR5'].map(n =>
          `<td class="txt">${esc((p.nodes && p.nodes[n]) || '—')}</td>`).join('');
        return `<tr>
          <td>${i + 1}</td>
          <td class="txt">${esc(p.code || '—')}</td>
          <td class="txt"><strong>${esc(p.name || '—')}</strong><br><small>${esc(p.region || '')}</small></td>
          <td class="txt">${esc(p.series || '—')}</td>
          <td class="txt">${esc(p.planning || '—')}</td>
          <td class="txt">${esc(p.versionType || '—')}</td>
          <td class="txt"><span class="badge ${STATUS_CLASS[p.status] || ''}">${STATUS_LABELS[p.status] || p.status}</span></td>
          <td>${riskBadge}</td>
          ${nodesCells}
        </tr>`;
      }).join('');

    const yearBtns = ['全部', 2024, 2025, 2026, 2027, 2028, 2029].map(y =>
      `<button class="cs-year-btn ${y === filterYear ? 'active' : ''}" data-oyear="${y}">${y}</button>`).join('');

    return `
      <div class="cs-view-head">
        <h3>项目全景图</h3>
        <button class="btn primary">+ 新建项目</button>
      </div>
      <div class="cs-filter-bar">
        <div class="cs-filter-years">${yearBtns}</div>
        <div class="cs-filter-controls">
          <input type="text" placeholder="项目名称/编号/系列" class="cs-search">
          <select class="select"><option>全部状态</option><option>进行中</option><option>已完成</option></select>
          <select class="select"><option>全部规划</option><option>计划内</option><option>规划中</option></select>
          <select class="select"><option>全部风险</option><option>高</option><option>中</option><option>低</option></select>
          <button class="btn primary">🔍 查询</button>
        </div>
      </div>
      <div class="cs-panel">
        <div class="table-wrapper">
          <table>
            <thead><tr>
              <th>序号</th><th>项目编码</th><th>项目名称·区域</th><th>项目系列</th>
              <th>规划情况</th><th>版本类型</th><th>项目状态</th><th>进度风险</th>
              <th>BR0 立项</th><th>TR3 转产</th><th>TR5 量产</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="cs-table-foot">共 ${filtered.length} 条</div>
      </div>`;
  }

  /* ============================================================
     视图 3：风险全景图
     ============================================================ */
  function renderRisk() {
    const risks = (state && state.risks) || [];
    const rs = (summary && summary.riskStats) || { high: 0, medium: 0, low: 0, open: 0, closed: 0, total: 0 };

    const statCards = [
      { value: rs.high, label: '高风险', cls: 'high' },
      { value: rs.medium, label: '中风险', cls: 'medium' },
      { value: rs.low, label: '低风险', cls: 'low' },
      { value: rs.open, label: '未闭环', cls: 'open' },
      { value: rs.closed, label: '已闭环', cls: 'closed' },
      { value: rs.total, label: '全部风险', cls: 'total' }
    ].map(c => `<div class="cs-risk-stat cs-risk-stat-${c.cls}">
        <strong>${esc(c.value)}</strong><span>${esc(c.label)}</span></div>`).join('');

    const rows = risks.length === 0
      ? `<tr><td colspan="8" class="cs-table-empty">暂无数据</td></tr>`
      : risks.map((r, i) => `<tr>
          <td>${i + 1}</td>
          <td>${r.star ? '⭐' : ''}</td>
          <td class="txt">${esc(r.projectName || '—')}</td>
          <td class="txt">${esc(r.desc || '—')}</td>
          <td class="txt">${esc(r.impactType || '—')}</td>
          <td><span class="cs-risk-badge cs-risk-${r.level}">${RISK_LABELS[r.level] || '低'}</span></td>
          <td><span class="badge ${r.state === 'closed' ? 'status-done' : 'status-hold'}">${r.state === 'closed' ? '已闭环' : '未闭环'}</span></td>
          <td class="txt">
            <div class="cs-close-bar"><div class="cs-close-fill" style="width:${r.closeProgress || 0}%"></div></div>
            <small>${r.closeProgress || 0}% · ${esc(r.resourceSupport || '')}</small>
          </td>
        </tr>`).join('');

    return `
      <div class="cs-view-head">
        <h3>风险全景图</h3>
        <div class="cs-head-actions">
          <button class="btn">🔔 更新提醒</button>
          <button class="btn primary">+ 登记风险</button>
        </div>
      </div>
      <div class="cs-filter-bar">
        <div class="cs-filter-controls">
          <select class="select"><option>全部项目</option></select>
          <select class="select"><option>全部等级</option><option>高</option><option>中</option><option>低</option></select>
          <select class="select"><option>全部影响类型</option><option>进度</option><option>质量</option><option>成本</option></select>
          <select class="select"><option>全部状态</option><option>未闭环</option><option>已闭环</option></select>
          <button class="btn primary">🔍 查询</button>
        </div>
      </div>
      <div class="cs-risk-stat-grid">${statCards}</div>
      <div class="cs-panel">
        <div class="table-wrapper">
          <table>
            <thead><tr>
              <th>序号</th><th>星标</th><th>所属项目</th><th>风险描述</th>
              <th>影响类型</th><th>等级</th><th>状态</th><th>措施闭环进度</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="cs-table-foot">共 ${risks.length} 条</div>
      </div>`;
  }

  /* ============================================================
     视图 4：资源管理
     ============================================================ */
  function renderResource() {
    const res = (state && state.resources) || { human: [], month: '', dept: '' };
    const human = res.human || [];
    const total = human.reduce((s, h) => s + (h.invest || 0), 0);

    const cards = human.map(h => `
      <div class="cs-res-card" style="--rc:${h.color}">
        <div class="cs-res-icon" style="background:${h.color}"></div>
        <strong>${esc(h.invest)}</strong>
        <span>${esc(h.role)}</span>
        <small>投入度</small>
      </div>`).join('');

    const totalCard = `
      <div class="cs-res-card cs-res-total">
        <div class="cs-res-icon" style="background:linear-gradient(135deg,var(--accent),var(--blue))"></div>
        <strong>${total.toFixed(1)}</strong>
        <span>合计</span>
        <small>总投入度</small>
      </div>`;

    return `
      <div class="cs-view-head">
        <h3>资源管理</h3>
        <div class="cs-head-actions">
          <button class="btn">⬆ Excel导入</button>
          <button class="btn primary">+ 新增记录</button>
        </div>
      </div>
      <div class="cs-subtabs">
        <button class="cs-subtab">物料资源</button>
        <button class="cs-subtab active">人力资源</button>
      </div>
      <div class="cs-filter-bar">
        <div class="cs-filter-controls">
          <label class="cs-inline-label">人力月份 <input type="month" class="cs-search" value="${esc(res.month)}"></label>
          <label class="cs-inline-label">资源归属部门
            <select class="select"><option>${esc(res.dept || '研发中心')}</option></select>
          </label>
        </div>
      </div>
      <div class="cs-panel">
        <div class="cs-panel-head"><h4>📊 ${esc(res.dept || '研发中心')} 人力投入统计 <small>(单位：人月)</small></h4></div>
        <div class="cs-res-grid">${cards}${totalCard}</div>
      </div>`;
  }

  /* ---------- 主渲染 ---------- */
  function render() {
    if (!container) return;

    const tabs = [
      { id: 'board', icon: '📊', label: '立项管理看板' },
      { id: 'overview', icon: '📖', label: '项目全景图' },
      { id: 'risk', icon: '⚠️', label: '风险全景图' },
      { id: 'resource', icon: '📦', label: '资源管理' }
    ].map(t => `<button class="cs-tab ${t.id === currentView ? 'active' : ''}" data-view="${t.id}">
        <span>${t.icon}</span> ${t.label}</button>`).join('');

    let body;
    if (currentView === 'board') body = renderBoard();
    else if (currentView === 'overview') body = renderOverview();
    else if (currentView === 'risk') body = renderRisk();
    else if (currentView === 'resource') body = renderResource();

    container.innerHTML = `
      <div class="csenergy-page">
        <div class="cs-topnav">${tabs}</div>
        <div class="cs-view-body">${body}</div>
      </div>`;

    bindEvents();
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    // tab 切换
    container.querySelectorAll('.cs-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.getAttribute('data-view');
        if (v && v !== currentView) {
          currentView = v;
          render();
        }
      });
    });

    // 年份切换（看板）
    container.querySelectorAll('[data-year]').forEach(btn => {
      btn.addEventListener('click', () => {
        filterYear = Number(btn.getAttribute('data-year'));
        render();
      });
    });

    // 年份筛选（全景图）
    container.querySelectorAll('[data-oyear]').forEach(btn => {
      btn.addEventListener('click', () => {
        const y = btn.getAttribute('data-oyear');
        filterYear = y === '全部' ? filterYear : Number(y);
        render();
      });
    });

    // 资源子tab
    container.querySelectorAll('.cs-subtab').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.cs-subtab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  async function load() {
    if (container) container.innerHTML = '<div class="cs-loading">加载中...</div>';
    await fetchAll();
    render();
  }

  /* ---------- ModuleDefinition 接口 ---------- */
  return {
    id: 'csenergy',
    name: '工商储项目',
    icon: '🔋',
    order: 3,
    sidebar: true,

    init(el) {
      container = el;
      load();
    },

    enter(subPath) {
      if (subPath && ['board', 'overview', 'risk', 'resource'].includes(subPath)) {
        currentView = subPath;
      }
      if (!state) { load(); } else { render(); }
    },

    leave() { /* 保留状态 */ },

    getSummary() {
      return summary ? summary.metrics : { approved: 0, inProgress: 0 };
    }
  };
})();
