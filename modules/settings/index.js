/* modules/settings/index.js — 系统设置客户端模块
   渲染为仪表盘子页面 (#/dashboard/settings)。
   提供：主题切换、外包人月单价、偏差告警阈值、数据路径显示、清除缓存、版本信息。
*/

// eslint-disable-next-line no-unused-vars
const SettingsModule = (() => {
  'use strict';

  const LS_KEYS = {
    theme: 'platform_theme',
    outsourceRate: 'outsource_rate',
    alertThreshold: 'platform_alert_threshold'
  };

  /* ---------- 渲染 ---------- */

  /**
   * 渲染系统设置页面到指定容器
   * 由 DashboardModule 在子路由 settings 时调用
   */
  function render(container) {
    if (!container) return;

    // 读取当前设置
    const currentTheme = getStoredValue(LS_KEYS.theme, 'light');
    const outsourceRate = getStoredValue(LS_KEYS.outsourceRate, '30000');
    const alertThreshold = getStoredValue(LS_KEYS.alertThreshold, '10');
    const isDark = currentTheme === 'dark';

    container.innerHTML = `
      <div class="settings-page">
        <h2 class="page-title">系统设置</h2>

        <div class="settings-section">
          <div class="form-group">
            <label class="form-label">主题切换</label>
            <div class="form-control">
              <label class="toggle-switch">
                <input type="checkbox" id="settingThemeToggle" ${isDark ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
              <span class="toggle-label" id="themeLabel">${isDark ? '暗色' : '亮色(默认)'}</span>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">外包人月单价 (元)</label>
            <div class="form-control">
              <input type="number" id="settingOutsourceRate" value="${SharedUI.esc(outsourceRate)}" min="0" step="1000" class="settings-input">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">偏差告警阈值 (%)</label>
            <div class="form-control">
              <input type="number" id="settingAlertThreshold" value="${SharedUI.esc(alertThreshold)}" min="1" max="100" step="1" class="settings-input">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">数据存储路径</label>
            <div class="form-control">
              <span class="settings-readonly">data/</span>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">清除本地缓存</label>
            <div class="form-control">
              <button class="btn danger" id="settingClearCache">清除本地缓存</button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">平台版本信息</label>
            <div class="form-control">
              <span class="settings-readonly">v2.0.0</span>
            </div>
          </div>
        </div>
      </div>
    `;

    // 绑定事件
    bindEvents(container);
  }

  /* ---------- 事件绑定 ---------- */

  function bindEvents(container) {
    // 主题切换
    const themeToggle = document.getElementById('settingThemeToggle');
    if (themeToggle) {
      themeToggle.addEventListener('change', function () {
        const isDark = this.checked;
        const theme = isDark ? 'dark' : 'light';
        setStoredValue(LS_KEYS.theme, theme);

        if (isDark) {
          document.body.classList.add('dark-theme');
        } else {
          document.body.classList.remove('dark-theme');
        }

        const label = document.getElementById('themeLabel');
        if (label) label.textContent = isDark ? '暗色' : '亮色(默认)';

        SharedUI.toast('设置已保存', 'success');
      });
    }

    // 外包人月单价
    const rateInput = document.getElementById('settingOutsourceRate');
    if (rateInput) {
      rateInput.addEventListener('change', function () {
        const val = Number(this.value) || 30000;
        setStoredValue(LS_KEYS.outsourceRate, String(val));
        SharedUI.toast('设置已保存', 'success');
      });
    }

    // 偏差告警阈值
    const thresholdInput = document.getElementById('settingAlertThreshold');
    if (thresholdInput) {
      thresholdInput.addEventListener('change', function () {
        const val = Number(this.value) || 10;
        setStoredValue(LS_KEYS.alertThreshold, String(val));
        SharedUI.toast('设置已保存', 'success');
      });
    }

    // 清除缓存
    const clearBtn = document.getElementById('settingClearCache');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        try {
          const platformKeys = Object.values(LS_KEYS);
          // Also clear known platform keys
          const allKeys = [...platformKeys, 'sidebar_collapsed', 'wb_who', 'workbench-user'];
          allKeys.forEach(key => localStorage.removeItem(key));
          SharedUI.toast('本地缓存已清除', 'success');
        } catch (e) {
          SharedUI.toast('清除失败: ' + e.message, 'error');
        }
      });
    }
  }

  /* ---------- 工具函数 ---------- */

  function getStoredValue(key, defaultVal) {
    try {
      const val = localStorage.getItem(key);
      return val !== null ? val : defaultVal;
    } catch (e) {
      return defaultVal;
    }
  }

  function setStoredValue(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) { /* ignore */ }
  }

  /* ---------- 模块接口 ---------- */

  return {
    id: 'settings',
    name: '系统设置',
    icon: '⚙',
    order: 99,
    sidebar: false, // 不在侧边栏主导航显示，作为仪表盘子页面

    render: render,

    init(el) { render(el); },
    enter() {},
    leave() {}
  };
})();
