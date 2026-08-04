/* modules/token/index.js — AI/Token 使用记录客户端模块
   渲染为仪表盘子页面 (#/dashboard/token)。
   显示月度汇总、预算进度条、占位内容。
*/

// eslint-disable-next-line no-unused-vars
const TokenModule = (() => {
  'use strict';

  let state = null;

  /* ---------- 数据获取 ---------- */

  async function fetchState() {
    try {
      const resp = await fetch('/api/token/state');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      state = await resp.json();
      return state;
    } catch (e) {
      console.error('[token] 获取数据失败:', e.message);
      return null;
    }
  }

  /* ---------- 渲染 ---------- */

  /**
   * 渲染 Token 页面到指定容器
   * 由 DashboardModule 在子路由 token 时调用
   */
  async function render(container) {
    if (!container) return;

    await fetchState();
    const data = state || { summary: {}, agents: [], dailyLogs: [], budgetLimit: {} };
    const summary = data.summary || {};
    const budgetLimit = data.budgetLimit || { monthly: 500, alertThreshold: 0.8 };

    // 预算进度
    const totalCost = Number(summary.totalCost) || 0;
    const monthlyLimit = Number(budgetLimit.monthly) || 500;
    const usagePct = monthlyLimit > 0 ? Math.min(100, Math.round(totalCost / monthlyLimit * 100)) : 0;
    const progressClass = usagePct > 80 ? 'warn' : usagePct > 60 ? 'caution' : '';

    // 月度汇总
    const summaryHtml = `
      <div class="token-summary">
        <div class="summary-grid">
          <div class="summary-item">
            <span class="summary-label">总Token</span>
            <span class="summary-value">${SharedUI.formatNumber(summary.totalTokens || 0)}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">总花费</span>
            <span class="summary-value">${SharedUI.formatCurrency(totalCost)}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">调用次数</span>
            <span class="summary-value">${SharedUI.formatNumber(summary.totalInvocations || 0)}</span>
          </div>
        </div>
        <div class="budget-progress">
          <div class="progress-header">
            <span>月预算: ${SharedUI.formatCurrency(monthlyLimit)}</span>
            <span>已使用: ${usagePct}%</span>
          </div>
          <div class="progress-bar ${progressClass}">
            <div class="progress-fill" style="width:${usagePct}%"></div>
          </div>
        </div>
      </div>
    `;

    // Agent 使用排行
    let agentHtml = '';
    if (data.agents && data.agents.length > 0) {
      const rows = data.agents
        .sort((a, b) => (b.cost || 0) - (a.cost || 0))
        .map((agent, i) => `<tr>
          <td>${i + 1}</td>
          <td>${SharedUI.esc(agent.name || agent.id)}</td>
          <td>${SharedUI.formatNumber(agent.invocations || 0)}</td>
          <td>${SharedUI.formatNumber(agent.tokensUsed || 0)}</td>
          <td>${SharedUI.formatCurrency(agent.cost || 0)}</td>
        </tr>`).join('');

      agentHtml = `
        <div class="token-section">
          <h3 class="section-title">Agent 使用排行</h3>
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>排名</th>
                  <th>Agent名称</th>
                  <th>调用次数</th>
                  <th>Token数</th>
                  <th>花费</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      `;
    }

    // 占位说明
    const placeholderHtml = `
      <div class="token-section placeholder-section">
        <div class="placeholder-box">
          <span class="placeholder-icon">🤖</span>
          <p class="placeholder-text">详细的 Token 使用追踪功能将在后续版本中完善。</p>
          <p class="placeholder-desc">当前页面展示基础汇总数据，包括月度消耗概览和预算使用进度。</p>
        </div>
      </div>
    `;

    container.innerHTML = `
      <div class="token-page">
        <div class="page-header">
          <h2 class="page-title">AI/Token 使用记录</h2>
        </div>
        ${summaryHtml}
        ${agentHtml}
        ${placeholderHtml}
      </div>
    `;
  }

  /* ---------- 模块接口 ---------- */

  return {
    id: 'token',
    name: 'AI/Token 使用记录',
    icon: '🤖',
    order: 4,
    sidebar: false, // 不在侧边栏显示，作为仪表盘子页面

    render: render, // 暴露给 DashboardModule 调用

    init(el) { render(el); },
    enter() {},
    leave() {},
    getSummary() {
      if (!state || !state.summary) return { monthlyCost: 0 };
      return { monthlyCost: state.summary.totalCost || 0 };
    }
  };
})();
