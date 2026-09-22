# M2 施工单 · 数据自动流入（SGAI+ 执行）

> 口径来源：`plan-ai-master.md` §11 M2（唯一版本）。本单是 M2 的**执行细化**。
> 执行人：SGAI+（改动一律推 `origin/dev/sgai`，验收后合并 main）。
> 状态：**M2-A 进行中**（2026-09-21 起）。

## 0. M2 到底要解决什么

M1 把平台从"个人工具"升级成"系统"（身份/权限/审计/部署/脱敏）。
M2 的目标是**数据不再靠人手工录**：Git 仓库、团队工作台、标准模板导出
都通过 adapter 自动流入平台，进度自动更新。

**验收标准（master §11）**：一周不手动录数据，平台进度仍在更新。

## 1. 冻结项（不归本轮，勿动）

| 项 | 原因 |
|---|---|
| 钉钉打通（文档/听记/机器人/待办/通讯录） | 等凭据，见 `plan-dingtalk-checklist.md` |
| Teambition 侧改动 | 已有，保持（TB OpenAPI + Webhook + 每日对账已跑通） |

## 2. M2-A（本轮 · 后端骨架 + 契约）

| # | 任务 | 产出 | 状态 |
|---|---|---|---|
| A1 | 统一数据契约发布 | `docs/plan-ai-m2-contract.md`（《团队工作台对接规范》：统一字段 + adapter 接口 + 标准模板 + 接入步骤） | ⬜ 本轮 |
| A2 | Git PR adapter 模块 | `modules/pradapter/`：git 采集 + L1/L2/L3/L4 映射引擎 + 置信度 + 落库 + API | ⬜ 本轮 |
| A3 | 静默告警 | 仓库 N 周无提交 → 告警（任务级告警等有任务数据后叠加） | ⬜ 本轮 |
| A4 | 单测 | `_test-pradapter.js`（映射引擎 + 告警逻辑，纯函数） | ⬜ 本轮 |
| A5 | 权限 | `db.js` 默认矩阵加 `pradapter:read`（pm/dev/viewer）、`pradapter:write`（pm） | ⬜ 本轮 |

### A2 设计要点（对齐 master §4.3）

- **采集**：配置制仓库列表 `data/pradapter/config.json`，`git log`/`git branch` 拉提交，
  不依赖 GitHub API（内网可用）；真实 PR 聚合留到接入 GitHub/GitLab 时按 API 补。
- **映射四级**：
  - L1 显式：提交标题 `#<任务号>` / `Closes #<号>` / 分支名含任务号 → 高置信，自动记入变更日志
  - L2 语义：标题/分支名与任务标题相似度 ≥ 阈值 → 生成待确认建议，人点"是/否"，确认后固化为 L1
  - L3 仓库：仓库配置了 `module` 映射 → 只更新项目/模块活跃度，不碰任务
  - L4 无法关联：只进原始日志，供追溯
- **克制原则**：PR 数据不覆盖手写完成度，只做"佐证"——有佐证安静，没佐证报警。
- **当前数据现实**：plan/project 库为空（无任务明细），映射引擎先以仓库级（L3/L4）+ 规则级（L1/L2 纯函数）跑通；
  任务库有数据后 L1/L2 自动生效，无需改引擎。

### A3 告警设计

- 仓库静默：最近提交 > 2 周 → `repo-stale` 告警（当前可跑）
- 任务静默：任务映射到仓库 + due 在 14 天内 + 未完成 + 仓库 2 周无提交 → `task-stale`（任务数据到位后生效）
- 告警可 ack（认领），同因同对象只保留未 ack 的一条

## 3. M2-B（应用层 · ✅ 本轮完成）

| # | 任务 | 说明 | 状态 |
|---|---|---|---|
| B1 | 风险识别 Skill | 输入：仓库活跃度 + 计划偏差 + 里程碑临近 → 输出风险清单（含评测集） | ✅ `modules/skill/skills/risk.js`（4 规则，TOP3 排序，真实数据 8 条风险） |
| B2 | 周报 Skill | 周报 Prompt 模板（master §6.3）+ 数据自动注入 + 评测集 | ✅ `report.js`（四节式 Markdown 草稿 + 脱敏 + 待确认） |
| B3 | 偏差分析 Skill | 基于迭代工时偏差 + PR 佐证，输出"可信度"而非硬算完成度 | ✅ `variance.js`（偏差表 + 趋势 + 归因 + 建议，PR 佐证可信度） |
| B4 | 前端面板 | 平台内「数据自动流入」页：仓库状态 / 映射确认 / 告警列表 / Skill 运行与确认 | ✅ `dataflow.html`（2026-09-22 加入平台侧栏入口，此前无任何入站链接） |
| B5 | 今日待确认 | 跨 Skill 聚合所有待办到一处，按严重度排序，逐条采纳/驳回；侧栏红点 | ✅ `modules/inbox/`（`_test-inbox.js` 21 项） |

**实现要点**：
- 运行时 `modules/skill/lib/engine.js`：数据注入（iteration calc / pradapter / plan，全部脱敏口径）→ 规则执行 → 输出统一落成「待确认项」→ 人工确认回灌采纳率（决策 3/7）。
- 权限：`skill:read`（pm/dev/viewer）、`skill:write`（pm）。
- 评测集 `_test-skill.js`：37 项断言（risk 11 / variance 9 / report 9 / engine 8）。
- 模型可插拔：当前为**规则引擎版**（确定性、可测、内网可用）；接外部模型时只需给每个 Skill 加一个 AI 后处理层（master 决策 6）。

**2026-09-22 修复（外部 review 发现，均已回归测试）**：
1. 周报风险节永远兑底 → `run('report')` 先跑 risk 同源注入（不再空壳）
2. `logAudit` 字段名 `detail` → `details`（skill + pradapter 两处，审计详情不再静默丢失）
3. report.js 硬编码 14 天 → 复用 risk.js `RULES.repoSilentDays`（文案跟随阈值）
4. PR 佐证靠仓库名猜中文关键词 → 改 config.json `repos[].teams` **显式映射**；未配置时不产生"缺佐证"噪音
5. 重跑 Skill 自动失效旧 pending 项（`expired`），采纳率分母/待确认数不虚高
6. `_test-gate.js` 写死模块数 → 改存在性断言
7. 小项：`results` 裁剪窗口 50→500；readBody 超 64KB 返 413 而非断连；dataflow.html 401/403 提示精确化

**2026-09-22 修复（外部 review 发现，均已回归测试，第二批）**：
8. **严重度值中英混用** → risk.js 发「高/中/低」，report/variance 的待确认项不带 severity、被兜底成 `'medium'`；
   下游按英文排序，5 条真正的高风险被当成未知值排到最后、高风险计数恒为 0。
   已在 `engine.normalizeItems` 收敛为 canonical `high|medium|low`（中文别名照收）。
9. **collectInputs 失败时静默产出空结果** → 裸 node 里跑 `engine.run()` 时全局 `TEAMS` 未注入，
   `calc.js` 抛 ReferenceError 被 catch 吞掉，`deviations=[]`，三个 Skill「运行成功」却把 82 条待办全标 expired。
   改为显式 `console.warn` 并提示常见原因。
10. `dataflow.html` 无任何入站链接（等于不存在）→ 加入平台侧栏 footer，`target="_blank"`。

## 4. M2-C（待用户输入）

| # | 任务 | 需要什么 |
|---|---|---|
| C1 | 接真实仓库 | 1-2 个真实仓库路径（或 GitHub/GitLab 地址 + 认证方式） |
| C2 | 团队工作台接入 | 对接团队填《对接规范》契约表（`plan-ai-m2-contract.md` §7） |

## 5. 关键决策记录（勿偏离）

- adapter 一律加在**平台这一侧**，团队零改动（master §4.2）。
- 不做"点对点硬编码"，统一走契约字段。
- L2 确认动作训练映射规则：点得多了 L2 自然升级 L1。
- 告警是"佐证缺失"信号，不是"完成度计算"。
- 数据分级遵循 `plan-ai-m1-data-masking.md`：代码仓库 = L3，只取统计特征（PR 数/合并率/评审耗时），不传原文进 AI。

## 6. 相关文档

- `plan-ai-master.md` §4.2/4.3（契约与映射）、§11 M2（路线图）
- `plan-ai-m1-data-masking.md`（脱敏红线，M2 接入卡点）
- `plan-dingtalk-checklist.md`（钉钉凭据清单，冻结项）