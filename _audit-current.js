// 只审计「当前已渲染」的 tab，不做任何点击，避免重渲染冲掉现场
(() => {
  const EPS = 1.5;
  const bad = [];
  document.querySelectorAll('td, th').forEach(cell => {
    const cr = cell.getBoundingClientRect();
    if (cr.width === 0) return;
    cell.querySelectorAll('input, select, textarea, button, .pl-ind').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const overRight = r.right - cr.right;
      const overLeft = cr.left - r.left;
      const over = Math.max(overRight, overLeft);
      if (over > EPS) {
        bad.push({
          ctrl: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
          field: el.getAttribute && el.getAttribute('data-f') || '',
          depth: el.closest('tr') ? (el.closest('tr').getAttribute('data-depth') || '') : '',
          over: Math.round(over) + 'px',
          side: overRight > overLeft ? 'right' : 'left'
        });
      }
    });
  });
  const de = document.documentElement, b = document.body;
  const activeTab = document.querySelector('[data-form-tab].active');
  return {
    activeTab: activeTab ? activeTab.getAttribute('data-form-tab') : '(none)',
    rowsRendered: {
      ov: document.querySelectorAll('tr[data-ov-idx]').length,
      task: document.querySelectorAll('tr[data-task-idx]').length,
      ref: document.querySelectorAll('tr[data-ref-idx]').length,
      market: document.querySelectorAll('tr[data-market-idx]').length
    },
    overflowCount: bad.length,
    overflows: bad.slice(0, 25),
    pageHasHScroll: (de.scrollWidth - de.clientWidth) > 2 || (b.scrollWidth - b.clientWidth) > 2,
    docScrollW: de.scrollWidth, docClientW: de.clientWidth
  };
})()
