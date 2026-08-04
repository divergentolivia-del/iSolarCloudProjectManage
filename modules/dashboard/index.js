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
        ${SharedUI.renderMetricCard('📊', '产能偏差', deviationValue, deviationStatus, deviationStatus === 'warn' ? '⚠ ' + deviationText : '✓ ' + deviationText)}
        ${SharedUI.renderMetricCard('📋', '在研项目数', projectValue, projectStatus, projectStatus === 'warn' ? '⚠ ' + projectText : '✓ ' + projectText)}
        ${SharedUI.renderMetricCard('🤖', 'Token月度消耗', tokenValue, tokenStatus, '✓ ' + tokenText)}
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
    if (data.alerts && data.alerts.length > 0) {
      const alertItems = data.alerts.map(a => {
        const icon = a.type.startsWith('budget') ? '⚠' : a.type === 'token-warning' ? '○' : '⚠';
        return `<li class="alert-item ${a.type}"><span class="alert-icon">${SharedUI.esc(icon)}</span> ${SharedUI.esc(a.message)}</li>`;
      }).join('');
      const moreLink = data.alertsTotal > 5 ? '<div class="alerts-more"><a href="#/dashboard">查看全部</a></div>' : '';
      alertsHtml = `
        <div class="quick-section alerts-section">
          <h3 class="section-title">待办/告警</h3>
          <ul class="alert-list">${alertItems}</ul>
          ${moreLink}
        </div>
      `;
    } else {
      alertsHtml = `
        <div class="quick-section alerts-section">
          <h3 class="section-title">待办/告警</h3>
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
        <h2 class="page-title">云平台管理工作台</h2>
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
   * 渲染子页面（budget 或 token）
   */
  function renderSubPage(subPath) {
    if (!container) return;

    if (subPath === 'budget') {
      // 渲染预算管理子页面
      if (typeof BudgetModule !== 'undefined' && BudgetModule.render) {
        BudgetModule.render(container);
      } else {
        container.innerHTML = '<div class="sub-page"><p>人力预算管理模块加载中...</p></div>';
      }
    } else if (subPath === 'token') {
      // 渲染 Token 子页面
      if (typeof TokenModule !== 'undefined' && TokenModule.render) {
        TokenModule.render(container);
      } else {
        container.innerHTML = '<div class="sub-page"><p>AI/Token 使用记录模块加载中...</p></div>';
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
