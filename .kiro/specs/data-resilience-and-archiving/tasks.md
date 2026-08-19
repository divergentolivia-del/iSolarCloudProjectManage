# Implementation Plan: Data Resilience and Archiving

## Overview

本实现计划将设计文档中的两大功能（CLI 导出工具 + 迭代归档系统）分解为增量式编码任务。每个任务构建在前置任务之上，最终将所有组件集成。实现语言为 JavaScript (Node.js)，核心服务保持零外部依赖，CLI 工具使用 `xlsx` (SheetJS) 作为 devDependency。

## Tasks

- [x] 1. Project setup and package initialization
  - [x] 1.1 Create `package.json` with project metadata and devDependencies
    - Initialize package.json with name `isolarcloud-project-manage`, version `1.0.0`
    - Add devDependencies: `xlsx` (SheetJS) for Excel generation, `fast-check` for property-based testing
    - Add scripts: `"test": "node --test _test-*.js"`, `"export": "node export-cli.js"`
    - Keep dependencies empty (zero-dependency core principle)
    - _Requirements: 4.1 (Export_Builder idempotency relies on xlsx library)_

  - [x] 1.2 Create `data/archive/` directory placeholder and ensure directory structure
    - Add `.gitkeep` in `data/archive/` to track the directory in version control
    - Verify `data/state.json` and `data/history/` paths exist per existing convention
    - _Requirements: 5.2 (archive records saved to `data/archive/{id}.json`)_

- [x] 2. Implement archive module (`archive.js`)
  - [x] 2.1 Implement `createArchive(state, meta)` function
    - Generate archive ID in format `YYYY-MM-{online-date}` from active cycle
    - Build `meta` object with id, name, archivedAt (server timestamp), archivedBy, note, cycle info, selected iterations, summary metrics, and rev
    - Compute summary metrics (totalWorkload, totalCapacity, overallDeviation, teamCount) using `calc.compute(state)`
    - Deep-copy state into the archive record as frozen snapshot via `JSON.parse(JSON.stringify(state))`
    - Check for duplicate ID and return error object if archive already exists
    - Use atomic write (tmp file + rename) to prevent partial writes
    - Auto-create `data/archive/` directory if not present
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x] 2.2 Implement `initNextIteration(currentState)` function
    - Clear `totals`, `board`, and `iterations` fields to empty arrays
    - Preserve `headcount` object with all team entries via deep copy
    - Preserve `locked` array via deep copy
    - Reset all cycle entries' `active` flag to false
    - Clear `sources` to empty object
    - Increment `rev` by 1
    - Set `updatedAt` to current server timestamp, `updatedBy` to '系统(初始化新迭代)'
    - Return the new state object without modifying the input
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x] 2.3 Implement `listArchives()` function
    - Scan `data/archive/` directory for `.json` files
    - Parse each file and extract only `meta` field (skip full state loading)
    - Skip corrupted/unparseable files without throwing
    - Return array sorted by `archivedAt` in descending order
    - Return empty array if directory doesn't exist or is empty
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 2.4 Implement `getArchive(id)` and `deleteArchive(id)` functions
    - `getArchive`: Read and return complete archive record (meta + state) by ID, return null if not found
    - `deleteArchive`: Remove archive file by ID, return `{ ok: true }` or `{ error: string }` if not found
    - Validate ID format matches `[\w.-]+` pattern to prevent path traversal
    - _Requirements: 9.1, 9.2, 10.1, 10.3, 13.3_

  - [x]* 2.5 Write unit tests for archive module (`_test-archive.js`)
    - Test `createArchive()`: normal creation with file verification and summary field correctness
    - Test `createArchive()`: duplicate ID rejection returns error
    - Test `initNextIteration()`: preserves headcount keys, clears totals/board/iterations, increments rev
    - Test `listArchives()`: empty directory returns [], corrupted files are skipped gracefully
    - Test `getArchive()`: normal read and null return for non-existent ID
    - Test `deleteArchive()`: successful deletion and error for non-existent ID
    - _Requirements: 5.1–5.7, 6.1–6.2, 7.1–7.6, 8.1–8.4_

  - [ ]* 2.6 Write property test for `initNextIteration` (Property 7)
    - **Property 7: Initialize next iteration completeness**
    - Use fast-check to generate arbitrary state objects with varying headcount, cycles, totals, board
    - Assert: headcount keys preserved identically, totals/board/iterations empty, rev incremented by 1
    - **Validates: Requirements 7.2, 7.3, 7.4, 7.6**

- [x] 3. Checkpoint - Ensure archive module tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement Excel export builder (`export-builder.js`)
  - [x] 4.1 Implement `buildWorkbook(state, computeResult)` main entry and `buildCapacitySheet` (Sheet 1)
    - Create workbook with exactly 3 sheets
    - Sheet 1 named `{月份}产能数据` (derive month label from active cycle)
    - Build team headcount matrix: departments as columns, regular/outsource/total as rows
    - Build version cycle plan table (seal, online, workdays, saturdays, dev period, active flag)
    - Include locked project list in right-side region
    - Set appropriate column widths
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 4.2 Implement `buildPlanningSheet` (Sheet 2 — 4 sections vertically stacked)
    - Section 1 (产品线版本工作量汇总): Product line workload summary from `computeResult.lineRows`
    - Section 2 (版本规划工作量汇总): Version planning workload summary from `computeResult.planRows`
    - Section 3 (云团队产能明细): Team capacity detail with headcount × days calculation
    - Section 4 (偏差分析): Deviation analysis from `computeResult.deviation` with footnotes
    - Separate sections with empty rows matching original Excel layout
    - _Requirements: 2.4_

  - [x] 4.3 Implement `buildStoryPointSheet` (Sheet 3 — raw iteration story points)
    - Group story point data by project (层级1)
    - Columns for each selected iteration showing story points and estimated story points
    - Build two-row header: iteration names (merged) + sub-headers (故事点/预估故事点)
    - Include 项目_公式辅助列 for project grouping
    - _Requirements: 2.5_

  - [ ]* 4.4 Write property test for `buildWorkbook` format consistency (Property 1 & 5)
    - **Property 1: CLI export format consistency**
    - **Property 5: Data completeness — any valid state produces 3-Sheet xlsx**
    - Use fast-check to generate arbitrary valid state objects with cycles (minLength: 1), headcount, locked, totals, board, iterations
    - Assert: buildWorkbook never throws and always returns workbook with exactly 3 SheetNames
    - Assert: Sheet names follow expected pattern
    - **Validates: Requirements 2.1, 2.2, 4.1**

  - [ ]* 4.5 Write property test for Sheet 2 section completeness (Property 8)
    - **Property 8: Sheet 2 must contain 4 section title rows**
    - Generate states with varying lineRows/planRows/deviation data
    - Assert: resulting sheet contains title rows for all 4 sections (产品线版本工作量汇总, 版本规划工作量汇总, 云团队产能明细, 偏差分析)
    - **Validates: Requirements 2.4**

- [x] 5. Implement CLI export tool (`export-cli.js`)
  - [x] 5.1 Implement CLI argument parsing and main flow
    - Parse `process.argv` for input path, `--output` option, `--quiet` flag, `--all-archives` flag
    - Default input to `data/state.json` when no argument provided
    - Default output to current directory with auto-derived filename `云平台人力产能-{online-date}.xlsx`
    - Detect archive file format (containing `meta` and `state` fields) and extract `state` for processing
    - Require `calc.js` and `export-builder.js` for computation and workbook building
    - _Requirements: 1.1, 1.2, 1.3, 3.4_

  - [x] 5.2 Implement input validation, error handling, and batch export mode
    - Validate file existence: output Chinese error to stderr + exit code 1 if file not found
    - Validate JSON parsing: output parse error details + suggest trying history snapshots
    - Validate state structure: warn about missing fields (cycles, headcount, locked, totals, iterations), generate workbook with empty sections for missing data
    - Implement `--all-archives` mode: scan `data/archive/` and export each file as individual xlsx
    - Print output file path and summary to stdout on success (unless `--quiet`)
    - _Requirements: 1.4, 1.5, 3.1, 3.2, 3.3_

  - [x]* 5.3 Write unit tests for CLI export (`_test-export.js`)
    - Test `validateState()` for valid and invalid inputs
    - Test `deriveOutputPath()` for various cycle configurations
    - Test `buildWorkbook()` output contains exactly 3 sheets with correct names
    - Test Sheet 1 headcount matrix has correct row count
    - Test Sheet 2 contains 4 section title rows
    - Test Sheet 3 groups by project with iteration column headers
    - Test empty state (no totals/board) graceful degradation
    - Test archive file detection (meta + state structure)
    - _Requirements: 1.1–1.5, 2.1–2.5, 3.1–3.4, 4.1–4.3_

  - [ ]* 5.4 Write property test for CLI export idempotency (Property 2)
    - **Property 2: CLI export idempotency**
    - For same input state, buildWorkbook produces identical content on repeated calls
    - Generate arbitrary valid states, call buildWorkbook twice, compare Sheet data cell-by-cell
    - **Validates: Requirements 4.1, 4.2**

- [x] 6. Checkpoint - Ensure CLI export and builder tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Integrate archive API routes into `server.js`
  - [x] 7.1 Add archive API routes (GET /api/archive/list, GET /api/archive/:id, POST /api/archive)
    - `GET /api/archive/list`: Invoke `archive.listArchives()`, return array
    - `GET /api/archive/:id`: Validate ID format `[\w.-]+`, invoke `archive.getArchive(id)`, return 404 if null
    - `POST /api/archive`: Parse body for name/note/archivedBy, validate ACCESS_TOKEN, invoke `archive.createArchive()`, broadcast SSE event on success, return result
    - Reject IDs containing path traversal characters (`..` or `/`)
    - _Requirements: 5.1, 8.1, 9.1, 9.2, 13.1, 13.3, 14.1_

  - [x] 7.2 Add init-next and delete archive routes (POST /api/archive/init-next, DELETE /api/archive/:id)
    - `POST /api/archive/init-next`: Validate ACCESS_TOKEN, invoke `archive.initNextIteration(readState())`, call `writeState(newState)`, broadcast SSE state-reset event, return response with cleared/preserved/newRev
    - `DELETE /api/archive/:id`: Validate ACCESS_TOKEN, validate ID format, invoke `archive.deleteArchive(id)`, return result or error
    - Broadcast appropriate SSE events for state changes
    - _Requirements: 7.1, 7.7, 10.1, 10.2, 10.3, 13.1, 13.2, 14.2_

  - [x]* 7.3 Write integration tests for archive API endpoints
    - Test POST /api/archive: creates file with correct structure and summary
    - Test POST /api/archive (duplicate): returns 409 conflict
    - Test POST /api/archive/init-next: state.json is cleared correctly
    - Test GET /api/archive/list: returns correct format sorted by date
    - Test GET /api/archive/:id: returns complete data and 404 for missing
    - Test DELETE /api/archive/:id: file removed, returns ok
    - Test ACCESS_TOKEN validation on protected endpoints
    - _Requirements: 5.1–5.7, 7.1–7.7, 8.1–8.4, 9.1–9.2, 10.1–10.3, 13.1–13.3_

- [x] 8. Implement Archive UI in `app.js` and `index.html`
  - [x] 8.1 Add "归档本迭代" button and confirmation dialog
    - Add prominent "归档本迭代" button with primary/emphasis styling in the deviation analysis tab or top action area
    - Implement confirmation dialog showing: current iteration name, version cycle, key metrics (total workload, total capacity, overall deviation), and explanation that archived data is permanently preserved
    - On confirm: send POST /api/archive request, display success toast
    - After success: prompt "是否初始化下一迭代？" with "是" and "稍后" options
    - If "是" selected: send POST /api/archive/init-next, refresh UI to blank state
    - Disable archive button with tooltip when service connection unavailable
    - Add second confirmation dialog for init-next (destructive operation)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 13.4_

  - [x] 8.2 Add "历史归档" tab (7th tab) with timeline view
    - Add new tab in the tab bar as the 7th tab labeled "历史归档"
    - On tab activation: fetch GET /api/archive/list
    - Render archive cards in reverse chronological order showing: name, date, version cycle, deviation summary, operator name
    - On card click: fetch GET /api/archive/:id, enter read-only mode
    - _Requirements: 12.1, 12.2, 12.3_

  - [x] 8.3 Implement read-only archive viewing mode
    - Display top banner: "正在查看 YYYY年MM月 归档数据" with "返回当前迭代" button
    - Render all tabs (headcount, cycles, planning, deviation, story points) using archived state data
    - Disable all editing controls (inputs, buttons, checkboxes) in read-only mode
    - "返回当前迭代" button restores normal editing mode with current state
    - _Requirements: 6.3, 9.3, 9.4, 12.3, 12.4_

  - [x] 8.4 Implement SSE event handling for archive events
    - Listen for archive-created SSE event: refresh archive list if on history tab
    - Listen for state-reset SSE event: refresh interface to reflect new blank iteration state
    - Handle reconnection gracefully after service restart
    - _Requirements: 14.1, 14.2, 14.3_

- [x] 9. Checkpoint - Ensure all tests pass and UI integration complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Wire everything together and final validation
  - [x] 10.1 Wire export-builder into archive read-only view for Excel download
    - Add "导出为Excel" button in archive read-only mode
    - When clicked: compute archived state, build workbook, trigger browser download
    - Reuse export-builder.js logic for consistent output format
    - _Requirements: 1.1, 2.1–2.5 (export from archive view)_

  - [ ]* 10.2 Write property test for archive immutability (Property 3)
    - **Property 3: Archive immutability**
    - Create archive, then modify state.json via writeState, read archive again
    - Assert: archive state content is identical before and after state modification
    - **Validates: Requirements 6.1, 6.2**

  - [ ]* 10.3 Write property test for archive uniqueness (Property 4)
    - **Property 4: Archive uniqueness**
    - Attempt to create two archives with the same active cycle in the same month
    - Assert: first succeeds (ok: true), second fails (error defined)
    - **Validates: Requirements 5.6**

  - [ ]* 10.4 Write property test for archive restorability (Property 6)
    - **Property 6: Archive restorability**
    - For each archive created, extract its state, compute, and build workbook
    - Assert: workbook has exactly 3 sheets (archived data is always exportable)
    - **Validates: Requirements 1.1, 2.1**

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design uses JavaScript (Node.js) throughout — no language selection needed
- `xlsx` (SheetJS) is used only as devDependency in CLI tool, not in core server runtime
- Core server (`server.js`) maintains zero external dependencies — `archive.js` uses only Node.js built-in modules
- The existing `archive()` function in server.js (history snapshots) is separate from the new Archive module — no conflict

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3", "2.4"] },
    { "id": 2, "tasks": ["2.5", "2.6", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3"] },
    { "id": 4, "tasks": ["4.4", "4.5", "5.1"] },
    { "id": 5, "tasks": ["5.2"] },
    { "id": 6, "tasks": ["5.3", "5.4", "7.1"] },
    { "id": 7, "tasks": ["7.2"] },
    { "id": 8, "tasks": ["7.3", "8.1"] },
    { "id": 9, "tasks": ["8.2", "8.3"] },
    { "id": 10, "tasks": ["8.4", "10.1"] },
    { "id": 11, "tasks": ["10.2", "10.3", "10.4"] }
  ]
}
```
