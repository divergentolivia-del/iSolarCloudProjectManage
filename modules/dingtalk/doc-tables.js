/* modules/dingtalk/doc-tables.js — 钉钉智能表格 → aoa（供 import-core 的钉钉映射吃）
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────
 * 这个文件的职责只有一件事：把钉钉 Notable API 返回的
 *   { id, name, fields:[{name,type,...}], records:[{id, fields:{列名:值}}] }
 * 拍平成 import-core 认的
 *   { name, aoa: [[表头...], [第1行...], ...] }
 * 拍平之后走的就是「导入 Excel」那条一模一样的解析链（parseDingTalkSheets），
 * 列映射 / 表单分配 / 层级还原一个字节都不重写。
 *
 * ★★ 最大的坑：每类字段的取值形状都不一样，猜错的表现是「整列静默变空」——
 *    不报错、不告警，只是那一列没数据。下面每个 case 都是拿真实文档
 *    （13 张表 / 1948 行）实测出来的，不是照文档写的。实测结论：
 *      text                 → 裸字符串
 *      richText             → { markdown }
 *      number / autoNumber  → 字符串（"6"、"1"），不是数字
 *      progress             → 分数【字符串】（"0.9"、"1.00"、"0"），不是 0-100
 *                              （import-core 的 parseProgress 已能认 0.9 → 90）
 *      date / lastModifiedTime → 毫秒时间戳（1788883200000）
 *      singleSelect / flow  → { name, id }（实测 4261 个样本，从没出现过裸字符串）
 *      multipleSelect       → [{ name, id }] 或 []
 *      user                 → [{ unionId, name }]
 *      checkbox             → boolean
 *      各种 link            → { linkedRecordIds: [...] }
 *
 * ★★ 第二个坑：层级靠【名字】匹配（import-core 的 buildHierarchy 用 byName）。
 *    所以链接字段（含自引用的 Parent Record）必须解析成「被链接记录的主字段文本」，
 *    直接把 recordId 丢进去的话，所有父子关系都会变成 dangling。
 *    主字段 = fields[0]（钉钉的表头第一列就是主字段，实测确认）。
 *    recordId 全局唯一，所以映射表跨表合建一份，跨表链接也能解析。
 */

'use strict';

/* ---------- 单个单元格：按字段类型拍平成显示文本 ---------- */

/**
 * @param {*} v        原始值
 * @param {object} f   字段定义（要 type）
 * @param {object} idToText  recordId → 主字段文本（跨表）
 */
function flatCell(v, f, idToText) {
  if (v === undefined || v === null) return '';
  const t = f && f.type;

  switch (t) {
    /* 时间类：毫秒时间戳 → Date。交给 import-core 的 parseDate 归一，
       直接给数字会被 parseDate 当成 Excel 日期序列号（>20000 且 <60000 才算，
       时间戳远大于 60000 所以会落到 new Date(数字) 那条，结果不可控）。 */
    case 'date':
    case 'lastModifiedTime':
    case 'createdTime':
      return typeof v === 'number' ? new Date(v) : v;

    /* 富文本：正文在 markdown 里 */
    case 'richText':
      return (v && typeof v === 'object' && typeof v.markdown === 'string') ? v.markdown : '';

    /* 单选 / 流程状态：{ name, id } */
    case 'singleSelect':
    case 'flow':
    case 'flowStatus':
      return (v && typeof v === 'object' && v.name != null) ? String(v.name) : String(v);

    /* 多选 / 人员：数组，取 name 拼起来。
       人员用「、」分隔，因为 import-core 那边既要把整串当负责人显示，
       也可能被成员表按分隔符拆开。 */
    case 'multipleSelect':
    case 'user':
      return Array.isArray(v) ? v.map(x => (x && x.name != null) ? String(x.name) : '').filter(Boolean).join('、') : '';

    /* 链接：解析成被链接记录的主字段文本 —— 层级匹配全靠这个 */
    case 'unidirectionalLink':
    case 'bidirectionalLink':
    case 'link':
      if (v && Array.isArray(v.linkedRecordIds)) {
        return v.linkedRecordIds.map(id => idToText[id] || '').filter(Boolean).join('、');
      }
      return '';

    /* 勾选：转 TRUE/FALSE，与 import-core 的 cellText 口径一致 */
    case 'checkbox':
      return v ? 'TRUE' : 'FALSE';

    /* number / autoNumber / progress / text 等：本来就是字符串，原样给。
       progress 的 "0.9" 由 parseProgress 负责 ×100。 */
    default:
      if (typeof v === 'object') return '';
      return String(v);
  }
}

/* 取链接字段里的第一个 recordId（Parent Record 实际只会有一个）*/
function firstLinkedId(v) {
  if (v && Array.isArray(v.linkedRecordIds) && v.linkedRecordIds.length) return String(v.linkedRecordIds[0]);
  return '';
}

/* ---------- 整表：记录 → aoa ---------- */

/**
 * 把若干张钉钉表拍平成 import-core 认的 sheet 描述。
 *
 * @param {Array} tables  [{ id, name, fields:[{name,type}], records:[{id, fields:{}}] }]
 * @returns {Array<{name:string, aoa:Array<Array>}>}  可直接交给 parseDingTalkSheets
 */
function tablesToSheets(tables) {
  const list = Array.isArray(tables) ? tables : [];

  /* 1) 先建一张全局 recordId → 主字段文本 的表。
     必须【先全部建好再拍平】—— 记录之间会互相链接（还有自引用的
     Parent Record），边遍历边建的话，链接到「后面还没读到的记录」就解析不出来，
     表现为随机一批行层级丢失，极难定位。 */
  const idToText = {};
  list.forEach(function (t) {
    const primary = ((t.fields || [])[0] || {}).name;   // 主字段 = 第一列
    if (!primary) return;
    (t.records || []).forEach(function (r) {
      if (!r || !r.id) return;
      const v = r.fields ? r.fields[primary] : undefined;
      /* 主字段本身也可能是复杂类型，用同一个 flatCell 拍平 */
      idToText[r.id] = flatCell(v, { type: (t.fields || [])[0].type }, idToText);
    });
  });

  /* 2) 逐表拍平：首行是表头（字段名），之后一行一条记录
   *
   * 末尾固定追加两列内部字段 _dtId / _dtParentId：
   *   - 层级还原：钉钉 API 按 recordId 排返回记录，**父行可能在子行下方**
   *     （实测 913 行的 WBS 表里有 332 行是这种）。import-core 原来的建树逻辑
   *     只认「在上方」的父行（那是给 Excel 顺序导出写的），靠名字匹配会大片 dangling。
   *     文档路径手里有权威 recordId，直接用 id 建树，不再猜。
   *   - 增量同步：落盘后任务节点上存 dtRecordId，重同步时按它认人，改名不丢关联。
   * 这两列不参与列映射（映射按平台字段的同义词找表头，这两个名字谁也匹配不上），
   * 由 import-core 单独读出来。 */
  const out = [];
  list.forEach(function (t) {
    const fields = t.fields || [];
    if (!fields.length) return;                 // 没有字段定义的表读不出列名，只能跳过
    const headers = fields.map(function (f) { return String(f.name == null ? '' : f.name); });

    /* 找父列：自引用的链接字段（linkedSheetId === 本表 id），
       钉钉里一般叫 Parent Record。找不到就没有层级。 */
    const parentIdx = fields.findIndex(function (f) {
      return (f.type === 'unidirectionalLink' || f.type === 'bidirectionalLink' || f.type === 'link') &&
        f.property && String(f.property.linkedSheetId) === String(t.id);
    });

    const hAll = headers.concat(['_dtId', '_dtParentId']);
    const aoa = [hAll];
    (t.records || []).forEach(function (r) {
      const vals = r && r.fields ? r.fields : {};
      const row = fields.map(function (f) { return flatCell(vals[f.name], f, idToText); });
      row.push(r && r.id ? String(r.id) : '');
      row.push(parentIdx >= 0 ? firstLinkedId(vals[fields[parentIdx].name]) : '');
      aoa.push(row);
    });

    out.push({ name: String(t.name == null ? '' : t.name), aoa: aoa });
  });

  return out;
}

module.exports = {
  tablesToSheets: tablesToSheets,
  flatCell: flatCell
};
