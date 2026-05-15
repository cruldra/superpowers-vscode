# React + shadcn/ui 重写设计

## 背景与目标

当前 `superpowers-vscode` 插件的 webview UI 使用 14KB 的内联 HTML/JS（`src/webview/html.ts`），表格 + Tab 布局，配套一系列功能（运行 plan、worktree、状态写回 markdown）。这次整体重写：

1. **技术栈现代化**：webview 改用 React + TypeScript + shadcn/ui + Tailwind，扩展打包器从 `tsdown` 换成 `esbuild`，对齐主流 VS Code 插件（Cline、Roo-Code、Continue）。
2. **UI 重设计为 Kanban**：两列泳道（规划阶段、开发阶段），用徽标体现具体子状态。
3. **大幅缩窄功能**：骨架阶段只保留 spec/plan 文件扫描和 Kanban 展示，删除运行 plan、worktree、状态写回、删除文件等所有其他功能。

终态是一个**最小可用的脚手架**，跑起来能看到两列 Kanban 渲染本地 specs/plans 文件，点卡片能打开对应文件。后续功能在新骨架上增量加。

## 非目标

本次重写**不**包含：

- 运行 plan、git worktree、systemd-run、opencode 集成
- 把 plan 状态写回 markdown 文件
- 删除 spec/plan 文件的 UI 操作
- 卡片状态的"准确"判定（状态推断逻辑只放占位，等后续单独设计）
- 拖拽（不引入 dnd-kit 等）
- 状态管理库（不引入 Zustand/Redux）

## 参考项目

调研了三个高 star 的 React-webview 插件，结构高度一致：

| 项目 | 结构特点 |
|---|---|
| **Cline** | 根目录 `src/`（扩展）+ `webview-ui/`（独立 Vite + shadcn），`esbuild.mjs` 打包扩展 |
| **Roo-Code** | pnpm workspace，`src/` + `webview-ui/`，`esbuild.mjs`，`components.json` 配 shadcn |
| **Continue** | `extensions/` + `gui/`（webview），同样 esbuild |

本设计直接采纳这个模式。

## 目录结构

```
superpowers-vscode/
├── package.json                # 根包（扩展），pnpm workspace 根
├── pnpm-workspace.yaml         # 声明 webview-ui 为子包
├── tsconfig.json               # 扩展 tsconfig
├── esbuild.mjs                 # 扩展打包脚本（替代 tsdown.config.ts）
├── eslint.config.mjs           # 保留
├── res/                        # 图标资源保留
├── docs/superpowers/           # 保留目录，旧示例文件清空
│   ├── specs/                  # 本设计文件留这里
│   └── plans/
├── src/                        # 扩展主进程
│   ├── extension.ts            # 激活入口（重写自 index.ts）
│   ├── scanner.ts              # 扫描 + 配对成 Task（重写）
│   ├── types.ts                # Task / Phase / State（重写）
│   ├── panel/
│   │   ├── KanbanPanel.ts      # webview 宿主，加载 vite 产物
│   │   └── messages.ts         # 消息协议（与 webview 共享）
│   └── generated/meta.ts       # vscode-ext-gen 生成
├── webview-ui/                 # 独立 Vite 子包
│   ├── package.json
│   ├── components.json         # shadcn/ui 配置 (New York 风格)
│   ├── tailwind.config.ts
│   ├── vite.config.ts          # 输出到 ../dist/webview-ui/
│   ├── index.html
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx             # Kanban 顶层
│       ├── index.css           # tailwind 入口
│       ├── components/
│       │   ├── ui/             # shadcn 生成（badge、card 等按需）
│       │   ├── KanbanBoard.tsx
│       │   ├── KanbanColumn.tsx
│       │   └── TaskCard.tsx
│       ├── hooks/useTasks.ts   # 订阅扩展消息
│       ├── lib/vscode.ts       # acquireVsCodeApi 封装
│       ├── lib/utils.ts        # shadcn cn() 工具
│       └── types.ts            # 镜像 src/types.ts 的运行时类型
└── test/                       # Vitest（扩展端）
    ├── scanner.test.ts
    └── extension.test.ts       # 重写自 index.test.ts
```

## 构建管道

| 任务 | 工具 | 输出 |
|---|---|---|
| 扩展打包 | esbuild（`esbuild.mjs`） | `dist/index.cjs` |
| Webview 打包 | Vite + `@vitejs/plugin-react` | `dist/webview-ui/{index.html,assets/*}` |
| Tailwind | `@tailwindcss/vite` (v4) | 内联进 vite 产物 |
| 类型检查 | `tsc --noEmit` × 2 工程 | — |
| 测试 | Vitest（仅扩展端） | — |

根 `package.json` 的关键 scripts：

```jsonc
{
  "scripts": {
    "build": "pnpm --filter webview-ui build && node esbuild.mjs --production",
    "dev": "concurrently \"pnpm --filter webview-ui dev\" \"node esbuild.mjs --watch\"",
    "typecheck": "tsc --noEmit && pnpm --filter webview-ui typecheck",
    "test": "vitest",
    "lint": "eslint .",
    "ext:package": "vsce package --no-dependencies"
  }
}
```

`KanbanPanel.ts` 加载 webview 时：

1. 读 `dist/webview-ui/index.html` 文本
2. 用 `panel.webview.asWebviewUri()` 重写其中所有 `<script src=...>` 和 `<link href=...>` 的相对路径
3. 注入 CSP `<meta>` 和 nonce（参考 Cline `WebviewProvider`）

## 数据模型

`src/types.ts` 与 `webview-ui/src/types.ts` 保持镜像：

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
  id: string            // `${date}-${topic}`
  title: string         // 取 spec 的首个 H1，缺则取 plan 的，再缺取 topic
  date: string          // YYYY-MM-DD
  topic: string         // 文件名中间段
  specPath?: string     // 绝对路径
  planPath?: string
  phase: Phase
  state: TaskState
}
```

### 命名约定（重写后强制执行）

旧 specs/plans 文件已删，从骨架开始约定：

- **Spec 文件名**：`YYYY-MM-DD-<topic>-design.md`
- **Plan 文件名**：`YYYY-MM-DD-<topic>.md`（与对应 spec 的 `<topic>` 完全一致）

`<topic>` 用 kebab-case，可含连字符。匹配靠 `${date}-${topic}` 这个完整 key。

### Scanner 行为

1. 扫描 `<workspace>/docs/superpowers/specs/*.md` 和 `.../plans/*.md`
2. 文件名解析：
   - Spec 正则：`^(\d{4}-\d{2}-\d{2})-(.+)-design\.md$` → 组 1 = date，组 2 = topic
   - Plan 正则：`^(\d{4}-\d{2}-\d{2})-(.+)\.md$` → 组 1 = date，组 2 = topic
   - 不匹配格式的文件忽略
3. 以 `${date}-${topic}` 为 key 配对：
   - 同 key 的 spec + plan 合成一个 Task
   - 只有 spec 或只有 plan 也独立成一个 Task
4. **状态判定（占位逻辑，搭骨架阶段）**：
   - 只有 spec → `phase=planning, state=write-plan`
   - 同时有 spec + plan → `phase=development, state=implement`
   - 只有 plan → `phase=development, state=implement`
   - 代码里加 `// TODO: 状态判定逻辑等下一轮迭代补充`，集中在 `scanner.ts` 内一个函数里，方便替换。
5. 输出按 `date` 倒序。

## 消息协议

`src/panel/messages.ts` 与 `webview-ui/src/lib/vscode.ts` 共享类型：

```ts
export type ExtensionToWebview =
  | { type: 'tasks/update'; tasks: Task[] }

export type WebviewToExtension =
  | { type: 'tasks/request' }
  | { type: 'task/open'; path: string }
```

### 交互流程

1. webview 挂载后发 `tasks/request`
2. 扩展运行 scanner，回 `tasks/update`
3. 扩展用 `vscode.workspace.createFileSystemWatcher('**/docs/superpowers/{specs,plans}/*.md')` 监听增删改，命中即重新扫描并 push `tasks/update`
4. 用户点卡片时 webview 发 `task/open`，扩展用 `vscode.window.showTextDocument` 打开文件

## UI 设计

### Kanban 整体

- 两列等宽布局，column header 显示阶段名 + 任务计数（"📋 规划阶段 (3)"、"⚙️ 开发阶段 (2)"）
- 暗色背景跟随 VS Code 主题变量（`--vscode-editor-background` 等）
- 顶部一个 toolbar 区域占位（暂留空，后续可加搜索/筛选/刷新按钮）

### TaskCard（极简型，选定方案 C）

每张卡片包含：

- 标题（一行，溢出截断）
- 状态文字（小字号 + 状态色）
- 左侧 3px 状态色边框

状态色映射：

| 子状态 | 色值（占位）|
|---|---|
| write-spec, write-plan | 蓝 `#3b82f6` |
| spec-review, plan-review | 黄 `#fbbf24` |
| create-worktree, implement | 紫 `#a78bfa` |
| review | 橙 `#f97316` |
| fix | 红 `#ef4444` |
| review-passed, merge-cleanup | 绿 `#22c55e` |

每张卡点击触发 `task/open`：优先打开 plan，缺则打开 spec。

### shadcn 组件用量

最小集，按需 `pnpm dlx shadcn@latest add`：

- `card`（KanbanColumn 用）
- `badge`（状态徽标用）

其他视觉用 Tailwind 类直写，不为求"看起来很 shadcn"额外引组件。

## VS Code 集成

`package.json` 的 `contributes`：

```jsonc
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [{
        "id": "superpowers",
        "title": "Superpowers",
        "icon": "res/icon.svg"
      }]
    },
    "views": {
      "superpowers": [{
        "id": "superpowers.kanban",
        "name": "Kanban",
        "type": "webview"
      }]
    },
    "commands": [
      { "command": "superpowers.refresh", "title": "Refresh Superpowers Kanban" }
    ]
  }
}
```

**注意**：视图改用 `type: "webview"` 的 view（嵌在活动栏侧边栏里），不再用单独的 WebviewPanel。这样和 Cline / Roo-Code 行为一致——侧边栏点图标直接显示 Kanban。

旧的 `superpowers.openPanel`、`superpowers.runPlan`、所有 `superpowers.run*` 和 `superpowers.worktreeDirectory` 配置项**全部移除**。

## 删除清单

骨架阶段统一清掉：

```
src/index.ts
src/runPlan.ts
src/worktree.ts
src/planCompletion.ts
src/panelOpenInteraction.ts
src/treeView.ts
src/config.ts
src/utils.ts
src/extensionRuntime.ts
src/webview/html.ts
src/webview/panel.ts
src/scanner.ts                  (会重写，但旧文件先删)
src/types.ts                    (同上)
test/runPlan.test.ts
test/worktree.test.ts
test/index.test.ts
test/extensionRuntime.test.ts
test/scanner.test.ts            (重写)
docs/superpowers/specs/2026-03-*.md
docs/superpowers/plans/2026-03-*.md
docs/superpowers/plans/2026-03-31-*.md
tsdown.config.ts
taze.config.ts
package.json 中 superpowers.run* 和 worktreeDirectory 配置项
package.json 中 superpowers.openPanel 和 superpowers.runPlan 命令
devDependencies: tsdown, taze
```

保留：`res/`、`README.md`（后期重写）、`LICENSE.md`、`eslint.config.mjs`、`pnpm-workspace.yaml`、`.vscode/`、`.github/`、`.gitignore`。

新增：`esbuild.mjs`、`webview-ui/` 整目录、`src/extension.ts`、`src/scanner.ts`、`src/types.ts`、`src/panel/KanbanPanel.ts`、`src/panel/messages.ts`、新的 `test/scanner.test.ts`、`test/extension.test.ts`。

## 技术栈

| 层 | 选型 | 版本约束 |
|---|---|---|
| 扩展运行时 | TypeScript + reactive-vscode | 沿用现有 |
| 扩展打包 | esbuild | ^0.25 |
| Webview 框架 | React | ^19 |
| Webview 打包 | Vite + `@vitejs/plugin-react` | Vite ^6 |
| UI 组件库 | shadcn/ui (New York 风格) + Radix UI | shadcn CLI 拉最新 |
| 样式 | Tailwind CSS v4 + `@tailwindcss/vite` | ^4 |
| 测试 | Vitest | 沿用 |
| 包管理 | pnpm + workspace | 沿用 |

## 验收标准

骨架完成的可验证标志：

1. `pnpm install` 成功（含 webview-ui 子包）
2. `pnpm build` 产出 `dist/index.cjs` 和 `dist/webview-ui/index.html`
3. `pnpm typecheck` 两个工程都通过
4. `pnpm test` 通过（含 scanner 配对逻辑测试）
5. `pnpm ext:package` 产出 `.vsix` 文件
6. 在 VS Code 中安装 `.vsix`，活动栏出现 Superpowers 图标
7. 在装有 `docs/superpowers/specs/*.md` 和 `.../plans/*.md` 的工作区点开侧边栏，看到两列 Kanban 渲染对应 Task 卡片
8. 点卡片打开对应 markdown 文件
9. 新增 / 删除 / 修改 spec 或 plan 文件，Kanban 自动刷新

## 风险与遗留

- **状态判定逻辑是 TODO**：当前 Task.state 只能反映三种情况，未来要决定状态来源（frontmatter / workspace state / 手动点选 / 混合）。`scanner.ts` 的状态判定函数会被独立出来，方便替换。
- **CSP + asWebviewUri 重写**：Vite 产物用 `type="module"` 的 `<script>`，VS Code webview 对 ES module 的 CSP 限制需特别处理，参考 Cline `WebviewProvider.getHtmlContent`。
- **Tailwind v4 + shadcn**：shadcn 官方文档以 Tailwind v3 为主，v4 需用 `@theme` 语法和新的 `@tailwindcss/vite`。需要在脚手架阶段验证一次完整链路。
- **reactive-vscode 与 webview**：reactive-vscode 主打响应式 API 给扩展端用，webview 侧不依赖它，桥接靠裸 postMessage。
