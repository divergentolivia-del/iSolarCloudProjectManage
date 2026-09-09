// 读出当前 tab 表格的行结构 + 把手坐标，供拖拽测试驱动鼠标
(() => {
  const ATTRS = ['data-ov-idx', 'data-task-idx', 'data-market-idx', 'data-ref-idx',
    'data-ms-idx', 'data-issue-idx', 'data-risk-idx', 'data-res-idx', 'data-member-idx'];
  const attr = ATTRS.find(a => document.querySelector('tr[' + a + ']'));
  if (!attr) return { error: 'no rows' };
  return {
    attr,
    rows: [...document.querySelectorAll('tr[' + attr + ']')].map(tr => {
      const handle = tr.querySelector('.pl-drag');
      const hr = handle ? handle.getBoundingClientRect() : null;
      const rr = tr.getBoundingClientRect();
      const nameInp = tr.querySelector('input[data-f="name"],input[data-f="title"]');
      return {
        idx: Number(tr.getAttribute(attr)),
        depth: tr.getAttribute('data-depth') || '',
        code: (tr.querySelector('.pl-ov-seq') || {}).textContent || '',
        name: nameInp ? nameInp.value : '',
        hasHandle: !!handle,
        hx: hr ? Math.round(hr.left + hr.width / 2) : null,
        hy: hr ? Math.round(hr.top + hr.height / 2) : null,
        top: Math.round(rr.top), h: Math.round(rr.height)
      };
    })
  };
})()
