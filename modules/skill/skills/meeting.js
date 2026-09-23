/* modules/skill/skills/meeting.js — Skill 11：会议纪要提取器（纯函数）
   输入：transcripts（会议记录文本数组，来源=钉钉听记/人工导入，接口先就绪）。
   输出：结构化纪要（主题/结论/行动项[责任人+截止]）+ 待确认项。
   规则口径（非 NLP）：结论=含「决定/确认/共识/通过」的句；
   行动项=含「负责/跟进/请…做/需完成/跟进一下」的句，责任人取「X 负责/请 X」，
   截止取「X 前/截至 X/本周/下周」。当前无文本源时只出一条说明项，不产生噪音。 */

'use strict';

const RULES = {
  conclusionKeywords: ['决定', '确认', '共识', '通过', '敲定'],
  actionKeywords: ['负责', '跟进', '请', '需完成', '要完成', '需在', '落实', '推进'],
  dueKeywords: ['本周', '下周', '今天', '明天', '月底', '封版前']
};

function splitSentences(text) {
  return String(text || '')
    .split(/[。；;\n]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 4);
}

/** 从一句话里提取责任人：「X 负责」「请 X 跟进/做」「X 跟进」 */
function extractOwner(sentence) {
  const patterns = [
    /([\u4e00-\u9fa5A-Za-z·]{1,6})\s*(?:负责|跟进|落实|推进)/,
    /请\s*([\u4e00-\u9fa5A-Za-z·]{1,6})\s*(?:跟进|做|处理|完成|落实)/
  ];
  for (const re of patterns) {
    const m = sentence.match(re);
    if (m && m[1]) return m[1].trim().replace(/^(请|让|麻烦)/, '');
  }
  return '';
}

/** 从一句话里提取截止时间 */
function extractDue(sentence) {
  const m = sentence.match(/(?:在|于)?\s*(\d{1,2}[月./-]\d{1,2}[日号]?|\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*前/);
  if (m) return m[1];
  for (const k of RULES.dueKeywords) {
    if (sentence.includes(k)) return k;
  }
  return '';
}

function isActionSentence(sentence) {
  return RULES.actionKeywords.some(k => sentence.includes(k));
}
function isConclusionSentence(sentence) {
  return RULES.conclusionKeywords.some(k => sentence.includes(k));
}

/**
 * 会议纪要提取主函数。
 * @param {object} input
 *   transcripts: [{id, title, time, text}]
 * @returns {{name, desc, minutes, markdown, items}}
 */
function extract(input) {
  const transcripts = (input && input.transcripts) || [];

  /* 无数据源：只出一条说明项（低严重度），不产生噪音 */
  if (!transcripts.length) {
    return {
      name: '会议纪要提取器',
      desc: '从会议记录文本提取结构化纪要（结论/行动项/责任人/截止）',
      minutes: [],
      markdown: [
        '# 会议纪要（暂无数据）',
        '',
        '当前未接入会议记录文本源（钉钉听记打通后自动流入，或人工导入 data/meeting/transcripts.json）。',
        '格式：{ "transcripts": [{ "id", "title", "time", "text" }] }'
      ].join('\n'),
      items: [{
        id: 'meeting-no-source', severity: '低', category: '会议纪要',
        title: '会议纪要提取器未接入文本源（钉钉听记待凭据打通）',
        evidence: 'transcripts 为空：无会议记录可提取',
        suggestion: '钉钉听记凭据打通后自动生效；临时方案：把会议记录存到 data/meeting/transcripts.json',
        confidence: 0.9
      }]
    };
  }

  const minutes = [];
  const items = [];

  for (const t of transcripts) {
    const sentences = splitSentences(t.text);
    const conclusions = [];
    const actions = [];

    for (const s of sentences) {
      if (isConclusionSentence(s) && !conclusions.some(c => c === s)) conclusions.push(s);
      if (isActionSentence(s)) {
        actions.push({
          text: s,
          owner: extractOwner(s),
          due: extractDue(s)
        });
      }
    }

    minutes.push({
      id: t.id || '',
      title: t.title || '（未命名会议）',
      time: t.time || '',
      conclusions,
      actions,
      noOwner: actions.filter(a => !a.owner).length
    });

    items.push({
      id: 'meeting-min-' + (t.id || t.title || minutes.length), severity: '低', category: '会议纪要',
      title: `纪要已提取「${t.title || '未命名会议'}」：${conclusions.length} 条结论 / ${actions.length} 项行动`,
      evidence: actions.slice(0, 3).map(a => a.owner ? `${a.owner}：${a.text}` : a.text).join('；') || '（无行动项）',
      suggestion: '核对行动项责任人与截止时间是否识别正确',
      confidence: 0.6
    });

    /* 无责任人的行动项 → 中严重度（漏派活是会议最常见的翻车点） */
    for (const a of actions.filter(a => !a.owner)) {
      items.push({
        id: 'meeting-no-owner-' + (t.id || t.title || minutes.length) + '-' + actions.indexOf(a), severity: '中', category: '会议纪要',
        title: `「${t.title || '未命名会议'}」有行动项未识别到责任人`,
        evidence: a.text,
        suggestion: '手动补全责任人后落待办',
        confidence: 0.7
      });
    }
  }

  const totalActions = minutes.reduce((a, m) => a + m.actions.length, 0);
  const totalNoOwner = minutes.reduce((a, m) => a + m.noOwner, 0);

  const md = [
    '# 会议纪要汇总',
    '',
    `共 ${minutes.length} 场会议：${totalActions} 项行动（其中 ${totalNoOwner} 项未识别到责任人）。`,
    '',
    ...minutes.map(m => [
      `## ${m.title}${m.time ? `（${m.time}）` : ''}`,
      '',
      m.conclusions.length ? '### 结论' : '',
      ...m.conclusions.map(c => `- ${c}`),
      '',
      m.actions.length ? '### 行动项' : '### 行动项',
      ...m.actions.map(a => `- ${a.text}${a.owner ? `（责任人：${a.owner}` : '（⚠ 未识别到责任人）'}${a.due ? `，截止：${a.due}` : ''}）`),
      ''
    ].filter(l => l !== '' || true).join('\n'))
  ].join('\n');

  return {
    name: '会议纪要提取器',
    desc: '从会议记录文本提取结构化纪要（结论/行动项/责任人/截止）',
    minutes,
    markdown: md,
    items
  };
}

module.exports = { name: '会议纪要提取器', desc: '从会议记录文本提取结构化纪要', extract };