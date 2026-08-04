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

    const rows = projects.map(p => {
      const statusBadge = `<span class="badge ${STATUS_CLASSES[p.status] || ''}">${SharedUI.esc(STATUS_LABELS[p.status] || p.status)}</span>`;
      const priority = PRIORITY_LABELS[p.priority] || p.priority || '—';
      const progress = p.resourceSummary
        ? Math.round((p.resourceSummary.usedManDays || 0) / (p.resourceSummary.totalManDays || 1) * 100) + '%'
        : '—';

      return `<tr>
        <td><a href="#/project/detail/${SharedUI.esc(p.id)}" class="project-link">${SharedUI.esc(p.name || '')}</a></td>
        <td>${SharedUI.esc(p.productLine || '')}</td>
        <td>${statusBadge}</td>
        <td>${SharedUI.esc(priority)}</td>
        <td>${SharedUI.esc(p.owner || '')}</td>
        <td>${SharedUI.esc(p.startDate || '')} ~ ${SharedUI.esc(p.endDate || '')}</td>
        <td>${SharedUI.esc(progress)}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <div class="project-page">
        <div class="page-header">
          <h2 class="page-title">全年度项目管理</h2>
          <button class="btn primary" id="addProjectBtn">+ 新增项目</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>项目名称</th>
                <th>产品线</th>
                <th>状态</th>
                <th>优先级</th>
                <th>负责人</th>
                <th>周期</th>
                <th>进度</th>
              </tr>
            </thead>
            <tbody>
              ${rows || '<tr><td colspan="7" class="empty-hint">暂无项目数据</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // 绑定新增按钮
    const addBtn = document.getElementById('addProjectBtn');
    if (addBtn) {
      addBtn.addEventListener('click', showAddForm);
    }
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

    // 里程碑时间线
    const milestones = (project.milestones || []).map(ms => {
      const statusIcon = ms.status === 'done' ? '✅' : ms.status === 'in-progress' ? '🔵' : '⚪';
      const today = new Date().toISOString().slice(0, 10);
      const overdue = ms.status !== 'done' && ms.date && ms.date < today;
      const cls = overdue ? 'overdue' : '';
      return `<li class="milestone-item ${cls}">
        <span class="ms-icon">${statusIcon}</span>
        <span class="ms-name">${SharedUI.esc(ms.name || '')}</span>
        <span class="ms-date">${SharedUI.esc(ms.date || '')}</span>
        ${overdue ? '<span class="ms-overdue">逾期</span>' : ''}
      </li>`;
    }).join('');

    // 资源摘要
    let resourceHtml = '';
    if (project.resourceSummary) {
      const rs = project.resourceSummary;
      const pct = rs.totalManDays ? Math.round(rs.usedManDays / rs.totalManDays * 100) : 0;
      const teamRows = rs.teams ? Object.entries(rs.teams).map(([team, days]) =>
        `<tr><td>${SharedUI.esc(team)}</td><td>${days} 人天</td></tr>`
      ).join('') : '';

      resourceHtml = `
        <div class="detail-section">
          <h4>资源概况</h4>
          <p>总工时: ${rs.totalManDays || 0} 人天，已使用: ${rs.usedManDays || 0} 人天 (${pct}%)</p>
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

        <div class="detail-section">
          <h4>里程碑</h4>
          ${milestones ? `<ul class="milestone-list">${milestones}</ul>` : '<p class="empty-hint">暂无里程碑</p>'}
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

    return `
      <form id="projectForm" class="form-grid">
        <input type="hidden" id="pf-id" value="${SharedUI.esc(proj.id || '')}">
        <div class="form-row">
          <label>项目名称 *</label>
          <input type="text" id="pf-name" value="${SharedUI.esc(proj.name || '')}" required>
        </div>
        <div class="form-row">
          <label>产品线</label>
          <input type="text" id="pf-productLine" value="${SharedUI.esc(proj.productLine || '')}">
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
        <div class="form-row">
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

    if (!name) {
      SharedUI.toast('项目名称不能为空', 'warning');
      return;
    }

    if (startDate && endDate && startDate > endDate) {
      SharedUI.toast('开始日期不能晚于结束日期', 'warning');
      return;
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
      note: note || '',
      milestones: [],
      resourceSummary: null,
      iterations: []
    };

    // 如果编辑，保留原有的 milestones 和 resourceSummary
    if (!isNew && state) {
      const existing = (state.projects || []).find(p => p.id === id);
      if (existing) {
        project.milestones = existing.milestones || [];
        project.resourceSummary = existing.resourceSummary || null;
        project.iterations = existing.iterations || [];
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
      renderList();
    }
  }

  /* ---------- ModuleDefinition 接口 ---------- */

  return {
    id: 'project',
    name: '全年度项目管理',
    icon: '📋',
    order: 2,
    sidebar: true,

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
