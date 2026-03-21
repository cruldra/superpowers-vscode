# Superpowers 面板 Tab 页 + 表格布局设计

## 背景

当前 Superpowers Explorer 面板使用两个独立的 Section 分别展示 Specs 和 Plans，每个 Section 内按日期分组，使用列表样式展示文件。

存在的问题：

1. Specs 和 Plans 混在一个页面中，视觉层次不够清晰
2. 列表样式信息密度较低，缺少表格的结构化展示
3. 状态颜色不够明显，用户反馈"不太明显"
4. 状态变更操作隐藏在右键菜单中，不够直观

## 目标

- Specs 和 Plans 用 Tab 页分开，每个 Tab 下是独立的表格
- 表格包含名称、日期、状态（Plans）、操作等列
- 状态使用更深的背景色，更加明显
- 状态变更通过操作列直接操作，无需右键菜单

## 非目标

- 不改变数据扫描逻辑和数据结构
- 不改变文件打开行为
- 不增加新的状态类型

## 设计方案

### 1. Tab 页布局

面板顶部添加 Tab 切换区域：

- 第一个 Tab：`Specs (n)` - 显示 specs 表格
- 第二个 Tab：`Plans (n)` - 显示 plans 表格

Tab 样式使用 VS Code 原生 Tab 样式，支持点击切换，当前 Tab 有底部高亮线。

### 2. Specs 表格

列定义：

| 列名 | 宽度 | 说明 |
|------|------|------|
| 名称 | 自适应 | spec 标题，可点击打开 |
| 日期 | 固定 | YYYY-MM-DD 格式 |
| 操作 | 固定 | "打开" 链接 |

点击名称或"打开"都会在编辑器中打开文件。

### 3. Plans 表格

列定义：

| 列名 | 宽度 | 说明 |
|------|------|------|
| 名称 | 自适应 | plan 标题，可点击打开 |
| 日期 | 固定 | YYYY-MM-DD 格式 |
| 进度 | 固定 | `n/m` 格式，如 `5/5`、`12/20` |
| 状态 | 固定 | 状态徽章，可点击切换 |
| 操作 | 固定 | "打开" 链接 |

### 4. 状态徽章

状态使用深色背景 + 亮色文字的徽章样式：

| 状态 | 背景色 | 文字色 | 说明 |
|------|--------|--------|------|
| 已完成 | `#1a5f1a` | `#4ec9b0` | 深绿底 + 亮绿字 |
| 需要测试 | `#5f3d00` | `#ce9178` | 深橙底 + 亮橙字 |
| 进行中 | `#3d3d3d` | `#cccccc` | 深灰底 + 浅灰字 |

状态徽章可点击，点击后弹出下拉菜单，显示可切换的状态选项。

### 5. 状态切换交互

点击状态徽章后，显示下拉菜单：

- 已完成状态：显示"需要测试"、"进行中"选项
- 需要测试状态：显示"已完成"选项
- 进行中状态：显示"已完成"、"需要测试"选项

选择后立即更新文件并刷新数据。

### 6. 移除右键菜单

由于状态切换已集成到状态徽章，移除现有的右键菜单实现。

## 技术实现

### HTML 结构变更

```html
<div class="tabs">
  <div class="tab active" data-tab="specs">Specs <span class="count">(2)</span></div>
  <div class="tab" data-tab="plans">Plans <span class="count">(3)</span></div>
</div>

<div class="tab-content" id="specs-tab">
  <table class="data-table">
    <thead>...</thead>
    <tbody>...</tbody>
  </table>
</div>

<div class="tab-content hidden" id="plans-tab">
  <table class="data-table">
    <thead>...</thead>
    <tbody>...</tbody>
  </table>
</div>
```

### CSS 样式

使用 VS Code CSS 变量：

- `--vscode-tab-activeBackground` - 活动 Tab 背景
- `--vscode-tab-activeForeground` - 活动 Tab 前景
- `--vscode-tab-inactiveForeground` - 非活动 Tab 前景
- `--vscode-list-hoverBackground` - 表格行 hover 背景

状态颜色使用硬编码值（非 VS Code 变量），确保在所有主题下都有足够对比度。

### JavaScript 逻辑

1. Tab 切换：点击 Tab 显示对应内容，隐藏其他
2. 表格渲染：根据当前 Tab 渲染对应数据
3. 状态切换：点击状态徽章显示下拉菜单，选择后发送消息更新文件

### 消息协议

现有消息保持不变：

- `openFile` - 打开文件
- `markPlanNeedsTesting` - 标记需要测试
- `completePlan` - 标记已完成
- `refresh` - 刷新数据

新增消息：

- `setPlanStatus` - 设置 plan 状态（替代 markPlanNeedsTesting 和 completePlan 的组合）

## 文件变更

| 文件 | 变更 |
|------|------|
| `src/webview/html.ts` | 重构 HTML 结构，添加 Tab 和表格 |
| `src/types.ts` | 无变更 |
| `src/scanner.ts` | 无变更 |
| `src/index.ts` | 添加 `setPlanStatus` 命令 |
| `src/webview/panel.ts` | 处理 `setPlanStatus` 消息 |

## 测试计划

1. Tab 切换正确显示对应内容
2. Specs 表格正确显示名称、日期、操作列
3. Plans 表格正确显示名称、日期、进度、状态、操作列
4. 状态徽章颜色正确
5. 点击状态徽章显示下拉菜单
6. 选择状态后正确更新文件
7. 点击名称或"打开"正确打开文件
8. 刷新后数据正确更新
