/superpowers:brainstorming 讨论下 {issueNumber} 号工单

用tea命令找工单

## 后续 marker 维护（本会话有效）

创建了 spec 或 plan 文件后追加对应 marker:

```
opencli spx issue marker --issue <工单号> --type spec --value <spec 路径>
opencli spx issue marker --issue <工单号> --type plan --value <plan 路径>
```

## 严禁擅自继续

如果你创建/更新了 spec/plan 文件并 marker 已同步，**立即停下**汇报；不要进入实施流程。

特别地：

- 不要创建分支
- 不要切换分支，包括 `git checkout` / `git switch`
- 不要修改当前主 worktree 所在分支
- 不要修改任何代码文件
- 不要创建 PR
- 不要调用 gitea 其他写操作（除上面的 marker 同步）

只讨论需求与 spec/plan，必要时用 spx issue marker 更新 marker。
