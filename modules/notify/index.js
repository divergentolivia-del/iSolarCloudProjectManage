/* modules/notify/index.js — AI 推送中心（前端配置页）
 *
 * 挂在 #/notify，提供：
 *   1. 状态总览：开关 / 群配置 / agentId / 调度节奏 / 最近检查 / 待发队列
 *   2. 单点发送：按姓名（支持多人）解析钉钉 userId，给具体的人发消息
 *   3. 推送配置：群 ID、agentId、高严重度与提醒阈值，保存即生效（不落 git）
 *   4. 待发队列：查看 + 一键补发
 *   5. 群试发：验证钉钉连通性
 */

// eslint-disable-next-line no-unused-vars
const NotifyModule = (() => {
  'use strict';

  let container = null;

  /* ---------- 工具 ---------- */

  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    let body = {};
    try { body = await r.json(); } catch (e) { /* 非 JSON */ }
    if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
    return body;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function toast(msg, isErr) {
    const el = container.querySelector('#notifyToast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'notify-toast ' + (isErr ? 'error' : 'ok');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'notify-toast'; }, 4000);
  }

  /* ---------- 渲染 ---------- */

  function renderStatus(s) {
    const c = s.config || {};
    const hs = s.lastSummary && s.lastSummary.highSeverity;
    const rm = s.lastSummary && s.lastSummary.reminders;
    const rows = [
      ['总开关', c.enabled ? '✅ 已启用' : '⛔ 已停用'],
      ['群推送', typeof c.groupChatId === 'string' ? c.groupChatId : (c.groupReady ? '已配置' : '未配置（推送进待发队列）')],
      ['责任人单聊', typeof c.agentId === 'string' ? c.agentId : (c.workNoticeReady ? '工作通知' : '机器人单聊（未配 agentId）')],
      ['调度节奏', c.schedule ? ('启动后 ' + c.schedule.startupDelaySeconds + 's 首查，每 ' + c.schedule.intervalMinutes + ' 分钟一次') : '—'],
      ['最近检查', fmtTime(s.lastCheckAt)]
    ];
    let lastLine = '尚未执行过检查';
    if (hs || rm) {
      const h = hs ? ('高严重度：新增 ' + hs.newItems + '（推 ' + hs.pushed + ' / 入队 ' + hs.queued + '）') : '高严重度：—';
      const r = rm ? ('提醒：' + (rm.reminded || []).length + ' 条') : '提醒：—';
      lastLine = h + '，' + r;
    }
    return `
      <div class="settings-section">
        <h3 class="notify-sec-title">📊 状态总览</h3>
        <table class="notify-status-table">
          ${rows.map(r => `<tr><td class="notify-k">${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}
          <tr><td class="notify-k">最近检查</td><td>${esc(lastLine)}</td></tr>
          <tr><td class="notify-k">待发队列</td><td><span id="notifyOutboxCount">${s.outboxCount || 0}</span> 条待补发</td></tr>
        </table>
      </div>`;
  }

  function renderSend() {
    return `
      <div class="settings-section">
        <h3 class="notify-sec-title">✉️ 单点发送（给具体的人发消息）</h3>
        <div class="notify-hint">按姓名直接给同事发钉钉消息，不走群。支持多人，用逗号 / 顿号 / 空格分隔。发送前先点「解析」确认匹配到的人。</div>
        <div class="form-group">
          <label>收件人姓名</label>
          <input type="text" id="notifySendNames" placeholder="如：王亚、李婷" />
          <button class="btn" id="notifyResolveBtn" type="button">🔍 解析</button>
          <div id="notifyResolveResult" class="notify-resolve"></div>
        </div>
        <div class="form-group">
          <label>消息内容</label>
          <textarea id="notifySendText" rows="4" placeholder="要发给对方的话…"></textarea>
        </div>
        <button class="btn primary" id="notifySendBtn" type="button">📨 发送</button>
        <span class="notify-hint">发送走企业内部应用机器人单聊（robot oToMessages），只需 appKey 即可，无需 agentId。</span>
      </div>`;
  }

  function renderConfig(cfg) {
    const hs = cfg.highSeverity || {};
    const rm = cfg.reminders || {};
    const sc = cfg.schedule || {};
    return `
      <div class="settings-section">
        <h3 class="notify-sec-title">⚙️ 推送配置（保存即生效，不落 git）</h3>
        <div class="form-group">
          <label><input type="checkbox" id="notifyEnabled" ${cfg.enabled ? 'checked' : ''} /> 启用推送</label>
        </div>
        <div class="form-group">
          <label>群 openConversationId</label>
          <input type="text" id="notifyGroupId" value="${esc(cfg.groupChatId || '')}" placeholder="cid…（留空则推送进待发队列）" />
          <div class="notify-hint">获取：把机器人拉进目标群 → 群内 @ 机器人任意消息 → 在钉钉开放平台后台消息记录里找该群的 openConversationId（形如 cidXXXX）。</div>
        </div>
        <div class="form-group">
          <label>agentId（可选）</label>
          <input type="text" id="notifyAgentId" value="${esc(cfg.agentId || '')}" placeholder="留空则责任人单聊走机器人通道" />
          <div class="notify-hint">填了之后提醒才发「工作通知」（App 内更正式的单聊），留空用机器人单聊。</div>
        </div>
        <div class="form-group">
          <label><input type="checkbox" id="notifyHsOn" ${hs.on === false ? '' : 'checked'} /> 高严重度自动推群</label>
          <div class="notify-inline">
            <span>级别：</span>
            ${['high', 'medium', 'low'].map(lv => `
              <label class="notify-chip"><input type="checkbox" data-sev="${lv}" ${(hs.severities || ['high']).includes(lv) ? 'checked' : ''} /> ${lv === 'high' ? '高' : lv === 'medium' ? '中' : '低'}</label>`).join('')}
            <span class="notify-hint">单次上限 <input type="number" id="notifyMaxPerRun" style="width:64px" value="${hs.maxPerRun || 8}" min="1" max="50" /> 条</span>
          </div>
        </div>
        <div class="form-group">
          <label><input type="checkbox" id="notifyRmOn" ${rm.on === false ? '' : 'checked'} /> 智能提醒</label>
          <div class="notify-inline">
            <span>封版前</span><input type="text" id="notifySealDays" class="notify-days" value="${(rm.sealDays || [7, 3, 1]).join(',')}" placeholder="7,3,1" />
            <span>上线前</span><input type="text" id="notifyOnlineDays" class="notify-days" value="${(rm.onlineDays || [3, 1]).join(',')}" placeholder="3,1" />
            <span>里程碑前</span><input type="text" id="notifyDueDays" class="notify-days" value="${(rm.dueDays || [3, 1]).join(',')}" placeholder="3,1" />
            <span class="notify-hint">（天，逗号分隔；到点提醒一次）</span>
          </div>
        </div>
        <button class="btn primary" id="notifySaveBtn" type="button">💾 保存配置</button>
        <button class="btn" id="notifyTestBtn" type="button">🧪 试发群消息</button>
        <span class="notify-hint">改了检查间隔（schedule）需重启服务生效，其余立即生效。</span>
      </div>`;
  }

  function renderOutbox(q) {
    const items = (q.entries || []).map(e => `
      <div class="notify-outbox-item">
        <div class="notify-outbox-head">
          <span class="notify-tag ${esc(e.kind)}">${e.kind === 'reminder' ? '提醒' : e.kind === 'workNotice' ? '单聊' : '高严重度'}</span>
          <span class="notify-hint">${fmtTime(e.at)}</span>
          ${e.error ? `<span class="notify-hint" style="color:var(--warn)">原因：${esc(e.error)}</span>` : ''}
        </div>
        <pre class="notify-outbox-text">${esc(e.text || '')}</pre>
      </div>`).join('');
    return `
      <div class="settings-section">
        <h3 class="notify-sec-title">📥 待发队列（${q.count || 0}）</h3>
        ${items || '<div class="notify-hint">队列为空 —— 没有待补发的消息。</div>'}
        <button class="btn" id="notifyFlushBtn" type="button" ${q.count ? '' : 'disabled'}>📤 补发全部</button>
        <button class="btn" id="notifyCheckBtn" type="button">🔎 立即检查一次</button>
      </div>`;
  }

  function render() {
    if (!container) return;
    container.innerHTML = `
      <div class="settings-page notify-page">
        <h2 class="page-title">AI 推送中心</h2>
        <div class="notify-hint">钉钉主动推送：高严重度项自动推群；封版 / 上线 / 里程碑前提醒责任人。配置改完立即生效。</div>
        <div id="notifyBody" class="notify-body"><p>加载中…</p></div>
        <div id="notifyToast" class="notify-toast"></div>
      </div>`;
    loadAll();
  }

  /* ---------- 数据 ---------- */

  async function loadAll() {
    const body = document.getElementById('notifyBody');
    try {
      const [s, cfg] = await Promise.all([
        api('/api/notify/status'),
        api('/api/notify/config')
      ]);
      body.innerHTML = renderStatus(s) + renderSend() + renderConfig(cfg.config || {}) + renderOutbox(s.outbox ? { count: s.outboxCount, entries: s.outbox } : { count: 0, entries: [] });
      bindEvents();
    } catch (e) {
      body.innerHTML = '<div class="notify-hint">加载失败：' + esc(e.message) + '</div>';
    }
  }

  /* ---------- 交互 ---------- */

  function bindEvents() {
    const $ = id => document.getElementById(id);

    /* 解析收件人 */
    const resolveBtn = $('notifyResolveBtn');
    if (resolveBtn) resolveBtn.addEventListener('click', async () => {
      const names = ($('notifySendNames') || {}).value || '';
      const out = $('notifyResolveResult');
      if (!names.trim()) { out.innerHTML = '<span class="notify-hint">先填收件人姓名</span>'; return; }
      out.innerHTML = '解析中…';
      try {
        const r = await api('/api/notify/resolve?names=' + encodeURIComponent(names.trim()));
        const found = (r.found || []).map(f => `<span class="notify-chip ok">${esc(f.name)}<small>${esc(f.dept || '')}</small></span>`).join('');
        const missing = (r.missing || []).map(m => `<span class="notify-chip bad">${esc(m)}（未匹配）</span>`).join('');
        out.innerHTML = (found ? '将发送给：' + found : '') + (missing ? '<br/>未找到：' + missing : '') + (r.hint ? '<br/><span class="notify-hint">' + esc(r.hint) + '</span>' : '');
      } catch (e) {
        out.innerHTML = '<span class="notify-hint">解析失败：' + esc(e.message) + '</span>';
      }
    });

    /* 单点发送 */
    const sendBtn = $('notifySendBtn');
    if (sendBtn) sendBtn.addEventListener('click', async () => {
      const names = ($('notifySendNames') || {}).value || '';
      const text = ($('notifySendText') || {}).value || '';
      if (!names.trim() || !text.trim()) { toast('请填写收件人和消息内容', true); return; }
      sendBtn.disabled = true; sendBtn.textContent = '发送中…';
      try {
        const r = await api('/api/notify/send', { method: 'POST', body: JSON.stringify({ names: names.trim(), text: text.trim() }) });
        if (r.ok) toast('已发送给 ' + r.sent + ' 人' + (r.missing && r.missing.length ? '；未匹配：' + r.missing.join('、') : ''), false);
        else toast('发送失败：' + (r.error || '') + (r.missing && r.missing.length ? '；未匹配：' + r.missing.join('、') : ''), true);
      } catch (e) {
        toast('发送失败：' + e.message, true);
      }
      sendBtn.disabled = false; sendBtn.textContent = '📨 发送';
    });

    /* 保存配置 */
    const saveBtn = $('notifySaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const sevs = Array.from(document.querySelectorAll('#notifyHsOn ~ .notify-inline input[data-sev]:checked')).map(i => i.getAttribute('data-sev'));
      const toNum = (s, def) => { const n = Number(s); return isNaN(n) ? def : n; };
      const patch = {
        enabled: $('notifyEnabled').checked,
        groupChatId: $('notifyGroupId').value.trim(),
        agentId: $('notifyAgentId').value.trim(),
        highSeverity: {
          on: $('notifyHsOn').checked,
          severities: sevs.length ? sevs : ['high'],
          maxPerRun: toNum($('notifyMaxPerRun').value, 8)
        },
        reminders: {
          on: $('notifyRmOn').checked,
          sealDays: $('notifySealDays').value.split(/[,，]/).map(s => toNum(s.trim(), 0)).filter(n => n > 0),
          onlineDays: $('notifyOnlineDays').value.split(/[,，]/).map(s => toNum(s.trim(), 0)).filter(n => n > 0),
          dueDays: $('notifyDueDays').value.split(/[,，]/).map(s => toNum(s.trim(), 0)).filter(n => n > 0)
        }
      };
      saveBtn.disabled = true; saveBtn.textContent = '保存中…';
      try {
        const r = await api('/api/notify/config', { method: 'POST', body: JSON.stringify(patch) });
        toast('已保存。' + (r.note || ''), false);
      } catch (e) {
        toast('保存失败：' + e.message, true);
      }
      saveBtn.disabled = false; saveBtn.textContent = '💾 保存配置';
    });

    /* 试发群消息 */
    const testBtn = $('notifyTestBtn');
    if (testBtn) testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      try {
        const r = await api('/api/notify/test', { method: 'POST' });
        if (r.ok) toast('测试消息已发送到群 ✅', false);
        else toast('试发失败：' + (r.error || ''), true);
      } catch (e) {
        toast('试发失败：' + e.message, true);
      }
      testBtn.disabled = false;
    });

    /* 补发队列 */
    const flushBtn = $('notifyFlushBtn');
    if (flushBtn) flushBtn.addEventListener('click', async () => {
      flushBtn.disabled = true;
      try {
        const r = await api('/api/notify/outbox/flush', { method: 'POST' });
        toast('补发完成：成功 ' + r.flushed + ' 条' + (r.failed && r.failed.length ? '，失败 ' + r.failed.length + ' 条' : ''), r.failed && r.failed.length ? true : false);
        loadAll();
      } catch (e) {
        toast('补发失败：' + e.message, true);
        flushBtn.disabled = false;
      }
    });

    /* 立即检查 */
    const checkBtn = $('notifyCheckBtn');
    if (checkBtn) checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true;
      try {
        const r = await api('/api/notify/check', { method: 'POST' });
        toast(r.skipped ? '上一次检查未结束，本次跳过' : '检查完成', false);
        loadAll();
      } catch (e) {
        toast('检查失败：' + e.message, true);
        checkBtn.disabled = false;
      }
    });
  }

  /* ---------- 样式（随页面注入，不污染全局） ---------- */

  function injectCss() {
    if (document.getElementById('notifyPageCss')) return;
    const style = document.createElement('style');
    style.id = 'notifyPageCss';
    style.textContent = `
      .notify-page { max-width: 860px; }
      .notify-body { display: flex; flex-direction: column; gap: 16px; }
      .notify-sec-title { margin: 0 0 12px; font-size: 15px; color: var(--text); }
      .notify-hint { color: var(--muted); font-size: 12px; margin: 4px 0; }
      .notify-status-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .notify-status-table td { padding: 6px 8px; border-bottom: 1px solid var(--border, rgba(0,0,0,.06)); }
      .notify-k { color: var(--muted); width: 110px; white-space: nowrap; }
      .notify-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; font-size: 13px; }
      .notify-days { width: 84px; }
      .notify-chip { display: inline-flex; align-items: center; gap: 4px; background: var(--panel, #f5f6f8); border: 1px solid var(--border, rgba(0,0,0,.1)); border-radius: 10px; padding: 2px 8px; font-size: 12px; margin-right: 4px; }
      .notify-chip.ok { background: rgba(31,163,138,.1); border-color: rgba(31,163,138,.35); }
      .notify-chip.bad { background: rgba(224,79,95,.08); border-color: rgba(224,79,95,.35); }
      .notify-chip small { color: var(--muted); margin-left: 2px; }
      .notify-resolve { margin-top: 8px; font-size: 13px; line-height: 24px; }
      .notify-outbox-item { border: 1px solid var(--border, rgba(0,0,0,.1)); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
      .notify-outbox-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .notify-outbox-text { white-space: pre-wrap; font-size: 12px; color: var(--muted); margin: 6px 0 0; max-height: 120px; overflow: auto; }
      .notify-tag { font-size: 11px; padding: 1px 8px; border-radius: 8px; background: rgba(76,125,255,.12); color: #4c7dff; }
      .notify-tag.reminder { background: rgba(245,154,36,.14); color: #d97a00; }
      .notify-tag.workNotice { background: rgba(139,108,255,.12); color: #8b6cff; }
      .notify-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 8px 16px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .3s; z-index: 9999; max-width: 70vw; }
      .notify-toast.ok { opacity: 1; }
      .notify-toast.error { opacity: 1; background: #c0392b; }
      .notify-page .form-group { margin-bottom: 12px; }
      .notify-page input[type="text"], .notify-page textarea { width: 100%; box-sizing: border-box; }
      .notify-page textarea { font-family: inherit; }
      .notify-page .btn { margin-right: 8px; }
    `;
    document.head.appendChild(style);
  }

  /* ---------- ModuleDefinition ---------- */

  return {
    id: 'notify',
    name: 'AI 推送',
    icon: '🔔',
    order: 6,
    sidebar: true,

    init(el) {
      container = el;
      injectCss();
      render();
    },

    enter() {
      render();
    },

    leave() {
      container = null;
    }
  };
})();