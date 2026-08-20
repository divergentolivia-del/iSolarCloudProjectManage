/* modules/dashboard/index.js — 首页仪表盘客户端模块
   渲染仪表盘主页：指标卡片、模块入口卡片、快速访问区。
   作为 Dashboard 子路由容器，管理 budget 和 token 子页面的渲染。
*/

// eslint-disable-next-line no-unused-vars
const DashboardModule = (() => {
  'use strict';

  let container = null;
  let currentSubPath = '';
  let summaryData = null;

  /**
   * 获取仪表盘汇总数据
   */
  async function fetchSummary() {
    try {
      const resp = await fetch('/api/dashboard/summary');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    } catch (e) {
      console.error('[dashboard] 获取汇总数据失败:', e.message);
      return null;
    }
  }

  /**
   * 渲染仪表盘主页
   */
  async function renderHome() {
    if (!container) return;

    summaryData = await fetchSummary();
    const data = summaryData || {
      iteration: { deviation: 0, cycleName: '—' },
      project: { active: 0, overdue: 0 },
      budget: { rate: 0, alerts: 0 },
      token: { monthlyCost: 0 },
      alerts: [],
      alertsTotal: 0,
      deviationByTeam: [],
      recentArchives: []
    };

    // 指标卡片
    const deviationValue = SharedUI.formatPct(data.iteration.deviation);
    const deviationStatus = Math.abs(data.iteration.deviation) > 0.10 ? 'warn' : 'ok';
    const deviationText = data.iteration.deviation > 0.10 ? '偏高' :
      data.iteration.deviation < -0.10 ? '偏低' : '正常';

    const projectValue = (data.project.active || 0) + ' 个';
    const projectStatus = data.project.overdue > 0 ? 'warn' : 'ok';
    const projectText = data.project.overdue > 0 ? data.project.overdue + '个逾期' : '正常';

    const tokenValue = SharedUI.formatCurrency(data.token.monthlyCost || 0);
    const tokenStatus = 'ok';
    const tokenText = '正常';

    const metricsHtml = `
      <div class="metrics-row">
        <div class="metric-card">
          <div class="metric-card-header">
            <span class="metric-card-icon">📊</span>
            <span class="metric-card-label">产能偏差</span>
          </div>
          <div class="metric-card-value">${SharedUI.esc(deviationValue)}</div>
          <span class="metric-card-status ${deviationStatus}">${SharedUI.esc(deviationStatus === 'warn' ? '⚠ ' + deviationText : '✓ ' + deviationText)}</span>
          <span class="metric-card-subtitle">偏差超±10%时预警</span>
        </div>
        <div class="metric-card">
          <div class="metric-card-header">
            <span class="metric-card-icon">📋</span>
            <span class="metric-card-label">在研项目数</span>
          </div>
          <div class="metric-card-value">${SharedUI.esc(projectValue)}</div>
          <span class="metric-card-status ${projectStatus}">${SharedUI.esc(projectStatus === 'warn' ? '⚠ ' + projectText : '✓ ' + projectText)}</span>
          <span class="metric-card-subtitle">有逾期里程碑时预警</span>
        </div>
        <div class="metric-card">
          <div class="metric-card-header">
            <span class="metric-card-icon">🤖</span>
            <span class="metric-card-label">Token月度消耗</span>
          </div>
          <div class="metric-card-value">${SharedUI.esc(tokenValue)}</div>
          <span class="metric-card-status ${tokenStatus}">${SharedUI.esc('✓ ' + tokenText)}</span>
          <span class="metric-card-subtitle">超月预算80%时预警</span>
        </div>
      </div>
    `;

    // 模块入口卡片
    const entriesHtml = `
      <div class="entry-cards-row">
        ${SharedUI.renderModuleEntryCard('人力预算管理', '管理各团队人力预算计划，实际用量跟踪与预警', '💰', '#/dashboard/budget')}
        ${SharedUI.renderModuleEntryCard('AI/Token 使用记录', '查看AI Agent调用统计，Token消耗趋势分析', '🤖', '#/dashboard/token')}
      </div>
    `;

    // 快速访问区：告警
    let alertsHtml = '';
    const alertSourceNote = '来源：项目里程碑逾期、预算超支、Token超限';
    if (data.alerts && data.alerts.length > 0) {
      const alertItems = data.alerts.map(a => {
        const icon = a.type.startsWith('budget') ? '⚠' : a.type === 'token-warning' ? '○' : '⚠';
        return `<li class="alert-item ${a.type}"><span class="alert-icon">${SharedUI.esc(icon)}</span> ${SharedUI.esc(a.message)}</li>`;
      }).join('');
      const moreLink = data.alertsTotal > 5 ? '<div class="alerts-more"><a href="#/dashboard">查看全部</a></div>' : '';
      alertsHtml = `
        <div class="quick-section alerts-section">
          <h3 class="section-title">待办/告警</h3>
          <p class="section-note">${SharedUI.esc(alertSourceNote)}</p>
          <ul class="alert-list">${alertItems}</ul>
          ${moreLink}
        </div>
      `;
    } else {
      alertsHtml = `
        <div class="quick-section alerts-section">
          <h3 class="section-title">待办/告警</h3>
          <p class="section-note">${SharedUI.esc(alertSourceNote)}</p>
          <p class="empty-hint">暂无告警</p>
        </div>
      `;
    }

    // 快速访问区：月度偏差概览
    let deviationHtml = '';
    if (data.deviationByTeam && data.deviationByTeam.length > 0) {
      const items = data.deviationByTeam.slice(0, 6).map(d => {
        const pct = SharedUI.formatPct(d.ratio);
        const cls = Math.abs(d.ratio) > 0.10 ? 'warn' : '';
        return `<li class="deviation-item ${cls}"><span class="dev-team">${SharedUI.esc(d.team)}</span> <span class="dev-value">${SharedUI.esc(pct)}</span></li>`;
      }).join('');
      deviationHtml = `
        <div class="quick-section deviation-section">
          <h3 class="section-title">当月偏差概览</h3>
          <ul class="deviation-list">${items}</ul>
        </div>
      `;
    }

    // 快速访问区：最近归档
    let archivesHtml = '';
    if (data.recentArchives && data.recentArchives.length > 0) {
      const items = data.recentArchives.map(a => {
        return `<li class="archive-item"><span class="archive-icon">📦</span> ${SharedUI.esc(a.name)} <span class="archive-date">${SharedUI.esc(a.date)}</span></li>`;
      }).join('');
      archivesHtml = `
        <div class="quick-section archives-section">
          <h3 class="section-title">最近归档记录</h3>
          <ul class="archive-list">${items}</ul>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="dashboard-page">
        <div class="dashboard-heading">
          <div>
            <div class="section-kicker">WORKBENCH OVERVIEW</div>
            <h2 class="page-title">云平台管理工作台</h2>
            <p class="dashboard-lead">&#x628A;&#x9879;&#x76EE;&#x8FDB;&#x5EA6;&#x3001;&#x4EBA;&#x529B;&#x9884;&#x7B97;&#x548C; AI &#x4F7F;&#x7528;&#x6210;&#x672C;&#x653E;&#x5728;&#x540C;&#x4E00;&#x5C4F;&#xFF0C;&#x5148;&#x5904;&#x7406;&#x98CE;&#x9669;&#xFF0C;&#x518D;&#x63A8;&#x8FDB;&#x4EA4;&#x4ED8;&#x3002;</p>
          </div>
        </div>
        ${metricsHtml}
        ${entriesHtml}
        <div class="quick-access-row">
          ${alertsHtml}
          ${deviationHtml}
        </div>
        ${archivesHtml}
      </div>
    `;
  }

  /**
   * 渲染子页面（budget、token 或 settings）
   */
  function renderSubPage(subPath) {
    if (!container) return;

    if (subPath === 'budget') {
      // 渲染预算管理子页面
      container.innerHTML = `
        <div class="sub-page">
          <div class="sub-page-nav">
            <a href="#/dashboard" class="btn back-btn">&larr; 返回首页</a>
            <div class="breadcrumb-inline">${SharedUI.renderBreadcrumb([{label: '首页', href: '#/dashboard'}, {label: '人力预算管理'}])}</div>
          </div>
          <div id="budgetSubContainer"></div>
        </div>
      `;
      const subContainer = document.getElementById('budgetSubContainer');
      if (typeof BudgetModule !== 'undefined' && BudgetModule.render) {
        BudgetModule.render(subContainer);
      } else {
        subContainer.innerHTML = '<p>人力预算管理模块加载中...</p>';
      }
    } else if (subPath === 'token') {
      // 渲染 Token 子页面
      container.innerHTML = `
        <div class="sub-page">
          <div class="sub-page-nav">
            <a href="#/dashboard" class="btn back-btn">&larr; 返回首页</a>
            <div class="breadcrumb-inline">${SharedUI.renderBreadcrumb([{label: '首页', href: '#/dashboard'}, {label: 'AI/Token使用记录'}])}</div>
          </div>
          <div id="tokenSubContainer"></div>
        </div>
      `;
      const subContainer = document.getElementById('tokenSubContainer');
      if (typeof TokenModule !== 'undefined' && TokenModule.render) {
        TokenModule.render(subContainer);
      } else {
        subContainer.innerHTML = '<p>AI/Token 使用记录模块加载中...</p>';
      }
    } else if (subPath === 'settings') {
      // 渲染系统设置子页面
      container.innerHTML = `
        <div class="sub-page">
          <div class="sub-page-nav">
            <a href="#/dashboard" class="btn back-btn">&larr; 返回首页</a>
            <div class="breadcrumb-inline">${SharedUI.renderBreadcrumb([{label: '首页', href: '#/dashboard'}, {label: '系统设置'}])}</div>
          </div>
          <div id="settingsSubContainer"></div>
        </div>
      `;
      const subContainer = document.getElementById('settingsSubContainer');
      if (typeof SettingsModule !== 'undefined' && SettingsModule.render) {
        SettingsModule.render(subContainer);
      } else {
        subContainer.innerHTML = '<p>系统设置模块加载中...</p>';
      }
    } else {
      renderHome();
    }
  }

  /* ---------- ModuleDefinition 接口 ---------- */

  return {
    id: 'dashboard',
    name: '首页',
    icon: '🏠',
    order: 0,
    sidebar: true,

    /**
     * init(container, context) — 首次进入模块
     */
    init(el, context) {
      container = el;
      currentSubPath = (context && context.subPath) || '';
      if (currentSubPath) {
        renderSubPage(currentSubPath);
      } else {
        renderHome();
      }
    },

    /**
     * enter(subPath) — 重新进入模块（已初始化）
     */
    enter(subPath) {
      currentSubPath = subPath || '';
      if (currentSubPath) {
        renderSubPage(currentSubPath);
      } else {
        renderHome();
      }
    },

    /**
     * leave() — 离开模块时的清理
     */
    leave() {
      // No cleanup needed
    },

    /**
     * getSummary() — 返回仪表盘需要的摘要指标
     */
    getSummary() {
      return summaryData;
    }
  };
})();
