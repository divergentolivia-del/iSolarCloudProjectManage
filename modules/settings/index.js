/* modules/settings/index.js — 系统设置客户端模块
   渲染为仪表盘子页面 (#/dashboard/settings)。
   提供：主题切换、数据路径显示、清除缓存、版本信息。
*/

// eslint-disable-next-line no-unused-vars
const SettingsModule = (() => {
  'use strict';

  /* 2026-10-10 去掉「外包人月单价」「偏差告警阈值」两项。
     原因：两个输入框都只写 localStorage，没有任何地方读：
       - outsource_rate      → 预算模块实际读的是 state.costConfig.outsourceRate
                               （modules/budget/index.js:77，默认 30000）
       - platform_alert_threshold → 偏差判定用的是写死的 DEVIATION_TOLERANCE
                               （config.js:60 = 0.10），从不读这个键
     留着能改但不生效，比没有更糟，故整项移除（含保存逻辑）。
     要改单价/阈值：找平台管理员改数据文件或 config.js。 */
  const LS_KEYS = {
    theme: 'platform_theme'
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
    const isDark = currentTheme === 'dark';
    /* 用户管理只对管理员渲染。判断放在这里而不是用 CSS 藏 ——
       非管理员连这段 HTML 都不该拿到，免得界面上一堆「点了必然 403」的按钮。
       Platform 没有 isAdmin，只能看 role。 */
    const _me = (typeof Platform !== 'undefined' && Platform.currentUser) ? Platform.currentUser() : null;
    const isAdmin = !!(_me && _me.role === 'admin');

    container.innerHTML = `
      <div class="settings-page">
        <h2 class="page-title">系统设置</h2>

        <div class="settings-section">
          <!-- 账号：密码改这里、退出登录也在这里。
               2026-09-22 之前全平台没有任何改密码界面，而顶部提示条的
               「去修改密码」正是指向本页 —— 点了没反应，于是所有人都停在
               批量建号的初始密码上（同批次规则相同，可被同事猜中）。 -->
          <div class="form-group">
            <label class="form-label">当前账号</label>
            <div class="form-control">
              <span class="settings-readonly" id="acctWho">—</span>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">密码</label>
            <div class="form-control">
              <button class="btn" id="acctChangePwd">修改密码</button>
              <button class="btn danger" id="acctLogout">退出登录</button>
            </div>
          </div>
        </div>

        <!-- 改密码表单：默认收起，点「修改密码」才展开 -->
        <div class="settings-section" id="acctPwdForm" style="display:none">
          <div class="form-group">
            <label class="form-label">原密码</label>
            <div class="form-control">
              <input type="password" id="acctOldPwd" class="settings-input" autocomplete="current-password" style="text-align:left">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">新密码</label>
            <div class="form-control">
              <input type="password" id="acctNewPwd" class="settings-input" autocomplete="new-password" style="text-align:left">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">再输一次</label>
            <div class="form-control">
              <input type="password" id="acctNewPwd2" class="settings-input" autocomplete="new-password" style="text-align:left">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label"></label>
            <div class="form-control">
              <span id="acctPwdMsg" style="font-size:13px"></span>
              <button class="btn primary" id="acctPwdSubmit">确认修改</button>
            </div>
          </div>
        </div>

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

        ${isAdmin ? `
        <h2 class="page-title" style="margin-top:32px">用户管理</h2>
        <div class="settings-section">
          <!-- 团队下拉的数据源是 teams.json（19 个团队分类），不是 users.department
               （那是钉钉叶子部门名，68 个值，两个维度别混）。
               搜索与筛选都走服务端，前端不自己过滤 —— 分页/权限口径只有一处。 -->
          <div class="form-group">
            <label class="form-label">团队</label>
            <div class="form-control">
              <select id="umDept" class="settings-input" style="text-align:left"><option value="">全部团队</option></select>
              <input type="text" id="umQuery" class="settings-input" placeholder="搜姓名或工号" style="text-align:left;margin-left:8px">
              <button class="btn" id="umRefresh" style="margin-left:8px">刷新</button>
            </div>
          </div>
          <div id="umStat" style="font-size:13px;color:#6b7280;margin:4px 0 8px"></div>
          <div id="umTable" style="max-height:520px;overflow:auto">
            <p style="color:#6b7280">加载中...</p>
          </div>
        </div>

        <!-- 新建用户：默认收起，点标题展开。接口本来就存在
             （POST /api/auth/users），373 个号当初是批量导入建的，
             一直没有界面 —— 于是「外包同事（无工号）怎么建号」没地方落。
             密码由服务端按 data/auth-config.json 的规则算出来，只回显这一次。 -->
        <h2 class="page-title" style="margin-top:32px">新建用户</h2>
        <div class="settings-section">
          <div class="form-group">
            <label class="form-label">类型</label>
            <div class="form-control">
              <label style="margin-right:16px;font-weight:400">
                <input type="radio" name="nuKind" value="internal" checked> 内部同事
              </label>
              <label style="font-weight:400">
                <input type="radio" name="nuKind" value="outsourced"> 外包同事
              </label>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">账号</label>
            <div class="form-control">
              <input type="text" id="nuId" class="settings-input" placeholder="内部填工号，外包填姓名拼音" style="text-align:left">
              <span id="nuIdHint" style="font-size:12px;color:#6b7280;margin-left:8px"></span>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">姓名</label>
            <div class="form-control">
              <input type="text" id="nuName" class="settings-input" placeholder="真实姓名" style="text-align:left">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">姓名缩写</label>
            <div class="form-control">
              <input type="text" id="nuPrefix" class="settings-input" placeholder="如 陈丹萍 填 cdp" style="text-align:left;max-width:160px">
              <span style="font-size:12px;color:#6b7280;margin-left:8px">
                密码的第一段。程序不做拼音转换，这一格必须手填。
              </span>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">角色</label>
            <div class="form-control">
              <select id="nuRole" class="settings-input" style="text-align:left"></select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label"></label>
            <div class="form-control">
              <button class="btn primary" id="nuSubmit">建号</button>
              <span style="font-size:12px;color:#6b7280;margin-left:10px">
                外包同事可用姓名拼音做账号
              </span>
            </div>
          </div>
          <div id="nuResult" style="font-size:13px"></div>
        </div>

        <!-- 权限矩阵：只管「可读写」这一档。
             「仅可读」固定全模块只读、不可配 —— 少一半勾选框，
             也不会出现「把只读角色的读权限收没了、某人连首页都打不开」这种误配。
             真正的门禁在 server.js 的 gate()，早就按 模块:read / 模块:write 判了，
             这里只是把那个矩阵接到界面上。 -->
        <h2 class="page-title" style="margin-top:32px">权限矩阵</h2>
        <div class="settings-section">
          <p style="color:#6b7280;font-size:13px;margin-top:0">
            「可读写」角色在各模块上的权限。改动即时生效。
          </p>
          <div id="pmMatrix"><p style="color:#6b7280">加载中...</p></div>
        </div>

        <h2 class="page-title" style="margin-top:32px">白名单管理</h2>
        <div class="settings-section" id="whitelistSection">
          <p style="color:#6b7280">加载中...</p>
        </div>

        <h2 class="page-title" style="margin-top:32px">操作记录</h2>
        <div class="settings-section" id="auditSection">
          <p style="color:#6b7280">加载中...</p>
        </div>
        ` : ''}
      </div>
    `;

    // 绑定事件
    bindEvents(container);

    // 加载账号区（当前账号名）—— 改密码/退出登录对所有人开放，
    // 顶部提示条的「去修改密码」就指向这里，页面不能锁死
    loadAccountSection();

    /* 以下全部仅管理员有 DOM。非管理员的 HTML 里根本没有这些区块，
       所以「加载中...」不会永远挂着 —— 那正是预期的：压根不请求。 */
    if (isAdmin) {
      loadUserSection();        // 用户列表 + 新建用户
      loadPermissionMatrix();   // 权限矩阵
      loadWhitelistSection();   // 白名单
      loadAuditSection();       // 操作记录
    }
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

    // 清除缓存
    const clearBtn = document.getElementById('settingClearCache');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        try {
          const platformKeys = Object.values(LS_KEYS);
          // Also clear known platform keys
          const allKeys = [...platformKeys, 'sidebar_collapsed', 'wb_who', 'workbench-user',
            // 已废弃的两个设置项对应的键，顺手清掉老用户 localStorage 里的残留
            'outsource_rate', 'platform_alert_threshold'];
          allKeys.forEach(key => localStorage.removeItem(key));
          SharedUI.toast('本地缓存已清除', 'success');
        } catch (e) {
          SharedUI.toast('清除失败: ' + e.message, 'error');
        }
      });
    }
  }

  /* ---------- 账号：改密码 / 退出登录 ---------- */

  /** 账号区：填当前账号名、绑「修改密码」「退出登录」 */
  function loadAccountSection() {
    const who = document.getElementById('acctWho');
    const u = (typeof Platform !== 'undefined' && Platform.currentUser) ? Platform.currentUser() : null;
    if (who) who.textContent = u ? (u.name + '（' + u.id + ' · ' + u.role + '）') : '未启用登录';

    const openBtn = document.getElementById('acctChangePwd');
    const form = document.getElementById('acctPwdForm');
    if (openBtn && form) {
      openBtn.addEventListener('click', function () {
        form.style.display = form.style.display === 'none' ? '' : 'none';
        const first = document.getElementById('acctOldPwd');
        if (form.style.display !== 'none' && first) first.focus();
      });
    }

    const submit = document.getElementById('acctPwdSubmit');
    if (submit) submit.addEventListener('click', submitPasswordChange);

    const logout = document.getElementById('acctLogout');
    if (logout) logout.addEventListener('click', doLogout);
  }

  function pwdMsg(text, kind) {
    const el = document.getElementById('acctPwdMsg');
    if (!el) return;
    el.textContent = text || '';
    /* 主题里根本没有 --danger 这个变量（只有 --warn），写成 --danger 是静默失效：
       style.color 拿到空值，文字保持原色，报错看起来像成功了。 */
    el.style.color = kind === 'ok' ? 'var(--ok)' : 'var(--warn)';
  }

  /**
   * 提交改密码。
   * 前端只做「两次输入是否一致」这类能立刻判断的校验；
   * 原密码对不对、新密码够不够长，一律以服务端返回为准 —— 规则只有一处，不在这边复刻。
   */
  function submitPasswordChange() {
    const oldPwd = (document.getElementById('acctOldPwd') || {}).value || '';
    const np = (document.getElementById('acctNewPwd') || {}).value || '';
    const np2 = (document.getElementById('acctNewPwd2') || {}).value || '';

    if (!oldPwd) return pwdMsg('请填写原密码');
    if (!np) return pwdMsg('请填写新密码');
    if (np !== np2) return pwdMsg('两次输入的新密码不一致');

    pwdMsg('提交中…', 'ok');
    fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ oldPassword: oldPwd, newPassword: np })
    })
      .then(r => r.json().then(d => ({ ok: r.ok, d: d })))
      .then(r => {
        if (!r.ok) { pwdMsg((r.d && r.d.error) || '修改失败'); return; }
        ['acctOldPwd', 'acctNewPwd', 'acctNewPwd2'].forEach(function (id) {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        const form = document.getElementById('acctPwdForm');
        if (form) form.style.display = 'none';
        /* 改完立刻刷新身份：服务端已经把「初始密码」标记清掉了，
           顶部那条提示条应该当场消失，而不是等下次刷新。 */
        if (typeof Platform !== 'undefined' && Platform.refreshIdentity) {
          Platform.refreshIdentity().then(function () {
            SharedUI.toast('密码已修改', 'success');
          });
        } else {
          SharedUI.toast('密码已修改', 'success');
        }
      })
      .catch(function () { pwdMsg('网络异常，密码未修改'); });
  }

  /** 退出登录：服务端销毁会话并清 Cookie，然后回登录页 */
  function doLogout() {
    if (!window.confirm('确定退出登录？')) return;
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
      .catch(function () { /* 就算请求失败也照常回登录页，本地没有可清的东西（Cookie 是 HttpOnly） */ })
      .then(function () { window.location.href = '/login.html'; });
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

  /* ---------- 用户管理（仅 admin 渲染） ----------

     为什么加在这：373 个号批量建出来之后，平台没有任何地方能看这张表。
     改角色 / 停用 / 重置密码的接口早就有了（auth/routes.js），缺的是界面。
     团队一列来自 teams.json 的姓名反查，接口返回时已经附好，前端不自己算。 */

  let _umTeams = null;   // 团队清单缓存，加载过一次就不再请求
  let _umTimer = null;   // 搜索防抖

  function loadUserSection() {
    const sel = document.getElementById('umDept');
    if (!sel) return;

    bindUserEvents();
    bindNewUserForm();

    fetch('/api/auth/teams', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => {
        _umTeams = d.teams || [];
        /* 名单文件缺失/损坏时接口回 ready:false —— 下拉只留「全部团队」并说明原因，
           列表照常加载，不因为筛选项缺了就整块白屏。 */
        const opts = ['<option value="">全部团队</option>'];
        if (!d.ready) {
          opts.push('<option value="" disabled>团队名单未就绪</option>');
        } else {
          _umTeams.forEach(t => {
            opts.push('<option value="' + SharedUI.esc(t.team) + '">' +
              SharedUI.esc(t.team) + '（' + t.count + '）</option>');
          });
        }
        sel.innerHTML = opts.join('');
      })
      .catch(function () { /* 下拉拉不到不影响下面的列表 */ });

    loadUserList();
  }

  function bindUserEvents() {
    const sel = document.getElementById('umDept');
    if (sel) sel.addEventListener('change', loadUserList);

    const q = document.getElementById('umQuery');
    if (q) {
      /* 防抖 250ms：372 个人名，每敲一个字母打一次接口没必要，但也不等回车 ——
         输入即筛的手感更接近本地过滤。筛选本身仍在服务端做，口径只有一处。 */
      q.addEventListener('input', function () {
        if (_umTimer) clearTimeout(_umTimer);
        _umTimer = setTimeout(loadUserList, 250);
      });
    }

    const refresh = document.getElementById('umRefresh');
    if (refresh) refresh.addEventListener('click', loadUserList);

    const table = document.getElementById('umTable');
    if (table) {
      /* 事件委托：372 行 × 2 个按钮，逐行绑会挂 700+ 个监听器 */
      table.addEventListener('click', onUserTableClick);
      table.addEventListener('change', onUserTableChange);
    }
  }

  function loadUserList() {
    const box = document.getElementById('umTable');
    if (!box) return;

    const dept = (document.getElementById('umDept') || {}).value || '';
    const q = (document.getElementById('umQuery') || {}).value || '';
    const qs = [];
    if (dept) qs.push('dept=' + encodeURIComponent(dept));
    if (q.trim()) qs.push('q=' + encodeURIComponent(q.trim()));

    fetch('/api/auth/users' + (qs.length ? '?' + qs.join('&') : ''), { credentials: 'same-origin' })
      .then(r => r.json().then(d => ({ ok: r.ok, d: d })))
      .then(function (r) {
        if (!r.ok) {
          box.innerHTML = '<p style="color:var(--warn)">' + SharedUI.esc((r.d && r.d.error) || '获取用户列表失败') + '</p>';
          return;
        }
        renderUserList(r.d);
      })
      .catch(function () {
        box.innerHTML = '<p style="color:var(--warn)">获取用户列表失败</p>';
      });
  }

  /* 角色三档。2026-10-14 由 admin/pm/dev/viewer 收敛而来 ——
     旧的 pm/dev 是【职能】、viewer 是【访问级别】，两个维度揉在一列里，
     界面上根本看不出「开发」和「只读」谁大谁小（而且旧矩阵里 dev 是零写权限、
     viewer 反而多一个 budget:read，等于「开发」比「只读」看得还少）。
     现在 role 只表达访问级别，职能信息归 department。 */
  const ROLE_OPTIONS = [
    { v: 'reader', t: '仅可读' },
    { v: 'editor', t: '可读写' },
    { v: 'admin', t: '管理员' }
  ];

  function renderUserList(d) {
    const box = document.getElementById('umTable');
    if (!box) return;

    const users = (d && d.users) || [];
    const me = (typeof Platform !== 'undefined' && Platform.currentUser) ? Platform.currentUser() : null;

    const stat = document.getElementById('umStat');
    if (stat) {
      stat.textContent = '共 ' + users.length + ' 人' +
        (d && typeof d.unassigned === 'number' ? '，未归类 ' + d.unassigned + ' 人' : '') +
        (d && d.teamsReady === false ? '（团队名单未就绪，团队一列不可用）' : '');
    }

    if (!users.length) {
      box.innerHTML = '<p style="color:#6b7280">没有匹配的用户</p>';
      return;
    }

    /* 列表不做分页：372 行纯文本对浏览器不算什么，分页反而多一层状态要维护。
       真到卡的程度再加。 */
    const rows = users.map(function (u) {
      const self = !!(me && me.id === u.id);       // 自己那行：角色和启停都锁死（服务端也拒）
      const roleSel = '<select class="settings-input" data-um-role="' + SharedUI.esc(u.id) + '"' +
        (self ? ' disabled title="不能改自己的角色"' : '') + ' style="font-size:13px;padding:2px 6px">' +
        ROLE_OPTIONS.map(o => '<option value="' + o.v + '"' + (o.v === u.role ? ' selected' : '') + '>' + o.t + '</option>').join('') +
        '</select>';
      const on = Number(u.enabled) === 1;
      const toggleBtn = '<button class="link" data-um-toggle="' + SharedUI.esc(u.id) + '" data-on="' + (on ? '1' : '0') + '"' +
        (self ? ' disabled title="不能停用自己"' : '') + ' style="color:' + (on ? 'var(--warn)' : 'var(--ok)') + '">' +
        (on ? '停用' : '启用') + '</button>';
      return '<tr>' +
        '<td style="padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px">' + SharedUI.esc(u.name || '') + '</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px">' + SharedUI.esc(u.id || '') + '</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px">' +
          (u.team ? SharedUI.esc(u.team) : '<span style="color:#6b7280">未归类</span>') + '</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid var(--line)">' + roleSel + '</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px">' +
          (on ? '<span style="color:var(--ok)">正常</span>' : '<span style="color:var(--warn)">已停用</span>') + '</td>' +
        /* 初始密码标记：372/373 都还挂着，这是「谁还没改密码」的唯一可视入口 */
        '<td style="padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px">' +
          (Number(u.pwd_is_initial) === 1
            ? '<span class="badge">初始密码</span> ' +
              '<button class="link" data-um-reset="' + SharedUI.esc(u.id) + '">重置</button>'
            : '') + '</td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px">' + toggleBtn + '</td>' +
      '</tr>';
    }).join('');

    box.innerHTML =
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="background:var(--bg);position:sticky;top:0">' +
          '<th style="padding:8px 10px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)">姓名</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)">工号</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)">团队</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)">角色</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)">状态</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)">密码</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)">操作</th>' +
        '</tr></thead><tbody>' + rows + '</tbody>' +
      '</table>';
  }

  /* ---------- 新建用户 ----------

     373 个号当初是 CSV 批量导入建的，`POST /api/auth/users` 早就存在却从没被前端调过，
     于是「外包同事没有工号、SSO 也进不去，怎么开号」这件事一直没有落点。

     密码不由前端拼：服务端按 data/auth-config.json 的规则算，一次性回显。
     前端算的话规则就散到了浏览器里，改一次要动两处 —— 而两处一旦不一致，
     建出来的号密码格式不同，且两边都不会报错。 */

  function bindNewUserForm() {
    const btn = document.getElementById('nuSubmit');
    if (!btn || btn.dataset.nuBound === '1') return;
    btn.dataset.nuBound = '1';

    const roleSel = document.getElementById('nuRole');
    if (roleSel) {
      /* 默认「仅可读」：给权限时从最小开始，要写权限得有人主动去选。
         反过来（默认可读写）意味着每次建号都在无声地放宽权限。 */
      roleSel.innerHTML = ROLE_OPTIONS.slice().reverse()
        .map(o => '<option value="' + o.v + '"' + (o.v === 'reader' ? ' selected' : '') + '>' + o.t + '</option>')
        .join('');
    }

    /* 类型切换时改账号格的提示语。内部是工号（密码要用后 4 位），
       外包是姓名拼音 —— 两者混填会让密码公式拼出个位数不对的密码。 */
    const kindInputs = document.querySelectorAll('input[name="nuKind"]');
    Array.prototype.forEach.call(kindInputs, function (r) {
      r.addEventListener('change', syncNewUserKind);
    });
    syncNewUserKind();

    btn.addEventListener('click', submitNewUser);
  }

  function syncNewUserKind() {
    const kind = (document.querySelector('input[name="nuKind"]:checked') || {}).value || 'internal';
    const idBox = document.getElementById('nuId');
    if (!idBox) return;
    idBox.placeholder = kind === 'outsourced' ? '姓名全拼，如 zhangsan' : '工号，如 10017968';
    const tag = document.getElementById('nuIdHint');
    if (tag) {
      tag.textContent = kind === 'outsourced'
        ? '外包没有工号，密码用固定后缀，账号请填姓名全拼（不要用缩写，缩写会撞）'
        : '密码 = 姓名缩写首字母大写 + 年份 + 工号后 4 位';
    }
  }

  function submitNewUser() {
    const kind = (document.querySelector('input[name="nuKind"]:checked') || {}).value || 'internal';
    const id = ((document.getElementById('nuId') || {}).value || '').trim();
    const name = ((document.getElementById('nuName') || {}).value || '').trim();
    const prefix = ((document.getElementById('nuPrefix') || {}).value || '').trim();
    const role = ((document.getElementById('nuRole') || {}).value || 'reader');
    const box = document.getElementById('nuResult');

    function show(msg, color) {
      if (box) box.innerHTML = '<p style="color:' + (color || 'var(--warn)') + ';margin:8px 0 0">' +
        SharedUI.esc(msg) + '</p>';
    }

    /* 前端这几条只防手滑（少填一格就点建号），真正的校验在服务端 ——
       表单是浏览器里的东西，绕过它直接 POST 一样能建号。 */
    if (!id) return show('账号不能为空');
    if (!name) return show('姓名不能为空');
    if (!prefix) return show('姓名缩写不能为空 —— 它是密码的第一段，程序不做拼音转换');

    const btn = document.getElementById('nuSubmit');
    if (btn) btn.disabled = true;

    fetch('/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id: id, name: name, prefix: prefix, role: role, kind: kind })
    })
      .then(r => r.json().then(d => ({ ok: r.ok, d: d })))
      .then(function (r) {
        if (!r.ok) return show((r.d && r.d.error) || '建号失败');
        /* ★ 明文密码只此一次：服务端不落库、不再回显。
           所以这里不做 toast（几秒就没），而是留在页面上等管理员抄走。 */
        if (box) {
          box.innerHTML =
            '<div style="margin-top:10px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--bg)">' +
              '<div style="font-size:13px;color:var(--ok);margin-bottom:6px">已建号：' +
                SharedUI.esc(r.d.user.name) + '（' + SharedUI.esc(r.d.user.id) + '，' + SharedUI.esc(role) + '）</div>' +
              '<div style="font-size:13px">初始密码：<b id="nuPwd">' + SharedUI.esc(r.d.password) + '</b>' +
                ' <button class="link" id="nuCopy" style="margin-left:8px">复制</button></div>' +
              '<div style="font-size:12px;color:#6b7280;margin-top:6px">' +
                '这个密码只显示这一次，请现在抄给本人。刷新后不再可见，只能重置。</div>' +
            '</div>';
          const copy = document.getElementById('nuCopy');
          if (copy) {
            copy.addEventListener('click', function () {
              const t = (document.getElementById('nuPwd') || {}).textContent || '';
              /* 内网 http 下 navigator.clipboard 通常不可用（非安全上下文），
                 所以退化到临时 textarea + execCommand，别让「复制」点了没反应。 */
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(t).then(
                  function () { SharedUI.toast('密码已复制', 'success'); },
                  function () { SharedUI.toast('复制失败，请手动选中', 'error'); });
              } else {
                const ta = document.createElement('textarea');
                ta.value = t; document.body.appendChild(ta); ta.select();
                try { document.execCommand('copy'); SharedUI.toast('密码已复制', 'success'); }
                catch (e) { SharedUI.toast('复制失败，请手动选中', 'error'); }
                document.body.removeChild(ta);
              }
            });
          }
        }
        /* 清掉输入，避免手快连点两次建出两个号（第二次会因账号已存在而失败） */
        ['nuId', 'nuName', 'nuPrefix'].forEach(function (k) {
          const el = document.getElementById(k);
          if (el) el.value = '';
        });
        loadUserList();
      })
      .catch(function () { show('网络异常，未建号'); })
      .then(function () { if (btn) btn.disabled = false; });
  }

  /* ---------- 权限矩阵（仅 admin 渲染） ----------

     ⚠ 门禁本身【不需要改】：server.js 的 gate() 早就是
       `need = isRead(req) ? 模块:read : 模块:write`，模块级授权在鉴权层一直有效，
       缺的只是写 permissions 表的界面（db.setPermission 实现且导出，全仓库零调用）。

     只配「可读写」这一档：「仅可读」是全平台只读的基线，允许在界面上改它，
     就会出现「把某人所在档的读权限收没了、登录后首页都打不开」这种自伤配置。
     服务端也拦了（POST /api/auth/permissions 只收 editor），不只是这里不给点。 */

  let _pmData = null;

  function loadPermissionMatrix() {
    const box = document.getElementById('pmMatrix');
    if (!box) return;

    fetch('/api/auth/permissions/matrix', { credentials: 'same-origin' })
      .then(r => r.json().then(d => ({ ok: r.ok, d: d })))
      .then(function (r) {
        if (!r.ok) {
          box.innerHTML = '<p style="color:var(--warn)">' +
            SharedUI.esc((r.d && r.d.error) || '获取权限矩阵失败') + '</p>';
          return;
        }
        _pmData = r.d;
        renderPermissionMatrix();
      })
      .catch(function () {
        box.innerHTML = '<p style="color:var(--warn)">获取权限矩阵失败</p>';
      });
  }

  /** 三态取值：'rw' 读写 / 'read' 只读 / 'none' 无 */
  function triState(resource) {
    const ed = (_pmData && _pmData.allowed && _pmData.allowed.editor) || {};
    const rd = ed[resource + ':read'] ? 1 : 0;
    const wr = ed[resource + ':write'] ? 1 : 0;
    return wr ? 'rw' : (rd ? 'read' : 'none');
  }

  function renderPermissionMatrix() {
    const box = document.getElementById('pmMatrix');
    if (!box || !_pmData) return;

    const rows = _pmData.resources || [];
    const reader = (_pmData.allowed && _pmData.allowed.reader) || {};
    const editable = _pmData.editableRole;

    /* 按分组切段。分组顺序由服务端排好（业务模块 / 平台管理 / AI 能力 / 其它），
       前端只按相邻聚合，不再排一次 —— 两处都排就会出现顺序不一致的诡异情况。 */
    const groups = [];
    rows.forEach(function (r) {
      const g = groups[groups.length - 1];
      if (g && g.name === r.group) g.items.push(r);
      else groups.push({ name: r.group, items: [r] });
    });

    const head =
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="background:var(--bg)">' +
          '<th style="padding:8px 10px;text-align:left;font-size:13px">模块</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:13px;width:180px">仅可读（固定）</th>' +
          '<th style="padding:8px 10px;text-align:left;font-size:13px;width:180px">可读写</th>' +
        '</tr></thead><tbody>';

    const body = groups.map(function (g) {
      const title =
        '<tr><td colspan="3" style="padding:10px 10px 4px;font-size:12px;color:#6b7280;' +
          'border-bottom:1px solid var(--line)">' + SharedUI.esc(g.name) + '</td></tr>';
      const lines = g.items.map(function (r) {
        /* 仅可读那一列只作展示。rw 行显示「读 ✔ / 写 ✘」两个事实，
           让管理员一眼看懂「这一档就是不给写」；AI 能力是单点开关。 */
        const readerCell = r.kind === 'rw'
          ? (reader[r.resource + ':read'] ? '<span style="color:var(--ok)">读 ✔</span>' : '') +
            ' <span style="color:#9ca3af">写 ✘</span>'
          : (reader[r.resource] ? '<span style="color:var(--ok)">开</span>' : '<span style="color:#9ca3af">关</span>');

        const editorCell = r.kind === 'rw'
          ? '<select class="settings-input" data-pm-rw="' + SharedUI.esc(r.resource) + '" style="font-size:13px;padding:2px 6px">' +
              ['none', 'read', 'rw'].map(function (v) {
                const t = { none: '无', read: '只读', rw: '读写' }[v];
                return '<option value="' + v + '"' + (v === triState(r.resource) ? ' selected' : '') + '>' + t + '</option>';
              }).join('') +
            '</select>'
          : '<label style="font-size:13px;font-weight:400;cursor:pointer">' +
              '<input type="checkbox" data-pm-point="' + SharedUI.esc(r.resource) + '"' +
                ((_pmData.allowed.editor || {})[r.resource] ? ' checked' : '') + '> 可调用</label>';

        return '<tr>' +
          '<td style="padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px">' +
            SharedUI.esc(r.name) +
            ' <span style="color:#9ca3af;font-size:11px">' + SharedUI.esc(r.resource) + '</span></td>' +
          '<td style="padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px">' + readerCell + '</td>' +
          '<td style="padding:6px 10px;border-bottom:1px solid var(--line)">' + editorCell + '</td>' +
        '</tr>';
      }).join('');
      return title + lines;
    }).join('');

    box.innerHTML = head + body + '</tbody></table>';

    if (!box.dataset.pmBound) {
      box.dataset.pmBound = '1';
      box.addEventListener('change', onMatrixChange);
    }
    box.dataset.editable = editable || '';
  }

  function onMatrixChange(e) {
    const rw = e.target.closest('[data-pm-rw]');
    const pt = e.target.closest('[data-pm-point]');
    if (!rw && !pt) return;

    const editable = (_pmData && _pmData.editableRole) || 'editor';
    const resource = rw ? rw.dataset.pmRw : pt.dataset.pmPoint;
    const body = rw
      ? { role: editable, resource: resource, read: rw.value !== 'none', write: rw.value === 'rw' }
      : { role: editable, resource: resource, allowed: !!pt.checked };

    /* 先把控件锁住，避免改一格的过程中又动另一格 —— 两次 POST 交错回来，
       后到的响应会把先到的那格的选择冲掉，界面和库里就对不上了。 */
    e.target.disabled = true;

    fetch('/api/auth/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    })
      .then(r => r.json().then(d => ({ ok: r.ok, d: d })))
      .then(function (r) {
        if (!r.ok) {
          SharedUI.toast((r.d && r.d.error) || '保存失败', 'error');
          /* 失败回滚：重拉一次矩阵，让控件回到服务端的真实值。
             不自己改控件的值 —— 前端猜的服务端状态没有意义。 */
          return loadPermissionMatrix();
        }
        if (_pmData && _pmData.allowed && _pmData.allowed[editable]) {
          if (rw) {
            _pmData.allowed[editable][resource + ':read'] = body.read ? 1 : 0;
            _pmData.allowed[editable][resource + ':write'] = body.write ? 1 : 0;
          } else {
            _pmData.allowed[editable][resource] = body.allowed ? 1 : 0;
          }
        }
        SharedUI.toast('已保存', 'success');
      })
      .catch(function () {
        SharedUI.toast('网络异常，未保存', 'error');
        loadPermissionMatrix();
      })
      .then(function () { e.target.disabled = false; });
  }

  function onUserTableChange(e) {
    const sel = e.target.closest('[data-um-role]');
    if (!sel) return;
    const id = sel.dataset.umRole;
    const role = sel.value;

    fetch('/api/auth/users/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id: id, role: role })
    })
      .then(r => r.json().then(d => ({ ok: r.ok, d: d })))
      .then(function (r) {
        if (!r.ok) SharedUI.toast((r.d && r.d.error) || '改角色失败', 'error');
        else SharedUI.toast(id + ' 的角色已改为 ' + role, 'success');
        loadUserList();   // 失败时也重拉，把下拉框拉回服务端的真实值
      })
      .catch(function () { SharedUI.toast('网络异常，角色未修改', 'error'); loadUserList(); });
  }

  function onUserTableClick(e) {
    const toggle = e.target.closest('[data-um-toggle]');
    if (toggle) return toggleUser(toggle.dataset.umToggle, toggle.dataset.on !== '1');
    const reset = e.target.closest('[data-um-reset]');
    if (reset) return resetUserPassword(reset.dataset.umReset);
  }

  /** 启用 / 停用。停用不影响已有会话的当前请求，但下次鉴权就会被挡。 */
  function toggleUser(id, enabled) {
    if (!window.confirm((enabled ? '启用 ' : '停用 ') + id + '？')) return;
    fetch('/api/auth/users/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id: id, enabled: enabled })
    })
      .then(r => r.json().then(d => ({ ok: r.ok, d: d })))
      .then(function (r) {
        if (!r.ok) SharedUI.toast((r.d && r.d.error) || '操作失败', 'error');
        else SharedUI.toast(id + (enabled ? ' 已启用' : ' 已停用'), 'success');
        loadUserList();
      })
      .catch(function () { SharedUI.toast('网络异常，未生效', 'error'); });
  }

  /**
   * 重置密码。★ 口令由用户当场输入，不由前端生成也不由服务端兜底 ——
   * 前端生成等于把规则写在客户端（同批次同规则，正是 9/22 那次事故的成因）；
   * 服务端兜底则会把明文密码写进日志。这里只负责把用户输入传给已有的接口。
   */
  function resetUserPassword(id) {
    const pwd = window.prompt('给 ' + id + ' 设置新密码（至少 6 位）：');
    if (pwd === null) return;
    if (String(pwd).length < 6) { SharedUI.toast('密码至少 6 位', 'error'); return; }

    fetch('/api/auth/users/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id: id, password: pwd })
    })
      .then(r => r.json().then(d => ({ ok: r.ok, d: d })))
      .then(function (r) {
        if (!r.ok) SharedUI.toast((r.d && r.d.error) || '重置失败', 'error');
        else SharedUI.toast(id + ' 的密码已重置', 'success');
        loadUserList();
      })
      .catch(function () { SharedUI.toast('网络异常，密码未修改', 'error'); });
  }

  /* ---------- 模块接口 ---------- */

  return {
    id: 'settings',
    name: '系统设置',
    icon: '⚙',
    order: 8,
    sidebar: false, // 不在侧边栏主导航显示，作为仪表盘子页面

    render: render,

    init(el) { render(el); },
    enter() {},
    leave() {}
  };
})();
