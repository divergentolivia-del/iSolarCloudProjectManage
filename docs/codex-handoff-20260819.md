# Codex Handoff 2026-08-19

## 1. 本次目标

本次不是继续改业务代码，而是把后续安全交付规则沉淀到仓库，并把当前代码状态、Kiro 实现上下文、数据风险和验证方式整理成可交接文档。用户已同意将本次内容推送到独立远程分支。

## 2. 当前仓库状态

- 当前分支：`main`
- 远端：`origin https://github.com/divergentolivia-del/iSolarCloudProjectManage.git`
- 当前基线提交：`f346dca feat: add annual release planning view`
- `main` 与 `origin/main` 未显示 ahead/behind。
- 根目录未发现常见自动 CI/CD 配置文件，如 `.github/workflows`、`.gitlab-ci.yml`、`vercel.json`、`netlify.toml`。
- 部署指南明确要求服务器升级时不要传 `data` 目录，升级代码时替换 `js/css/html` 等代码文件并重启服务。

## 3. 当前未提交变更范围

只读检查发现当前工作区存在大量 `data/` 运行态变更：

- 已跟踪变更：`data/iteration/state.json` 大量内容变化，`data/state.json` 被删除。
- 未跟踪数据：`data/archive/2026-08-8.13.json`、`data/audit-log.json`、大量 `data/iteration/history/*.json`、`data/iteration/state.json.bak`。
- 这些文件更像平台运行数据、历史快照或审计记录，不应作为“代码改动”直接推送。

本次提交范围应只包含：

- `docs/codex-delivery-rules.md`
- `docs/codex-handoff-20260819.md`

## 4. Kiro 已沉淀的实现上下文

仓库中已有两组 Kiro 规格：

- `.kiro/specs/data-resilience-and-archiving/`
- `.kiro/specs/platform-architecture/`

`data-resilience-and-archiving` 规格描述的核心功能包括：

- `export-cli.js`：服务不可用时从 JSON 导出 Excel。
- `export-builder.js`：构建与原始 Excel 一致的 3 Sheet 工作簿。
- `archive.js`：创建、查询、删除迭代归档，并初始化下一迭代。
- `server.js`：归档相关 API 与 SSE 事件。
- `app.js` / `index.html`：归档按钮、历史归档 Tab、只读查看归档数据。

该规格的任务文件显示核心实现项已完成，但仍有多项测试任务被标为可选未完成，包括 archive 模块单测、CLI 导出测试、归档 API 集成测试和若干 property tests。

`platform-architecture` 规格描述的是从单功能工作台升级为多模块平台，包括 platform shell、hash router、module loader、dashboard、project/budget/token 模块等。当前任务清单未勾选，但仓库中已存在相关文件与模块目录，后续需要用代码和实际验证结果校准任务状态。

## 5. 数据与发布风险

- `data/` 是当前平台的状态、历史快照、归档和审计数据目录。直接提交或部署这些文件，可能把本地运行态数据带到远端或服务器。
- `data/iteration/state.json` 当前差异很大，不能在未确认的情况下提交。
- `data/state.json` 当前被删除，结合迁移逻辑看，这可能是平台架构升级后的状态，但仍需要确认线上数据目录结构后再处理。
- 部署文档明确服务器升级不要覆盖 `data` 目录。
- 本仓库未发现常见自动部署配置，但远端平台可能仍配置了外部部署规则。推送独立分支后，仍需在 GitHub/部署平台侧确认该分支是否会触发流水线。

## 6. 推荐提交和推送策略

推荐本次独立分支：

```bash
git switch -c codex/handoff-and-rules-20260819
git add docs/codex-delivery-rules.md docs/codex-handoff-20260819.md
git commit -m "docs: add codex handoff and delivery rules"
git push -u origin codex/handoff-and-rules-20260819
```

明确不要执行：

```bash
git add .
git reset --hard
git checkout -- .
git push origin main
git push --force
```

## 7. 验证建议

文档提交前：

```bash
git status -sb
git diff --name-only
```

代码验证：

```bash
npm test
```

实际执行结果（2026-08-19）：

- `_test-merge.js`：20 通过，0 失败
- `_test-server.js`：14 通过，3 失败
- 失败点集中在损坏 `state.json` 后的日志断言和 `.broken` 回退断言

部署前验证：

```bash
node server.js
node export-cli.js
```

注意：`node export-cli.js` 会生成 Excel 文件，执行前需确认输出文件是否要提交。默认不提交生成物。

## 8. Kiro 可直接执行的提示词

```text
你在仓库 E:\PMWork\Project Materials\iSolarCloudProject\迭代版本\iSolarCloudProjectManage 中工作。

请先读取 docs/codex-delivery-rules.md、docs/codex-handoff-20260819.md、部署指南.md，以及 .kiro/specs/data-resilience-and-archiving/ 和 .kiro/specs/platform-architecture/ 下的 requirements/design/tasks。

严格遵守：
1. 不覆盖现有 data/ 目录，不提交 data/iteration/state.json、data/state.json、data/archive、data/iteration/history、data/audit-log.json 等运行态数据。
2. 不执行 git reset、checkout --、强推、数据库迁移、seed/reset。
3. 不使用 git add .，只 stage 本次明确修改的代码或文档文件。
4. 如需推送，只推独立远程分支，不推 main。

请完成以下任务：
- 校准 Kiro tasks.md 与当前代码实际状态，列出已实现、未验证、缺测试的项。
- 针对 data-resilience-and-archiving，优先补齐 archive 模块单测、CLI 导出测试和归档 API 集成测试。
- 运行 npm test，记录结果。
- 输出改动清单、验证结果、数据风险和后续建议。
```

## 9. 后续建议

- 先把 `data/` 加强到 `.gitignore` 或改成只跟踪 `.gitkeep` 和示例数据，避免运行态数据反复进入 git status。
- 为 archive/export/platform 三组能力补齐自动化测试后，再考虑合并主分支。
- 若 GitHub 或部署平台配置了“任意分支自动部署”，建议改为仅 main/tag 部署，独立分支只用于代码审查。


