# React + shadcn/ui 重写骨架实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 superpowers-vscode 插件整体重写为 React + TypeScript + shadcn/ui + esbuild 架构，骨架阶段只保留 spec/plan 扫描和两列 Kanban UI。

**Architecture:** 单 repo + pnpm workspace。根目录承载扩展主进程（esbuild 打包到 `dist/index.cjs`），`webview-ui/` 子包承载独立 Vite + React 应用（输出到 `dist/webview-ui/`）。扩展通过 `WebviewViewProvider` 在活动栏侧边栏宿主 webview，与 React 用 `postMessage` 协议通信。Scanner 扫描 `docs/superpowers/{specs,plans}` 并按 `${date}-${topic}` 配对成 Task。

**Tech Stack:** TypeScript, reactive-vscode (defineExtension), esbuild, React 19, Vite 6, Tailwind CSS v4, shadcn/ui (New York), Vitest, pnpm workspace。

**Worktree note:** 本计划假设在隔离的 git worktree 中执行（由 `using-git-worktrees` skill 创建）。所有 `git commit` 都在 worktree 内进行。

**Spec 引用:** [`docs/superpowers/specs/2026-05-15-react-shadcn-rewrite-design.md`](../specs/2026-05-15-react-shadcn-rewrite-design.md)

---

## 文件结构概览

**新建：**
- `esbuild.mjs` — 扩展打包配置
- `src/extension.ts` — 激活入口
- `src/scanner.ts` — 扫描 + 配对
- `src/types.ts` — Task / Phase / TaskState 类型
- `src/panel/messages.ts` — 共享消息协议类型
- `src/panel/KanbanPanel.ts` — WebviewViewProvider
- `webview-ui/package.json`
- `webview-ui/vite.config.ts`
- `webview-ui/tsconfig.json`
- `webview-ui/tsconfig.node.json`
- `webview-ui/index.html`
- `webview-ui/components.json`
- `webview-ui/src/main.tsx`
- `webview-ui/src/App.tsx`
- `webview-ui/src/index.css`
- `webview-ui/src/types.ts`
- `webview-ui/src/lib/utils.ts`
- `webview-ui/src/lib/vscode.ts`
- `webview-ui/src/hooks/useTasks.ts`
- `webview-ui/src/components/KanbanBoard.tsx`
- `webview-ui/src/components/KanbanColumn.tsx`
- `webview-ui/src/components/TaskCard.tsx`
- `webview-ui/src/components/ui/badge.tsx` (shadcn 生成)
- `webview-ui/src/components/ui/card.tsx` (shadcn 生成)
- `test/scanner.test.ts`

**删除：**
- `src/index.ts` `src/runPlan.ts` `src/worktree.ts` `src/planCompletion.ts` `src/panelOpenInteraction.ts` `src/treeView.ts` `src/config.ts` `src/utils.ts` `src/extensionRuntime.ts` `src/scanner.ts` `src/types.ts` `src/webview/html.ts` `src/webview/panel.ts`
- `test/runPlan.test.ts` `test/worktree.test.ts` `test/index.test.ts` `test/extensionRuntime.test.ts` `test/scanner.test.ts`
- `docs/superpowers/specs/2026-03-*.md` `docs/superpowers/plans/2026-03-*.md`
- `tsdown.config.ts` `taze.config.ts`

**修改：**
- `package.json` — scripts / contributes / dependencies 全面重写
- `tsconfig.json` — 仅覆盖扩展主进程
- `pnpm-workspace.yaml` — 加入 `webview-ui`
- `.gitignore` — 加入 `webview-ui/node_modules`、`webview-ui/dist`

---

### Task 1: 清空旧代码与旧文档

**Files:**
- Delete: `src/index.ts`, `src/runPlan.ts`, `src/worktree.ts`, `src/planCompletion.ts`, `src/panelOpenInteraction.ts`, `src/treeView.ts`, `src/config.ts`, `src/utils.ts`, `src/extensionRuntime.ts`, `src/scanner.ts`, `src/types.ts`
- Delete: `src/webview/html.ts`, `src/webview/panel.ts`, `src/webview/` (空目录后删)
- Delete: `test/runPlan.test.ts`, `test/worktree.test.ts`, `test/index.test.ts`, `test/extensionRuntime.test.ts`, `test/scanner.test.ts`
- Delete: `docs/superpowers/specs/2026-03-19-superpowers-vscode-design.md`, `docs/superpowers/specs/2026-03-20-panel-open-interaction-design.md`, `docs/superpowers/specs/2026-03-22-tabs-table-layout-design.md`
- Delete: `docs/superpowers/plans/2026-03-19-superpowers-vscode-plugin.md`, `docs/superpowers/plans/2026-03-20-panel-open-interaction.md`, `docs/superpowers/plans/2026-03-22-tabs-table-layout.md`, `docs/superpowers/plans/2026-03-31-background-run-and-env-copy.md`
- Delete: `tsdown.config.ts`, `taze.config.ts`
- Keep: `docs/superpowers/specs/2026-05-15-react-shadcn-rewrite-design.md`, `docs/superpowers/plans/2026-05-15-react-shadcn-rewrite.md`（本计划）

- [ ] **Step 1: 删除扩展旧源文件**

```bash
rm -f src/index.ts src/runPlan.ts src/worktree.ts src/planCompletion.ts \
      src/panelOpenInteraction.ts src/treeView.ts src/config.ts \
      src/utils.ts src/extensionRuntime.ts src/scanner.ts src/types.ts
rm -rf src/webview
```

- [ ] **Step 2: 删除旧测试**

```bash
rm -f test/runPlan.test.ts test/worktree.test.ts test/index.test.ts \
      test/extensionRuntime.test.ts test/scanner.test.ts
```

- [ ] **Step 3: 删除旧 spec 与 plan 示例（保留本轮重写的 spec 和当前 plan）**

```bash
rm -f docs/superpowers/specs/2026-03-*.md
rm -f docs/superpowers/plans/2026-03-*.md
```

- [ ] **Step 4: 删除 tsdown 与 taze 配置**

```bash
rm -f tsdown.config.ts taze.config.ts
```

- [ ] **Step 5: 验证 src/ 和 docs/ 当前状态**

```bash
ls src/ docs/superpowers/specs/ docs/superpowers/plans/
```

Expected: `src/` 只含 `generated/`（暂留，下个 task 移除）；specs 只有 `2026-05-15-react-shadcn-rewrite-design.md`；plans 只有 `2026-05-15-react-shadcn-rewrite.md`

- [ ] **Step 6: 删除 vscode-ext-gen 生成的 meta（旧命令名已失效）**

```bash
rm -rf src/generated
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "🔥 chore: 清空旧扩展源码、旧测试和过期 specs/plans

为重写让位，仅保留本轮重写的 spec 和 plan、res/ 资源、配置文件骨架。"
```

---

### Task 2: 重写根 package.json

**Files:**
- Modify: `package.json` (完整替换)

- [ ] **Step 1: 完整替换 package.json 内容**

```json
{
  "publisher": "clurdra",
  "name": "superpowers-vscode-clurdra",
  "displayName": "Superpowers-clurdra",
  "version": "0.2.0",
  "packageManager": "pnpm@10.27.0",
  "description": "Superpowers specs and plans Kanban explorer",
  "author": "clurdra",
  "license": "MIT",
  "homepage": "https://github.com/cruldra/superpowers-vscode#readme",
  "repository": {
    "type": "git",
    "url": "https://github.com/cruldra/superpowers-vscode"
  },
  "bugs": {
    "url": "https://github.com/cruldra/superpowers-vscode/issues"
  },
  "categories": [
    "Other"
  ],
  "main": "./dist/index.cjs",
  "icon": "res/icon.png",
  "files": [
    "LICENSE.md",
    "dist/**/*",
    "res/*"
  ],
  "engines": {
    "vscode": "^1.97.0"
  },
  "activationEvents": [
    "onView:superpowers.kanban"
  ],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "superpowers",
          "title": "Superpowers",
          "icon": "res/icon.svg"
        }
      ]
    },
    "views": {
      "superpowers": [
        {
          "id": "superpowers.kanban",
          "name": "Kanban",
          "type": "webview"
        }
      ]
    },
    "commands": [
      {
        "command": "superpowers.refresh",
        "title": "Refresh Superpowers Kanban"
      }
    ],
    "menus": {
      "view/title": [
        {
          "command": "superpowers.refresh",
          "when": "view == superpowers.kanban",
          "group": "navigation"
        }
      ]
    }
  },
  "scripts": {
    "build": "pnpm --filter webview-ui build && node esbuild.mjs --production",
    "dev": "concurrently \"pnpm --filter webview-ui dev\" \"node esbuild.mjs --watch\"",
    "typecheck": "tsc --noEmit && pnpm --filter webview-ui typecheck",
    "lint": "eslint .",
    "test": "vitest",
    "vscode:prepublish": "pnpm build",
    "release": "bumpp",
    "ext:package": "pnpm build && vsce package --no-dependencies",
    "ext:publish:vsce": "npm_config_proxy= npm_config_https_proxy= vsce publish --skip-duplicate"
  },
  "devDependencies": {
    "@antfu/eslint-config": "^6.7.3",
    "@types/node": "^25.0.3",
    "@types/vscode": "^1.97.0",
    "@vscode/vsce": "^3.7.1",
    "bumpp": "^10.3.2",
    "concurrently": "^9.1.0",
    "esbuild": "^0.25.0",
    "eslint": "^9.39.2",
    "ovsx": "^0.10.7",
    "reactive-vscode": "^1.0.0-beta.2",
    "typescript": "^5.9.3",
    "vitest": "^4.0.16"
  }
}
```

- [ ] **Step 2: 更新 pnpm-workspace.yaml 加入 webview-ui**

完整替换 `pnpm-workspace.yaml`：

```yaml
packages:
  - webview-ui
```

- [ ] **Step 3: 更新 .gitignore 加入 webview-ui 产物**

把以下两行追加到 `.gitignore` 末尾（如果已有忽略 `node_modules` 和 `dist` 不需要重复）：

```
webview-ui/node_modules
webview-ui/dist
```

通过查看现有 `.gitignore` 确认 `node_modules` 和 `dist` 已被忽略，仅在缺失时追加。

- [ ] **Step 4: Commit（先不 install，等 webview-ui 包结构定好后一起 install）**

```bash
git add package.json pnpm-workspace.yaml .gitignore
git commit -m "♻️ chore: 重写 package.json 与 workspace 配置

切换打包器为 esbuild，新增 webview-ui 子包占位，移除 runPlan/worktree
相关命令和配置，仅保留 superpowers.refresh 命令。版本号升至 0.2.0。"
```

---

### Task 3: 重写扩展端 tsconfig.json

**Files:**
- Modify: `tsconfig.json` (完整替换)

- [ ] **Step 1: 完整替换 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "dist", "webview-ui"]
}
```

- [ ] **Step 2: Commit**

```bash
git add tsconfig.json
git commit -m "♻️ chore: 重写扩展端 tsconfig，限定 src/test 作用域"
```

---

### Task 4: 创建扩展端类型定义 src/types.ts

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: 创建 src/types.ts**

```ts
export type Phase = 'planning' | 'development'

export type PlanningState =
  | 'write-spec'
  | 'spec-review'
  | 'write-plan'
  | 'plan-review'

export type DevelopmentState =
  | 'create-worktree'
  | 'implement'
  | 'review'
  | 'fix'
  | 'review-passed'
  | 'merge-cleanup'

export type TaskState = PlanningState | DevelopmentState

export interface Task {
  /** `${date}-${topic}` */
  id: string
  /** 首选 spec 的首个 H1，缺则取 plan 的，再缺取 topic */
  title: string
  /** YYYY-MM-DD */
  date: string
  /** 文件名中间段，例如 "react-shadcn-rewrite" */
  topic: string
  /** spec 绝对路径，可缺 */
  specPath?: string
  /** plan 绝对路径，可缺 */
  planPath?: string
  phase: Phase
  state: TaskState
}
```

- [ ] **Step 2: Commit（typecheck 留到 scanner 测试就绪后一次性跑）**

```bash
git add src/types.ts
git commit -m "✨ feat(types): 新增 Task / Phase / TaskState 数据模型"
```

---

### Task 5: TDD 实现 scanner.ts —— 写测试

**Files:**
- Create: `test/scanner.test.ts`

- [ ] **Step 1: 安装根 deps（为运行 vitest 准备）**

```bash
pnpm install
```

Expected: 安装成功；可能 warn 缺 `webview-ui` 子包，忽略（下个 task 创建）。

- [ ] **Step 2: 创建 test/scanner.test.ts**

```ts
import type { Task } from '../src/types'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanTasks } from '../src/scanner'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'superpowers-test-'))
  mkdirSync(join(workspace, 'docs', 'superpowers', 'specs'), { recursive: true })
  mkdirSync(join(workspace, 'docs', 'superpowers', 'plans'), { recursive: true })
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

function writeSpec(name: string, content: string) {
  writeFileSync(join(workspace, 'docs', 'superpowers', 'specs', name), content)
}

function writePlan(name: string, content: string) {
  writeFileSync(join(workspace, 'docs', 'superpowers', 'plans', name), content)
}

describe('scanTasks', () => {
  it('returns empty array when no files exist', async () => {
    const result = await scanTasks(workspace)
    expect(result).toEqual([])
  })

  it('returns empty array when docs/superpowers does not exist', async () => {
    rmSync(join(workspace, 'docs'), { recursive: true })
    const result = await scanTasks(workspace)
    expect(result).toEqual([])
  })

  it('pairs spec and plan with same date+topic into one task', async () => {
    writeSpec('2026-05-15-rewrite-design.md', '# Rewrite Design\nbody')
    writePlan('2026-05-15-rewrite.md', '# Rewrite Plan\nbody')
    const result = await scanTasks(workspace)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject<Partial<Task>>({
      id: '2026-05-15-rewrite',
      date: '2026-05-15',
      topic: 'rewrite',
      title: 'Rewrite Design',
      phase: 'development',
      state: 'implement',
    })
    expect(result[0].specPath).toContain('2026-05-15-rewrite-design.md')
    expect(result[0].planPath).toContain('2026-05-15-rewrite.md')
  })

  it('creates planning-phase task when only spec exists', async () => {
    writeSpec('2026-05-10-foo-design.md', '# Foo Design')
    const result = await scanTasks(workspace)
    expect(result).toHaveLength(1)
    expect(result[0].phase).toBe('planning')
    expect(result[0].state).toBe('write-plan')
    expect(result[0].planPath).toBeUndefined()
    expect(result[0].title).toBe('Foo Design')
  })

  it('creates development-phase task when only plan exists', async () => {
    writePlan('2026-05-11-bar.md', '# Bar Plan')
    const result = await scanTasks(workspace)
    expect(result).toHaveLength(1)
    expect(result[0].phase).toBe('development')
    expect(result[0].state).toBe('implement')
    expect(result[0].specPath).toBeUndefined()
    expect(result[0].title).toBe('Bar Plan')
  })

  it('falls back to topic when no H1 in markdown', async () => {
    writeSpec('2026-05-12-baz-design.md', 'no heading here')
    const result = await scanTasks(workspace)
    expect(result[0].title).toBe('baz')
  })

  it('sorts tasks by date descending', async () => {
    writeSpec('2026-05-10-a-design.md', '# A')
    writeSpec('2026-05-15-b-design.md', '# B')
    writeSpec('2026-05-12-c-design.md', '# C')
    const result = await scanTasks(workspace)
    expect(result.map(t => t.id)).toEqual([
      '2026-05-15-b',
      '2026-05-12-c',
      '2026-05-10-a',
    ])
  })

  it('ignores files that do not match naming convention', async () => {
    writeSpec('not-dated.md', '# Bad')
    writePlan('readme.md', '# Bad')
    writeSpec('2026-13-99-bad-design.md', '# Bad') // invalid date passes regex but is logically odd; convention check is only by shape
    writePlan('2026-05-15-good.md', '# Good')
    const result = await scanTasks(workspace)
    expect(result.map(t => t.id)).toContain('2026-05-15-good')
    expect(result.find(t => t.id.includes('not-dated'))).toBeUndefined()
    expect(result.find(t => t.id.includes('readme'))).toBeUndefined()
  })

  it('handles topic with multiple hyphens correctly', async () => {
    writeSpec('2026-05-15-react-shadcn-rewrite-design.md', '# X')
    writePlan('2026-05-15-react-shadcn-rewrite.md', '# Y')
    const result = await scanTasks(workspace)
    expect(result).toHaveLength(1)
    expect(result[0].topic).toBe('react-shadcn-rewrite')
    expect(result[0].id).toBe('2026-05-15-react-shadcn-rewrite')
  })
})
```

- [ ] **Step 3: 运行测试，确认全部 FAIL**

```bash
pnpm test -- --run test/scanner.test.ts
```

Expected: 测试失败，错误信息提到 "Cannot find module '../src/scanner'" 或类似。

---

### Task 6: TDD 实现 scanner.ts —— 写实现

**Files:**
- Create: `src/scanner.ts`

- [ ] **Step 1: 创建 src/scanner.ts**

```ts
import type { Phase, Task, TaskState } from './types'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SPEC_REGEX = /^(\d{4}-\d{2}-\d{2})-(.+)-design\.md$/
const PLAN_REGEX = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/

interface FileInfo {
  date: string
  topic: string
  filePath: string
  title: string
}

function extractTitle(filePath: string, fallback: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const match = content.match(/^# (.+)$/m)
    return match ? match[1].trim() : fallback
  }
  catch {
    return fallback
  }
}

function listMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir))
    return []
  return fs.readdirSync(dir).filter(f => f.endsWith('.md'))
}

function parseSpecs(specsDir: string): FileInfo[] {
  return listMarkdownFiles(specsDir)
    .map((name) => {
      const m = name.match(SPEC_REGEX)
      if (!m)
        return null
      const filePath = path.join(specsDir, name)
      return {
        date: m[1],
        topic: m[2],
        filePath,
        title: extractTitle(filePath, m[2]),
      }
    })
    .filter((x): x is FileInfo => x !== null)
}

function parsePlans(plansDir: string): FileInfo[] {
  return listMarkdownFiles(plansDir)
    .map((name) => {
      // Plan 不能匹配 -design.md 后缀
      if (SPEC_REGEX.test(name))
        return null
      const m = name.match(PLAN_REGEX)
      if (!m)
        return null
      const filePath = path.join(plansDir, name)
      return {
        date: m[1],
        topic: m[2],
        filePath,
        title: extractTitle(filePath, m[2]),
      }
    })
    .filter((x): x is FileInfo => x !== null)
}

/**
 * 状态判定占位逻辑 —— 仅按文件存在性给一个默认状态。
 * TODO: 状态判定逻辑等下一轮迭代补充（来源可能是 frontmatter / workspace state / 手动点选）。
 */
function inferPhaseAndState(hasSpec: boolean, hasPlan: boolean): { phase: Phase, state: TaskState } {
  if (hasSpec && !hasPlan)
    return { phase: 'planning', state: 'write-plan' }
  return { phase: 'development', state: 'implement' }
}

export async function scanTasks(workspaceRoot: string): Promise<Task[]> {
  const specsDir = path.join(workspaceRoot, 'docs', 'superpowers', 'specs')
  const plansDir = path.join(workspaceRoot, 'docs', 'superpowers', 'plans')

  const specs = parseSpecs(specsDir)
  const plans = parsePlans(plansDir)

  const map = new Map<string, Task>()

  for (const s of specs) {
    const id = `${s.date}-${s.topic}`
    const { phase, state } = inferPhaseAndState(true, false)
    map.set(id, {
      id,
      title: s.title,
      date: s.date,
      topic: s.topic,
      specPath: s.filePath,
      phase,
      state,
    })
  }

  for (const p of plans) {
    const id = `${p.date}-${p.topic}`
    const existing = map.get(id)
    if (existing) {
      existing.planPath = p.filePath
      const { phase, state } = inferPhaseAndState(!!existing.specPath, true)
      existing.phase = phase
      existing.state = state
    }
    else {
      const { phase, state } = inferPhaseAndState(false, true)
      map.set(id, {
        id,
        title: p.title,
        date: p.date,
        topic: p.topic,
        planPath: p.filePath,
        phase,
        state,
      })
    }
  }

  return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date))
}
```

- [ ] **Step 2: 运行测试，确认全部 PASS**

```bash
pnpm test -- --run test/scanner.test.ts
```

Expected: 9 个测试全部通过。

- [ ] **Step 3: typecheck 扩展端**

```bash
pnpm exec tsc --noEmit
```

Expected: 无输出。

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/scanner.ts test/scanner.test.ts
git commit -m "✨ feat(scanner): 实现 specs/plans 扫描与按 date+topic 配对

新增 Task 数据模型，scanner.ts 用 \${date}-\${topic} 作为配对 key，
状态判定先用占位逻辑（只有 spec 时进规划阶段，否则进开发阶段）。
9 个 Vitest 测试用例覆盖空目录、配对、降序、缺标题回退等场景。"
```

---

### Task 7: 创建消息协议 src/panel/messages.ts

**Files:**
- Create: `src/panel/messages.ts`

- [ ] **Step 1: 创建 src/panel/messages.ts**

```ts
import type { Task } from '../types'

export type ExtensionToWebview =
  | { type: 'tasks/update', tasks: Task[] }

export type WebviewToExtension =
  | { type: 'tasks/request' }
  | { type: 'task/open', path: string }
```

- [ ] **Step 2: typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: 无输出。

- [ ] **Step 3: Commit**

```bash
git add src/panel/messages.ts
git commit -m "✨ feat(panel): 定义扩展与 webview 间的消息协议"
```

---

### Task 8: 创建 WebviewViewProvider —— src/panel/KanbanPanel.ts

**Files:**
- Create: `src/panel/KanbanPanel.ts`

- [ ] **Step 1: 创建 src/panel/KanbanPanel.ts**

```ts
import type {
  CancellationToken,
  ExtensionContext,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
} from 'vscode'
import type { Task } from '../types'
import type { ExtensionToWebview, WebviewToExtension } from './messages'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Uri, ViewColumn, window, workspace } from 'vscode'
import { scanTasks } from '../scanner'

export class KanbanPanelProvider implements WebviewViewProvider {
  static readonly viewType = 'superpowers.kanban'

  private view?: WebviewView

  constructor(private readonly context: ExtensionContext) {}

  async resolveWebviewView(
    view: WebviewView,
    _ctx: WebviewViewResolveContext,
    _token: CancellationToken,
  ): Promise<void> {
    this.view = view

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui'),
      ],
    }

    view.webview.html = this.buildHtml(view)

    view.webview.onDidReceiveMessage((msg: WebviewToExtension) => {
      this.handleMessage(msg).catch((err) => {
        window.showErrorMessage(`Superpowers: ${err}`)
      })
    })

    view.onDidDispose(() => {
      this.view = undefined
    })
  }

  async refresh(): Promise<void> {
    const tasks = await this.loadTasks()
    this.postMessage({ type: 'tasks/update', tasks })
  }

  private async handleMessage(msg: WebviewToExtension): Promise<void> {
    switch (msg.type) {
      case 'tasks/request': {
        const tasks = await this.loadTasks()
        this.postMessage({ type: 'tasks/update', tasks })
        break
      }
      case 'task/open': {
        const doc = await workspace.openTextDocument(Uri.file(msg.path))
        await window.showTextDocument(doc, { viewColumn: ViewColumn.One, preview: false })
        break
      }
    }
  }

  private postMessage(msg: ExtensionToWebview): void {
    this.view?.webview.postMessage(msg)
  }

  private async loadTasks(): Promise<Task[]> {
    const folder = workspace.workspaceFolders?.[0]
    if (!folder)
      return []
    return scanTasks(folder.uri.fsPath)
  }

  private buildHtml(view: WebviewView): string {
    const distRoot = Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui')
    const indexPath = path.join(distRoot.fsPath, 'index.html')
    let html = fs.readFileSync(indexPath, 'utf-8')

    const nonce = makeNonce()
    const cspSource = view.webview.cspSource

    // 重写 src 和 href 的相对路径为 webview URI
    html = html.replace(/(src|href)="(\/[^"]+|\.\/[^"]+|[^"/][^"]*)"/g, (_m, attr, p) => {
      const cleaned = p.replace(/^\.?\//, '')
      const uri = view.webview.asWebviewUri(Uri.joinPath(distRoot, cleaned))
      return `${attr}="${uri}"`
    })

    // 给所有 <script> 标签注入 nonce
    html = html.replace(/<script(\s[^>]*)?>/g, (m, attrs) => {
      const a = attrs ?? ''
      return `<script nonce="${nonce}"${a}>`
    })

    // 注入 CSP
    const csp = `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};`
    html = html.replace(
      /<head>/,
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
    )

    return html
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++)
    out += chars[Math.floor(Math.random() * chars.length)]
  return out
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: 无输出。

- [ ] **Step 3: Commit**

```bash
git add src/panel/KanbanPanel.ts
git commit -m "✨ feat(panel): WebviewViewProvider 加载 Vite 产物并桥接消息

读 dist/webview-ui/index.html，用 asWebviewUri 重写所有 src/href 路径，
注入 CSP nonce 给 <script>，处理 tasks/request 和 task/open 消息。"
```

---

### Task 9: 创建扩展入口 src/extension.ts

**Files:**
- Create: `src/extension.ts`

- [ ] **Step 1: 创建 src/extension.ts**

```ts
import type { ExtensionContext } from 'vscode'
import { commands, window, workspace } from 'vscode'
import { KanbanPanelProvider } from './panel/KanbanPanel'

let provider: KanbanPanelProvider | undefined

export function activate(context: ExtensionContext): void {
  provider = new KanbanPanelProvider(context)

  context.subscriptions.push(
    window.registerWebviewViewProvider(KanbanPanelProvider.viewType, provider),
    commands.registerCommand('superpowers.refresh', () => provider?.refresh()),
  )

  // 监听 specs/plans 文件变化，自动刷新
  const watcher = workspace.createFileSystemWatcher(
    '**/docs/superpowers/{specs,plans}/*.md',
  )
  const onChange = (): void => {
    provider?.refresh()
  }
  watcher.onDidCreate(onChange)
  watcher.onDidChange(onChange)
  watcher.onDidDelete(onChange)
  context.subscriptions.push(watcher)
}

export function deactivate(): void {
  provider = undefined
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: 无输出。

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "✨ feat(extension): 激活入口注册 WebviewView、刷新命令、文件监听"
```

---

### Task 10: 创建 esbuild.mjs

**Files:**
- Create: `esbuild.mjs`

- [ ] **Step 1: 创建 esbuild.mjs**

```js
import * as esbuild from 'esbuild'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/index.cjs',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('[esbuild] watching...')
}
else {
  await esbuild.build(options)
}
```

- [ ] **Step 2: 跑一次 production build（webview-ui 还没造，esbuild 只打扩展端能成功）**

```bash
node esbuild.mjs --production
```

Expected: 输出包含 `dist/index.cjs`；存在 `dist/index.cjs` 文件，不报错。

```bash
ls -la dist/
```

Expected: 至少有 `index.cjs` 文件。

- [ ] **Step 3: Commit**

```bash
git add esbuild.mjs
git commit -m "🔧 build: 用 esbuild 替代 tsdown 打包扩展主进程

支持 --production 和 --watch 两种模式，产物到 dist/index.cjs。"
```

---

### Task 11: 初始化 webview-ui 子包骨架（无 React 内容）

**Files:**
- Create: `webview-ui/package.json`
- Create: `webview-ui/tsconfig.json`
- Create: `webview-ui/tsconfig.node.json`
- Create: `webview-ui/vite.config.ts`
- Create: `webview-ui/index.html`

- [ ] **Step 1: 创建 webview-ui/package.json**

```json
{
  "name": "webview-ui",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.9.3",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: 创建 webview-ui/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "useDefineForClassFields": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 3: 创建 webview-ui/tsconfig.node.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "composite": true,
    "noEmit": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: 创建 webview-ui/vite.config.ts**

```ts
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../dist/webview-ui',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 给产物用稳定文件名，方便 KanbanPanel.ts 的 URI 重写
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
```

- [ ] **Step 5: 创建 webview-ui/index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Superpowers Kanban</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: 安装 webview-ui 依赖**

```bash
pnpm install
```

Expected: webview-ui 子包依赖被装上。

- [ ] **Step 7: Commit（暂时没有 main.tsx 还跑不通 build，下个 task 加）**

```bash
git add webview-ui/package.json webview-ui/tsconfig.json webview-ui/tsconfig.node.json \
        webview-ui/vite.config.ts webview-ui/index.html pnpm-lock.yaml
git commit -m "🔧 build(webview-ui): 初始化 Vite + React 19 + TS 子包骨架"
```

---

### Task 12: 加 React 入口 main.tsx + App.tsx（最小可跑）

**Files:**
- Create: `webview-ui/src/main.tsx`
- Create: `webview-ui/src/App.tsx`
- Create: `webview-ui/src/index.css`

- [ ] **Step 1: 创建 webview-ui/src/index.css（先空文件，下个 task 加 Tailwind）**

```css
/* placeholder, replaced when Tailwind is added */
body {
  margin: 0;
  font-family: system-ui, sans-serif;
}
```

- [ ] **Step 2: 创建 webview-ui/src/App.tsx**

```tsx
export function App() {
  return <div>Superpowers Kanban — bootstrap OK</div>
}
```

- [ ] **Step 3: 创建 webview-ui/src/main.tsx**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

- [ ] **Step 4: 跑 webview-ui build 验证脚手架**

```bash
pnpm --filter webview-ui build
```

Expected: 输出包含 `../dist/webview-ui/assets/main.js`、`../dist/webview-ui/assets/index.css`、`../dist/webview-ui/index.html`，不报错。

```bash
ls dist/webview-ui/ dist/webview-ui/assets/
```

Expected: 至少看到 `index.html` 和 assets 目录里的 js/css 文件。

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/main.tsx webview-ui/src/App.tsx webview-ui/src/index.css
git commit -m "✨ feat(webview-ui): 添加 React 入口 main.tsx 和 App.tsx 占位"
```

---

### Task 13: 加 Tailwind CSS v4

**Files:**
- Modify: `webview-ui/package.json` (deps)
- Modify: `webview-ui/vite.config.ts` (plugin)
- Modify: `webview-ui/src/index.css` (Tailwind import)

- [ ] **Step 1: 安装 Tailwind v4 与 Vite 插件**

```bash
pnpm --filter webview-ui add -D tailwindcss@^4.0.0 @tailwindcss/vite@^4.0.0
```

- [ ] **Step 2: 把 `@tailwindcss/vite` 接入 webview-ui/vite.config.ts**

完整替换 `webview-ui/vite.config.ts` 为：

```ts
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: '../dist/webview-ui',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
```

- [ ] **Step 3: 完整替换 webview-ui/src/index.css**

```css
@import "tailwindcss";

@theme {
  --color-card-border: #475569;
  --color-state-blue: #3b82f6;
  --color-state-yellow: #fbbf24;
  --color-state-purple: #a78bfa;
  --color-state-orange: #f97316;
  --color-state-red: #ef4444;
  --color-state-green: #22c55e;
}

body {
  margin: 0;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-size: var(--vscode-font-size, 13px);
}
```

- [ ] **Step 4: 验证 Tailwind 类能正常生效——临时在 App.tsx 加 className**

把 webview-ui/src/App.tsx 改为：

```tsx
export function App() {
  return (
    <div className="p-4 text-lg">
      Superpowers Kanban — Tailwind OK
    </div>
  )
}
```

- [ ] **Step 5: 跑 build 确认 Tailwind 工作**

```bash
pnpm --filter webview-ui build
```

Expected: build 成功；查看 `dist/webview-ui/assets/index.css` 应包含 Tailwind 的 utility 类（grep 一下确认）。

```bash
grep -c "padding" dist/webview-ui/assets/index.css
```

Expected: 输出 ≥ 1。

- [ ] **Step 6: Commit**

```bash
git add webview-ui/package.json webview-ui/vite.config.ts webview-ui/src/index.css \
        webview-ui/src/App.tsx pnpm-lock.yaml
git commit -m "💄 style(webview-ui): 接入 Tailwind CSS v4 与 @tailwindcss/vite"
```

---

### Task 14: 加 shadcn/ui 与基础组件

**Files:**
- Create: `webview-ui/components.json`
- Modify: `webview-ui/src/index.css` (加 shadcn 主题变量)
- Modify: `webview-ui/tsconfig.json` (paths 已在 Task 11 配好，确认即可)
- Create: `webview-ui/src/lib/utils.ts`
- Create (via CLI): `webview-ui/src/components/ui/badge.tsx`
- Create (via CLI): `webview-ui/src/components/ui/card.tsx`

- [ ] **Step 1: 创建 webview-ui/components.json**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "slate",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

- [ ] **Step 2: 进入 webview-ui 目录跑 shadcn init（非交互方式：手动写 utils.ts 与组件文件，避免 CLI 提示）**

创建 `webview-ui/src/lib/utils.ts`：

```ts
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 3: 安装 shadcn 运行时依赖**

```bash
pnpm --filter webview-ui add clsx tailwind-merge class-variance-authority lucide-react
```

- [ ] **Step 4: 创建 webview-ui/src/components/ui/badge.tsx**

```tsx
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-slate-700 text-slate-100',
        secondary: 'border-transparent bg-slate-600 text-slate-200',
        outline: 'border-slate-500 text-slate-200',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}
```

- [ ] **Step 5: 创建 webview-ui/src/components/ui/card.tsx**

```tsx
import * as React from 'react'
import { cn } from '@/lib/utils'

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('rounded-lg border border-slate-700 bg-slate-900 text-slate-100 shadow', className)} {...props} />
  ),
)
Card.displayName = 'Card'

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-4', className)} {...props} />
  ),
)
CardHeader.displayName = 'CardHeader'

export const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-sm font-semibold leading-none tracking-tight', className)} {...props} />
  ),
)
CardTitle.displayName = 'CardTitle'

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-4 pt-0', className)} {...props} />
  ),
)
CardContent.displayName = 'CardContent'
```

- [ ] **Step 6: 验证 build 仍然成功**

```bash
pnpm --filter webview-ui build
```

Expected: 成功，无 TS 错误。

- [ ] **Step 7: Commit**

```bash
git add webview-ui/components.json webview-ui/src/lib/utils.ts \
        webview-ui/src/components/ui/badge.tsx webview-ui/src/components/ui/card.tsx \
        webview-ui/package.json pnpm-lock.yaml
git commit -m "✨ feat(webview-ui): 接入 shadcn 工具函数与 Badge/Card 基础组件"
```

---

### Task 15: 创建 webview 端类型镜像与 vscode 桥

**Files:**
- Create: `webview-ui/src/types.ts`
- Create: `webview-ui/src/lib/vscode.ts`

- [ ] **Step 1: 创建 webview-ui/src/types.ts（与 src/types.ts 内容完全一致）**

```ts
export type Phase = 'planning' | 'development'

export type PlanningState =
  | 'write-spec'
  | 'spec-review'
  | 'write-plan'
  | 'plan-review'

export type DevelopmentState =
  | 'create-worktree'
  | 'implement'
  | 'review'
  | 'fix'
  | 'review-passed'
  | 'merge-cleanup'

export type TaskState = PlanningState | DevelopmentState

export interface Task {
  id: string
  title: string
  date: string
  topic: string
  specPath?: string
  planPath?: string
  phase: Phase
  state: TaskState
}

export type ExtensionToWebview =
  | { type: 'tasks/update', tasks: Task[] }

export type WebviewToExtension =
  | { type: 'tasks/request' }
  | { type: 'task/open', path: string }
```

- [ ] **Step 2: 创建 webview-ui/src/lib/vscode.ts**

```ts
import type { ExtensionToWebview, WebviewToExtension } from '../types'

interface VsCodeApi {
  postMessage: (msg: WebviewToExtension) => void
  getState: <T = unknown>() => T | undefined
  setState: <T = unknown>(state: T) => void
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi
  }
}

const api = window.acquireVsCodeApi?.() ?? {
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
}

export function postMessage(msg: WebviewToExtension): void {
  api.postMessage(msg)
}

export function onMessage(handler: (msg: ExtensionToWebview) => void): () => void {
  const listener = (ev: MessageEvent): void => {
    handler(ev.data as ExtensionToWebview)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
```

- [ ] **Step 3: typecheck**

```bash
pnpm --filter webview-ui typecheck
```

Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add webview-ui/src/types.ts webview-ui/src/lib/vscode.ts
git commit -m "✨ feat(webview-ui): 镜像 Task 类型并封装 vscode postMessage 桥"
```

---

### Task 16: 创建 useTasks hook

**Files:**
- Create: `webview-ui/src/hooks/useTasks.ts`

- [ ] **Step 1: 创建 webview-ui/src/hooks/useTasks.ts**

```ts
import { useEffect, useState } from 'react'
import { onMessage, postMessage } from '../lib/vscode'
import type { Task } from '../types'

export function useTasks(): Task[] {
  const [tasks, setTasks] = useState<Task[]>([])

  useEffect(() => {
    const cleanup = onMessage((msg) => {
      if (msg.type === 'tasks/update')
        setTasks(msg.tasks)
    })
    postMessage({ type: 'tasks/request' })
    return cleanup
  }, [])

  return tasks
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm --filter webview-ui typecheck
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add webview-ui/src/hooks/useTasks.ts
git commit -m "✨ feat(webview-ui): useTasks hook 订阅扩展推送的任务列表"
```

---

### Task 17: 创建 TaskCard 组件（极简型）

**Files:**
- Create: `webview-ui/src/components/TaskCard.tsx`

- [ ] **Step 1: 创建 webview-ui/src/components/TaskCard.tsx**

```tsx
import type { Task, TaskState } from '../types'
import { postMessage } from '../lib/vscode'

const STATE_COLORS: Record<TaskState, string> = {
  'write-spec': 'border-blue-500 text-blue-400',
  'write-plan': 'border-blue-500 text-blue-400',
  'spec-review': 'border-yellow-500 text-yellow-400',
  'plan-review': 'border-yellow-500 text-yellow-400',
  'create-worktree': 'border-violet-500 text-violet-400',
  'implement': 'border-violet-500 text-violet-400',
  'review': 'border-orange-500 text-orange-400',
  'fix': 'border-red-500 text-red-400',
  'review-passed': 'border-green-500 text-green-400',
  'merge-cleanup': 'border-green-500 text-green-400',
}

const STATE_LABELS: Record<TaskState, string> = {
  'write-spec': '● 写 spec',
  'write-plan': '● 写 plan',
  'spec-review': '● spec 审查',
  'plan-review': '● plan 审查',
  'create-worktree': '● 建 worktree',
  'implement': '● 实施',
  'review': '● review',
  'fix': '● 修复',
  'review-passed': '● 审查通过',
  'merge-cleanup': '● 合并清理',
}

interface Props {
  task: Task
}

export function TaskCard({ task }: Props) {
  const colors = STATE_COLORS[task.state]
  const label = STATE_LABELS[task.state]

  const onOpen = (): void => {
    const target = task.planPath ?? task.specPath
    if (target)
      postMessage({ type: 'task/open', path: target })
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full text-left rounded-md border-l-[3px] bg-slate-800 hover:bg-slate-700 transition-colors p-3 cursor-pointer ${colors.split(' ')[0]}`}
    >
      <div className="text-sm font-semibold text-slate-100 truncate" title={task.title}>
        {task.title}
      </div>
      <div className={`text-xs mt-1 ${colors.split(' ')[1]}`}>
        {label}
      </div>
    </button>
  )
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm --filter webview-ui typecheck
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add webview-ui/src/components/TaskCard.tsx
git commit -m "✨ feat(webview-ui): 实现 TaskCard 极简卡片，状态色作左边框"
```

---

### Task 18: 创建 KanbanColumn 与 KanbanBoard

**Files:**
- Create: `webview-ui/src/components/KanbanColumn.tsx`
- Create: `webview-ui/src/components/KanbanBoard.tsx`

- [ ] **Step 1: 创建 webview-ui/src/components/KanbanColumn.tsx**

```tsx
import type { Task } from '../types'
import { TaskCard } from './TaskCard'

interface Props {
  title: string
  icon: string
  tasks: Task[]
}

export function KanbanColumn({ title, icon, tasks }: Props) {
  return (
    <div className="flex-1 min-w-0 flex flex-col rounded-md bg-slate-900 border border-slate-700 overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between bg-slate-800">
        <span className="text-xs uppercase tracking-wide text-slate-300 font-semibold">
          {icon}
          {' '}
          {title}
        </span>
        <span className="text-xs text-slate-400">{tasks.length}</span>
      </div>
      <div className="flex flex-col gap-2 p-2 overflow-y-auto flex-1">
        {tasks.length === 0
          ? <div className="text-xs text-slate-500 text-center py-4">No tasks</div>
          : tasks.map(t => <TaskCard key={t.id} task={t} />)}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 创建 webview-ui/src/components/KanbanBoard.tsx**

```tsx
import type { Task } from '../types'
import { KanbanColumn } from './KanbanColumn'

interface Props {
  tasks: Task[]
}

export function KanbanBoard({ tasks }: Props) {
  const planning = tasks.filter(t => t.phase === 'planning')
  const development = tasks.filter(t => t.phase === 'development')

  return (
    <div className="h-full flex flex-col p-2 gap-2">
      <div className="flex-1 min-h-0 flex gap-2">
        <KanbanColumn title="规划阶段" icon="📋" tasks={planning} />
        <KanbanColumn title="开发阶段" icon="⚙️" tasks={development} />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: typecheck**

```bash
pnpm --filter webview-ui typecheck
```

Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add webview-ui/src/components/KanbanColumn.tsx webview-ui/src/components/KanbanBoard.tsx
git commit -m "✨ feat(webview-ui): 实现 KanbanColumn 和 KanbanBoard 两列布局"
```

---

### Task 19: 接入 App.tsx —— 完成 webview 端联通

**Files:**
- Modify: `webview-ui/src/App.tsx` (完整替换)

- [ ] **Step 1: 完整替换 webview-ui/src/App.tsx**

```tsx
import { KanbanBoard } from './components/KanbanBoard'
import { useTasks } from './hooks/useTasks'

export function App() {
  const tasks = useTasks()
  return (
    <div className="h-screen w-screen overflow-hidden">
      <KanbanBoard tasks={tasks} />
    </div>
  )
}
```

- [ ] **Step 2: 跑 webview-ui build 验证**

```bash
pnpm --filter webview-ui build
```

Expected: build 成功，无 TS 错误，产物在 `dist/webview-ui/`。

- [ ] **Step 3: 跑完整 build（扩展 + webview）**

```bash
pnpm build
```

Expected: 两个 build 步骤都成功；`dist/index.cjs` 和 `dist/webview-ui/index.html` 都存在。

```bash
ls dist/ dist/webview-ui/ dist/webview-ui/assets/
```

Expected: `dist/index.cjs` 存在；`dist/webview-ui/index.html` 存在；assets 目录里有 .js 和 .css。

- [ ] **Step 4: Commit**

```bash
git add webview-ui/src/App.tsx
git commit -m "✨ feat(webview-ui): App 接入 useTasks 渲染 KanbanBoard"
```

---

### Task 20: 集成验证 —— 在 VS Code 中加载扩展

> 这是手动验证步骤。验证完成后在每个 checkbox 上打勾。

- [ ] **Step 1: 打包 .vsix**

```bash
pnpm ext:package
```

Expected: 输出 `superpowers-vscode-clurdra-0.2.0.vsix`。

- [ ] **Step 2: 在 VS Code 安装 .vsix**

在 VS Code 中按 `Ctrl+Shift+P` → `Extensions: Install from VSIX...`，选择刚生成的 `.vsix` 文件。

Expected: 提示安装成功；可能需要 Reload Window。

- [ ] **Step 3: 验证活动栏图标**

Expected: VS Code 活动栏左侧出现 Superpowers 图标。

- [ ] **Step 4: 准备测试工作区**

在某个 VS Code workspace 下创建：

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
printf '# Sample Spec\nbody\n' > docs/superpowers/specs/2026-05-15-sample-design.md
printf '# Sample Plan\nbody\n' > docs/superpowers/plans/2026-05-15-sample.md
printf '# Spec Only\nbody\n' > docs/superpowers/specs/2026-05-10-spec-only-design.md
```

- [ ] **Step 5: 点开 Superpowers 侧边栏**

Expected: 看到两列 Kanban；规划阶段列含 `Spec Only` 卡（左边框蓝色 + "● 写 plan"）；开发阶段列含 `Sample Spec` 卡（左边框紫色 + "● 实施"）。卡片右上有任务计数。

- [ ] **Step 6: 测试卡片点击**

点击 `Sample Spec` 卡。

Expected: 编辑器打开 `docs/superpowers/plans/2026-05-15-sample.md`（plan 优先于 spec）。

点击 `Spec Only` 卡。

Expected: 编辑器打开 `docs/superpowers/specs/2026-05-10-spec-only-design.md`。

- [ ] **Step 7: 测试文件监听**

在工作区终端执行：

```bash
printf '# Added\nbody\n' > docs/superpowers/plans/2026-05-16-added.md
```

Expected: Kanban 自动新增一张 `Added` 卡（开发阶段列）。

```bash
rm docs/superpowers/plans/2026-05-16-added.md
```

Expected: Kanban 自动移除该卡片。

- [ ] **Step 8: 测试刷新命令**

点击 Kanban view 标题栏的刷新按钮（齿轮位置）。

Expected: Kanban 重新加载，任务无变化（数据应该一致）。

- [ ] **Step 9: 验收清单核对**

逐项核对 spec 的"验收标准"：

1. `pnpm install` 成功 ✓
2. `pnpm build` 产出 `dist/index.cjs` 和 `dist/webview-ui/index.html` ✓
3. `pnpm typecheck` 两个工程通过 → 跑 `pnpm typecheck`，Expected: 通过
4. `pnpm test` 通过 → 跑 `pnpm test --run`，Expected: 9 个 scanner 测试通过
5. `pnpm ext:package` 产出 `.vsix` ✓
6. 活动栏有图标 ✓
7. Kanban 渲染 Task 卡片 ✓
8. 点卡片打开文件 ✓
9. 增删改自动刷新 ✓

- [ ] **Step 10: Commit 一次集成验证完成的标记**

如有改动（无），commit。否则跳过。

```bash
git status
# 如有改动，提交收尾
```

---

## Self-Review 检查清单（写完计划后留作记录）

**Spec 覆盖**：
- 目录结构 → Task 4/7/8/9/10/11 + Task 14（components.json）
- 构建管道 → Task 2（package.json scripts）+ Task 10（esbuild）+ Task 11（vite）
- 数据模型 → Task 4（types）
- Scanner 行为与命名约定 → Task 5/6
- 消息协议 → Task 7
- UI 设计（TaskCard 极简型）→ Task 17，状态色映射在卡片代码内
- VS Code 集成 → Task 2（contributes）+ Task 9（activation）
- 删除清单 → Task 1
- 技术栈 → Task 11/13/14
- 验收标准 → Task 20 逐项核对

**类型一致性**：`src/types.ts` 与 `webview-ui/src/types.ts` 在 Task 4 与 Task 15 内容完全一致；消息协议 `ExtensionToWebview` / `WebviewToExtension` 在 `src/panel/messages.ts`（Task 7）与 `webview-ui/src/types.ts`（Task 15）相同；scanner 输出的 `Task` 字段与 webview 端 `useTasks`/`TaskCard` 消费一致。

**Placeholder**：无 TBD / TODO 留白；唯一标注 TODO 的位置是 scanner.ts 的 `inferPhaseAndState` 函数，已在 spec 中作为遗留事项明确说明，不算计划失败。

**风险**：Tailwind v4 + shadcn 在 Task 13/14 通过实际 build 验证；CSP nonce 注入在 Task 8 完成，Task 20 集成测试验证；reactive-vscode 仅作为依赖保留（未用其 API），将来要替换 `extension.ts` 用 `defineExtension` 不影响本计划。

---

## 执行选项

Plan complete and saved to `docs/superpowers/plans/2026-05-15-react-shadcn-rewrite.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
