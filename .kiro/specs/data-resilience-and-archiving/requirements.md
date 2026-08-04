# Requirements Document

## Introduction

本文档定义「数据韧性与归档」功能的正式需求，涵盖两项核心能力：

1. **JSON-to-Excel 兜底导出工具** — 独立 CLI 脚本，在服务不可用时将 JSON 状态文件还原为与原始 Excel（`云平台-2026年7月人力情况.xlsx`）格式完全一致的 3-Sheet `.xlsx` 文件。
2. **迭代归档与历史数据管理** — 在每月产能评审会完成后，将当前迭代数据归档为检查点，支持初始化下一迭代、按月浏览历史归档。

两项功能共享核心目标：无论服务崩溃、数据损坏、还是业务周期推进，用户始终能以可读形式访问完整的历史产能数据。

## Glossary

- **CLI_Export_Tool**: 命令行导出工具 (`export-cli.js`)，独立于 HTTP 服务运行，读取 JSON 文件并生成 Excel 工作簿
- **Export_Builder**: Excel 构建模块 (`export-builder.js`)，纯函数模块，接收 state 和计算结果，返回 3-Sheet XLSX Workbook
- **Archive_Module**: 归档逻辑层 (`archive.js`)，管理归档的创建、查询、校验
- **Server**: HTTP 服务器 (`server.js`)，提供 API 端点和 SSE 广播
- **Archive_UI**: 浏览器端归档交互界面，包含归档按钮、确认对话框、历史时间线
- **State**: 系统当前状态对象 (`data/state.json`)，包含 cycles、headcount、locked、totals、board、iterations 等字段
- **Archive_Record**: 归档文件 (`data/archive/YYYY-MM-{online-date}.json`)，包含 meta 元数据和完整 state 快照
- **Iteration**: 一个月度产能规划周期，从数据填报到评审会确认为一个完整迭代
- **Checkpoint**: 归档操作的语义——冻结当前迭代数据作为该迭代的最终记录
- **Compute_Result**: `calc.compute(state)` 的返回值，包含偏差分析、产能汇总等计算结果

## Requirements

### Requirement 1: CLI 导出工具基本执行

**User Story:** As a 运维人员, I want to export JSON state files to Excel via command line, so that I can recover readable reports when the web service is unavailable.

#### Acceptance Criteria

1. WHEN the CLI_Export_Tool is invoked with a valid JSON file path, THE CLI_Export_Tool SHALL read the file, compute derived data, build an Excel workbook, and write it to the output path
2. WHEN the CLI_Export_Tool is invoked without arguments, THE CLI_Export_Tool SHALL default to reading `data/state.json` and output to the current directory
3. WHEN the CLI_Export_Tool is invoked with `--output` option, THE CLI_Export_Tool SHALL write the Excel file to the specified path
4. WHEN the CLI_Export_Tool is invoked with `--all-archives` flag, THE CLI_Export_Tool SHALL export all JSON files in `data/archive/` directory as individual Excel files
5. WHEN the CLI_Export_Tool completes successfully, THE CLI_Export_Tool SHALL print the output file path and a summary to stdout

### Requirement 2: Excel 工作簿格式一致性

**User Story:** As a 运维人员, I want the exported Excel to match the original file format exactly, so that stakeholders can read it without noticing any difference from the original template.

#### Acceptance Criteria

1. THE Export_Builder SHALL produce a workbook containing exactly 3 sheets
2. THE Export_Builder SHALL name Sheet 1 as `{月份}产能数据`, Sheet 2 as `规划与产能分析`, and Sheet 3 as `人力工时数据`
3. WHEN building Sheet 1, THE Export_Builder SHALL include a team headcount matrix (departments as columns, regular/outsource/total as rows), a version cycle plan table, and a locked project list
4. WHEN building Sheet 2, THE Export_Builder SHALL include 4 vertically stacked sections: product-line workload summary, version planning workload summary, team capacity detail, and deviation analysis
5. WHEN building Sheet 3, THE Export_Builder SHALL group story point data by project (层级1) with columns for each selected iteration showing story points and estimated story points

### Requirement 3: CLI 输入验证与错误处理

**User Story:** As a 运维人员, I want clear error messages in Chinese when something goes wrong, so that I can quickly diagnose and fix the issue.

#### Acceptance Criteria

1. WHEN the specified input file does not exist or is unreadable, THE CLI_Export_Tool SHALL output a Chinese error message to stderr and exit with code 1
2. WHEN the input file contains invalid JSON, THE CLI_Export_Tool SHALL output an error message including the parse error details and suggest trying history snapshots
3. WHEN the state object is missing required fields (cycles, headcount, locked, totals, iterations), THE CLI_Export_Tool SHALL output a warning listing missing fields and generate the workbook with empty sections for missing data
4. WHEN the input file is an archive record (containing `meta` and `state` fields), THE CLI_Export_Tool SHALL extract the `state` field and process it as the state object

### Requirement 4: CLI 导出幂等性与纯函数性

**User Story:** As a 运维人员, I want consistent and predictable export results, so that I can trust the output for audit and comparison purposes.

#### Acceptance Criteria

1. THE Export_Builder SHALL produce identical workbook content when given the same state and compute result inputs
2. THE Export_Builder SHALL not modify the input state object or compute result object
3. WHEN deriving the output filename automatically, THE CLI_Export_Tool SHALL use the pattern `云平台人力产能-{online-date}.xlsx` based on the active cycle's online date

### Requirement 5: 创建迭代归档

**User Story:** As a 项目经理, I want to archive the current iteration after the capacity review meeting, so that the iteration data is permanently preserved as a checkpoint.

#### Acceptance Criteria

1. WHEN a user submits a POST request to `/api/archive` with name and note, THE Server SHALL invoke the Archive_Module to create an archive record
2. WHEN creating an archive, THE Archive_Module SHALL generate a unique ID in format `YYYY-MM-{online-date}` and save the file to `data/archive/{id}.json`
3. WHEN creating an archive, THE Archive_Module SHALL include a `meta` object with id, name, archivedAt (server timestamp), archivedBy, note, cycle info, selected iterations, summary metrics, and rev number
4. WHEN creating an archive, THE Archive_Module SHALL deep-copy the current state into the archive record as a frozen snapshot
5. WHEN creating an archive, THE Archive_Module SHALL compute summary metrics (totalWorkload, totalCapacity, overallDeviation, teamCount) from the state
6. WHEN an archive with the same ID already exists, THE Archive_Module SHALL reject the creation and return an error message
7. WHEN writing the archive file, THE Archive_Module SHALL use atomic write (tmp file + rename) to prevent partial writes

### Requirement 6: 归档不可变性

**User Story:** As a 项目经理, I want archived data to remain unchanged regardless of subsequent edits, so that I have a reliable historical record for year-end review.

#### Acceptance Criteria

1. THE Archive_Module SHALL not expose any API endpoint that modifies the content of an existing archive record
2. WHEN the current state.json is modified after an archive is created, THE Archive_Record SHALL retain its original state data unchanged
3. WHEN viewing an archived iteration, THE Archive_UI SHALL render all data in read-only mode with all editing controls disabled

### Requirement 7: 初始化下一迭代

**User Story:** As a 项目经理, I want to initialize the next iteration after archiving, so that I can start fresh data entry for the new month while retaining the team structure.

#### Acceptance Criteria

1. WHEN a user submits a POST request to `/api/archive/init-next`, THE Server SHALL invoke the Archive_Module to create a new blank state
2. WHEN initializing the next iteration, THE Archive_Module SHALL clear the totals, board, and iterations fields to empty arrays
3. WHEN initializing the next iteration, THE Archive_Module SHALL preserve the headcount object with all team entries and values intact (deep copy)
4. WHEN initializing the next iteration, THE Archive_Module SHALL preserve the locked array (cross-iteration projects) with values intact
5. WHEN initializing the next iteration, THE Archive_Module SHALL reset all cycle entries' active flag to false
6. WHEN initializing the next iteration, THE Archive_Module SHALL increment the rev number by 1
7. WHEN initialization succeeds, THE Server SHALL write the new state to state.json and broadcast the change via SSE

### Requirement 8: 归档列表查询

**User Story:** As a 项目经理, I want to browse all historical archives in a timeline view, so that I can review past iterations and track capacity trends over time.

#### Acceptance Criteria

1. WHEN a user submits a GET request to `/api/archive/list`, THE Server SHALL return an array of archive metadata objects sorted by archivedAt in descending order
2. WHEN listing archives, THE Archive_Module SHALL return only metadata (id, name, archivedAt, archivedBy, note, cycle, iterations, summary, rev) without loading full state data
3. WHEN the archive directory does not exist or is empty, THE Archive_Module SHALL return an empty array
4. WHEN an archive file is corrupted or unparseable, THE Archive_Module SHALL skip that file and continue processing remaining archives

### Requirement 9: 归档详情查看

**User Story:** As a 项目经理, I want to view the full data of any archived iteration, so that I can review historical capacity details and compare across months.

#### Acceptance Criteria

1. WHEN a user submits a GET request to `/api/archive/:id`, THE Server SHALL return the complete archive record including meta and state
2. WHEN the requested archive ID does not exist, THE Server SHALL return HTTP 404 with an error message
3. WHEN viewing archive details, THE Archive_UI SHALL display a banner indicating "正在查看 YYYY年MM月 归档数据" with a "返回当前迭代" button
4. WHEN viewing archive details, THE Archive_UI SHALL render all tabs (headcount, cycles, planning, deviation, story points) using the archived state data

### Requirement 10: 归档删除

**User Story:** As a 管理员, I want to delete erroneous archives, so that I can correct mistakes in the archiving process.

#### Acceptance Criteria

1. WHEN a user submits a DELETE request to `/api/archive/:id` with a valid ACCESS_TOKEN, THE Server SHALL remove the archive file
2. WHEN a DELETE request lacks a valid ACCESS_TOKEN, THE Server SHALL reject the request
3. WHEN the specified archive ID does not exist, THE Server SHALL return an error response

### Requirement 11: 归档 UI 交互 — 归档按钮与确认

**User Story:** As a 项目经理, I want a prominent archive button with a confirmation dialog, so that I don't accidentally archive and I understand what data is being preserved.

#### Acceptance Criteria

1. THE Archive_UI SHALL display a prominent "归档本迭代" button in the deviation analysis tab or top action area with primary/emphasis styling
2. WHEN the user clicks the archive button, THE Archive_UI SHALL display a confirmation dialog showing the current iteration name, version cycle, key metrics summary (total workload, total capacity, overall deviation), and an explanation that archived data is permanently preserved
3. WHEN the user confirms the archive, THE Archive_UI SHALL send the archive request and display a success toast upon completion
4. WHEN the archive succeeds, THE Archive_UI SHALL prompt the user with "是否初始化下一迭代？" offering "是" and "稍后" options
5. WHEN the service connection is unavailable, THE Archive_UI SHALL disable the archive button with a tooltip explaining that archiving requires an online connection

### Requirement 12: 历史归档时间线 UI

**User Story:** As a 项目经理, I want a timeline tab to browse archived months, so that I can quickly find and review any past iteration's data.

#### Acceptance Criteria

1. THE Archive_UI SHALL provide a "历史归档" tab (the 7th tab) displaying all archives as cards in reverse chronological order
2. WHEN displaying archive cards, THE Archive_UI SHALL show the archive name, date, version cycle, deviation summary, and operator name
3. WHEN the user clicks an archive card, THE Archive_UI SHALL enter read-only mode displaying the full archived data across all tabs
4. WHEN in read-only mode viewing an archive, THE Archive_UI SHALL display a top banner with the archive date and a "返回当前迭代" button

### Requirement 13: 安全与访问控制

**User Story:** As a 系统管理员, I want archive operations to be protected by access control, so that unauthorized users cannot create, delete, or reset iteration data.

#### Acceptance Criteria

1. WHEN a POST request to `/api/archive` or `/api/archive/init-next` is received, THE Server SHALL validate the ACCESS_TOKEN before processing
2. WHEN a DELETE request to `/api/archive/:id` is received, THE Server SHALL validate the ACCESS_TOKEN before processing
3. WHEN validating archive IDs from URL paths, THE Server SHALL reject IDs containing path traversal characters (`.." or `/`) and only accept IDs matching the pattern `[\w.-]+`
4. WHEN the Archive_UI triggers a destructive operation (init-next), THE Archive_UI SHALL require a second confirmation dialog before sending the request

### Requirement 14: 归档事件广播

**User Story:** As a 协同用户, I want to be notified in real-time when an archive is created or the iteration is reset, so that I am aware of state changes without refreshing.

#### Acceptance Criteria

1. WHEN an archive is successfully created, THE Server SHALL broadcast an SSE event to all connected clients indicating the archive creation
2. WHEN the next iteration is initialized, THE Server SHALL broadcast an SSE event to all connected clients indicating the state reset
3. WHEN a client receives a state-reset SSE event, THE Archive_UI SHALL refresh the interface to reflect the new blank iteration state
