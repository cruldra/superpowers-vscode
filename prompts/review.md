/review 审查这个仓库的 PR #{prNumber}。

用 `tea pulls {prNumber}` 看 PR 元信息（标题/描述/分支）。看代码差异用 git（当前目录就是 PR 分支的 worktree）：先 `git fetch origin main`，再 `git diff origin/main...HEAD`（概览可加 --stat）。注意 tea 没有 `diff` 子命令，不要尝试 `tea pulls diff`。

## 提交审查意见

把审查意见（markdown 格式）写到 `/tmp/review-{prNumber}.md`，调 spx：

```
opencli spx pr review-comment --pr {prNumber} --body-file /tmp/review-{prNumber}.md

## 严禁

- 不要在审查意见里建议"合并 PR"或"merge"
- 不要执行 `tea pulls merge` 或任何合并命令
- 不要 push 到 main / dev 分支

合并权完全在用户手上,你的工作只是指出问题或确认通过。
