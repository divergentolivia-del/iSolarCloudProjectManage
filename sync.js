/* 协同同步层。自动判别运行模式：
     server 模式 — 通过 http(s) 访问且 /api/state 可用，数据存服务端，多人实时协同
     local  模式 — 直接双击打开 HTML（file://），数据存 localStorage，靠 JSON 文件传递

   断连保护（server 模式）：
     服务端不可达时（node 被 Ctrl+C、服务器重启、网络中断、服务端写盘失败），
     每次变更写入本机 localStorage 暂存，使用者可继续填报；服务恢复后自动补交。
     暂存同时记录「断连时的基线快照」，供 app.js 做三方合并 ——
     这样多人各自离线填写后，恢复时是彼此叠加而不是互相覆盖。

   本层不认识业务数据结构，基线与合并结果都由 app.js 提供。 */

const Sync = (function () {
  const PENDING_KEY = 'cloud-capacity-workbench-pending';
  const RETRY_MS = 5000;              // 断连后重连探测间隔
  const PENDING_MAX_AGE = 7 * 864e5;  // 暂存超过 7 天视为过期，恢复时提醒人工确认

  let mode = 'local';
  let rev = 0;
  let online = true;
  let offReason = '';                 // 'shutdown' 服务端主动关闭 / 'network' 连接中断 / 'server' 服务端报错
  let pushing = false;
  let pendingPush = false;
  let retryTimer = null;
  let base = null;                    // 最近一次确认与服务端一致的快照，三方合并的基线
  let H = {};                         // { onRemote, onStatus, onRecover, onStoreFail }

  function isHttp() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }
  function clone(o) {
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; }
  }

  /* 填报人署名，用于变更留痕 */
  function whoami() {
    let n = localStorage.getItem('workbench-user') || '';
    if (!n) {
      n = (window.prompt('请输入你的姓名（用于记录填报人）') || '').trim();
      if (n) localStorage.setItem('workbench-user', n);
    }
    return n || '未署名';
  }

  /* ---------- 本机暂存 ---------- */
  /* 存三样：基线（断连前的服务端版本）、我的最新版、基线的 rev。
     恢复时三方合并需要基线，缺了它就只能二选一。 */
  function savePending(st) {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({
        baseRev: rev, base: base, state: st,
        ts: Date.now(), at: new Date().toLocaleString('zh-CN')
      }));
      return true;
    } catch (e) {
      // localStorage 配额不足等：这次改动哪儿都没存下，必须让使用者知道
      if (H.onStoreFail) H.onStoreFail(e);
      return false;
    }
  }
  function readPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY)); } catch (e) { return null; }
  }
  function clearPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch (e) { }
  }

  function notify() {
    if (H.onStatus) H.onStatus({ online: online, reason: offReason, pending: readPending() });
  }

  function goOffline(reason) {
    if (mode !== 'server') return;
    if (!online && offReason === reason) return;
    online = false;
    offReason = reason || 'network';
    notify();
    startRetry();
  }

  /* 探测到服务端可达后统一走这里：先取最新状态，再把暂存交给 app 合并 */
  function goOnline() {
    if (mode !== 'server' || online) return;
    fetch('api/state', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('bad'); return r.json(); })
      .then(remote => {
        if (online) return;
        online = true;
        offReason = '';
        if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
        rev = Number(remote.rev || 0);
        notify();
        if (H.onRecover) H.onRecover(remote, readPending());
      })
      .catch(() => { /* 仍未恢复，等下一次探测 */ });
  }

  function startRetry() {
    if (retryTimer) return;
    retryTimer = setInterval(goOnline, RETRY_MS);
  }

  function init(handlers) {
    H = handlers || {};
    if (!isHttp()) return Promise.resolve({ mode: 'local' });

    return fetch('api/state', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('no server'); return r.json(); })
      .then(remote => {
        mode = 'server';
        online = true;
        rev = Number(remote.rev || 0);
        base = clone(remote);
        subscribe();
        return { mode: 'server', state: remote, pending: readPending() };
      })
      .catch(() => ({ mode: 'local' }));
  }

  /* SSE 订阅：他人提交后拉取最新状态；连接开合同时用作在线状态探针 */
  function subscribe() {
    if (!window.EventSource) return;
    const es = new EventSource('api/events');

    es.onopen = () => goOnline();

    // 服务端 Ctrl+C 前主动推送，使页面立刻感知，无需等连接超时
    es.addEventListener('shutdown', () => goOffline('shutdown'));

    es.onmessage = e => {
      let d = {};
      try { d = JSON.parse(e.data); } catch (x) { return; }
      if (Number(d.rev) === rev) return;   // 自己刚提交的，忽略
      fetch('api/state', { cache: 'no-store' })
        .then(r => r.json())
        .then(remote => {
          rev = Number(remote.rev || 0);
          base = clone(remote);
          if (H.onRemote) H.onRemote(remote, d.by);
        })
        .catch(() => { });
    };

    es.onerror = () => {
      // readyState 1(OPEN) 说明只是瞬时抖动；其余状态视为断连。EventSource 自带重连
      if (es.readyState !== 1) goOffline('network');
    };
  }

  function sendState(st) {
    return fetch('api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRev: rev, by: whoami(), state: st })
    }).then(
      r => r.json().then(j => ({ status: r.status, body: j }),
                         () => ({ status: r.status, body: {} })),
      () => ({ netFail: true })
    ).then(res => {
      if (res.netFail) {                    // 请求发不出去，先把这次改动留在本机
        savePending(st);
        goOffline('network');
        return { offline: true };
      }
      if (res.status === 409) {
        // 服务端已被他人更新，把基线一并交给 app 做三方合并
        rev = Number(res.body.currentRev || 0);
        return { conflict: true, server: res.body.state, base: base, mine: st };
      }
      if (res.status !== 200) {
        // 服务端报错（磁盘满、权限等）：数据同样没落到服务端，必须暂存
        savePending(st);
        goOffline('server');
        return { offline: true, error: res.body.error || ('HTTP ' + res.status) };
      }
      rev = Number(res.body.rev || 0);
      base = clone(st);
      clearPending();
      return { ok: true, rev: rev, updatedAt: res.body.updatedAt };
    });
  }

  /* 提交变更。同一时刻只发一个请求，期间的变更合并到下一次 */
  function push(getState) {
    if (mode !== 'server') return Promise.resolve({ local: true });
    const st = getState();

    if (!online) {                // 已知断连：只暂存，不发请求
      const ok = savePending(st);
      startRetry();
      return Promise.resolve({ offline: true, stored: ok });
    }
    if (pushing) { pendingPush = true; return Promise.resolve({ queued: true }); }
    pushing = true;

    return sendState(st).finally(() => {
      pushing = false;
      if (pendingPush) { pendingPush = false; push(getState); }
    });
  }

  /* 合并完成后强制提交：以服务端最新 rev 为基准，不再触发乐观锁 */
  function commitMerged(st) {
    if (mode !== 'server') return Promise.resolve({ local: true });
    return sendState(st);
  }

  return {
    get mode() { return mode; },
    get rev() { return rev; },
    get online() { return mode !== 'server' || online; },
    get reason() { return offReason; },
    get base() { return base; },
    get pending() { return readPending(); },
    get pendingMaxAge() { return PENDING_MAX_AGE; },
    init: init, push: push, whoami: whoami,
    commitMerged: commitMerged, clearPending: clearPending
  };
})();
