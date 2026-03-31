# Superpowers-clurdra

一个用于 VS Code 的 [obra/superpowers](https://github.com/obra/superpowers) 文档浏览与执行插件，聚焦 `docs/superpowers/` 目录下的 spec 和 plan 文件。

## 功能

- 在活动栏提供 `Superpowers` 入口，打开专用面板
- 自动扫描 `docs/superpowers/specs` 和 `docs/superpowers/plans`
- 用表格展示 spec、plan、日期、进度与状态
- 支持刷新、预览打开、删除关联 spec/plan 文件
- 支持在面板里直接运行 plan
- 运行 plan 前自动创建独立 git worktree，隔离实现过程
- 支持把 plan 状态标记为进行中、需要测试、已完成

## 适用目录结构

```text
docs/
  superpowers/
    specs/
    plans/
```

插件会读取 Markdown 文件的第一个 H1 作为标题，并从文件名中提取日期。

## Plan 运行方式

运行 plan 时，插件会：

1. 根据 plan 文件名生成 `feature/...` 分支名
2. 按配置创建 git worktree
3. 用 `systemd-run --user` 在 worktree 目录后台执行 `opencode run`

默认执行命令等价于：

```bash
systemd-run --user --unit=opencode-plan-xxx --working-directory '/path/to/worktree' zsh -c 'opencode run '\''实施 docs/superpowers/plans/xxx.md'\'' --model '\''alibaba-coding-plan-cn/glm-5'\'' --agent '\''build'\''' 
```

## 配置项

插件提供这些 VS Code 配置：

- `superpowers.runMessage`: 运行 plan 时传给 `opencode run` 的消息模板，支持 `$plan_relative_path`
- `superpowers.runModel`: 运行 plan 时使用的模型
- `superpowers.runAgent`: 运行 plan 时使用的 agent
- `superpowers.worktreeDirectory`: worktree 目录模板，支持 `$project_root`、`$project_name`、`$feature_name`

默认值：

```json
{
  "superpowers.runMessage": "实施 $plan_relative_path",
  "superpowers.runModel": "alibaba-coding-plan-cn/glm-5",
  "superpowers.runAgent": "build",
  "superpowers.worktreeDirectory": "$project_root.worktrees/$feature_name"
}
```

## 开发

安装依赖：

```bash
pnpm install
```

常用命令：

```bash
pnpm build
pnpm dev
pnpm test
pnpm lint
pnpm typecheck
```

打包扩展：

```bash
pnpm ext:package
```

## 技术栈

- TypeScript
- VS Code Extension API
- reactive-vscode
- Vitest

## 许可证

MIT
