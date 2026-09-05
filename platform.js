/* ============================================================
   platform.js — Platform shell orchestrator
   Registers modules, renders sidebar navigation, manages layout
   state (collapse/expand/mobile), binds router, and provides
   shared platform services (toast, breadcrumb, badge, whoami).
   ============================================================ */

// eslint-disable-next-line no-unused-vars
const Platform = (() => {
  'use strict';

  const SIDEBAR_KEY = 'sidebar_collapsed';
  const USER_KEY = 'wb_who';

  let modules = [];          // ordered array of ModuleDefinition objects
  let moduleMap = {};        // { moduleId: ModuleDefinition }
  let sidebarCollapsed = false;
  let mobileOpen = false;

  /* ============================================================
     Sidebar Rendering
     ============================================================ */

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
      return `<a class="sidebar-nav-item" href="${SharedUI.esc(href)}" data-module="${SharedUI.esc(m.id)}" data-tooltip="${SharedUI.esc(m.name)}">
        <span class="nav-icon">${SharedUI.esc(m.icon || '')}</span>
        <span class="nav-label">${SharedUI.esc(m.name)}</span>
        <span class="nav-badge hidden" id="badge-${SharedUI.esc(m.id)}"></span>
      </a>`;
    }).join('');

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
  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    applySidebarState();
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? 'true' : 'false');
    } catch (e) { /* localStorage might be unavailable */ }
    // 用户手动展开侧栏后，重新允许子页因内容拥挤而发起自动收起
    if (!sidebarCollapsed) autoCollapseFired = false;
  }

  /*
   * 子页（迭代工作台 iframe）因内容拥挤发起自动收起侧栏。
   * 只在侧栏当前展开且尚未曾自动收起时响应一次，避免每次渲染都强行打断用户手动展开。
   */
  let autoCollapseFired = false;
  function collapseSidebar() {
    if (sidebarCollapsed || autoCollapseFired) return;
    sidebarCollapsed = true;
    autoCollapseFired = true;
    applySidebarState();
    try {
      localStorage.setItem(SIDEBAR_KEY, 'true');
    } catch (e) { /* localStorage might be unavailable */ }
  }

  /* 接收 iframe 发送的「内容拥挤 → 收起侧栏」请求 */
  function handleFrameMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.source !== 'iterationFrame' || data.type !== 'autoCollapseSidebar') return;
    // 同源校验：仅接受本平台自己 iframe 的消息
    if (event.origin && event.source && event.origin !== window.location.origin) return;
    collapseSidebar();
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
      // Tablet: auto-collapse unless user explicitly expanded
      const sidebar = document.getElementById('sidebar');
      if (sidebar && !sidebar.classList.contains('expanded')) {
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

  /**
   * Get current user name.
   * 1. Try localStorage key 'wb_who'
   * 2. Fall back to legacy key 'workbench-user'
   * 3. If not found, prompt the user
   * @returns {string} User name
   */
  function whoami() {
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

    // Render sidebar navigation items
    renderSidebarNav();

    // Apply sidebar state
    applySidebarState();

    // Render user name in navbar
    renderNavbarUser();

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
    whoami,

    // Internal helper exposed for Router to call
    _highlightNav: highlightNav
  };
})();
