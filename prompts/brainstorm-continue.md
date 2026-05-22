/superpowers:brainstorming 讨论下 {issueNumber} 号工单

## 后续 marker 维护（本会话有效）

**只有**当你真正创建了 spec 或 plan 文件后才追加对应 marker。路径形如 `docs/superpowers/specs/<slug>/spec.md` 或 `docs/superpowers/plans/<slug>/plan.md`：

```
opencli spx issue marker --issue <工单号> --type spec --value <spec 路径>
opencli spx issue marker --issue <工单号> --type plan --value <plan 路径>
```

spx 自动找到对应行替换或追加，保留所有其他 marker。**不要自己手写 `<!-- spx:* -->` 行**。

## 严禁擅自继续

如果你创建/更新了 spec/plan 文件并 marker 已同步，**立即停下**汇报；不要进入实施流程。

特别地：

- 不要 `git checkout` 任何分支
- 不要修改任何代码文件
- 不要创建 PR
- 不要调用 gitea 其他写操作（除上面的 marker 同步）

只讨论需求与 spec/plan，必要时用 spx issue marker 更新 marker。
