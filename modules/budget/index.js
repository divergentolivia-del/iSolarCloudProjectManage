/* modules/budget/index.js — 人力预算管理客户端模块
   渲染为仪表盘子页面 (#/dashboard/budget)。
   提供：年度预算计划表（CRUD）、录入当月实际人数、项目预算追加、
   计划 vs 实际对比图、预算超支预警。
*/

// eslint-disable-next-line no-unused-vars
const BudgetModule = (() => {
  'use strict';

  let state = null;
  let lastContainer = null;

  /* ---------- TEAMS 配置 ---------- */

  function getTeamKeys() {
    if (typeof TEAMS !== 'undefined' && Array.isArray(TEAMS)) {
      return TEAMS.map(function (t) { return t.key; });
    }
    return [];
  }

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
    lastContainer = container;

    await fetchState();
    const data = state || { plans: [], actuals: [], alerts: [], costConfig: { outsourceRate: 30000 } };
    const outsourceRate = (data.costConfig && data.costConfig.outsourceRate) || 30000;

    // 年度预算计划表（含外包成本列）
    let planTableHtml = '';
    if (data.plans && data.plans.length > 0) {
      const rows = data.plans.map(plan => {
        const q = plan.quarterly || [];
        const q1 = q.find(x => x.q === 'Q1') || {};
        const q2 = q.find(x => x.q === 'Q2') || {};
        const q3 = q.find(x => x.q === 'Q3') || {};
        const q4 = q.find(x => x.q === 'Q4') || {};
        const annual = plan.annual || {};
        const outsource = Number(plan.outsource) || 0;
        const outsourceCost = outsource * outsourceRate;
        const outsourceCostDisplay = outsourceCost >= 10000
          ? '¥' + (outsourceCost / 10000).toFixed(1) + '万/月'
          : '¥' + outsourceCost.toLocaleString() + '/月';

        return `<tr>
          <td class="txt">${SharedUI.esc(plan.team)}</td>
          <td>${(q1.regular || 0) + '+' + (q1.outsource || 0)}</td>
          <td>${(q2.regular || 0) + '+' + (q2.outsource || 0)}</td>
          <td>${(q3.regular || 0) + '+' + (q3.outsource || 0)}</td>
          <td>${(q4.regular || 0) + '+' + (q4.outsource || 0)}</td>
          <td>${annual.budget || '—'}</td>
          <td>${outsource}</td>
          <td>${outsourceCostDisplay}</td>
          <td>
            <button class="btn budget-edit-btn" data-team="${SharedUI.esc(plan.team)}">编辑</button>
            <button class="btn danger budget-delete-btn" data-team="${SharedUI.esc(plan.team)}">删除</button>
          </td>
        </tr>`;
      }).join('');

      // 汇总外包成本
      const totalOutsource = data.plans.reduce((sum, p) => sum + (Number(p.outsource) || 0), 0);
      const totalOutsourceCost = totalOutsource * outsourceRate;
      const totalCostDisplay = totalOutsourceCost >= 10000
        ? '¥' + (totalOutsourceCost / 10000).toFixed(1) + '万/月'
        : '¥' + totalOutsourceCost.toLocaleString() + '/月';

      planTableHtml = `
        <div class="budget-section">
          <h3 class="section-title">年度预算计划表</h3>
          <div class="cost-summary">
            <span class="cost-summary-item">外包成本 = 外包人月 × ¥${outsourceRate.toLocaleString()}/人月</span>
            <span class="cost-summary-item">外包总成本: ${totalCostDisplay} (${totalOutsource}人月)</span>
          </div>
          <div class="table-wrapper">
            <table class="data-table budget-table" id="budgetPlanTable">
              <thead>
                <tr>
                  <th>团队</th>
                  <th>Q1(正式+外包)</th>
                  <th>Q2(正式+外包)</th>
                  <th>Q3(正式+外包)</th>
                  <th>Q4(正式+外包)</th>
                  <th>年均</th>
                  <th>外包(人月)</th>
                  <th>外包成本</th>
                  <th>操作</th>
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
          <div class="empty-state-box">
            <p class="empty-hint">暂无预算计划数据</p>
            <p class="empty-desc">点击下方按钮创建您的第一个团队预算计划</p>
            <button class="btn primary" id="addBudgetPlanBtn">+ 新增团队预算</button>
          </div>
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

    // 项目预算追加表
    let projectBudgetHtml = '';
    if (data.projectBudgets && data.projectBudgets.length > 0) {
      const pRows = data.projectBudgets.map(function (pb) {
        const cost = (Number(pb.headcount) || 0) * (Number(pb.duration) || 0) * outsourceRate;
        const costDisplay = cost >= 10000 ? '\u00a5' + (cost / 10000).toFixed(1) + '\u4e07' : '\u00a5' + cost.toLocaleString();
        return '<tr><td>' + SharedUI.esc(pb.projectName) + '</td><td>' + SharedUI.esc(pb.team) +
          '</td><td>' + (pb.headcount || 0) + '</td><td>' + (pb.duration || 0) +
          '\u4e2a\u6708</td><td>' + costDisplay + '</td><td>' + SharedUI.esc(pb.reason || '') + '</td></tr>';
      }).join('');
      projectBudgetHtml = '<div class="budget-section"><h3 class="section-title">\u9879\u76ee\u9884\u7b97\u8ffd\u52a0</h3><div class="table-wrapper"><table class="data-table"><thead><tr><th>\u9879\u76ee\u540d\u79f0</th><th>\u56e2\u961f</th><th>\u4eba\u6570</th><th>\u5de5\u671f</th><th>\u6210\u672c</th><th>\u539f\u56e0</th></tr></thead><tbody>' + pRows + '</tbody></table></div></div>';
    }

    container.innerHTML = `
      <div class="budget-page">
        <div class="page-header">
          <h2 class="page-title">人力预算管理</h2>
          <div class="page-header-actions">
            <button class="btn primary" id="addBudgetPlanHeaderBtn">+ 新增预算</button>
            <button class="btn" id="addActualBtn">录入当月实际人数</button>
            <button class="btn" id="addProjectBudgetBtn">+ 项目预算追加</button>
            <button class="btn" id="budgetExportBtn">导出 Excel</button>
          </div>
        </div>
        ${planTableHtml}
        ${projectBudgetHtml}
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

    // 绑定新增团队预算按钮（空状态时出现）
    const addBudgetBtn = document.getElementById('addBudgetPlanBtn');
    if (addBudgetBtn) {
      addBudgetBtn.addEventListener('click', showAddPlanForm);
    }

    // 绑定页头新增预算按钮
    const addPlanHeaderBtn = document.getElementById('addBudgetPlanHeaderBtn');
    if (addPlanHeaderBtn) {
      addPlanHeaderBtn.addEventListener('click', showAddPlanForm);
    }

    // 绑定录入当月实际人数按钮
    const addActualBtn = document.getElementById('addActualBtn');
    if (addActualBtn) {
      addActualBtn.addEventListener('click', showAddActualForm);
    }

    // 绑定项目预算追加按钮
    const addProjectBudgetBtn = document.getElementById('addProjectBudgetBtn');
    if (addProjectBudgetBtn) {
      addProjectBudgetBtn.addEventListener('click', showAddProjectBudgetForm);
    }

    // 绑定编辑按钮
    container.querySelectorAll('.budget-edit-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var team = this.getAttribute('data-team');
        showEditPlanForm(team);
      });
    });

    // 绑定删除按钮
    container.querySelectorAll('.budget-delete-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var team = this.getAttribute('data-team');
        deletePlan(team);
      });
    });
  }

  /* ---------- CRUD 表单 ---------- */

  function buildTeamOptions(selectedTeam) {
    var teams = getTeamKeys();
    return teams.map(function (t) {
      var sel = t === selectedTeam ? ' selected' : '';
      return '<option value="' + SharedUI.esc(t) + '"' + sel + '>' + SharedUI.esc(t) + '</option>';
    }).join('');
  }

  function showAddPlanForm() {
    var teamOptions = buildTeamOptions('');
    var formHtml = '<form id="budgetPlanForm" class="form-grid">' +
      '<div class="form-row"><label>\u56e2\u961f *</label><select id="bf-team">' + teamOptions + '</select></div>' +
      '<div class="form-row"><label>Q1\u6b63\u5f0f(\u4eba\u6708)</label><input type="number" id="bf-q1r" value="0" min="0"></div>' +
      '<div class="form-row"><label>Q1\u5916\u5305(\u4eba\u6708)</label><input type="number" id="bf-q1o" value="0" min="0"></div>' +
      '<div class="form-row"><label>Q2\u6b63\u5f0f(\u4eba\u6708)</label><input type="number" id="bf-q2r" value="0" min="0"></div>' +
      '<div class="form-row"><label>Q2\u5916\u5305(\u4eba\u6708)</label><input type="number" id="bf-q2o" value="0" min="0"></div>' +
      '<div class="form-row"><label>Q3\u6b63\u5f0f(\u4eba\u6708)</label><input type="number" id="bf-q3r" value="0" min="0"></div>' +
      '<div class="form-row"><label>Q3\u5916\u5305(\u4eba\u6708)</label><input type="number" id="bf-q3o" value="0" min="0"></div>' +
      '<div class="form-row"><label>Q4\u6b63\u5f0f(\u4eba\u6708)</label><input type="number" id="bf-q4r" value="0" min="0"></div>' +
      '<div class="form-row"><label>Q4\u5916\u5305(\u4eba\u6708)</label><input type="number" id="bf-q4o" value="0" min="0"></div>' +
      '</form>';

    SharedUI.confirm('\u65b0\u589e\u56e2\u961f\u9884\u7b97', formHtml, function () {
      submitPlanForm(true, null);
    }, { confirmText: '\u4fdd\u5b58', cancelText: '\u53d6\u6d88' });
  }

  function showEditPlanForm(team) {
    if (!state || !state.plans) return;
    var plan = state.plans.find(function (p) { return p.team === team; });
    if (!plan) return;
    var q = plan.quarterly || [];
    var q1 = q.find(function (x) { return x.q === 'Q1'; }) || {};
    var q2 = q.find(function (x) { return x.q === 'Q2'; }) || {};
    var q3 = q.find(function (x) { return x.q === 'Q3'; }) || {};
    var q4 = q.find(function (x) { return x.q === 'Q4'; }) || {};

    var teamOptions = buildTeamOptions(team);
    var formHtml = '<form id="budgetPlanForm" class="form-grid">' +
      '<div class="form-row"><label>\u56e2\u961f</label><select id="bf-team" disabled>' + teamOptions + '</select></div>' +
      '<div class="form-row"><label>Q1\u6b63\u5f0f(\u4eba\u6708)</label><input type="number" id="bf-q1r" value="' + (q1.regular || 0) + '" min="0"></div>' +
      '<div class="form-row"><label>Q1\u5916\u5305(\u4eba\u6708)</label><input type="number" id="bf-q1o" value="' + (q1.outsource || 0) + '" min="0"></div>' +
      '<div class="form-row"><label>Q2\u6b63\u5f0f(\u4eba\u6708)</label><input type="number" id="bf-q2r" value="' + (q2.regular || 0) + '" min="0"></div>' +
      '<div class="form-row"><label>Q2\u5916\u5305(\u4eba\u6708)</label><input type="number" id="bf-q2o" value="' + (q2.outsource || 0) + '" min="0"></div>' +
      '<div class="form-row"><label>Q3\u6b63\u5f0f(\u4eba\u6708)</label><input type="number" id="bf-q3r" value="' + (q3.regular || 0) + '" min="0"></div>' +
      '<div class="form-row"><label>Q3\u5916\u5305(\u4eba\u6708)</label><input type="number" id="bf-q3o" value="' + (q3.outsource || 0) + '" min="0"></div>' +
      '<div class="form-row"><label>Q4\u6b63\u5f0f(\u4eba\u6708)</label><input type="number" id="bf-q4r" value="' + (q4.regular || 0) + '" min="0"></div>' +
      '<div class="form-row"><label>Q4\u5916\u5305(\u4eba\u6708)</label><input type="number" id="bf-q4o" value="' + (q4.outsource || 0) + '" min="0"></div>' +
      '</form>';

    SharedUI.confirm('\u7f16\u8f91\u56e2\u961f\u9884\u7b97: ' + team, formHtml, function () {
      submitPlanForm(false, team);
    }, { confirmText: '\u4fdd\u5b58', cancelText: '\u53d6\u6d88' });
  }

  async function submitPlanForm(isNew, existingTeam) {
    var teamEl = document.getElementById('bf-team');
    var team = teamEl ? teamEl.value : '';
    if (!team) { SharedUI.toast('\u8bf7\u9009\u62e9\u56e2\u961f', 'warning'); return; }

    var q1r = Number(document.getElementById('bf-q1r').value) || 0;
    var q1o = Number(document.getElementById('bf-q1o').value) || 0;
    var q2r = Number(document.getElementById('bf-q2r').value) || 0;
    var q2o = Number(document.getElementById('bf-q2o').value) || 0;
    var q3r = Number(document.getElementById('bf-q3r').value) || 0;
    var q3o = Number(document.getElementById('bf-q3o').value) || 0;
    var q4r = Number(document.getElementById('bf-q4r').value) || 0;
    var q4o = Number(document.getElementById('bf-q4o').value) || 0;

    var totalOutsource = Math.round((q1o + q2o + q3o + q4o) / 4);
    var annualBudget = Math.round(((q1r + q1o) + (q2r + q2o) + (q3r + q3o) + (q4r + q4o)) / 4);

    var plan = {
      team: team,
      quarterly: [
        { q: 'Q1', budget: q1r + q1o, regular: q1r, outsource: q1o },
        { q: 'Q2', budget: q2r + q2o, regular: q2r, outsource: q2o },
        { q: 'Q3', budget: q3r + q3o, regular: q3r, outsource: q3o },
        { q: 'Q4', budget: q4r + q4o, regular: q4r, outsource: q4o }
      ],
      annual: { budget: annualBudget },
      outsource: totalOutsource
    };

    var newState = Object.assign({}, state || {});
    if (!newState.plans) newState.plans = [];
    if (!newState.costConfig) newState.costConfig = { outsourceRate: 30000 };

    if (isNew) {
      if (newState.plans.find(function (p) { return p.team === team; })) {
        SharedUI.toast('\u8be5\u56e2\u961f\u5df2\u5b58\u5728\u9884\u7b97\u8ba1\u5212', 'warning');
        return;
      }
      newState.plans.push(plan);
    } else {
      newState.plans = newState.plans.map(function (p) { return p.team === existingTeam ? plan : p; });
    }

    var ok = await saveState(newState);
    if (ok) { await fetchState(); render(lastContainer); }
  }

  async function deletePlan(team) {
    if (!state || !state.plans) return;
    SharedUI.confirm('\u5220\u9664\u786e\u8ba4', '<p>\u786e\u5b9a\u5220\u9664\u56e2\u961f "' + SharedUI.esc(team) + '" \u7684\u9884\u7b97\u8ba1\u5212\u5417\uff1f</p>', async function () {
      var newState = Object.assign({}, state);
      newState.plans = newState.plans.filter(function (p) { return p.team !== team; });
      var ok = await saveState(newState);
      if (ok) { await fetchState(); render(lastContainer); }
    }, { confirmText: '\u5220\u9664', cancelText: '\u53d6\u6d88', confirmClass: 'danger' });
  }

  function showAddActualForm() {
    var teamOptions = buildTeamOptions('');
    var today = new Date();
    var defaultMonth = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
    var formHtml = '<form id="actualForm" class="form-grid">' +
      '<div class="form-row"><label>\u56e2\u961f *</label><select id="af-team">' + teamOptions + '</select></div>' +
      '<div class="form-row"><label>\u6708\u4efd(YYYY-MM)</label><input type="text" id="af-month" value="' + defaultMonth + '" placeholder="2026-07"></div>' +
      '<div class="form-row"><label>\u6b63\u5f0f\u4eba\u6570</label><input type="number" id="af-regular" value="0" min="0"></div>' +
      '<div class="form-row"><label>\u5916\u5305\u4eba\u6570</label><input type="number" id="af-outsource" value="0" min="0"></div>' +
      '</form>';

    SharedUI.confirm('\u5f55\u5165\u5f53\u6708\u5b9e\u9645\u4eba\u6570', formHtml, async function () {
      var team = document.getElementById('af-team').value;
      var month = document.getElementById('af-month').value.trim();
      var regular = Number(document.getElementById('af-regular').value) || 0;
      var outsource = Number(document.getElementById('af-outsource').value) || 0;

      if (!team || !month) { SharedUI.toast('\u56e2\u961f\u548c\u6708\u4efd\u4e0d\u80fd\u4e3a\u7a7a', 'warning'); return; }
      if (!/^\d{4}-\d{2}$/.test(month)) { SharedUI.toast('\u6708\u4efd\u683c\u5f0f\u5e94\u4e3a YYYY-MM', 'warning'); return; }

      var newState = Object.assign({}, state || {});
      if (!newState.actuals) newState.actuals = [];
      if (!newState.costConfig) newState.costConfig = { outsourceRate: 30000 };

      // 查找是否已有同团队同月数据
      var idx = newState.actuals.findIndex(function (a) { return a.team === team && a.month === month; });
      var entry = { team: team, month: month, regular: regular, outsource: outsource, total: regular + outsource };
      if (idx >= 0) {
        newState.actuals[idx] = entry;
      } else {
        newState.actuals.push(entry);
      }

      var ok = await saveState(newState);
      if (ok) { await fetchState(); render(lastContainer); }
    }, { confirmText: '\u4fdd\u5b58', cancelText: '\u53d6\u6d88' });
  }

  function showAddProjectBudgetForm() {
    var teamOptions = buildTeamOptions('');
    var formHtml = '<form id="projectBudgetForm" class="form-grid">' +
      '<div class="form-row"><label>\u9879\u76ee\u540d\u79f0 *</label><input type="text" id="pbf-name" placeholder="\u9879\u76ee\u540d\u79f0"></div>' +
      '<div class="form-row"><label>\u56e2\u961f *</label><select id="pbf-team">' + teamOptions + '</select></div>' +
      '<div class="form-row"><label>\u4eba\u6570</label><input type="number" id="pbf-headcount" value="1" min="1"></div>' +
      '<div class="form-row"><label>\u5de5\u671f(\u6708)</label><input type="number" id="pbf-duration" value="3" min="1"></div>' +
      '<div class="form-row"><label>\u539f\u56e0</label><select id="pbf-reason"><option value="\u89c4\u5212\u5916\u9879\u76ee">\u89c4\u5212\u5916\u9879\u76ee</option><option value="\u4eba\u529b\u7f3a\u53e3">\u4eba\u529b\u7f3a\u53e3</option></select></div>' +
      '</form>';

    SharedUI.confirm('\u9879\u76ee\u9884\u7b97\u8ffd\u52a0', formHtml, async function () {
      var name = (document.getElementById('pbf-name').value || '').trim();
      var team = document.getElementById('pbf-team').value;
      var headcount = Number(document.getElementById('pbf-headcount').value) || 1;
      var duration = Number(document.getElementById('pbf-duration').value) || 1;
      var reason = document.getElementById('pbf-reason').value;

      if (!name) { SharedUI.toast('\u9879\u76ee\u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a', 'warning'); return; }
      if (!team) { SharedUI.toast('\u8bf7\u9009\u62e9\u56e2\u961f', 'warning'); return; }

      var newState = Object.assign({}, state || {});
      if (!newState.projectBudgets) newState.projectBudgets = [];
      if (!newState.costConfig) newState.costConfig = { outsourceRate: 30000 };

      newState.projectBudgets.push({
        id: 'pb-' + Date.now().toString(36),
        projectName: name,
        team: team,
        headcount: headcount,
        duration: duration,
        reason: reason
      });

      var ok = await saveState(newState);
      if (ok) { await fetchState(); render(lastContainer); }
    }, { confirmText: '\u4fdd\u5b58', cancelText: '\u53d6\u6d88' });
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
