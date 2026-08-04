/* ============================================================
   shared-ui.js — Shared UI component helpers
   Provides reusable rendering functions and formatters for the
   multi-module platform.
   ============================================================ */

// eslint-disable-next-line no-unused-vars
const SharedUI = (() => {
  'use strict';

  /**
   * HTML escape helper — prevents XSS in dynamic content
   * @param {string} text - Raw text to escape
   * @returns {string} HTML-safe string
   */
  function esc(text) {
    if (text == null) return '';
    const str = String(text);
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return str.replace(/[&<>"']/g, ch => map[ch]);
  }

  /**
   * Format a decimal value as a percentage with sign (±X.X%)
   * @param {number} value - Decimal value (e.g. 0.052 → +5.2%)
   * @returns {string} Formatted percentage string
   */
  function formatPct(value) {
    if (value == null || isNaN(value)) return '—';
    const pct = (value * 100).toFixed(1);
    const sign = value > 0 ? '+' : '';
    return sign + pct + '%';
  }

  /**
   * Format a number as currency (¥X.X)
   * @param {number} value - Monetary value in yuan
   * @returns {string} Formatted currency string
   */
  function formatCurrency(value) {
    if (value == null || isNaN(value)) return '¥0';
    if (value >= 10000) {
      return '¥' + (value / 10000).toFixed(1) + '万';
    }
    return '¥' + Number(value).toFixed(1);
  }

  /**
   * Format a number with comma separators
   * @param {number} value - Number to format
   * @returns {string} Formatted number string (e.g. 1,250,000)
   */
  function formatNumber(value) {
    if (value == null || isNaN(value)) return '0';
    return Number(value).toLocaleString('zh-CN');
  }

  /**
   * Render a metric card HTML string
   * @param {string} icon - Emoji or icon character
   * @param {string} label - Card label text
   * @param {string} value - Display value (pre-formatted)
   * @param {string} status - Status type: 'ok' | 'warn' | 'hold' | 'normal'
   * @param {string} [statusText] - Optional status description text
   * @returns {string} HTML string for the metric card
   */
  function renderMetricCard(icon, label, value, status, statusText) {
    const statusClass = status || 'normal';
    const statusLabel = statusText || (status === 'ok' ? '✓ 正常' : status === 'warn' ? '⚠ 异常' : status === 'hold' ? '⚠ 注意' : '✓ 正常');
    return `<div class="metric-card">
      <div class="metric-card-header">
        <span class="metric-card-icon">${esc(icon)}</span>
        <span class="metric-card-label">${esc(label)}</span>
      </div>
      <div class="metric-card-value">${esc(value)}</div>
      <span class="metric-card-status ${esc(statusClass)}">${esc(statusLabel)}</span>
    </div>`;
  }

  /**
   * Render breadcrumb navigation HTML
   * @param {Array<{label: string, href?: string}>} items - Breadcrumb items, last is current page
   * @returns {string} HTML string for the breadcrumb
   */
  function renderBreadcrumb(items) {
    if (!items || items.length === 0) return '';
    return items.map((item, i) => {
      const isLast = i === items.length - 1;
      const sep = i > 0 ? '<span class="breadcrumb-separator">/</span>' : '';
      if (isLast) {
        return `${sep}<span class="breadcrumb-item current">${esc(item.label)}</span>`;
      }
      const href = item.href || '#/dashboard';
      return `${sep}<a class="breadcrumb-item" href="${esc(href)}">${esc(item.label)}</a>`;
    }).join('');
  }

  /**
   * Render a module entry card HTML string
   * @param {string} title - Card title
   * @param {string} description - Card description text
   * @param {string} icon - Emoji or icon character
   * @param {string} hash - Navigation hash (e.g. '#/dashboard/budget')
   * @returns {string} HTML string for the entry card
   */
  function renderModuleEntryCard(title, description, icon, hash) {
    return `<a class="entry-card" href="${esc(hash)}">
      <div class="entry-card-header">
        <span class="entry-card-icon">${esc(icon)}</span>
        <span class="entry-card-title">${esc(title)}</span>
      </div>
      <div class="entry-card-desc">${esc(description)}</div>
      <span class="entry-card-action">进入 →</span>
    </a>`;
  }

  /**
   * Show a transient toast notification
   * @param {string} message - Notification message
   * @param {string} [type='info'] - Type: 'info' | 'success' | 'error' | 'warning'
   * @param {number} [duration=3000] - Duration in ms before auto-hide
   */
  function toast(message, type, duration) {
    type = type || 'info';
    duration = duration || 3000;

    const el = document.getElementById('toast');
    if (!el) return;

    // Clear any pending hide timeout
    if (el._toastTimer) {
      clearTimeout(el._toastTimer);
    }

    // Remove old type classes
    el.className = 'toast';
    if (type !== 'info') {
      el.classList.add(type);
    }

    el.textContent = message;
    el.classList.remove('hidden');

    el._toastTimer = setTimeout(() => {
      el.classList.add('hidden');
      el._toastTimer = null;
    }, duration);
  }

  /**
   * Show a modal confirmation dialog
   * @param {string} title - Dialog title
   * @param {string} bodyHtml - Dialog body (HTML content)
   * @param {Function} onConfirm - Callback when user confirms
   * @param {object} [options] - Optional settings
   * @param {string} [options.confirmText='确认'] - Confirm button text
   * @param {string} [options.cancelText='取消'] - Cancel button text
   * @param {string} [options.confirmClass='primary'] - Confirm button class
   */
  function confirm(title, bodyHtml, onConfirm, options) {
    options = options || {};
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    const footerEl = document.getElementById('modalFooter');
    const closeBtn = document.getElementById('modalClose');

    if (!overlay || !titleEl || !bodyEl || !footerEl) return;

    titleEl.textContent = title;
    bodyEl.innerHTML = bodyHtml;

    const confirmText = options.confirmText || '确认';
    const cancelText = options.cancelText || '取消';
    const confirmClass = options.confirmClass || 'primary';

    footerEl.innerHTML = `
      <button class="btn" id="modalCancelBtn">${esc(cancelText)}</button>
      <button class="btn ${esc(confirmClass)}" id="modalConfirmBtn">${esc(confirmText)}</button>
    `;

    overlay.classList.remove('hidden');

    function close() {
      overlay.classList.add('hidden');
      // Cleanup listeners
      document.getElementById('modalCancelBtn')?.removeEventListener('click', close);
      document.getElementById('modalConfirmBtn')?.removeEventListener('click', handleConfirm);
      closeBtn?.removeEventListener('click', close);
    }

    function handleConfirm() {
      close();
      if (typeof onConfirm === 'function') {
        onConfirm();
      }
    }

    document.getElementById('modalCancelBtn')?.addEventListener('click', close);
    document.getElementById('modalConfirmBtn')?.addEventListener('click', handleConfirm);
    closeBtn?.addEventListener('click', close);

    // Close on backdrop click
    overlay.addEventListener('click', function backdropClick(e) {
      if (e.target === overlay) {
        close();
        overlay.removeEventListener('click', backdropClick);
      }
    });
  }

  // Public API
  return {
    esc,
    formatPct,
    formatCurrency,
    formatNumber,
    renderMetricCard,
    renderBreadcrumb,
    renderModuleEntryCard,
    toast,
    confirm
  };
})();
