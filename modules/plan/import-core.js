/* modules/plan/import-core.js — 项目计划导入内核（服务端，纯函数，无 IO）
   ============================================================
   职责：把一份 Excel 工作簿解析成「能直接灌进平台表单」的 plan 对象 + 诊断信息。

   两类来源都走这里，差别只在第 1 步：
     A) 平台自己导出的文件（带 `_元信息` sheet）→ 按 _id/_parentId 精确还原
     B) 钉钉导出的文件（多维表导出）→ 按表头同义词识别 + Parent Record 栈式建树
   2b 的「从钉钉接口拉取」复用的也是 B 这条链路，只是数据来源从文件变成接口。

   两条设计原则（与导出侧对称）：
   1) 只填平台表单里存在的字段。钉钉表里平台没有的列（提出人、参与部门、依赖强度…）
      一律跳过，不往 WBS 里硬塞 —— 见 docs/plan-dingtalk-sync-design.md
   2) 猜不准的东西不猜。状态、进度、层级这类有歧义的，宁可留空并在 diagnostics 里
      标出来让用户在预览页确认，也不做静默猜测。
*/

'use strict';

/* 平台枚举值 → 中文标签。与 modules/plan/index.js 里的 *_LABELS 必须一致，
   导出与导入共用同一套语义（导出时值→标签，导入时标签→值）。 */
const LABELS = {
  planStatus: { draft: '草稿', active: '进行中', completed: '已完成', archived: '已归档' },
  taskStatus: { 'not-started': '未开始', 'in-progress': '进行中', completed: '已完成', blocked: '受阻' },
  priority: { high: '高', medium: '中', low: '低' },
  taskType: { dev: '开发', test: '测试', design: '设计', doc: '文档', ops: '运维', other: '其他' },
  milestoneStatus: { pending: '待开始', 'in-progress': '进行中', done: '已完成' },
  issueStatus: { pending: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' },
  riskType: { tech: '技术风险', market: '市场风险', quality: '质量风险', schedule: '进度风险', resource: '资源风险', other: '其他风险' },
  riskStatus: { occurring: '已发生', watching: '跟进中', mitigated: '已缓解', closed: '已关闭' },
  resKind: { team: '团队', person: '个人' },
  memberRole: {
    pm: '产品经理', pjm: '项目经理', specialist: '项目专员', se: '系统经理',
    dev: '研发', test: '测试', ux: 'UX/UI', ops: '运维', other: '其他'
  },
  refStage: { TR2: 'TR2', TR3: 'TR3', TR4: 'TR4', TR5: 'TR5', other: '其他' },
  refDocStatus: { pending: '待提交', submitted: '已提交', reviewing: '评审中', passed: '已通过', na: '不适用' }
};

/* 反查表：中文标签（含若干常见别名）→ 平台枚举值。导入时用 */
function buildReverse(map, extra) {
  const out = {};
  Object.keys(map).forEach(k => { out[normLabel(map[k])] = k; });
  Object.keys(extra || {}).forEach(alias => { out[normLabel(alias)] = extra[alias]; });
  return out;
}
/* 归一化标签：去空白、全角转半角的基础处理，避免「已 完成」「已完成 」对不上 */
function normLabel(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, '')
    .replace(/[（）]/g, m => (m === '（' ? '(' : ')'))
    .replace(/[：:]/g, '')
    .replace(/[％%]/g, '%')
    .trim();
}

/* 反查字典。别名是实测里出现过的写法，不是拍脑袋列的。 */
const FROM_LABEL = {
  taskStatus: buildReverse(LABELS.taskStatus, {
    '未开始': 'not-started', '待开始': 'not-started', '未启动': 'not-started', '计划中': 'not-started', '待规划': 'not-started',
    '进行中': 'in-progress', '处理中': 'in-progress', '跟进中': 'in-progress', '开发中': 'in-progress', '测试中': 'in-progress',
    '已完成': 'completed', '完成': 'completed', '已上线': 'completed', '已发布': 'completed', '已结项': 'completed', '100%': 'completed',
    '受阻': 'blocked', '阻塞': 'blocked', '延期': 'blocked', '风险': 'blocked'
  }),
  priority: buildReverse(LABELS.priority, { '高': 'high', '中': 'medium', '低': 'low', 'P0': 'high', 'P1': 'high', 'P2': 'medium', 'P3': 'low' }),
  taskType: buildReverse(LABELS.taskType, { '前端': 'dev', '后端': 'dev', '开发': 'dev', '联调': 'dev' }),
  milestoneStatus: buildReverse(LABELS.milestoneStatus, { '未开始': 'pending', '待开始': 'pending', '进行中': 'in-progress', '已完成': 'done', '达成': 'done', '已达成': 'done' }),
  issueStatus: buildReverse(LABELS.issueStatus, { '未开始': 'pending', '待处理': 'pending', '处理中': 'processing', '跟进中': 'processing', '已解决': 'resolved', '已闭环': 'resolved', '已关闭': 'closed', '已结案': 'closed' }),
  riskType: buildReverse(LABELS.riskType, { '人力风险': 'resource', '资源风险': 'resource', '进度风险': 'schedule', '质量风险': 'quality', '市场风险': 'market', '技术风险': 'tech', '其他风险': 'other' }),
  riskStatus: buildReverse(LABELS.riskStatus, { '已发生': 'occurring', '发生中': 'occurring', '跟进中': 'watching', '监控中': 'watching', '跟踪中': 'watching', '未评估': 'watching', '已缓解': 'mitigated', '已关闭': 'closed', '已收口': 'closed' }),
  resKind: buildReverse(LABELS.resKind, { '团队': 'team', '个人': 'person', '部门': 'team' }),
  memberRole: buildReverse(LABELS.memberRole, { '产品经理': 'pm', '项目经理': 'pjm', '项目专员': 'specialist', '系统经理': 'se', 'SE': 'se', '研发': 'dev', '测试': 'test', 'UX/UI': 'ux', '运维': 'ops' }),
  refStage: buildReverse(LABELS.refStage, { 'TR2': 'TR2', 'TR3': 'TR3', 'TR4': 'TR4', 'TR5': 'TR5' }),
  refDocStatus: buildReverse(LABELS.refDocStatus, { '待提交': 'pending', '已提交': 'submitted', '评审中': 'reviewing', '已通过': 'passed', '不适用': 'na' })
};

/* ---------- 表头同义词 ----------
   平台字段 → 钉钉表里可能出现的列名。别名按「实测出现过」+「常见写法」列，
   不追求穷举；准确率靠 matchColumn 的打分，不靠枚举命中。 */
const SYNONYMS = {
  overview: {
    name: ['任务名称', '阶段名称', '阶段', '名称', '任务', '工作内容', '事项', '项目阶段'],
    owner: ['负责人', '责任人', '执行人', '主责人', 'owner', '负责人员'],
    startDate: ['计划开始时间', '开始时间', '计划开始', '起始日期', '开始日期', 'start'],
    endDate: ['计划完成时间', '完成时间', '计划结束时间', '结束时间', '截止日期', '计划结束', 'end'],
    status: ['状态', '当前状态', '进展', 'status', '执行状态'],
    progress: ['进度%', '进度', '完成度', '完成率', 'progress'],
    deliverable: ['交付产物', '交付物名称', '交付物', '输出物', '交付清单', '关联文档'],
    note: ['相关信息1', '备注', '说明', '其他']
  },
  tasks: {
    name: ['能力名称', '任务名称', '任务', '名称', '工作内容', '工作项'],
    owner: ['负责人', '责任人', '执行人', '主责人', 'owner', '负责人员'],
    dept: ['主责部门', '负责部门', '部门', '责任部门', '承接部门'],
    status: ['需求状态', '状态', '当前状态', '进展', 'status', '执行状态'],
    progress: ['进度%', '进度', '完成度', '完成率', 'progress'],
    plannedHours: ['计划工时（人天）', '计划工时', '人天', '工时', '工作量', '预计工时'],
    startDate: ['计划开始时间', '开始时间', '计划开始', '开始日期', '起始日期'],
    endDate: ['计划完成时间', '计划结束时间', '结束时间', '完成时间', '截止日期'],
    type: ['能力类型', '任务类型', '类型', '工作类型'],
    priority: ['优先级', '需求优先级', '重要程度'],
    dept2: ['参与部门', '协同部门'],
    note: ['备注', '说明', '备注说明'],
    phase: ['工作域', '所属阶段'],
    module: ['工作模块', '模块'],
    se: ['SE负责人', 'SE', '系统经理'],
    desc: ['能力描述', '任务描述', '描述', '说明']
  },
  marketPlan: {
    name: ['任务', '任务名称', '阶段', '阶段名称', '名称', '事项'],
    startDate: ['计划开始时间', '开始时间', '计划开始', '开始日期'],
    endDate: ['计划结束时间', '计划完成时间', '结束时间', '完成时间'],
    owner: ['任务执行人', '负责人', '责任人', '执行人'],
    status: ['状态', '当前状态', '进展'],
    note: ['备注', '说明']
  },
  milestones: {
    name: ['里程碑', '里程碑名称', '任务名称', '名称', '节点', '里程碑节点'],
    date: ['里程碑日期', '目标日期', '日期', '计划完成日期', '计划完成时间', '完成时间'],
    status: ['状态', '当前状态', '进展'],
    owner: ['负责人', '责任人', '执行人'],
    desc: ['说明', '描述', '备注', '交付需求范围']
  },
  issues: {
    code: ['问题编号', '编号', '序号，编号', 'ID'],
    desc: ['遗留问题描述', '问题描述', '问题', '描述', '遗留问题'],
    solution: ['应对方案', '解决方案', '处理方案', '措施', '应对措施'],
    owner: ['责任人', '负责人', '处理人'],
    dueDate: ['预计闭环时间', '计划闭环时间', '闭环时间', '截止时间', '解决期限'],
    progress: ['当前进展', '进展', '进展状态'],
    conclusion: ['结论', '处理结论', '闭环结论'],
    status: ['当前状态', '状态', '问题状态']
  },
  risks: {
    type: ['风险类型', '类型', '风险分类'],
    desc: ['风险描述', '描述', '风险', '风险内容'],
    solution: ['应对方案', '应对措施', '解决方案', '缓解措施'],
    owner: ['责任人', '负责人', '风险责任人'],
    dueDate: ['计划闭环时间', '预计闭环时间', '闭环时间', '截止时间'],
    status: ['风险状态', '状态', '风险等级'],
    progress: ['进展状态', '进展', '当前进展']
  },
  resources: {
    name: ['部门团队', '资源', '部门', '资源名称', '团队', '团队名称'],
    kind: ['类型', '资源类型', '类别'],
    dept: ['部门', '所属部门'],
    total: ['总容量(人天)', '总容量', '资源需求（人月）', '资源需求', '人天', '容量']
  },
  members: {
    name: ['项目代表', '姓名', '成员', '人员', '名字'],
    role: ['角色', '项目角色', '职能'],
    dept: ['部门/团队', '部门', '团队', '所属部门'],
    duty: ['职责分工', '职责', '分工', '负责内容'],
    contact: ['联系方式', '电话', '邮箱', '联系']
  },
  references: {
    title: ['文档名称', '交付产物', '参考文档', '名称', '交付物', '文档'],
    link: ['链接地址', '模板链接', '链接', '地址', 'URL'],
    owner: ['责任人', '提交人员', '负责人', '递交人'],
    date: ['归档时间', '提交日期', '日期', '归档日期'],
    dept: ['责任部门(人)', '责任部门', '提交部门'],
    stage: ['评审阶段', '阶段', 'TR阶段'],
    status: ['提交状态', '状态', '归档状态'],
    requirement: ['评审要求', '要求'],
    reviewer: ['评审人员', '评审人']
  }
};

/* 表单 → 在钉钉表里的推荐 sheet 名（仅用于给用户提示，实际靠表头打分匹配） */
const FORM_TITLE = {
  basic: '基本信息', overview: '项目总览', milestones: '里程碑', tasks: 'WBS任务',
  marketPlan: '上市计划', issues: '遗留问题', risks: '项目风险',
  resources: '资源', members: '团队成员', references: '参考文档'
};

/* 表单 → sheet 名里的判别词。表名叫「里程碑表」「项目风险」时，
   归属已经不言自明，不必再靠表头猜；这是最硬的一个信号。
   只取业务特征词，不放「表」「计划」这类通用后缀，避免误伤。 */
const SHEET_NAME_HINTS = {
  milestones: ['里程碑', 'milestone'],
  marketPlan: ['上市计划', '上市', '发布计划', '上市策略'],
  references: ['参考文档', '交付件', '文档清单', '项目文档', '参考资料'],
  risks: ['项目风险', '风险台账', '风险清单', '风险登记'],
  issues: ['遗留问题', '问题清单', '问题跟踪', '遗留事项'],
  members: ['团队成员', '项目成员', '成员清单', '团队名单'],
  resources: ['资源需求', '资源清单', '资源计划', '资源投入'],
  tasks: ['工作分解', 'WBS', '任务分解', '执行计划', '任务清单'],
  overview: ['项目总览', '总览', '项目概览'],
  basic: ['基本信息']
};

/* 分级建树用的父列别名（钉钉多维表导出固定叫 Parent Record） */
const PARENT_COLS = ['ParentRecord', '上级', '上级任务', '父任务', '父级', '所属阶段', '所属父级', '上级能力', 'ParentID'];

/* ============================================================
   一、基础工具
   ============================================================ */

/* 单元格取值，统一成字符串。数字/日期/布尔都转成可读文本。 */
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return fmtDate(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).replace(/\r\n/g, '\n').trim();
}

/* 日期归一：钉钉导出实测是 'YYYY-MM-DD' 文本，但可能是 'YYYY/M/D'、'2026年9月1日' 或 Excel 日期序列号 */
function parseDate(v) {
  const s = cellText(v);
  if (!s) return '';
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return pad4(m[1]) + '-' + pad2(m[2]) + '-' + pad2(m[3]);
  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s);
  if (m) return pad4(m[1]) + '-' + pad2(m[2]) + '-' + pad2(m[3]);
  m = /^(\d{4})[-/.](\d{1,2})月?$/.exec(s);
  if (m) return pad4(m[1]) + '-' + pad2(m[2]) + '-01';
  if (v instanceof Date) return fmtDate(v);
  // Excel 日期序列号（1900 起算）
  if (typeof v === 'number' && v > 20000 && v < 60000) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return fmtDate(d);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : fmtDate(d);
}
function pad2(n) { return String(Number(n)).padStart(2, '0'); }
function pad4(n) { return String(n).padStart(4, '0'); }
function fmtDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* 进度归一：'37%' / '37' / '0.37' → 37（整数 0-100）。认不出返回 null。 */
function parseProgress(v) {
  const s = cellText(v);
  if (!s) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*%?$/.exec(s);
  if (!m) return null;
  let n = Number(m[1]);
  if (!isFinite(n)) return null;
  if (!/%/.test(s) && n > 0 && n <= 1) n = n * 100;   // 0.37 → 37
  n = Math.round(n);
  if (n < 0 || n > 100) return null;
  return n;
}

/* 工时归一：'1.0' / '13.00' → 13。认不出返回 null。 */
function parseNumber(v) {
  const s = cellText(v);
  if (!s) return null;
  const n = Number(s.replace(/[,\s人天月]/g, ''));
  return isFinite(n) ? n : null;
}

/* 表头归一化：去空白、全角括号转半角、去冒号。用于同义词比对。 */
function normKey(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, '')
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/[：:]/g, '')
    .replace(/[％%]/g, '%');
}

/* 表头里这些词出现即降权：命中「需求状态」不该顶掉真正的「状态」。
   真实来源里踩过：需求状态 / 目标用户 / 预计上线时间 / 能力层级。 */
const QUALIFIER_RE = /(需求|目标|预期|预计|预估|计划外|历史|参考|对比|备注性|附属)/;

/* 在表头数组里为某个平台字段找最合适的列。返回 { idx, score, header } 或 null。
   打分规则（这是导入准确率的核心，实测调过）：
     单字段名 vs 表头完全相等 → 100（「任务」「状态」这种短表头必须靠精确命中）
     多字别名 vs 表头完全相等 →  95
     表头包含别名 / 别名包含表头 → 60（「计划开始时间」命中别名「开始时间」）
     含限定词（需求状态 / 目标用户…）→ 减 40，保证真·「状态」列胜出
   同分时取列号更小的，避免右侧的重复列抢走左侧主列。 */
function qualifiersOf(h) {
  const m = QUALIFIER_RE.exec(h);
  return m ? m[1] : '';
}
function matchColumn(headers, aliases) {
  let best = null;
  for (let c = 0; c < headers.length; c++) {
    const h = normKey(headers[c]);
    if (!h) continue;
    const q = qualifiersOf(h) ? 40 : 0;
    for (const a of aliases) {
      const na = normKey(a);
      let score = 0;
      if (h === na) score = (na.length <= 2 ? 100 : 95);
      else if (h.length >= 2 && na.length >= 2 && (h.includes(na) || na.includes(h))) score = 60;
      // 单字别名的包含匹配必须要求「更长的那边确实更长」。
      // 反例：「备注」因为共用「期」这个字蹭上了 references.date 的别名「期」，
      // 让一份无关表判别分凑到 2、被判成强匹配。单字只在完全相等时才算数。
      if (score === 60 && Math.min(h.length, na.length) < 2) score = 0;
      if (score) score -= q;
      if (score > 0 && (!best || score > best.score)) best = { idx: c, score: score, header: headers[c] };
    }
  }
  return best;
}

/* 辅助列（Parent Record / 层级 / 序号 / ID 尾列）不算「未映射」，它们另有用途 */
const AUX_HEADERS = ['parentrecord', 'parentid', '层级', '序号', '#', 'id', '工作域', '工作模块', '相关记录'];
function isAuxHeader(normed) {
  return AUX_HEADERS.some(a => normed === normKey(a));
}

/* 平台不消费、但按「保留原始行文本」原则不该报丢弃的列。
   这类列的值会原样追加到 note（不丢信息，也不污染结构化字段）。 */
const NOTE_PASSTHROUGH = {};

/* 给一张表的所有列打分，返回 { mapping, unmatchedHeaders, matchedCount, extraCols } */
function matchSheet(headers, form, extraCols) {
  const syn = SYNONYMS[form] || {};
  const extra = (extraCols || NOTE_PASSTHROUGH[form] || []).map(normKey);
  const mapping = {};      // 平台字段 → 列下标
  const usedCols = {};     // 列下标 → 平台字段（一列只能映射一次）
  const candidates = [];
  Object.keys(syn).forEach(field => {
    const hit = matchColumn(headers, syn[field]);
    if (hit) candidates.push({ field: field, hit: hit });
  });
  /* 命中分高的先占位，避免「计划完成时间」既想当 startDate 又想当 endDate 时抢错 */
  candidates.sort((a, b) => (b.hit.score - a.hit.score) || (a.hit.idx - b.hit.idx));
  candidates.forEach(c => {
    if (usedCols[c.hit.idx] != null) return;
    mapping[c.field] = c.hit.idx;
    usedCols[c.hit.idx] = c.field;
  });
  /* 未映射列：排除辅助列与「已指定为 note 透传」的列 */
  const unmatchedHeaders = [];
  const passthrough = [];
  headers.forEach((h, i) => {
    const n = normKey(h);
    if (!n || usedCols[i] != null || isAuxHeader(n)) return;
    if (extra.indexOf(n) >= 0) { passthrough.push(i); return; }
    unmatchedHeaders.push(h);
  });
  return {
    mapping: mapping, passthrough: passthrough,
    unmatchedHeaders: unmatchedHeaders, matchedCount: Object.keys(mapping).length
  };
}

/* ---------- 表单判别 ----------
   分配 sheet 是个「一对一匹配」问题：一张 sheet 只能喂给一个表单。实测踩过两轮坑：
     1) 纯按命中列数 → 「上市计划」抢走「项目总览」（前者有真正的 状态/执行人 列）
     2) 每个表单各自挑最优 → 「团队分工与执行计划」同时被 WBS任务 和 上市计划 认领，
        「资源需求」被忽略，结果资源表凭空多出 447 条
   所以规则是：
     a) 判别分（该表单独有字段的命中数）优先，通用字段（名称/负责人/日期）不计分
     b) 全局按 (判别分, 命中数, 非空数) 排序，贪心分配；表单和 sheet 互相唯一
     c) 判别分为 0 的组合直接排除 —— 没有判别列的匹配纯属巧合
   FORM_DISCRIMINATORS 里刻意不含 name/owner/日期，否则所有表判别分相同、失去区分度。 */
const FORM_DISCRIMINATORS = {
  milestones: ['date', 'desc', 'status'],
  issues: ['code', 'desc', 'solution', 'progress', 'conclusion'],
  risks: ['type', 'solution', 'progress'],
  members: ['role', 'duty', 'contact'],
  references: ['title', 'link', 'date', 'dept', 'stage', 'status', 'requirement', 'reviewer'],
  resources: ['kind', 'total'],
  marketPlan: ['note', 'status', 'startDate', 'endDate'],
  tasks: ['type', 'dept', 'plannedHours', 'phase', 'module', 'se', 'dept2'],
  overview: ['deliverable', 'note', 'progress']
};

/* 表名里带这些词的，说明是钉钉侧的草稿 / 已废弃 / 备份表，不参与分配（用户明确要求跳过） */
const SHEET_EXCLUDE_RE = /(废弃|草稿|备份|归档|历史版本|旧版|无效)/;

function isExcludedSheet(name) {
  return SHEET_EXCLUDE_RE.test(cellText(name));
}

function discriminativeScore(mapping, form) {
  const d = FORM_DISCRIMINATORS[form] || [];
  return d.reduce((n, f) => n + (mapping[f] != null ? 1 : 0), 0);
}

/* ---------- 判别列的「排他性」 ----------
   最初的判别分是「命中几个判别列」，实测不够：一份无关的《应收账款》表
   （客户名称/负责人/回款状态/备注）恰好命中 milestones 的 desc + status，
   判别分 2 → 被判成「强匹配」，整表静默变成里程碑。

   问题在于判别列本身也分强弱：
     · date / code / kind / total / plannedHours —— 几乎只有一个表单会用到，命中即强证据
     · status / note / progress / startDate      —— 好东西，但五六个表单都在用，单靠它说明不了什么
   所以按「该字段出现在几个表单的判别列里」给权重，1 个表单独占的才真正算数。 */
const FIELD_EXCLUSIVITY = (function () {
  const count = {};      // 字段 → 出现在几个表单的判别列中
  Object.keys(FORM_DISCRIMINATORS).forEach(form => {
    const seen = {};
    FORM_DISCRIMINATORS[form].forEach(f => {
      if (seen[f]) return;
      seen[f] = true;
      count[f] = (count[f] || 0) + 1;
    });
  });
  return count;          // 1 = 独占（强），越大越泛滥
})();

/* 字段权重：独占字段记 2 分，共享字段记 1 分。
   2 个独占字段 = 4 分（强），1 个独占字段 = 2 分（强），
   纯共享字段最多 1~2 分（中/弱），杜绝「两个通用列凑出强匹配」。 */
function discriminativeWeight(mapping, form) {
  const d = FORM_DISCRIMINATORS[form] || [];
  let w = 0;
  d.forEach(f => {
    if (mapping[f] == null) return;
    w += (FIELD_EXCLUSIVITY[f] || 1) === 1 ? 2 : 1;
  });
  return w;
}

/* 命中列里独占字段的个数（强降级判定要用） */
function exclusiveHits(mapping, form) {
  const d = FORM_DISCRIMINATORS[form] || [];
  return d.reduce((n, f) => n + (mapping[f] != null && (FIELD_EXCLUSIVITY[f] || 1) === 1 ? 1 : 0), 0);
}

/* 对每个表单 × 每张 sheet 算出候选分数 */
function buildAssignments(candidates) {
  const pairs = [];
  Object.keys(FORM_TITLE).forEach(form => {
    if (form === 'basic') return;
    candidates.forEach(c => {
      const headers = (c.aoa[c.best.headerRow] || []).map(cellText);
      const m = matchSheet(headers, form);
      const conf = confidenceOf(headers, form, m.mapping, c.name);
      // 一个字段都对不上就没什么好说的；纯通用列的匹配仍留着交给分档裁决。
      if (m.matchedCount < 2) return;
      pairs.push({
        form: form, sheet: c.name, aoa: c.aoa, headerRow: c.best.headerRow,
        matched: m.matchedCount, mapping: m.mapping, unmatched: m.unmatchedHeaders,
        disc: conf.disc, score: conf.score, exHits: conf.exHits, exactEx: conf.exactEx,
        ratio: conf.ratio, nameHint: conf.nameHint,
        tier: conf.tier, nonEmpty: c.best.nonEmpty
      });
    });
  });
  // 证据强的先占位；这样弱匹配不会抢走强匹配的表
  pairs.sort((a, b) => (b.nameHint ? 1 : 0) - (a.nameHint ? 1 : 0) || (b.score - a.score) ||
                       (b.nonEmpty - a.nonEmpty) ||
                       (b.exHits - a.exHits) || (b.exactEx - a.exactEx) || (b.disc - a.disc) ||
                       (b.matched - a.matched));
  return pairs;
}

/* 一个 sheet × 一个表单 的匹配置信度。三类信号，命中数决定档位：

     0) 表名信号：表名里含该表单的判别词（「里程碑」→ 里程碑表）。命中直接 strong，
        因为这是人工起的名字，比任何表头推断都可靠。
     1) 独占列：这一列的存在就排除其他表单（「问题编号」只能是遗留问题）
     2) 精确业务词：表头**就是**别名本身（「能力名称」），而不是「客户名称」蹭上
        通用别名「名称」——且只有 gap>0 的列才算，否则通用列「状态」会白送分
     3) 判别列覆盖：命中的业务列占映射列的比例（两列全中 vs 二十列中两列）

   档位：0) 命中 → strong；1/2/3 命中 ≥2 → strong，命中 1 → medium，全不中 → low。

   实测校准：
     团队分工与执行计划(表名含「执行计划」) strong｜项目总览 strong｜参考文档 strong｜资源需求 strong
     团队项目成员 strong｜项目风险 strong｜遗留问题 strong｜上市计划（表名带「上市计划」）strong
     弱成员表(姓名/角色) medium｜无关的《应收账款》 low（「客户名称」蹭 title，无独占列、无精确词）
   前几版踩过的坑：
     按「命中几个判别列」算 → 应收账款蹭 2 列变强匹配；
     按「是不是独占字段」算 → 风险表的 type/solution/desc 全是共享字段，永远够不着强匹配；
     纯靠 leadRatio 阈值 → 里程碑表(ratio 0.19, exLead 1)被压成 low 而漏掉，
       且「客户名称」的子串命中会把无关表顶到 medium。 */
function confidenceOf(headers, form, mapping, sheetName) {
  const forms = Object.keys(FORM_TITLE).filter(f => f !== 'basic');
  const fields = Object.keys(mapping);
  let exLead = 0, exactEx = 0, lead = 0, total = 0;
  fields.forEach(field => {
    const h = normKey(headers[mapping[field]]);
    if (!h || h.length < 2) return;
    const per = forms.map(f => {
      const hit = matchColumn([headers[mapping[field]]], (SYNONYMS[f] || {})[field] || []);
      return hit ? hit.score : 0;
    }).sort((a, b) => b - a);
    const gap = Math.max(0, per[0] - (per[1] || 0));
    lead += gap; total += per[0];
    if (gap <= 0) return;
    // 排他性领先：这一列明确属于本表单
    if ((FIELD_EXCLUSIVITY[field] || 1) === 1) exLead++;
    // 精确命中业务词（表头就是别名本身），且这一列确实领先
    if (exactSynonymHit(form, field, h)) exactEx++;
  });
  const leadRatio = total > 0 ? lead / total : 0;
  const exShare = fields.length ? exLead / fields.length : 0;

  const nameHint = sheetNameHint(sheetName, form);
  /* 信号 0（表名）之外的三个信号都只在前两个满足时才计分：
     「状态」这种通用列谁都有，光靠一列独占就自动归属，
     会让「应收账款」这类无关表被静默绑成参考文档。 */
  let score = 0;
  if (exLead >= 2) score++;                       // 信号 1：独占列
  if (exLead >= 2 && exactEx >= 1) score++;       // 信号 2：精确业务词
  if (exLead >= 2 && (exShare >= 0.30 || exactEx >= 3)) score++;   // 信号 3：判别列覆盖

  let tier;
  if (nameHint) tier = 'strong';                  // 信号 0：表名说了算
  else if (score >= 2) tier = 'strong';
  else if (score >= 1) tier = 'medium';
  else tier = 'low';

  return {
    tier: tier, score: score, nameHint: !!nameHint,
    ratio: Math.round(leadRatio * 100) / 100,
    exHits: exLead, exactEx: exactEx,
    disc: (FORM_DISCRIMINATORS[form] || []).filter(f => mapping[f] != null).length
  };
}

/* 表名是否命中该表单的判别词。不做模糊匹配——表名是人写的，宁可漏判也不要误判。 */
function sheetNameHint(sheetName, form) {
  const n = normKey(sheetName);
  if (!n) return null;
  const hints = SHEET_NAME_HINTS[form] || [];
  for (let i = 0; i < hints.length; i++) {
    if (n.indexOf(normKey(hints[i])) >= 0) return hints[i];
  }
  /* 表名即表单全称（「里程碑」表直接叫「里程碑」） */
  const title = normKey(FORM_TITLE[form]);
  if (title && n.indexOf(title) >= 0) return FORM_TITLE[form];
  return null;
}

/* 表头是否**精确**等于该表单该字段的某个别名（不是子串蹭上的）。
   子串命中（「客户名称」vs「名称」）不算，避免无关表白送分。 */
function exactSynonymHit(form, field, normHeader) {
  const aliases = (SYNONYMS[form] || {})[field] || [];
  for (let i = 0; i < aliases.length; i++) {
    if (normKey(aliases[i]) === normHeader) return true;
  }
  return false;
}

const TIER_LABEL = { strong: '强匹配', medium: '中等', low: '弱匹配（疑似）' };

/* 手动指定归属：把 sheet 强行绑到某个表单。
   自动匹配再准也有失手的时候（无关文件蹭上通用列、关键列名古怪），
   所以预览页必须留一个「这张表当 X 导」的开关，且它是唯一能救回 low 档表的途径。 */
function applySheetOverrides(taken, usedSheets, candidates, overrides) {
  if (!overrides) return;
  Object.keys(overrides).forEach(sheetName => {
    const form = overrides[sheetName];
    const c = candidates.find(x => x.name === sheetName);
    if (!c) return;
    // 先解除这张 sheet 原来占的表单，以及目标表单原来的 sheet
    Object.keys(taken).forEach(f => { if (taken[f] && taken[f].sheet === sheetName) delete taken[f]; });
    if (taken[form]) { const old = taken[form].sheet; delete usedSheets[old]; delete taken[form]; }
    if (!form) { delete usedSheets[sheetName]; return; }        // 显式取消
    const headers = (c.aoa[c.headerRow] || []).map(cellText);
    const m = matchSheet(headers, form);
    const conf = confidenceOf(headers, form, m.mapping, sheetName);
    const p = {
      form: form, sheet: sheetName, aoa: c.aoa, headerRow: c.headerRow,
      matched: m.matchedCount, mapping: m.mapping, unmatched: m.unmatchedHeaders,
      disc: conf.disc, weight: conf.score, score: conf.score, exHits: conf.exHits,
      ratio: conf.ratio, nameHint: conf.nameHint, tier: conf.tier,
      nonEmpty: c.best.nonEmpty, manual: true
    };
    taken[form] = p;
    usedSheets[sheetName] = p;
  });
}

/* 贪心一对一分配，返回 { byForm, bySheet }
   low 档排在最后：只有在没有更强档位认领该表单时才能补位，
   避免一张只蹭到通用列的无关表把本该空的表单占掉。 */
function assignForms(candidates) {
  const pairs = buildAssignments(candidates);
  const byForm = {}, bySheet = {};
  // low 档不自动占位：无关文件的表头蹭上两三个通用列就能凑出「2 列匹配」，
  // 静默变成里程碑/成员表比不导入更糟。它只作为「手动指定」的建议留在 pairs 里。
  pairs.forEach(p => {
    if (p.tier === 'low') return;
    if (byForm[p.form] || bySheet[p.sheet]) return;
    byForm[p.form] = p;
    bySheet[p.sheet] = p;
  });
  return { byForm: byForm, bySheet: bySheet, pairs: pairs };
}

/* 找表头行：前 5 行里，非空单元格最多、且能匹配到平台字段的那一行。
   form 传 null 时对所有表单取最高分——给「先定位表头、再决定归属」用。 */
function findHeaderRow(aoa, form) {
  const forms = form ? [form] : Object.keys(FORM_TITLE).filter(f => f !== 'basic');
  let best = { row: 0, score: -1, matched: 0, nonEmpty: 0, form: form || null };
  for (let r = 0; r < Math.min(aoa.length, 5); r++) {
    const row = aoa[r] || [];
    const nonEmpty = row.filter(c => cellText(c)).length;
    if (nonEmpty < 2) continue;
    forms.forEach(f => {
      const m = matchSheet(row.map(cellText), f);
      const score = m.matchedCount * 10 + nonEmpty;
      if (score > best.score) best = { row: r, score: score, matched: m.matchedCount, nonEmpty: nonEmpty, form: f };
    });
  }
  return best;
}

/* 读一个 sheet 成二维数组（字符串化），并裁掉尾部全空行 */
function sheetToAoa(ws, XLSX) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: true });
  while (aoa.length && (aoa[aoa.length - 1] || []).every(c => !cellText(c))) aoa.pop();
  return aoa;
}

/* 行是否为空（除父列外全空则视为空行） */
function isEmptyRow(row, mapping) {
  return !Object.keys(mapping).some(f => cellText(row[mapping[f]]));
}

/* 「节点名」字段：用来判空行、做父子挂靠。注意遗留问题 / 项目风险这两张表单
   平台上根本没有 name 字段，之前写死 'name' 导致 mapping.name 为 undefined，
   整张表的行被 continue 掉——这就是「11 行数据导入 0 行」的根因。 */
const NAME_FIELD_CANDIDATES = {
  references: ['title', 'name'],
  issues: ['code', 'name', 'desc'],
  risks: ['type', 'name', 'desc'],
  resources: ['name', 'dept'],
  members: ['name', 'contact'],
  milestones: ['name'],
  marketPlan: ['name'],
  tasks: ['name', 'wbsCode'],
  overview: ['name']
};

function pickNameField(form, mapping) {
  const list = NAME_FIELD_CANDIDATES[form] || ['name'];
  for (const f of list) if (mapping[f] != null) return f;
  return null;   // 该表没有任何可作节点名的列 → 退化为纯平表导入
}

/* 从原始行取某平台字段的文本 */
function rowVal(row, mapping, field) {
  return mapping[field] == null ? '' : cellText(row[mapping[field]]);
}

/* ============================================================
   二、分层建树（对一张表的所有行做，不是对单个父名字做）
   ============================================================ */
function buildHierarchy(rows, mapping, nameField) {
  const diag = { dangling: [], selfRef: [], cycle: [], ambiguous: [] };
  // 同名计数：>1 就要在预览页提示「父行靠名字匹配，存在歧义」
  const byName = {};      // 名字 → [行下标…]，按出现顺序
  rows.forEach((r, i) => {
    r.name = rowVal(r.raw, mapping, nameField);
    r.parentRow = -1;
    if (r.name) (byName[r.name] = byName[r.name] || []).push(i);
  });

  const claimed = {};     // 名字 → 已被当作父名认领过的行下标集合
  rows.forEach((r, i) => {
    const pn = r.parentName;
    if (!pn) return;
    if (pn === r.name) { diag.selfRef.push({ row: r.rowNo, name: pn, parentName: pn }); return; }
    const cands = byName[pn] || [];
    if (!cands.length) { diag.dangling.push({ row: r.rowNo, name: r.name, parentName: pn }); return; }
    claimed[pn] = claimed[pn] || {};
    // 取「在上方、最近、且未被占用」的那个；都被占用则退而取最近的上方那个
    let pick = -1;
    for (let k = cands.length - 1; k >= 0; k--) {
      if (cands[k] < i) { if (pick < 0) pick = cands[k]; if (!claimed[pn][cands[k]]) { pick = cands[k]; break; } }
    }
    if (pick < 0) { diag.dangling.push({ row: r.rowNo, name: r.name, parentName: pn }); return; }
    claimed[pn][pick] = true;
    r.parentRow = pick;
    if (cands.length > 1 && !diag.ambiguous.some(x => x.parentName === pn)) {
      diag.ambiguous.push({ row: r.rowNo, name: r.name, parentName: pn, candidates: cands.length });
    }
  });

  // 成环检测：沿 parentRow 往上走，超过行数必成环
  rows.forEach(r => {
    let steps = 0, cur = r.parentRow;
    while (cur >= 0 && steps <= rows.length) { cur = rows[cur].parentRow; steps++; }
    if (steps > rows.length) { r.parentRow = -1; diag.cycle.push({ row: r.rowNo, name: r.name }); }
  });

  // 深度计算（供预览显示）
  rows.forEach(r => { r.depth = depthOf(rows, r); });
  return diag;
}

/* 沿 parentRow 上溯算深度（预览页按深度缩进显示） */
function depthOf(rows, r) {
  let d = 0, cur = r.parentRow, guard = 0;
  while (cur >= 0 && guard++ < 200) { d++; cur = rows[cur].parentRow; }
  return d;
}

/* ============================================================
   三、字段转换（钉钉一行 → 平台一条表单记录）
   不猜的东西：状态（无来源时留空）、层级（靠 parentRow）
   ============================================================ */
function idGen(prefix) {
  let n = 0;
  const next = () => prefix + '-' + Date.now().toString(36) + (++n).toString(36) + Math.random().toString(36).slice(2, 5);
  /* 平台导出的记录带 _id：优先沿用，保证「导出 → 改一改 → 导回」时
     记录身份不变（对应关系、外部关联都挂在这个 id 上，换掉就等于全丢）。
     没有 _id（钉钉表格、异源表格）才现生成。 */
  next.prefer = srcId => srcId || next();
  return next;
}

/* 从进度推状态：只认两端（0=未开始，100=已完成）。中间态没有可靠信号，留 null。 */
function statusFromProgress(p) {
  if (p === 0) return 'not-started';
  if (p === 100) return 'completed';
  return null;
}

function convertOverview(rows, mapping, genId) {
  return rows.map(r => {
    const progress = parseProgress(rowVal(r.raw, mapping, 'progress'));
    let status = FROM_LABEL.taskStatus[normLabel(rowVal(r.raw, mapping, 'status'))] || null;
    if (!status) status = statusFromProgress(progress);
    return {
      id: genId('ov'),
      parentId: '',
      _parentRow: r.parentRow,
      _rowNo: r.rowNo,
      name: rowVal(r.raw, mapping, 'name'),
      owner: rowVal(r.raw, mapping, 'owner'),
      startDate: parseDate(rowVal(r.raw, mapping, 'startDate')),
      endDate: parseDate(rowVal(r.raw, mapping, 'endDate')),
      status: status || 'not-started',
      progress: progress == null ? 0 : progress,
      deliverable: rowVal(r.raw, mapping, 'deliverable'),
      note: rowVal(r.raw, mapping, 'note')
    };
  });
}

/* WBS 任务。钉钉「团队分工与执行计划」是能力拆解表，利用率最高的一张。
   平台没有的列（参与部门/SE负责人/工作域/目标用户…）按约定直接丢弃，不硬塞。 */
function convertTasks(rows, mapping, genId) {
  return rows.map(r => {
    const progress = parseProgress(rowVal(r.raw, mapping, 'progress'));
    let status = FROM_LABEL.taskStatus[normLabel(rowVal(r.raw, mapping, 'status'))] || null;
    if (!status) status = statusFromProgress(progress);
    const hours = parseNumber(rowVal(r.raw, mapping, 'plannedHours'));
    return {
      id: genId('t'),
      parentId: '',
      _parentRow: r.parentRow,
      _rowNo: r.rowNo,
      wbsCode: '',
      name: rowVal(r.raw, mapping, 'name'),
      type: FROM_LABEL.taskType[normLabel(rowVal(r.raw, mapping, 'type'))] || 'dev',
      status: status || 'not-started',
      priority: FROM_LABEL.priority[normLabel(rowVal(r.raw, mapping, 'priority'))] || 'medium',
      progress: progress == null ? 0 : progress,
      plannedHours: hours == null ? '' : hours,
      owner: rowVal(r.raw, mapping, 'owner'),
      dept: rowVal(r.raw, mapping, 'dept'),
      startDate: parseDate(rowVal(r.raw, mapping, 'startDate')),
      endDate: parseDate(rowVal(r.raw, mapping, 'endDate')),
      dependencies: [],
      note: rowVal(r.raw, mapping, 'note')
    };
  });
}

function convertTreeForm(rows, mapping, genId, key, nameField) {
  return rows.map(r => {
    const progress = parseProgress(rowVal(r.raw, mapping, 'progress'));
    let status = FROM_LABEL.taskStatus[normLabel(rowVal(r.raw, mapping, 'status'))] || null;
    if (!status) status = statusFromProgress(progress);
    const o = { id: genId(key), parentId: '', _parentRow: r.parentRow, _rowNo: r.rowNo };
    o[nameField] = rowVal(r.raw, mapping, nameField);
    o.startDate = parseDate(rowVal(r.raw, mapping, 'startDate'));
    o.endDate = parseDate(rowVal(r.raw, mapping, 'endDate'));
    o.owner = rowVal(r.raw, mapping, 'owner');
    o.status = status || 'not-started';
    o.note = rowVal(r.raw, mapping, 'note');
    return o;
  });
}

function convertMilestones(rows, mapping, genId) {
  return rows.map(r => ({
    id: genId('ms'),
    _rowNo: r.rowNo,
    name: rowVal(r.raw, mapping, 'name'),
    date: parseDate(rowVal(r.raw, mapping, 'date')),
    status: FROM_LABEL.milestoneStatus[normLabel(rowVal(r.raw, mapping, 'status'))] || 'pending',
    owner: rowVal(r.raw, mapping, 'owner'),
    desc: [rowVal(r.raw, mapping, 'desc'), rowVal(r.raw, mapping, 'deliverable')].filter(Boolean).join('\n')
  }));
}

function convertIssues(rows, mapping, genId) {
  return rows.map(r => ({
    id: genId('is'),
    _rowNo: r.rowNo,
    code: rowVal(r.raw, mapping, 'code'),
    desc: rowVal(r.raw, mapping, 'desc'),
    solution: rowVal(r.raw, mapping, 'solution'),
    owner: rowVal(r.raw, mapping, 'owner'),
    dueDate: parseDate(rowVal(r.raw, mapping, 'dueDate')),
    progress: rowVal(r.raw, mapping, 'progress'),
    conclusion: rowVal(r.raw, mapping, 'conclusion'),
    status: FROM_LABEL.issueStatus[normLabel(rowVal(r.raw, mapping, 'status'))] || 'pending'
  }));
}

function convertRisks(rows, mapping, genId) {
  return rows.map(r => ({
    id: genId('rk'),
    _rowNo: r.rowNo,
    type: FROM_LABEL.riskType[normLabel(rowVal(r.raw, mapping, 'type'))] || 'other',
    desc: rowVal(r.raw, mapping, 'desc'),
    solution: rowVal(r.raw, mapping, 'solution'),
    owner: rowVal(r.raw, mapping, 'owner'),
    dueDate: parseDate(rowVal(r.raw, mapping, 'dueDate')),
    status: FROM_LABEL.riskStatus[normLabel(rowVal(r.raw, mapping, 'status'))] || 'watching',
    progress: rowVal(r.raw, mapping, 'progress')
  }));
}

/* 资源：钉钉「资源需求」用人月，平台用总容量(人天)。默认 ×21（可在预览页关掉）。 */
const HOURS_PER_MONTH = 21;
function convertResources(rows, mapping, genId, monthToDay) {
  return rows.map(r => {
    const n = parseNumber(rowVal(r.raw, mapping, 'total'));
    return {
      id: genId('rs'),
      _rowNo: r.rowNo,
      name: rowVal(r.raw, mapping, 'name'),
      kind: FROM_LABEL.resKind[normLabel(rowVal(r.raw, mapping, 'kind'))] || 'team',
      dept: rowVal(r.raw, mapping, 'dept'),
      total: n == null ? '' : (monthToDay ? Math.round(n * HOURS_PER_MONTH * 100) / 100 : n)
    };
  });
}

function convertMembers(rows, mapping, genId) {
  return rows.map(r => ({
    id: genId('mb'),
    _rowNo: r.rowNo,
    name: rowVal(r.raw, mapping, 'name'),
    role: FROM_LABEL.memberRole[normLabel(rowVal(r.raw, mapping, 'role'))] || 'other',
    dept: rowVal(r.raw, mapping, 'dept'),
    duty: rowVal(r.raw, mapping, 'duty'),
    contact: rowVal(r.raw, mapping, 'contact')
  }));
}

function convertReferences(rows, mapping, genId) {
  return rows.map(r => ({
    id: genId('rf'),
    parentId: '',
    _parentRow: r.parentRow,
    _rowNo: r.rowNo,
    title: rowVal(r.raw, mapping, 'title'),
    link: rowVal(r.raw, mapping, 'link'),
    owner: rowVal(r.raw, mapping, 'owner'),
    date: parseDate(rowVal(r.raw, mapping, 'date')),
    dept: rowVal(r.raw, mapping, 'dept'),
    stage: FROM_LABEL.refStage[normLabel(rowVal(r.raw, mapping, 'stage'))] || 'other',
    status: FROM_LABEL.refDocStatus[normLabel(rowVal(r.raw, mapping, 'status'))] || 'pending',
    requirement: rowVal(r.raw, mapping, 'requirement'),
    type: ''
  }));
}

/* 按 _parentRow（= rows 数组下标）把 parentId 补上。
   id 在 convert* 阶段生成，所以这里做第二遍遍历把父子关系接上。
   linkParents(list) 里 x 的下标必须等于当年 rows 的下标与 buildHierarchy 存的
   parentRow 同一坐标系 —— 转换器都是 map 一比一，所以成立。 */
function linkParents(list) {
  // 每个下标都要进表：父行自己可能是根（_parentRow = -1），
  // 若只登记 _parentRow >= 0 的行，那么挂在「下标 0 的根行」下的子行就找不到父，
  // 层级会静默丢失（钉钉的 Parent Record 第一行走的就是这个坑）。
  const byRowIdx = {};
  list.forEach((x, i) => { byRowIdx[i] = x; });
  list.forEach(x => {
    x.parentId = (x._parentRow >= 0 && byRowIdx[x._parentRow]) ? byRowIdx[x._parentRow].id : '';
  });
  return list;
}

/* ============================================================
   四、来源 A：平台自己导出的文件（带 _元信息）
   按 _id/_parentId 精确还原，不依赖名字匹配。
   ============================================================ */
function detectExportType(aoa) {
  const meta = {};
  aoa.forEach(r => { if (cellText(r[0])) meta[normKey(r[0])] = cellText(r[1]); });
  return meta;
}

/* 读一张表：返回 { headers, rows(对象数组，含 _id/_parentId) } */
function readExportSheet(ws, XLSX) {
  const aoa = sheetToAoa(ws, XLSX);
  if (!aoa.length) return null;
  const headers = (aoa[0] || []).map(cellText);
  const iId = headers.indexOf('_id'), iPid = headers.indexOf('_parentId');
  const rows = aoa.slice(1).map((r, i) => {
    const o = { _rowNo: i + 2 };
    headers.forEach((h, c) => { if (h && h !== '_id' && h !== '_parentId') o[h] = r[c]; });
    o._id = iId >= 0 ? cellText(r[iId]) : '';
    o._parentId = iPid >= 0 ? cellText(r[iPid]) : '';
    return o;
  }).filter(o => Object.keys(o).some(k => k[0] !== '_' && cellText(o[k])));
  return { headers: headers, rows: rows };
}

/* ============================================================
   五、主入口
   ============================================================ */

/**
 * 解析一份工作簿。
 * @param {Buffer|Uint8Array} buf  文件内容
 * @param {object} XLSX            SheetJS 实例（依赖注入，便于单测与复用）
 * @param {object} opts            { planName, monthToDay, sheetOverrides }
 * @returns {object} { source, plan, sheets[], diagnostics[], summary }
 */
function parseWorkbook(buf, XLSX, opts) {
  opts = opts || {};
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const metaSheet = wb.SheetNames.find(n => normKey(n) === '_元信息' || normKey(n) === '元信息');
  if (metaSheet) {
    const meta = detectExportType(sheetToAoa(wb.Sheets[metaSheet], XLSX));
    const out = parsePlatformExport(wb, XLSX, meta, opts);
    out.meta = meta;
    return out;
  }
  return parseDingTalkExport(wb, XLSX, opts);
}

/* ---------- 来源 B：钉钉导出 ---------- */
function parseDingTalkExport(wb, XLSX, opts) {
  const genId = idGen('im');
  const sheets = [];
  const skipped = [];

  /* 1) 先把每张 sheet 读成 aoa，并对每个平台表单试算表头行 */
  const candidates = [];
  wb.SheetNames.forEach(name => {
    if (name.charAt(0) === '_') return;                        // _元信息 之类
    if (isExcludedSheet(name)) return;                         // 废弃 / 草稿 / 备份表不参与
    const aoa = sheetToAoa(wb.Sheets[name], XLSX);
    if (!aoa.length) return;
    let best = { form: null, matched: 0, headerRow: 0, mapping: {}, unmatched: [], score: -1, nonEmpty: 0 };
    Object.keys(FORM_TITLE).forEach(form => {
      if (form === 'basic') return;                            // 基本信息不在 sheet 级匹配
      const h = findHeaderRow(aoa, form);
      const m = matchSheet((aoa[h.row] || []).map(cellText), form);
      const score = h.matched * 10 + h.nonEmpty;
      if (score > best.score) {
        best = { form: form, matched: h.matched, headerRow: h.row, mapping: m.mapping, unmatched: m.unmatchedHeaders, score: score, nonEmpty: h.nonEmpty };
      }
    });
    candidates.push({ name: name, aoa: aoa, best: best, headerRow: best.headerRow });
  });

  /* 2) 一张 sheet 只喂一个表单，一个表单只吃一张 sheet（贪心一对一分配） */
  const assign = assignForms(candidates);
  const taken = assign.byForm;
  const usedSheets = assign.bySheet;

  /* 2.5) 用户在预览页的手动指定：直接把某张 sheet 绑到某个表单，覆盖自动分配。
     opts.sheetOverrides = { '表名': '表单key' }；值为 '' 或 null 表示保持跳过。 */
  applySheetOverrides(taken, usedSheets, candidates, opts.sheetOverrides);

  /* 3) 逐表转换 */
  const plan = {
    id: '', name: opts.planName || '', year: new Date().getFullYear(),
    status: 'draft', owner: '', projectId: '', projectName: '',
    startDate: '', endDate: '', description: '',
    overview: [], milestones: [], tasks: [], marketPlan: [],
    issues: [], risks: [], resources: [], members: [], references: []
  };

  const diag = [];

  Object.keys(taken).forEach(form => {
    const c = taken[form];
    const headers = (c.aoa[c.headerRow] || []).map(cellText);
    const mapping = c.mapping;
    // 有名字列就用名字列做「节点名」，没有的（遗留问题 / 项目风险）退回主标识列
    const nameField = pickNameField(form, mapping);
    // 父列：钉钉固定叫 Parent Record，别名见 PARENT_COLS
    let parentCol = -1;
    headers.forEach((h, i) => { if (parentCol < 0 && PARENT_COLS.indexOf(normKey(h)) >= 0) parentCol = i; });

    // 数据行：跳过全空行；无可标识列（全表没有节点名）时只按「有效单元格数」判断
    const rows = [];
    for (let r = c.headerRow + 1; r < c.aoa.length; r++) {
      const row = c.aoa[r] || [];
      if (isEmptyRow(row, mapping)) continue;
      if (!nameField) { rows.push({ rowNo: r + 1, raw: row, parentName: '' }); continue; }
      if (!cellText(row[mapping[nameField]])) continue;
      rows.push({ rowNo: r + 1, raw: row, parentName: parentCol >= 0 ? cellText(row[parentCol]) : '' });
    }

    const hd = buildHierarchy(rows, mapping, nameField);
    const tagged = [].concat(
      hd.dangling.map(x => ({ kind: 'dangling', sheet: c.sheet, row: x.row, name: x.name, parentName: x.parentName })),
      hd.selfRef.map(x => ({ kind: 'selfRef', sheet: c.sheet, row: x.row, name: x.name, parentName: x.parentName })),
      hd.cycle.map(x => ({ kind: 'cycle', sheet: c.sheet, row: x.row, name: x.name })),
      hd.ambiguous.map(x => ({ kind: 'ambiguous', sheet: c.sheet, row: x.row, name: x.name, parentName: x.parentName, candidates: x.candidates }))
    );
    diag.push.apply(diag, tagged);

    const sheetStat = {
      form: form, label: FORM_TITLE[form], sheetName: c.sheet,
      headerRow: c.headerRow + 1, rows: rows.length,
      tier: c.tier || 'strong', confidence: TIER_LABEL[c.tier || 'strong'],
      ratio: c.ratio, discriminators: c.disc, exHits: c.exHits, exactEx: c.exactEx,
      nameHint: c.nameHint, confidenceScore: c.score, matchedCols: c.matched,
      mapping: mapping, headers: headers,
      /* 映射结果给预览页展示：「钉钉列 → 平台字段」 */
      mappedCols: Object.keys(mapping).map(f => ({ field: f, header: headers[mapping[f]] })),
      unmatchedHeaders: c.unmatched,
      dropped: (c.unmatched || []).length,
      ambiguous: hd.ambiguous.length,
      droppedNames: (c.unmatched || []).slice(0, 12),
      nodeName: nameField ? headers[mapping[nameField]] : ''
    };

    switch (form) {
      case 'overview':
        plan.overview = linkParents(convertOverview(rows, mapping, genId));
        break;
      case 'tasks':
        plan.tasks = linkParents(convertTasks(rows, mapping, genId));
        break;
      case 'marketPlan':
        plan.marketPlan = linkParents(convertTreeForm(rows, mapping, genId, 'mk', 'name'));
        break;
      case 'milestones':
        plan.milestones = convertMilestones(rows, mapping, genId);
        break;
      case 'issues':
        plan.issues = convertIssues(rows, mapping, genId);
        break;
      case 'risks':
        plan.risks = convertRisks(rows, mapping, genId);
        break;
      case 'resources':
        plan.resources = convertResources(rows, mapping, genId, opts.monthToDay !== false);
        sheetStat.unitNote = opts.monthToDay === false ? '按原值导入' : '人月 → 人天（×' + HOURS_PER_MONTH + '）';
        break;
      case 'members':
        plan.members = convertMembers(rows, mapping, genId);
        break;
      case 'references':
        plan.references = linkParents(convertReferences(rows, mapping, genId));
        break;
    }
    // 钉钉没有独立的基本信息 sheet，负责人/起止从总览或 WBS 里反推
    applyBasicFromSheet(plan, rows, mapping, form);
    sheets.push(sheetStat);
  });

  /* 4) 未匹配的 sheet 列出原因，让用户知道什么被跳过了（用户明确要求：平台没有的一律跳过） */
  wb.SheetNames.forEach(name => {
    if (name.charAt(0) === '_') return;
    if (sheets.some(s => s.sheetName === name)) return;
    const c = candidates.find(x => x.name === name);
    const winner = usedSheets[name];
    let reason = '数据为空';
    let suggest = null;   // 给预览页「手动指定归属」用：最像哪个表单
    if (isExcludedSheet(name)) reason = '表名标注为废弃 / 草稿 / 备份，按规则跳过';
    else if (c && c.aoa.length) {
      const headers = (c.aoa[c.headerRow] || []).map(cellText);
      // 这张表对每个表单的最佳拟合，供手动指定兜底
      let bestFit = null;
      Object.keys(FORM_TITLE).forEach(f => {
        if (f === 'basic') return;
        const mm = matchSheet(headers, f);
        if (mm.matchedCount < 2) return;
        const conf = confidenceOf(headers, f, mm.mapping, name);
        if (!bestFit || conf.score > bestFit.score ||
            (conf.score === bestFit.score && conf.exHits > bestFit.exHits) ||
            (conf.score === bestFit.score && conf.exHits === bestFit.exHits && mm.matchedCount > bestFit.matched)) {
          bestFit = {
            form: f, label: FORM_TITLE[f], score: conf.score, disc: conf.disc,
            nameHint: conf.nameHint, exHits: conf.exHits, matched: mm.matchedCount, tier: conf.tier,
            mapping: mm.mapping, headers: headers
          };
        }
      });
      // 手动指定时按目标表单重新算 mapping，所以连原始列名一起带上给预览页
      if (bestFit) suggest = bestFit;
      if (!bestFit) reason = '表头与平台任何表单都对不上（平台无对应元素），已跳过';
      else if (bestFit.tier === 'low') reason = '仅蹭到通用列（名称/负责人/状态等），判别列不足，已跳过';
      else if (winner || taken[bestFit.form]) reason = '与已归属的表内容重复，保留匹配度更高的那张';
      else reason = '判别列不足以确认归属，已跳过';
    }
    skipped.push({
      sheetName: name, reason: reason, suggest: suggest,
      headerHint: c && c.aoa.length ? (c.aoa[0] || []).map(cellText).filter(Boolean).slice(0, 6).join(' / ') : ''
    });
  });

  plan.id = 'plan-' + Date.now().toString(36);
  if (!plan.name) plan.name = opts.planName || '（未命名计划）';
  if (!plan.startDate) plan.startDate = earliest(plan);
  if (!plan.endDate) plan.endDate = latest(plan);

  return {
    source: 'dingtalk',
    plan: plan,
    sheets: sheets,
    skipped: skipped,
    diagnostics: dedupeDiag(diag),
    summary: countPlan(plan)
  };
}

/* 从某张表里补基本信息（负责人 / 起止时间），钉钉没有独立的基本信息 sheet */
function applyBasicFromSheet(plan, rows, mapping, form) {
  if (form !== 'overview' && form !== 'tasks') return;
  const owners = [], starts = [], ends = [];
  rows.forEach(d => {
    const r = d.raw;
    if (mapping.owner != null) { const v = cellText(r[mapping.owner]); if (v) owners.push(v); }
    if (mapping.startDate != null) { const v = parseDate(r[mapping.startDate]); if (v) starts.push(v); }
    if (mapping.endDate != null) { const v = parseDate(r[mapping.endDate]); if (v) ends.push(v); }
  });
  if (!plan.owner && owners.length) plan.owner = owners[0];
  if (!plan.startDate && starts.length) plan.startDate = starts.slice().sort()[0];
  if (!plan.endDate && ends.length) plan.endDate = ends.slice().sort().pop();
}

function earliest(plan) {
  const ds = [];
  ['overview', 'tasks', 'marketPlan'].forEach(k => (plan[k] || []).forEach(x => { if (x.startDate) ds.push(x.startDate); }));
  return ds.length ? ds.sort()[0] : '';
}
function latest(plan) {
  const ds = [];
  ['overview', 'tasks', 'marketPlan'].forEach(k => (plan[k] || []).forEach(x => { if (x.endDate) ds.push(x.endDate); }));
  return ds.length ? ds.sort().pop() : '';
}

function countPlan(plan) {
  return {
    overview: plan.overview.length, milestones: plan.milestones.length, tasks: plan.tasks.length,
    marketPlan: plan.marketPlan.length, issues: plan.issues.length, risks: plan.risks.length,
    resources: plan.resources.length, members: plan.members.length, references: plan.references.length
  };
}

/* 诊断分类 + 去重。类型判定看字段形态：有 candidates 是歧义，parentName==name 是自指，
   有 parentName 是悬空，都没有是成环。 */
function diagKind(d) {
  if (d.candidates) return 'ambiguous';
  if (d.parentName && d.parentName === d.name) return 'selfRef';
  if (d.parentName) return 'dangling';
  return 'cycle';
}
function dedupeDiag(diag) {
  const seen = {}, out = [];
  diag.forEach(d => {
    const kind = diagKind(d);
    const key = kind + '|' + (d.sheet || '') + '|' + d.row;
    if (seen[key]) return;
    seen[key] = true;
    out.push(Object.assign({ kind: kind }, d));
  });
  return out;
}

/* ---------- 来源 A：平台导出文件的回导 ---------- */
function parsePlatformExport(wb, XLSX, meta, opts) {
  const genId = idGen('rt');
  const sheets = [], skipped = [];
  const plan = {
    id: '', name: opts.planName || cellText(meta.planName) || '',
    year: new Date().getFullYear(), status: 'draft', owner: '', projectId: '', projectName: '',
    startDate: '', endDate: '', description: '',
    overview: [], milestones: [], tasks: [], marketPlan: [],
    issues: [], risks: [], resources: [], members: [], references: []
  };

  const basic = wb.SheetNames.find(n => normKey(n) === '基本信息');
  if (basic) {
    sheetToAoa(wb.Sheets[basic], XLSX).forEach(r => {
      const k = normKey(cellText(r[0])), v = cellText(r[1]);
      if (k === '计划名称') plan.name = v || plan.name;
      else if (k === '年度') plan.year = parseNumber(v) || plan.year;
      else if (k === '状态') plan.status = FROM_LABEL.planStatus ? (FROM_LABEL.planStatus[normKey(v)] || plan.status) : plan.status;
      else if (k === '负责人') plan.owner = v;
      else if (k === '关联项目') plan.projectName = v;
      else if (k === '开始日期') plan.startDate = parseDate(v);
      else if (k === '结束日期') plan.endDate = parseDate(v);
      else if (k === '计划说明') plan.description = v;
    });
  }

  const MAP = {
    '项目总览': 'overview', '里程碑': 'milestones', 'WBS任务': 'tasks', '上市计划': 'marketPlan',
    '遗留问题': 'issues', '项目风险': 'risks', '资源': 'resources', '团队成员': 'members', '参考文档': 'references'
  };

  wb.SheetNames.forEach(name => {
    const form = MAP[normKey(name)];
    if (!form) { if (!basic || name !== basic) skipped.push({ sheetName: name, reason: '非平台导出表，已跳过' }); return; }
    const s = readExportSheet(wb.Sheets[name], XLSX);
    if (!s) { skipped.push({ sheetName: name, reason: '数据为空' }); return; }
    const list = s.rows.map(r => toPlatformItem(r, form, genId));
    // 按 _id/_parentId 还原层级（精确，不依赖名字）
    const byId = {};
    list.forEach(x => { if (x._srcId) byId[x._srcId] = x; });
    list.forEach(x => { x.parentId = (x._srcParentId && byId[x._srcParentId]) ? byId[x._srcParentId].id : ''; });
    list.forEach(x => { delete x._srcId; delete x._srcParentId; delete x._rowNo; });
    plan[form] = list;
    sheets.push({
      form: form, label: FORM_TITLE[form], sheetName: name, headerRow: 1,
      rows: list.length, mapping: {}, headers: s.headers, unmatchedHeaders: [], dropped: 0, ambiguous: 0
    });
  });
  plan.id = 'plan-' + Date.now().toString(36);
  return { source: 'platform-export', plan: plan, sheets: sheets, skipped: skipped, diagnostics: [], summary: countPlan(plan) };
}

/* 平台导出行 → 平台记录（把中文标签反查成枚举值） */
function toPlatformItem(r, form, genId) {
  const g = k => cellText(r[k]);
  const st = FROM_LABEL.taskStatus[normKey(g('状态'))];
  // 平台导出的行带 _id：沿用原 id，保证回导后记录身份不变（外部关联挂在 id 上）
  const id = genId.prefer(g('_id'));
  switch (form) {
    case 'overview': return {
      id: id, parentId: '', _srcId: g('_id'), _srcParentId: g('_parentId'), _rowNo: r._rowNo,
      name: g('名称'), owner: g('负责人'),
      startDate: parseDate(g('开始')), endDate: parseDate(g('结束')),
      status: st || statusFromProgress(parseProgress(g('进度%'))) || 'not-started',
      progress: parseProgress(g('进度%')) == null ? 0 : parseProgress(g('进度%')),
      deliverable: g('交付物'), note: g('备注')
    };
    case 'tasks': {
      const p = parseProgress(g('进度%'));
      return {
        id: id, parentId: '', _srcId: g('_id'), _srcParentId: g('_parentId'), _rowNo: r._rowNo,
        wbsCode: g('WBS编码'), name: g('名称'),
        type: FROM_LABEL.taskType[normKey(g('类型'))] || 'dev',
        status: st || statusFromProgress(p) || 'not-started',
        priority: FROM_LABEL.priority[normKey(g('优先级'))] || 'medium',
        progress: p == null ? 0 : p,
        plannedHours: parseNumber(g('人天')) == null ? '' : parseNumber(g('人天')),
        owner: g('负责人'), dept: g('主责部门'),
        startDate: parseDate(g('开始')), endDate: parseDate(g('结束')),
        dependencies: g('依赖') ? g('依赖').split(/[,，、]\s*/).map(x => x.trim()).filter(Boolean) : [],
        note: g('备注')
      };
    }
    case 'milestones': return {
      id: id, _rowNo: r._rowNo, name: g('里程碑'), date: parseDate(g('日期')),
      status: FROM_LABEL.milestoneStatus[normKey(g('状态'))] || 'pending',
      owner: g('负责人'), desc: g('说明')
    };
    case 'marketPlan': {
      const p = parseProgress(g('进度%'));
      return {
        id: id, parentId: '', _srcId: g('_id'), _srcParentId: g('_parentId'), _rowNo: r._rowNo,
        name: g('名称'), startDate: parseDate(g('计划开始时间')), endDate: parseDate(g('计划结束时间')),
        owner: g('任务执行人'), status: st || statusFromProgress(p) || 'not-started', note: g('备注')
      };
    }
    case 'issues': return {
      id: id, _rowNo: r._rowNo, code: g('问题编号'), desc: g('遗留问题描述'),
      solution: g('应对方案'), owner: g('责任人'), dueDate: parseDate(g('预计闭环时间')),
      progress: g('当前进展'), conclusion: g('结论'),
      status: FROM_LABEL.issueStatus[normKey(g('当前状态'))] || 'pending'
    };
    case 'risks': return {
      id: id, _rowNo: r._rowNo,
      type: FROM_LABEL.riskType[normKey(g('风险类型'))] || 'other',
      desc: g('风险描述'), solution: g('应对方案'), owner: g('责任人'),
      dueDate: parseDate(g('计划闭环时间')),
      status: FROM_LABEL.riskStatus[normKey(g('风险状态'))] || 'watching',
      progress: g('进展状态')
    };
    case 'resources': return {
      id: id, _rowNo: r._rowNo, name: g('资源'),
      kind: FROM_LABEL.resKind[normKey(g('类型'))] || 'team',
      dept: g('部门'), total: parseNumber(g('总容量(人天)')) == null ? '' : parseNumber(g('总容量(人天)'))
    };
    case 'members': return {
      id: id, _rowNo: r._rowNo, name: g('姓名'),
      role: FROM_LABEL.memberRole[normKey(g('角色'))] || 'other',
      dept: g('部门/团队'), duty: g('职责分工'), contact: g('联系方式')
    };
    case 'references': return {
      id: id, parentId: '', _srcId: g('_id'), _srcParentId: g('_parentId'), _rowNo: r._rowNo,
      title: g('交付产物'), link: g('模板链接'), owner: g('提交人员'), date: parseDate(g('提交日期')),
      dept: g('责任部门(人)'), stage: FROM_LABEL.refStage[normKey(g('评审阶段'))] || 'other',
      status: FROM_LABEL.refDocStatus[normKey(g('提交状态'))] || 'pending',
      requirement: g('评审要求'), type: ''
    };
    default: return { id: id, _rowNo: r._rowNo };
  }
}

module.exports = {
  parseWorkbook: parseWorkbook,
  parseDingTalkExport: parseDingTalkExport,
  parsePlatformExport: parsePlatformExport,
  LABELS: LABELS,
  SYNONYMS: SYNONYMS,
  FORM_TITLE: FORM_TITLE,
  HOURS_PER_MONTH: HOURS_PER_MONTH,
  TIER_LABEL: TIER_LABEL,
  confidenceOf: confidenceOf,
  FIELD_EXCLUSIVITY: FIELD_EXCLUSIVITY,
  /* 供单测使用的细粒度工具 */
  _internals: {
    parseDate: parseDate, parseProgress: parseProgress, parseNumber: parseNumber,
    normKey: normKey, normLabel: normLabel, matchColumn: matchColumn, matchSheet: matchSheet,
    findHeaderRow: findHeaderRow, buildHierarchy: buildHierarchy, convertOverview: convertOverview,
    linkParents: linkParents, cellText: cellText, rowVal: rowVal, statusFromProgress: statusFromProgress
  }
};
