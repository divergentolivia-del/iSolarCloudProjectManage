# 云平台管理工作台 · 协作约定

## 分支规则（2026-09-23 用户拍板，先看这条）

**所有改动一律推 `origin/dev/sgai`，验收后才合并 main。**

- 默认在 `dev/sgai` 上干活，不要在 main 上直接提交
- main 的角色是**验收快照**：dev/sgai 上的东西用户看过、确认没问题了，再合并回 main
- SGAI+ 写的 Skill 代码走同一条线，也推 `origin/dev/sgai`
- 来源：`docs/plan-ai-m2-tasks.md:4`（原话「改动一律推 `origin/dev/sgai`，验收后合并 main」）

### 为什么这条要写在最前面

2026-09-23 之前有过一次教训：改动直接写在 main 上，而 SGAI+ 同时在 dev/sgai 上
写了 Skill 9/10（章程 + 干系人），两条线各走各的，合并时 `engine.js` 撞出 4 处冲突。
冲突本身不难，难的是**判断哪边不能丢**——比如 `collectInputs` 一边是内联实现、
一边被拆成了 provider 注册表，选错就静默丢功能。

合并时的原则：**两边功能代码一个都不能丢**，逐块看再决定，不要整块选一边。

## 提交规矩

- **绝不 `git add .`** —— `data/iteration/state.json` 是被 git 跟踪的真实工时数据，
  一律显式 add 具体文件
- 提交前 `git diff --cached --name-only` 确认没带上 `data/` 下的东西
- 密钥类值（SSO `clientSecret` 等）**不进聊天、不进截图、不进代码**，
  只进 gitignore 掉的配置文件

## 代码归属

- **Skill 代码属于 SGAI+**，我（Claude Code）不写 Skill 代码
- 我的范围：平台骨架、模块集成、版面设计、钉钉/SSO 打通、排障
