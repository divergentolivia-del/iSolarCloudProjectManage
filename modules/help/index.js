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
      desc: '账号密码、主题切换、编辑白名单、操作记录。注意：偏差阈值与外包单价没有本页入口，由管理员统一维护。' }
  ];

  // FAQ 分组：先「怎么算的」，再「数据哪来的」，最后「坏了找谁」。
  // 注意：答案渲染进 <div class="help-faq-a">${esc(f.a)}</div>，
  // 必须是单段纯文本——换行会被 HTML 折叠、HTML 会被转义，两条都不能用。
  const FAQ_GROUPS = [
    {
      g: '口径类', icon: '🧮',
      items: [
        { q: '人头数和产能到底怎么算的？',
          a: '总产能 = 可投入人数 × 开发周期天数。开发周期天数 = 工作日 + 周六（周日不计）。可投入人数 = 正式人数 + 外包人数。偏差 = 版本工作量 − 总产能，为正说明产能不足、需要裁需求，为负说明产能富余、可以继续导入需求。' },
        { q: '偏差多少算正常？可以调吗？',
          a: '默认 ±10% 以内算正常偏差，由团队自行消化，不触发告警。这个 10% 目前是写死在代码里的（config.js 的 DEVIATION_TOLERANCE），设置页没有阈值调整入口。要改阈值找平台管理员。' },
        { q: '表格里为什么有些格子是黄底？',
          a: '黄底表示这一格是手工改过的值，不是系统算出来的。你可以直接编辑「版本工作量」和「可投入人数」两列做假设分析（改人数看产能扛不扛得住）。改动会被记住，刷新不丢；把头人数的量改回自动值，锁定自动解除。' },
        { q: '「专项锁定人力」是什么？算进产能吗？',
          a: '是标注某人已被专项占用，不计入产能、只做提示，避免你误以为他还能投入到迭代里。它会影响偏差表的对账列，但不参与产能公式。' },
        { q: 'Token 额度是多少？超了会怎样？',
          a: '月度额度 500，告警阈值 80%。仪表盘上的进度条超过 60% 变黄、超过 80% 变红。超了不会停机，只是进度条告警并在首页告警区列出。' },
        { q: '我想改「外包人月单价」，在哪里改？',
          a: '预算模块实际读的是数据文件里的 costConfig.outsourceRate（默认 30000），设置页没有这个字段的入口。要改单价，找平台管理员改数据文件。' },
        { q: '里程碑逾期怎么判定的？',
          a: '计划页里里程碑的截止日期过了、且状态没标完成，就算逾期，会进首页告警区，并按配置在到期前 3 天 / 1 天推钉钉提醒责任人。' }
      ]
    },
    {
      g: '数据来源与新鲜度', icon: '📡',
      items: [
        { q: '平台里的数据哪些是自动的、哪些要我自己填？',
          a: '自动：代码仓库的提交 / PR、钉钉通讯录、TB 任务。手工：人头数填报、专项锁定、项目计划 / 里程碑。AI 生成：12 个 Skill 分析出的建议，全部先落到「今日待确认」等你拍板，不会直接改业务数据。' },
        { q: '数据多久刷新一次？',
          a: '仓库采集和 AI 分析按批次跑，不是实时的。判断管道是否存活看「数据自动流入」页；管道正常但「今日待确认」是空的，那就是真没有新建议。' },
        { q: '我刚改的数据，过一会儿怎么变了？',
          a: '两种可能：一是同步任务把它覆盖回源系统口径了；二是 AI 建议被你（或同事）采纳后落位覆盖。如果反复被覆盖，说明该字段应归源系统管，别再手改，找平台管理员。' }
      ]
    },
    {
      g: '常见坑', icon: '⚠️',
      items: [
        { q: '钉钉群收不到告警，怎么查？',
          a: '三个检查点，按顺序：①「AI 推送」页的 webhook.url 填了吗、enabled 是开的吗；②群机器人的安全设置——关键词 / 加签 / IP 白名单至少要设一项，三项全空钉钉会直接拒收（报 errcode 310000），设了加签还要把密钥填进 webhook.secret；③如果刚配好，看有没有滞留在「待发队列」里等补发。' },
        { q: '「待发队列」是什么？',
          a: '群消息没发出去时的降级落点。推送是锦上添花，绝不能因为推送故障拖垮主流程——所以配置没填好或发送失败时，消息先存进队列，等你把配置补齐，下一次自动检查会补发，也可以在页面上手动点补发。' },
        { q: '我点「采纳」和「驳回」，到底落到哪里去了？',
          a: '采纳 = 这条 AI 建议被人工确认有效，落位到对应业务数据；驳回 = 建议不成立，不改数据。两个动作都只记账、不回滚。采纳率是衡量 AI 准不准的唯一诚实指标——只认人的动作，所以请如实点。' },
        { q: '顶上有条黄条说我还在用初始密码，能关掉吗？',
          a: '那是批量建号时的提醒：你和同批次同事的初始密码规则相同，别人知道规则就能猜。点「知道了」可以关掉提示，但提示消失不代表密码改了，真正解决是去「系统设置 → 账号与密码」改掉。' }
      ]
    },
    {
      g: '出问题找谁', icon: '🚑',
      items: [
        { q: '平台打不开、报错、或者数据明显不对，找谁？',
          a: '分两类：用不明白 / 口径有疑问 / 权限要开通 → 找平台管理员；服务起不来 / 页面 502 / 内网访问不通 → 找运维（走运维申请）。提问题时请带上：你当时的操作、页面截图、大概时间点，有报错原文更好。' }
      ]
    },
    {
      g: '操作路径引导', icon: '🧭',
      items: [
        { q: '我第一次用，从哪开始？',
          a: '三步：①进「阳光云迭代项目」把本版本的人头数填了（产能是后面所有分析的地基）；②进「今日待确认」把积压的 AI 建议过一遍；③以后每天只需要看「今日待确认」这一处。' },
        { q: '每天 / 每周分别要做什么？',
          a: '每天：过一遍「今日待确认」，逐条采纳 / 驳回——这是平台里唯一需要每天花时间的地方。每周：检查迭代项目的人头数和偏差是否偏离；看「立项管理看板」的风险闭环率；有封版 / 上线节点时确认钉钉提醒已发给责任人。' }
      ]
    }
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

  function renderFaq() {
    return `<div class="help-faq">` + FAQ_GROUPS.map(gr => `
      <div class="help-faq-group">
        <div class="help-faq-group-title">${gr.icon} ${esc(gr.g)}</div>
        ${gr.items.map(f => `
          <details class="help-faq-item">
            <summary>${esc(f.q)}</summary>
            <div class="help-faq-a">${esc(f.a)}</div>
          </details>`).join('')}
      </div>`).join('') + `</div>`;
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
          ${renderFaq()}
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
      .help-faq-group { margin-bottom: 4px; }
      .help-faq-group-title {
        font-size: 12px; font-weight: 700; color: var(--muted); letter-spacing: .04em;
        margin: 16px 0 2px; padding-top: 12px; border-top: 1px solid var(--line, rgba(0,0,0,.08));
      }
      .help-faq-group:first-child .help-faq-group-title { border-top: none; padding-top: 0; margin-top: 0; }
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
    /* sidebar: false —— 不再往侧栏上方导航区塞第二条入口。
       侧栏左下角（.sidebar-footer）已有一条静态的「使用帮助」链接，
       这里再注册一次会渲染成两条重名项。保留下方那条，与「系统设置」并排。 */
    sidebar: false,
    init(el) { container = el; injectCss(); render(); },
    enter() { render(); },
    leave() {}
  };
})();
