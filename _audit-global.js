// 跨模块通用渲染审计：控件溢出单元格、页面横向溢出、文字被裁、同源 iframe 一并扫
(() => {
  const EPS = 1.5;
  const out = { docs: [] };

  function scanDoc(label, doc, win) {
    const cellOverflow = [];
    const textClipped = [];
    doc.querySelectorAll('td, th').forEach(cell => {
      const cr = cell.getBoundingClientRect();
      if (cr.width === 0) return;
      cell.querySelectorAll('input, select, textarea, button, .pl-ind').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const over = Math.max(r.right - cr.right, cr.left - r.left);
        if (over > EPS) {
          cellOverflow.push({
            ctrl: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
            field: (el.getAttribute && el.getAttribute('data-f')) || '',
            depth: el.closest('tr') ? (el.closest('tr').getAttribute('data-depth') || '') : '',
            over: Math.round(over) + 'px'
          });
        }
      });
    });
    // 文字被容器裁掉（overflow hidden 且内容宽 > 容器宽），只看可见叶子节点
    doc.querySelectorAll('label, .cs-tab, .pl-form-tab, button, .metric-label, .pl-block-label').forEach(el => {
      const cs = win.getComputedStyle(el);
      if (cs.overflow === 'visible' && cs.textOverflow !== 'ellipsis') return;
      if (el.scrollWidth - el.clientWidth > 2) {
        textClipped.push({ el: el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0], text: (el.textContent || '').trim().slice(0, 24), clip: (el.scrollWidth - el.clientWidth) + 'px' });
      }
    });
    const de = doc.documentElement, b = doc.body;
    out.docs.push({
      doc: label,
      hHScroll: (de.scrollWidth - de.clientWidth) > 2 || (b.scrollWidth - b.clientWidth) > 2,
      scrollW: de.scrollWidth, clientW: de.clientWidth,
      cellOverflowCount: cellOverflow.length,
      cellOverflow: cellOverflow.slice(0, 12),
      textClippedCount: textClipped.length,
      textClipped: textClipped.slice(0, 8)
    });
  }

  scanDoc('top', document, window);
  [...document.querySelectorAll('iframe')].forEach((f, i) => {
    try {
      const d = f.contentDocument;
      if (d && d.body) scanDoc('iframe[' + i + '] ' + (f.getAttribute('src') || '').slice(0, 40), d, f.contentWindow);
      else out.docs.push({ doc: 'iframe[' + i + ']', note: 'no document (未加载)' });
    } catch (e) {
      out.docs.push({ doc: 'iframe[' + i + ']', note: 'cross-origin, 跳过' });
    }
  });
  return out;
})()
