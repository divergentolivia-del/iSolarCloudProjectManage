// 在页面内构建工作簿并回读，校验：字典翻译、数字单元格类型、层级还原所需的 _id/_parentId
(() => {
  const api = window._planApi;
  if (!api || !api.buildPlanWorkbook) return { error: '_planApi.buildPlanWorkbook 不可用' };
  if (typeof XLSX === 'undefined') return { error: 'XLSX 未加载（本地 vendor 是否 404？）' };

  const plan = api.getPlan(window.__auditPlanId);
  if (!plan) return { error: '找不到计划 ' + window.__auditPlanId };

  const { wb, fileName } = api.buildPlanWorkbook(plan);

  // 写成字节再读回来：真正验证文件可用，而不是只看内存对象
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const wb2 = XLSX.read(buf, { type: 'array' });

  const sheets = {};
  wb2.SheetNames.forEach(n => {
    const ws = wb2.Sheets[n];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    // 收集第 2 行各单元格的类型（n=数字 s=字符串），验证数字列没被写成文本
    const ref = XLSX.utils.decode_range(ws['!ref']);
    const types = [];
    for (let c = ref.s.c; c <= ref.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 1, c: c })];
      types.push(cell ? cell.t : '-');
    }
    sheets[n] = {
      rows: aoa.length,
      head: aoa[0] || [],
      row1: aoa[1] || [],
      row1Types: types,
      hasCols: !!ws['!cols']
    };
  });

  // 层级还原校验：用 _id/_parentId 重建父子关系，与内存中的 plan 比对
  const ovSheet = XLSX.utils.sheet_to_json(wb2.Sheets['项目总览'], { header: 1, raw: false, defval: '' });
  const head = ovSheet[0];
  const iId = head.indexOf('_id'), iPid = head.indexOf('_parentId');
  const rebuilt = ovSheet.slice(1).map(r => ({ id: r[iId], parentId: r[iPid] }));
  const original = (plan.overview || []).map(x => ({ id: x.id, parentId: x.parentId || '' }));
  const sortK = a => a.slice().sort((x, y) => (x.id > y.id ? 1 : -1)).map(x => x.id + '<' + x.parentId).join('|');
  const roundTripOk = sortK(rebuilt) === sortK(original);

  return {
    fileName: fileName,
    bytes: buf.byteLength || buf.length,
    sheetCount: wb2.SheetNames.length,
    roundTripOverviewHierarchy: roundTripOk,
    sheets: sheets
  };
})()
