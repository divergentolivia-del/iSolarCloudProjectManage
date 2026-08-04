# Requirements Document

## Introduction

本文档定义了「云平台管理工作台」从单功能迭代管理工具升级为多模块管理平台的功能需求。平台采用「外壳 + 模块」架构，核心聚焦于项目管理（阳光云迭代项目 + 全年度专项项目）和人力/成本预算管理，Token使用记录作为低优先级占位模块。

## Glossary

- **Platform_Shell（平台外壳）**: 提供统一导航、路由、认证和共享基础设施的顶层容器框架
- **Router（路由器）**: 基于 URL hash 实现模块级和模块内部页面导航的组件
- **Module_Loader（模块加载器）**: 服务端动态加载各模块路由处理器的组件
- **Dashboard（仪表盘）**: 平台首页，展示全局概览指标和模块入口
- **Sidebar（侧边栏）**: 左侧固定导航栏，提供一级模块导航
- **Sync_Layer（同步层）**: 管理客户端与服务端的数据同步（含离线暂存和SSE广播）
- **Iteration_Module（迭代模块）**: 现有阳光云迭代项目工作台，包含7个Tab功能
- **Project_Module（项目模块）**: 全年度专项项目管理台账
- **Budget_Module（预算模块）**: 人力预算管理功能
- **Token_Module（Token模块）**: AI/Token 使用记录占位模块（低优先级）
- **Metric_Card（指标卡片）**: 仪表盘上展示关键指标数值和状态的卡片组件
- **Module_Entry_Card（模块入口卡片）**: 仪表盘上引导用户进入子页面的入口卡片
- **Breadcrumb（面包屑）**: 显示当前页面在导航层级中位置的路径指示器
- **Optimistic_Lock（乐观锁）**: 基于 rev 版本号的并发写入冲突检测机制
- **SSE（Server-Sent Events）**: 服务端向客户端推送实时事件的通信机制

## Requirements

### Requirement 1: Platform Shell Layout

**User Story:** As a platform user, I want a consistent three-zone layout (top navbar + left sidebar + main content), so that I can navigate between modules efficiently.

#### Acceptance Criteria

1. THE Platform_Shell SHALL render a top navbar of 48px height containing brand logo, platform title, username display, notification icon, and settings entry
2. THE Platform_Shell SHALL render a fixed left Sidebar of 200px width containing module navigation items ordered by their configured `order` value
3. THE Platform_Shell SHALL render a main content area that fills the remaining viewport width after the Sidebar
4. WHEN the platform loads, THE Platform_Shell SHALL initialize all registered modules and bind the hashchange event listener
5. WHEN a module is registered, THE Platform_Shell SHALL add a navigation entry to the Sidebar displaying the module's icon, name, and optional badge count

### Requirement 2: Sidebar Navigation

**User Story:** As a user, I want a collapsible sidebar with clear active state indicators, so that I always know which module I'm viewing and can save screen space when needed.

#### Acceptance Criteria

1. THE Sidebar SHALL display exactly three primary navigation items: 首页 (`#/dashboard`), 阳光云迭代项目 (`#/iteration`), and 全年度项目管理 (`#/project`)
2. WHEN a navigation item is active, THE Sidebar SHALL highlight it with a left blue indicator bar and background color change
3. WHEN the user is on a dashboard sub-page (`#/dashboard/budget` or `#/dashboard/token`), THE Sidebar SHALL keep the 首页 navigation item in active state
4. WHEN the user clicks the collapse button on desktop, THE Sidebar SHALL toggle between expanded mode (200px, icon + text) and collapsed mode (56px, icon only with tooltip on hover)
5. THE Sidebar SHALL persist the user's collapse preference to localStorage
6. WHILE the viewport width is between 768px and 1199px, THE Sidebar SHALL default to collapsed mode (56px)
7. WHILE the viewport width is less than 768px, THE Sidebar SHALL be hidden by default and accessible via a hamburger menu as an overlay
8. WHEN a navigation item is clicked in mobile overlay mode, THE Sidebar SHALL close the overlay after navigation

### Requirement 3: Hash-Based Routing

**User Story:** As a user, I want URL-based navigation that supports browser back/forward, so that I can bookmark pages and use standard browser navigation.

#### Acceptance Criteria

1. WHEN the URL hash changes, THE Router SHALL parse it into a moduleId and subPath by splitting on `/` after the `#/` prefix
2. WHEN no hash is present or hash is `#/`, THE Router SHALL default to `dashboard` as the moduleId with empty subPath
3. WHEN the parsed moduleId does not correspond to a registered and enabled module, THE Router SHALL fall back to the dashboard module
4. WHEN navigating to a new module, THE Router SHALL call the current active module's `leave()` hook before activating the new module
5. WHEN a module is activated for the first time, THE Router SHALL call its `init(container, context)` method
6. WHEN a previously initialized module is re-activated, THE Router SHALL call its `enter(subPath)` method instead of `init()`
7. THE Router SHALL update the Breadcrumb to reflect the current navigation path after each route change
8. THE Router SHALL support the following route-to-module mappings: `#/dashboard` → Dashboard, `#/dashboard/budget` → Budget sub-page, `#/dashboard/token` → Token sub-page, `#/iteration` → Iteration_Module, `#/iteration/{tab}` → Iteration sub-tab, `#/project` → Project_Module, `#/project/detail/{id}` → Project detail page

### Requirement 4: Module Lifecycle Management

**User Story:** As a developer, I want a standardized module interface with lifecycle hooks, so that modules can be independently developed and consistently managed by the platform.

#### Acceptance Criteria

1. THE Platform_Shell SHALL require each module to implement the ModuleDefinition interface containing: id, name, icon, order, init(), enter(), leave(), and getSummary()
2. WHEN a module's `init()` is called, THE Platform_Shell SHALL pass the module's DOM container element and a context object containing the subPath and platform reference
3. WHEN switching between modules, THE Platform_Shell SHALL hide all module containers via CSS class and show only the target module's container
4. THE Platform_Shell SHALL pre-create DOM containers for all registered modules at startup
5. WHEN a module has been initialized, THE Platform_Shell SHALL preserve its DOM state across module switches to avoid re-rendering

### Requirement 5: Dashboard Metric Cards

**User Story:** As a manager, I want to see key metrics (产能偏差, 在研项目数, Token月度消耗) at a glance on the dashboard, so that I can quickly assess platform health.

#### Acceptance Criteria

1. WHEN the dashboard loads, THE Dashboard SHALL display exactly 3 metric cards: 产能偏差, 在研项目数, and Token月度消耗
2. THE Dashboard SHALL display 产能偏差 as a percentage value with sign (±X.X%), showing warning status when deviation exceeds ±10%
3. THE Dashboard SHALL display 在研项目数 as a count with unit (X 个), showing warning status when overdue projects exist
4. THE Dashboard SHALL display Token月度消耗 as a monetary value (¥X.X) with normal status indicator
5. WHEN the dashboard loads, THE Dashboard SHALL fetch aggregated data from the `/api/dashboard/summary` endpoint
6. IF a module's data is unavailable during aggregation, THEN THE Dashboard SHALL display zero-value defaults for that module's metric card without blocking other cards

### Requirement 6: Dashboard Module Entry Cards

**User Story:** As a user, I want quick entry cards on the dashboard to access sub-modules (人力预算管理, AI/Token使用记录), so that I can navigate to these functions without cluttering the sidebar.

#### Acceptance Criteria

1. THE Dashboard SHALL display two module entry cards: 人力预算管理 and AI/Token使用记录
2. WHEN the user clicks the 人力预算管理 entry card, THE Dashboard SHALL navigate to `#/dashboard/budget`
3. WHEN the user clicks the AI/Token使用记录 entry card, THE Dashboard SHALL navigate to `#/dashboard/token`
4. THE Dashboard module entry cards SHALL display a title, brief description, and an action button

### Requirement 7: Dashboard Quick Access Section

**User Story:** As a user, I want to see alerts, deviation summaries, and recent archives on the dashboard, so that I can quickly identify issues requiring attention.

#### Acceptance Criteria

1. THE Dashboard quick access section SHALL display a combined alerts list sourcing from overdue milestones (Project_Module), budget alerts (Budget_Module), and Token warnings (Token_Module)
2. THE Dashboard SHALL display a maximum of 5 alert items, with a "查看全部" link when more exist
3. THE Dashboard SHALL display a monthly deviation summary list showing per-team deviation percentages from the Iteration_Module
4. THE Dashboard SHALL display the 3 most recent archive records from the archive directory

### Requirement 8: Server-Side Module Loading

**User Story:** As a developer, I want the server to dynamically load module route handlers from a modules/ directory, so that adding new modules doesn't require modifying core server code.

#### Acceptance Criteria

1. WHEN the server starts, THE Module_Loader SHALL scan the `modules/` directory and load each sub-directory's `routes.js` file
2. THE Module_Loader SHALL register each module's route handler with its declared URL prefix
3. WHEN a module's `routes.js` fails to load (syntax error or missing), THE Module_Loader SHALL log a warning and continue loading remaining modules
4. THE Module_Loader SHALL call each module's `ensureData()` method to initialize its data directory structure
5. THE Module_Loader SHALL ensure no two modules share the same URL prefix
6. WHEN dispatching an HTTP request, THE Module_Loader SHALL match the request path against registered module prefixes using longest-prefix-first matching

### Requirement 9: Dashboard Data Aggregation API

**User Story:** As the dashboard component, I want a single API endpoint that returns aggregated metrics from all modules, so that the dashboard can load data efficiently.

#### Acceptance Criteria

1. WHEN a GET request is made to `/api/dashboard/summary`, THE Server SHALL read state files from all modules (iteration, project, budget, token) and return an aggregated JSON response
2. THE aggregation response SHALL contain sub-objects for iteration (deviation, cycleName), project (active count, overdue count), budget (execution rate, alert count), and token (monthly cost, invocations)
3. IF a module's state file is missing or unparseable, THEN THE Server SHALL use zero-value defaults for that module's metrics without returning an error
4. THE Server SHALL compute iteration deviation as `(workload - capacity) / capacity` using the existing `compute()` function

### Requirement 10: Backward-Compatible Iteration API

**User Story:** As an existing user of the iteration workstation, I want the existing `/api/state` endpoint to continue working unchanged, so that my workflow is not disrupted by the platform upgrade.

#### Acceptance Criteria

1. THE Server SHALL continue to serve GET and POST requests on `/api/state` with identical behavior to the pre-upgrade version
2. WHEN a request is made to `/api/state`, THE Server SHALL route it to the Iteration_Module's handler transparently
3. THE Server SHALL maintain the existing `/api/events` SSE endpoint with unchanged event format for clients that do not specify a module filter

### Requirement 11: Multi-Module SSE Synchronization

**User Story:** As a user collaborating with teammates, I want real-time updates when any module's data changes, so that I always see the latest information.

#### Acceptance Criteria

1. WHEN a module's state is updated via POST, THE Sync_Layer SHALL broadcast an SSE event containing the moduleId and new rev number to all connected clients
2. THE Sync_Layer SHALL maintain independent rev counters for each module
3. WHEN a client receives an SSE update event for the module it is currently viewing, THE Sync_Layer SHALL trigger a data refresh for that module
4. WHEN a client receives an SSE update event while viewing the dashboard, THE Sync_Layer SHALL refresh the dashboard aggregation data
5. SSE events without a moduleId field SHALL default to the `iteration` module for backward compatibility

### Requirement 12: Offline Data Persistence and Recovery

**User Story:** As a user with unstable network, I want my changes to be saved locally during disconnection and synced automatically when reconnected, so that I never lose work.

#### Acceptance Criteria

1. WHEN the SSE connection is lost, THE Sync_Layer SHALL store pending state changes in localStorage using module-specific keys
2. WHEN the SSE connection is restored, THE Sync_Layer SHALL attempt to push each module's pending changes to the server
3. IF a revision conflict occurs during recovery push, THEN THE Sync_Layer SHALL perform a three-way merge using the server state, base state, and local state
4. THE Sync_Layer SHALL preserve all changes made during an offline period without data loss

### Requirement 13: Data Migration for Platform Upgrade

**User Story:** As a system administrator, I want the platform to automatically migrate existing data to the new directory structure on first startup, so that the upgrade is seamless.

#### Acceptance Criteria

1. WHEN the server starts and detects `data/state.json` exists but `data/iteration/state.json` does not, THE Server SHALL execute the data migration process
2. THE migration process SHALL copy `data/state.json` to `data/iteration/state.json` and copy `data/history/*` to `data/iteration/history/`
3. THE migration process SHALL create empty state files for project, budget, and token modules in their respective directories
4. THE migration process SHALL write a redirect marker to the original `data/state.json` location indicating migration has occurred
5. THE migration process SHALL be idempotent — running multiple times produces the same result without duplicating or corrupting data
6. IF the migration is interrupted, THEN THE Server SHALL detect the incomplete state on next startup and re-execute the migration safely

### Requirement 14: Project Module (全年度项目管理)

**User Story:** As a project manager, I want to manage annual projects with milestones and resource tracking, so that I can oversee project progress across the year.

#### Acceptance Criteria

1. THE Project_Module SHALL store project data in `data/project/state.json` following the ProjectState schema
2. THE Project_Module SHALL support CRUD operations on projects via `/api/project/state` GET and POST endpoints
3. WHEN a project's status changes, THE Project_Module SHALL validate that the new status is one of: planned, in-progress, completed, suspended
4. THE Project_Module SHALL enforce that each project's startDate is not later than its endDate
5. THE Project_Module SHALL enforce unique project IDs within the state file
6. WHEN a GET request is made to `/api/project/milestones`, THE Project_Module SHALL return upcoming milestones sorted by date
7. THE Project_Module SHALL use optimistic locking (rev field) consistent with the existing iteration module pattern

### Requirement 15: Budget Module (人力预算管理)

**User Story:** As a resource manager, I want to plan quarterly headcount budgets and track actual vs. planned staffing, so that I can identify budget deviations early.

#### Acceptance Criteria

1. THE Budget_Module SHALL store budget data in `data/budget/state.json` following the BudgetState schema
2. THE Budget_Module SHALL support reading and updating budget state via `/api/budget/state` GET and POST endpoints
3. THE Budget_Module SHALL require each team's quarterly plan to contain exactly 4 entries (Q1 through Q4)
4. THE Budget_Module SHALL validate that team names in budget data exist in the platform's configured TEAMS list
5. THE Budget_Module SHALL generate alerts when a team's actual headcount exceeds the planned budget by more than the configured threshold (default 10%)
6. THE Budget_Module page SHALL display an annual budget plan table, a plan-vs-actual comparison visualization, and a budget alerts list
7. THE Budget_Module page SHALL provide an Excel export function for budget data

### Requirement 16: Token Module Placeholder (AI/Token 使用记录)

**User Story:** As a platform user, I want a basic Token usage display page, so that I can see monthly AI consumption at a glance (detailed tracking is deferred).

#### Acceptance Criteria

1. THE Token_Module SHALL store basic token data in `data/token/state.json` following the TokenState schema
2. THE Token_Module SHALL provide a read-only GET endpoint at `/api/token/state` returning current token summary
3. THE Token_Module dashboard metric card SHALL display the monthly cost value (¥X.X) with a simple status indicator
4. THE Token_Module page SHALL display a monthly summary (total tokens, total cost, invocation count) and a budget progress bar

### Requirement 17: Responsive Layout Behavior

**User Story:** As a user accessing the platform from different devices, I want the layout to adapt to my screen size, so that the platform remains usable on tablets and phones.

#### Acceptance Criteria

1. WHILE the viewport width is 1200px or greater, THE Platform_Shell SHALL display the Sidebar in expanded mode (200px) and the main content area at `calc(100% - 200px)` width
2. WHILE the viewport width is between 768px and 1199px, THE Platform_Shell SHALL display the Sidebar in collapsed mode (56px) and the main content area at `calc(100% - 56px)` width
3. WHILE the viewport width is less than 768px, THE Platform_Shell SHALL hide the Sidebar and display a hamburger menu button, with the main content area at full width
4. WHEN the sidebar transitions between expanded and collapsed states, THE Platform_Shell SHALL animate the width change using a CSS transition of 0.2s ease

### Requirement 18: Optimistic Locking and Conflict Resolution

**User Story:** As a user editing data concurrently with teammates, I want conflicts to be detected and resolved automatically, so that no one's changes are silently lost.

#### Acceptance Criteria

1. WHEN a POST request includes a rev value that does not match the server's current rev for that module, THE Server SHALL return HTTP 409 with the current server state
2. WHEN a 409 conflict is received, THE Sync_Layer SHALL perform a three-way merge using the server state, the client's base state, and the client's current state
3. WHEN a merge is successful, THE Sync_Layer SHALL automatically resubmit the merged state to the server
4. THE Server SHALL increment the rev counter by 1 on each successful state write for any module

### Requirement 19: Error Resilience

**User Story:** As a platform user, I want the system to handle errors gracefully without crashing, so that a problem in one module does not affect my use of other modules.

#### Acceptance Criteria

1. IF a module fails to load at startup, THEN THE Platform_Shell SHALL display that module's navigation item in a disabled/gray state and continue normal operation of other modules
2. IF a module's state file is corrupted, THEN THE Server SHALL attempt to restore from the most recent history snapshot
3. IF no valid snapshot exists for a corrupted module, THEN THE Server SHALL initialize that module with an empty state and notify the user
4. IF the dashboard aggregation encounters an error for one module, THEN THE Dashboard SHALL display a "数据异常" indicator on that module's metric card without blocking other cards

### Requirement 20: Security and Access Control

**User Story:** As a system administrator, I want the platform to maintain existing security measures and prevent unauthorized access, so that data remains protected within our internal network.

#### Acceptance Criteria

1. WHEN an ACCESS_TOKEN environment variable is configured, THE Server SHALL require valid token authentication for all API requests
2. THE Server SHALL validate module IDs using the pattern `/^[a-z][a-z0-9-]*$/` to prevent path traversal attacks
3. THE Server SHALL limit POST request body size to 64MB per request
4. THE Server SHALL record the `updatedBy` field on every write operation for audit trail purposes
5. WHEN no ACCESS_TOKEN is configured, THE Server SHALL print a security warning to the console at startup
