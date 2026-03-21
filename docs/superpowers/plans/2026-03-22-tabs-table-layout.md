# Tab 页 + 表格布局实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Superpowers 面板从两个 Section 布局改为 Tab 页 + 表格布局，并使用更明显的状态颜色。

**Architecture:** 在 html.ts 中重构 HTML 结构，添加 Tab 切换和表格渲染逻辑；在 index.ts 中添加 setPlanStatus 命令；移除右键菜单相关代码。

**Tech Stack:** VS Code Webview API, TypeScript

---

## 文件结构

| 文件 | 变更类型 | 职责 |
|------|----------|------|
| `src/webview/html.ts` | 修改 | Tab 布局 + 表格 + 状态徽章下拉菜单 |
| `src/index.ts` | 修改 | 添加 setPlanStatus 命令 |
| `src/webview/panel.ts` | 修改 | 处理 setPlanStatus 消息 |
| `src/planCompletion.ts` | 修改 | 添加 setPlanStatus 函数 |
| `test/webview/html.test.ts` | 创建 | 测试表格渲染和 Tab 切换 |
| `test/planStatus.test.ts` | 创建 | 测试状态切换逻辑 |

---

### Task 1: 添加 setPlanStatus 函数

**Files:**
- Modify: `src/planCompletion.ts`

- [ ] **Step 1: 添加 setPlanContentStatus 函数**

```typescript
export function setPlanContentStatus(content: string, status: 'completed' | 'needsTesting' | 'default'): string {
  // 先清除现有状态标记
  const updated = content.replace(/^> \*\*Status:\*\* .+\n/m, '')

  if (status === 'default') {
    return updated
  }

  // 添加新状态标记到文件开头（在第一个 # 之后）
  const lines = updated.split('\n')
  let insertIndex = 1 // 默认插在第一行（标题）之后

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('# ')) {
      insertIndex = i + 1
      break
    }
  }

  const statusText = status === 'completed' ? 'completed' : 'needs-testing'
  const statusLine = `> **Status:** ${statusText}`
  lines.splice(insertIndex, 0, statusLine)

  return lines.join('\n')
}
```

- [ ] **Step 2: 运行现有测试确认没有破坏**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 3: Commit**

```bash
git add src/planCompletion.ts
git commit -m "✨ feat(planCompletion): 添加 setPlanContentStatus 函数"
```

---

### Task 2: 添加 setPlanStatus 命令

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 添加 setPlanStatus 命令注册**

在 `superpowers.markPlanNeedsTesting` 命令之后添加：

```typescript
vscode.commands.registerCommand('superpowers.setPlanStatus', async (planPath?: string, status?: string) => {
  if (!planPath || !status)
    return

  const validStatuses = ['completed', 'needsTesting', 'default']
  if (!validStatuses.includes(status))
    return

  const content = fs.readFileSync(planPath, 'utf-8')
  const updatedContent = setPlanContentStatus(content, status as 'completed' | 'needsTesting' | 'default')

  if (updatedContent === content)
    return

  fs.writeFileSync(planPath, updatedContent, 'utf-8')
  await vscode.commands.executeCommand('superpowers.refresh')
})
```

- [ ] **Step 2: 添加 import**

在文件顶部添加：

```typescript
import { setPlanContentStatus } from './planCompletion'
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "✨ feat(index): 添加 setPlanStatus 命令"
```

---

### Task 3: 重构 html.ts 添加 Tab 布局和表格

**Files:**
- Modify: `src/webview/html.ts`

- [ ] **Step 1: 重写 getSuperpowersPanelHtmlContent 函数**

完全替换 `src/webview/html.ts` 的内容：

```typescript
export function getSuperpowersPanelHtmlContent(): string {
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
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 16px;
    }
    .tab {
      padding: 8px 16px;
      cursor: pointer;
      font-size: 13px;
      color: var(--vscode-tab-inactiveForeground);
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }
    .tab:hover {
      color: var(--vscode-tab-activeForeground);
    }
    .tab.active {
      color: var(--vscode-tab-activeForeground);
      border-bottom-color: var(--vscode-tab-activeBorder);
    }
    .tab .count {
      font-weight: normal;
      margin-left: 4px;
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .data-table th {
      text-align: left;
      padding: 8px 12px;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .data-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground);
    }
    .data-table tr:hover td {
      background: var(--vscode-list-hoverBackground);
    }
    .data-table .name {
      cursor: pointer;
    }
    .data-table .name:hover {
      color: var(--vscode-textLink-foreground);
    }
    .data-table .date {
      color: var(--vscode-descriptionForeground);
    }
    .data-table .progress {
      color: var(--vscode-descriptionForeground);
    }
    .data-table .progress.complete {
      color: #4ec9b0;
    }
    .data-table .action {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
    }
    .data-table .action:hover {
      text-decoration: underline;
    }
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .status-badge:hover {
      opacity: 0.9;
    }
    .status-badge.completed {
      background: #1a5f1a;
      color: #4ec9b0;
      border-color: #4ec9b0;
    }
    .status-badge.needsTesting {
      background: #5f3d00;
      color: #ce9178;
      border-color: #ce9178;
    }
    .status-badge.default {
      background: #3d3d3d;
      color: #cccccc;
      border-color: #888888;
    }
    .status-dropdown {
      position: absolute;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      z-index: 1000;
      min-width: 120px;
      display: none;
    }
    .status-dropdown.show {
      display: block;
    }
    .status-dropdown-item {
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
    }
    .status-dropdown-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      padding: 16px;
      text-align: center;
    }
    .toolbar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 12px;
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

  <div class="tabs">
    <div class="tab active" data-tab="specs" onclick="switchTab('specs')">
      Specs<span class="count" id="specs-count">(0)</span>
    </div>
    <div class="tab" data-tab="plans" onclick="switchTab('plans')">
      Plans<span class="count" id="plans-count">(0)</span>
    </div>
  </div>

  <div class="tab-content active" id="specs-tab">
    <table class="data-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>日期</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="specs-body"></tbody>
    </table>
  </div>

  <div class="tab-content" id="plans-tab">
    <table class="data-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>日期</th>
          <th>进度</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="plans-body"></tbody>
    </table>
  </div>

  <div class="status-dropdown" id="status-dropdown">
    <div class="status-dropdown-item" data-status="completed" onclick="selectStatus('completed')">已完成</div>
    <div class="status-dropdown-item" data-status="needsTesting" onclick="selectStatus('needsTesting')">需要测试</div>
    <div class="status-dropdown-item" data-status="default" onclick="selectStatus('default')">进行中</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const statusDropdown = document.getElementById('status-dropdown');
    let currentPlanPath = null;
    let currentStatus = null;

    function switchTab(tabName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelector('[data-tab="' + tabName + '"]').classList.add('active');
      document.getElementById(tabName + '-tab').classList.add('active');
    }

    function openFile(path) {
      vscode.postMessage({ command: 'openFile', path });
    }

    function refresh() {
      vscode.postMessage({ command: 'refresh' });
    }

    function showStatusDropdown(event, path, status) {
      event.stopPropagation();
      currentPlanPath = path;
      currentStatus = status;

      // 隐藏当前状态的选项
      document.querySelectorAll('.status-dropdown-item').forEach(item => {
        item.style.display = item.dataset.status === status ? 'none' : 'block';
      });

      statusDropdown.style.left = event.clientX + 'px';
      statusDropdown.style.top = (event.clientY + 20) + 'px';
      statusDropdown.classList.add('show');
    }

    function hideStatusDropdown() {
      statusDropdown.classList.remove('show');
      currentPlanPath = null;
      currentStatus = null;
    }

    function selectStatus(status) {
      if (currentPlanPath && status !== currentStatus) {
        vscode.postMessage({ command: 'setPlanStatus', path: currentPlanPath, status });
      }
      hideStatusDropdown();
    }

    document.addEventListener('click', hideStatusDropdown);

    function getStatusText(status) {
      switch (status) {
        case 'completed': return '已完成';
        case 'needsTesting': return '需要测试';
        default: return '进行中';
      }
    }

    function renderSpecs(specs) {
      const tbody = document.getElementById('specs-body');
      document.getElementById('specs-count').textContent = '(' + specs.length + ')';

      if (specs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无 Specs</td></tr>';
        return;
      }

      let html = '';
      specs.forEach(spec => {
        html += '<tr>';
        html += '<td class="name" onclick="openFile(\\'' + spec.path + '\\')">' + spec.title + '</td>';
        html += '<td class="date">' + spec.date + '</td>';
        html += '<td class="action" onclick="openFile(\\'' + spec.path + '\\')">打开</td>';
        html += '</tr>';
      });
      tbody.innerHTML = html;
    }

    function renderPlans(plans) {
      const tbody = document.getElementById('plans-body');
      document.getElementById('plans-count').textContent = '(' + plans.length + ')';

      if (plans.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无 Plans</td></tr>';
        return;
      }

      let html = '';
      plans.forEach(plan => {
        const progressText = plan.progress.completed + '/' + plan.progress.total;
        const progressClass = plan.status === 'completed' ? 'complete' : '';
        const statusClass = plan.status || 'default';
        const statusText = getStatusText(plan.status);

        html += '<tr>';
        html += '<td class="name" onclick="openFile(\\'' + plan.path + '\\')">' + plan.title + '</td>';
        html += '<td class="date">' + plan.date + '</td>';
        html += '<td class="progress ' + progressClass + '">' + progressText + '</td>';
        html += '<td><span class="status-badge ' + statusClass + '" onclick="showStatusDropdown(event, \\'' + plan.path + '\\', \\'' + statusClass + '\\')">' + statusText + ' ▾</span></td>';
        html += '<td class="action" onclick="openFile(\\'' + plan.path + '\\')">打开</td>';
        html += '</tr>';
      });
      tbody.innerHTML = html;
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'updateData') {
        renderSpecs(message.data.specs);
        renderPlans(message.data.plans);
      }
    });
  </script>
</body>
</html>`
}
```

- [ ] **Step 2: Commit**

```bash
git add src/webview/html.ts
git commit -m "✨ feat(html): 重构为 Tab 布局 + 表格 + 状态下拉菜单"
```

---

### Task 4: 更新 panel.ts 处理新消息

**Files:**
- Modify: `src/webview/panel.ts`

- [ ] **Step 1: 添加 setPlanStatus 消息处理**

在 `_handleMessage` 方法的 switch 语句中添加：

```typescript
case 'setPlanStatus':
  vscode.commands.executeCommand('superpowers.setPlanStatus', message.path, message.status)
  break
```

- [ ] **Step 2: Commit**

```bash
git add src/webview/panel.ts
git commit -m "✨ feat(panel): 添加 setPlanStatus 消息处理"
```

---

### Task 5: 移除旧的右键菜单代码

**Files:**
- Modify: `src/webview/html.ts`

- [ ] **Step 1: 删除右键菜单相关代码**

新版本的 html.ts 已经不包含右键菜单代码，此任务在 Task 3 重写 html.ts 时已完成。确认新版本中不包含：
- `context-menu` 相关 HTML 元素
- `contextmenu` 事件监听
- `showContextMenu` 函数

- [ ] **Step 2: 验证没有残留引用**

Run: `grep -r "context-menu\|contextmenu\|showContextMenu" src/`
Expected: 无输出（或仅在注释中）

---

### Task 6: 更新测试

**Files:**
- Create: `test/webview/html.test.ts`
- Delete: `test/panel.test.ts`（旧测试已不再适用）

- [ ] **Step 1: 创建 webview 目录**

```bash
mkdir -p test/webview
```

- [ ] **Step 2: 创建 html.test.ts**

```typescript
import { describe, expect, it } from 'vitest'
import { getSuperpowersPanelHtmlContent } from '../../src/webview/html'

describe('getSuperpowersPanelHtmlContent', () => {
  it('包含 Tab 切换元素', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).toContain('class="tab"')
    expect(html).toContain('data-tab="specs"')
    expect(html).toContain('data-tab="plans"')
  })

  it('包含表格结构', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).toContain('class="data-table"')
    expect(html).toContain('id="specs-body"')
    expect(html).toContain('id="plans-body"')
  })

  it('包含状态下拉菜单', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).toContain('class="status-dropdown"')
    expect(html).toContain('data-status="completed"')
    expect(html).toContain('data-status="needsTesting"')
    expect(html).toContain('data-status="default"')
  })

  it('包含 switchTab 函数', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).toContain('function switchTab')
  })

  it('包含状态徽章样式', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).toContain('.status-badge.completed')
    expect(html).toContain('.status-badge.needsTesting')
    expect(html).toContain('.status-badge.default')
  })

  it('不包含旧的右键菜单代码', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).not.toContain('context-menu')
    expect(html).not.toContain('contextmenu')
  })
})
```

- [ ] **Step 3: 删除旧的 panel.test.ts**

```bash
rm test/panel.test.ts
```

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add test/
git commit -m "✅ test: 重构 webview 测试，移除旧的 panel.test.ts"
```

---

### Task 7: 集成测试

**Files:**
- 无文件变更

- [ ] **Step 1: 编译并运行插件**

Run: `npm run compile`
Expected: 编译成功

- [ ] **Step 2: 按 F5 启动调试**

手动测试：
1. 点击 Superpowers 图标打开面板
2. 确认 Specs 和 Plans 两个 Tab 存在
3. 切换 Tab 确认表格显示正确
4. 确认状态徽章颜色明显
5. 点击状态徽章确认下拉菜单显示
6. 选择新状态确认文件更新

---

## 完成检查

- [ ] Tab 切换正常工作
- [ ] Specs 表格显示名称、日期、操作
- [ ] Plans 表格显示名称、日期、进度、状态、操作
- [ ] 状态徽章颜色使用深色背景
- [ ] 点击状态徽章显示下拉菜单
- [ ] 选择状态后文件正确更新
- [ ] 点击名称或"打开"正确打开文件
- [ ] 所有测试通过
