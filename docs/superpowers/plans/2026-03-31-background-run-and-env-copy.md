# 后台运行任务与复制 .env 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Plan 运行改为基于 systemd 的后台任务，并在创建 worktree 后递归复制所有 `.env` 文件。

**Architecture:** 保持现有入口结构不变，由 `src/index.ts` 继续承接 `superpowers.runPlan` 命令；`src/runPlan.ts` 负责生成 unit 名与后台运行命令；`src/worktree.ts` 负责 worktree 初始化命令与 `.env` 复制命令；Webview 继续基于扫描结果渲染，并额外接收扩展端合并后的任务状态。

**Tech Stack:** TypeScript, VS Code Extension API, Vitest, systemd user services, git worktree

---

## 文件结构

| 文件 | 变更类型 | 职责 |
|------|----------|------|
| `src/runPlan.ts` | 修改 | 生成 `opencode-` unit 名，构建 `systemd-run` 命令 |
| `src/worktree.ts` | 修改 | 在 worktree 创建命令后追加递归复制 `.env` 文件的 shell 命令 |
| `src/index.ts` | 修改 | 启动后台任务、维护内存任务状态、每 30 秒轮询、刷新面板数据 |
| `src/types.ts` | 修改 | 为 Plan 列表增加任务状态字段 |
| `src/webview/html.ts` | 修改 | 在 Plan 列表中展示任务状态并控制运行按钮显隐 |
| `test/index.test.ts` | 创建 | 测试后台任务状态机、并行任务和按钮显隐数据规则 |
| `test/runPlan.test.ts` | 修改 | 测试 unit 名与 `systemd-run` 命令构建 |
| `test/worktree.test.ts` | 修改 | 测试 `.env` 递归复制命令 |
| `test/webview/html.test.ts` | 修改 | 测试 Plan 列表包含任务状态展示逻辑 |

---

### Task 1: 生成后台运行命令

**Files:**
- Modify: `src/runPlan.ts`
- Test: `test/runPlan.test.ts`

- [ ] **Step 1: 写失败测试，描述 unit 名必须以 `opencode-` 开头且同一 Plan 稳定生成相同名称**
- [ ] **Step 2: 运行 `pnpm vitest test/runPlan.test.ts`，确认新测试先失败**
- [ ] **Step 3: 在 `src/runPlan.ts` 中添加最小实现，生成安全的 unit 名**
- [ ] **Step 4: 写失败测试，描述最终命令使用 `systemd-run --user --unit=... sh -c 'opencode run ...'`**
- [ ] **Step 5: 再次运行 `pnpm vitest test/runPlan.test.ts`，确认因为实现缺失而失败**
- [ ] **Step 6: 在 `src/runPlan.ts` 中补齐最小实现，使测试通过**
- [ ] **Step 7: 运行 `pnpm vitest test/runPlan.test.ts`，确认全部通过**

### Task 2: 在 worktree 创建后复制 `.env`

**Files:**
- Modify: `src/worktree.ts`
- Test: `test/worktree.test.ts`

- [ ] **Step 1: 写失败测试，描述 worktree 创建命令会递归查找所有 `.env` 并按相对路径复制到目标目录**
- [ ] **Step 2: 运行 `pnpm vitest test/worktree.test.ts`，确认新测试先失败**
- [ ] **Step 3: 在计划中固定 shell 策略：从源工作区根目录递归查找所有名为 `.env` 的文件，排除目标 worktree 目录，逐个创建目标父目录，按相对路径复制并覆盖已有文件**
- [ ] **Step 4: 在 `src/worktree.ts` 中补充最小 shell 命令，保持现有字符串拼接风格，不额外引入脚本文件**
- [ ] **Step 4: 运行 `pnpm vitest test/worktree.test.ts`，确认测试通过**

### Task 3: 在扩展端维护任务状态并轮询

**Files:**
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Test: `test/index.test.ts`

- [ ] **Step 1: 先写失败测试，明确“同一个 Plan”的键使用 `planPath`，并通过稳定 `unitName` 映射到 systemd unit**
- [ ] **Step 2: 写失败测试，覆盖后台启动成功后立即隐藏运行按钮、并行 Plan 可同时运行**
- [ ] **Step 3: 写失败测试，覆盖轮询结果分别映射为“运行中 / 已完成 / 失败 / 可重新运行”**
- [ ] **Step 4: 运行 `pnpm vitest test/index.test.ts`，确认新增测试先失败**
- [ ] **Step 5: 在 `src/types.ts` 中保留现有文档状态字段 `status`，新增独立运行状态字段 `taskStatus`，避免语义混用**
- [ ] **Step 6: 在 `src/index.ts` 中添加最小任务状态模型，只记录 `planPath`、`unitName`、`taskStatus`**
- [ ] **Step 7: 将 `superpowers.runPlan` 改为后台启动命令，创建成功后立即把对应 Plan 标记为运行中**
- [ ] **Step 8: 添加单个全局 30 秒轮询器，对运行中 unit 执行 `systemctl --user status`**
- [ ] **Step 9: 固定解析规则：包含 `Active: active` 视为运行中；包含 `inactive (dead)` 且出现成功退出信息时视为已完成；包含 `failed` 或非零退出信息时视为失败；无法识别时保留上次状态并允许重试**
- [ ] **Step 10: 每次状态变化后重新扫描并把任务状态合并进面板数据**
- [ ] **Step 11: 运行 `pnpm vitest test/index.test.ts`，确认状态机测试通过**

### Task 4: 在面板中展示任务状态并控制运行按钮

**Files:**
- Modify: `src/webview/html.ts`
- Modify: `src/types.ts`
- Test: `test/webview/html.test.ts`

- [ ] **Step 1: 写失败测试，描述任务状态与文档状态分离渲染，任务状态使用独立文案“运行中 / 已完成 / 失败”**
- [ ] **Step 2: 运行 `pnpm vitest test/webview/html.test.ts`，确认测试先失败**
- [ ] **Step 3: 在 `src/types.ts` 为 Plan 列表补充可选任务状态字段，保持现有字段兼容**
- [ ] **Step 4: 在 `src/webview/html.ts` 里按 `taskStatus` 控制“运行”按钮显隐：运行中隐藏按钮，终态恢复按钮**
- [ ] **Step 5: 在 `test/webview/html.test.ts` 中补充静态断言，约束 HTML 中包含任务状态文案与显隐分支**
- [ ] **Step 5: 运行 `pnpm vitest test/webview/html.test.ts`，确认测试通过**

### Task 5: 集成验证

**Files:**
- Modify: `src/index.ts`
- Verify: `test/runPlan.test.ts`
- Verify: `test/worktree.test.ts`
- Verify: `test/webview/html.test.ts`

- [ ] **Step 1: 运行 `pnpm vitest test/runPlan.test.ts test/worktree.test.ts test/webview/html.test.ts`**
- [ ] **Step 2: 运行 `pnpm test`，确认没有意外回归**
- [ ] **Step 3: 运行 `pnpm typecheck`，确认类型检查通过**
- [ ] **Step 4: 运行 `gitnexus_detect_changes`，确认变更范围符合预期**
