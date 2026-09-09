// 侧栏拥挤判定采样：切 tab 后连续采样侧栏状态，检测是否来回震荡
(() => {
  const sb = document.querySelector('.sidebar');
  const wrap = document.querySelector('.table-wrapper');
  const table = wrap && wrap.querySelector('table');
  let need = null;
  if (table) {
    const prev = table.style.width;
    table.style.width = 'min-content';
    need = table.offsetWidth;
    if (prev) table.style.width = prev; else table.style.removeProperty('width');
  }
  return {
    collapsed: !!(sb && sb.classList.contains('collapsed')),
    wrapClientW: wrap ? wrap.clientWidth : null,
    wrapScrollW: wrap ? wrap.scrollWidth : null,
    clipped: wrap ? (wrap.scrollWidth - wrap.clientWidth > 4) : false,
    intrinsicNeed: need
  };
})()
