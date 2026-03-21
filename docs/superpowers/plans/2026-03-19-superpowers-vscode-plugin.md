# Superpowers VS Code 插件实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一个 VS Code 插件，展示和管理项目中由 superpowers 生成的 specs 和 plans 文档。

**Architecture:** 左侧 TreeView 作为入口，点击后在编辑区打开 WebviewPanel，通过文件扫描器解析 `docs/superpowers/` 目录下的 Markdown 文件并展示。

**Tech Stack:** TypeScript, VS Code Extension API, reactive-vscode

---

## Task 1: 创建类型定义

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: 创建类型定义文件**

```typescript
// src/types.ts
export interface SpecFile {
  name: string
  date: string
  title: string
  path: string
}

export interface PlanFile {
  name: string
  date: string
  title: string
  path: string
  progress: {
    completed: number
    total: number
  }
}

export interface SuperpowersData {
  specs: SpecFile[]
  plans: PlanFile[]
}

export interface GroupedFiles {
  [date: string]: SpecFile[] | PlanFile[]
}
```

- [ ] **Step 2: 提交**

```bash
git add src/types.ts
git commit -m "✨ feat: 添加类型定义"
```

---

## Task 2: 实现文件扫描器

**Files:**
- Create: `src/scanner.ts`
- Create: `test/scanner.test.ts`

- [ ] **Step 1: 创建扫描器测试**

```typescript
// test/scanner.test.ts
import { describe, expect, it } from 'vitest'
import { SuperpowersScanner } from '../src/scanner'

describe('SuperpowersScanner', () => {
  const scanner = new SuperpowersScanner()

  describe('parseSpec', () => {
    it('从内容中提取 H1 标题', () => {
      const content = '# 测试标题\n\n这是内容'
      const result = scanner.parseSpec(content, 'test-file')
      expect(result.title).toBe('测试标题')
    })

    it('无标题时使用文件名', () => {
      const content = '无标题内容'
      const result = scanner.parseSpec(content, 'test-file')
      expect(result.title).toBe('test-file')
    })
  })

  describe('parsePlan', () => {
    it('计算任务进度', () => {
      const content = `# 计划

- [x] 任务1
- [x] 任务2
- [ ] 任务3
- [ ] 任务4`
      const result = scanner.parsePlan(content, 'test-plan')
      expect(result.progress.completed).toBe(2)
      expect(result.progress.total).toBe(4)
    })

    it('无任务时进度为零', () => {
      const content = '# 计划\n\n无任务'
      const result = scanner.parsePlan(content, 'test-plan')
      expect(result.progress.completed).toBe(0)
      expect(result.progress.total).toBe(0)
    })
  })

  describe('parseDateFromFilename', () => {
    it('从文件名提取日期', () => {
      expect(scanner.parseDateFromFilename('2026-03-19-test-design.md')).toBe('2026-03-19')
      expect(scanner.parseDateFromFilename('2026-03-18-test.md')).toBe('2026-03-18')
    })

    it('无效日期返回空字符串', () => {
      expect(scanner.parseDateFromFilename('test.md')).toBe('')
    })
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

```bash
pnpm test
```

Expected: 测试失败，因为 scanner.ts 不存在

- [ ] **Step 3: 实现扫描器**

```typescript
import type { PlanFile, SpecFile, SuperpowersData } from './types'
import * as fs from 'node:fs'
import * as path from 'node:path'
// src/scanner.ts
import * as vscode from 'vscode'

export class SuperpowersScanner {
  private readonly specsDir = 'docs/superpowers/specs'
  private readonly plansDir = 'docs/superpowers/plans'

  async scan(workspaceRoot: string): Promise<SuperpowersData> {
    const [specs, plans] = await Promise.all([
      this.scanDir(path.join(workspaceRoot, this.specsDir), 'spec'),
      this.scanDir(path.join(workspaceRoot, this.plansDir), 'plan'),
    ])

    return { specs, plans }
  }

  private async scanDir(dirPath: string, type: 'spec' | 'plan'): Promise<SpecFile[] | PlanFile[]> {
    if (!fs.existsSync(dirPath)) {
      return []
    }

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'))
    const results: SpecFile[] | PlanFile[] = []

    for (const file of files) {
      const filePath = path.join(dirPath, file)
      const content = fs.readFileSync(filePath, 'utf-8')
      const date = this.parseDateFromFilename(file)

      if (type === 'spec') {
        const parsed = this.parseSpec(content, file)
        results.push({
          name: file.replace('.md', ''),
          date,
          title: parsed.title,
          path: filePath,
        })
      }
      else {
        const parsed = this.parsePlan(content, file)
        results.push({
          name: file.replace('.md', ''),
          date,
          title: parsed.title,
          path: filePath,
          progress: parsed.progress,
        })
      }
    }

    // 按日期倒序排序
    return results.sort((a, b) => b.date.localeCompare(a.date))
  }

  parseSpec(content: string, fileName: string): { title: string } {
    const titleMatch = content.match(/^# (.+)$/m)
    return {
      title: titleMatch ? titleMatch[1] : fileName.replace('.md', ''),
    }
  }

  parsePlan(content: string, fileName: string): { title: string, progress: { completed: number, total: number } } {
    const titleMatch = content.match(/^# (.+)$/m)
    const completed = (content.match(/^- \[x\]/gim) || []).length
    const total = (content.match(/^- \[[ x]\]/gim) || []).length

    return {
      title: titleMatch ? titleMatch[1] : fileName.replace('.md', ''),
      progress: { completed, total },
    }
  }

  parseDateFromFilename(filename: string): string {
    const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/)
    return dateMatch ? dateMatch[1] : ''
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
pnpm test
```

Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
git add src/scanner.ts test/scanner.test.ts
git commit -m "✨ feat: 实现文件扫描器"
```

---

## Task 3: 创建 WebviewPanel

**Files:**
- Create: `src/webview/panel.ts`

- [ ] **Step 1: 创建 WebviewPanel 类**

```typescript
import type { PlanFile, SpecFile, SuperpowersData } from '../types'
// src/webview/panel.ts
import * as vscode from 'vscode'

export class SuperpowersPanel {
  public static currentPanel: SuperpowersPanel | undefined
  private readonly _panel: vscode.WebviewPanel
  private readonly _extensionUri: vscode.Uri
  private _disposables: vscode.Disposable[] = []

  public static createOrShow(extensionUri: vscode.Uri): SuperpowersPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined

    if (SuperpowersPanel.currentPanel) {
      SuperpowersPanel.currentPanel._panel.reveal(column)
      return SuperpowersPanel.currentPanel
    }

    const panel = vscode.window.createWebviewPanel(
      'superpowersExplorer',
      'Superpowers Explorer',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    )

    SuperpowersPanel.currentPanel = new SuperpowersPanel(panel, extensionUri)
    return SuperpowersPanel.currentPanel
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel
    this._extensionUri = extensionUri

    this._panel.webview.html = this._getHtmlContent()

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    this._panel.webview.onDidReceiveMessage(
      message => this._handleMessage(message),
      null,
      this._disposables
    )
  }

  public updateData(data: SuperpowersData): void {
    this._panel.webview.postMessage({ type: 'updateData', data })
  }

  private _handleMessage(message: any): void {
    switch (message.command) {
      case 'openFile':
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(message.path))
        break
      case 'refresh':
        vscode.commands.executeCommand('superpowers.refresh')
        break
    }
  }

  private _getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Superpowers Explorer</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
    }
    h2 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    h2 .count {
      font-weight: normal;
      color: var(--vscode-descriptionForeground);
    }
    .section {
      margin-bottom: 24px;
    }
    .date-group {
      margin-bottom: 16px;
    }
    .date-header {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      padding: 4px 8px;
      background: var(--vscode-list-hoverBackground);
      border-radius: 4px;
      margin-bottom: 8px;
    }
    .file-list {
      list-style: none;
    }
    .file-item {
      padding: 8px 12px;
      cursor: pointer;
      border-radius: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2px;
    }
    .file-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .file-title {
      font-size: 13px;
    }
    .progress {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .progress.complete {
      color: var(--vscode-testing-iconPassed);
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      padding: 8px 12px;
    }
    .toolbar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 16px;
    }
    .refresh-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .refresh-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="refresh-btn" onclick="refresh()">刷新</button>
  </div>

  <div class="section">
    <h2>📋 Specs <span class="count" id="specs-count">(0)</span></h2>
    <div id="specs-content"></div>
  </div>

  <div class="section">
    <h2>📋 Plans <span class="count" id="plans-count">(0)</span></h2>
    <div id="plans-content"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function renderFiles(files, containerId, type) {
      const container = document.getElementById(containerId);
      const countEl = document.getElementById(containerId.replace('-content', '-count'));

      if (!files || files.length === 0) {
        container.innerHTML = '<div class="empty">暂无文件</div>';
        countEl.textContent = '(0)';
        return;
      }

      countEl.textContent = '(' + files.length + ')';

      // 按日期分组
      const groups = {};
      files.forEach(file => {
        const date = file.date || '未知日期';
        if (!groups[date]) {
          groups[date] = [];
        }
        groups[date].push(file);
      });

      let html = '';
      Object.keys(groups).sort().reverse().forEach(date => {
        html += '<div class="date-group">';
        html += '<div class="date-header">' + date + '</div>';
        html += '<ul class="file-list">';
        groups[date].forEach(file => {
          html += '<li class="file-item" onclick="openFile(\\'' + file.path + '\\')">';
          html += '<span class="file-title">' + file.title + '</span>';
          if (type === 'plan' && file.progress) {
            const cls = file.progress.completed === file.progress.total ? 'progress complete' : 'progress';
            html += '<span class="' + cls + '">[' + file.progress.completed + '/' + file.progress.total + ']</span>';
          }
          html += '</li>';
        });
        html += '</ul></div>';
      });

      container.innerHTML = html;
    }

    function openFile(path) {
      vscode.postMessage({ command: 'openFile', path });
    }

    function refresh() {
      vscode.postMessage({ command: 'refresh' });
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'updateData') {
        renderFiles(message.data.specs, 'specs-content', 'spec');
        renderFiles(message.data.plans, 'plans-content', 'plan');
      }
    });
  </script>
</body>
</html>`
  }

  public dispose(): void {
    SuperpowersPanel.currentPanel = undefined

    this._panel.dispose()

    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/webview/panel.ts
git commit -m "✨ feat: 创建 WebviewPanel 组件"
```

---

## Task 4: 创建 TreeView

**Files:**
- Create: `src/treeView.ts`

- [ ] **Step 1: 创建 TreeView Provider**

```typescript
// src/treeView.ts
import * as vscode from 'vscode'

export class SuperpowersTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | null | void> = new vscode.EventEmitter<TreeItem | undefined | null | void>()
  readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | null | void> = this._onDidChangeTreeData.event

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: TreeItem): Thenable<TreeItem[]> {
    if (!element) {
      return Promise.resolve([
        new TreeItem('Superpowers', vscode.TreeItemCollapsibleState.None, 'superpowers.root'),
      ])
    }
    return Promise.resolve([])
  }

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }
}

class TreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue?: string
  ) {
    super(label, collapsibleState)
    this.iconPath = new vscode.ThemeIcon('rocket')
    this.tooltip = '点击打开 Superpowers Explorer'
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/treeView.ts
git commit -m "✨ feat: 创建 TreeView Provider"
```

---

## Task 5: 更新 package.json

**Files:**
- Modify: `package.json`

**注意**: 需要合并以下字段到现有 `package.json`，保留 `scripts`、`devDependencies`、`repository` 等现有字段。

- [ ] **Step 1: 更新元数据字段**

修改以下字段：
```json
{
  "publisher": "superpowers",
  "name": "superpowers-vscode",
  "displayName": "Superpowers",
  "version": "0.1.0",
  "description": "Superpowers specs and plans explorer",
  "author": "Superpowers"
}
```

- [ ] **Step 2: 更新 activationEvents**

```json
{
  "activationEvents": [
    "onView:superpowers-explorer",
    "onCommand:superpowers.refresh"
  ]
}
```

- [ ] **Step 3: 添加 contributes**

```json
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "superpowers-explorer",
          "title": "Superpowers",
          "icon": "res/icon.svg"
        }
      ]
    },
    "views": {
      "superpowers-explorer": [
        {
          "id": "superpowers-explorer",
          "name": "Superpowers"
        }
      ]
    },
    "commands": [
      {
        "command": "superpowers.openPanel",
        "title": "Open Superpowers Explorer"
      },
      {
        "command": "superpowers.refresh",
        "title": "Refresh Superpowers Data"
      }
    ],
    "menus": {
      "view/title": [
        {
          "command": "superpowers.refresh",
          "when": "view == superpowers-explorer",
          "group": "navigation"
        }
      ]
    },
    "configuration": {
      "type": "object",
      "title": "Superpowers",
      "properties": {}
    }
  }
}
```

- [ ] **Step 4: 提交**

```bash
git add package.json
git commit -m "✨ feat: 更新 package.json 元数据和贡献点"
```

---

## Task 6: 集成所有组件

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 更新入口文件**

```typescript
// src/index.ts
import { defineExtension } from 'reactive-vscode'
import * as vscode from 'vscode'
import { SuperpowersScanner } from './scanner'
import { SuperpowersTreeDataProvider } from './treeView'
import { SuperpowersPanel } from './webview/panel'

export const { activate, deactivate } = defineExtension(() => {
  const scanner = new SuperpowersScanner()
  const treeDataProvider = new SuperpowersTreeDataProvider()

  // 注册 TreeView
  vscode.window.createTreeView('superpowers-explorer', {
    treeDataProvider,
    showCollapseAll: false,
  })

  // 注册命令
  vscode.commands.registerCommand('superpowers.openPanel', async () => {
    const panel = SuperpowersPanel.createOrShow(vscode.extensions.getExtension('superpowers.superpowers-vscode')!.extensionUri)

    // 扫描并更新数据
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (workspaceFolders && workspaceFolders.length > 0) {
      const data = await scanner.scan(workspaceFolders[0].uri.fsPath)
      panel.updateData(data)
    }
  })

  vscode.commands.registerCommand('superpowers.refresh', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (workspaceFolders && workspaceFolders.length > 0) {
      const data = await scanner.scan(workspaceFolders[0].uri.fsPath)
      if (SuperpowersPanel.currentPanel) {
        SuperpowersPanel.currentPanel.updateData(data)
      }
    }
    treeDataProvider.refresh()
  })

  // TreeView 点击事件
  vscode.commands.registerCommand('superpowers.root', () => {
    vscode.commands.executeCommand('superpowers.openPanel')
  })
})
```

- [ ] **Step 2: 提交**

```bash
git add src/index.ts
git commit -m "✨ feat: 集成所有组件"
```

---

## Task 7: 更新图标

**Files:**
- Modify: `res/icon.svg`

- [ ] **Step 1: 创建或更新 SVG 图标**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
  <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
  <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
  <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
</svg>
```

- [ ] **Step 2: 提交**

```bash
git add res/icon.svg
git commit -m "✨ feat: 更新插件图标"
```

---

## Task 8: 运行类型检查和构建

- [ ] **Step 1: 运行类型检查**

```bash
pnpm typecheck
```

Expected: 无错误

- [ ] **Step 2: 运行构建**

```bash
pnpm build
```

Expected: 构建成功

- [ ] **Step 3: 运行所有测试**

```bash
pnpm test
```

Expected: 所有测试通过

---

## 完成检查

- [ ] 运行 `pnpm typecheck` 无错误
- [ ] 运行 `pnpm build` 构建成功
- [ ] 运行 `pnpm test` 所有测试通过
- [ ] 在 VS Code 中按 F5 启动调试，验证功能
- [ ] 点击左侧 Superpowers 图标，确认打开面板
- [ ] 确认面板显示 specs 和 plans 数据
- [ ] 确认按日期分组展示
- [ ] 确认 plans 显示进度
