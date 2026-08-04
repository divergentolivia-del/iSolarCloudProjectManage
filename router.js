/* ============================================================
   router.js — Hash-based client-side router
   Parses URL hash into moduleId + subPath, manages module
   lifecycle (init/enter/leave), and updates navigation state.
   ============================================================ */

// eslint-disable-next-line no-unused-vars
const Router = (() => {
  'use strict';

  let moduleMap = {};          // { moduleId: ModuleDefinition }
  let activeModuleId = null;   // currently active module id
  let initialized = new Set(); // set of module ids that have been init()'d
  let callbacks = [];          // onChange listeners
  let currentRoute = { moduleId: 'dashboard', subPath: '' };

  /**
   * Parse a URL hash string into { moduleId, subPath }
   * Examples:
   *   '' | '#' | '#/' → { moduleId: 'dashboard', subPath: '' }
   *   '#/iteration' → { moduleId: 'iteration', subPath: '' }
   *   '#/iteration/analysis' → { moduleId: 'iteration', subPath: 'analysis' }
   *   '#/dashboard/budget' → { moduleId: 'dashboard', subPath: 'budget' }
   *   '#/project/detail/proj-001' → { moduleId: 'project', subPath: 'detail/proj-001' }
   */
  function parseRoute(hash) {
    const stripped = (hash || '').replace(/^#\/?/, '');
    if (!stripped) {
      return { moduleId: 'dashboard', subPath: '' };
    }
    const parts = stripped.split('/');
    const moduleId = parts[0] || 'dashboard';
    const subPath = parts.slice(1).join('/');
    return { moduleId, subPath };
  }

  /**
   * Resolve the effective module for a parsed route.
   * Falls back to dashboard for unregistered or disabled modules.
   */
  function resolveModule(parsed) {
    let { moduleId, subPath } = parsed;
    const mod = moduleMap[moduleId];
    if (!mod || mod.enabled === false) {
      moduleId = 'dashboard';
      subPath = '';
    }
    return { moduleId, subPath };
  }

  /**
   * Determine which sidebar nav item should be active for a given route.
   * Dashboard sub-pages (budget, token) keep 'dashboard' as the active nav item.
   */
  function getActiveNavId(moduleId) {
    // Dashboard and its sub-pages all highlight the dashboard nav item
    return moduleId;
  }

  /**
   * Build breadcrumb items for the current route.
   */
  function buildBreadcrumb(moduleId, subPath) {
    const mod = moduleMap[moduleId];
    const items = [];

    if (moduleId === 'dashboard' && !subPath) {
      items.push({ label: '首页' });
    } else if (moduleId === 'dashboard' && subPath === 'budget') {
      items.push({ label: '首页', href: '#/dashboard' });
      items.push({ label: '人力预算管理' });
    } else if (moduleId === 'dashboard' && subPath === 'token') {
      items.push({ label: '首页', href: '#/dashboard' });
      items.push({ label: 'AI/Token 使用记录' });
    } else if (moduleId === 'iteration') {
      if (!subPath) {
        items.push({ label: mod ? mod.name : '阳光云迭代项目' });
      } else {
        items.push({ label: mod ? mod.name : '阳光云迭代项目', href: '#/iteration' });
        items.push({ label: subPath });
      }
    } else if (moduleId === 'project') {
      if (!subPath) {
        items.push({ label: mod ? mod.name : '全年度项目管理' });
      } else if (subPath.startsWith('detail/')) {
        items.push({ label: mod ? mod.name : '全年度项目管理', href: '#/project' });
        items.push({ label: '项目详情' });
      } else {
        items.push({ label: mod ? mod.name : '全年度项目管理', href: '#/project' });
        items.push({ label: subPath });
      }
    } else {
      // Generic fallback
      if (mod) {
        items.push({ label: mod.name });
      } else {
        items.push({ label: moduleId });
      }
    }

    return items;
  }

  /**
   * Hide all module containers, then show the target one.
   */
  function switchContainer(moduleId) {
    const containers = document.querySelectorAll('.module-view');
    containers.forEach(c => {
      c.classList.remove('active');
      c.classList.add('hidden');
    });

    const target = document.getElementById('module-' + moduleId);
    if (target) {
      target.classList.remove('hidden');
      target.classList.add('active');
    }
  }

  /**
   * Core navigation handler — called on hashchange and programmatic navigate.
   */
  function handleRouteChange() {
    const hash = window.location.hash;
    const parsed = parseRoute(hash);
    const resolved = resolveModule(parsed);
    const { moduleId, subPath } = resolved;

    // If falling back to dashboard and hash doesn't match, fix the URL silently
    if (resolved.moduleId !== parsed.moduleId) {
      // Don't update hash to avoid infinite loop — just render dashboard
    }

    const mod = moduleMap[moduleId];
    if (!mod) return; // no modules registered yet

    // Call leave() on current active module if switching away
    if (activeModuleId && activeModuleId !== moduleId) {
      const prev = moduleMap[activeModuleId];
      if (prev && typeof prev.leave === 'function') {
        try { prev.leave(); } catch (e) { console.warn('[Router] leave() error:', e); }
      }
    }

    // Switch DOM containers
    switchContainer(moduleId);

    // Activate the new module
    if (!initialized.has(moduleId)) {
      // First time — call init()
      const container = document.getElementById('module-' + moduleId);
      if (mod && typeof mod.init === 'function') {
        try {
          mod.init(container, { subPath, platform: window.Platform || null });
        } catch (e) {
          console.error('[Router] init() error for module "' + moduleId + '":', e);
        }
      }
      initialized.add(moduleId);
    } else {
      // Already initialized — call enter()
      if (mod && typeof mod.enter === 'function') {
        try {
          mod.enter(subPath);
        } catch (e) {
          console.error('[Router] enter() error for module "' + moduleId + '":', e);
        }
      }
    }

    activeModuleId = moduleId;
    currentRoute = { moduleId, subPath };

    // Update breadcrumb
    const breadcrumbItems = buildBreadcrumb(moduleId, subPath);
    if (window.Platform && typeof window.Platform.setBreadcrumb === 'function') {
      window.Platform.setBreadcrumb(breadcrumbItems);
    }

    // Update sidebar active state
    const navId = getActiveNavId(moduleId);
    if (window.Platform && typeof window.Platform._highlightNav === 'function') {
      window.Platform._highlightNav(navId);
    }

    // Notify onChange callbacks
    callbacks.forEach(cb => {
      try { cb(currentRoute); } catch (e) { console.warn('[Router] onChange callback error:', e); }
    });
  }

  /**
   * Initialize the router.
   * @param {Object} modules - Map of moduleId → ModuleDefinition (or array)
   */
  function init(modules) {
    // Accept either an object map or an array of module definitions
    if (Array.isArray(modules)) {
      moduleMap = {};
      modules.forEach(m => {
        if (m && m.id) moduleMap[m.id] = m;
      });
    } else {
      moduleMap = modules || {};
    }

    // Bind hashchange listener
    window.addEventListener('hashchange', handleRouteChange);

    // Perform initial route resolution
    handleRouteChange();
  }

  /**
   * Programmatic navigation — update hash to trigger route change.
   * @param {string} path - Path without '#/' prefix, e.g. 'iteration/analysis'
   */
  function navigate(path) {
    const target = '#/' + (path || '').replace(/^\//, '');
    if (window.location.hash === target) {
      // Same hash — manually trigger to handle re-entry
      handleRouteChange();
    } else {
      window.location.hash = target;
      // Also call handleRouteChange directly to ensure immediate update.
      // In browsers, hashchange fires asynchronously; this ensures synchronous navigation
      // for programmatic callers. The hashchange listener is idempotent (same route = no-op).
      handleRouteChange();
    }
  }

  /**
   * Get current route information.
   * @returns {{ moduleId: string, subPath: string }}
   */
  function current() {
    return { ...currentRoute };
  }

  /**
   * Register a callback to be invoked on every route change.
   * @param {Function} callback - Receives { moduleId, subPath }
   */
  function onChange(callback) {
    if (typeof callback === 'function') {
      callbacks.push(callback);
    }
  }

  // Public API
  return {
    init,
    navigate,
    current,
    onChange
  };
})();
