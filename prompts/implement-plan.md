/goal 使用子代理全程绿灯实施 @{planFile}，发起 PR 时务必在 PR body 中包含 "Closes #{issueNumber}"。

**严禁合并 PR**：你的职责只到发起 PR 为止，后续审查反馈到了请继续修复并 push，永远不要执行 `tea pulls merge` 或任何合并操作。合并由用户在看板上拖工单到"完成"列时由插件代为执行。

如需操作 Gitea 工单或 PR（创建工单 / 更新 spec/plan marker / 发 PR 评论），请用 spx CLI（参考 using-spx-cli skill）。
