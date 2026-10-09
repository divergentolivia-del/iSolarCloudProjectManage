/* modules/help/index.js — 使用帮助模块
   一页讲清楚：每个页面是干嘛的、数据是怎么流转的、常见问题。
*/
const HelpModule = (() => {
  'use strict';

  let container = null;

  const PAGES = [
    { icon: '🏠', name: '首页', href: '#/dashboard',
      desc: '总览：产能偏差、在研项目、Token 消耗三个指标卡，AI 快捷动作（生成本周周报），以及今日待办 / 告警列表。' },
    { icon: '📥', name: '今日待确认', href: '#/inbox',
      desc: '所有 AI Skill 产生的待拍板建议都在这里：逐条审阅，点「采纳 / 驳回」。这是平台里唯一需要每天花时间的地方。' },
    { icon: '📚', name: '阳光云迭代项目', href: '#/iteration',
      desc: '迭代工作台：版本周期、人头数填报、专项锁定人力、工时数据导入、迭代口径、偏差分析、历史归档。' },
    { icon: '📊', name: '立项管理看板', href: '#/csenergy',
      desc: '全年项目管理：立项 / 审批 / 进行中项目数、里程碑节点统计、风险闭环率、项目进度与风险分布。' },
    { icon: '🗓️', name: '项目计划', href: '#/plan',
      desc: '部门项目执行指挥台：阶段计划、里程碑、WBS 任务、偏差与复盘。支持 Excel 导入 / 导出。' },
    { icon: '🔔', name: 'AI 推送', href: '#/notify',
      desc: '钉钉推送配置：高严重度项自动推群、封版 / 上线前提醒责任人、单点发送（按姓名给具体的人发）、待发队列补发。' },
    { icon: '🔁', name: '数据自动流入', href: 'dataflow.html',
      desc: '数据管道仪表盘：仓库采集状态、静默告警、提交↔任务映射确认、12 项 AI 分析的手动运行入口。管道出问题时才需要看。' },
    { icon: '⚙️', name: '系统设置', href: '#/dashboard/settings',
      desc: '账号密码、主题切换、外包人月单价 / 偏差预警阈值、编辑白名单、操作记录。' }
  ];

  const FAQ = [
    { q: '「今日待确认」是空的，是正常的吗？',
      a: '先看「数据自动流入」页确认采集管道是否存活；管道正常但待确认为空，就是真没有新建议。AI Skill 每批次数据运行后才会产生新建议。' },
    { q: '平台里的数据从哪里来？',
      a: '代码仓库的提交 / PR 由采集器自动拉取，经过 12 个 AI Skill 分析（风险识别、偏差分析、周报生成等），结果落到「今日待确认」等你拍板。' },
    { q: '采纳 / 驳回有什么区别？',
      a: '采纳 = 这条 AI 建议被人工确认有效，会落位到对应业务数据；驳回 = 建议不成立。累计采纳率是衡量 AI 准不准的核心指标，只认人的动作。' },
    { q: '想让钉钉群收到告警，要配什么？',
      a: '进「AI 推送」页，把机器人拉进目标群后填入群 openConversationId 保存即可。高严重度项会自动推群，不需要 agentId；配了 agentId 还会额外发工作通知。' }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function renderFlow() {
    const steps = [
      ['📦', '采集', '仓库提交 / PR 自动拉取'],
      ['🧠', '分析', '12 个 AI Skill 跑批'],
      ['📥', '待确认', '建议进收件箱等你拍板'],
      ['✅', '落位', '采纳后进业务数据'],
      ['🔔', '推送', '高严重度自动推钉钉']
    ];
    return `<div class="help-flow">` + steps.map((s, i) => `
      <div class="help-flow-step">
        <div class="help-flow-ic">${s[0]}</div>
        <div class="help-flow-name">${esc(s[1])}</div>
        <div class="help-flow-desc">${esc(s[2])}</div>
      </div>` + (i < steps.length - 1 ? '<div class="help-flow-arrow">→</div>' : '') +
    '').join('') + `</div>`;
  }

  function render() {
    if (!container) return;
    container.innerHTML = `
      <div class="help-page">
        <h2 class="page-title">使用帮助</h2>
        <div class="help-sub">一分钟搞懂：每个页面是干嘛的、数据怎么流转、出了问题找哪里。</div>

        <div class="help-card">
          <h3 class="help-h">🔄 数据是怎么流转的</h3>
          ${renderFlow()}
        </div>

        <div class="help-card">
          <h3 class="help-h">📄 每个页面是干嘛的</h3>
          <div class="help-pgrid">
            ${PAGES.map(p => `
              <a class="help-pcard" href="${p.href}">
                <div class="help-phead"><span class="help-picon">${p.icon}</span><span class="help-pname">${esc(p.name)}</span></div>
                <div class="help-pdesc">${esc(p.desc)}</div>
              </a>`).join('')}
          </div>
        </div>

        <div class="help-card">
          <h3 class="help-h">❓ 常见问题</h3>
          <div class="help-faq">
            ${FAQ.map(f => `
              <details class="help-faq-item">
                <summary>${esc(f.q)}</summary>
                <div class="help-faq-a">${esc(f.a)}</div>
              </details>`).join('')}
          </div>
        </div>
      </div>`;
  }

  function injectCss() {
    if (document.getElementById('helpStyle')) return;
    const style = document.createElement('style');
    style.id = 'helpStyle';
    style.textContent = `
      .help-page { max-width: 1000px; }
      .help-sub { color: var(--muted); font-size: 13px; margin: 6px 0 18px; }
      .help-card { background: var(--panel, #fff); border: 1px solid var(--line, rgba(0,0,0,.08)); border-radius: 14px; padding: 18px 20px; margin-bottom: 16px; }
      .help-h { margin: 0 0 14px; font-size: 14px; color: var(--text); }
      .help-flow { display: flex; align-items: flex-start; gap: 6px; flex-wrap: wrap; }
      .help-flow-step { flex: 0 0 auto; width: 118px; text-align: center; }
      .help-flow-ic { font-size: 22px; margin-bottom: 6px; }
      .help-flow-name { font-size: 13px; font-weight: 650; color: var(--text); }
      .help-flow-desc { font-size: 11px; color: var(--muted); margin-top: 3px; line-height: 1.45; }
      .help-flow-arrow { flex: 0 0 auto; color: var(--muted); font-size: 16px; padding-top: 22px; }
      .help-pgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
      .help-pcard { display: block; border: 1px solid var(--line, rgba(0,0,0,.1)); border-radius: 10px; padding: 12px 14px; text-decoration: none; transition: border-color .15s, box-shadow .15s; }
      .help-pcard:hover { border-color: var(--blue, #4c7dff); box-shadow: 0 0 0 3px rgba(76,125,255,.1); }
      .help-phead { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
      .help-picon { font-size: 16px; }
      .help-pname { font-size: 13px; font-weight: 650; color: var(--text); }
      .help-pdesc { font-size: 12px; color: var(--muted); line-height: 1.55; }
      .help-faq-item { border-bottom: 1px solid var(--line, rgba(0,0,0,.08)); padding: 10px 0; }
      .help-faq-item:last-child { border-bottom: none; }
      .help-faq-item summary { font-size: 13px; font-weight: 600; color: var(--text); cursor: pointer; }
      .help-faq-a { font-size: 12px; color: var(--muted); line-height: 1.65; margin-top: 8px; padding-left: 10px; border-left: 3px solid var(--line, rgba(0,0,0,.1)); }
    `;
    document.head.appendChild(style);
  }

  return {
    id: 'help',
    name: '使用帮助',
    icon: '📖',
    order: 9,
    sidebar: true,
    init(el) { container = el; injectCss(); render(); },
    enter() { render(); },
    leave() {}
  };
})();
