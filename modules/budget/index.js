/* modules/budget/index.js — 人力预算管理客户端模块
   渲染为仪表盘子页面 (#/dashboard/budget)。
   提供：年度预算计划表（可编辑）、计划 vs 实际对比图、预算告警列表。
*/

// eslint-disable-next-line no-unused-vars
const BudgetModule = (() => {
  'use strict';

  let state = null;

  /* ---------- 数据获取 ---------- */

  async function fetchState() {
    try {
      const resp = await fetch('/api/budget/state');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      state = await resp.json();
      return state;
    } catch (e) {
      console.error('[budget] 获取数据失败:', e.message);
      return null;
    }
  }

  async function saveState(newState) {
    try {
      const resp = await fetch('/api/budget/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseRev: state ? state.rev : 0,
          state: newState,
          by: typeof Platform !== 'undefined' ? Platform.whoami() : '未署名'
        })
      });
      const result = await resp.json();
      if (resp.status === 409) {
        SharedUI.toast('数据冲突，请刷新后重试', 'warning');
        return false;
      }
      if (!resp.ok) {
        SharedUI.toast(result.error || '保存失败', 'error');
        return false;
      }
      SharedUI.toast('保存成功', 'success');
      return true;
    } catch (e) {
      SharedUI.toast('网络错误: ' + e.message, 'error');
      return false;
    }
  }

  /* ---------- 渲染 ---------- */

  /**
   * 渲染预算管理页面到指定容器
   * 由 DashboardModule 在子路由 budget 时调用
   */
  async function render(container) {
    if (!container) return;

    await fetchState();
    const data = state || { plans: [], actuals: [], alerts: [] };

    // 年度预算计划表
    let planTableHtml = '';
    if (data.plans && data.plans.length > 0) {
      const rows = data.plans.map(plan => {
        const q = plan.quarterly || [];
        const q1 = q.find(x => x.q === 'Q1') || {};
        const q2 = q.find(x => x.q === 'Q2') || {};
        const q3 = q.find(x => x.q === 'Q3') || {};
        const q4 = q.find(x => x.q === 'Q4') || {};
        const annual = plan.annual || {};

        return `<tr>
          <td>${SharedUI.esc(plan.team)}</td>
          <td class="editable" data-team="${SharedUI.esc(plan.team)}" data-q="Q1" data-field="budget">${q1.budget || 0}</td>
          <td class="editable" data-team="${SharedUI.esc(plan.team)}" data-q="Q2" data-field="budget">${q2.budget || 0}</td>
          <td class="editable" data-team="${SharedUI.esc(plan.team)}" data-q="Q3" data-field="budget">${q3.budget || 0}</td>
          <td class="editable" data-team="${SharedUI.esc(plan.team)}" data-q="Q4" data-field="budget">${q4.budget || 0}</td>
          <td>${annual.budget || '—'}</td>
        </tr>`;
      }).join('');

      planTableHtml = `
        <div class="budget-section">
          <h3 class="section-title">年度预算计划表</h3>
          <div class="table-wrapper">
            <table class="data-table budget-table" id="budgetPlanTable">
              <thead>
                <tr>
                  <th>团队</th>
                  <th>Q1计划</th>
                  <th>Q2计划</th>
                  <th>Q3计划</th>
                  <th>Q4计划</th>
                  <th>年均</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      `;
    } else {
      planTableHtml = `
        <div class="budget-section">
          <h3 class="section-title">年度预算计划表</h3>
          <p class="empty-hint">暂无预算计划数据</p>
        </div>
      `;
    }

    // 计划 vs 实际对比 (CSS bar chart)
    let comparisonHtml = '';
    if (data.plans && data.plans.length > 0 && data.actuals && data.actuals.length > 0) {
      // 获取当前季度预算和最新月份的实际数据
      const currentQ = getCurrentQuarter();
      const latestActuals = getLatestActuals(data.actuals);
      const maxVal = Math.max(
        ...data.plans.map(p => {
          const q = (p.quarterly || []).find(x => x.q === currentQ);
          return q ? (q.budget || 0) : 0;
        }),
        ...latestActuals.map(a => a.total || 0),
        1
      );

      const bars = data.plans.map(plan => {
        const q = (plan.quarterly || []).find(x => x.q === currentQ) || {};
        const planned = Number(q.budget) || 0;
        const actual = latestActuals.find(a => a.team === plan.team);
        const actualVal = actual ? (Number(actual.total) || 0) : 0;
        const deviation = planned > 0 ? (actualVal - planned) / planned : 0;
        const warnClass = deviation > 0.10 ? 'over-budget' : '';
        const plannedWidth = Math.round(planned / maxVal * 100);
        const actualWidth = Math.round(actualVal / maxVal * 100);

        return `<div class="bar-row ${warnClass}">
          <span class="bar-label">${SharedUI.esc(plan.team.split('-')[0])}</span>
          <div class="bar-pair">
            <div class="bar planned" style="width:${plannedWidth}%"><span>${planned}</span></div>
            <div class="bar actual" style="width:${actualWidth}%"><span>${actualVal}</span></div>
          </div>
          ${deviation > 0.10 ? `<span class="bar-warn">⚠ +${(deviation * 100).toFixed(0)}%</span>` : ''}
        </div>`;
      }).join('');

      comparisonHtml = `
        <div class="budget-section">
          <h3 class="section-title">当月实际 vs 计划对比 (${currentQ})</h3>
          <div class="bar-legend">
            <span class="legend-item"><span class="legend-color planned"></span>计划</span>
            <span class="legend-item"><span class="legend-color actual"></span>实际</span>
          </div>
          <div class="bar-chart">${bars}</div>
        </div>
      `;
    }

    // 预算告警
    let alertsHtml = '';
    if (data.alerts && data.alerts.length > 0) {
      const items = data.alerts.map(a => {
        const icon = a.type === 'over-budget' ? '⚠' : '○';
        return `<li class="alert-item ${a.type || ''}"><span class="alert-icon">${icon}</span> ${SharedUI.esc(a.team)} ${SharedUI.esc(a.message || '')}</li>`;
      }).join('');
      alertsHtml = `
        <div class="budget-section">
          <h3 class="section-title">预算告警</h3>
          <ul class="alert-list">${items}</ul>
        </div>
      `;
    } else {
      alertsHtml = `
        <div class="budget-section">
          <h3 class="section-title">预算告警</h3>
          <p class="empty-hint">暂无告警</p>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="budget-page">
        <div class="page-header">
          <h2 class="page-title">人力预算管理</h2>
          <button class="btn" id="budgetExportBtn">导出 Excel</button>
        </div>
        ${planTableHtml}
        ${comparisonHtml}
        ${alertsHtml}
      </div>
    `;

    // 绑定可编辑单元格事件
    bindEditableCells(container);

    // 绑定导出按钮
    const exportBtn = document.getElementById('budgetExportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', exportExcel);
    }
  }

  /* ---------- 工具函数 ---------- */

  function getCurrentQuarter() {
    const month = new Date().getMonth();
    if (month < 3) return 'Q1';
    if (month < 6) return 'Q2';
    if (month < 9) return 'Q3';
    return 'Q4';
  }

  function getLatestActuals(actuals) {
    if (!actuals || actuals.length === 0) return [];
    // 找最新月份
    const months = [...new Set(actuals.map(a => a.month))].sort();
    const latest = months[months.length - 1];
    return actuals.filter(a => a.month === latest);
  }

  function bindEditableCells(container) {
    const cells = container.querySelectorAll('.editable');
    cells.forEach(cell => {
      cell.addEventListener('dblclick', function () {
        const current = this.textContent.trim();
        const input = document.createElement('input');
        input.type = 'number';
        input.value = current;
        input.className = 'cell-input';
        input.style.width = '60px';
        this.textContent = '';
        this.appendChild(input);
        input.focus();

        const finishEdit = async () => {
          const newVal = Number(input.value) || 0;
          this.textContent = newVal;
          // Update state and save
          const team = this.getAttribute('data-team');
          const q = this.getAttribute('data-q');
          if (state && state.plans) {
            const plan = state.plans.find(p => p.team === team);
            if (plan && plan.quarterly) {
              const entry = plan.quarterly.find(x => x.q === q);
              if (entry) {
                entry.budget = newVal;
                await saveState(state);
                await fetchState();
              }
            }
          }
        };

        input.addEventListener('blur', finishEdit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            input.blur();
          } else if (e.key === 'Escape') {
            this.textContent = current;
          }
        });
      });
    });
  }

  function exportExcel() {
    if (!state || !state.plans) {
      SharedUI.toast('无数据可导出', 'warning');
      return;
    }

    // 使用 XLSX (loaded from CDN in platform.html)
    if (typeof XLSX === 'undefined') {
      SharedUI.toast('Excel 组件未加载', 'error');
      return;
    }

    const wsData = [['团队', 'Q1预算', 'Q2预算', 'Q3预算', 'Q4预算', '年均']];
    state.plans.forEach(plan => {
      const q = plan.quarterly || [];
      const q1 = (q.find(x => x.q === 'Q1') || {}).budget || 0;
      const q2 = (q.find(x => x.q === 'Q2') || {}).budget || 0;
      const q3 = (q.find(x => x.q === 'Q3') || {}).budget || 0;
      const q4 = (q.find(x => x.q === 'Q4') || {}).budget || 0;
      const annual = plan.annual ? plan.annual.budget : Math.round((q1 + q2 + q3 + q4) / 4);
      wsData.push([plan.team, q1, q2, q3, q4, annual]);
    });

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '预算计划');
    XLSX.writeFile(wb, `人力预算_${state.year || new Date().getFullYear()}.xlsx`);
    SharedUI.toast('导出成功', 'success');
  }

  /* ---------- 模块接口 ---------- */

  return {
    id: 'budget',
    name: '人力预算管理',
    icon: '💰',
    order: 3,
    sidebar: false, // 不在侧边栏显示，作为仪表盘子页面

    render: render, // 暴露给 DashboardModule 调用

    init(el) { render(el); },
    enter() {},
    leave() {},
    getSummary() {
      if (!state) return { rate: 0, alerts: 0 };
      return { alerts: (state.alerts || []).length };
    }
  };
})();
