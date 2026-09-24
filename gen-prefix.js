#!/usr/bin/env node
/* gen-prefix.js — 给开户名单生成「密码前缀」（姓名缩写）

用法：
  node gen-prefix.js data/dingtalk/roster.csv          # 生成/覆写「密码前缀」列
  node gen-prefix.js data/dingtalk/roster.csv --dry    # 只看结果，不写文件

── 为什么要自己建表 ────────────────────────────────────────────
零依赖是本项目的硬约束（CLAUDE.md），为一个花名册引拼音库不划算。
但「不引库」不等于「做不了」：这份 372 人的名单只用 392 个不同的字，
逐个建表完全在人能维护的范围内。

── 2026-09-24 踩过的坑，改表格式就是为了不再踩 ────────────────
第一版把汉字拆成「姓氏表」和「常用字表」两张，手工敲。结果：
  · 姓氏表建得全，名字表漏了一批常见的姓字（徐王林杨金李叶文万…）
  · 「陈雷」的「雷」名字表里没有 → 只算出 `c`（应为 `cl`），静默丢字母
  · 「蔡乐乐」也 `c` —— 两个不同的人前缀撞成一样
  · 因为工号后 4 位不同，密码拼出来仍不同，**全程没有任何报错**
      → 会带着一张错了 28 个字的表开完 372 个账号

改法：
  1. 合并成一张表，按首字母分组 —— 哪个字母下有哪些字一眼可见，
     不会出现「记得在姓氏表里加了、忘了在名字表里加」。
  2. 表外字**一律报出来**（不是只在两张表都缺时报）—— 缺字必须刺眼。
  3. 姓氏多音字单独一张小表覆盖（查、单、仇、曾…），其余统一走主表。

── 缩写规则 ──────────────────────────────────────────────────
中文名：姓 1 个首字母 + 名每字 1 个首字母
  陈丹萍 → cdp    张磊 → zl    欧阳明 → om
非中文名：按空格/连字符切词，每段取首字母
  Yen-Tzu Huang → yth    Nour Sakr → ns    Luyao Shi → ls

── 重名不用特殊处理 ──────────────────────────────────────────
两个张磊都是 zl，但密码里还有工号后 4 位（Zl20263853 / Zl20263228），
天然区分。所以这里缩写撞车不是错误，只是提示，供人工扫一眼。

大小写不在这里管：user-import.js 的 buildPassword 统一规范成首字母大写。
这里全部产出小写，方便人工核对。
*/

'use strict';

const fs = require('fs');

/* ══════════════ 拼音首字母表 ══════════════
 * 一行一个字母，同字母的字排在一起。加字时先找到对应字母那行再加，
 * 不要新起一行 —— 同一个字出现在两行里，后写的会覆盖先写的而不报错。
 *
 * 这张表是「一个字 -> 它的拼音首字母」，姓和名共用。多音字按
 * 中文人名的常见读法取值；做姓氏时读音不同的，见下方 SURNAME_OVERRIDE。
 */
const PY = {
  a: '阿安昂奥爱',
  b: '白百柏班斌彬兵波博滨冰宝毕卞标别步碧贝堡板本邦彪勃保奔',
  c: '才财蔡曹操岑柴昌长常超朝陈成诚承池驰冲储楚春慈从崔翠存昌纯崇川传创词聪产畅琛辰仇晨程',
  d: '大代戴丹党道德邓狄迪第刁丁东董栋都杜段多铎大典殿荡斗登顶冬',
  e: '恩尔二',
  f: '发樊凡方房飞菲丰封峰锋冯凤服福符付傅富芳风凤帆斐废枫范费',
  g: '甘刚高戈格葛根耿耕工恭龚巩谷顾关观光广贵桂郭国岗刚纲',
  h: '海涵汉豪郝昊浩何河贺恒衡宏红洪侯胡花华怀欢环焕荒黄惠慧辉会汇慧洪后胡海航弘徽鸿淏',
  j: '吉季纪继佳家嘉贾简建健江姜蒋焦杰洁捷金津锦靳进京晶精井静敬江姣姣筠俊骏军君积坚娟',
  k: '开凯康珂柯克孔靠可垦控坤昆阔葵楷',
  l: '来兰蓝郎朗乐雷冷黎李礼理力立丽连廉良梁林琳蔺凌玲刘柳龙娄楼卢鲁陆路璐罗吕略雷岭磊亮领令霖',
  m: '马麦满茂梅孟梦米苗铭明敏民淼缪牟牧墨毛盟',
  n: '娜南楠能倪年聂宁牛农暖男',
  o: '欧',
  p: '潘攀庞裴佩朋彭品平萍颇朴浦璞鹏频',
  q: '齐其奇琪琦启千钱强乔桥钦沁秦青清庆琼丘邱秋裘曲权全泉群漆勤璩',
  r: '冉然仁任荣容融锐瑞润睿',
  s: '萨桑森沙山珊善商少邵绍申深沈生昇圣盛师施石时史士世寿舒帅双水顺硕司思松宋苏素隋孙锁姗诗曙嗣莎胜',
  t: '台泰谈覃谭汤唐涛腾田铁廷婷通同童统涂屠拓陶天霆',
  w: '万汪王威微韦围伟卫蔚文雯翁邬巫吴伍武务魏炜玮旺',
  x: '娴西奚习席夏冼相向项肖潇晓晓谢辛新星邢幸雄熊修徐许旭宣薛学雪勋巡训贤翔笑孝小鑫兴昕旋绪轩馨祥',
  y: '园亚严言颜闫晏彦羊杨阳姚耀业叶一伊衣仪义弋逸毅应英迎盈勇永友佑于余俞宇雨玉郁育元袁原远苑岳跃云允运艳洋渊颖滢彧钰油垚圆寅延焱塬源扬益衍岩',
  z: '臧臧曾查翟战湛章张赵折甄振郑征峥正之志致智治中忠钟周舟宙朱竹祝卓子自宗邹祖左佐争震柱召政铸泽',
  /* 名单里出现但读音需注意的 */
  ch: '', sh: ''   // 占位，删除无妨；保留是为了提醒 zh/ch/sh 不分行
};
delete PY.ch; delete PY.sh;

/** 把 PY 倒排成「字 → 首字母」。同一个字出现在多行时立即报错。 */
const CHARS = (function build() {
  const m = Object.create(null);
  Object.keys(PY).forEach(function (ini) {
    for (const c of PY[ini]) {
      if (m[c] && m[c] !== ini) {
        throw new Error('拼音表冲突：字「' + c + '」同时被放在 ' + m[c] + ' 和 ' + ini + ' 两行，请只保留一处');
      }
      m[c] = ini;
    }
  });
  return m;
})();

/* ══════════════ 姓氏多音字覆盖 ══════════════
 * 这些字做姓氏时读音和做名字时不一样，主表按「做名字」的读音收，
 * 做姓时用这里的值。只列真正有分歧的，不要什么都往里塞。
 */
const SURNAME_OVERRIDE = {
  查:'z',  // 姓 zhā；名 chá
  单:'s',  // 姓 shàn；名 dān
  仇:'q',  // 姓 qiú；名 chóu
  曾:'z',  // 姓 zēng；名 céng
  朴:'p',  // 姓 piáo；名 pǔ
  区:'o',  // 姓 ōu；名 qū
  缪:'m',  // 姓 miào；名 móu
  秘:'b',  // 姓 bì；名 mì
  冼:'x',  // 姓 xiǎn
  乐:'y',  // 姓 yuè；名 lè
  都:'d',  // 姓 dū
  相:'x',  // 姓 xiàng
  繁:'p',  // 姓 pó
  尉:'y',  // 尉迟
  华:'h',  // 姓 huà；名 huá
  过:'g',  // 姓 guō；名 guò
  乜:'n',  // 姓 niè
  句:'g',  // 姓 gōu
  任:'r',  // 姓 rén（与名同音，留此仅为可读）
  燕:'y',  // 姓 yān
  召:'s',  // 姓 shào
  隗:'k',  // 姓 kuí
  折:'s',  // 姓 shé
  阚:'k',  // 姓 kàn
  盖:'g',  // 姓 gě
  种:'c',  // 姓 chóng
  祭:'z',  // 姓 zhài
  员:'y',  // 姓 yùn
  能:'n',  // 姓 nài
  蕃:'p'   // 姓 pí
};

/* 复姓：取 1 个首字母，占 2 个字。只有这些才当复姓处理。 */
const COMPOUND = {
  欧阳:'o', 司马:'s', 诸葛:'z', 东方:'d', 独孤:'d', 慕容:'m',
  皇甫:'h', 尉迟:'y', 上官:'s', 巫马:'w', 端木:'d', 澹台:'t'
};

/** 姓：优先多音字覆盖，再查主表。 */
function surnameInit(ch) {
  return SURNAME_OVERRIDE[ch] || CHARS[ch] || null;
}

/** 名：只查主表。 */
function givenInit(ch) {
  return CHARS[ch] || null;
}

/**
 * 生成姓名缩写。
 * @returns {{prefix:string, unknown:string[]}} unknown 为查不到的字
 */
function initials(rawName) {
  const s0 = String(rawName || '').trim();
  const unknown = [];

  /* ── 非中文名：按空格/连字符/点切词，每段取首字母 ──
     英文名的连字符是真分隔符（Yen-Tzu → yt），和中文名的部门后缀
     （张磊-智慧能源产品中心）语义不同，所以两条路分开走。 */
  if (!/^[一-龥]/.test(s0)) {
    const parts = s0.split(/[\s\-.]+/).filter(function (w) {
      return w && /[A-Za-z一-龥]/.test(w);
    });
    let p = '';
    parts.forEach(function (w) {
      const first = w.charAt(0);
      if (/[一-龥]/.test(first)) {
        const i = surnameInit(first);
        if (i) p += i; else unknown.push(first);
      } else {
        p += first.toLowerCase();
      }
    });
    return { prefix: p, unknown: unknown };
  }

  /* ── 中文名 ──
     先在第一个连字符处截断：通讯录用「张磊-智慧能源产品中心」给重名的人
     做区分，那串部门名不是姓名的一部分（详见 dingtalk-roster.js cleanName）。
     不截断的话整个部门名会被逐字取首字母，出来一串垃圾。 */
  const s = s0.split(/[-－—]/)[0];

  let out = '';
  let i = 0;

  /* 复姓占 2 个字、只取 1 个首字母 */
  const two = s.slice(0, 2);
  if (s.length >= 3 && COMPOUND[two]) {
    out += COMPOUND[two];
    i = 2;
  }

  for (; i < s.length; i++) {
    const c = s.charAt(i);
    if (!/[一-龥]/.test(c)) continue;                       // 跳过夹杂的符号
    const ini = (i === 0) ? surnameInit(c) : givenInit(c);
    if (!ini) { unknown.push(c); continue; }
    out += ini;
  }

  return { prefix: out, unknown: unknown };
}

/* ---------- 主流程 ---------- */

const argv = process.argv.slice(2);
const DRY = argv.indexOf('--dry') >= 0;
const file = argv.filter(function (a) { return a.charAt(0) !== '-'; })[0];
if (!file) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, ''));
  process.exit(1);
}

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.error('读不到名单：' + file + '（' + e.message + '）');
  process.exit(1);
}
if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

const lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
const header = lines[0].split(',');
const ci = {
  id: header.indexOf('工号'),
  name: header.indexOf('姓名'),
  prefix: header.indexOf('密码前缀')
};
if (ci.id < 0 || ci.name < 0 || ci.prefix < 0) {
  console.error('表头至少要含「工号,姓名,密码前缀」。实际读到：' + header.join(','));
  process.exit(1);
}

/* 极简 CSV 拆行：roster.csv 由本项目的 dingtalk-roster.js 产出，
   字段里只会出现逗号转义（双引号包裹），不做完整 CSV 解析。 */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const allUnknown = new Map();      // 字 -> {次数, 出现在哪些名字里}
const rows = lines.slice(1).map(function (l) {
  const f = splitCsv(l);
  const r = initials(f[ci.name]);
  r.unknown.forEach(function (c) {
    const rec = allUnknown.get(c) || { n: 0, names: [] };
    rec.n++;
    if (rec.names.length < 4 && rec.names.indexOf(f[ci.name]) < 0) rec.names.push(f[ci.name]);
    allUnknown.set(c, rec);
  });
  return { id: f[ci.id], name: f[ci.name], prefix: r.prefix, raw: f };
});

/* 缩写撞车不是错误（工号后 4 位会区分），但列出来供人工扫一眼 ——
   万一是两个人被算成同一串，能当场看出来。 */
const byPrefix = {};
rows.forEach(function (r) { (byPrefix[r.prefix] = byPrefix[r.prefix] || []).push(r.name); });
const dupPrefix = Object.keys(byPrefix).filter(function (k) { return byPrefix[k].length > 1; });

console.log('名单：      ' + file);
console.log('生成前缀：  ' + rows.length + ' 个');
console.log('');

/* 缺字【必须刺眼】——上一版就是这里不报错，错了 28 个字没人发现。
   所以：有缺字就直接退出，不写文件。 */
if (allUnknown.size) {
  console.log('❌ 有 ' + allUnknown.size + ' 个字查不到拼音首字母，这些名字会缺字母：');
  console.log('');
  allUnknown.forEach(function (rec, c) {
    console.log('    ' + c + '   出现 ' + rec.n + ' 次   例如：' + rec.names.join('、'));
  });
  console.log('');
  console.log('把上面这些字加到 gen-prefix.js 的 PY 表里（找到对应字母那行，追加进去），再重跑。');
  console.log('');
  console.log('注意：「陈雷」算出 `c` 这种少一个字母的情况，就是缺字造成的，不是规则问题。');
  process.exit(1);
}

console.log('✅ 全部汉字都在表内');
console.log('');
console.log('缩写相同的组（' + dupPrefix.length + ' 组）：');
if (!dupPrefix.length) console.log('    无');
dupPrefix.forEach(function (k) {
  console.log('    ' + k + ' → ' + byPrefix[k].join('、'));
});
console.log('');
console.log('前 15 行：');
rows.slice(0, 15).forEach(function (r) {
  console.log('    ' + r.id.padEnd(10) + r.name.padEnd(26) + '→ ' + r.prefix);
});
console.log('');

if (DRY) {
  console.log('--dry：未写入文件。');
  process.exit(0);
}

/* 写回：只改「密码前缀」列，其余列原样保留
   （roster.csv 的第 5 列部门是给人工核对用的，导入时会被 user-import.js 忽略） */
const out = [header.join(',')].concat(rows.map(function (r) {
  const f = r.raw.slice();
  while (f.length < header.length) f.push('');
  f[ci.prefix] = r.prefix;
  return f.slice(0, header.length).map(function (v) {
    v = String(v == null ? '' : v);
    return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(',');
}));
fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
console.log('已写入 ' + file);
