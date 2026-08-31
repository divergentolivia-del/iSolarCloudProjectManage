/* modules/project/index.js — 全年度项目管理客户端模块
   提供项目列表、新增/编辑、详情子页面。
   路由：#/project（列表）, #/project/detail/{id}（详情）
*/

// eslint-disable-next-line no-unused-vars
const ProjectModule = (() => {
  'use strict';

  let container = null;
  let state = null;
  let currentView = 'list'; // 'list' | 'detail'
  let currentProjectId = null;
  let currentListView = 'list'; // 'list' | 'timeline' | 'release'

  const STATUS_LABELS = {
    'planned': '计划中',
    'in-progress': '进行中',
    'completed': '已完成',
    'suspended': '已暂停'
  };

  const STATUS_CLASSES = {
    'planned': 'status-planned',
    'in-progress': 'status-active',
    'completed': 'status-done',
    'suspended': 'status-hold'
  };

  const PRIORITY_LABELS = {
    'high': '高',
    'medium': '中',
    'low': '低'
  };

  /* ---------- 数据获取 ---------- */

  async function fetchState() {
    try {
      const resp = await fetch('/api/project/state');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      state = await resp.json();
      return state;
    } catch (e) {
      console.error('[project] 获取数据失败:', e.message);
      return null;
    }
  }

  async function saveState(newState, by) {
    try {
      const resp = await fetch('/api/project/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseRev: state ? state.rev : 0,
          state: newState,
          by: by || (typeof Platform !== 'undefined' ? Platform.whoami() : '未署名')
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

  /* ---------- 渲染函数 ---------- */

  function renderList() {
    if (!container || !state) return;

    const projects = state.projects || [];
    const year = targetYear();
    const releaseItems = collectReleaseItems(projects, year);
    const releaseMap = {};
    releaseItems.forEach(item => { releaseMap[item.id] = item; });
    const releaseSummary = summarizeReleasePlan(releaseItems);
    const releaseConflicts = analyzeReleaseConflicts(releaseItems);

    const statusCounts = { planned: 0, 'in-progress': 0, completed: 0, suspended: 0 };
    projects.forEach(p => { if (statusCounts[p.status] !== undefined) statusCounts[p.status]++; });
    const total = projects.length || 1;
    const statusBar = projects.length ? `
      <div class="status-summary project-status-summary">
        <div class="status-bar">
          ${statusCounts.planned ? `<span class="status-segment planned" style="width:${(statusCounts.planned / total * 100).toFixed(1)}%">计划中 ${statusCounts.planned}</span>` : ''}
          ${statusCounts['in-progress'] ? `<span class="status-segment active" style="width:${(statusCounts['in-progress'] / total * 100).toFixed(1)}%">进行中 ${statusCounts['in-progress']}</span>` : ''}
          ${statusCounts.completed ? `<span class="status-segment done" style="width:${(statusCounts.completed / total * 100).toFixed(1)}%">已完成 ${statusCounts.completed}</span>` : ''}
          ${statusCounts.suspended ? `<span class="status-segment hold" style="width:${(statusCounts.suspended / total * 100).toFixed(1)}%">暂停 ${statusCounts.suspended}</span>` : ''}
        </div>
      </div>` : '';

    const overviewHtml = `
      <section class="project-overview" id="project-overview">
        <div class="project-overview-grid">
          ${SharedUI.renderMetricCard('📌', '项目总数', String(projects.length), projects.length ? 'normal' : 'hold', projects.length ? '已录入台账' : '待录入')}
          ${SharedUI.renderMetricCard('🟢', '在研项目', String(statusCounts['in-progress']), statusCounts['in-progress'] ? 'ok' : 'normal', statusCounts['in-progress'] ? '执行中' : '暂无')}
          ${SharedUI.renderMetricCard('🗓️', '年度发布项', String(releaseSummary.dated.length + releaseSummary.missingDate), releaseSummary.missingDate ? 'warn' : 'normal', releaseSummary.missingDate ? '有未填日期' : '日期完整')}
          ${SharedUI.renderMetricCard('⚠️', '发布冲突', String(releaseConflicts.length), releaseConflicts.length ? 'warn' : 'ok', releaseConflicts.length ? '需协调' : '暂无明显冲突')}
        </div>
        ${statusBar}
      </section>`;

    const ledgerHtml = buildProjectLedger(projects, releaseMap);
    const timelineHtml = `<div class="project-view-panel" id="project-timeline">
      <div class="section-head">
        <div>
          <div class="section-kicker">项目周期视图</div>
          <h3 class="section-title">全年项目周期</h3>
        </div>
        <div class="section-note">按项目状态展示开始与结束窗口，用于看资源占用时段。</div>
      </div>
      ${buildTimelineView(projects)}
    </div>`;
    const releaseHtml = buildReleaseBoard(releaseItems, year, releaseSummary, releaseConflicts) + ledgerHtml;

    const mainViewHtml = currentListView === 'release'
      ? releaseHtml
      : currentListView === 'timeline'
        ? timelineHtml + ledgerHtml
        : ledgerHtml;

    container.innerHTML = `
      <div class="project-page">
        <section class="project-shell">
          <div class="project-shell-copy">
            <div class="project-kicker">年度项目管理 / 发布协同</div>
            <h2 class="page-title">全年度项目管理</h2>
            <p class="project-shell-desc">把阳光云、乐充云的平台升级和业务版本放到同一张图里，提前发现发布窗口、底层变更和业务上线冲突。</p>
          </div>
          <div class="project-shell-actions">
            <a class="btn ${currentListView === 'list' ? 'primary' : ''}" href="#/project" aria-current="${currentListView === 'list' ? 'page' : 'false'}">台账</a>
            <a class="btn ${currentListView === 'timeline' ? 'primary' : ''}" href="#/project/timeline" aria-current="${currentListView === 'timeline' ? 'page' : 'false'}">周期</a>
            <a class="btn ${currentListView === 'release' ? 'primary' : ''}" href="#/project/release" aria-current="${currentListView === 'release' ? 'page' : 'false'}">年度发布</a>
            <button class="btn primary" id="addProjectBtn">+ 新增项目</button>
          </div>
        </section>

        <nav class="project-anchor-nav" aria-label="项目模块二级导航">
          <a href="#/project" class="project-anchor ${currentListView === 'list' ? 'active' : ''}">项目台账</a>
          <a href="#/project/timeline" class="project-anchor ${currentListView === 'timeline' ? 'active' : ''}">周期视图</a>
          <a href="#/project/release" class="project-anchor ${currentListView === 'release' ? 'active' : ''}">年度发布视图</a>
        </nav>

        ${overviewHtml}
        ${mainViewHtml}
      </div>`;

    const addBtn = document.getElementById('addProjectBtn');
    if (addBtn) addBtn.addEventListener('click', showAddForm);
  }  /* Timeline view: horizontal bars by status */
  function buildTimelineView(projects) {
    if (!projects.length) return '<p class="empty-hint">暂无项目数据</p>';

    // Determine year range for positioning
    const year = targetYear();
    const yearStart = new Date(year, 0, 1).getTime();
    const yearEnd = new Date(year, 11, 31).getTime();
    const yearSpan = yearEnd - yearStart;

    // Month labels
    const months = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    const monthMarkers = months.map((m, i) =>
      `<span class="timeline-month" style="left:${(i / 12 * 100).toFixed(1)}%">${m}</span>`
    ).join('');

    // Group by status
    const groups = [
      { key: 'in-progress', label: '进行中', cls: 'in-progress' },
      { key: 'planned', label: '计划中', cls: 'planned' },
      { key: 'completed', label: '已完成', cls: 'completed' },
      { key: 'suspended', label: '已暂停', cls: 'suspended' }
    ];

    let html = `<div class="timeline-container">
      <div class="timeline-header">
        <span class="timeline-label" style="font-weight:600">项目</span>
        <div class="timeline-track" style="position:relative;height:20px">${monthMarkers}</div>
      </div>`;

    groups.forEach(g => {
      const items = projects.filter(p => p.status === g.key);
      if (!items.length) return;
      html += `<div class="timeline-group-label">${SharedUI.esc(g.label)} (${items.length})</div>`;
      items.forEach(p => {
        let left = 0, width = 100;
        if (p.startDate) {
          const startMs = new Date(p.startDate).getTime();
          left = Math.max(0, Math.min(100, (startMs - yearStart) / yearSpan * 100));
        }
        if (p.endDate) {
          const endMs = new Date(p.endDate).getTime();
          const right = Math.max(0, Math.min(100, (endMs - yearStart) / yearSpan * 100));
          width = Math.max(2, right - left);
        } else {
          width = Math.max(2, 100 - left);
        }
        const dates = (p.startDate || '?') + ' ~ ' + (p.endDate || '?');
        html += `
          <div class="timeline-row">
            <span class="timeline-label">${SharedUI.esc(p.name || '')}</span>
            <div class="timeline-track">
              <div class="timeline-bar ${g.cls}" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%">
                <span class="bar-dates">${SharedUI.esc(dates)}</span>
              </div>
            </div>
          </div>`;
      });
    });

    html += '</div>';
    return html;
  }

  function renderDetail(projectId) {
    if (!container || !state) return;

    const project = (state.projects || []).find(p => p.id === projectId);
    if (!project) {
      container.innerHTML = `
        <div class="project-page">
          <p class="empty-hint">未找到项目: ${SharedUI.esc(projectId)}</p>
          <a href="#/project" class="btn">返回列表</a>
        </div>
      `;
      return;
    }

    const releaseDate = inferReleaseDate(project);
    const releaseParsed = parseDateValue(releaseDate);
    const releaseLayer = inferReleaseLayer(project);
    const releaseRisk = project.releaseRisk && RELEASE_RISK_LABELS[project.releaseRisk] ? project.releaseRisk : 'low';
    const releaseProduct = inferReleaseProduct(project);
    const releaseVersion = project.releaseVersion || project.name || '—';
    const releasePlanHtml = `
        <div class="detail-section release-detail-section">
          <div class="section-head compact">
            <div>
              <div class="section-kicker">年度发布计划</div>
              <h4>发布协同信息</h4>
            </div>
            <span class="release-risk-badge ${SharedUI.esc(RELEASE_RISK_CLASSES[releaseRisk] || 'release-risk-low')}">${SharedUI.esc(RELEASE_RISK_LABELS[releaseRisk] || '正常')}</span>
          </div>
          <div class="release-detail-grid">
            <div class="release-detail-item"><span>发布产品</span><strong>${SharedUI.esc(releaseProduct || '—')}</strong></div>
            <div class="release-detail-item"><span>版本标识</span><strong>${SharedUI.esc(releaseVersion)}</strong></div>
            <div class="release-detail-item"><span>发布层级</span><strong>${SharedUI.esc(RELEASE_LAYER_LABELS[releaseLayer] || releaseLayer)}</strong></div>
            <div class="release-detail-item ${releaseParsed ? '' : 'release-date-missing'}"><span>计划发布日</span><strong>${SharedUI.esc(releaseParsed ? releaseParsed.text : (releaseDate || '未设置'))}</strong></div>
            <div class="release-detail-item release-detail-wide"><span>影响范围</span><strong>${SharedUI.esc(project.impactScope || '未填写')}</strong></div>
            <div class="release-detail-item release-detail-wide"><span>依赖 / 底层变更</span><strong>${SharedUI.esc(project.dependency || '未填写')}</strong></div>
          </div>
        </div>`;
    // 里程碑时间线 with action buttons
    const milestones = (project.milestones || []).map((ms, idx) => {
      const statusIcon = ms.status === 'done' ? '✅' : ms.status === 'in-progress' ? '🔵' : '⚪';
      const today = new Date().toISOString().slice(0, 10);
      const overdue = ms.status !== 'done' && ms.date && ms.date < today;
      const cls = overdue ? 'overdue' : '';
      const doneDisabled = ms.status === 'done' ? 'disabled' : '';
      return `<li class="milestone-item ${cls}">
        <span class="ms-icon">${statusIcon}</span>
        <span class="ms-name">${SharedUI.esc(ms.name || '')}</span>
        <span class="ms-date">${SharedUI.esc(ms.date || '')}</span>
        ${overdue ? '<span class="ms-overdue">逾期</span>' : ''}
        <span class="ms-actions" style="margin-left:auto;display:flex;gap:4px;white-space:nowrap">
          <button class="btn" style="padding:2px 6px;font-size:12px" ${doneDisabled} data-ms-done="${idx}">标记完成</button>
          <button class="btn" style="padding:2px 6px;font-size:12px" data-ms-edit="${idx}">编辑</button>
          <button class="btn" style="padding:2px 6px;font-size:12px" data-ms-del="${idx}">删除</button>
        </span>
      </li>`;
    }).join('');

    // 资源摘要
    let resourceHtml = '';
    if (project.resourceSummary) {
      const rs = project.resourceSummary;
      const pct = rs.totalManMonths ? Math.round(rs.usedManMonths / rs.totalManMonths * 100) : 0;
      const costPct = rs.totalCost ? Math.round((rs.usedCost || 0) / rs.totalCost * 100) : 0;
      const teamRows = rs.teams ? Object.entries(rs.teams).map(([team, months]) =>
        `<tr><td>${SharedUI.esc(team)}</td><td>${months} 人月</td></tr>`
      ).join('') : '';

      resourceHtml = `
        <div class="detail-section">
          <h4>人力规划 & 成本预算</h4>
          <div class="resource-grid">
            <div class="resource-item"><span class="resource-item-label">预计总人力</span><span class="resource-item-value">${rs.totalManMonths || 0} 人月</span></div>
            <div class="resource-item"><span class="resource-item-label">已投入人力</span><span class="resource-item-value">${rs.usedManMonths || 0} 人月 (${pct}%)</span></div>
            <div class="resource-item"><span class="resource-item-label">预计总成本</span><span class="resource-item-value">${rs.totalCost || 0}万元</span></div>
            <div class="resource-item"><span class="resource-item-label">已使用成本</span><span class="resource-item-value">${rs.usedCost || 0}万元 (${costPct}%)</span></div>
            <div class="resource-item"><span class="resource-item-label">外包人数</span><span class="resource-item-value">${rs.outsourceCount || 0} 人</span></div>
            <div class="resource-item"><span class="resource-item-label">预计工期</span><span class="resource-item-value">${rs.durationMonths || 0} 个月</span></div>
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(100, pct)}%"></div></div>
          ${teamRows ? `<table class="mini-table"><thead><tr><th>团队</th><th>投入</th></tr></thead><tbody>${teamRows}</tbody></table>` : ''}
        </div>
      `;
    }

    container.innerHTML = `
      <div class="project-page project-detail">
        <div class="page-header">
          <a href="#/project" class="btn back-btn">← 返回列表</a>
          <button class="btn primary" id="editProjectBtn">编辑</button>
        </div>
        <h2 class="project-name">${SharedUI.esc(project.name || '')}</h2>
        <div class="project-meta">
          <span class="badge ${STATUS_CLASSES[project.status] || ''}">${SharedUI.esc(STATUS_LABELS[project.status] || project.status)}</span>
          <span class="meta-item">产品线: ${SharedUI.esc(project.productLine || '—')}</span>
          <span class="meta-item">负责人: ${SharedUI.esc(project.owner || '—')}</span>
          <span class="meta-item">优先级: ${SharedUI.esc(PRIORITY_LABELS[project.priority] || '—')}</span>
          <span class="meta-item">周期: ${SharedUI.esc(project.startDate || '—')} ~ ${SharedUI.esc(project.endDate || '—')}</span>
        </div>

        ${releasePlanHtml}

        <div class="detail-section">
          <h4>里程碑</h4>
          ${milestones ? `<ul class="milestone-list">${milestones}</ul>` : '<p class="empty-hint">暂无里程碑</p>'}
          <button class="btn" id="addMilestoneBtn" style="margin-top:8px">+ 添加里程碑</button>
        </div>

        ${resourceHtml}

        ${project.note ? `<div class="detail-section"><h4>备注</h4><p>${SharedUI.esc(project.note)}</p></div>` : ''}
      </div>
    `;

    // 绑定编辑按钮
    const editBtn = document.getElementById('editProjectBtn');
    if (editBtn) {
      editBtn.addEventListener('click', () => showEditForm(project));
    }

    // 绑定里程碑操作按钮
    container.querySelectorAll('[data-ms-done]').forEach(btn => {
      btn.addEventListener('click', () => markMilestoneDone(project, +btn.dataset.msDone));
    });
    container.querySelectorAll('[data-ms-edit]').forEach(btn => {
      btn.addEventListener('click', () => showEditMilestone(project, +btn.dataset.msEdit));
    });
    container.querySelectorAll('[data-ms-del]').forEach(btn => {
      btn.addEventListener('click', () => deleteMilestone(project, +btn.dataset.msDel));
    });
    const addMsBtn = document.getElementById('addMilestoneBtn');
    if (addMsBtn) addMsBtn.addEventListener('click', () => showAddMilestone(project));
  }

  /* ---------- 里程碑操作 ---------- */

  async function markMilestoneDone(project, idx) {
    if (!project.milestones || !project.milestones[idx]) return;
    project.milestones[idx].status = 'done';
    const newState = { ...state };
    newState.projects = (state.projects || []).map(p => p.id === project.id ? project : p);
    const ok = await saveState(newState);
    if (ok) { await fetchState(); renderDetail(project.id); }
  }

  async function deleteMilestone(project, idx) {
    if (!project.milestones || !project.milestones[idx]) return;
    if (!window.confirm('确定删除此里程碑？')) return;
    project.milestones.splice(idx, 1);
    const newState = { ...state };
    newState.projects = (state.projects || []).map(p => p.id === project.id ? project : p);
    const ok = await saveState(newState);
    if (ok) { await fetchState(); renderDetail(project.id); }
  }

  function showEditMilestone(project, idx) {
    const ms = (project.milestones || [])[idx];
    if (!ms) return;
    const formHtml = `
      <form id="milestoneForm" class="form-grid">
        <div class="form-row"><label>名称</label><input type="text" id="ms-name" value="${SharedUI.esc(ms.name || '')}"></div>
        <div class="form-row"><label>日期</label><input type="text" id="ms-date" value="${SharedUI.esc(ms.date || '')}" placeholder="YYYY-MM-DD"></div>
        <div class="form-row"><label>状态</label><select id="ms-status">
          <option value="pending" ${ms.status === 'pending' ? 'selected' : ''}>待完成</option>
          <option value="in-progress" ${ms.status === 'in-progress' ? 'selected' : ''}>进行中</option>
          <option value="done" ${ms.status === 'done' ? 'selected' : ''}>已完成</option>
        </select></div>
      </form>`;
    SharedUI.confirm('编辑里程碑', formHtml, async () => {
      const name = document.getElementById('ms-name')?.value?.trim();
      const date = document.getElementById('ms-date')?.value?.trim();
      const status = document.getElementById('ms-status')?.value;
      if (!name) { SharedUI.toast('名称不能为空', 'warning'); return; }
      project.milestones[idx] = { name, date: date || '', status: status || 'pending' };
      const newState = { ...state };
      newState.projects = (state.projects || []).map(p => p.id === project.id ? project : p);
      const ok = await saveState(newState);
      if (ok) { await fetchState(); renderDetail(project.id); }
    }, { confirmText: '保存', cancelText: '取消' });
  }

  function showAddMilestone(project) {
    const formHtml = `
      <form id="milestoneForm" class="form-grid">
        <div class="form-row"><label>名称</label><input type="text" id="ms-name" value="" placeholder="里程碑名称"></div>
        <div class="form-row"><label>日期</label><input type="text" id="ms-date" value="" placeholder="YYYY-MM-DD"></div>
        <div class="form-row"><label>状态</label><select id="ms-status">
          <option value="pending" selected>待完成</option>
          <option value="in-progress">进行中</option>
          <option value="done">已完成</option>
        </select></div>
      </form>`;
    SharedUI.confirm('添加里程碑', formHtml, async () => {
      const name = document.getElementById('ms-name')?.value?.trim();
      const date = document.getElementById('ms-date')?.value?.trim();
      const status = document.getElementById('ms-status')?.value;
      if (!name) { SharedUI.toast('名称不能为空', 'warning'); return; }
      if (!project.milestones) project.milestones = [];
      project.milestones.push({ name, date: date || '', status: status || 'pending' });
      const newState = { ...state };
      newState.projects = (state.projects || []).map(p => p.id === project.id ? project : p);
      const ok = await saveState(newState);
      if (ok) { await fetchState(); renderDetail(project.id); }
    }, { confirmText: '添加', cancelText: '取消' });
  }

  /* ---------- 表单 ---------- */

  function showAddForm() {
    const formHtml = buildFormHtml({
      id: 'proj-' + Date.now().toString(36),
      name: '',
      productLine: '',
      status: 'planned',
      priority: 'medium',
      owner: '',
      startDate: '',
      endDate: '',
      releaseVersion: '',
      releaseProduct: '',
      releaseLayer: 'business',
      releaseDate: '',
      releaseRisk: 'low',
      impactScope: '',
      dependency: '',
      note: ''
    }, '新增项目');

    SharedUI.confirm('新增项目', formHtml, () => {
      submitForm(true);
    }, { confirmText: '保存', cancelText: '取消' });
  }

  function showEditForm(project) {
    const formHtml = buildFormHtml(project, '编辑项目');
    SharedUI.confirm('编辑项目', formHtml, () => {
      submitForm(false, project.id);
    }, { confirmText: '保存', cancelText: '取消' });
  }

  function buildFormHtml(proj, title) {
    const statusOptions = Object.entries(STATUS_LABELS).map(([k, v]) =>
      `<option value="${k}" ${k === proj.status ? 'selected' : ''}>${v}</option>`
    ).join('');
    const priorityOptions = Object.entries(PRIORITY_LABELS).map(([k, v]) =>
      `<option value="${k}" ${k === proj.priority ? 'selected' : ''}>${v}</option>`
    ).join('');
    const releaseLayer = proj.releaseLayer || 'business';
    const releaseLayerOptions = Object.entries(RELEASE_LAYER_LABELS).map(([k, v]) =>
      `<option value="${k}" ${k === releaseLayer ? 'selected' : ''}>${v}</option>`
    ).join('');
    const releaseRisk = proj.releaseRisk || 'low';
    const releaseRiskOptions = Object.entries(RELEASE_RISK_LABELS).map(([k, v]) =>
      `<option value="${k}" ${k === releaseRisk ? 'selected' : ''}>${v}</option>`
    ).join('');

    const rs = proj.resourceSummary || {};

    return `
      <form id="projectForm" class="form-grid project-form-grid">
        <input type="hidden" id="pf-id" value="${SharedUI.esc(proj.id || '')}">
        <div class="form-row">
          <label>项目名称 *</label>
          <input type="text" id="pf-name" value="${SharedUI.esc(proj.name || '')}" required>
        </div>
        <div class="form-row">
          <label>产品线</label>
          <input type="text" id="pf-productLine" value="${SharedUI.esc(proj.productLine || '')}" placeholder="阳光云 / 乐充云 / 平台共性">
        </div>
        <div class="form-row">
          <label>状态</label>
          <select id="pf-status">${statusOptions}</select>
        </div>
        <div class="form-row">
          <label>优先级</label>
          <select id="pf-priority">${priorityOptions}</select>
        </div>
        <div class="form-row">
          <label>负责人</label>
          <input type="text" id="pf-owner" value="${SharedUI.esc(proj.owner || '')}">
        </div>
        <div class="form-row">
          <label>开始日期</label>
          <input type="text" id="pf-startDate" value="${SharedUI.esc(proj.startDate || '')}" placeholder="YYYY-MM 或 YYYY-MM-DD">
        </div>
        <div class="form-row">
          <label>结束日期</label>
          <input type="text" id="pf-endDate" value="${SharedUI.esc(proj.endDate || '')}" placeholder="YYYY-MM 或 YYYY-MM-DD">
        </div>

        <div class="form-row form-section"><label>年度发布计划</label></div>
        <div class="form-row">
          <label>版本标识</label>
          <input type="text" id="pf-releaseVersion" value="${SharedUI.esc(proj.releaseVersion || '')}" placeholder="例如：阳光云 2026-9.17 版本">
        </div>
        <div class="form-row">
          <label>发布产品</label>
          <input type="text" id="pf-releaseProduct" value="${SharedUI.esc(proj.releaseProduct || '')}" placeholder="阳光云 / 乐充云 / 平台共性">
        </div>
        <div class="form-row">
          <label>发布层级</label>
          <select id="pf-releaseLayer">${releaseLayerOptions}</select>
        </div>
        <div class="form-row">
          <label>计划发布日</label>
          <input type="text" id="pf-releaseDate" value="${SharedUI.esc(proj.releaseDate || '')}" placeholder="YYYY-MM-DD">
        </div>
        <div class="form-row">
          <label>发布风险</label>
          <select id="pf-releaseRisk">${releaseRiskOptions}</select>
        </div>
        <div class="form-row form-row-wide">
          <label>影响范围</label>
          <textarea id="pf-impactScope" rows="2" placeholder="会影响哪些业务线、终端、客户或上线窗口">${SharedUI.esc(proj.impactScope || '')}</textarea>
        </div>
        <div class="form-row form-row-wide">
          <label>依赖 / 底层变更</label>
          <textarea id="pf-dependency" rows="2" placeholder="例如：平台接口升级、权限模型、数据结构、灰度依赖">${SharedUI.esc(proj.dependency || '')}</textarea>
        </div>

        <div class="form-row form-section"><label>人力规划</label></div>
        <div class="form-row">
          <label>预计总人力(人月)</label>
          <input type="number" id="pf-totalManMonths" value="${rs.totalManMonths || ''}" min="0">
        </div>
        <div class="form-row">
          <label>已投入人力(人月)</label>
          <input type="number" id="pf-usedManMonths" value="${rs.usedManMonths || ''}" min="0">
        </div>
        <div class="form-row form-row-wide">
          <label>涉及团队(逗号分隔)</label>
          <input type="text" id="pf-teams" value="${SharedUI.esc(rs.teams ? Object.keys(rs.teams).join(',') : '')}" placeholder="APP开发-阳光云,后端开发-阳光云">
        </div>

        <div class="form-row form-section"><label>成本预算</label></div>
        <div class="form-row">
          <label>预计总成本(万元)</label>
          <input type="number" id="pf-totalCost" value="${rs.totalCost || ''}" min="0" step="0.1">
        </div>
        <div class="form-row">
          <label>已使用成本(万元)</label>
          <input type="number" id="pf-usedCost" value="${rs.usedCost || ''}" min="0" step="0.1">
        </div>
        <div class="form-row">
          <label>外包人数</label>
          <input type="number" id="pf-outsourceCount" value="${rs.outsourceCount || ''}" min="0">
        </div>
        <div class="form-row">
          <label>预计工期(月)</label>
          <input type="number" id="pf-durationMonths" value="${rs.durationMonths || ''}" min="0">
        </div>
        <div class="form-row form-row-wide">
          <label>备注</label>
          <textarea id="pf-note" rows="3">${SharedUI.esc(proj.note || '')}</textarea>
        </div>
      </form>
    `;
  }
  async function submitForm(isNew, existingId) {
    const id = document.getElementById('pf-id')?.value || existingId;
    const name = document.getElementById('pf-name')?.value?.trim();
    const productLine = document.getElementById('pf-productLine')?.value?.trim();
    const status = document.getElementById('pf-status')?.value;
    const priority = document.getElementById('pf-priority')?.value;
    const owner = document.getElementById('pf-owner')?.value?.trim();
    const startDate = document.getElementById('pf-startDate')?.value?.trim();
    const endDate = document.getElementById('pf-endDate')?.value?.trim();
    const note = document.getElementById('pf-note')?.value?.trim();

    const releaseVersion = document.getElementById('pf-releaseVersion')?.value?.trim();
    const releaseProduct = document.getElementById('pf-releaseProduct')?.value?.trim();
    const releaseLayer = document.getElementById('pf-releaseLayer')?.value || 'business';
    const releaseDate = document.getElementById('pf-releaseDate')?.value?.trim();
    const releaseRisk = document.getElementById('pf-releaseRisk')?.value || 'low';
    const impactScope = document.getElementById('pf-impactScope')?.value?.trim();
    const dependency = document.getElementById('pf-dependency')?.value?.trim();

    const totalManMonths = Number(document.getElementById('pf-totalManMonths')?.value) || 0;
    const usedManMonths = Number(document.getElementById('pf-usedManMonths')?.value) || 0;
    const teamsStr = (document.getElementById('pf-teams')?.value || '').trim();
    const totalCost = Number(document.getElementById('pf-totalCost')?.value) || 0;
    const usedCost = Number(document.getElementById('pf-usedCost')?.value) || 0;
    const outsourceCount = Number(document.getElementById('pf-outsourceCount')?.value) || 0;
    const durationMonths = Number(document.getElementById('pf-durationMonths')?.value) || 0;

    if (!name) {
      SharedUI.toast('项目名称不能为空', 'warning');
      return;
    }

    if (startDate && endDate && startDate > endDate) {
      SharedUI.toast('开始日期不能晚于结束日期', 'warning');
      return;
    }

    if (releaseDate && !parseDateValue(releaseDate)) {
      SharedUI.toast('计划发布日请使用 YYYY-MM-DD 或 YYYY-MM 格式', 'warning');
      return;
    }

    let resourceSummary = null;
    if (totalManMonths || usedManMonths || totalCost || usedCost || outsourceCount || durationMonths || teamsStr) {
      const teams = {};
      if (teamsStr) {
        teamsStr.split(',').map(function (t) { return t.trim(); }).filter(Boolean).forEach(function (t) {
          teams[t] = 0;
        });
      }
      resourceSummary = {
        totalManMonths: totalManMonths,
        usedManMonths: usedManMonths,
        totalCost: totalCost,
        usedCost: usedCost,
        outsourceCount: outsourceCount,
        durationMonths: durationMonths,
        teams: teams
      };
    }

    const project = {
      id: id,
      name: name,
      productLine: productLine || '',
      status: status || 'planned',
      priority: priority || 'medium',
      owner: owner || '',
      startDate: startDate || '',
      endDate: endDate || '',
      releaseVersion: releaseVersion || '',
      releaseProduct: releaseProduct || '',
      releaseLayer: RELEASE_LAYER_LABELS[releaseLayer] ? releaseLayer : 'business',
      releaseDate: releaseDate || '',
      releaseRisk: RELEASE_RISK_LABELS[releaseRisk] ? releaseRisk : 'low',
      impactScope: impactScope || '',
      dependency: dependency || '',
      note: note || '',
      milestones: [],
      resourceSummary: resourceSummary,
      iterations: []
    };

    if (!isNew && state) {
      const existing = (state.projects || []).find(p => p.id === id);
      if (existing) {
        project.milestones = existing.milestones || [];
        project.iterations = existing.iterations || [];
        if (resourceSummary && existing.resourceSummary && existing.resourceSummary.teams) {
          Object.keys(existing.resourceSummary.teams).forEach(function (k) {
            if (!(k in resourceSummary.teams)) {
              resourceSummary.teams[k] = existing.resourceSummary.teams[k];
            }
          });
        }
      }
    }

    const newState = { ...(state || {}), year: state?.year || new Date().getFullYear() };
    if (isNew) {
      newState.projects = [...(state?.projects || []), project];
    } else {
      newState.projects = (state?.projects || []).map(p => p.id === id ? project : p);
    }

    const ok = await saveState(newState);
    if (ok) {
      await fetchState();
      if (!isNew && currentView === 'detail') {
        renderDetail(id);
      } else {
        renderList();
      }
    }
  }
  const RELEASE_LAYER_LABELS = {
    platform: '平台底座',
    business: '业务版本',
    shared: '公共能力'
  };

  const RELEASE_RISK_LABELS = {
    high: '高风险',
    medium: '需关注',
    low: '正常'
  };

  const RELEASE_RISK_CLASSES = {
    high: 'release-risk-high',
    medium: 'release-risk-medium',
    low: 'release-risk-low'
  };

  const BASE_RELEASE_PRODUCTS = ['阳光云', '乐充云'];
  const RELEASE_CONFLICT_DAYS = 7;
  const PLATFORM_IMPACT_DAYS = 14;

  function targetYear() {
    return Number(state && state.year) || new Date().getFullYear();
  }

  function parseDateValue(value) {
    if (!value) return null;
    const text = String(value).trim();
    const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(text);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3] || 1);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return {
      date,
      year,
      month: month - 1,
      day,
      stamp: date.getTime(),
      text: text.length === 7 ? text + '-01' : text,
      short: (month < 10 ? '0' + month : String(month)) + '-' + (day < 10 ? '0' + day : String(day))
    };
  }

  function daysBetween(a, b) {
    return Math.round(Math.abs(a.stamp - b.stamp) / 86400000);
  }

  function inferReleaseProduct(project) {
    if (project.releaseProduct) return project.releaseProduct;
    const text = [project.productLine, project.name, project.note].filter(Boolean).join(' ');
    if (/乐充/.test(text)) return '乐充云';
    if (/阳光云|iSolarCloud|云平台/.test(text)) return '阳光云';
    return project.productLine || '其他';
  }

  function inferReleaseLayer(project) {
    if (project.releaseLayer && RELEASE_LAYER_LABELS[project.releaseLayer]) return project.releaseLayer;
    const text = [project.productLine, project.name, project.note].filter(Boolean).join(' ');
    if (/平台|底座|中台|网关|基础|架构|公共/.test(text)) return 'platform';
    return 'business';
  }

  function inferReleaseDate(project) {
    if (project.releaseDate) return project.releaseDate;
    const releaseMilestone = (project.milestones || [])
      .filter(ms => /发布|上线|发版|投产|封版/.test(ms.name || '') && ms.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
    return releaseMilestone ? releaseMilestone.date : (project.endDate || '');
  }

  function collectReleaseItems(projects, year) {
    return (projects || []).map(project => {
      const releaseDate = inferReleaseDate(project);
      const parsed = parseDateValue(releaseDate);
      const risk = project.releaseRisk && RELEASE_RISK_LABELS[project.releaseRisk] ? project.releaseRisk : 'low';
      return {
        id: project.id,
        project,
        name: project.name || '',
        version: project.releaseVersion || project.name || '',
        product: inferReleaseProduct(project),
        layer: inferReleaseLayer(project),
        releaseDate,
        parsed,
        risk,
        status: project.status || 'planned',
        owner: project.owner || '',
        impactScope: project.impactScope || '',
        dependency: project.dependency || ''
      };
    }).filter(item => !item.parsed || item.parsed.year === year);
  }

  function orderedReleaseProducts(items) {
    const names = new Set(BASE_RELEASE_PRODUCTS);
    items.forEach(item => {
      if (item.product) names.add(item.product);
    });
    return Array.from(names);
  }

  function summarizeReleasePlan(items) {
    const dated = items.filter(item => item.parsed);
    const missingDate = items.filter(item => !item.parsed).length;
    const platformCount = dated.filter(item => item.layer === 'platform').length;
    const businessCount = dated.filter(item => item.layer === 'business').length;
    const today = new Date().setHours(0, 0, 0, 0);
    const next = dated
      .filter(item => item.parsed.stamp >= today)
      .sort((a, b) => a.parsed.stamp - b.parsed.stamp)[0] || null;
    return { dated, missingDate, platformCount, businessCount, next };
  }

  function analyzeReleaseConflicts(items) {
    const conflicts = [];
    const dated = items.filter(item => item.parsed).sort((a, b) => a.parsed.stamp - b.parsed.stamp);

    for (let i = 0; i < dated.length; i++) {
      for (let j = i + 1; j < dated.length; j++) {
        const a = dated[i];
        const b = dated[j];
        const gap = daysBetween(a.parsed, b.parsed);
        if (gap > PLATFORM_IMPACT_DAYS) break;
        const sameProduct = a.product === b.product;
        const hasFoundation = ['platform', 'shared'].includes(a.layer) || ['platform', 'shared'].includes(b.layer);
        const crossLayer = a.layer !== b.layer;

        if (sameProduct && hasFoundation && crossLayer && gap <= RELEASE_CONFLICT_DAYS) {
          conflicts.push({
            severity: 'high',
            title: '同产品底层/业务发布窗口重叠',
            desc: `${a.product} 的底层或公共能力变更与业务版本间隔 ${gap} 天，建议拆开灰度、封版和业务上线窗口。`,
            items: [a, b]
          });
        } else if (hasFoundation && crossLayer && gap <= PLATFORM_IMPACT_DAYS) {
          conflicts.push({
            severity: 'medium',
            title: '底层变更靠近业务发布',
            desc: `底层或公共能力变更与业务发布间隔 ${gap} 天，需要确认兼容、回滚策略和灰度节奏。`,
            items: [a, b]
          });
        } else if (gap <= 3) {
          conflicts.push({
            severity: 'medium',
            title: '发布窗口过于集中',
            desc: `两个版本间隔 ${gap} 天，可能挤占测试、运维、上线支持资源。`,
            items: [a, b]
          });
        }
      }
    }

    const monthBuckets = {};
    dated.forEach(item => {
      const key = item.parsed.year + '-' + item.parsed.month;
      if (!monthBuckets[key]) monthBuckets[key] = [];
      monthBuckets[key].push(item);
    });

    Object.values(monthBuckets).forEach(bucket => {
      if (bucket.length >= 4) {
        conflicts.push({
          severity: 'medium',
          title: '单月发布密度偏高',
          desc: `${bucket[0].parsed.year}年${bucket[0].parsed.month + 1}月已有 ${bucket.length} 个计划发布，建议评估封版、测试和运维承载。`,
          items: bucket.slice(0, 4)
        });
      }
    });

    return conflicts;
  }
  function buildReleaseMetrics(summary, conflicts, year) {
    const nextRelease = summary.next
      ? (summary.next.product + ' · ' + (summary.next.version || summary.next.name) + ' · ' + summary.next.parsed.short)
      : '暂无';

    return `
      <div class="release-summary-grid">
        ${SharedUI.renderMetricCard('🗓️', '年度发布项', String(summary.dated.length + summary.missingDate), 'normal', year + ' 年发布视图')}
        ${SharedUI.renderMetricCard('🏗️', '平台发布', String(summary.platformCount), summary.platformCount ? 'hold' : 'normal', summary.platformCount ? '平台底座变更' : '暂无')}
        ${SharedUI.renderMetricCard('🚀', '业务发布', String(summary.businessCount), summary.businessCount ? 'ok' : 'normal', summary.businessCount ? '业务上线窗口' : '暂无')}
        ${SharedUI.renderMetricCard('⚠️', '冲突提醒', String(conflicts.length), conflicts.length ? 'warn' : 'ok', conflicts.length ? '需协调发布窗口' : '暂无明显冲突')}
        ${SharedUI.renderMetricCard('⏭️', '下一发布', nextRelease, summary.next ? 'normal' : 'hold', summary.next ? '最近计划' : '请先补日期')}
      </div>`;
  }

  function renderReleaseChip(item) {
    return `<span class="release-chip">${SharedUI.esc(item.product)} · ${SharedUI.esc(RELEASE_LAYER_LABELS[item.layer] || item.layer)} · ${SharedUI.esc(item.parsed ? item.parsed.short : item.releaseDate || '未定')}</span>`;
  }

  function buildReleaseMatrix(items, year) {
    if (!items.length) {
      return `<div class="empty-hint">暂无发布计划，先在项目表单里补充“发布产品 / 发布层级 / 计划发布日”。</div>`;
    }

    const products = orderedReleaseProducts(items);
    const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

    const body = products.map(product => {
      const lanes = ['platform', 'shared', 'business'].map(layer => {
        const laneItems = items
          .filter(item => item.product === product && item.layer === layer && item.parsed && item.parsed.year === year)
          .sort((a, b) => a.parsed.stamp - b.parsed.stamp);

        return `
          <div class="release-lane">
            <div class="release-lane-label">
              <span class="release-lane-title">${SharedUI.esc(product)}</span>
              <span class="release-lane-sub">${SharedUI.esc(RELEASE_LAYER_LABELS[layer])}</span>
            </div>
            <div class="release-lane-grid">
              ${months.map((monthLabel, monthIndex) => {
                const cellItems = laneItems.filter(item => item.parsed.month === monthIndex);
                return `
                  <div class="release-cell ${cellItems.length ? 'has-item' : 'empty'}">
                    <div class="release-cell-head">${SharedUI.esc(monthLabel)}</div>
                    <div class="release-cell-body">
                      ${cellItems.length ? cellItems.map(item => `
                        <a class="release-card ${SharedUI.esc(RELEASE_RISK_CLASSES[item.risk] || 'release-risk-low')}" href="#/project/detail/${SharedUI.esc(item.id)}" title="${SharedUI.esc(item.name)}">
                          <span class="release-card-top">
                            <span class="release-card-name">${SharedUI.esc(item.version || item.name)}</span>
                            ${renderReleaseChip(item)}
                          </span>
                          <span class="release-card-date">${SharedUI.esc(item.parsed.short)}</span>
                          ${item.impactScope ? `<span class="release-card-note">${SharedUI.esc(item.impactScope)}</span>` : ''}
                        </a>`).join('') : `<span class="release-cell-empty">—</span>`}
                    </div>
                  </div>`;
              }).join('')}
            </div>
          </div>`;
      }).join('');

      return `
        <section class="release-product-group">
          ${lanes}
        </section>`;
    }).join('');

    return `<div class="release-matrix">${body}</div>`;
  }

  function buildReleaseConflictCards(conflicts) {
    if (!conflicts.length) {
      return `
        <div class="release-empty release-empty-good">
          <div class="release-empty-title">暂未发现明显冲突</div>
          <div class="release-empty-desc">发布窗口当前看起来比较平稳，继续保持平台先行、业务跟进的节奏。</div>
        </div>`;
    }

    return `<div class="release-conflicts">${conflicts.map(conflict => `
      <article class="release-conflict ${SharedUI.esc(conflict.severity || 'medium')}">
        <div class="release-conflict-head">
          <span class="release-conflict-title">${SharedUI.esc(conflict.title)}</span>
          <span class="release-conflict-badge">${SharedUI.esc(conflict.severity === 'high' ? '高风险' : '需关注')}</span>
        </div>
        <p class="release-conflict-desc">${SharedUI.esc(conflict.desc)}</p>
        <div class="release-conflict-items">
          ${conflict.items.map(renderReleaseChip).join('')}
        </div>
      </article>`).join('')}</div>`;
  }

  function buildProjectLedger(projects, releaseMap) {
    const rows = projects.map(p => {
      const release = releaseMap[p.id] || {};
      const statusBadge = `<span class="badge ${STATUS_CLASSES[p.status] || ''}">${SharedUI.esc(STATUS_LABELS[p.status] || p.status)}</span>`;
      const priority = PRIORITY_LABELS[p.priority] || p.priority || '—';
      const rs = p.resourceSummary || {};
      const manMonths = rs.totalManMonths ? (rs.usedManMonths || 0) + '/' + rs.totalManMonths : '—';
      const costStr = rs.totalCost ? (rs.usedCost || 0) + '/' + rs.totalCost + '万' : '—';
      const layer = release.layer ? RELEASE_LAYER_LABELS[release.layer] || release.layer : '—';
      const releaseDate = release.parsed ? release.parsed.short : (release.releaseDate || '—');
      const releaseVersion = release.version || p.name || '—';
      const risk = release.risk || 'low';

      return `<tr>
        <td class="txt"><a href="#/project/detail/${SharedUI.esc(p.id)}" class="project-link">${SharedUI.esc(p.name || '')}</a></td>
        <td class="txt">${SharedUI.esc(p.productLine || '')}</td>
        <td class="txt">${SharedUI.esc(releaseVersion)}</td>
        <td class="txt">${SharedUI.esc(layer)}</td>
        <td class="txt">${SharedUI.esc(releaseDate)}</td>
        <td class="txt">${SharedUI.esc(RELEASE_RISK_LABELS[risk] || '正常')}</td>
        <td>${statusBadge}</td>
        <td class="txt">${SharedUI.esc(priority)}</td>
        <td class="txt">${SharedUI.esc(p.owner || '')}</td>
        <td class="txt">${SharedUI.esc(p.startDate || '')} ~ ${SharedUI.esc(p.endDate || '')}</td>
        <td>${SharedUI.esc(manMonths)}</td>
        <td>${SharedUI.esc(costStr)}</td>
      </tr>`;
    }).join('');

    return `
      <div class="ledger-block" id="project-ledger">
        <div class="section-head">
          <div>
            <div class="section-kicker">项目台账</div>
            <h3 class="section-title">全年项目记录</h3>
          </div>
          <div class="section-note">${SharedUI.esc(projects.length)} 个项目，按照发布产品与层级同步管理</div>
        </div>
        <div class="table-wrapper">
          <table class="data-table project-ledger-table">
            <thead>
              <tr>
                <th>项目名称</th>
                <th>产品线</th>
                <th>版本/项目</th>
                <th>发布层级</th>
                <th>计划发布</th>
                <th>风险</th>
                <th>状态</th>
                <th>优先级</th>
                <th>负责人</th>
                <th>周期</th>
                <th>人力(已投入/总计)</th>
                <th>成本(已使用/总预算)</th>
              </tr>
            </thead>
            <tbody>
              ${rows || '<tr><td colspan="12" class="empty-hint">暂无项目数据</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function buildMissingReleaseList(items) {
    const missing = items.filter(item => !item.parsed);
    if (!missing.length) {
      return `
        <div class="release-empty release-empty-good">
          <div class="release-empty-title">全部项目都已录入日期</div>
          <div class="release-empty-desc">可以直接用全年时间轴做窗口协调。</div>
        </div>`;
    }

    return `
      <div class="release-missing-list">
        ${missing.map(item => `
          <a class="release-missing-item" href="#/project/detail/${SharedUI.esc(item.id)}">
            <span>${SharedUI.esc(item.version || item.name || '未命名项目')}</span>
            <small>${SharedUI.esc(item.product)} · ${SharedUI.esc(RELEASE_LAYER_LABELS[item.layer] || item.layer)}</small>
          </a>`).join('')}
      </div>`;
  }
  function buildReleaseBoard(items, year, summary, conflicts) {
    return `
      <div class="release-board" id="project-release">
        <div class="section-head release-head">
          <div>
            <div class="section-kicker">年度发布视图</div>
            <h3 class="section-title">平台 / 业务全年发布排期</h3>
            <div class="section-note">把平台升级和业务发版放到同一时间轴里，先看冲突，再看资源。</div>
          </div>
          <div class="release-year-chip">${SharedUI.esc(year)} 年</div>
        </div>
        ${buildReleaseMetrics(summary, conflicts, year)}
        <div class="release-board-grid">
          <div class="release-board-main">
            ${buildReleaseMatrix(items, year)}
          </div>
          <div class="release-board-side">
            <div class="release-panel">
              <h4>冲突提醒</h4>
              ${buildReleaseConflictCards(conflicts)}
            </div>
            <div class="release-panel">
              <h4>未填发布日期</h4>
              ${buildMissingReleaseList(items)}
            </div>
          </div>
        </div>
      </div>`;
  }

  /* ---------- ModuleDefinition 接口 ---------- */

  return {
    id: 'project',
    name: '全年度项目管理（旧版）',
    icon: '📋',
    order: 2,
    // sidebar 已隐藏：功能已融合进「全年度项目管理看板」(csenergy)，
    // 保留模块代码与路由以便回退，数据与新模块共享同一份 data/project/state.json
    sidebar: false,

    /**
     * init(container, context) — 首次进入模块
     */
    async init(el, context) {
      container = el;
      const subPath = (context && context.subPath) || '';
      await fetchState();

      if (subPath.startsWith('detail/')) {
        currentView = 'detail';
        currentProjectId = subPath.replace('detail/', '');
        renderDetail(currentProjectId);
      } else {
        currentView = 'list';
        currentProjectId = null;
        currentListView = subPath === 'release' ? 'release' : subPath === 'timeline' ? 'timeline' : 'list';
        renderList();
      }
    },
    /**
     * enter(subPath) — 重新进入模块
     */
    async enter(subPath) {
      await fetchState();

      if (subPath && subPath.startsWith('detail/')) {
        currentView = 'detail';
        currentProjectId = subPath.replace('detail/', '');
        renderDetail(currentProjectId);
      } else {
        currentView = 'list';
        currentProjectId = null;
        currentListView = subPath === 'release' ? 'release' : subPath === 'timeline' ? 'timeline' : 'list';
        renderList();
      }
    },
    /**
     * leave() — 离开模块
     */
    leave() {
      // No cleanup needed
    },

    /**
     * getSummary() — 返回仪表盘摘要
     */
    getSummary() {
      if (!state) return { active: 0, overdue: 0 };
      const projects = state.projects || [];
      const today = new Date().toISOString().slice(0, 10);
      return {
        active: projects.filter(p => p.status === 'in-progress').length,
        overdue: projects.filter(p => p.status === 'in-progress' && p.endDate && p.endDate < today).length
      };
    }
  };
})();
