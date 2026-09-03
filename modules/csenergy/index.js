/* modules/csenergy/index.js — 全年度项目管理看板（全能替代版）
   融合看板可视化 + 现有 project 模块的全部编辑能力：
     视图：立项看板 / 项目台账(CRUD) / 周期视图 / 年度发布(矩阵+冲突) / 风险全景(CRUD) / 资源管理
     详情：项目详情页（里程碑增删改 + 资源摘要 + 发布计划）
   ★ 数据源统一为 /api/project/state（与 project 模块共享），额外读写 risks/resources
*/

// eslint-disable-next-line no-unused-vars
const CsEnergyModule = (() => {
  'use strict';

  let container = null;
  let state = null;
  let summary = null;
  let currentView = 'board';   // board | ledger | timeline | release | risk | resource | detail
  let currentProjectId = null;
  let filterYear = new Date().getFullYear();

  /* ---------- 常量表 ---------- */
  const NODE_KEYS = ['BR0', 'BR1', 'BR2', 'BR3', 'BR4', 'TR1', 'TR2', 'TR3', 'TR4', 'TR5', 'TR6'];
  const STATUS_LABELS = { planned: '计划中', 'in-progress': '进行中', completed: '已完成', suspended: '已暂停' };
  const STATUS_CLASSES = { planned: 'status-planned', 'in-progress': 'status-active', completed: 'status-done', suspended: 'status-hold' };
  const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' };
  const RISK_LABELS = { high: '高', medium: '中', low: '低' };
  const VERSION_TYPE_LABELS = { V: 'V', R: 'R', C: 'C', other: '其他' };
  const PLANNING_LABELS = { in: '规划内', out: '规划外' };
  const RELEASE_LAYER_LABELS = { platform: '平台底座', business: '业务版本', shared: '公共能力' };
  const RELEASE_RISK_LABELS = { high: '高风险', medium: '需关注', low: '正常' };
  const RELEASE_RISK_CLASSES = { high: 'release-risk-high', medium: 'release-risk-medium', low: 'release-risk-low' };
  const BASE_RELEASE_PRODUCTS = ['阳光云', '乐充云'];
  const RELEASE_CONFLICT_DAYS = 7;
  const PLATFORM_IMPACT_DAYS = 14;

  const esc = (t) => (typeof SharedUI !== 'undefined' ? SharedUI.esc(t) : String(t == null ? '' : t));
  const whoami = () => (typeof Platform !== 'undefined' && Platform.whoami ? Platform.whoami() : '未署名');

  /* ==========================================================
     数据获取 / 保存（统一走 /api/project/state）
     ========================================================== */
  async function fetchState() {
    try {
      const resp = await fetch('/api/csenergy/state');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      state = await resp.json();
      return state;
    } catch (e) {
      console.error('[csenergy] 获取数据失败:', e.message);
      state = null;
      return null;
    }
  }

  async function fetchSummary() {
    try {
      const resp = await fetch('/api/csenergy/summary');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      summary = await resp.json();
    } catch (e) {
      console.error('[csenergy] 获取汇总失败:', e.message);
      summary = null;
    }
  }

  async function saveState(newState) {
    try {
      const resp = await fetch('/api/csenergy/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRev: state ? state.rev : 0, state: newState, by: whoami() })
      });
      const result = await resp.json();
      if (resp.status === 409) { SharedUI.toast('数据冲突，请刷新后重试', 'warning'); return false; }
      if (!resp.ok) { SharedUI.toast(result.error || '保存失败', 'error'); return false; }
      SharedUI.toast('保存成功', 'success');
      return true;
    } catch (e) {
      SharedUI.toast('网络错误: ' + e.message, 'error');
      return false;
    }
  }

  function targetYear() { return Number(state && state.year) || new Date().getFullYear(); }

  /* ==========================================================
     发布日期/产品/层级 解析工具（迁移自 project 模块）
     ========================================================== */
  function parseDateValue(value) {
    if (!value) return null;
    const text = String(value).trim();
    const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(text);
    if (!m) return null;
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3] || 1);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return {
      date, year, month: month - 1, day, stamp: date.getTime(),
      text: text.length === 7 ? text + '-01' : text,
      short: (month < 10 ? '0' + month : String(month)) + '-' + (day < 10 ? '0' + day : String(day))
    };
  }
  function daysBetween(a, b) { return Math.round(Math.abs(a.stamp - b.stamp) / 86400000); }

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
    const rm = (project.milestones || [])
      .filter(ms => /发布|上线|发版|投产|封版/.test(ms.name || '') && ms.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
    return rm ? rm.date : (project.endDate || '');
  }
  function collectReleaseItems(projects, year) {
    return (projects || []).map(project => {
      const releaseDate = inferReleaseDate(project);
      const parsed = parseDateValue(releaseDate);
      const risk = project.releaseRisk && RELEASE_RISK_LABELS[project.releaseRisk] ? project.releaseRisk : 'low';
      return {
        id: project.id, project, name: project.name || '',
        version: project.releaseVersion || project.name || '',
        product: inferReleaseProduct(project), layer: inferReleaseLayer(project),
        releaseDate, parsed, risk, status: project.status || 'planned',
        owner: project.owner || '', impactScope: project.impactScope || '', dependency: project.dependency || ''
      };
    }).filter(item => !item.parsed || item.parsed.year === year);
  }
  function orderedReleaseProducts(items) {
    const names = new Set(BASE_RELEASE_PRODUCTS);
    items.forEach(item => { if (item.product) names.add(item.product); });
    return Array.from(names);
  }
  function summarizeReleasePlan(items) {
    const dated = items.filter(i => i.parsed);
    const missingDate = items.filter(i => !i.parsed).length;
    const platformCount = dated.filter(i => i.layer === 'platform').length;
    const businessCount = dated.filter(i => i.layer === 'business').length;
    const today = new Date().setHours(0, 0, 0, 0);
    const next = dated.filter(i => i.parsed.stamp >= today).sort((a, b) => a.parsed.stamp - b.parsed.stamp)[0] || null;
    return { dated, missingDate, platformCount, businessCount, next };
  }
  function analyzeReleaseConflicts(items) {
    const conflicts = [];
    const dated = items.filter(i => i.parsed).sort((a, b) => a.parsed.stamp - b.parsed.stamp);
    for (let i = 0; i < dated.length; i++) {
      for (let j = i + 1; j < dated.length; j++) {
        const a = dated[i], b = dated[j];
        const gap = daysBetween(a.parsed, b.parsed);
        if (gap > PLATFORM_IMPACT_DAYS) break;
        const sameProduct = a.product === b.product;
        const hasFoundation = ['platform', 'shared'].includes(a.layer) || ['platform', 'shared'].includes(b.layer);
        const crossLayer = a.layer !== b.layer;
        if (sameProduct && hasFoundation && crossLayer && gap <= RELEASE_CONFLICT_DAYS) {
          conflicts.push({ severity: 'high', title: '同产品底层/业务发布窗口重叠', desc: `${a.product} 的底层或公共能力变更与业务版本间隔 ${gap} 天，建议拆开灰度、封版和业务上线窗口。`, items: [a, b] });
        } else if (hasFoundation && crossLayer && gap <= PLATFORM_IMPACT_DAYS) {
          conflicts.push({ severity: 'medium', title: '底层变更靠近业务发布', desc: `底层或公共能力变更与业务发布间隔 ${gap} 天，需要确认兼容、回滚策略和灰度节奏。`, items: [a, b] });
        } else if (gap <= 3) {
          conflicts.push({ severity: 'medium', title: '发布窗口过于集中', desc: `两个版本间隔 ${gap} 天，可能挤占测试、运维、上线支持资源。`, items: [a, b] });
        }
      }
    }
    const monthBuckets = {};
    dated.forEach(item => {
      const key = item.parsed.year + '-' + item.parsed.month;
      (monthBuckets[key] = monthBuckets[key] || []).push(item);
    });
    Object.values(monthBuckets).forEach(bucket => {
      if (bucket.length >= 4) {
        conflicts.push({ severity: 'medium', title: '单月发布密度偏高', desc: `${bucket[0].parsed.year}年${bucket[0].parsed.month + 1}月已有 ${bucket.length} 个计划发布，建议评估封版、测试和运维承载。`, items: bucket.slice(0, 4) });
      }
    });
    return conflicts;
  }

  /* ---------- SVG 环形图 ---------- */
  function renderDonut(segments, centerLabel, centerValue) {
    const total = segments.reduce((s, x) => s + (x.value || 0), 0);
    const r = 52, cx = 70, cy = 70, sw = 16, circ = 2 * Math.PI * r;
    let offset = 0, arcs = '';
    if (total > 0) {
      segments.forEach(seg => {
        const len = ((seg.value || 0) / total) * circ;
        arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${sw}" stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
        offset += len;
      });
    } else {
      arcs = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"></circle>`;
    }
    return `<div class="cs-donut"><svg viewBox="0 0 140 140" width="140" height="140">${arcs}</svg>
      <div class="cs-donut-center"><strong>${esc(centerValue)}</strong><span>${esc(centerLabel)}</span></div></div>`;
  }
  function renderLegend(items) {
    return `<div class="cs-legend">${items.map(i => `<span class="cs-legend-item"><i style="background:${i.color}"></i>${esc(i.label)} <b>${esc(i.value)}</b></span>`).join('')}</div>`;
  }

  /* ==========================================================
     视图 1：立项管理看板
     ========================================================== */
  function renderBoard() {
    const m = (summary && summary.metrics) || {};
    const pr = (summary && summary.progressRisk) || { high: 0, medium: 0, low: 0 };
    const rc = (summary && summary.riskClosure) || { closeRate: 0, closed: 0, open: 0, total: 0 };
    const ms = (summary && summary.milestoneStats) || [];
    const gantt = (summary && summary.ganttProjects) || [];
    const overdue = (summary && summary.overdueRisks) || [];
    const upcoming = (summary && summary.upcomingRisks) || [];

    const metricCards = [
      { icon: '📁', value: m.approved || 0, label: '已立项项目数(总)', sub: `本年度 (${filterYear})`, color: 'green' },
      { icon: '⏳', value: m.pending || 0, label: '待立项项目数', sub: '状态：计划中', color: 'orange' },
      { icon: '🚀', value: m.inProgress || 0, label: '进行中项目数', sub: '状态：进行中', color: 'blue' },
      { icon: '👤', value: m.managerCount || 0, label: '项目负责人数', sub: '进行中项目不重复负责人', color: 'purple' },
      { icon: '👥', value: m.humanProjects || 0, label: '人力项目数', sub: '进行中项目名录', color: 'pink' },
      { icon: '📈', value: m.efficiency || 0, label: '人均效能数', sub: '项目数 ÷ 负责人数', color: 'teal' }
    ].map(c => `
      <div class="cs-metric cs-metric-${c.color}">
        <div class="cs-metric-top"><span class="cs-metric-icon">${c.icon}</span><span class="cs-metric-trend">🎯</span></div>
        <div class="cs-metric-value">${esc(c.value)}</div>
        <div class="cs-metric-label">${esc(c.label)}</div>
        <div class="cs-metric-sub">${esc(c.sub)}</div>
      </div>`).join('');

    const maxMs = Math.max(1, ...ms.map(x => x.count));
    const bars = ms.map(x => `
      <div class="cs-bar-col"><div class="cs-bar" style="--h:${Math.round((x.count / maxMs) * 100)}%" data-v="${x.count}"></div><span class="cs-bar-label">${esc(x.node)}</span></div>`).join('');

    const progSegs = [
      { value: pr.high, color: 'var(--warn)', label: '高风险' },
      { value: pr.medium, color: 'var(--hold)', label: '中风险' },
      { value: pr.low, color: 'var(--ok)', label: '低风险' }
    ];
    const progTotal = pr.high + pr.medium + pr.low;
    const closureSegs = [
      { value: rc.closed, color: 'var(--ok)', label: '已闭环' },
      { value: rc.open, color: 'var(--hold)', label: '未闭环' }
    ];

    let ganttHtml;
    if (gantt.length === 0) {
      ganttHtml = `<div class="cs-empty">暂无进行中的项目里程碑数据</div>`;
    } else {
      ganttHtml = gantt.map(p => {
        const nodes = (p.milestones || []).map(mile => {
          const done = mile.status === 'done';
          return `<span class="cs-gantt-node ${done ? 'done' : 'pending'}" title="${esc(mile.name)} · ${esc(mile.date)}">${esc(mile.node || mile.name || '')}<small>${esc((mile.date || '').slice(5))}</small></span>`;
        }).join('');
        return `<div class="cs-gantt-row"><div class="cs-gantt-name">${esc(p.name)}</div><div class="cs-gantt-track">${nodes || '<span class="cs-gantt-empty">无节点</span>'}</div></div>`;
      }).join('');
    }

    const overdueHtml = overdue.length === 0
      ? `<div class="cs-risk-ok">🎉 暂无超时未闭环风险，继续保持！</div>`
      : overdue.map(r => `<div class="cs-risk-line cs-risk-${r.level}"><span class="cs-risk-dot"></span><span class="cs-risk-text">${esc(r.desc)}</span><span class="cs-risk-date">${esc(r.planCloseDate)}</span></div>`).join('');
    const upcomingHtml = upcoming.length === 0
      ? `<div class="cs-risk-ok">近一周暂无待闭环风险</div>`
      : upcoming.map(r => `<div class="cs-risk-line cs-risk-${r.level}"><span class="cs-risk-dot"></span><span class="cs-risk-text">${esc(r.desc)}</span><span class="cs-risk-date">${esc(r.planCloseDate)}</span></div>`).join('');

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
        <div class="cs-chart-card"><h4>📊 里程碑节点统计</h4><div class="cs-bar-chart">${bars}</div></div>
        <div class="cs-chart-card"><h4>🔴 项目进度风险分布 <small>(进行中)</small></h4>
          <div class="cs-donut-wrap">${renderDonut(progSegs, '进行中', progTotal)}${renderLegend([
            { color: 'var(--warn)', label: '高风险', value: pr.high },
            { color: 'var(--hold)', label: '中风险', value: pr.medium },
            { color: 'var(--ok)', label: '低风险', value: pr.low }])}</div></div>
        <div class="cs-chart-card"><h4>🔄 风险闭环率</h4>
          <div class="cs-donut-wrap">${renderDonut(closureSegs, '闭环率', rc.closeRate + '%')}${renderLegend([
            { color: 'var(--ok)', label: '已闭环', value: rc.closed },
            { color: 'var(--hold)', label: '未闭环', value: rc.open }])}</div></div>
      </div>
      <div class="cs-panel"><div class="cs-panel-head"><h4>📅 里程碑甘特图 <small>(进行中项目)</small></h4></div><div class="cs-gantt">${ganttHtml}</div></div>
      <div class="cs-chart-row cs-chart-row-2">
        <div class="cs-panel"><div class="cs-panel-head"><h4>⚠️ 超时未闭环风险</h4></div><div class="cs-risk-list">${overdueHtml}</div></div>
        <div class="cs-panel"><div class="cs-panel-head"><h4>🚨 近一周需闭环风险</h4></div><div class="cs-risk-list">${upcomingHtml}</div></div>
      </div>`;
  }

  /* ==========================================================
     视图 2：项目台账（含 CRUD）
     ========================================================== */
  function buildProjectLedger(projects, releaseMap) {
    const rows = projects.map(p => {
      const release = releaseMap[p.id] || {};
      const statusBadge = `<span class="badge ${STATUS_CLASSES[p.status] || ''}">${esc(STATUS_LABELS[p.status] || p.status)}</span>`;
      const priority = PRIORITY_LABELS[p.priority] || p.priority || '—';
      const rs = p.resourceSummary || {};
      const manMonths = rs.totalManMonths ? (rs.usedManMonths || 0) + '/' + rs.totalManMonths : '—';
      const costStr = rs.totalCost ? (rs.usedCost || 0) + '/' + rs.totalCost + '万' : '—';
      const layer = release.layer ? RELEASE_LAYER_LABELS[release.layer] || release.layer : '—';
      const releaseDate = release.parsed ? release.parsed.short : (release.releaseDate || '—');
      const releaseVersion = release.version || p.name || '—';
      const risk = release.risk || 'low';
      return `<tr>
        <td class="txt"><a href="#/csenergy/detail/${esc(p.id)}" class="project-link">${esc(p.name || '')}</a></td>
        <td class="txt">${esc(p.productLine || '')}</td>
        <td class="txt">${esc(releaseVersion)}</td>
        <td class="txt">${esc(layer)}</td>
        <td class="txt">${esc(releaseDate)}</td>
        <td class="txt">${esc(RELEASE_RISK_LABELS[risk] || '正常')}</td>
        <td>${statusBadge}</td>
        <td class="txt">${esc(priority)}</td>
        <td class="txt">${esc(p.owner || '')}</td>
        <td class="txt">${esc(p.startDate || '')} ~ ${esc(p.endDate || '')}</td>
        <td>${esc(manMonths)}</td>
        <td>${esc(costStr)}</td>
        <td class="txt"><button class="btn cs-mini-btn" data-edit-proj="${esc(p.id)}">编辑</button> <button class="btn cs-mini-btn cs-del-btn" data-del-proj="${esc(p.id)}">删除</button></td>
      </tr>`;
    }).join('');

    return `
      <div class="ledger-block">
        <div class="cs-panel-head"><h4>📒 全年项目台账 <small>${projects.length} 个项目</small></h4></div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead><tr>
              <th>项目名称</th><th>产品线</th><th>版本/项目</th><th>发布层级</th><th>计划发布</th><th>风险</th>
              <th>状态</th><th>优先级</th><th>负责人</th><th>周期</th><th>人力(投/总)</th><th>成本(用/预算)</th><th>操作</th>
            </tr></thead>
            <tbody>${rows || '<tr><td colspan="13" class="cs-table-empty">暂无项目数据，点击右上角「+ 新增项目」开始</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  }

  function renderLedger() {
    const projects = (state && state.projects) || [];
    const year = targetYear();
    const releaseItems = collectReleaseItems(projects, year);
    const releaseMap = {};
    releaseItems.forEach(item => { releaseMap[item.id] = item; });

    const statusCounts = { planned: 0, 'in-progress': 0, completed: 0, suspended: 0 };
    projects.forEach(p => { if (statusCounts[p.status] !== undefined) statusCounts[p.status]++; });
    const total = projects.length || 1;
    const statusBar = projects.length ? `
      <div class="status-summary">
        <div class="status-bar">
          ${statusCounts.planned ? `<span class="status-segment planned" style="width:${(statusCounts.planned / total * 100).toFixed(1)}%">计划中 ${statusCounts.planned}</span>` : ''}
          ${statusCounts['in-progress'] ? `<span class="status-segment active" style="width:${(statusCounts['in-progress'] / total * 100).toFixed(1)}%">进行中 ${statusCounts['in-progress']}</span>` : ''}
          ${statusCounts.completed ? `<span class="status-segment done" style="width:${(statusCounts.completed / total * 100).toFixed(1)}%">已完成 ${statusCounts.completed}</span>` : ''}
          ${statusCounts.suspended ? `<span class="status-segment hold" style="width:${(statusCounts.suspended / total * 100).toFixed(1)}%">暂停 ${statusCounts.suspended}</span>` : ''}
        </div>
      </div>` : '';

    return `
      <div class="cs-view-head">
        <h3>项目台账</h3>
        <button class="btn primary" id="csAddProjectBtn">+ 新增项目</button>
      </div>
      ${statusBar}
      ${buildProjectLedger(projects, releaseMap)}`;
  }

  /* ==========================================================
     视图 3：周期视图（甘特图）
     ========================================================== */
  function buildTimelineView(projects) {
    if (!projects.length) return '<p class="cs-empty">暂无项目数据</p>';
    const year = targetYear();
    const yearStart = new Date(year, 0, 1).getTime();
    const yearEnd = new Date(year, 11, 31).getTime();
    const yearSpan = yearEnd - yearStart;
    const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    const monthMarkers = months.map((m, i) => `<span class="timeline-month" style="left:${(i / 12 * 100).toFixed(1)}%">${m}</span>`).join('');
    const groups = [
      { key: 'in-progress', label: '进行中', cls: 'in-progress' },
      { key: 'planned', label: '计划中', cls: 'planned' },
      { key: 'completed', label: '已完成', cls: 'completed' },
      { key: 'suspended', label: '已暂停', cls: 'suspended' }
    ];
    let html = `<div class="timeline-container"><div class="timeline-header"><span class="timeline-label" style="font-weight:600">项目</span><div class="timeline-track" style="position:relative;height:20px">${monthMarkers}</div></div>`;
    groups.forEach(g => {
      const items = projects.filter(p => p.status === g.key);
      if (!items.length) return;
      html += `<div class="timeline-group-label">${esc(g.label)} (${items.length})</div>`;
      items.forEach(p => {
        let left = 0, width = 100;
        if (p.startDate) { const startMs = new Date(p.startDate).getTime(); left = Math.max(0, Math.min(100, (startMs - yearStart) / yearSpan * 100)); }
        if (p.endDate) { const endMs = new Date(p.endDate).getTime(); const right = Math.max(0, Math.min(100, (endMs - yearStart) / yearSpan * 100)); width = Math.max(2, right - left); }
        else { width = Math.max(2, 100 - left); }
        const dates = (p.startDate || '?') + ' ~ ' + (p.endDate || '?');
        html += `<div class="timeline-row"><span class="timeline-label">${esc(p.name || '')}</span><div class="timeline-track"><div class="timeline-bar ${g.cls}" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"><span class="bar-dates">${esc(dates)}</span></div></div></div>`;
      });
    });
    html += '</div>';
    return html;
  }

  function renderTimeline() {
    const projects = (state && state.projects) || [];
    return `
      <div class="cs-view-head"><h3>周期视图</h3><span class="cs-year-chip">${targetYear()} 年</span></div>
      <div class="cs-panel">
        <div class="cs-panel-head"><h4>📆 全年项目周期 <small>按状态分组，展示开始/结束窗口</small></h4></div>
        ${buildTimelineView(projects)}
      </div>`;
  }

  /* ==========================================================
     视图 4：年度发布（矩阵 + 冲突）
     ========================================================== */
  function buildReleaseMetrics(summ, conflicts, year) {
    const nextRelease = summ.next ? (summ.next.product + ' · ' + (summ.next.version || summ.next.name) + ' · ' + summ.next.parsed.short) : '暂无';
    return `<div class="release-summary-grid">
      ${SharedUI.renderMetricCard('🗓️', '年度发布项', String(summ.dated.length + summ.missingDate), 'normal', year + ' 年发布视图')}
      ${SharedUI.renderMetricCard('🏗️', '平台发布', String(summ.platformCount), summ.platformCount ? 'hold' : 'normal', summ.platformCount ? '平台底座变更' : '暂无')}
      ${SharedUI.renderMetricCard('🚀', '业务发布', String(summ.businessCount), summ.businessCount ? 'ok' : 'normal', summ.businessCount ? '业务上线窗口' : '暂无')}
      ${SharedUI.renderMetricCard('⚠️', '冲突提醒', String(conflicts.length), conflicts.length ? 'warn' : 'ok', conflicts.length ? '需协调发布窗口' : '暂无明显冲突')}
      ${SharedUI.renderMetricCard('⏭️', '下一发布', nextRelease, summ.next ? 'normal' : 'hold', summ.next ? '最近计划' : '请先补日期')}
    </div>`;
  }
  function renderReleaseChip(item) {
    return `<span class="release-chip">${esc(item.product)} · ${esc(RELEASE_LAYER_LABELS[item.layer] || item.layer)} · ${esc(item.parsed ? item.parsed.short : item.releaseDate || '未定')}</span>`;
  }
  function buildReleaseMatrix(items, year) {
    if (!items.length) return `<div class="empty-hint">暂无发布计划，先在项目表单里补充"发布产品 / 发布层级 / 计划发布日"。</div>`;
    const products = orderedReleaseProducts(items);
    const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    const body = products.map(product => {
      const lanes = ['platform', 'shared', 'business'].map(layer => {
        const laneItems = items.filter(item => item.product === product && item.layer === layer && item.parsed && item.parsed.year === year).sort((a, b) => a.parsed.stamp - b.parsed.stamp);
        return `<div class="release-lane">
          <div class="release-lane-label"><span class="release-lane-title">${esc(product)}</span><span class="release-lane-sub">${esc(RELEASE_LAYER_LABELS[layer])}</span></div>
          <div class="release-lane-grid">
            ${months.map((monthLabel, monthIndex) => {
              const cellItems = laneItems.filter(item => item.parsed.month === monthIndex);
              return `<div class="release-cell ${cellItems.length ? 'has-item' : 'empty'}">
                <div class="release-cell-head">${esc(monthLabel)}</div>
                <div class="release-cell-body">
                  ${cellItems.length ? cellItems.map(item => `<a class="release-card ${esc(RELEASE_RISK_CLASSES[item.risk] || 'release-risk-low')}" href="#/csenergy/detail/${esc(item.id)}" title="${esc(item.name)}"><span class="release-card-top"><span class="release-card-name">${esc(item.version || item.name)}</span>${renderReleaseChip(item)}</span><span class="release-card-date">${esc(item.parsed.short)}</span>${item.impactScope ? `<span class="release-card-note">${esc(item.impactScope)}</span>` : ''}</a>`).join('') : `<span class="release-cell-empty">—</span>`}
                </div></div>`;
            }).join('')}
          </div></div>`;
      }).join('');
      return `<section class="release-product-group">${lanes}</section>`;
    }).join('');
    return `<div class="release-matrix">${body}</div>`;
  }
  function buildReleaseConflictCards(conflicts) {
    if (!conflicts.length) return `<div class="release-empty release-empty-good"><div class="release-empty-title">暂未发现明显冲突</div><div class="release-empty-desc">发布窗口当前看起来比较平稳，继续保持平台先行、业务跟进的节奏。</div></div>`;
    return `<div class="release-conflicts">${conflicts.map(conflict => `<article class="release-conflict ${esc(conflict.severity || 'medium')}"><div class="release-conflict-head"><span class="release-conflict-title">${esc(conflict.title)}</span><span class="release-conflict-badge">${esc(conflict.severity === 'high' ? '高风险' : '需关注')}</span></div><p class="release-conflict-desc">${esc(conflict.desc)}</p><div class="release-conflict-items">${conflict.items.map(renderReleaseChip).join('')}</div></article>`).join('')}</div>`;
  }
  function buildMissingReleaseList(items) {
    const missing = items.filter(item => !item.parsed);
    if (!missing.length) return `<div class="release-empty release-empty-good"><div class="release-empty-title">全部项目都已录入日期</div><div class="release-empty-desc">可以直接用全年时间轴做窗口协调。</div></div>`;
    return `<div class="release-missing-list">${missing.map(item => `<a class="release-missing-item" href="#/csenergy/detail/${esc(item.id)}"><span>${esc(item.version || item.name || '未命名项目')}</span><small>${esc(item.product)} · ${esc(RELEASE_LAYER_LABELS[item.layer] || item.layer)}</small></a>`).join('')}</div>`;
  }
  function renderRelease() {
    const projects = (state && state.projects) || [];
    const year = targetYear();
    const items = collectReleaseItems(projects, year);
    const summ = summarizeReleasePlan(items);
    const conflicts = analyzeReleaseConflicts(items);
    return `
      <div class="cs-view-head"><h3>年度发布视图</h3><span class="release-year-chip">${year} 年</span></div>
      <p class="section-note">把平台升级和业务发版放到同一时间轴里，先看冲突，再看资源。</p>
      ${buildReleaseMetrics(summ, conflicts, year)}
      <div class="release-board-grid">
        <div class="release-board-main">${buildReleaseMatrix(items, year)}</div>
        <div class="release-board-side">
          <div class="release-panel"><h4>冲突提醒</h4>${buildReleaseConflictCards(conflicts)}</div>
          <div class="release-panel"><h4>未填发布日期</h4>${buildMissingReleaseList(items)}</div>
        </div>
      </div>`;
  }

  /* ==========================================================
     视图 5：风险全景（含 CRUD）
     ========================================================== */
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
    ].map(c => `<div class="cs-risk-stat cs-risk-stat-${c.cls}"><strong>${esc(c.value)}</strong><span>${esc(c.label)}</span></div>`).join('');

    const rows = risks.length === 0
      ? `<tr><td colspan="9" class="cs-table-empty">暂无风险，点击「+ 登记风险」开始</td></tr>`
      : risks.map((r, i) => `<tr>
          <td>${i + 1}</td>
          <td>${r.star ? '⭐' : ''}</td>
          <td class="txt">${esc(r.projectName || '—')}</td>
          <td class="txt">${esc(r.desc || '—')}</td>
          <td class="txt">${esc(r.impactType || '—')}</td>
          <td><span class="cs-risk-badge cs-risk-${r.level}">${RISK_LABELS[r.level] || '低'}</span></td>
          <td><span class="badge ${r.state === 'closed' ? 'status-done' : 'status-hold'}">${r.state === 'closed' ? '已闭环' : '未闭环'}</span></td>
          <td class="txt"><div class="cs-close-bar"><div class="cs-close-fill" style="width:${r.closeProgress || 0}%"></div></div><small>${r.closeProgress || 0}% · ${esc(r.resourceSupport || '')}</small></td>
          <td class="txt"><button class="btn cs-mini-btn" data-edit-risk="${esc(r.id)}">编辑</button> <button class="btn cs-mini-btn cs-del-btn" data-del-risk="${esc(r.id)}">删除</button></td>
        </tr>`).join('');

    return `
      <div class="cs-view-head"><h3>风险全景图</h3><button class="btn primary" id="csAddRiskBtn">+ 登记风险</button></div>
      <div class="cs-risk-stat-grid">${statCards}</div>
      <div class="cs-panel">
        <div class="table-wrapper">
          <table class="data-table"><thead><tr><th>序号</th><th>星标</th><th>所属项目</th><th>风险描述</th><th>影响类型</th><th>等级</th><th>状态</th><th>措施闭环进度</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody></table>
        </div>
      </div>`;
  }

  /* ==========================================================
     视图 6：资源管理
     ========================================================== */
  function renderResource() {
    const res = (state && state.resources) || { human: [], month: '', dept: '' };
    const human = res.human || [];
    const palette = ['#8b6cff', '#5277ff', '#52c41a', '#f5a524', '#f071a8', '#13c2c2', '#597ef7', '#eb2f96'];
    const total = human.reduce((s, h) => s + (h.invest || 0), 0);
    const cards = human.map((h, i) => `
      <div class="cs-res-card"><div class="cs-res-icon" style="background:${h.color || palette[i % palette.length]}"></div><strong>${esc(h.invest)}</strong><span>${esc(h.role)}</span><small>投入度(人月)</small></div>`).join('');
    const totalCard = `<div class="cs-res-card cs-res-total"><div class="cs-res-icon" style="background:linear-gradient(135deg,var(--accent),var(--blue))"></div><strong>${total.toFixed(1)}</strong><span>合计</span><small>总投入度</small></div>`;
    const emptyHint = human.length === 0 ? `<p class="cs-empty">暂无人力资源数据，点击「+ 新增角色」添加</p>` : '';

    return `
      <div class="cs-view-head"><h3>资源管理</h3><button class="btn primary" id="csAddResBtn">+ 新增角色</button></div>
      <div class="cs-filter-bar"><div class="cs-filter-controls">
        <label class="cs-inline-label">月份 <input type="month" class="cs-search" id="csResMonth" value="${esc(res.month || '')}"></label>
        <label class="cs-inline-label">部门 <input type="text" class="cs-search" id="csResDept" value="${esc(res.dept || '研发中心')}"></label>
      </div></div>
      <div class="cs-panel">
        <div class="cs-panel-head"><h4>📊 ${esc(res.dept || '研发中心')} 人力投入统计 <small>(单位：人月)</small></h4></div>
        ${emptyHint}
        <div class="cs-res-grid">${cards}${human.length ? totalCard : ''}</div>
      </div>`;
  }

  /* ==========================================================
     项目详情页（迁移自 project 模块）
     ========================================================== */
  function renderDetail(projectId) {
    const project = (state.projects || []).find(p => p.id === projectId);
    if (!project) {
      container.innerHTML = `<div class="csenergy-page"><div class="cs-view-head"><h3>项目详情</h3><button class="btn" id="csBackBtn">← 返回台账</button></div><p class="cs-empty">未找到项目: ${esc(projectId)}</p></div>`;
      const b = document.getElementById('csBackBtn'); if (b) b.addEventListener('click', () => { location.hash = '#/csenergy/ledger'; });
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
        <div class="section-head compact"><div><div class="section-kicker">年度发布计划</div><h4>发布协同信息</h4></div>
          <span class="release-risk-badge ${esc(RELEASE_RISK_CLASSES[releaseRisk] || 'release-risk-low')}">${esc(RELEASE_RISK_LABELS[releaseRisk] || '正常')}</span></div>
        <div class="release-detail-grid">
          <div class="release-detail-item"><span>发布产品</span><strong>${esc(releaseProduct || '—')}</strong></div>
          <div class="release-detail-item"><span>版本标识</span><strong>${esc(releaseVersion)}</strong></div>
          <div class="release-detail-item"><span>发布层级</span><strong>${esc(RELEASE_LAYER_LABELS[releaseLayer] || releaseLayer)}</strong></div>
          <div class="release-detail-item ${releaseParsed ? '' : 'release-date-missing'}"><span>计划发布日</span><strong>${esc(releaseParsed ? releaseParsed.text : (releaseDate || '未设置'))}</strong></div>
          <div class="release-detail-item release-detail-wide"><span>影响范围</span><strong>${esc(project.impactScope || '未填写')}</strong></div>
          <div class="release-detail-item release-detail-wide"><span>依赖 / 底层变更</span><strong>${esc(project.dependency || '未填写')}</strong></div>
        </div>
      </div>`;

    const milestones = (project.milestones || []).map((ms, idx) => {
      const statusIcon = ms.status === 'done' ? '✅' : ms.status === 'in-progress' ? '🔵' : '⚪';
      const today = new Date().toISOString().slice(0, 10);
      const overdue = ms.status !== 'done' && ms.date && ms.date < today;
      const doneDisabled = ms.status === 'done' ? 'disabled' : '';
      return `<li class="milestone-item ${overdue ? 'overdue' : ''}">
        <span class="ms-icon">${statusIcon}</span>
        <span class="ms-name">${esc(ms.name || '')}</span>
        <span class="ms-date">${esc(ms.date || '')}</span>
        ${overdue ? '<span class="ms-overdue">逾期</span>' : ''}
        <span class="ms-actions" style="margin-left:auto;display:flex;gap:4px;white-space:nowrap">
          <button class="btn cs-mini-btn" ${doneDisabled} data-ms-done="${idx}">标记完成</button>
          <button class="btn cs-mini-btn" data-ms-edit="${idx}">编辑</button>
          <button class="btn cs-mini-btn cs-del-btn" data-ms-del="${idx}">删除</button>
        </span></li>`;
    }).join('');

    let resourceHtml = '';
    if (project.resourceSummary) {
      const rs = project.resourceSummary;
      const pct = rs.totalManMonths ? Math.round(rs.usedManMonths / rs.totalManMonths * 100) : 0;
      const costPct = rs.totalCost ? Math.round((rs.usedCost || 0) / rs.totalCost * 100) : 0;
      const teamRows = rs.teams ? Object.entries(rs.teams).map(([team, months]) => `<tr><td>${esc(team)}</td><td>${months} 人月</td></tr>`).join('') : '';
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
        </div>`;
    }

    container.innerHTML = `
      <div class="csenergy-page project-detail">
        <div class="page-header">
          <button class="btn back-btn" id="csBackBtn">← 返回台账</button>
          <button class="btn primary" id="csEditProjectBtn">编辑项目</button>
        </div>
        <h2 class="project-name">${esc(project.name || '')}</h2>
        <div class="project-meta">
          <span class="badge ${STATUS_CLASSES[project.status] || ''}">${esc(STATUS_LABELS[project.status] || project.status)}</span>
          <span class="meta-item">产品线: ${esc(project.productLine || '—')}</span>
          <span class="meta-item">负责人: ${esc(project.owner || '—')}</span>
          <span class="meta-item">优先级: ${esc(PRIORITY_LABELS[project.priority] || '—')}</span>
          <span class="meta-item">周期: ${esc(project.startDate || '—')} ~ ${esc(project.endDate || '—')}</span>
        </div>
        ${releasePlanHtml}
        <div class="detail-section">
          <h4>里程碑</h4>
          ${milestones ? `<ul class="milestone-list">${milestones}</ul>` : '<p class="empty-hint">暂无里程碑</p>'}
          <button class="btn" id="csAddMsBtn" style="margin-top:8px">+ 添加里程碑</button>
        </div>
        ${resourceHtml}
        ${project.note ? `<div class="detail-section"><h4>备注</h4><p>${esc(project.note)}</p></div>` : ''}
      </div>`;

    const backBtn = document.getElementById('csBackBtn');
    if (backBtn) backBtn.addEventListener('click', () => { location.hash = '#/csenergy/ledger'; });
    const editBtn = document.getElementById('csEditProjectBtn');
    if (editBtn) editBtn.addEventListener('click', () => { location.hash = '#/csenergy/edit/' + project.id; });
    const addMsBtn = document.getElementById('csAddMsBtn');
    if (addMsBtn) addMsBtn.addEventListener('click', () => showAddMilestone(project));
    container.querySelectorAll('[data-ms-done]').forEach(btn => btn.addEventListener('click', () => markMilestoneDone(project, +btn.dataset.msDone)));
    container.querySelectorAll('[data-ms-edit]').forEach(btn => btn.addEventListener('click', () => showEditMilestone(project, +btn.dataset.msEdit)));
    container.querySelectorAll('[data-ms-del]').forEach(btn => btn.addEventListener('click', () => deleteMilestone(project, +btn.dataset.msDel)));
  }

  /* ==========================================================
     项目 CRUD 表单（迁移自 project 模块）
     ========================================================== */
  function buildFormHtml(proj) {
    const statusOptions = Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}" ${k === proj.status ? 'selected' : ''}>${v}</option>`).join('');
    const priorityOptions = Object.entries(PRIORITY_LABELS).map(([k, v]) => `<option value="${k}" ${k === proj.priority ? 'selected' : ''}>${v}</option>`).join('');
    const releaseLayer = proj.releaseLayer || 'business';
    const releaseLayerOptions = Object.entries(RELEASE_LAYER_LABELS).map(([k, v]) => `<option value="${k}" ${k === releaseLayer ? 'selected' : ''}>${v}</option>`).join('');
    const releaseRisk = proj.releaseRisk || 'low';
    const releaseRiskOptions = Object.entries(RELEASE_RISK_LABELS).map(([k, v]) => `<option value="${k}" ${k === releaseRisk ? 'selected' : ''}>${v}</option>`).join('');
    const versionType = proj.versionType || 'V';
    const versionTypeOptions = Object.entries(VERSION_TYPE_LABELS).map(([k, v]) => `<option value="${k}" ${k === versionType ? 'selected' : ''}>${v}</option>`).join('');
    const planning = proj.planning || 'in';
    const rs = proj.resourceSummary || {};
    return `
      <form id="csProjectForm" class="cs-form">
        <input type="hidden" id="pf-id" value="${esc(proj.id || '')}">

        <div class="cs-form-section">
          <div class="cs-form-section-title">基础信息</div>
          <div class="cs-form-grid">
            <label class="cs-field"><span class="cs-field-label"><em>*</em> 项目名称</span><input type="text" id="pf-name" value="${esc(proj.name || '')}" placeholder="请输入项目名称+区域版本" required></label>
            <label class="cs-field"><span class="cs-field-label">项目系列</span><input type="text" id="pf-series" value="${esc(proj.series || '')}" placeholder="请选择或输入项目系列"></label>
            <label class="cs-field"><span class="cs-field-label"><em>*</em> 所属产品线</span><input type="text" id="pf-productLine" value="${esc(proj.productLine || '')}" placeholder="阳光云 / 乐充云 / 平台共性"></label>
            <label class="cs-field"><span class="cs-field-label"><em>*</em> 版本类型</span><select id="pf-versionType">${versionTypeOptions}</select></label>
            <label class="cs-field"><span class="cs-field-label">规划情况</span>
              <span class="cs-radio-group">
                <label class="cs-radio"><input type="radio" name="pf-planning" value="in" ${planning === 'in' ? 'checked' : ''}> 规划内</label>
                <label class="cs-radio"><input type="radio" name="pf-planning" value="out" ${planning === 'out' ? 'checked' : ''}> 规划外</label>
              </span>
            </label>
          </div>
        </div>

        <div class="cs-form-section">
          <div class="cs-form-section-title">项目状态</div>
          <div class="cs-form-grid">
            <label class="cs-field"><span class="cs-field-label"><em>*</em> 项目状态</span><select id="pf-status">${statusOptions}</select></label>
            <label class="cs-field"><span class="cs-field-label">优先级</span><select id="pf-priority">${priorityOptions}</select></label>
            <label class="cs-field"><span class="cs-field-label">开始日期</span><input type="text" id="pf-startDate" value="${esc(proj.startDate || '')}" placeholder="YYYY-MM 或 YYYY-MM-DD"></label>
            <label class="cs-field"><span class="cs-field-label">结束日期</span><input type="text" id="pf-endDate" value="${esc(proj.endDate || '')}" placeholder="YYYY-MM 或 YYYY-MM-DD"></label>
          </div>
        </div>

        <div class="cs-form-section">
          <div class="cs-form-section-title">人员信息</div>
          <div class="cs-form-grid cs-form-grid-3">
            <label class="cs-field"><span class="cs-field-label"><em>*</em> 产品经理</span><input type="text" id="pf-productManager" value="${esc(proj.productManager || '')}" placeholder="搜索员工姓名"></label>
            <label class="cs-field"><span class="cs-field-label"><em>*</em> 系统经理</span><input type="text" id="pf-systemManager" value="${esc(proj.systemManager || '')}" placeholder="搜索员工姓名"></label>
            <label class="cs-field"><span class="cs-field-label"><em>*</em> 项目经理</span><input type="text" id="pf-projectManager" value="${esc(proj.projectManager || proj.owner || '')}" placeholder="搜索员工姓名"></label>
          </div>
        </div>

        <div class="cs-form-section">
          <div class="cs-form-section-title">年度发布计划</div>
          <div class="cs-form-grid">
            <label class="cs-field"><span class="cs-field-label">版本标识</span><input type="text" id="pf-releaseVersion" value="${esc(proj.releaseVersion || '')}" placeholder="例如：阳光云 2026-9.17 版本"></label>
            <label class="cs-field"><span class="cs-field-label">发布产品</span><input type="text" id="pf-releaseProduct" value="${esc(proj.releaseProduct || '')}" placeholder="阳光云 / 乐充云 / 平台共性"></label>
            <label class="cs-field"><span class="cs-field-label">发布层级</span><select id="pf-releaseLayer">${releaseLayerOptions}</select></label>
            <label class="cs-field"><span class="cs-field-label">计划发布日</span><input type="text" id="pf-releaseDate" value="${esc(proj.releaseDate || '')}" placeholder="YYYY-MM-DD"></label>
            <label class="cs-field"><span class="cs-field-label">发布风险</span><select id="pf-releaseRisk">${releaseRiskOptions}</select></label>
            <label class="cs-field cs-field-wide"><span class="cs-field-label">影响范围</span><textarea id="pf-impactScope" rows="2" placeholder="会影响哪些业务线、终端、客户或上线窗口">${esc(proj.impactScope || '')}</textarea></label>
            <label class="cs-field cs-field-wide"><span class="cs-field-label">依赖 / 底层变更</span><textarea id="pf-dependency" rows="2" placeholder="例如：平台接口升级、权限模型、数据结构、灰度依赖">${esc(proj.dependency || '')}</textarea></label>
          </div>
        </div>

        <div class="cs-form-section">
          <div class="cs-form-section-title">人力规划</div>
          <div class="cs-form-grid">
            <label class="cs-field"><span class="cs-field-label">预计总人力(人月)</span><input type="number" id="pf-totalManMonths" value="${rs.totalManMonths || ''}" min="0"></label>
            <label class="cs-field"><span class="cs-field-label">已投入人力(人月)</span><input type="number" id="pf-usedManMonths" value="${rs.usedManMonths || ''}" min="0"></label>
            <label class="cs-field cs-field-wide"><span class="cs-field-label">涉及团队(逗号分隔)</span><input type="text" id="pf-teams" value="${esc(rs.teams ? Object.keys(rs.teams).join(',') : '')}" placeholder="APP开发-阳光云,后端开发-阳光云"></label>
          </div>
        </div>

        <div class="cs-form-section">
          <div class="cs-form-section-title">成本预算</div>
          <div class="cs-form-grid">
            <label class="cs-field"><span class="cs-field-label">预计总成本(万元)</span><input type="number" id="pf-totalCost" value="${rs.totalCost || ''}" min="0" step="0.1"></label>
            <label class="cs-field"><span class="cs-field-label">已使用成本(万元)</span><input type="number" id="pf-usedCost" value="${rs.usedCost || ''}" min="0" step="0.1"></label>
            <label class="cs-field"><span class="cs-field-label">外包人数</span><input type="number" id="pf-outsourceCount" value="${rs.outsourceCount || ''}" min="0"></label>
            <label class="cs-field"><span class="cs-field-label">预计工期(月)</span><input type="number" id="pf-durationMonths" value="${rs.durationMonths || ''}" min="0"></label>
          </div>
        </div>

        <div class="cs-form-section">
          <div class="cs-form-section-title">备注</div>
          <div class="cs-form-grid">
            <label class="cs-field cs-field-wide"><span class="cs-field-label">功能备注</span><textarea id="pf-note" rows="3" placeholder="简要描述项目主要功能">${esc(proj.note || '')}</textarea></label>
          </div>
        </div>
      </form>`;
  }

  /* 二级页面：新增/编辑项目表单 */
  function renderProjectForm(mode, projId) {
    const isNew = mode === 'new';
    let proj;
    if (isNew) {
      proj = { id: 'proj-' + Date.now().toString(36), name: '', series: '', productLine: '', versionType: 'V', planning: 'in', status: 'planned', priority: 'medium', productManager: '', systemManager: '', projectManager: '', startDate: '', endDate: '', releaseVersion: '', releaseProduct: '', releaseLayer: 'business', releaseDate: '', releaseRisk: 'low', impactScope: '', dependency: '', note: '' };
    } else {
      proj = (state.projects || []).find(p => p.id === projId);
      if (!proj) {
        container.innerHTML = `<div class="csenergy-page"><div class="cs-form-topbar"><button class="btn back-btn" id="csFormBack">← 返回</button></div><p class="cs-empty">未找到项目: ${esc(projId)}</p></div>`;
        const b = document.getElementById('csFormBack'); if (b) b.addEventListener('click', () => { location.hash = '#/csenergy/ledger'; });
        return;
      }
    }

    container.innerHTML = `
      <div class="csenergy-page cs-form-page">
        <div class="cs-form-topbar">
          <div class="cs-form-topbar-left">
            <button class="btn back-btn" id="csFormBack">← 返回</button>
            <span class="cs-form-title">${isNew ? '新建项目' : '编辑项目'}</span>
          </div>
          <div class="cs-form-topbar-right">
            <button class="btn primary" id="csFormSave">${isNew ? '✓ 创建项目' : '✓ 保存修改'}</button>
            <button class="btn" id="csFormCancel">取消</button>
          </div>
        </div>
        <div class="cs-form-body">${buildFormHtml(proj)}</div>
      </div>`;

    const back = () => { location.hash = '#/csenergy/ledger'; };
    document.getElementById('csFormBack')?.addEventListener('click', back);
    document.getElementById('csFormCancel')?.addEventListener('click', back);
    document.getElementById('csFormSave')?.addEventListener('click', () => submitForm(isNew, isNew ? undefined : projId));
  }

  async function submitForm(isNew, existingId) {
    const g = (id) => document.getElementById(id);
    const id = g('pf-id')?.value || existingId;
    const name = g('pf-name')?.value?.trim();
    if (!name) { SharedUI.toast('项目名称不能为空', 'warning'); return; }
    const startDate = g('pf-startDate')?.value?.trim();
    const endDate = g('pf-endDate')?.value?.trim();
    if (startDate && endDate && startDate > endDate) { SharedUI.toast('开始日期不能晚于结束日期', 'warning'); return; }
    const releaseDate = g('pf-releaseDate')?.value?.trim();
    if (releaseDate && !parseDateValue(releaseDate)) { SharedUI.toast('计划发布日请使用 YYYY-MM-DD 或 YYYY-MM 格式', 'warning'); return; }

    const totalManMonths = Number(g('pf-totalManMonths')?.value) || 0;
    const usedManMonths = Number(g('pf-usedManMonths')?.value) || 0;
    const teamsStr = (g('pf-teams')?.value || '').trim();
    const totalCost = Number(g('pf-totalCost')?.value) || 0;
    const usedCost = Number(g('pf-usedCost')?.value) || 0;
    const outsourceCount = Number(g('pf-outsourceCount')?.value) || 0;
    const durationMonths = Number(g('pf-durationMonths')?.value) || 0;

    let resourceSummary = null;
    if (totalManMonths || usedManMonths || totalCost || usedCost || outsourceCount || durationMonths || teamsStr) {
      const teams = {};
      if (teamsStr) teamsStr.split(',').map(t => t.trim()).filter(Boolean).forEach(t => { teams[t] = 0; });
      resourceSummary = { totalManMonths, usedManMonths, totalCost, usedCost, outsourceCount, durationMonths, teams };
    }

    const releaseLayer = g('pf-releaseLayer')?.value || 'business';
    const releaseRisk = g('pf-releaseRisk')?.value || 'low';
    const versionType = g('pf-versionType')?.value || 'V';
    const planningEl = document.querySelector('input[name="pf-planning"]:checked');
    const planning = planningEl ? planningEl.value : 'in';
    const projectManager = g('pf-projectManager')?.value?.trim() || '';
    const project = {
      id, name,
      series: g('pf-series')?.value?.trim() || '',
      productLine: g('pf-productLine')?.value?.trim() || '',
      versionType: VERSION_TYPE_LABELS[versionType] ? versionType : 'V',
      planning: PLANNING_LABELS[planning] ? planning : 'in',
      status: g('pf-status')?.value || 'planned',
      priority: g('pf-priority')?.value || 'medium',
      productManager: g('pf-productManager')?.value?.trim() || '',
      systemManager: g('pf-systemManager')?.value?.trim() || '',
      projectManager,
      owner: projectManager,  // 兼容旧字段：owner = 项目经理
      startDate: startDate || '', endDate: endDate || '',
      releaseVersion: g('pf-releaseVersion')?.value?.trim() || '',
      releaseProduct: g('pf-releaseProduct')?.value?.trim() || '',
      releaseLayer: RELEASE_LAYER_LABELS[releaseLayer] ? releaseLayer : 'business',
      releaseDate: releaseDate || '',
      releaseRisk: RELEASE_RISK_LABELS[releaseRisk] ? releaseRisk : 'low',
      impactScope: g('pf-impactScope')?.value?.trim() || '',
      dependency: g('pf-dependency')?.value?.trim() || '',
      note: g('pf-note')?.value?.trim() || '',
      milestones: [], resourceSummary, iterations: []
    };

    if (!isNew && state) {
      const existing = (state.projects || []).find(p => p.id === id);
      if (existing) {
        project.milestones = existing.milestones || [];
        project.iterations = existing.iterations || [];
        project.nodes = existing.nodes;
        if (resourceSummary && existing.resourceSummary && existing.resourceSummary.teams) {
          Object.keys(existing.resourceSummary.teams).forEach(k => { if (!(k in resourceSummary.teams)) resourceSummary.teams[k] = existing.resourceSummary.teams[k]; });
        }
      }
    }

    const newState = { ...(state || {}), year: state?.year || new Date().getFullYear() };
    newState.projects = isNew ? [...(state?.projects || []), project] : (state?.projects || []).map(p => p.id === id ? project : p);
    const ok = await saveState(newState);
    if (ok) {
      await fetchState(); await fetchSummary();
      // 保存后返回台账页
      location.hash = '#/csenergy/ledger';
      currentView = 'ledger';
      currentProjectId = null;
      render();
    }
  }

  async function deleteProject(id) {
    if (!window.confirm('确定删除此项目？此操作不可撤销。')) return;
    const newState = { ...state };
    newState.projects = (state.projects || []).filter(p => p.id !== id);
    const ok = await saveState(newState);
    if (ok) { await fetchState(); await fetchSummary(); render(); }
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
    const formHtml = `<form class="form-grid">
      <div class="form-row"><label>名称</label><input type="text" id="ms-name" value="${esc(ms.name || '')}"></div>
      <div class="form-row"><label>节点(可选)</label><input type="text" id="ms-node" value="${esc(ms.node || '')}" placeholder="BR0/TR3 等"></div>
      <div class="form-row"><label>日期</label><input type="text" id="ms-date" value="${esc(ms.date || '')}" placeholder="YYYY-MM-DD"></div>
      <div class="form-row"><label>状态</label><select id="ms-status">
        <option value="pending" ${ms.status === 'pending' ? 'selected' : ''}>待完成</option>
        <option value="in-progress" ${ms.status === 'in-progress' ? 'selected' : ''}>进行中</option>
        <option value="done" ${ms.status === 'done' ? 'selected' : ''}>已完成</option>
      </select></div></form>`;
    SharedUI.confirm('编辑里程碑', formHtml, async () => {
      const name = document.getElementById('ms-name')?.value?.trim();
      if (!name) { SharedUI.toast('名称不能为空', 'warning'); return; }
      project.milestones[idx] = { name, node: document.getElementById('ms-node')?.value?.trim() || '', date: document.getElementById('ms-date')?.value?.trim() || '', status: document.getElementById('ms-status')?.value || 'pending' };
      const newState = { ...state };
      newState.projects = (state.projects || []).map(p => p.id === project.id ? project : p);
      const ok = await saveState(newState);
      if (ok) { await fetchState(); renderDetail(project.id); }
    }, { confirmText: '保存', cancelText: '取消' });
  }
  function showAddMilestone(project) {
    const formHtml = `<form class="form-grid">
      <div class="form-row"><label>名称</label><input type="text" id="ms-name" placeholder="例如：BR0 立项"></div>
      <div class="form-row"><label>节点(可选)</label><input type="text" id="ms-node" placeholder="BR0/TR3 等"></div>
      <div class="form-row"><label>日期</label><input type="text" id="ms-date" placeholder="YYYY-MM-DD"></div>
      <div class="form-row"><label>状态</label><select id="ms-status"><option value="pending">待完成</option><option value="in-progress">进行中</option><option value="done">已完成</option></select></div></form>`;
    SharedUI.confirm('添加里程碑', formHtml, async () => {
      const name = document.getElementById('ms-name')?.value?.trim();
      if (!name) { SharedUI.toast('名称不能为空', 'warning'); return; }
      if (!project.milestones) project.milestones = [];
      project.milestones.push({ name, node: document.getElementById('ms-node')?.value?.trim() || '', date: document.getElementById('ms-date')?.value?.trim() || '', status: document.getElementById('ms-status')?.value || 'pending' });
      const newState = { ...state };
      newState.projects = (state.projects || []).map(p => p.id === project.id ? project : p);
      const ok = await saveState(newState);
      if (ok) { await fetchState(); renderDetail(project.id); }
    }, { confirmText: '添加', cancelText: '取消' });
  }

  /* ==========================================================
     风险 CRUD
     ========================================================== */
  function buildRiskForm(risk) {
    const projects = (state && state.projects) || [];
    const projOptions = ['<option value="">（未关联）</option>'].concat(
      projects.map(p => `<option value="${esc(p.id)}" ${p.id === risk.projectId ? 'selected' : ''}>${esc(p.name)}</option>`)
    ).join('');
    const levelOpts = [['high', '高'], ['medium', '中'], ['low', '低']].map(([k, v]) => `<option value="${k}" ${k === risk.level ? 'selected' : ''}>${v}</option>`).join('');
    const stateOpts = [['open', '未闭环'], ['closed', '已闭环']].map(([k, v]) => `<option value="${k}" ${k === risk.state ? 'selected' : ''}>${v}</option>`).join('');
    return `<form class="form-grid">
      <input type="hidden" id="rf-id" value="${esc(risk.id || '')}">
      <div class="form-row"><label>所属项目</label><select id="rf-project">${projOptions}</select></div>
      <div class="form-row form-row-wide"><label>风险描述 *</label><textarea id="rf-desc" rows="2">${esc(risk.desc || '')}</textarea></div>
      <div class="form-row"><label>影响类型</label><input type="text" id="rf-impactType" value="${esc(risk.impactType || '')}" placeholder="进度/质量/成本"></div>
      <div class="form-row"><label>等级</label><select id="rf-level">${levelOpts}</select></div>
      <div class="form-row"><label>状态</label><select id="rf-state">${stateOpts}</select></div>
      <div class="form-row"><label>闭环进度(%)</label><input type="number" id="rf-progress" value="${risk.closeProgress || 0}" min="0" max="100"></div>
      <div class="form-row"><label>计划闭环日</label><input type="text" id="rf-planClose" value="${esc(risk.planCloseDate || '')}" placeholder="YYYY-MM-DD"></div>
      <div class="form-row form-row-wide"><label>所需资源支持</label><input type="text" id="rf-support" value="${esc(risk.resourceSupport || '')}"></div>
      <div class="form-row"><label>星标</label><select id="rf-star"><option value="false" ${!risk.star ? 'selected' : ''}>否</option><option value="true" ${risk.star ? 'selected' : ''}>是</option></select></div>
    </form>`;
  }
  function showAddRisk() {
    SharedUI.confirm('登记风险', buildRiskForm({ id: 'risk-' + Date.now().toString(36), level: 'medium', state: 'open', closeProgress: 0 }), () => submitRisk(true), { confirmText: '保存', cancelText: '取消' });
  }
  function showEditRisk(risk) {
    SharedUI.confirm('编辑风险', buildRiskForm(risk), () => submitRisk(false, risk.id), { confirmText: '保存', cancelText: '取消' });
  }
  async function submitRisk(isNew, existingId) {
    const g = (id) => document.getElementById(id);
    const id = g('rf-id')?.value || existingId;
    const desc = g('rf-desc')?.value?.trim();
    if (!desc) { SharedUI.toast('风险描述不能为空', 'warning'); return; }
    const projectId = g('rf-project')?.value || '';
    const proj = (state.projects || []).find(p => p.id === projectId);
    const risk = {
      id, star: g('rf-star')?.value === 'true',
      projectId, projectName: proj ? proj.name : '',
      desc, impactType: g('rf-impactType')?.value?.trim() || '',
      level: g('rf-level')?.value || 'medium',
      state: g('rf-state')?.value || 'open',
      closeProgress: Math.max(0, Math.min(100, Number(g('rf-progress')?.value) || 0)),
      planCloseDate: g('rf-planClose')?.value?.trim() || '',
      resourceSupport: g('rf-support')?.value?.trim() || '',
      createdAt: isNew ? new Date().toISOString().slice(0, 10) : undefined
    };
    const newState = { ...state };
    newState.risks = isNew ? [...(state.risks || []), risk] : (state.risks || []).map(r => r.id === id ? { ...r, ...risk } : r);
    const ok = await saveState(newState);
    if (ok) { await fetchState(); await fetchSummary(); render(); }
  }
  async function deleteRisk(id) {
    if (!window.confirm('确定删除此风险？')) return;
    const newState = { ...state };
    newState.risks = (state.risks || []).filter(r => r.id !== id);
    const ok = await saveState(newState);
    if (ok) { await fetchState(); await fetchSummary(); render(); }
  }

  /* ==========================================================
     资源 CRUD
     ========================================================== */
  function showAddResource() {
    const formHtml = `<form class="form-grid">
      <div class="form-row"><label>角色名称 *</label><input type="text" id="res-role" placeholder="系统SE / 电气 / 硬件..."></div>
      <div class="form-row"><label>投入度(人月)</label><input type="number" id="res-invest" value="0" min="0" step="0.1"></div>
    </form>`;
    SharedUI.confirm('新增角色投入', formHtml, async () => {
      const role = document.getElementById('res-role')?.value?.trim();
      if (!role) { SharedUI.toast('角色名称不能为空', 'warning'); return; }
      const invest = Number(document.getElementById('res-invest')?.value) || 0;
      const newState = { ...state };
      const res = { ...(state.resources || { human: [], material: [] }) };
      res.human = [...(res.human || []), { role, invest }];
      res.month = document.getElementById('csResMonth')?.value || res.month;
      res.dept = document.getElementById('csResDept')?.value || res.dept;
      newState.resources = res;
      const ok = await saveState(newState);
      if (ok) { await fetchState(); render(); }
    }, { confirmText: '添加', cancelText: '取消' });
  }

  /* ==========================================================
     主渲染 + 事件绑定
     ========================================================== */
  function render() {
    if (!container) return;
    if (currentView === 'detail' && currentProjectId) { renderDetail(currentProjectId); return; }
    if (currentView === 'new') { renderProjectForm('new'); return; }
    if (currentView === 'edit' && currentProjectId) { renderProjectForm('edit', currentProjectId); return; }

    const tabs = [
      { id: 'board', icon: '📊', label: '立项管理看板' },
      { id: 'ledger', icon: '📒', label: '项目台账' },
      { id: 'timeline', icon: '📆', label: '周期视图' },
      { id: 'release', icon: '🚀', label: '年度发布' },
      { id: 'risk', icon: '⚠️', label: '风险全景' },
      { id: 'resource', icon: '📦', label: '资源管理' }
    ].map(t => `<button class="cs-tab ${t.id === currentView ? 'active' : ''}" data-view="${t.id}"><span>${t.icon}</span> ${t.label}</button>`).join('');

    let body;
    if (currentView === 'board') body = renderBoard();
    else if (currentView === 'ledger') body = renderLedger();
    else if (currentView === 'timeline') body = renderTimeline();
    else if (currentView === 'release') body = renderRelease();
    else if (currentView === 'risk') body = renderRisk();
    else if (currentView === 'resource') body = renderResource();

    container.innerHTML = `<div class="csenergy-page"><div class="cs-topnav">${tabs}</div><div class="cs-view-body">${body}</div></div>`;
    bindEvents();
  }

  function bindEvents() {
    container.querySelectorAll('.cs-tab').forEach(btn => btn.addEventListener('click', () => {
      const v = btn.getAttribute('data-view');
      if (v && v !== currentView) { location.hash = '#/csenergy/' + v; }
    }));
    container.querySelectorAll('[data-year]').forEach(btn => btn.addEventListener('click', () => { filterYear = Number(btn.getAttribute('data-year')); render(); }));

    // 项目 CRUD —— 跳转二级页面
    const addProjBtn = document.getElementById('csAddProjectBtn');
    if (addProjBtn) addProjBtn.addEventListener('click', () => { location.hash = '#/csenergy/new'; });
    container.querySelectorAll('[data-edit-proj]').forEach(btn => btn.addEventListener('click', () => {
      location.hash = '#/csenergy/edit/' + btn.getAttribute('data-edit-proj');
    }));
    container.querySelectorAll('[data-del-proj]').forEach(btn => btn.addEventListener('click', () => deleteProject(btn.getAttribute('data-del-proj'))));

    // 风险 CRUD
    const addRiskBtn = document.getElementById('csAddRiskBtn');
    if (addRiskBtn) addRiskBtn.addEventListener('click', showAddRisk);
    container.querySelectorAll('[data-edit-risk]').forEach(btn => btn.addEventListener('click', () => {
      const r = (state.risks || []).find(x => x.id === btn.getAttribute('data-edit-risk')); if (r) showEditRisk(r);
    }));
    container.querySelectorAll('[data-del-risk]').forEach(btn => btn.addEventListener('click', () => deleteRisk(btn.getAttribute('data-del-risk'))));

    // 资源
    const addResBtn = document.getElementById('csAddResBtn');
    if (addResBtn) addResBtn.addEventListener('click', showAddResource);
  }

  async function load() {
    if (container) container.innerHTML = '<div class="cs-loading">加载中...</div>';
    await Promise.all([fetchState(), fetchSummary()]);
    render();
  }

  function applySubPath(subPath) {
    if (subPath && subPath.startsWith('detail/')) {
      currentView = 'detail';
      currentProjectId = subPath.replace('detail/', '');
    } else if (subPath && subPath.startsWith('edit/')) {
      currentView = 'edit';
      currentProjectId = subPath.replace('edit/', '');
    } else if (subPath === 'new') {
      currentView = 'new';
      currentProjectId = null;
    } else if (['board', 'ledger', 'timeline', 'release', 'risk', 'resource'].includes(subPath)) {
      currentView = subPath;
      currentProjectId = null;
    } else {
      currentView = 'board';
      currentProjectId = null;
    }
  }

  /* ---------- ModuleDefinition 接口 ---------- */
  return {
    id: 'csenergy',
    name: '全年度项目管理看板',
    icon: '📊',
    order: 2,
    sidebar: true,

    init(el, context) {
      container = el;
      applySubPath((context && context.subPath) || '');
      load();
    },
    enter(subPath) {
      applySubPath(subPath);
      if (!state) { load(); } else { render(); }
    },
    leave() { },
    getSummary() {
      return summary ? summary.metrics : { approved: 0, inProgress: 0 };
    }
  };
})();
