// 在侧栏上装 MutationObserver，记录 collapsed 类的每一次翻转（含时间戳）
// 震荡发生在同一帧序列内，定时采样会漏掉，必须监听变更本身
(() => {
  const sb = document.querySelector('.sidebar');
  if (!sb) return 'no sidebar';
  if (window.__sbObs) { window.__sbObs.disconnect(); }
  window.__sbLog = [{ t: 0, collapsed: sb.classList.contains('collapsed'), note: 'init' }];
  const t0 = performance.now();
  window.__sbObs = new MutationObserver(() => {
    const c = sb.classList.contains('collapsed');
    const last = window.__sbLog[window.__sbLog.length - 1];
    if (!last || last.collapsed !== c) {
      window.__sbLog.push({ t: Math.round(performance.now() - t0), collapsed: c });
    }
  });
  window.__sbObs.observe(sb, { attributes: true, attributeFilter: ['class'] });
  return 'watching';
})()
