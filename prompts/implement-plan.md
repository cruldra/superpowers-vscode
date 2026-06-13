/goal 使用子代理全程绿灯实施 @{planFile}，发起 PR 时务必在 PR body 中包含 "Closes #{issueNumber}"。

**严禁合并 PR**：你的职责只到发起 PR 为止，后续审查反馈到了请继续修复并 push，永远不要执行 `tea pulls merge` 或任何合并操作。

## 数据库迁移（alembic）

多个 feature worktree 共用同一台 dev DB（`192.168.1.4:5433`）。任何 worktree 直接在共享库上跑迁移，都会让别的分支 `alembic upgrade` 崩（DB 里记着的 revision 在对方代码里不存在）。所以本会话：

- 只用 `uv run alembic revision --autogenerate -m "..."` 生成迁移文件，**绝不手写 revision 文件**。
- 生成后立即 `git add` 提交迁移文件，纳入 PR。
- **绝不**对共享 dev DB（`192.168.1.4:5433`）或 prod 执行 `alembic upgrade` / `downgrade` 等任何改库命令。
- 需要运行时验证迁移，就起一个一次性独立库（本地 docker postgres 或唯一命名的 scratch 库），在它上面 upgrade，验证完即丢弃，不要留痕。
- 共享 dev DB 与 prod 的迁移合并后由用户统一执行，时机由用户决定。