# Implementation Plan: Platform Architecture Upgrade (平台架构升级)

## Overview

This plan incrementally transforms the existing single-function iteration workbench into a multi-module management platform. The approach prioritizes the platform shell and iteration module refactor first (so the platform is immediately usable with existing functionality), then adds new modules one by one. All code uses vanilla JavaScript with zero runtime dependencies.

## Tasks

- [x] 1. Platform Shell Foundation (平台外壳基础)
  - [x] 1.1 Create `platform.html` — new platform entry point
    - New HTML file serving as the multi-module platform entry
    - Include three-zone layout skeleton: top navbar (48px), sidebar (200px), main content area
    - Pre-create module containers (`#module-dashboard`, `#module-iteration`, `#module-project`)
    - Link to `platform.css`, `shared-ui.js`, `router.js`, `platform.js`
    - Keep original `index.html` as standalone iteration entry (backward compatibility)
    - _Requirements: 1.1, 1.2, 1.3, 4.4, 10.1_

  - [x] 1.2 Create `platform.css` — responsive layout styles
    - Implement three-zone grid/flex layout: navbar, sidebar, main content
    - Sidebar styles: expanded (200px), collapsed (56px), hidden (mobile overlay)
    - Active nav item: left blue indicator bar + background highlight
    - Collapse/expand transition: `width 0.2s ease`
    - Responsive breakpoints: ≥1200px expanded, 768–1199px collapsed, <768px hidden+hamburger
    - Module container visibility classes (`.module-view.active` / `.module-view.hidden`)
    - Metric card grid, module entry card styles, quick access section layout
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.4, 2.6, 2.7, 17.1, 17.2, 17.3, 17.4_

  - [x] 1.3 Create `shared-ui.js` — shared UI component helpers
    - `renderMetricCard(icon, label, value, status)` — renders a metric card HTML string
    - `renderBreadcrumb(items)` — renders breadcrumb navigation
    - `renderModuleEntryCard(title, description, hash)` — renders module entry card
    - `toast(message, type)` — shows transient notification
    - `formatPct(value)` — formats decimal as ±X.X%
    - `formatCurrency(value)` — formats as ¥X.X
    - _Requirements: 5.2, 5.3, 5.4, 6.4, 3.7_

  - [x] 1.4 Create `router.js` — hash-based client-side router
    - Parse URL hash into `{ moduleId, subPath }` (split on `/` after `#/`)
    - Default to `dashboard` when hash is empty or `#/`
    - Fall back to dashboard for unregistered/disabled modules
    - On navigate: call current module's `leave()`, hide all containers, show target container
    - First activation calls `module.init(container, context)`; subsequent calls `module.enter(subPath)`
    - Update breadcrumb and sidebar active state after each route change
    - Bind `hashchange` event listener
    - Support route mappings: `#/dashboard`, `#/dashboard/budget`, `#/dashboard/token`, `#/iteration`, `#/iteration/{tab}`, `#/project`, `#/project/detail/{id}`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 1.5 Create `platform.js` — platform shell orchestrator
    - `Platform.init(modules)` — register modules, render sidebar nav items, render navbar, bind router
    - Render sidebar with module entries ordered by `order` field, with icon + name + optional badge
    - Sidebar collapse toggle: persist preference to `localStorage`, handle responsive resize
    - Mobile: hamburger button opens overlay sidebar, close on nav click or backdrop click
    - `Platform.toast()`, `Platform.setBreadcrumb()`, `Platform.setBadge()`, `Platform.toggleSidebar()`
    - Pre-create DOM containers for all registered modules at startup
    - Dashboard sub-pages (`#/dashboard/budget`, `#/dashboard/token`): keep 首页 nav item active
    - _Requirements: 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 2. Checkpoint — Platform shell renders correctly
  - Ensure platform.html loads with sidebar, navbar, and empty content area. Manually verify responsive breakpoints. Ask the user if questions arise.

- [x] 3. Server-Side Module Loader & Data Migration
  - [x] 3.1 Create `module-loader.js` — server-side dynamic module loading
    - `loadAll()` — scan `modules/` directory, require each sub-directory's `routes.js`
    - Register module route handlers with declared URL prefix
    - Log warning and skip on load failure (syntax error, missing file)
    - Call each module's `ensureData()` to initialize data directories
    - Validate no duplicate URL prefixes (throw on conflict)
    - Sort registered modules by prefix length descending (longest-prefix-first matching)
    - `dispatch(req, res, url)` — match request path against registered prefixes
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [x] 3.2 Create `migrate.js` — data migration logic
    - Detect migration needed: `data/state.json` exists but `data/iteration/state.json` does not
    - Copy `data/state.json` → `data/iteration/state.json`
    - Copy `data/history/*` → `data/iteration/history/`
    - Create empty state files for project, budget, token modules in respective directories
    - Write redirect marker to original `data/state.json`
    - Idempotent: safe to run multiple times, handles interruption gracefully
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

  - [x] 3.3 Refactor `server.js` — integrate module loader and migration
    - On startup: run migration check (call `migrate.js`), then call `moduleLoader.loadAll()`
    - Route dispatching: authentication check → SSE → dashboard API → module dispatch → legacy `/api/state` fallback → static files
    - Serve `platform.html` as default entry (while keeping `index.html` accessible)
    - Validate module IDs with `/^[a-z][a-z0-9-]*$/` pattern
    - Maintain 64MB body size limit, `updatedBy` tracking on writes
    - Security warning if no ACCESS_TOKEN configured
    - _Requirements: 8.6, 10.1, 10.2, 20.1, 20.2, 20.3, 20.4, 20.5_

  - [ ]* 3.4 Write property tests for module loader and migration
    - **Property 1: Module isolation — writing to one module does not alter another module's state**
    - **Property 2: Route determinism — same hash always parses to same moduleId and subPath**
    - **Property 5: Dashboard aggregation consistency — computed metrics match individual module data**
    - **Validates: Requirements 8.5, 3.1, 9.1, 9.3**

- [x] 4. Iteration Module Refactor
  - [x] 4.1 Create `modules/iteration/routes.js` — server-side iteration module
    - Export module definition: `{ id: 'iteration', prefix: '/api/iteration', handle(), ensureData() }`
    - `ensureData()` — ensure `data/iteration/` and `data/iteration/history/` exist
    - `handle()` — serve GET/POST for `/api/iteration/state` (reuse existing state logic from server.js)
    - Maintain backward compat: `/api/state` in server.js forwards to this handler
    - _Requirements: 10.1, 10.2, 10.3_

  - [x] 4.2 Create `modules/iteration/index.js` — client-side iteration module
    - Implement `ModuleDefinition` interface: `{ id: 'iteration', name: '阳光云迭代项目', icon: '📊', order: 1, init(), enter(), leave(), getSummary() }`
    - `init(container, context)` — render the existing 7-tab workbench UI (refactored from app.js)
    - `enter(subPath)` — activate specified tab (e.g., `analysis`, `contacts`)
    - `leave()` — pause any timers, unbind temporary event listeners
    - `getSummary()` — return deviation and cycle name for dashboard
    - Reuse existing `calc.js`, `config.js`, `parse.js` logic
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 10.1_

  - [x] 4.3 Adapt `sync.js` — enhance for multi-module SSE
    - Add `pushModule(moduleId, getState)` — submit state to `/api/{moduleId}/state`
    - Add `onModuleUpdate(moduleId, callback)` — subscribe to module-specific SSE events
    - SSE events now include `moduleId` field; events without moduleId default to `iteration`
    - Independent rev counters per module
    - Offline storage uses module-specific localStorage keys (`pending_{moduleId}`)
    - On reconnection: push pending changes per module, handle 409 conflicts per module
    - Preserve existing `push()` and `init()` signatures for backward compat
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 12.1, 12.2, 12.3, 12.4, 18.1, 18.2, 18.3, 18.4_

- [x] 5. Checkpoint — Iteration module works within new platform
  - Ensure the iteration workbench loads at `#/iteration` within the platform shell. Verify `/api/state` backward compatibility. Verify SSE events. Ask the user if questions arise.

- [x] 6. Dashboard Module
  - [x] 6.1 Create `modules/dashboard/routes.js` — server-side dashboard API
    - Export: `{ id: 'dashboard', prefix: '/api/dashboard', handle(), ensureData() }`
    - `GET /api/dashboard/summary` — read state files from all modules, aggregate metrics
    - Compute iteration deviation using existing `compute()` from `calc.js`
    - Project: count active and overdue projects
    - Budget: compute execution rate, count alerts
    - Token: read monthly cost and invocations from summary
    - Use zero-value defaults for any module whose state is missing/unparseable
    - Quick access data: merge alerts from project milestones + budget + token warnings (max 5)
    - Monthly deviation list from iteration data
    - Recent 3 archive records from `data/archive/`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 5.5, 5.6, 7.1, 7.2, 7.3, 7.4_

  - [x] 6.2 Create `modules/dashboard/index.js` — client-side dashboard module
    - Implement `ModuleDefinition`: `{ id: 'dashboard', name: '首页', icon: '🏠', order: 0 }`
    - `init()` — fetch `/api/dashboard/summary` and render full dashboard
    - Render 3 metric cards: 产能偏差 (±X.X%), 在研项目数 (X 个), Token月度消耗 (¥X.X)
    - Status indicators: warning when deviation >±10%, overdue projects exist, or token >80% budget
    - Render 2 module entry cards: 人力预算管理 → `#/dashboard/budget`, AI/Token使用记录 → `#/dashboard/token`
    - Render quick access: alerts list (max 5 + "查看全部"), monthly deviation summary, recent 3 archives
    - Sub-page routing: when subPath is `budget` render BudgetModule view, when `token` render TokenModule view
    - `enter(subPath)` — refresh data or switch to sub-page
    - On SSE update for any module while on dashboard → refresh aggregation
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 11.4, 19.4_

- [x] 7. Checkpoint — Dashboard shows live metrics
  - Ensure dashboard loads at `#/dashboard` with metric cards, entry cards, and quick access section. Verify zero-value fallback when module data is empty. Ask the user if questions arise.

- [x] 8. Project Module (全年度项目管理)
  - [x] 8.1 Create `modules/project/routes.js` — server-side project module
    - Export: `{ id: 'project', prefix: '/api/project', handle(), ensureData() }`
    - `ensureData()` — create `data/project/` and `data/project/history/` directories, init empty state
    - `GET /api/project/state` — return project state
    - `POST /api/project/state` — update project state with optimistic locking (rev check → 409 on conflict)
    - Validate: project IDs unique, status in enum, startDate ≤ endDate
    - `GET /api/project/milestones` — return upcoming milestones sorted by date
    - Record `updatedBy` on writes, save history snapshots
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 18.1, 18.4_

  - [x] 8.2 Create `modules/project/index.js` — client-side project module
    - Implement `ModuleDefinition`: `{ id: 'project', name: '全年度项目管理', icon: '📋', order: 2 }`
    - `init()` — fetch project state and render project list table
    - Project list: columns for name, productLine, status, priority, owner, dates, progress
    - Status badges with color coding (planned=gray, in-progress=blue, completed=green, suspended=orange)
    - Add/Edit project form with validation (required fields, date range check)
    - Detail sub-page at `#/project/detail/{id}`: milestones timeline, resource summary, linked iterations
    - `enter(subPath)` — parse subPath for list vs detail view
    - `leave()` — cleanup
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_

  - [ ]* 8.3 Write property tests for project module
    - **Property 3: Backward compatibility — /api/state returns identical response to pre-upgrade**
    - **Property 4: Optimistic lock monotonicity — each successful write increments rev**
    - Test project validation: unique IDs, valid status enum, startDate ≤ endDate
    - **Validates: Requirements 10.1, 18.4, 14.3, 14.4, 14.5**

- [x] 9. Budget Module (人力预算管理)
  - [x] 9.1 Create `modules/budget/routes.js` — server-side budget module
    - Export: `{ id: 'budget', prefix: '/api/budget', handle(), ensureData() }`
    - `ensureData()` — create `data/budget/` and `data/budget/history/`
    - `GET /api/budget/state` — return budget state
    - `POST /api/budget/state` — update with optimistic locking
    - Validate: team names exist in TEAMS config, quarterly has exactly 4 entries (Q1–Q4)
    - Auto-generate alerts when actual exceeds planned by >10% threshold
    - Record `updatedBy`, save history snapshots
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.7_

  - [x] 9.2 Create `modules/budget/index.js` — client-side budget module
    - Render as dashboard sub-page (within Dashboard module at `#/dashboard/budget`)
    - Breadcrumb: 首页 > 人力预算管理
    - Annual budget plan table: team × Q1–Q4 with editable cells, auto-save on change
    - Plan vs. actual comparison: CSS bar chart showing planned (light) vs actual (dark) per team
    - Warning indicator (⚠) when deviation exceeds threshold
    - Budget alerts list below chart
    - Excel export button (reuse existing xlsx devDependency via export-builder.js pattern)
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7_

- [x] 10. Token Module Placeholder (AI/Token 使用记录)
  - [x] 10.1 Create `modules/token/routes.js` — server-side token module
    - Export: `{ id: 'token', prefix: '/api/token', handle(), ensureData() }`
    - `ensureData()` — create `data/token/`, `data/token/history/`, `data/token/logs/`
    - `GET /api/token/state` — return token state (read-only endpoint)
    - Initialize with sample/empty token state if not exists
    - _Requirements: 16.1, 16.2_

  - [x] 10.2 Create `modules/token/index.js` — client-side token module
    - Render as dashboard sub-page (within Dashboard module at `#/dashboard/token`)
    - Breadcrumb: 首页 > AI/Token 使用记录
    - Monthly summary: total tokens, total cost, invocation count
    - Budget progress bar (current spend / monthly limit)
    - Metric card on dashboard: monthly cost (¥X.X) with status indicator
    - Placeholder content — detailed tracking deferred to future iteration
    - _Requirements: 16.1, 16.2, 16.3, 16.4_

- [x] 11. Error Resilience & Security Hardening
  - [x] 11.1 Implement error resilience across platform
    - Module load failure → sidebar shows disabled/gray nav item, platform continues
    - Corrupted state file → attempt restore from latest history snapshot; if none, init empty + notify user
    - Dashboard aggregation error for one module → show "数据异常" indicator, don't block others
    - _Requirements: 19.1, 19.2, 19.3, 19.4_

  - [x] 11.2 Implement security validations
    - Module ID validation: `/^[a-z][a-z0-9-]*$/` pattern on all module-related paths
    - POST body size limit enforcement (64MB)
    - `updatedBy` field recorded on every write operation
    - ACCESS_TOKEN check on all API requests when configured
    - Security warning to console when no ACCESS_TOKEN set
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5_

- [x] 12. Final Checkpoint — Full platform integration
  - Ensure all modules load correctly within the platform. Verify routing between all pages. Verify SSE broadcasts across modules. Verify data migration with existing state.json. Verify responsive layout at all breakpoints. Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The original `index.html` and `/api/state` endpoint remain functional for backward compatibility
- All server-side code maintains zero runtime dependencies (only Node.js built-ins)
- `xlsx` and `fast-check` remain as devDependencies only
- Each module's routes.js follows the same pattern: `{ id, prefix, handle(), ensureData() }`
- Client modules follow `ModuleDefinition` interface: `{ id, name, icon, order, init(), enter(), leave(), getSummary() }`
- Property tests validate the 5 correctness properties from the design document
- Budget and Token modules render as sub-pages of the Dashboard (accessed via `#/dashboard/budget` and `#/dashboard/token`)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["1.4", "1.5", "3.1", "3.2"] },
    { "id": 2, "tasks": ["3.3", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3"] },
    { "id": 4, "tasks": ["3.4", "6.1"] },
    { "id": 5, "tasks": ["6.2", "8.1"] },
    { "id": 6, "tasks": ["8.2", "9.1", "10.1"] },
    { "id": 7, "tasks": ["8.3", "9.2", "10.2"] },
    { "id": 8, "tasks": ["11.1", "11.2"] }
  ]
}
```
