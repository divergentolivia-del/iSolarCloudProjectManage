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

        <h2 class="page-title" style="margin-top:32px">白名单管理</h2>
        <div class="settings-section" id="whitelistSection">
          <p style="color:#6b7280">加载中...</p>
        </div>

        <h2 class="page-title" style="margin-top:32px">操作记录</h2>
        <div class="settings-section" id="auditSection">
          <p style="color:#6b7280">加载中...</p>
        </div>
      </div>
    `;

    // 绑定事件
    bindEvents(container);

    // 加载白名单配置
    loadWhitelistSection();

    // 加载审计日志
    loadAuditSection();
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

  /* ---------- 白名单管理 ---------- */

  let _platformConfig = null;

  function loadWhitelistSection() {
    fetch('/api/platform/config')
      .then(r => r.json())
      .then(config => {
        _platformConfig = config;
        renderWhitelist(config);
      })
      .catch(() => {
        const el = document.getElementById('whitelistSection');
        if (el) el.innerHTML = '<p style="color:var(--warn)">获取配置失败</p>';
      });
  }

  function renderWhitelist(config) {
    const el = document.getElementById('whitelistSection');
    if (!el) return;

    const isWhitelist = config.editMode === 'whitelist';
    const list = config.whitelist || [];

    el.innerHTML = `
      <div class="form-group">
        <label class="form-label">编辑权限模式</label>
        <div class="form-control">
          <label style="margin-right:16px"><input type="radio" name="editMode" value="open" ${!isWhitelist ? 'checked' : ''}> 开放（所有人可编辑）</label>
          <label><input type="radio" name="editMode" value="whitelist" ${isWhitelist ? 'checked' : ''}> 白名单（仅白名单成员可编辑）</label>
        </div>
      </div>
      <div class="form-group" id="whitelistMembers" style="${isWhitelist ? '' : 'display:none'}">
        <label class="form-label">白名单成员</label>
        <div class="form-control" style="flex-direction:column;align-items:flex-start;gap:8px">
          ${list.length ? list.map((name, i) => `
            <span style="display:inline-flex;align-items:center;gap:6px;background:#f0f0f0;padding:4px 10px;border-radius:4px">
              ${SharedUI.esc(name)}
              <button class="link" data-wl-remove="${i}" style="color:var(--warn);font-size:12px">移除</button>
            </span>
          `).join('') : '<span style="color:#6b7280">暂无成员</span>'}
          <div style="display:flex;gap:8px;margin-top:4px">
            <input type="text" id="whitelistInput" placeholder="输入姓名" style="padding:4px 8px;border:1px solid var(--line);border-radius:4px;font-size:13px">
            <button class="btn" id="whitelistAdd" style="font-size:13px;padding:4px 12px">添加</button>
          </div>
        </div>
      </div>
      <div style="margin-top:12px">
        <button class="btn primary" id="whitelistSave">保存白名单配置</button>
      </div>
    `;

    // Bind events
    el.querySelectorAll('input[name=editMode]').forEach(radio => {
      radio.addEventListener('change', () => {
        const members = document.getElementById('whitelistMembers');
        if (members) members.style.display = radio.value === 'whitelist' ? '' : 'none';
      });
    });

    el.querySelectorAll('[data-wl-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.wlRemove);
        _platformConfig.whitelist.splice(idx, 1);
        renderWhitelist(_platformConfig);
      });
    });

    const addBtn = document.getElementById('whitelistAdd');
    const addInput = document.getElementById('whitelistInput');
    if (addBtn && addInput) {
      addBtn.addEventListener('click', () => {
        const name = addInput.value.trim();
        if (!name) return;
        if (!_platformConfig.whitelist) _platformConfig.whitelist = [];
        if (!_platformConfig.whitelist.includes(name)) {
          _platformConfig.whitelist.push(name);
        }
        renderWhitelist(_platformConfig);
      });
    }

    const saveBtn = document.getElementById('whitelistSave');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const mode = el.querySelector('input[name=editMode]:checked');
        _platformConfig.editMode = mode ? mode.value : 'open';
        _platformConfig._updatedBy = Platform.whoami();
        fetch('/api/platform/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(_platformConfig)
        }).then(r => r.json()).then(res => {
          if (res.ok) SharedUI.toast('白名单配置已保存', 'success');
          else SharedUI.toast('保存失败', 'error');
        }).catch(() => SharedUI.toast('保存失败', 'error'));
      });
    }
  }

  /* ---------- 审计日志 ---------- */

  function loadAuditSection() {
    fetch('/api/platform/audit')
      .then(r => r.json())
      .then(logs => {
        renderAuditLog(logs);
      })
      .catch(() => {
        const el = document.getElementById('auditSection');
        if (el) el.innerHTML = '<p style="color:var(--warn)">获取日志失败</p>';
      });
  }

  function renderAuditLog(logs) {
    const el = document.getElementById('auditSection');
    if (!el) return;

    if (!logs || logs.length === 0) {
      el.innerHTML = '<p style="color:#6b7280">暂无操作记录</p>';
      return;
    }

    const rows = logs.map(log => `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid var(--line);font-size:13px">${SharedUI.esc(log.timestamp || '')}</td>
        <td style="padding:6px 12px;border-bottom:1px solid var(--line);font-size:13px">${SharedUI.esc(log.user || '')}</td>
        <td style="padding:6px 12px;border-bottom:1px solid var(--line);font-size:13px">${SharedUI.esc(log.module || '')}</td>
        <td style="padding:6px 12px;border-bottom:1px solid var(--line);font-size:13px">${SharedUI.esc(log.action || '')}${log.details ? ' (' + SharedUI.esc(log.details) + ')' : ''}</td>
      </tr>
    `).join('');

    el.innerHTML = `
      <div style="max-height:400px;overflow:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--bg)">
              <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)">时间</th>
              <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)">操作人</th>
              <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)">模块</th>
              <th style="padding:8px 12px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)">操作</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
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
