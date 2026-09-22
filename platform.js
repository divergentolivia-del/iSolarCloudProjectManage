/* ============================================================
   platform.js — Platform shell orchestrator
   Registers modules, renders sidebar navigation, manages layout
   state (collapse/expand/mobile), binds router, and provides
   shared platform services (toast, breadcrumb, badge, whoami).
   ============================================================ */

// eslint-disable-next-line no-unused-vars
const Platform = (() => {
  'use strict';

  /* ============================================================
     统一 401 处理（M1 Step 4.5）
     登录态失效时，任何 API 返回 401 且带 login 字段 → 跳登录页并带回跳地址。
     防御：只包一次；登录页自身不跳；非 JSON 响应不读 body。
     服务端行为（见 server.js gate）：API → 401 {error, login:'/login.html'}；
     页面请求 → 302 login.html?next=。这里只接管 API 的 401。
     ============================================================ */
  if (typeof window !== 'undefined' && !window.__wbFetchWrapped) {
    window.__wbFetchWrapped = true;
    const _origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      return _origFetch(input, init).then(resp => {
        if (resp && resp.status === 401) {
          try {
            const ct = resp.headers.get('content-type') || '';
            if (ct.indexOf('application/json') >= 0) {
              resp.clone().json().then(j => {
                if (j && typeof j.login === 'string' && j.login &&
                    !/login\.html/.test(window.location.pathname)) {
                  const next = encodeURIComponent(
                    window.location.pathname + window.location.search + window.location.hash
                  );
                  window.location.href = j.login + (next ? '?next=' + next : '');
                }
              }).catch(() => { /* 读取失败不影响原响应 */ });
            }
          } catch (e) { /* 异常不影响原响应 */ }
        }
        return resp;
      });
    };
  }

  const SIDEBAR_KEY = 'sidebar_collapsed';
  const USER_KEY = 'wb_who';

  let modules = [];          // ordered array of ModuleDefinition objects
  let moduleMap = {};        // { moduleId: ModuleDefinition }
  let sidebarCollapsed = false;
  let mobileOpen = false;

  /* ============================================================
     Sidebar Rendering
     ============================================================ */

  /** 各功能模块专属图标配色：渐变色瓦片 + 唯一 emoji，避免同类图标混淆 */
  const NAV_ICON_COLORS = {
    dashboard: { icon: '🏠', bg: 'linear-gradient(135deg, #4c7dff, #6a9bff)', shadow: 'rgba(76,125,255,.35)' },
    iteration: { icon: '📚', bg: 'linear-gradient(135deg, #1fa38a, #38c9ac)', shadow: 'rgba(31,163,138,.35)' },
    csenergy:  { icon: '📊', bg: 'linear-gradient(135deg, #8b6cff, #a68bff)', shadow: 'rgba(139,108,255,.35)' },
    plan:      { icon: '🗓️', bg: 'linear-gradient(135deg, #f59a24, #ffb857)', shadow: 'rgba(245,154,36,.35)' },
    dataflow:  { icon: '🔄', bg: 'linear-gradient(135deg, #0ea5b7, #38cfe0)', shadow: 'rgba(14,165,183,.35)' },
    inbox:     { icon: '📥', bg: 'linear-gradient(135deg, #e04f5f, #ff7b88)', shadow: 'rgba(224,79,95,.35)' },
    settings:  { icon: '⚙',  bg: 'linear-gradient(135deg, #8a94a6, #a6b0c2)', shadow: 'rgba(138,148,166,.35)' },
    help:      { icon: '📖', bg: 'linear-gradient(135deg, #8a94a6, #a6b0c2)', shadow: 'rgba(138,148,166,.35)' }
  };
  function navLook(id) {
    return NAV_ICON_COLORS[id] || { icon: '', bg: 'linear-gradient(135deg, #8a94a6, #a6b0c2)', shadow: 'rgba(138,148,166,.35)' };
  }

  /**
   * Render sidebar navigation items into #sidebarNav.
   * Only renders modules with sidebar !== false, sorted by order.
   */
  function renderSidebarNav() {
    const nav = document.getElementById('sidebarNav');
    if (!nav) return;

    const sidebarModules = modules
      .filter(m => m.sidebar !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    nav.innerHTML = sidebarModules.map(m => {
      const href = '#/' + (m.id === 'dashboard' ? 'dashboard' : m.id);
      const look = navLook(m.id);
      return `<a class="sidebar-nav-item" href="${SharedUI.esc(href)}" data-module="${SharedUI.esc(m.id)}" data-tooltip="${SharedUI.esc(m.name)}" data-navcolor="${SharedUI.esc(m.id)}">
        <span class="nav-icon" style="--nav-bg:${look.bg};--nav-shadow:${look.shadow}">${SharedUI.esc(m.icon || look.icon)}</span>
        <span class="nav-label">${SharedUI.esc(m.name)}</span>
        <span class="nav-badge hidden" id="badge-${SharedUI.esc(m.id)}"></span>
      </a>`;
    }).join('');

    // 静态 footer 项（系统设置 / 使用帮助）也应用同款图标瓦片
    nav.querySelectorAll('.nav-icon[data-fixed]').forEach(ic => {
      const id = ic.getAttribute('data-fixed');
      const look = navLook(id);
      ic.style.setProperty('--nav-bg', look.bg);
      ic.style.setProperty('--nav-shadow', look.shadow);
    });

    // Bind click handlers for mobile close
    nav.querySelectorAll('.sidebar-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        if (mobileOpen) {
          closeMobileSidebar();
        }
      });
    });
  }

  /**
   * Highlight the active navigation item in the sidebar.
   * Dashboard sub-pages (budget, token) keep 'dashboard' active.
   * @param {string} moduleId - The module to highlight
   */
  function highlightNav(moduleId) {
    const nav = document.getElementById('sidebarNav');
    if (!nav) return;

    nav.querySelectorAll('.sidebar-nav-item').forEach(item => {
      const itemModule = item.getAttribute('data-module');
      if (itemModule === moduleId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }

  /* ============================================================
     Sidebar Collapse / Expand
     ============================================================ */

  /**
   * Apply the current collapse state to the sidebar DOM.
   */
  function applySidebarState() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    if (sidebarCollapsed) {
      sidebar.classList.add('collapsed');
      sidebar.classList.remove('expanded');
    } else {
      sidebar.classList.remove('collapsed');
      sidebar.classList.add('expanded');
    }
  }

  /**
   * Toggle sidebar collapsed state and persist preference.
   */
  /* 用户是否「主动展开」过侧栏。
     必须单独记，不能靠 .expanded 类判断：applySidebarState() 只要处于非收起状态就会加
     .expanded，于是「默认展开」和「用户主动展开」在 DOM 上无法区分，
     handleResize 里那个 !contains('expanded') 的守卫因此永远为假、分支成为死代码
     （表现：<1200px 时 CSS 本意让侧栏默认窄，JS 却始终把它撑回 220px）。 */
  let userExpandedManually = false;

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    userExpandedManually = !sidebarCollapsed;   // 展开=用户主动要宽的；收起=清除
    applySidebarState();
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? 'true' : 'false');
    } catch (e) { /* localStorage might be unavailable */ }
    // 用户手动切换（无论收/展），都清除「自动收起」标记：
    // - 手动展开 → 允许 iframe 日后因拥挤再自动收起
    // - 手动收起 → 若再自动展开会打扰用户，故也清除，避免 iframe 误恢复
    autoCollapseFired = false;
    notifySidebarState(true);
  }

  /*
   * 子页（迭代工作台 iframe）因内容拥挤发起自动收起侧栏，
   * 或内容不再拥挤时发起恢复展开。
   * 收起只在侧栏当前展开且尚未曾自动收起时响应一次，避免每次渲染都强行打断用户手动展开。
   */
  let autoCollapseFired = false;
  function collapseSidebar() {
    if (sidebarCollapsed || autoCollapseFired) return;
    /* 用户主动展开过 → 不再自动收起。
       原先只有「手动收起 → 不自动展开」这一半，缺了对称的另一半，导致用户手动展开侧栏后
       立刻又被拥挤协议收回去，等于用户的明确意图被无视。宽表本身有独立横向滚动条，
       让用户自己决定要不要那 160px 更合理。手动收起时该标记会被清掉，自动收起随之恢复。 */
    if (userExpandedManually) return;
    sidebarCollapsed = true;
    autoCollapseFired = true;
    applySidebarState();
    try {
      localStorage.setItem(SIDEBAR_KEY, 'true');
    } catch (e) { /* localStorage might be unavailable */ }
    notifySidebarState();
  }
  /* 子页请求恢复展开：收起是自动发起的才恢复，用户手动收起不打扰 */
  function expandSidebar() {
    if (!sidebarCollapsed) return;
    if (!autoCollapseFired) return; // 用户手动收起 → 不自动展开
    sidebarCollapsed = false;
    autoCollapseFired = false;
    applySidebarState();
    try {
      localStorage.setItem(SIDEBAR_KEY, 'false');
    } catch (e) { /* localStorage might be unavailable */ }
    notifySidebarState();
  }

  /* 向子树广播当前侧栏状态，供 iframe 判断是否需要恢复。
     manual=true 表示用户手动切换（此时应解除 iframe 的防闪避、允许再次自动收起）。 */
  function notifySidebarState(manual) {
    try {
      const frame = document.getElementById('iterationFrame');
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(
          { source: 'platform', type: 'sidebarState', collapsed: sidebarCollapsed, auto: autoCollapseFired, manual: !!manual },
          window.location.origin
        );
      }
    } catch (e) { /* 跨源或已卸载，忽略 */ }
  }

  /* 接收 iframe 的「内容拥挤 → 收起侧栏」/「内容不再拥挤 → 恢复展开」/「查询当前状态」请求 */
  function handleFrameMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.source !== 'iterationFrame') return;
    if (data.type !== 'autoCollapseSidebar' && data.type !== 'restoreSidebar' && data.type !== 'getSidebarState') return;
    // 同源校验：仅接受本平台自己 iframe 的消息
    if (event.origin && event.source && event.origin !== window.location.origin) return;
    if (data.type === 'getSidebarState') {
      try {
        if (event.source) {
          event.source.postMessage(
            { source: 'platform', type: 'sidebarState', collapsed: sidebarCollapsed, auto: autoCollapseFired },
            window.location.origin
          );
        }
      } catch (e) { /* 已卸载，忽略 */ }
      return;
    }
    /* 只有「迭代工作台」正在前台时才响应它的侧栏请求。
       iframe 一旦创建就常驻 DOM，即使切到别的模块也还在。它内部监听 window resize
       重新测量拥挤度，而侧栏收/展本身就会改变 iframe 宽度 —— 于是：
         别的模块（如项目计划）因宽表收起侧栏
           → iframe 变宽被 resize
           → 这个当前不可见的迭代视图判定「我不挤」
           → 发 restoreSidebar
           → 侧栏又展开，宽表被裁
       两个模块共用同一个 autoCollapseFired 标志，后台模块就这样否决了前台模块的决定，
       表现为「切到内容多的 Tab，先收起又自动展开」。加前台校验即可切断这条回路。 */
    if (!isIterationActive()) return;
    if (data.type === 'autoCollapseSidebar') collapseSidebar();
    else expandSidebar();
  }
  function isIterationActive() {
    try {
      if (typeof Router === 'undefined' || typeof Router.current !== 'function') return true;
      const cur = Router.current();
      return !!(cur && cur.moduleId === 'iteration');
    } catch (e) {
      return true;   // 取不到路由时保持原有行为，不要把功能整个关掉
    }
  }

  /**
   * Load sidebar collapse preference from localStorage.
   */
  function loadSidebarPreference() {
    try {
      const stored = localStorage.getItem(SIDEBAR_KEY);
      if (stored === 'true') {
        sidebarCollapsed = true;
      } else if (stored === 'false') {
        sidebarCollapsed = false;
      }
      // If no stored preference, leave default (expanded for desktop)
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
     Mobile Sidebar (Overlay)
     ============================================================ */

  function openMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (sidebar) sidebar.classList.add('mobile-open');
    if (backdrop) backdrop.classList.add('visible');
    mobileOpen = true;
  }

  function closeMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (backdrop) backdrop.classList.remove('visible');
    mobileOpen = false;
  }

  /* ============================================================
     Responsive Resize Handling
     ============================================================ */

  /**
   * Handle window resize — auto-collapse sidebar on narrow viewports.
   */
  function handleResize() {
    const width = window.innerWidth;

    if (width < 768) {
      // Mobile: sidebar hidden by default, controlled by hamburger
      closeMobileSidebar();
    } else if (width < 1200) {
      /* 平板宽度：默认收起，除非用户主动展开过。
         与 platform.css 的 @media (max-width:1199px) 一致 —— 该断点里
         .sidebar 的默认宽度就是收起宽度，JS 状态理应跟 CSS 意图一致。 */
      if (!userExpandedManually && !sidebarCollapsed) {
        sidebarCollapsed = true;
        applySidebarState();
      }
    }
    // Desktop (>=1200): respect user preference
  }

  /* ============================================================
     Navbar User Display
     ============================================================ */

  /**
   * Render the current user name in the navbar.
   */
  function renderNavbarUser() {
    const el = document.getElementById('navbarUser');
    if (!el) return;
    const name = whoami();
    el.textContent = name;
  }

  /* ============================================================
     User Identity (whoami)
     ============================================================ */

  /* 服务端返回的登录用户（见 refreshIdentity）。
     whoami() 有十几处同步调用点，改签名会牵动一大片，
     所以这里缓存一份，whoami() 保持「同步返回字符串」不变。 */
  let _serverUser = null;
  let _serverPermissions = [];
  let _serverIsInitialPwd = false;

  /* 「初始口令」提示条的关闭状态。
     存 sessionStorage 而不是 localStorage：本次登录会话不再打扰，
     但下次再登录还会提醒一次 —— 目的就是把人烦到去改口令。 */
  const PWD_NOTICE_KEY = 'wb_pwd_notice_closed';

  /**
   * 初始口令提示条：还挂着批量建号发的口令时显示，否则隐藏。
   * 未启用登录（_serverUser 为空）时不显示 —— 那种模式下根本没有账号概念。
   */
  function renderPwdNotice() {
    const el = document.getElementById('pwdNotice');
    if (!el) return;
    let closed = false;
    try { closed = sessionStorage.getItem(PWD_NOTICE_KEY) === '1'; } catch (e) { /* 隐私模式下取不到，当作没关过 */ }
    el.classList.toggle('hidden', !(_serverUser && _serverIsInitialPwd) || closed);
  }

  /** 绑定「×」：关掉并记住，本次会话不再出现 */
  function bindPwdNotice() {
    const btn = document.getElementById('pwdNoticeClose');
    if (!btn) return;
    btn.addEventListener('click', () => {
      try { sessionStorage.setItem(PWD_NOTICE_KEY, '1'); } catch (e) { /* ignore */ }
      renderPwdNotice();
    });
  }

  /**
   * 向服务端确认「我是谁」。
   * 登录未启用时服务端返回 { user: null }，此时退回原来的本地昵称逻辑。
   * @returns {Promise<void>}
   */
  function refreshIdentity() {
    return fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : { user: null })
      .then(d => {
        if (d && d.user) {
          _serverUser = d.user;
          _serverPermissions = d.permissions || [];
          _serverIsInitialPwd = !!d.isInitialPwd;
          /* 顺手清掉旧的假身份，避免它继续散落在 localStorage 里 */
          try {
            localStorage.removeItem(USER_KEY);
            localStorage.removeItem('workbench-user');
          } catch (e) { /* ignore */ }
        } else {
          _serverUser = null;
          _serverIsInitialPwd = false;
        }
        renderPwdNotice();
        /* 身份（或权限）可能已变化：广播给各模块，让保存按钮等按权限刷新 */
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('platform:identity'));
        }
      })
      .catch(() => { _serverUser = null; });
  }

  /** 当前登录用户（未启用登录时为 null） */
  function currentUser() { return _serverUser; }

  /** 是否拥有某个权限，如 'plan:write'（未启用登录时不拦，返回 true） */
  function can(resource) {
    if (!_serverUser) return true;
    if (_serverUser.role === 'admin') return true;
    return _serverPermissions.indexOf(resource) >= 0;
  }

  /**
   * Get current user name.
   * 1. 已登录 → 用服务端返回的姓名（唯一可信来源）
   * 2. 未启用登录 → 退回 localStorage 键 'wb_who'
   * 3. 再退回旧键 'workbench-user'
   * 4. 都没有则询问
   * @returns {string} User name
   */
  function whoami() {
    if (_serverUser && _serverUser.name) return _serverUser.name;

    let name = '';
    try {
      name = localStorage.getItem(USER_KEY) || '';
      // Also check legacy key for backward compat
      if (!name) {
        name = localStorage.getItem('workbench-user') || '';
        if (name) {
          // Migrate to new key
          localStorage.setItem(USER_KEY, name);
        }
      }
    } catch (e) { /* ignore */ }

    if (!name) {
      name = (window.prompt('请输入你的姓名（用于记录操作人）') || '').trim();
      if (name) {
        try {
          localStorage.setItem(USER_KEY, name);
          // Also set legacy key for sync.js compat
          localStorage.setItem('workbench-user', name);
        } catch (e) { /* ignore */ }
      }
    }

    return name || '未署名';
  }

  /* ============================================================
     Module Container Management
     ============================================================ */

  /**
   * Pre-create DOM containers for all registered modules.
   * Containers already present in HTML are not recreated.
   */
  function ensureModuleContainers() {
    const mainContent = document.getElementById('mainContent');
    if (!mainContent) return;

    modules.forEach(m => {
      const containerId = 'module-' + m.id;
      if (!document.getElementById(containerId)) {
        const div = document.createElement('div');
        div.id = containerId;
        div.className = 'module-view hidden';
        mainContent.appendChild(div);
      }
    });
  }

  /* ============================================================
     Breadcrumb
     ============================================================ */

  /**
   * Update the breadcrumb bar with given items.
   * @param {Array<{label: string, href?: string}>} items
   */
  function setBreadcrumb(items) {
    const bar = document.getElementById('breadcrumbBar');
    if (!bar) return;
    bar.innerHTML = SharedUI.renderBreadcrumb(items || []);
  }

  /* ============================================================
     Toast
     ============================================================ */

  /**
   * Show a transient toast notification.
   * @param {string} msg - Message text
   * @param {string} [type='info'] - Type: 'info' | 'success' | 'error' | 'warning'
   */
  function toast(msg, type) {
    SharedUI.toast(msg, type);
  }

  /* ============================================================
     Badge
     ============================================================ */

  /**
   * Update the badge count on a navigation item.
   * @param {string} moduleId - Module ID
   * @param {number} count - Badge number (0 or falsy hides the badge)
   */
  function setBadge(moduleId, count) {
    const badge = document.getElementById('badge-' + moduleId);
    if (!badge) return;

    if (count && count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.remove('hidden');
    } else {
      badge.textContent = '';
      badge.classList.add('hidden');
    }
  }

  /* ============================================================
     Notification Dropdown
     ============================================================ */

  /**
   * Toggle the notification dropdown panel.
   * Fetches latest alerts from /api/dashboard/summary and shows them.
   */
  async function toggleNotificationDropdown() {
    let dropdown = document.getElementById('notificationDropdown');

    // Create dropdown if not exists
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.id = 'notificationDropdown';
      dropdown.className = 'notification-dropdown hidden';
      document.body.appendChild(dropdown);
    }

    // Toggle visibility
    if (!dropdown.classList.contains('hidden')) {
      dropdown.classList.add('hidden');
      return;
    }

    // Fetch alerts
    dropdown.innerHTML = '<div class="notification-loading">加载中...</div>';
    dropdown.classList.remove('hidden');

    try {
      const resp = await fetch('/api/dashboard/summary');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const alerts = data.alerts || [];

      if (alerts.length === 0) {
        dropdown.innerHTML = '<div class="notification-empty">暂无告警通知</div>';
      } else {
        const items = alerts.map(a => {
          const icon = (a.type || '').startsWith('budget') ? '⚠' : a.type === 'token-warning' ? '🤖' : '⚠';
          return `<div class="notification-item"><span class="notification-icon">${icon}</span><span class="notification-text">${SharedUI.esc(a.message || '')}</span></div>`;
        }).join('');
        dropdown.innerHTML = `<div class="notification-header">告警通知 (${alerts.length})</div>${items}`;
      }
    } catch (e) {
      dropdown.innerHTML = '<div class="notification-empty">获取通知失败</div>';
    }
  }

  /* ============================================================
     Dark Theme on Load
     ============================================================ */

  /**
   * Apply dark theme if persisted in localStorage.
   */
  function applyPersistedTheme() {
    try {
      const theme = localStorage.getItem('platform_theme');
      if (theme === 'dark') {
        document.body.classList.add('dark-theme');
      }
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
     Whitelist / Readonly Mode
     ============================================================ */

  /**
   * Check platform config for whitelist mode.
   * If editMode is 'whitelist' and current user is NOT in the list,
   * apply readonly mode to the body.
   */
  function checkWhitelist() {
    fetch('/api/platform/config')
      .then(r => r.json())
      .then(config => {
        if (config.editMode === 'whitelist' && Array.isArray(config.whitelist) && config.whitelist.length > 0) {
          const user = whoami();
          if (!config.whitelist.includes(user)) {
            document.body.classList.add('readonly-mode');
            // Show readonly banner
            const banner = document.createElement('div');
            banner.className = 'readonly-banner';
            banner.textContent = '当前为只读模式（' + user + '不在编辑白名单中）';
            document.body.insertBefore(banner, document.body.firstChild);
          }
        }
      })
      .catch(() => { /* 获取配置失败时不阻塞页面 */ });
  }

  /* ============================================================
     Platform Init
     ============================================================ */

  /**
   * Initialize the platform shell.
   * - Register modules
   * - Render sidebar navigation
   * - Render navbar user
   * - Set up sidebar collapse/expand
   * - Set up mobile hamburger
   * - Set up responsive resize
   * - Bind router
   *
   * @param {Array<ModuleDefinition>} moduleList - Array of module definitions
   */
  function init(moduleList) {
    modules = (moduleList || []).slice();
    moduleMap = {};
    modules.forEach(m => {
      if (m && m.id) moduleMap[m.id] = m;
    });

    // Apply persisted dark theme
    applyPersistedTheme();

    // Load sidebar preference
    loadSidebarPreference();

    /* 先问服务端「我是谁」，再决定导航栏显示谁。
       拿不到就照旧走本地昵称，行为与从前一致。 */
    refreshIdentity().then(() => {
      renderNavbarUser();
    });

    // Render sidebar navigation items
    renderSidebarNav();

    // Apply sidebar state
    applySidebarState();

    // Render user name in navbar
    renderNavbarUser();

    // Bind 初始口令提示条的关闭按钮（显示与否由 refreshIdentity 决定）
    bindPwdNotice();

    // Pre-create module containers
    ensureModuleContainers();

    // Check whitelist / readonly mode
    checkWhitelist();

    // Bind sidebar collapse button
    const collapseBtn = document.getElementById('sidebarCollapseBtn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', toggleSidebar);
    }

    // Listen for iteration-frame auto-collapse requests
    window.addEventListener('message', handleFrameMessage);

    // Bind hamburger button (mobile)
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    if (hamburgerBtn) {
      hamburgerBtn.addEventListener('click', () => {
        if (mobileOpen) {
          closeMobileSidebar();
        } else {
          openMobileSidebar();
        }
      });
    }

    // Bind notification bell button
    const notifyBtn = document.getElementById('navbarNotify');
    if (notifyBtn) {
      notifyBtn.addEventListener('click', toggleNotificationDropdown);
    }

    // Bind settings button
    const settingsBtn = document.getElementById('navbarSettings');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        window.location.hash = '#/dashboard/settings';
      });
    }

    // Bind sidebar help link — show toast instead of navigating
    const helpLink = document.getElementById('sidebarHelp');
    if (helpLink) {
      helpLink.addEventListener('click', (event) => {
        event.preventDefault();
        SharedUI.toast('帮助文档建设中', 'info');
      });
    }

    // Close notification dropdown on outside click
    document.addEventListener('click', (e) => {
      const dropdown = document.getElementById('notificationDropdown');
      const btn = document.getElementById('navbarNotify');
      if (dropdown && !dropdown.contains(e.target) && e.target !== btn) {
        dropdown.classList.add('hidden');
      }
    });

    // Bind backdrop click (mobile)
    const backdrop = document.getElementById('sidebarBackdrop');
    if (backdrop) {
      backdrop.addEventListener('click', closeMobileSidebar);
    }

    // Responsive resize handling
    window.addEventListener('resize', handleResize);

    // Initial responsive check
    handleResize();

    // Initialize the router with the module map
    if (typeof Router !== 'undefined' && Router.init) {
      Router.init(modules);

      // 每次路由变化都同步侧栏选中态（兜底，防止首次时序错位导致高亮扑空）
      if (typeof Router.onChange === 'function') {
        Router.onChange(function (route) {
          if (route && route.moduleId) highlightNav(route.moduleId);
        });
      }

      // 初始化后立即按当前路由高亮一次（此时侧栏 DOM 已渲染）
      if (typeof Router.current === 'function') {
        var cur = Router.current();
        if (cur && cur.moduleId) highlightNav(cur.moduleId);
      }
    }
  }

  /**
   * Get all registered modules.
   * @returns {Array<ModuleDefinition>}
   */
  function getModules() {
    return modules.slice();
  }

  /**
   * Get a specific module by ID.
   * @param {string} moduleId
   * @returns {ModuleDefinition|undefined}
   */
  function getModule(moduleId) {
    return moduleMap[moduleId];
  }

  // Public API
  return {
    init,
    getModules,
    getModule,
    toast,
    setBreadcrumb,
    setBadge,
    toggleSidebar,
    collapseSidebar,
    expandSidebar,
    whoami,
    currentUser,
    can,
    refreshIdentity,

    // Internal helper exposed for Router to call
    _highlightNav: highlightNav
  };
})();
