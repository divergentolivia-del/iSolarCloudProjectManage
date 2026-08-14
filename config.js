/* 组织架构与业务配置：组织调整时只改本文件，不动计算与界面代码 */

/* 阳光云团队列表（核算主体）。key 须与导出数据「所在团队」列一致，大小写不敏感。
   source 决定工时取数口径：
     story = 取「故事点」    est = 取「预估故事点」（仅测试部-应用软件测试-云服务） */
const TEAMS = [
  { key: 'APP开发-阳光云',            dept: 'APP开发',    source: 'story' },
  { key: 'APP开发-平台',              dept: 'APP开发',    source: 'story' },
  { key: '后端开发-阳光云',           dept: '后端开发',   source: 'story' },
  { key: '后端开发-平台',             dept: '后端开发',   source: 'story' },
  { key: 'Web开发-阳光云',            dept: 'Web开发',    source: 'story' },
  { key: 'Web开发-平台',              dept: 'Web开发',    source: 'story' },
  { key: '中台开发-IoT中台',          dept: '中台开发',   source: 'story' },
  { key: '中台开发-技术中台',         dept: '中台开发',   source: 'story' },
  { key: '中台开发-数据中台',         dept: '中台开发',   source: 'story' },
  { key: '中台开发-平台运维',         dept: '中台开发',   source: 'story' },
  { key: '中台开发-业务中台（平台）', dept: '中台开发',   source: 'story' },
  { key: 'AI开发-交互智能',           dept: 'AI开发',     source: 'story' },
  { key: 'AI开发-系统智能',           dept: 'AI开发',     source: 'story' },
  { key: '测试部-应用软件测试-云服务', dept: '测试部',    source: 'est'   },
  { key: '测试部-应用软件测试-中后台', dept: '测试部',    source: 'story' },
  { key: '欧洲办公室-APP',            dept: '欧洲办公室', source: 'story' },
  { key: '欧洲办公室-WEB',            dept: '欧洲办公室', source: 'story' },
  { key: '欧洲办公室-测试',           dept: '欧洲办公室', source: 'story' }
];

/* 非阳光云团队：出现在原始导出里但不属于核算主体，静默忽略、不报未识别告警。
   前缀匹配。ECO 团队自身的组（APP开发-ECO 等）在此排除；
   而分类维度的「ECO」是阳光云团队投在 ECO 任务上的工时，仍计入，两者不冲突。 */
const IGNORED_TEAM_PATTERNS = [
  '（不可选）', '站控', '嵌入式', '户用储能监控中心', '工具开发部', '工具及自动化',
  '-ECO', 'ECO-', '测试部-系统测试', '测试部-站控测试', '测试部-电气测试',
  '测试部-应用软件测试-站控', '测试部-嵌入式', '测试部-云服务', '测试部-中后台',
  '云服务开发部', '中后台开发部', 'AI开发部', '未填写'
];

/* 产品线：出现在「产品线版本工作量汇总」，按看板的「所属项目(层级1)」匹配 */
const PRODUCT_LINES = ['户用及分布式监控', '储能及地面监控', '工商业场景监控（临时）'];

/* 版本规划工作量汇总的其他分类。match 为该分类聚合的「所属项目(层级1)」值 */
const OTHER_CATEGORIES = [
  { key: '智慧能源产品中心', match: ['智慧能源产品中心'] },
  { key: 'ECO',              match: ['ECO'] },
  { key: '工具项目',         match: ['工具项目'] },
  { key: '未立项/未填写',    match: ['未立项', '未填写'] }
];

/* 专项锁定人力可填的岗位列 */
const LOCK_ROLES = ['APP', 'APP-平台', 'WEB', 'WEB-平台', '后端', '后端-平台', '测试-云服务', '测试-中台'];
const LOCK_ROLE_TO_TEAM = {
  'APP': 'APP开发-阳光云', 'APP-平台': 'APP开发-平台',
  'WEB': 'Web开发-阳光云', 'WEB-平台': 'Web开发-平台',
  '后端': '后端开发-阳光云', '后端-平台': '后端开发-平台',
  '测试-云服务': '测试部-应用软件测试-云服务', '测试-中台': '测试部-应用软件测试-中后台'
};

const OWNER_LINES = ['智慧能源', '储能', '地面电站', '其他'];

/* 偏差判定阈值：绝对值在此比例内视为正常偏差，由研发团队自行消化 */
const DEVIATION_TOLERANCE = 0.10;

/* 对账告警阈值：总计表与看板按团队比对，差异超过此人天数才提示 */
const RECONCILE_TOLERANCE = 2;
