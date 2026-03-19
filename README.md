# Superpowers

一个 VS Code 插件，用于展示和管理项目中由 superpowers 生成的 specs（设计文档）和 plans（计划文档）。

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## 功能特性

- **左侧活动栏图标**: 在 VS Code 活动栏注册一个 Superpowers 图标，点击即可打开主面板
- **双栏展示**: 主面板分两栏展示 Specs 和 Plans，按日期分组
- **进度追踪**: 自动统计 Plans 中的任务完成情况，显示 `[已完成/总数]` 进度
- **一键完成**: 右键 Plans 项目可标记为已完成
- **自动扫描**: 自动扫描工作区中 `docs/superpowers/` 目录下的文档
- **刷新功能**: 支持手动刷新文档列表

## 安装

### 从 VS Code 市场安装

即将发布...

### 手动安装

1. 克隆本仓库
2. 运行 `pnpm install` 安装依赖
3. 运行 `pnpm build` 构建插件
4. 运行 `pnpm ext:package` 打包插件
5. 在 VS Code 中，打开 Extensions 视图，点击 `...` 菜单，选择 `Install from VSIX`，选择生成的 `.vsix` 文件

## 使用方法

### 目录结构

在你的项目中创建以下目录结构：

```
docs/
└── superpowers/
    ├── specs/
    │   ├── 2026-03-19-feature-design.md
    │   └── 2026-03-20-another-design.md
    └── plans/
        ├── 2026-03-19-feature-plan.md
        └── 2026-03-20-another-plan.md
```

### 文件命名规范

- **Specs 文件**: `YYYY-MM-DD-<name>-design.md`
- **Plans 文件**: `YYYY-MM-DD-<name>.md`

### 文档格式

#### Spec 文档示例

```markdown
# 功能设计文档标题

## 概述

这是功能概述...

## 详细设计

...
```

#### Plan 文档示例

```markdown
# 功能实施计划

## 任务清单

- [x] 已完成任务 1
- [x] 已完成任务 2
- [ ] 待办任务 3
- [ ] 待办任务 4

## 备注

...
```

### 使用插件

1. 点击 VS Code 左侧活动栏的 Superpowers 图标
2. 在主面板中查看所有 Specs 和 Plans
3. 点击任意文档标题即可在编辑器中打开
4. 右键 Plans 项目可标记为已完成
5. 点击刷新按钮更新文档列表

## 快捷键

- `Superpowers: Open Superpowers Explorer` - 打开 Superpowers 面板
- `Superpowers: Refresh Superpowers Data` - 刷新文档数据

## 开发

### 环境要求

- Node.js >= 18
- pnpm >= 10.27.0
- VS Code >= 1.97.0

### 开发命令

```bash
# 安装依赖
pnpm install

# 开发模式（监听文件变化）
pnpm dev

# 构建
pnpm build

# 运行测试
pnpm test

# 代码检查
pnpm lint

# 类型检查
pnpm typecheck

# 打包插件
pnpm ext:package

# 发布插件
pnpm ext:publish
```

### 项目结构

```
src/
├── index.ts                 # 插件入口
├── treeView.ts             # 左侧 TreeView 实现
├── scanner.ts              # 文件扫描逻辑
├── planCompletion.ts       # 计划完成逻辑
├── panelOpenInteraction.ts # 面板交互逻辑
├── types.ts                # 类型定义
├── utils.ts                # 工具函数
├── config.ts               # 配置管理
└── webview/
    └── panel.ts            # Webview 面板实现
```

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

[MIT](LICENSE.md)
