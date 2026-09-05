/* tb-config.js — Teambition 开放接口对接配置
   ⚠️ 本文件不含任何密钥，可安全提交到 git。
      User Token 存放在 data/tb/secret.json（已 .gitignore）或环境变量 TB_TOKEN，
      由 modules/tb/routes.js 读取，绝不写死在此。

   组织调整 / 迭代切换时，只改本文件的 BOARDS 模板（尤其是 sprintId），
   不动 TB 客户端与聚合代码。 */

'use strict';

/* TB 开放接口根地址 */
const TB_API_BASE = 'https://open.teambition.com/api';

/* 目标项目 ID（智慧能源需求管理项目） */
const TB_PROJECT_ID = '680dfb8c99c59515f40c1226';

/* ---------- 自定义字段 ID（该项目通用，已验证）---------- */
const TB_FIELDS = {
  team: 'cf:689d9725d499509188209290',       // 所在团队（下拉）
  storyPoint: 'cf:6878b134ae04e423c2eb5a36',  // 故事点
  estStoryPoint: 'cf:6979a32e929cb98c2efcca7d', // 预估故事点
  taskLevel: 'cf:68722870444ca7f13ef053d2',   // 任务类别（三级任务）
  productLine: 'cf:686ccc74e4f32d9e9e7ef0e2'   // 所属产品线（层级）
};

/* 三级任务筛选值 */
const TB_TASK_LEVEL_VALUE = '三级任务-研测工程师拆解';

/* 任务类型场景配置 ID（"任务"类型） */
const TB_SCENARIO_FIELD_CONFIG_ID = '680dfb8c0fa0a12fb22135a5';

/* ---------- 团队取数口径 ----------
   与 config.js 的 TEAMS.source 对齐：
   多数团队取「故事点」；测试部-应用软件测试-云服务 取「预估故事点」。 */
const TB_TEAM_SOURCE = {
  '测试部-应用软件测试-云服务': 'est'
  // 其余团队默认 'story'
};

/* ---------- 迭代映射（sprintId → 迭代名）----------
   TB 任务详情只给 sprintId(ID)，不给迭代名；而 /sprint/list 等接口需更高权限(403)。
   所以这里维护一张「sprintId → 迭代名」对照表，由前端可配置（后端读 state.tbSprintMap 优先，
   其次用本表默认值）。每月换迭代时，在前端「迭代配置」里改 sprintId 即可，不用改代码。 */
const TB_SPRINTS = {
  '6a54cad1565616b581fcb14b': '阳光云2026-8月C版本迭代',
  '6a6b1f08249c49d80744bbfe': '中后台-2026年8月迭代'
};

// 阳光云前后端研测团队清单（截图①的「所在团队」筛选）
// ⚠️ TQL 大小写敏感，必须是 TB 实际存储名（WEB 用大写，与 config.js 里显示用的小写不同）
const CLOUD_TEAMS = [
  'APP开发-阳光云', 'APP开发-平台',
  '后端开发-阳光云', '后端开发-平台',
  'WEB开发-阳光云', 'WEB开发-平台',
  '测试部-应用软件测试-云服务', '测试部-应用软件测试-中后台'
];

// 中后台团队清单（截图②的「所在团队」筛选）
const MIDDLE_TEAMS = [
  '中台开发-IoT中台', '中台开发-技术中台', '中台开发-数据中台',
  '中台开发-平台运维', '中台开发-业务中台（平台）'
];

/* ---------- 三个看板模板 ----------
   每个模板声明：显示名、涉及团队、迭代 sprint/sprintIds、是否带三级任务筛选、维度。
   sprintId 是「动态」的：每月切换版本迭代时只需更新前端配置的 sprintId。
   前端也允许在同步时临时覆盖 sprintId（覆盖优先于模板默认值）。 */
const TB_BOARDS = {
  /* 看板 1：阳光云迭代工作量（按团队维度，复刻截图①）
     ⚠️ 截图①的筛选条件是「所在团队 + 迭代 + 任务类型=任务」，没有「任务类别=三级任务」，
        所以 filterTaskLevel 必须为 false（与截图②③不同）。 */
  cloud: {
    key: 'cloud',
    name: '阳光云迭代工作量',
    dimension: 'team',
    filterTaskLevel: false,
    sprintId: '6a54cad1565616b581fcb14b',   // 阳光云 8月C版本迭代（示例，前端可改）
    sprintName: '阳光云2026-8月C版本迭代',
    teams: CLOUD_TEAMS
  },

  /* 看板 2：中后台工作量（按团队维度，带三级任务筛选，复刻截图②） */
  middle: {
    key: 'middle',
    name: '中后台工作量',
    dimension: 'team',
    filterTaskLevel: true,
    sprintId: '6a6b1f08249c49d80744bbfe',   // 中后台 8月迭代（示例，前端可改）
    sprintName: '中后台-2026年8月迭代',
    teams: MIDDLE_TEAMS
  },

  /* 看板 3：月度版本项目人力（按产品线维度，带三级任务筛选，两 sprint 合并，复刻截图③）
     全部团队参与，额外按「所属产品线」聚合，用于与团队维度对账。 */
  productLine: {
    key: 'productLine',
    name: '月度版本项目人力（产品线维度）',
    dimension: 'productLine',
    filterTaskLevel: true,
    sprintIds: ['6a54cad1565616b581fcb14b', '6a6b1f08249c49d80744bbfe'],
    sprintName: '阳光云+中后台 8月全量',
    teams: null // null = 不限团队（全部团队）
  }
};

module.exports = {
  TB_API_BASE,
  TB_PROJECT_ID,
  TB_FIELDS,
  TB_TASK_LEVEL_VALUE,
  TB_SCENARIO_FIELD_CONFIG_ID,
  TB_TEAM_SOURCE,
  TB_SPRINTS,
  CLOUD_TEAMS,
  MIDDLE_TEAMS,
  TB_BOARDS
};
