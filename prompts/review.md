/review 审查这个仓库的 PR #{prNumber}。

用 `tea pulls show {prNumber}` 看 PR 元信息，`tea pulls diff {prNumber}` 看代码差异。

## 提交审查意见

把审查意见（markdown 格式）写到 `/tmp/review-{prNumber}.md`，调 spx：

```
opencli spx pr review-comment --pr {prNumber} --body-file /tmp/review-{prNumber}.md

## 严禁

- 不要在审查意见里建议"合并 PR"或"merge"
- 不要执行 `tea pulls merge` 或任何合并命令
- 不要 push 到 main / dev 分支

合并权完全在用户手上,你的工作只是指出问题或确认通过。
