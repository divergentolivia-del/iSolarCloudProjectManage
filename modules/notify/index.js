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
    const chName = c.channel === 'webhook' ? '群自定义机器人 webhook'
      : c.channel === 'app' ? '企业内部应用机器人（groupChatId）'
      : '未配置';
    const rows = [
      ['总开关', c.enabled ? '✅ 已启用' : '⛔ 已停用'],
      ['群推送通道', chName],
      ['群推送', c.channel
        ? '✅ 可发送（' + chName + '）'
        : '未配置（推送进待发队列）'],
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
        <h3 class="notify-sec-title">✉️ 单点发送</h3>
        <div class="notify-hint">按姓名直接给同事发钉钉单聊（不进群）。支持多人，用逗号 / 顿号 / 空格分隔；建议先点「解析」确认匹配到谁。</div>
        <div class="ng-field">
          <div class="ng-labelrow"><label class="ng-label">收件人姓名</label><button class="btn sm" id="notifyResolveBtn" type="button">🔍 解析</button></div>
          <input type="text" id="notifySendNames" class="ng-input" placeholder="如：王亚、李婷" />
          <div id="notifyResolveResult" class="notify-resolve"></div>
        </div>
        <div class="ng-field">
          <label class="ng-label">消息内容</label>
          <textarea id="notifySendText" class="ng-input" rows="4" placeholder="要发给对方的话…"></textarea>
        </div>
        <div class="ng-actions">
          <button class="btn primary" id="notifySendBtn" type="button">📨 发送</button>
          <span class="notify-hint">走企业内部应用机器人单聊，只需 appKey，无需 agentId</span>
        </div>
      </div>`;
  }

  function renderConfig(cfg, isAdmin) {
    const hs = cfg.highSeverity || {};
    const rm = cfg.reminders || {};
    const wh = cfg.webhook || {};
    const sevCls = {
      high: (hs.severities || ['high']).includes('high') ? 'on' : '',
      medium: (hs.severities || ['high']).includes('medium') ? 'on' : '',
      low: (hs.severities || ['high']).includes('low') ? 'on' : ''
    };
    /* 凭据类字段（群机器人 webhook / groupChatId / agentId）只有 admin 渲染。
       判断放在服务端回的 isAdmin 上，而不是前端自己读角色 ——
       非 admin 连这些 HTML 都不该拿到，免得界面上全是「点了必然 403」的输入框。 */
    const credBlock = !isAdmin ? `
        <div class="ng-field">
          <div class="notify-hint">🔒 群机器人配置（webhook 地址 / 加签密钥 / 群 ID）仅平台管理员可见可改。需要调整请联系 admin。</div>
        </div>` : `
        <div class="ng-field">
          <label class="ng-label">群自定义机器人 webhook 地址（推荐）</label>
          <input type="text" id="notifyWebhookUrl" class="ng-input" value="${esc(wh.url || '')}" placeholder="https://oapi.dingtalk.com/robot/send?access_token=…" />
          <div class="notify-hint">获取：目标群 → 群设置 → 智能群助手 → 添加机器人 → 自定义 → 复制 Webhook 地址。配了它就走这条通道（不需要 groupChatId）。</div>
        </div>
        <div class="ng-field">
          <label class="ng-label">加签密钥（安全设置选「加签」时必填）</label>
          <input type="text" id="notifyWebhookSecret" class="ng-input" value="${esc(wh.secret || '')}" placeholder="SEC…（安全设置选「关键词」或「IP 白名单」时留空）" />
          <div class="notify-hint">自定义机器人安全设置三选一：关键词 / 加签 / IP 白名单。选加签才填这里；选关键词填下面那一项。</div>
        </div>
        <div class="ng-field">
          <label class="ng-label">关键词（安全设置选「关键词」时必填）</label>
          <input type="text" id="notifyWebhookKeyword" class="ng-input" value="${esc(wh.keyword || '')}" placeholder="如：阳光云（消息正文会自动带上它）" />
          <div class="notify-hint">填了之后每条消息正文前会自动加这个词，否则钉钉拒收（errcode 310000）。</div>
        </div>
        <div class="ng-field">
          <label class="ng-label">群 openConversationId（备用通道，可留空）</label>
          <input type="text" id="notifyGroupId" class="ng-input" value="${esc(cfg.groupChatId || '')}" placeholder="cid…（留空则不走企业内部应用机器人通道）" />
          <div class="notify-hint">只有不用 webhook、改走企业内部应用机器人时才需要：把机器人拉进目标群 → 群内 @ 机器人任意消息 → 在开放平台后台消息记录里找该群的 openConversationId。</div>
        </div>
        <div class="ng-field">
          <label class="ng-label">agentId（可选）</label>
          <input type="text" id="notifyAgentId" class="ng-input" value="${esc(cfg.agentId || '')}" placeholder="留空则责任人单聊走机器人通道" />
          <div class="notify-hint">填了之后提醒发「工作通知」（更正式），留空走机器人单聊。</div>
        </div>`;
    return `
      <div class="settings-section">
        <h3 class="notify-sec-title">⚙️ 推送配置（保存即生效）</h3>
        <div class="ng-field">
          <div class="ng-labelrow"><label class="ng-label"><input type="checkbox" id="notifyEnabled" ${cfg.enabled ? 'checked' : ''} class="ng-check" /> 启用推送</label></div>
        </div>${credBlock}
        <div class="ng-field">
          <div class="ng-labelrow"><label class="ng-label"><input type="checkbox" id="notifyHsOn" ${hs.on === false ? '' : 'checked'} class="ng-check" /> 高严重度自动推群</label><span class="notify-hint">单次上限 <input type="number" id="notifyMaxPerRun" class="ng-num" value="${hs.maxPerRun || 8}" min="1" max="50" /> 条</span></div>
          <div class="ng-sevs">
            ${['high', 'medium', 'low'].map(lv => `<label class="ng-sev ${sevCls[lv]}"><input type="checkbox" data-sev="${lv}" ${sevCls[lv] ? 'checked' : ''} /><span>${lv === 'high' ? '高' : lv === 'medium' ? '中' : '低'}</span></label>`).join('')}
          </div>
        </div>
        <div class="ng-field">
          <div class="ng-labelrow"><label class="ng-label"><input type="checkbox" id="notifyRmOn" ${rm.on === false ? '' : 'checked'} class="ng-check" /> 智能提醒</label><span class="notify-hint">到天提醒一次，逗号分隔</span></div>
          <div class="ng-days">
            <div class="ng-days-row"><span class="ng-days-k">封版前</span><input type="text" id="notifySealDays" class="ng-input" value="${(rm.sealDays || [7, 3, 1]).join(',')}" placeholder="7,3,1" /></div>
            <div class="ng-days-row"><span class="ng-days-k">上线前</span><input type="text" id="notifyOnlineDays" class="ng-input" value="${(rm.onlineDays || [3, 1]).join(',')}" placeholder="3,1" /></div>
            <div class="ng-days-row"><span class="ng-days-k">里程碑前</span><input type="text" id="notifyDueDays" class="ng-input" value="${(rm.dueDays || [3, 1]).join(',')}" placeholder="3,1" /></div>
          </div>
        </div>
        <div class="ng-actions">
          <button class="btn primary" id="notifySaveBtn" type="button">💾 保存配置</button>
          <button class="btn" id="notifyTestBtn" type="button">🧪 试发群消息</button>
          <span class="notify-hint">改了检查间隔需重启服务，其余立即生效</span>
        </div>
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
      /* 是否 admin 以服务端回的为准（status 与 config 各回一个，取到即用） */
      const isAdmin = !!(cfg.isAdmin || s.isAdmin);
      body.innerHTML =
        renderStatus(s) +
        '<div class="notify-grid">' + renderSend() + renderConfig(cfg.config || {}, isAdmin) + '</div>' +
        renderOutbox(s.outbox ? { count: s.outboxCount, entries: s.outbox } : { count: 0, entries: [] });
      bindEvents(isAdmin);
    } catch (e) {
      body.innerHTML = '<div class="notify-hint">加载失败：' + esc(e.message) + '</div>';
    }
  }

  /* ---------- 交互 ---------- */

  function bindEvents(isAdmin) {
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
      const sevs = Array.from(document.querySelectorAll('.ng-sevs input[data-sev]:checked')).map(i => i.getAttribute('data-sev'));
      const toNum = (s, def) => { const n = Number(s); return isNaN(n) ? def : n; };
      const patch = {
        enabled: $('notifyEnabled').checked,
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
      /* 凭据类字段只在 admin 渲染了输入框，也只在 admin 时提交 ——
         非 admin 若把这些键也带上，服务端会直接 403。 */
      if (isAdmin) {
        patch.webhook = {
          url: ($('notifyWebhookUrl') || {}).value ? $('notifyWebhookUrl').value.trim() : '',
          secret: ($('notifyWebhookSecret') || {}).value ? $('notifyWebhookSecret').value.trim() : '',
          keyword: ($('notifyWebhookKeyword') || {}).value ? $('notifyWebhookKeyword').value.trim() : ''
        };
        patch.groupChatId = ($('notifyGroupId') || {}).value ? $('notifyGroupId').value.trim() : '';
        patch.agentId = ($('notifyAgentId') || {}).value ? $('notifyAgentId').value.trim() : '';
      }
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
      .notify-page { max-width: 1160px; }
      .notify-body { display: flex; flex-direction: column; gap: 16px; }
      .notify-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
      @media (max-width: 1080px) { .notify-grid { grid-template-columns: 1fr; } }
      .notify-sec-title { margin: 0 0 12px; font-size: 15px; color: var(--text); }
      .notify-hint { color: var(--muted); font-size: 12px; margin: 2px 0; line-height: 1.5; }
      .notify-status-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .notify-status-table td { padding: 7px 10px; border-bottom: 1px solid var(--line, rgba(0,0,0,.06)); }
      .notify-k { color: var(--muted); width: 110px; white-space: nowrap; }
      /* —— 表单：纵向布局，label 在上，输入占满宽 —— */
      .ng-field { margin-bottom: 14px; }
      .ng-labelrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
      .ng-label { display: block; font-size: 13px; color: var(--text); margin-bottom: 6px; white-space: nowrap; }
      .ng-labelrow .ng-label { margin-bottom: 0; }
      .ng-check { margin-right: 6px; vertical-align: -2px; }
      .ng-input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 13px; border: 1px solid var(--line, rgba(0,0,0,.12)); border-radius: 8px; background: var(--panel, #fff); color: var(--text); font-family: inherit; }
      .ng-input:focus { outline: none; border-color: #4c7dff; box-shadow: 0 0 0 3px rgba(76,125,255,.12); }
      .ng-num { width: 64px; padding: 3px 6px; font-size: 13px; border: 1px solid var(--line, rgba(0,0,0,.12)); border-radius: 6px; }
      .ng-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
      /* —— 级别选择 chip —— */
      .ng-sevs { display: flex; gap: 8px; flex-wrap: wrap; }
      .ng-sev { display: inline-flex; align-items: center; gap: 6px; padding: 5px 14px; border: 1px solid var(--line, rgba(0,0,0,.12)); border-radius: 99px; font-size: 13px; cursor: pointer; user-select: none; white-space: nowrap; }
      .ng-sev input { display: none; }
      .ng-sev.on { background: rgba(76,125,255,.1); border-color: #4c7dff; color: #2b54d4; font-weight: 600; }
      /* —— 提醒阈值：三行 label+输入 —— */
      .ng-days { display: flex; flex-direction: column; gap: 8px; }
      .ng-days-row { display: flex; align-items: center; gap: 10px; }
      .ng-days-k { width: 64px; flex: none; font-size: 13px; color: var(--muted); }
      /* —— 解析结果 chip：不换行 —— */
      .notify-resolve { margin-top: 8px; font-size: 13px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .notify-chip { display: inline-flex; align-items: center; gap: 5px; background: var(--panel, #f5f6f8); border: 1px solid var(--line, rgba(0,0,0,.1)); border-radius: 10px; padding: 3px 10px; font-size: 12px; white-space: nowrap; }
      .notify-chip.ok { background: rgba(31,163,138,.1); border-color: rgba(31,163,138,.35); }
      .notify-chip.bad { background: rgba(224,79,95,.08); border-color: rgba(224,79,95,.35); }
      .notify-chip small { color: var(--muted); }
      /* —— 待发队列 —— */
      .notify-outbox-item { border: 1px solid var(--line, rgba(0,0,0,.1)); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; background: var(--panel, #fafbfc); }
      .notify-outbox-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .notify-outbox-text { white-space: pre-wrap; font-size: 12px; color: var(--muted); margin: 8px 0 0; max-height: 140px; overflow: auto; line-height: 1.6; }
      .notify-tag { font-size: 11px; padding: 2px 9px; border-radius: 99px; background: rgba(76,125,255,.12); color: #4c7dff; white-space: nowrap; }
      .notify-tag.reminder { background: rgba(245,154,36,.14); color: #d97a00; }
      .notify-tag.workNotice { background: rgba(139,108,255,.12); color: #8b6cff; }
      .notify-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 8px 16px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .3s; z-index: 9999; max-width: 70vw; }
      .notify-toast.ok { opacity: 1; }
      .notify-toast.error { opacity: 1; background: #c0392b; }
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