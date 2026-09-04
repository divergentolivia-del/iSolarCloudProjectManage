/* 界面与状态管理 */

const STORE_KEY = 'cloud-capacity-workbench-v1';

/* 最近一次合并中「两边都改过」的项，展示在顶部横幅供核对 */
let lastConflicts = [];

let state = load() || {
  cycles: [
    { name: '方案一', seal: '', online: '', workdays: 0, saturdays: 0, active: true, note: '' }
  ],
  headcount: {},
  locked: [],
  totals: [],      // 合并后的完整工作量数据 = _totalsCloud + _totalsMiddle
  _totalsCloud: [], // 阳光云迭代工作量统计
  _totalsMiddle: [], // 中后台工作量统计
  board: [],       // 月底版本项目人力看板（产线分布）
  iterations: [],  // 迭代清单与本期勾选状态
  sources: {}      // { totals: {fileName, at, rows}, totalsMiddle: {...}, board: {...} }
};

// Backward compatibility: if state.totals exists but _totalsCloud doesn't, treat totals as _totalsCloud
if (state.totals && state.totals.length && !state._totalsCloud) {
  state._totalsCloud = state.totals;
}
if (!state._totalsMiddle) state._totalsMiddle = [];

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return null; }
}
/* 保存：server 模式提交到服务端并广播，local 模式落 localStorage。
   server 模式下若服务端不可达，Sync 会把这次改动暂存到本机，恢复后自动合并补交。 */
function save(silent) {
  if (Sync.mode === 'server') {
    Sync.push(() => state).then(r => {
      if (r && r.offline) {
        if (r.stored === false) toast('本机暂存失败，请立即导出 JSON 备份');
        else if (!silent) toast('服务未连接，已暂存到本机');
      }
      else if (r && r.conflict) applyMerge(r.server, r.base, r.mine, '他人刚提交了修改');
      else if (r && r.ok && !silent) toast('已提交，其他人会实时看到');
      updateModeBadge();
    }).catch(e => toast('提交失败：' + e.message));
    return;
  }
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  if (!silent) toast('已保存到本机浏览器');
}

/* ---------- 三方合并 ----------
   多人各自离线填写后，若按整份数据二选一必然丢掉一边。
   这里以「断连时的基线」为参照，分别算出我方和服务端相对基线各改了什么，
   再按业务粒度（每组人头数、每条专项、每个迭代…）逐项叠加：
     只有一方改过 → 采用那一方
     两方都改成不同值 → 保留我方并记入冲突清单，交由使用者核对
   这样各组填各组时全自动零丢失，只有真撞同一格才需要人工介入。 */

function eq(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }

/* 按 key 归并一层对象（人头数：key 为组名，值为 {regular, outsource, owner}） */
function mergeMap(baseM, serverM, mineM, label, conflicts) {
  const out = {};
  const keys = new Set([].concat(Object.keys(baseM || {}), Object.keys(serverM || {}), Object.keys(mineM || {})));
  keys.forEach(k => {
    const b = (baseM || {})[k], s = (serverM || {})[k], m = (mineM || {})[k];
    const sChanged = !eq(b, s), mChanged = !eq(b, m);
    if (mChanged && sChanged && !eq(s, m)) {
      conflicts.push(label + ' · ' + k);
      out[k] = m;                       // 撞车时暂用我方，并提示核对
    } else if (mChanged) out[k] = m;
    else out[k] = s;
    if (out[k] === undefined) delete out[k];
  });
  return out;
}

/* 按标识字段归并数组（专项锁定：以名称为标识；迭代：以迭代名为标识） */
function mergeList(baseL, serverL, mineL, idOf, label, conflicts) {
  const index = l => {
    const m = {};
    (l || []).forEach(x => { m[idOf(x)] = x; });
    return m;
  };
  const bi = index(baseL), si = index(serverL), mi = index(mineL);
  const out = [];
  const seen = new Set();
  // 保持服务端顺序在前、我方新增追加在后，避免顺序抖动
  const order = [].concat((serverL || []).map(idOf), (mineL || []).map(idOf));
  order.forEach(k => {
    if (seen.has(k)) return;
    seen.add(k);
    const b = bi[k], s = si[k], m = mi[k];
    const sDel = b !== undefined && s === undefined;   // 服务端删了这条
    const mDel = b !== undefined && m === undefined;   // 我方删了这条
    if (sDel || mDel) return;                          // 任一方删除即视为删除
    const sChanged = !eq(b, s), mChanged = !eq(b, m);
    if (mChanged && sChanged && !eq(s, m)) {
      conflicts.push(label + ' · ' + k);
      out.push(m);
    } else out.push(mChanged ? m : s);
  });
  return out.filter(x => x !== undefined);
}

/* 三方合并主入口。base 缺失时降级为二选一（只可能出现在极老的暂存数据上） */
function mergeStates(base, server, mine) {
  const conflicts = [];
  if (!base) return { merged: mine, conflicts: ['基线缺失，无法自动合并'], degraded: true };

  const pickWhole = (field, label) => {
    const b = base[field], s = server[field], m = mine[field];
    const sChanged = !eq(b, s), mChanged = !eq(b, m);
    if (mChanged && sChanged && !eq(s, m)) { conflicts.push(label); return m; }
    return mChanged ? m : s;
  };

  const merged = {
    // 版本周期整体取用，撞车概率低且行内字段相互关联，不宜拆开合并
    cycles: pickWhole('cycles', '版本周期'),
    headcount: mergeMap(base.headcount, server.headcount, mine.headcount, '人头数', conflicts),
    locked: mergeList(base.locked, server.locked, mine.locked,
      x => (x && x.name) || '(未命名)', '专项锁定', conflicts),
    // 工时源数据整份替换，谁后导入以谁为准；迭代勾选跟随同一来源，避免半新半旧
    totals: pickWhole('totals', '工作量统计导入'),
    _totalsCloud: pickWhole('_totalsCloud', '阳光云工作量统计导入'),
    _totalsMiddle: pickWhole('_totalsMiddle', '中后台工作量统计导入'),
    board: pickWhole('board', '人力看板导入'),
    sources: pickWhole('sources', '数据源信息'),
    iterations: mergeList(base.iterations, server.iterations, mine.iterations,
      x => (x && x.name) || '', '迭代勾选', conflicts),
    iterDirty: mine.iterDirty || server.iterDirty,
    showAllIterations: mine.showAllIterations,
    sourceOverrides: pickWhole('sourceOverrides', '统计口径配置'),
    deviationOverrides: pickWhole('deviationOverrides', '偏差手动调整')
  };
  // 工时源被一方整份换掉时，迭代清单必须跟着那一方走，否则会出现清单里有已不存在的迭代
  if (!eq(base.totals, merged.totals) || !eq(base.board, merged.board) || !eq(base._totalsCloud, merged._totalsCloud) || !eq(base._totalsMiddle, merged._totalsMiddle)) {
    const src = !eq(base.totals, mine.totals) || !eq(base.board, mine.board) || !eq(base._totalsCloud, mine._totalsCloud) || !eq(base._totalsMiddle, mine._totalsMiddle) ? mine : server;
    merged.iterations = src.iterations || [];
  }
  return { merged: merged, conflicts: conflicts, degraded: false };
}

/* 执行合并并提交。冲突不弹窗打断，改为列清单让人事后核对 ——
   两边的填写都已保住，不存在必须当场做的取舍。 */
function applyMerge(serverState, baseState, mineState, why) {
  const r = mergeStates(baseState, serverState, mineState || state);
  state = r.merged;
  Sync.commitMerged(state).then(res => {
    if (res && res.conflict) {
      // 合并期间又有人提交，以新结果为基线再合一次（最多两轮，避免死循环）
      const r2 = mergeStates(res.base, res.server, state);
      state = r2.merged;
      lastConflicts = r.conflicts.concat(r2.conflicts);
      Sync.commitMerged(state);
    } else {
      lastConflicts = r.conflicts;
    }
    toast(r.conflicts.length
      ? (why || '已合并') + '，其中 ' + r.conflicts.length + ' 处两边都改过，请核对'
      : (why || '已合并') + '，双方修改已自动合并');
    renderAll();
  });
}

/* ---------- 断连提示与恢复裁决 ---------- */

/* 顶部常驻横幅。服务不可用期间一直显示，避免使用者以为一切正常；
   合并出现撞车时也用它列出待核对项。 */
function renderBanner() {
  const el = document.getElementById('banner');
  if (!el) return;

  if (Sync.mode === 'server' && !Sync.online) {
    const p = Sync.pending;
    const why = Sync.reason === 'shutdown' ? '协同服务已被管理员停止'
      : Sync.reason === 'server' ? '协同服务写入异常'
      : '与协同服务的连接中断';
    el.className = 'banner off';
    el.innerHTML = `
      <b>⚠ ${why}</b> —— 你现在的填写<b>只保存在本机浏览器</b>，其他人看不到。
      服务恢复后会自动与他人的修改合并补交，请不要关闭浏览器或清理缓存。
      ${p ? `<span class="note">（本机已暂存 ${esc(p.at)} 的修改）</span>` : ''}
      <button class="link" id="bannerExport">导出 JSON 备份</button>`;
    const b = el.querySelector('#bannerExport');
    if (b) b.addEventListener('click', exportJson);
    return;
  }

  if (lastConflicts.length) {
    el.className = 'banner warn';
    el.innerHTML = `
      <b>合并提示：以下 ${lastConflicts.length} 处你和他人都做过修改，已暂用你的值，请核对</b>
      <span class="note">${lastConflicts.map(esc).join('；')}</span>
      <button class="link" id="bannerAck">知道了</button>`;
    const b = el.querySelector('#bannerAck');
    if (b) b.addEventListener('click', () => { lastConflicts = []; renderBanner(); });
    return;
  }

  el.className = 'banner hidden';
  el.innerHTML = '';
}

/* 服务恢复后处理本机暂存 */
function onRecover(remote, pending) {
  if (!pending) {
    state = remote;
    toast('协同服务已恢复');
    renderAll();
    return;
  }
  const age = Date.now() - Number(pending.ts || 0);
  if (age > Sync.pendingMaxAge) {
    const keep = window.confirm(
      '发现 ' + pending.at + ' 的本机暂存，距今已超过 7 天。\n\n' +
      '【确定】把它合并进当前数据　【取消】丢弃这份暂存');
    if (!keep) { Sync.clearPending(); state = remote; renderAll(); return; }
  }
  if (Number(remote.rev || 0) === Number(pending.baseRev || 0)) {
    // 断连期间无人改过服务端，直接补交
    state = pending.state;
    Sync.commitMerged(state).then(r => {
      toast(r && r.ok ? '服务已恢复，断连期间的填写已自动补交' : '服务已恢复，补交失败请手动点保存');
      renderAll();
    });
    return;
  }
  applyMerge(remote, pending.base, pending.state, '服务已恢复，断连期间双方的填写');
}

function updateModeBadge() {
  const el = document.getElementById('modeBadge');
  if (!el) return;
  if (Sync.mode === 'server') {
    el.innerHTML = Sync.online
      ? '<span class="tag ok">实时协同</span> ' +
        '<span class="note">' +
        (state.updatedBy ? '最后更新 ' + esc(state.updatedBy) + ' ' + esc(state.updatedAt || '') : '') + '</span>'
      : '<span class="tag warn">服务未连接</span> <span class="note">改动暂存本机，恢复后自动补交</span>';
  } else {
    el.innerHTML = '<span class="tag hold">单机模式</span> <span class="note">数据仅存本机，需导出 JSON 汇总</span>';
  }
  renderBanner();
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2000);
}
function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
function fmt(v, d) {
  const n = num(v);
  return n.toFixed(d == null ? 1 : d).replace(/\.0+$/, '');
}
function pct(v) { return (num(v) * 100).toFixed(1) + '%'; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/* ---------- 视图切换 ---------- */
let currentView = 'cycle';
const RENDERERS = {};

function switchView(name) {
  currentView = name;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach(v =>
    v.classList.toggle('hidden', v.id !== 'view-' + name));
  RENDERERS[name]();
}

function renderAll() {
  document.getElementById('cycleLabel').textContent = cycleLabelText();
  updateModeBadge();
  RENDERERS[currentView]();
}

function cycleLabelText() {
  const c = activeCycle(state);
  if (!c) return '未设置版本周期';
  const days = cycleDays(c);
  const online = c.online ? '上线 ' + c.online : '未填上线时间';
  return c.name + '：' + online + ' · 开发周期 ' + days + ' 天';
}

document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => switchView(t.dataset.view)));
document.getElementById('btnSave').addEventListener('click', () => save());

/* ---------- ① 版本周期 ---------- */
RENDERERS.cycle = function () {
  const rows = state.cycles.map((c, i) => `
    <tr class="${c.active ? 'cycle-active' : ''}">
      <td class="txt">
        <div class="cell-name">
          <input type="text" data-c="${i}" data-f="name" value="${esc(c.name)}">
          ${c.active ? '<span class="badge-adopt">采用</span>' : ''}
        </div>
      </td>
      <td class="txt"><input type="text" data-c="${i}" data-f="seal" value="${esc(c.seal)}" placeholder="如 8.1"></td>
      <td class="txt"><input type="text" data-c="${i}" data-f="online" value="${esc(c.online)}" placeholder="如 8.13"></td>
      <td class="col-num"><input type="number" step="0.5" data-c="${i}" data-f="workdays" value="${c.workdays}"></td>
      <td class="col-num"><input type="number" step="0.5" data-c="${i}" data-f="saturdays" value="${c.saturdays}"></td>
      <td class="col-num col-strong">${cycleDays(c)}</td>
      <td class="col-pick">
        <input type="radio" name="activeCycle" data-c="${i}" data-f="active" ${c.active ? 'checked' : ''}>
      </td>
      <td class="txt"><input type="text" data-c="${i}" data-f="note" value="${esc(c.note)}" placeholder="备注"></td>
      <td class="col-op"><button class="link" data-del="${i}">删除</button></td>
    </tr>`).join('');

  document.getElementById('view-cycle').innerHTML = `
    <div class="card">
      <h2>版本上线时间与开发周期</h2>
      <p class="hint">可并列维护多个候选方案（月中小版本、跨月合并等），勾选「采用」的方案参与产能计算。开发周期 = 工作日 + 周六天数。</p>
      <div class="scroll"><table>
        <thead><tr>
          <th class="txt">方案</th><th class="txt">封版时间</th><th class="txt">上线时间</th>
          <th class="col-num">工作日</th><th class="col-num">周六天数</th><th class="col-num">开发周期</th><th class="col-pick">采用</th>
          <th class="txt">备注</th><th class="col-op">操作</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p style="margin-top:12px"><button class="btn" id="addCycle">新增方案</button></p>
    </div>`;

  const view = document.getElementById('view-cycle');
  view.querySelectorAll('input[data-c]').forEach(el => {
    el.addEventListener('change', () => {
      const c = state.cycles[+el.dataset.c], f = el.dataset.f;
      if (f === 'active') {
        state.cycles.forEach(x => { x.active = false; });
        c.active = true;
      } else if (f === 'workdays' || f === 'saturdays') {
        c[f] = num(el.value);
      } else {
        c[f] = el.value;
      }
      save(true); renderAll();
    });
  });
  view.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    if (state.cycles.length === 1) return toast('至少保留一个方案');
    const removed = state.cycles.splice(+b.dataset.del, 1)[0];
    if (removed.active && state.cycles[0]) state.cycles[0].active = true;
    save(true); renderAll();
  }));
  view.querySelector('#addCycle').addEventListener('click', () => {
    state.cycles.push({ name: '方案' + (state.cycles.length + 1), seal: '', online: '', workdays: 0, saturdays: 0, active: false, note: '' });
    save(true); renderAll();
  });
};

/* ---------- ② 人头数填报 ---------- */
RENDERERS.headcount = function () {
  const locked = lockedTotals(state);
  let html = '', lastDept = '';
  TEAMS.forEach(t => {
    const h = state.headcount[t.key] || {};
    const total = num(h.regular) + num(h.outsource);
    if (t.dept !== lastDept) {
      lastDept = t.dept;
      html += `<tr class="dept-head"><td colspan="6">${esc(t.dept)}</td></tr>`;
    }
    html += `
      <tr>
        <td class="txt">${esc(t.key)}</td>
        <td class="col-num"><input type="number" step="0.1" data-t="${esc(t.key)}" data-f="regular" value="${h.regular == null ? '' : h.regular}"></td>
        <td class="col-num"><input type="number" step="0.1" data-t="${esc(t.key)}" data-f="outsource" value="${h.outsource == null ? '' : h.outsource}"></td>
        <td class="col-num col-strong">${fmt(total)}</td>
        <td class="col-num">${fmt(locked[t.key])}</td>
        <td class="txt"><input type="text" data-t="${esc(t.key)}" data-f="owner" value="${esc(h.owner)}" placeholder="填报人"></td>
      </tr>`;
  });
  const heads = headcountTotals(state);
  const sum = TEAMS.reduce((s, t) => s + heads[t.key], 0);

  document.getElementById('view-headcount').innerHTML = `
    <div class="card">
      <h2>各组可投入迭代人头数</h2>
      <p class="hint">按组填写正式与外包人数，支持 0.5 等小数（部分投入）。可投入迭代人数 = 正式 + 外包，直接作为产能计算基数。「其中专项锁定」来自第③页，仅作参考展示。</p>
      <div class="scroll"><table>
        <thead><tr>
          <th class="txt">组-方向</th><th class="col-num">正式</th><th class="col-num">外包</th>
          <th class="col-num">可投入迭代人数</th><th class="col-num">其中专项锁定</th><th class="txt">填报人</th>
        </tr></thead>
        <tbody>${html}</tbody>
        <tfoot><tr class="sum">
          <td class="txt">合计</td><td colspan="2"></td>
          <td class="col-num col-strong">${fmt(sum)}</td><td colspan="2"></td>
        </tr></tfoot>
      </table></div>
    </div>`;

  document.querySelectorAll('#view-headcount input').forEach(el => {
    el.addEventListener('change', () => {
      const k = el.dataset.t, f = el.dataset.f;
      if (!state.headcount[k]) state.headcount[k] = {};
      state.headcount[k][f] = (f === 'owner') ? el.value : (el.value === '' ? null : num(el.value));
      // 人头数变化时，清除偏差分析中对应团队的可投入人数 override，保持同步
      if (f === 'regular' || f === 'outsource') {
        if (state.deviationOverrides && state.deviationOverrides[k] && state.deviationOverrides[k].head !== undefined) {
          delete state.deviationOverrides[k].head;
          if (!Object.keys(state.deviationOverrides[k]).length) delete state.deviationOverrides[k];
        }
      }
      save(true); renderAll();
    });
  });
};

/* ---------- ③ 专项锁定人力 ---------- */
RENDERERS.locked = function () {
  const roleTh = LOCK_ROLES.map(r => `<th>${esc(r)}</th>`).join('');
  const lineOpts = OWNER_LINES.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');

  const rows = (state.locked || []).map((item, i) => {
    const roles = item.roles || {};
    const cells = LOCK_ROLES.map(r =>
      `<td><input type="number" step="0.5" data-i="${i}" data-r="${esc(r)}" value="${roles[r] == null ? '' : roles[r]}"></td>`).join('');
    const total = LOCK_ROLES.reduce((s, r) => s + num(roles[r]), 0);
    return `
      <tr>
        <td class="txt"><input type="text" data-i="${i}" data-f="name" value="${esc(item.name)}" placeholder="项目名称"></td>
        ${cells}
        <td>${fmt(total)}</td>
        <td class="txt"><select data-i="${i}" data-f="line"><option value=""></option>${lineOpts}</select></td>
        <td class="txt"><input type="text" data-i="${i}" data-f="confirmer" value="${esc(item.confirmer)}" placeholder="确认人"></td>
        <td class="row-actions"><input type="checkbox" data-i="${i}" data-f="confirmed" ${item.confirmed ? 'checked' : ''}></td>
        <td class="txt"><input type="text" data-i="${i}" data-f="note" value="${esc(item.note)}"></td>
        <td class="row-actions"><button class="link" data-del="${i}">删除</button></td>
      </tr>`;
  }).join('');

  const totals = lockedTotals(state);
  const sumCells = LOCK_ROLES.map(r =>
    `<td>${fmt(totals[LOCK_ROLE_TO_TEAM[r]])}</td>`).join('');
  const grand = LOCK_ROLES.reduce((s, r) => s + num(totals[LOCK_ROLE_TO_TEAM[r]]), 0);

  document.getElementById('view-locked').innerHTML = `
    <div class="card">
      <h2>专项项目锁定人力</h2>
      <p class="hint">登记被专项项目占用、不参与本迭代的人力。此处仅作登记与核对，不自动从第②页人头数中扣减 —— 第②页填的应当已是「可投入迭代」的净人数。</p>
      <div class="scroll"><table>
        <thead><tr>
          <th class="txt">项目</th>${roleTh}<th>合计</th>
          <th class="txt">所属产品线</th><th class="txt">确认人</th><th>已确认</th>
          <th class="txt">备注</th><th>操作</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${LOCK_ROLES.length + 8}" class="txt" style="color:#6b7280">暂无记录</td></tr>`}</tbody>
        <tfoot><tr class="sum">
          <td class="txt">项目投入合计</td>${sumCells}<td>${fmt(grand)}</td>
          <td colspan="5"></td>
        </tr></tfoot>
      </table></div>
      <p style="margin-top:12px"><button class="btn" id="addLock">新增项目</button></p>
    </div>`;

  const view = document.getElementById('view-locked');
  (state.locked || []).forEach((item, i) => {
    const sel = view.querySelector(`select[data-i="${i}"]`);
    if (sel) sel.value = item.line || '';
  });
  view.querySelectorAll('input[data-r]').forEach(el => {
    el.addEventListener('change', () => {
      const item = state.locked[+el.dataset.i];
      if (!item.roles) item.roles = {};
      item.roles[el.dataset.r] = el.value === '' ? null : num(el.value);
      save(true); renderAll();
    });
  });
  view.querySelectorAll('[data-f]').forEach(el => {
    el.addEventListener('change', () => {
      const item = state.locked[+el.dataset.i], f = el.dataset.f;
      item[f] = (f === 'confirmed') ? el.checked : el.value;
      save(true); renderAll();
    });
  });
  view.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    state.locked.splice(+b.dataset.del, 1); save(true); renderAll();
  }));
  view.querySelector('#addLock').addEventListener('click', () => {
    state.locked.push({ name: '', roles: {}, line: '', confirmer: '', confirmed: false, note: '' });
    save(true); renderAll();
  });
};

/* ---------- ④ 工时数据导入 ---------- */

/* 导入成功后重建迭代清单：完全跟随新数据，不保留旧勾选。
   这样清单始终与当前导入文件一一对应，不会残留上月迭代。
   代价是分两次导入（工作量统计 + 人力看板）时，第二次会清掉第一次的勾选，
   故导入后在第⑤页标签上打红点提醒重新勾选。 */
function rebuildIterations() {
  const opts = iterationOptions(state.totals, state.board);
  state.iterations = opts.map(o => ({ name: o.name, weight: o.weight, selected: false }));
  state.iterDirty = true;
}

function handleImport(file, kind) {
  parseFile(file, res => {
    const effectiveKind = kind || res.kind;
    const meta = { fileName: res.fileName, at: new Date().toLocaleString('zh-CN'), rows: res.rows.length };
    if (effectiveKind === 'totals') {
      state._totalsCloud = res.rows;
      state.sources.totals = meta;
    } else if (effectiveKind === 'totalsMiddle') {
      state._totalsMiddle = res.rows;
      state.sources.totalsMiddle = meta;
    } else {
      state.board = res.rows;
      state.sources.board = meta;
    }
    // Merge totals from both sources
    state.totals = (state._totalsCloud || []).concat(state._totalsMiddle || []);
    rebuildIterations();
    save(true); renderAll();
    const label = effectiveKind === 'totalsMiddle' ? '中后台工作量统计'
      : effectiveKind === 'totals' ? '阳光云工作量统计' : '人力看板';
    toast(label + ' 已导入 ' + res.rows.length + ' 行，迭代清单已重建，请到第⑤页重新勾选');
  }, err => toast('导入失败：' + err.message));
}

function sourceCard(kind, title, hint) {
  const s = state.sources[kind];
  const imported = !!s;
  return `
    <div class="card" style="${imported ? 'border-left:4px solid var(--ok)' : ''}">
      <h2>${esc(title)} ${imported ? '<span class="tag ok">✓ 已导入</span>' : '<span class="tag hold">待导入</span>'}</h2>
      <p class="hint">${hint}</p>
      ${imported ? `
        <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:12px;margin:12px 0">
          <div style="font-weight:500;margin-bottom:4px">📄 ${esc(s.fileName)}</div>
          <div style="font-size:13px;color:#16a34a">${s.rows} 行有效数据 · 导入于 ${esc(s.at)}</div>
        </div>
        <div class="drop" data-kind="${kind}" style="background:#fafafa;border-style:dashed">
          点击或拖拽新文件以<b style="color:var(--warn)">覆盖</b>当前数据
        </div>
      ` : `
        <div class="drop" data-kind="${kind}">
          点击选择文件，或拖拽到此处（支持 .csv / .xlsx）
        </div>
      `}
    </div>`;
}

/* ---------- 任务明细同步（TB 视图）---------- */
/* TB = Teambition。阶段二：已打通开放接口，「自动同步 TB」一次性拉取三个看板
   （阳光云迭代 / 中后台 / 产品线维度）的任务故事点，按团队/产品线聚合后写入 state；
   手动导入 CSV 作为同步失败时的兜底。token 存服务端配置，前端不接触明文。

   方案 X：一个 tab（工作量类型）对应若干「TB 统计视图」，视图本身已内置迭代等
   筛选条件（视图名即含迭代信息），因此只需选视图，不再单独设迭代筛选。
   看板模板（团队/迭代/维度）在服务端 tb-config.js 配置，切换迭代只需改 sprintId。 */

/* 明细表格用的 tab（仅切换下方分布表的展示源，不决定同步范围）。
   同步范围由服务端 tb-config.js 的看板模板决定，前端不重复设迭代筛选。
   rows: 从 state 取哪个字段；kind: 导入 CSV 兜底时写入哪个 source。 */
const TB_VIEW_TABS = [
  { key: 'cloud', label: '阳光云迭代', rows: '_totalsCloud', kind: 'totals' },
  { key: 'middle', label: '阳光云迭代中后台', rows: '_totalsMiddle', kind: 'totalsMiddle' },
  { key: 'productLine', label: '产品线维度', rows: 'board', kind: 'board' }
];

/* 按团队聚合某数据源的工时分布：任务数 + 故事点 + 预估故事点 + 合计。
   按合计降序。空数据返回 []（表格显示空态）。 */
function tbTeamDistribution(rows) {
  if (!rows || !rows.length) return [];
  const byTeam = {};
  rows.forEach(r => {
    const team = r.team || r['所在团队'] || r['所属团队'] || '（未填写）';
    if (!byTeam[team]) byTeam[team] = { team: team, count: 0, story: 0, est: 0 };
    byTeam[team].count += 1;
    byTeam[team].story += num(r.story);
    byTeam[team].est += num(r.est);
  });
  return Object.keys(byTeam).map(k => byTeam[k])
    .sort((a, b) => (b.story + b.est) - (a.story + a.est));
}

/* 汇总某组行：任务数 + 故事点/预估故事点/总点数。空数据返回 null（显示「未同步」）。 */
function tbSumRows(rows) {
  if (!rows || !rows.length) return null;
  let story = 0, est = 0;
  rows.forEach(r => { story += num(r.story); est += num(r.est); });
  return { rows: rows.length, story: story, est: est, total: story + est };
}

/* 当前同步的迭代映射（前端配置优先，缺省用已入库的 tbSprintMap）。 */
function currentSprintMap() {
  return state.tbSprintMap || {};
}

function renderTbSyncCard() {
  const tab = state.tbViewTab || 'cloud';
  const activeTab = TB_VIEW_TABS.find(t => t.key === tab) || TB_VIEW_TABS[0];
  const dist = tbTeamDistribution(state[activeTab.rows]);

  const tabsHtml = TB_VIEW_TABS.map(t =>
    `<button class="tb-tab ${t.key === tab ? 'active' : ''}" data-tb-tab="${t.key}">${esc(t.label)}</button>`
  ).join('');

  /* 三源状态汇总（来自已同步的 state 行，每源一行总览） */
  const cloud = tbSumRows(state._totalsCloud);
  const middle = tbSumRows(state._totalsMiddle);
  const board = tbSumRows(state.board);
  const srcRow = (name, s, note) => {
    const body = s
      ? `${s.rows} 任务 · 故事点 ${fmt(s.story, 2)} / 预估 ${fmt(s.est, 2)}`
      : '未同步';
    return `<tr>
      <td class="txt">${esc(name)}</td>
      <td class="col-mid tb-src-val ${s ? '' : 'tb-empty'}">${body}</td>
      <td class="col-mid txt tb-src-note">${esc(note)}</td>
    </tr>`;
  };

  /* 迭代映射编辑：sprintId → 迭代名。未入库的 sprintId 也显示为空行供补充。 */
  const sprintMap = currentSprintMap();
  const sprintKeys = Object.keys(sprintMap);
  const mapRows = sprintKeys.length
    ? sprintKeys.map(sid => `<tr>
        <td class="txt tb-sid">${esc(sid)}</td>
        <td class="txt"><input class="tb-map-name" data-sid="${esc(sid)}" value="${esc(sprintMap[sid] || '')}" placeholder="迭代名（如 阳光云2026-8月C版本迭代）"></td>
        <td class="col-mid"><button class="btn tb-map-del" data-sid="${esc(sid)}">删除</button></td>
      </tr>`).join('')
    : `<tr><td colspan="3" class="txt tb-empty">暂无迭代映射。点击下方「+ 新增迭代映射」添加，或直接点「自动同步 TB」由后端按 tb-config 默认映射落库。</td></tr>`;

  const lastSync = state.updatedAt
    ? `${esc(state.updatedBy || '未署名')} · ${esc(state.updatedAt)}`
    : '尚未同步';

  /* 选中数据源的团队工时分布表 */
  const distRows = dist.length
    ? dist.map(d => `
      <tr>
        <td class="txt">${esc(d.team)}</td>
        <td>${d.count}</td>
        <td>${fmt(d.story, 2)}</td>
        <td>${fmt(d.est, 2)}</td>
        <td>${fmt(d.story + d.est, 2)}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="txt tb-empty">该数据源暂无数据。点击「自动同步 TB」拉取，或「导入 CSV」手动上传。</td></tr>`;

  return `
    <div class="card tb-sync-card">
      <h2>🔗 TB 工时同步 <span class="tb-config-badge" title="Token 是否已配置">…</span></h2>
      <p class="hint">从 Teambition 一次性拉取阳光云、中后台、产品线三个看板的任务故事点，按团队聚合并写入本期工时。Token 在服务端 data/tb/secret.json 配置，前端不接触明文；迭代映射可在下方直接配置。</p>

      <div class="tb-scroll">
        <table class="tb-table tb-src-table">
          <thead><tr><th class="txt">数据源</th><th class="col-mid">当前同步结果</th><th class="col-mid txt">说明</th></tr></thead>
          <tbody>
            ${srcRow('阳光云迭代', cloud, '按团队 → ⑥偏差分析')}
            ${srcRow('阳光云迭代中后台', middle, '中后台团队 → ⑥偏差分析')}
            ${srcRow('产品线维度', board, '产线×团队 → 产线分布')}
          </tbody>
        </table>
      </div>

      <div class="tb-toolbar">
        <div class="tb-actions">
          <button class="btn primary tb-sync-btn" data-tb-kind="${activeTab.kind}">⚡ 自动同步 TB</button>
          <button class="btn tb-import-btn" data-tb-kind="${activeTab.kind}">导入 CSV（兜底）</button>
          <span class="tb-lastsync">上次同步：${lastSync}</span>
        </div>
      </div>

      <details class="tb-map-details">
        <summary>🗂 迭代映射配置（sprintId → 迭代名）· 共 ${sprintKeys.length} 条</summary>
        <p class="hint">把 TB 里的迭代 sprintId 映射成平台可读的迭代名。迭代名每月变化，改这里即可，不用动代码。点「保存映射」落库，下次同步生效。</p>
        <div class="scroll"><table class="tb-table">
          <thead><tr><th class="txt">sprintId</th><th class="txt">迭代名（可编辑）</th><th class="col-mid">操作</th></tr></thead>
          <tbody>${mapRows}</tbody>
        </table></div>
        <div class="tb-actions">
          <button class="btn tb-map-add">+ 新增迭代映射</button>
          <button class="btn primary tb-map-save">保存映射</button>
        </div>
      </details>

      <div class="tb-tabs">${tabsHtml}</div>
      <div class="scroll">
        <table class="tb-table">
          <thead>
            <tr>
              <th class="txt">所属团队</th>
              <th>任务数</th>
              <th>故事点</th>
              <th>预估故事点</th>
              <th>合计</th>
            </tr>
          </thead>
          <tbody>${distRows}</tbody>
        </table>
      </div>
      <p class="note tb-foot">
        同步范围由服务端 tb-config.js 的看板模板决定；「自动同步 TB」一次性拉取三个看板并落库，完成后页面自动刷新。此处按团队聚合展示，不逐条列任务。
      </p>
    </div>`;
}

RENDERERS.import = function () {
  const res = compute(state);

  // 手动导入的三份数据源；有任一已导入则默认展开，否则收起（主推 TB 同步）
  const anyManualImported = !!(state.sources.totals || state.sources.totalsMiddle || state.sources.board);
  const manualOpen = state.manualImportOpen != null ? state.manualImportOpen : anyManualImported;
  const importedCount = [state.sources.totals, state.sources.totalsMiddle, state.sources.board].filter(Boolean).length;

  document.getElementById('view-import').innerHTML = `
    ${renderTbSyncCard()}

    <div class="manual-import ${manualOpen ? 'open' : ''}">
      <button class="manual-import-head" id="manualToggle" aria-expanded="${manualOpen}">
        <span class="manual-import-caret">▸</span>
        <span class="manual-import-title">手动导入工时数据</span>
        <span class="manual-import-sub">TB 关联失败或未接入时的兜底方式${importedCount ? ` · 已导入 ${importedCount}/3` : ''}</span>
      </button>
      <div class="manual-import-body">
        ${sourceCard('totals', '① 阳光云迭代工作量统计（必需）',
          '各团队在阳光云迭代中的工时统计（含中台团队投入阳光云迭代的部分）。与下方中后台数据合并构成完整版本工作量。')}

        ${sourceCard('totalsMiddle', '①-2 阳光云迭代中后台工作量统计（必需）',
          '中后台各组在中后台迭代中的工时统计。中台团队需合并两份表的工时才是完整投入，合并后与人力看板数据可相互对账。')}

        ${sourceCard('board', '② 月底版本项目人力看板（可选）',
          '产线维度明细，仅用于「产品线版本工作量汇总」的分布展示，不参与产能偏差计算。不导入则分类分布表为空，偏差分析仍可正常使用。')}
      </div>
    </div>

    ${res.unknownTeams.length ? `
    <div class="card" style="border-left:3px solid var(--hold)">
      <details>
        <summary style="cursor:pointer;font-weight:600;font-size:14px;color:var(--hold)">
          ⚠ 未识别的团队名 (${res.unknownTeams.length}个) — 点击展开查看
        </summary>
        <p class="hint">以下团队不在白名单中，其工时未计入汇总。如为新组或命名变更，请在 config.js 补充。</p>
        <div class="scroll"><table>
          <thead><tr><th class="txt">团队名</th><th>记录数</th></tr></thead>
          <tbody>${res.unknownTeams.map(u =>
      `<tr><td class="txt">${esc(u.name)}</td><td>${u.count}</td></tr>`).join('')}</tbody>
        </table></div>
      </details>
    </div>` : ''}

    ${res.unmappedLines.length ? `
    <div class="card" style="border-left:3px solid var(--hold)">
      <details>
        <summary style="cursor:pointer;font-weight:600;font-size:14px;color:var(--hold)">
          ⚠ 未归类的分类值 (${res.unmappedLines.length}个) — 点击展开查看
        </summary>
        <p class="hint">看板中出现但未归入产品线或其他分类的值，其工时未计入分类分布表。</p>
        <div class="scroll"><table>
          <thead><tr><th class="txt">分类值</th><th>工时（人天）</th></tr></thead>
          <tbody>${res.unmappedLines.map(u =>
      `<tr><td class="txt">${esc(u.name)}</td><td>${fmt(u.value, 2)}</td></tr>`).join('')}</tbody>
        </table></div>
      </details>
    </div>` : ''}

    <div class="card">
      <h2>统计口径配置</h2>
      <p class="hint">按团队设置工时取数规则。默认来自系统配置，可按需切换。仅对偏差分析计算生效。</p>
      <div class="scroll"><table class="table-compact">
        <thead><tr><th class="txt">团队</th><th class="col-mid">当前口径</th><th class="col-mid">操作</th></tr></thead>
        <tbody>${TEAMS.map(t => {
          const override = (state.sourceOverrides || {})[t.key];
          const current = override || t.source;
          const isEst = current === 'est';
          return '<tr>' +
            '<td class="txt">' + esc(t.key) + '</td>' +
            '<td class="col-mid"><span class="caliber-tag ' + (isEst ? 'est' : 'story') + '">' + (isEst ? '预估故事点' : '故事点') + '</span></td>' +
            '<td class="col-mid"><select class="source-sel" data-team="' + esc(t.key) + '">' +
              '<option value="story"' + (current === 'story' ? ' selected' : '') + '>故事点</option>' +
              '<option value="est"' + (isEst ? ' selected' : '') + '>预估故事点</option>' +
            '</select></td></tr>';
        }).join('')}</tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>导入说明</h2>
      <p class="note">
        · 取数口径：测试部-应用软件测试-云服务取「预估故事点」，其余各组取「故事点」。<br>
        · 团队名大小写自动归一（WEB开发 / Web开发 视为同一组）。<br>
        · ECO 团队自身的组（APP开发-ECO、后端开发-ECO 等）不计入核算主体；而分类维度的「ECO」是阳光云团队投在 ECO 任务上的工时，仍然计入。<br>
        · 站控、嵌入式、工具开发部等非阳光云团队自动忽略，不报未识别告警。<br>
        · 全零行（故事点与预估均为 0）自动跳过，原始导出中这类行占多数。<br>
        · 导入后请到第⑤页勾选本期迭代，否则所有工时为 0。
      </p>
    </div>`;

  const view = document.getElementById('view-import');
  view.querySelectorAll('.drop').forEach(drop => {
    const kind = drop.dataset.kind;
    const pick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,.xlsx,.xls';
      input.addEventListener('change', () => {
        if (input.files[0]) handleImport(input.files[0], kind);
      });
      input.click();
    };
    drop.addEventListener('click', pick);
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.add('hot');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.remove('hot');
    }));
    drop.addEventListener('drop', e => {
      const f = e.dataTransfer.files[0];
      if (f) handleImport(f, kind);
    });
  });
  // 统计口径配置 event binding
  view.querySelectorAll('.source-sel').forEach(el => {
    el.addEventListener('change', () => {
      const team = el.dataset.team;
      if (!state.sourceOverrides) state.sourceOverrides = {};
      state.sourceOverrides[team] = el.value;
      save(true); renderAll();
    });
  });

  // ---------- 手动导入折叠 event binding ----------
  const manualToggle = document.getElementById('manualToggle');
  if (manualToggle) {
    manualToggle.addEventListener('click', () => {
      state.manualImportOpen = !(state.manualImportOpen != null ? state.manualImportOpen
        : !!(state.sources.totals || state.sources.totalsMiddle || state.sources.board));
      RENDERERS.import();
    });
  }

  // ---------- 任务明细同步（TB 视图）event binding ----------
  // tab 切换（仅切换展示视图，不落库，避免误触 save）
  view.querySelectorAll('[data-tb-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tbViewTab = btn.dataset.tbTab;
      RENDERERS.import();
    });
  });

  // Token 配置状态 & 迭代映射默认值：从 /api/tb/config 拉取（仅服务端模式）
  if (Sync.mode === 'server') {
    fetch('api/tb/config', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : {})
      .then(cfg => {
        const badge = view.querySelector('.tb-config-badge');
        if (badge) {
          badge.textContent = cfg.tokenConfigured ? 'Token 已配置' : 'Token 未配置';
          badge.className = 'tb-config-badge ' + (cfg.tokenConfigured ? 'ok' : 'warn');
        }
        // 若前端 state 里还没映射，把服务端默认映射填进来供编辑（不落库，点保存才落）
        if (cfg.sprintMap && !Object.keys(currentSprintMap()).length) {
          state.tbSprintMap = Object.assign({}, cfg.sprintMap);
          RENDERERS.import();
        }
      })
      .catch(() => { /* 本地模式忽略 */ });
  }

  // 「自动同步 TB」：调用后端 /api/tb/sync 一次性拉取三个看板并写入 state
  const syncBtn = view.querySelector('.tb-sync-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => runTbSync(syncBtn));
  }

  // 「导入 CSV」复用现有 handleImport，按当前 tab 对应的 kind 导入
  const importBtn = view.querySelector('.tb-import-btn');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      const kind = importBtn.dataset.tbKind || 'totals';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,.xlsx,.xls';
      input.addEventListener('change', () => {
        if (input.files[0]) handleImport(input.files[0], kind);
      });
      input.click();
    });
  }

  // 「+ 新增迭代映射」：加一行空 sprintId/迭代名
  const addBtn = view.querySelector('.tb-map-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      if (!state.tbSprintMap) state.tbSprintMap = {};
      // 找一个尚未使用的空 sid 键位，避免覆盖已有映射
      let k = '', n = 1;
      while (!k || state.tbSprintMap[k] !== undefined) k = 'new-sprint-' + (n++);
      state.tbSprintMap[k] = '';
      RENDERERS.import();
      const inp = view.querySelector('.tb-map-name[data-sid="' + k + '"]');
      if (inp) { inp.focus(); inp.select(); }
    });
  }

  // 「删除」一条映射
  view.querySelectorAll('.tb-map-del').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.tbSprintMap) return;
      delete state.tbSprintMap[btn.dataset.sid];
      RENDERERS.import();
    });
  });

  // 「保存映射」：把可编辑行回填到 state.tbSprintMap 并落库
  const saveMapBtn = view.querySelector('.tb-map-save');
  if (saveMapBtn) {
    saveMapBtn.addEventListener('click', () => {
      const map = {};
      view.querySelectorAll('.tb-map-name').forEach(inp => {
        const sid = inp.dataset.sid;
        const name = inp.value.trim();
        if (sid && name) map[sid] = name;
      });
      if (!Object.keys(map).length) { toast('请先填写至少一条迭代映射（sprintId + 迭代名）。'); return; }
      state.tbSprintMap = map;
      save(true);
      toast('✅ 已保存迭代映射（' + Object.keys(map).length + ' 条），下次「自动同步 TB」生效');
      RENDERERS.import();
    });
  }
};

/* ---------- TB 自动同步（阶段二）----------
   调用后端 /api/tb/sync，一次性拉取三个看板（阳光云/中后台/产品线）并写入 state。
   后端写入后会通过 SSE 广播，前端 onRemote 自动刷新；这里再显式提示同步结果。
   token 存服务端配置（data/tb/secret.json 或环境变量 TB_TOKEN），前端不接触明文。 */
function runTbSync(btn) {
  if (Sync.mode !== 'server') {
    toast('自动同步需在服务端模式下使用（通过 node server.js 启动后用 http 访问）。当前请用「导入 CSV」。');
    return;
  }
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ 同步中…';

  fetch('api/tb/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      by: (typeof Sync.whoami === 'function' ? Sync.whoami() : '') || 'TB同步',
      // 把前端配置的迭代映射随同步发出；后端合并进 tbSprintMap 并落库，同步即生效
      sprintMap: currentSprintMap()
    })
  })
    .then(r => r.json().then(j => ({ status: r.status, body: j })))
    .then(({ status, body }) => {
      if (status !== 200 || !body.ok) {
        const msg = body && body.error ? body.error : ('同步失败（HTTP ' + status + '）');
        toast('❌ ' + msg);
        return;
      }
      const s = body.stats || {};
      const c = s.cloud || {}, m = s.middle || {}, p = s.productLine || {};
      toast('✅ TB 同步完成：阳光云 ' + (c.taskCount || 0) + ' 任务/' + (c.totalPoints || 0) +
        ' 点，中后台 ' + (m.taskCount || 0) + ' 任务/' + (m.totalPoints || 0) +
        ' 点，产品线 ' + (p.taskCount || 0) + ' 任务/' + (p.totalPoints || 0) + ' 点');
      // 显式拉取最新 state（SSE 也会触发，双保险，避免自身 rev 判定误跳过）
      fetch('api/state', { cache: 'no-store' })
        .then(r => r.json())
        .then(remote => {
          if (remote.totals && remote.totals.length && !remote._totalsCloud) remote._totalsCloud = remote.totals;
          if (!remote._totalsMiddle) remote._totalsMiddle = [];
          state = remote;
          renderAll();
        })
        .catch(() => { /* SSE 会兜底刷新 */ });
    })
    .catch(e => toast('❌ 同步请求失败：' + e.message))
    .finally(() => {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    });
}

/* ---------- ⑤ 迭代口径 ---------- */
RENDERERS.iteration = function () {
  const list = state.iterations || [];
  const selected = list.filter(i => i.selected);

  // 默认只展示与本期相关的候选，避免 116 个迭代全部铺开
  const showAll = !!state.showAllIterations;
  const visible = showAll ? list : list.filter(i =>
    i.selected || /2026年7月|2026-7月|2026年8月|2026-8月/.test(i.name));

  const rows = visible.map(i => {
    const gi = list.indexOf(i);
    return `
      <tr>
        <td class="row-actions"><input type="checkbox" data-i="${gi}" ${i.selected ? 'checked' : ''}></td>
        <td class="txt">${esc(i.name)}</td>
        <td>${fmt(i.weight, 1)}</td>
      </tr>`;
  }).join('');

  document.getElementById('view-iteration').innerHTML = `
    <div class="card">
      <h2>本期迭代口径 ${selected.length ? `<span class="tag ok">已选 ${selected.length} 个</span>` : '<span class="tag warn">未选择</span>'}</h2>
      ${state.iterDirty ? '<p class="tag warn" style="display:inline-block">数据刚重新导入，迭代清单已按新文件重建，此前勾选已清空，请重新勾选</p>' : ''}
      <p class="hint">勾选本期核算包含的迭代。阳光云版本通常需同时勾选<b>「阳光云2026-M月C版本迭代」和「中后台-2026年M月迭代」</b>—— 中台各组的工时挂在后者下。支持跨月合并：需要两月并算时同时勾选两个月份的迭代即可，配合第①页的开发周期天数使用。</p>
      ${selected.length ? `<p class="note">当前口径：${selected.map(s => esc(s.name)).join(' ＋ ')}</p>` : ''}
      <div class="scroll"><table>
        <thead><tr><th>选择</th><th class="txt">迭代名称</th><th>工时权重</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="txt" style="color:#6b7280">请先在第④页导入数据</td></tr>'}</tbody>
      </table></div>
      <p style="margin-top:12px">
        <button class="btn" id="toggleAll">${showAll ? '仅显示本期相关' : '显示全部 ' + list.length + ' 个迭代'}</button>
      </p>
    </div>`;

  const view = document.getElementById('view-iteration');
  view.querySelectorAll('input[data-i]').forEach(el => {
    el.addEventListener('change', () => {
      state.iterations[+el.dataset.i].selected = el.checked;
      state.iterDirty = false;   // 已重新勾选，撤下提醒
      save(true); renderAll();
    });
  });
  view.querySelector('#toggleAll').addEventListener('click', () => {
    state.showAllIterations = !showAll;
    save(true); renderAll();
  });
};

/* ---------- ⑥ 偏差分析 ---------- */
function matrixTable(title, hint, rows, sumRow, sumLabel) {
  const th = TEAMS.map(t => `<th>${esc(t.key)}</th>`).join('');
  const body = rows.map(r => `
    <tr>
      <td class="txt">${esc(r.key)}</td>
      ${TEAMS.map(t => `<td>${fmt(r.values[t.key])}</td>`).join('')}
      <td>${fmt(rowTotal(r.values))}</td>
    </tr>`).join('');
  const foot = sumRow ? `
    <tfoot><tr class="sum">
      <td class="txt">${esc(sumLabel)}</td>
      ${TEAMS.map(t => `<td>${fmt(sumRow[t.key])}</td>`).join('')}
      <td>${fmt(rowTotal(sumRow))}</td>
    </tr></tfoot>` : '';
  return `
    <div class="card">
      <h2>${esc(title)}</h2>
      <p class="hint">${esc(hint)}</p>
      <div class="scroll"><table>
        <thead><tr><th class="txt">分类</th>${th}<th>合计（人天）</th></tr></thead>
        <tbody>${body}</tbody>
        ${foot}
      </table></div>
    </div>`;
}

RENDERERS.analysis = function () {
  const res = compute(state);

  const c = res.cycle;
  let warn = '';
  // Data source indicator - shows exactly what data the system is using
  warn += '<div class="card" style="border-left:3px solid var(--accent)">' +
    '<details><summary style="cursor:pointer;font-size:13px;color:var(--accent)">📊 数据源确认 — 点击展开查看（工时表 ' + (state.totals || []).length + ' 行，已选 ' + res.iterations.length + ' 个迭代）</summary>' +
    '<p class="hint" style="margin-top:8px">当前 state.totals 行数: <b>' + (state.totals || []).length + '</b>，' +
    '_totalsCloud: <b>' + (state._totalsCloud || []).length + '</b>，' +
    '_totalsMiddle: <b>' + (state._totalsMiddle || []).length + '</b></p>' +
    '<p class="hint">已选迭代: <b>' + (res.iterations.length ? res.iterations.join('、') : '无') + '</b></p>' +
    '<p class="hint">各团队 authoritative 值（工时表直接汇总）:</p>' +
    '<div class="scroll" style="max-height:200px;overflow:auto"><table><thead><tr><th>团队</th><th>工时表值</th></tr></thead><tbody>' +
    TEAMS.map(function(t) { return '<tr><td class="txt">' + esc(t.key) + '</td><td>' + fmt(res.authoritative[t.key]) + '</td></tr>'; }).join('') +
    '</tbody></table></div></details></div>';
  if (!res.iterations.length)
    warn += '<div class="card"><p class="tag warn">未选择本期迭代，所有工时为 0。请到第⑤页勾选。</p></div>';
  if (res.days === 0)
    warn += '<div class="card"><p class="tag warn">开发周期为 0 天，请先在第①页填写工作日与周六天数，否则产能全部为 0。</p></div>';

  // 总计表 vs 看板 对账
  const rec = res.reconcile.length ? `
    <div class="card">
      <h2>口径对账 <span class="tag warn">${res.reconcile.length} 处差异</span></h2>
      <p class="hint">工作量统计表（权威口径，用于偏差计算）与人力看板（产线分布）按团队比对，差异超过 ${RECONCILE_TOLERANCE} 人天的列出。差异通常源于两份导出的时间差，或部分任务未挂产线标签。</p>
      <div class="scroll"><table>
        <thead><tr><th class="txt">团队</th><th>工作量统计表</th><th>人力看板</th><th>差异</th></tr></thead>
        <tbody>${res.reconcile.map(r => `
          <tr><td class="txt">${esc(r.team)}</td><td>${fmt(r.totals, 2)}</td>
          <td>${fmt(r.board, 2)}</td><td style="color:var(--warn)">${r.diff > 0 ? '+' : ''}${fmt(r.diff, 2)}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>` : '';

  /* 多方案偏差列：当有 2+ 个 workdays>0 的方案时展示多方案对比 */
  const validSchemes = state.cycles.filter(cyc => cyc.workdays > 0 || cyc.saturdays > 0);
  const multiScheme = validSchemes.length >= 2;

  let schemeHeaders = '';
  let schemeSubHeaders = '';
  if (multiScheme) {
    schemeHeaders = validSchemes.map(cyc => {
      const days = cycleDays(cyc);
      return `<th class="scheme-header" colspan="3">${esc(cyc.name)}（${days}天）</th>`;
    }).join('');
    schemeSubHeaders = validSchemes.map(() =>
      `<th class="scheme-sub-header">总产能</th><th class="scheme-sub-header">超出</th><th class="scheme-sub-header">比例</th>`
    ).join('');
  }

  const devRows = res.deviation.map(d => {
    const cls = d.verdict === '正常' ? 'ok' : (d.verdict === '产能富余' ? 'hold' : 'warn');
    const ratio = Math.min(Math.abs(d.ratio), 1);
    let schemeCells = '';
    if (multiScheme) {
      schemeCells = validSchemes.map(cyc => {
        const days = cycleDays(cyc);
        const cap = d.head * days;
        const over = d.workload - cap;
        const r = cap ? over / cap : 0;
        return `<td>${fmt(cap)}</td><td>${fmt(over)}</td><td>${cap ? pct(r) : '—'}</td>`;
      }).join('');
    }
    return `
      <tr>
        <td class="txt">${esc(d.team)}</td>
        <td><input type="number" step="0.1" class="dev-input${d.workloadOverridden ? ' overridden' : ''}" data-team="${esc(d.team)}" data-field="workload" value="${fmt(d.workload)}"></td>
        <td><input type="number" step="0.1" class="dev-input${d.headOverridden ? ' overridden' : ''}" data-team="${esc(d.team)}" data-field="head" value="${fmt(d.head)}"></td>
        <td>${fmt(d.capacity)}</td>
        <td>${fmt(d.over)}</td>
        <td>${d.capacity ? pct(d.ratio) : '—'}</td>
        <td style="width:120px"><div class="bar"><i class="${d.over > 0 ? 'over' : ''}" style="width:${(ratio * 100).toFixed(0)}%"></i></div></td>
        <td class="txt"><span class="tag ${cls}">${esc(d.verdict)}</span></td>
        ${schemeCells}
      </tr>`;
  }).join('');

  const overall = res.totals.capacity ? (res.totals.workload - res.totals.capacity) / res.totals.capacity : 0;

  let schemeSumCells = '';
  if (multiScheme) {
    schemeSumCells = validSchemes.map(cyc => {
      const days = cycleDays(cyc);
      const cap = res.totals.head * days;
      const over = res.totals.workload - cap;
      const r = cap ? over / cap : 0;
      return `<td>${fmt(cap)}</td><td>${fmt(over)}</td><td>${cap ? pct(r) : '—'}</td>`;
    }).join('');
  }

  document.getElementById('view-analysis').innerHTML = `
    ${warn}
    <div class="kpis">
      <div class="kpi"><div class="k">采用方案</div><div class="v" style="font-size:16px">${esc(c ? c.name : '—')}</div></div>
      <div class="kpi"><div class="k">开发周期（天）</div><div class="v">${res.days}</div></div>
      <div class="kpi"><div class="k">可投入人数</div><div class="v">${fmt(res.totals.head)}</div></div>
      <div class="kpi"><div class="k">版本工作量（人天）</div><div class="v">${fmt(res.totals.workload)}</div></div>
      <div class="kpi"><div class="k">本期迭代</div><div class="v" style="font-size:13px;line-height:1.4">${res.iterations.length ? res.iterations.map(esc).join('<br>') : '—'}</div></div>
      <div class="kpi"><div class="k">总产能（人天）</div><div class="v">${fmt(res.totals.capacity)}</div></div>
      <div class="kpi"><div class="k">整体偏差</div><div class="v" style="color:${overall > 0 ? 'var(--warn)' : 'var(--ok)'}">${res.totals.capacity ? pct(overall) : '—'}</div></div>
    </div>

    <div class="card">
      <h2>团队版本工作量与产能偏差分析</h2>
      <p class="hint">超出工作量 = 版本工作量 − 总产能；总产能 = 可投入人数 × 开发周期。为正说明产能不足需裁剪需求，为负说明产能富余可继续导入需求，${(DEVIATION_TOLERANCE * 100).toFixed(0)}% 以内属正常偏差由团队自行消化。${multiScheme ? '下方同时展示多个方案的产能对比。' : ''}可直接编辑「版本工作量」和「可投入人数」列进行假设分析，黄底表示手动修改值。</p>
      <div class="scroll"><table>
        <thead>
          ${multiScheme ? `<tr><th colspan="8"></th>${schemeHeaders}</tr>` : ''}
          <tr>
            <th class="txt">团队</th><th>版本工作量<br>（人天）</th><th>可投入人数</th>
            <th>总产能<br>（人天）</th><th>超出工作量</th><th>超出比例</th>
            <th>偏差</th><th class="txt">结论</th>
            ${multiScheme ? schemeSubHeaders : ''}
          </tr>
        </thead>
        <tbody>${devRows}</tbody>
        <tfoot><tr class="sum">
          <td class="txt">合计</td>
          <td>${fmt(res.totals.workload)}</td><td>${fmt(res.totals.head)}</td>
          <td>${fmt(res.totals.capacity)}</td>
          <td>${fmt(res.totals.workload - res.totals.capacity)}</td>
          <td>${res.totals.capacity ? pct(overall) : '—'}</td>
          <td colspan="2"></td>
          ${schemeSumCells}
        </tr></tfoot>
      </table></div>
      ${Object.keys(state.deviationOverrides || {}).length ? '<p style="margin-top:12px"><button class="btn" id="resetDeviationOverrides">重置为计算值</button></p>' : ''}
    </div>

    ${rec}
    ${matrixTable('产品线版本工作量汇总', '各产品线在各组的工时分布，来自人力看板。', res.lineRows, res.lineSummary, '产品线汇总')}
    ${matrixTable('版本规划工作量汇总', '产品线汇总 + 其他分类。「智慧能源产品中心」为部门级兜底分类，占比过高说明大量任务未打产线标签。', res.planRows, res.planTotal, '合计')}`;

  // Deviation input event bindings
  const view = document.getElementById('view-analysis');
  view.querySelectorAll('.dev-input').forEach(el => {
    el.addEventListener('change', () => {
      const team = el.dataset.team;
      const field = el.dataset.field;
      if (!state.deviationOverrides) state.deviationOverrides = {};
      if (!state.deviationOverrides[team]) state.deviationOverrides[team] = {};
      state.deviationOverrides[team][field] = num(el.value);
      save(true);
      RENDERERS.analysis();
    });
  });
  const resetBtn = view.querySelector('#resetDeviationOverrides');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      state.deviationOverrides = {};
      save(true);
      RENDERERS.analysis();
    });
  }
};

/* ---------- 归档功能 (Archive UI) ---------- */

/* 归档只读模式状态 */
let archiveReadOnly = false;
let archiveViewData = null;  // { meta, state } of the archive being viewed

/* 模态框通用方法 */
function showModal(title, bodyHtml, footerHtml) {
  const modal = document.getElementById('archiveModal');
  document.getElementById('archiveModalTitle').textContent = title;
  document.getElementById('archiveModalBody').innerHTML = bodyHtml;
  document.getElementById('archiveModalFooter').innerHTML = footerHtml;
  modal.classList.remove('hidden');
}
function hideModal() {
  document.getElementById('archiveModal').classList.add('hidden');
}
document.getElementById('archiveModalClose').addEventListener('click', hideModal);
document.getElementById('archiveModal').addEventListener('click', function (e) {
  if (e.target === this) hideModal();
});

/* 8.1: 归档本迭代按钮 — 确认对话框 */
function showArchiveDialog() {
  if (archiveReadOnly) return;
  if (Sync.mode === 'server' && !Sync.online) {
    toast('服务未连接，无法归档');
    return;
  }
  const res = compute(state);
  const c = res.cycle;
  const overall = res.totals.capacity
    ? ((res.totals.workload - res.totals.capacity) / res.totals.capacity * 100).toFixed(1) + '%'
    : '—';

  // Derive a smart default title from iterations or cycle info
  let defaultTitle = '';
  if (res.iterations && res.iterations.length > 0) {
    const firstIter = res.iterations[0] || '';
    const monthMatch = firstIter.match(/(\d+)月/);
    const month = monthMatch ? monthMatch[1] + '月' : (new Date().getMonth() + 1) + '月';
    defaultTitle = '阳光云' + new Date().getFullYear() + '年' + month + '迭代版本';
  } else if (c && c.online) {
    defaultTitle = new Date().getFullYear() + '年' + c.online + '上线版本';
  } else {
    defaultTitle = new Date().getFullYear() + '年' + (new Date().getMonth() + 1) + '月迭代';
  }

  const bodyHtml = `
    <div style="margin-bottom:16px">
      <label style="font-size:13px;color:var(--muted);display:block;margin-bottom:4px">归档标题（可编辑）</label>
      <input type="text" id="archiveNameInput" value="${esc(defaultTitle)}" 
        style="width:100%;padding:8px 12px;border:1px solid var(--line);border-radius:4px;font-size:14px">
    </div>
    <p style="margin:0 0 12px"><b>确认归档当前迭代？</b></p>
    <dl class="archive-metrics">
      <dt>上线时间</dt><dd>${esc(c ? c.online || '未设置' : '未设置')}</dd>
      <dt>封版时间</dt><dd>${esc(c ? c.seal || '未设置' : '未设置')}</dd>
      <dt>开发周期</dt><dd>${res.days} 天</dd>
      <dt>总工作量</dt><dd>${fmt(res.totals.workload)} 人天</dd>
      <dt>总产能</dt><dd>${fmt(res.totals.capacity)} 人天</dd>
      <dt>整体偏差</dt><dd style="color:${res.totals.workload > res.totals.capacity ? 'var(--warn)' : 'var(--ok)'}">${overall}</dd>
      <dt>本期迭代</dt><dd style="font-size:12px">${res.iterations.length ? res.iterations.map(esc).join('、') : '未选择'}</dd>
    </dl>
    <p style="color:var(--muted);font-size:12px;margin:12px 0 0">
      归档后本迭代数据将被永久保存，后续修改不影响已归档内容。
    </p>`;

  const footerHtml = `
    <button class="btn" onclick="hideModal()">取消</button>
    <button class="btn primary" id="confirmArchiveBtn">确认归档</button>`;

  showModal('归档本迭代', bodyHtml, footerHtml);

  document.getElementById('confirmArchiveBtn').addEventListener('click', doArchive);
}

/* 执行归档 */
function doArchive() {
  const btn = document.getElementById('confirmArchiveBtn');
  if (btn) { btn.disabled = true; btn.textContent = '归档中…'; }

  const nameInput = document.getElementById('archiveNameInput');
  const name = nameInput ? nameInput.value.trim() : '未命名迭代';

  fetch('api/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name,
      note: '',
      archivedBy: Sync.whoami()
    })
  })
    .then(r => r.json())
    .then(result => {
      hideModal();
      if (result.error) {
        toast('归档失败：' + result.error);
        return;
      }
      toast('归档成功！本迭代数据已保存');
      // 提示是否初始化下一迭代
      setTimeout(showInitNextDialog, 600);
    })
    .catch(e => {
      hideModal();
      toast('归档请求失败：' + e.message);
    });
}

/* 归档后提示初始化下一迭代 */
function showInitNextDialog() {
  const bodyHtml = `
    <p style="margin:0 0 8px"><b>本迭代已成功归档！</b></p>
    <p>是否初始化下一迭代？初始化将：</p>
    <ul style="margin:8px 0;padding-left:20px;color:var(--muted);font-size:13px">
      <li>清空工时数据（totals/board/iterations）</li>
      <li>保留人头数和专项锁定项目</li>
      <li>重置版本周期为非激活状态</li>
    </ul>
    <p style="color:var(--warn);font-size:12px;margin:8px 0 0">⚠ 此操作不可撤销</p>`;

  const footerHtml = `
    <button class="btn" onclick="hideModal()">稍后</button>
    <button class="btn primary" id="confirmInitNextBtn">是，初始化下一迭代</button>`;

  showModal('初始化下一迭代', bodyHtml, footerHtml);

  document.getElementById('confirmInitNextBtn').addEventListener('click', showInitNextConfirm);
}

/* 初始化下一迭代需二次确认 */
function showInitNextConfirm() {
  const bodyHtml = `
    <p style="margin:0;color:var(--warn)"><b>⚠ 再次确认</b></p>
    <p>初始化后当前所有工时数据和迭代勾选将被清空，仅保留人头数和专项锁定。</p>
    <p>确定要继续吗？</p>`;

  const footerHtml = `
    <button class="btn" onclick="hideModal()">取消</button>
    <button class="btn" style="background:var(--warn);border-color:var(--warn);color:#fff" id="finalInitNextBtn">确认初始化</button>`;

  showModal('二次确认', bodyHtml, footerHtml);

  document.getElementById('finalInitNextBtn').addEventListener('click', doInitNext);
}

/* 执行初始化下一迭代 */
function doInitNext() {
  const btn = document.getElementById('finalInitNextBtn');
  if (btn) { btn.disabled = true; btn.textContent = '初始化中…'; }

  fetch('api/archive/init-next', { method: 'POST' })
    .then(r => r.json())
    .then(result => {
      hideModal();
      if (result.error) {
        toast('初始化失败：' + result.error);
        return;
      }
      toast('已初始化下一迭代，工时数据已清空');
      // 刷新当前状态
      return fetch('api/state', { cache: 'no-store' }).then(r => r.json());
    })
    .then(remote => {
      if (remote && remote.cycles) {
        state = remote;
        renderAll();
      }
    })
    .catch(e => {
      hideModal();
      toast('初始化请求失败：' + e.message);
    });
}

/* 归档按钮事件绑定 */
document.getElementById('btnArchive').addEventListener('click', showArchiveDialog);

/* 根据连接状态更新归档按钮可用性 */
function updateArchiveButton() {
  const btn = document.getElementById('btnArchive');
  if (!btn) return;
  if (archiveReadOnly) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  if (Sync.mode === 'server' && !Sync.online) {
    btn.disabled = true;
    btn.title = '服务未连接，无法归档';
  } else {
    btn.disabled = false;
    btn.title = '归档本迭代数据';
  }
}

/* ---------- 8.2: 历史归档 Tab ---------- */

RENDERERS.archiveHistory = function () {
  const view = document.getElementById('view-archiveHistory');
  view.innerHTML = `
    <div class="card">
      <h2>历史归档</h2>
      <p class="hint">按时间降序展示所有归档迭代，点击卡片可查看完整数据。</p>
      <div id="archiveListContainer">
        <p style="color:var(--muted);text-align:center;padding:32px 0">加载中…</p>
      </div>
    </div>`;
  loadArchiveList();
};

function loadArchiveList() {
  fetch('api/archive/list', { cache: 'no-store' })
    .then(r => r.json())
    .then(list => {
      const container = document.getElementById('archiveListContainer');
      if (!container) return;
      if (!list || !list.length) {
        container.innerHTML = '<p style="color:var(--muted);text-align:center;padding:32px 0">暂无归档记录</p>';
        return;
      }
      const rows = list.map(item => {
        const deviation = item.summary && item.summary.overallDeviation != null
          ? (item.summary.overallDeviation * 100).toFixed(1) + '%'
          : '—';
        const onlineTime = item.cycle ? (item.cycle.online || '—') : '—';
        return `
          <tr>
            <td class="txt">${esc(item.name || item.id)}</td>
            <td>${esc(onlineTime)}</td>
            <td>${esc(deviation)}</td>
            <td>${esc(item.archivedBy || '未知')}</td>
            <td>${esc(item.archivedAt || '')}</td>
            <td class="archive-ops" style="white-space:nowrap">
              <button class="btn" onclick="viewArchive('${esc(item.id)}')">查看</button>
              <button class="btn" onclick="exportArchiveExcel('${esc(item.id)}')">导出Excel</button>
              <button class="btn" onclick="deleteArchive('${esc(item.id)}')">删除</button>
            </td>
          </tr>`;
      }).join('');
      container.innerHTML = `
        <div class="scroll"><table>
          <thead><tr>
            <th class="txt">归档标题</th><th>上线时间</th><th>偏差</th>
            <th>操作人</th><th>归档时间</th><th>操作</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;
    })
    .catch(e => {
      const container = document.getElementById('archiveListContainer');
      if (container) container.innerHTML = '<p style="color:var(--warn);text-align:center;padding:32px 0">加载失败：' + esc(e.message) + '</p>';
    });
}

/* 导出归档为 Excel */
async function exportArchiveExcel(id) {
  const data = await fetch('api/archive/' + id).then(r => r.json());
  if (!data || !data.state) { toast('归档数据异常'); return; }
  const result = compute(data.state);
  exportXlsxFromState(data.state, result, data.meta.name || id);
}

/* 删除归档 */
async function deleteArchive(id) {
  if (!window.confirm('确定删除此归档？此操作不可恢复。')) return;
  const resp = await fetch('api/archive/' + id, { method: 'DELETE' });
  const result = await resp.json();
  if (result.error) { toast('删除失败：' + result.error); return; }
  toast('归档已删除');
  loadArchiveList();
}

/* 通用导出 xlsx 逻辑（可用于当前 state 或归档 state） */
function exportXlsxFromState(s, res, fileName) {
  const wb = XLSX.utils.book_new();

  const head = ['分类'].concat(TEAMS.map(t => t.key)).concat(['合计（人天）']);
  const toAoa = rows => [head].concat(rows.map(r =>
    [r.key].concat(TEAMS.map(t => num(r.values[t.key]))).concat([rowTotal(r.values)])));

  XLSX.utils.book_append_sheet(wb,
    XLSX.utils.aoa_to_sheet(toAoa(res.lineRows.concat([{ key: '产品线汇总', values: res.lineSummary }]))),
    '产品线工作量汇总');
  XLSX.utils.book_append_sheet(wb,
    XLSX.utils.aoa_to_sheet(toAoa(res.planRows.concat([{ key: '合计', values: res.planTotal }]))),
    '版本规划工作量汇总');

  const hc = [['组-方向', '正式', '外包', '可投入迭代人数', '填报人']];
  TEAMS.forEach(t => {
    const h = s.headcount[t.key] || {};
    hc.push([t.key, num(h.regular), num(h.outsource), res.heads[t.key], h.owner || '']);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hc), '人头数');

  const dv = [['团队', '版本工作量（人天）', '可投入人数', '总产能（人天）', '超出工作量', '超出比例', '结论']];
  res.deviation.forEach(d => dv.push([d.team, d.workload, d.head, d.capacity, d.over, d.ratio, d.verdict]));
  const overall = res.totals.capacity ? (res.totals.workload - res.totals.capacity) / res.totals.capacity : 0;
  dv.push(['合计', res.totals.workload, res.totals.head, res.totals.capacity,
    res.totals.workload - res.totals.capacity, overall, '']);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dv), '偏差分析');

  const it = [['本期迭代']].concat(res.iterations.map(n => [n]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(it), '迭代口径');

  const cy = [['方案', '封版时间', '上线时间', '工作日', '周六天数', '开发周期', '是否采用', '备注']];
  s.cycles.forEach(c => cy.push([c.name, c.seal, c.online, num(c.workdays), num(c.saturdays), cycleDays(c), c.active ? '是' : '', c.note || '']));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cy), '版本周期');

  XLSX.writeFile(wb, '云平台人力产能-' + (fileName || '未命名') + '.xlsx');
}

/* ---------- 8.3: 只读模式查看归档 ---------- */

function viewArchive(id) {
  fetch('api/archive/' + encodeURIComponent(id), { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error('归档不存在'); return r.json(); })
    .then(data => {
      archiveViewData = data;
      archiveReadOnly = true;
      enterArchiveReadOnlyMode(data);
    })
    .catch(e => toast('查看归档失败：' + e.message));
}

function enterArchiveReadOnlyMode(data) {
  // 保存当前 state 引用（已在全局 state 中）
  if (!window._savedState) window._savedState = state;
  // 替换 state 为归档数据
  state = data.state;

  // 显示顶部横幅
  const banner = document.getElementById('archiveBanner');
  const dateLabel = data.meta.name || data.meta.id || '归档数据';
  banner.innerHTML = `
    <span>📋 正在查看「${esc(dateLabel)}」归档数据（${esc(data.meta.archivedAt || '')}）</span>
    <button class="btn" onclick="exitArchiveView()">返回当前迭代</button>`;
  banner.classList.remove('hidden');

  // 启用只读样式
  document.body.classList.add('archive-readonly');

  // 隐藏历史归档 Tab（查看归档时不需要再看列表）
  const archiveTab = document.querySelector('.tab[data-view="archiveHistory"]');
  if (archiveTab) archiveTab.style.display = 'none';

  // 更新归档按钮
  updateArchiveButton();

  // 切到第一个 Tab 并渲染
  switchView('cycle');

}

function exitArchiveView() {
  archiveReadOnly = false;
  archiveViewData = null;

  // 恢复原 state
  if (window._savedState) {
    state = window._savedState;
    window._savedState = null;
  } else {
    // 从服务端重新拉取
    if (Sync.mode === 'server') {
      fetch('api/state', { cache: 'no-store' })
        .then(r => r.json())
        .then(remote => { state = remote; renderAll(); })
        .catch(() => {});
    }
  }

  // 隐藏横幅
  document.getElementById('archiveBanner').classList.add('hidden');

  // 移除只读样式
  document.body.classList.remove('archive-readonly');

  // 恢复历史归档 Tab 显示
  const archiveTab = document.querySelector('.tab[data-view="archiveHistory"]');
  if (archiveTab) archiveTab.style.display = '';

  // 更新归档按钮
  updateArchiveButton();

  // 重新渲染
  renderAll();
}

/* ---------- 8.4: SSE 事件处理 ---------- */

/* 增强 SSE：监听 archive-created 和 state-reset 事件
   通过覆盖 Sync.init 中 onRemote 的基础上增加归档事件处理 */
function handleArchiveSSEEvents() {
  // 监听自定义 SSE 事件需要直接订阅 EventSource
  // 由于 Sync 已订阅了 api/events，我们在 onRemote 回调中处理
  // archive-created：更新归档列表
  // state-reset：刷新界面

  /* 归档相关的广播通过普通 message 事件发出（服务端 broadcast 函数），
     我们通过检测 state 的变化来响应。当 state.rev 变化且 by 包含 '归档' 或 '初始化新迭代' 时，
     判断为归档相关事件。 */
}

// 在原始 onRemote 中集成归档事件处理
// 修改方式：包装原始 Sync 的 onRemote，使其也处理归档场景
const _origSyncInit = Sync.init;

/* 归档 SSE 事件检测由 onRemote 回调自行判断。
   当收到 by 包含 '归档' 关键字时刷新归档列表；
   当收到 by 包含 '初始化新迭代' 时刷新整个界面。 */
function handleRemoteWithArchive(remote, by) {
  if (archiveReadOnly) {
    // 正在查看归档时，不自动切换状态，仅更新 _savedState
    window._savedState = remote;
    return;
  }
  // Backward compatibility for remote state
  if (remote.totals && remote.totals.length && !remote._totalsCloud) {
    remote._totalsCloud = remote.totals;
  }
  if (!remote._totalsMiddle) remote._totalsMiddle = [];
  state = remote;
  renderAll();

  if (by && by.includes('归档')) {
    // 如果当前在历史归档 Tab，刷新列表
    if (currentView === 'archiveHistory') {
      loadArchiveList();
    }
    toast('有新的归档记录（' + (by || '') + '）');
  } else if (by && by.includes('初始化新迭代')) {
    toast('迭代已重置（' + (by || '') + '）');
  } else {
    toast('数据已更新（' + (by || '他人') + '）');
  }
}

/* ---------- 导入导出 ---------- */
function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const c = activeCycle(state);
  a.download = '人力产能-' + ((c && c.online) || '未命名') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
document.getElementById('btnExport').addEventListener('click', exportJson);

document.getElementById('fileJson').addEventListener('change', function () {
  const f = this.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || !data.cycles) throw new Error('文件格式不符');
      state = data;
      save(true); renderAll();
      toast('已载入');
    } catch (err) { toast('载入失败：' + err.message); }
  };
  reader.readAsText(f);
  this.value = '';
});

document.getElementById('btnExportXlsx').addEventListener('click', () => {
  const res = compute(state);
  const c = activeCycle(state);
  exportXlsxFromState(state, res, (c && c.online) || '未命名');
});

/* 关页面前的兜底：
   1) 正在编辑的输入框还没触发 change，先强制提交一次，避免最后填的那格丢掉
   2) 断连期间有未补交的暂存时给出提醒，防止误以为已保存 */
window.addEventListener('beforeunload', e => {
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (Sync.mode === 'server' && !Sync.online && Sync.pending) {
    e.preventDefault();
    e.returnValue = '有填写内容尚未同步到服务端，关闭后需等本机重新打开才能补交。确定离开？';
    return e.returnValue;
  }
});
/* 服务端可用则以服务端数据为准；他人提交时自动刷新当前视图。
   断连时转本机暂存，恢复后由 onRecover 决定补交还是交由使用者裁决。 */
Sync.init({
  onRemote: handleRemoteWithArchive,
  onStatus: () => { updateModeBadge(); updateArchiveButton(); },
  onStoreFail: () => {
    // 本机也存不下（配额满 / 隐私模式），此时数据只在内存里，刷新即失
    window.alert('本机暂存失败，浏览器存储空间可能已满。\n' +
      '当前填写只存在于内存中，刷新页面会丢失，请立即点右上角「导出 JSON」备份。');
  },
  onRecover: onRecover
}).then(res => {
  if (res.mode === 'server' && res.state) {
    state = res.state;
    // Backward compatibility for server state
    if (state.totals && state.totals.length && !state._totalsCloud) {
      state._totalsCloud = state.totals;
    }
    if (!state._totalsMiddle) state._totalsMiddle = [];
    // 上次断连时暂存的改动（含关掉浏览器后重开的情况），恢复后一并处理
    if (res.pending) onRecover(res.state, res.pending);
  }
  renderAll();
  updateArchiveButton();
});
