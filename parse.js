/* 导入解析层：把 Teambition 导出的 CSV / xlsx 解析成统一记录数组
   自动识别两类文件：
     totals — 表头含「所在团队」「迭代」但无「所属项目」，即工作量统计表
     board  — 表头含「所属项目(层级1)」，即月底版本项目人力看板 */

function cellText(v) {
  return String(v == null ? '' : v).trim();
}
function toNum(v) {
  const n = Number(cellText(v).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}

/* 在前若干行里找表头行 */
function findHeader(aoa) {
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const row = aoa[i] || [];
    const joined = row.map(cellText).join('|');
    if (/所在团队/.test(joined)) return i;
  }
  return -1;
}

/* 解析二维数组，返回 { kind, rows } */
function parseAoa(aoa) {
  const hi = findHeader(aoa);
  if (hi < 0) throw new Error('未找到包含「所在团队」的表头行');
  const head = (aoa[hi] || []).map(cellText);

  const idx = re => head.findIndex(h => re.test(h));
  const cLine = idx(/所属项目|产线/);
  const cTeam = idx(/所在团队/);
  const cIter = idx(/^迭代$/);
  const cEst = idx(/预估故事点/);
  // 故事点列须排除预估故事点列
  const cStory = head.findIndex((h, i) => /故事点/.test(h) && !/预估/.test(h));

  if (cTeam < 0) throw new Error('未定位到「所在团队」列');
  if (cIter < 0) throw new Error('未定位到「迭代」列');
  if (cStory < 0) throw new Error('未定位到「故事点」列');

  const kind = cLine >= 0 ? 'board' : 'totals';
  const rows = [];
  let lastLine = '';

  for (let r = hi + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const team = cellText(row[cTeam]);
    const iter = cellText(row[cIter]);
    if (!team || !iter) continue;

    if (cLine >= 0) {
      const lv = cellText(row[cLine]);
      if (lv) lastLine = lv;   // 合并单元格向下继承
    }
    const story = toNum(row[cStory]);
    const est = cEst >= 0 ? toNum(row[cEst]) : 0;
    if (!story && !est) continue;   // 跳过全零行，原始导出中占多数

    rows.push({
      productLine: cLine >= 0 ? lastLine : '',
      team: team, iteration: iter, story: story, est: est
    });
  }
  if (!rows.length) throw new Error('未解析到有效数据行（故事点全为 0）');
  return { kind: kind, rows: rows, header: head };
}

/* CSV 文本 → 二维数组。处理引号包裹与转义 */
function csvToAoa(text) {
  const out = [];
  let row = [], field = '', inQ = false;
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out;
}

/* 读取文件 → { kind, rows }。CSV 走文本，xlsx 走 SheetJS */
function parseFile(file, onDone, onError) {
  const isCsv = /\.csv$/i.test(file.name);
  const reader = new FileReader();
  reader.onerror = () => onError(new Error('文件读取失败'));
  reader.onload = e => {
    try {
      let aoa;
      if (isCsv) {
        aoa = csvToAoa(e.target.result);
      } else {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const name = wb.SheetNames.find(n => /工时|工作量|看板/.test(n)) || wb.SheetNames[0];
        aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true });
      }
      const res = parseAoa(aoa);
      res.fileName = file.name;
      onDone(res);
    } catch (err) { onError(err); }
  };
  if (isCsv) reader.readAsText(file, 'UTF-8');
  else reader.readAsArrayBuffer(file);
}

/* 从已导入数据中提取迭代清单，按工时降序，便于勾选本期口径 */
function iterationOptions(totals, board) {
  const agg = {};
  (totals || []).concat(board || []).forEach(r => {
    const k = r.iteration;
    if (!agg[k]) agg[k] = 0;
    agg[k] += (Number(r.story) || 0) + (Number(r.est) || 0);
  });
  return Object.keys(agg)
    .map(k => ({ name: k, weight: agg[k] }))
    .sort((a, b) => b.weight - a.weight);
}

if (typeof module !== 'undefined') {
  module.exports = { parseAoa: parseAoa, csvToAoa: csvToAoa, iterationOptions: iterationOptions };
}
