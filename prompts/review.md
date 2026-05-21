/review 先切换到当前目录，然后用 tea 拿到这个仓库的 #{prNumber} PR，再对其进行审查

审查完毕后必须用 tea 命令把审查意见 post 成 PR 评论（不是 reply，是 issue comment）。评论 body 严格使用以下格式：

<!-- spx:review=1 -->
<审查意见正文，markdown 格式>

第一行的 `<!-- spx:review=1 -->` 标识不能省略也不能改，否则后续流程识别不到这条评论。

**注意**：审查意见里不要建议"合并 PR"或"merge"，也不要执行 `tea pulls merge`。合并的决定权完全在用户手上（用户会拖工单到"完成"列触发合并），你只需指出问题或确认通过即可。

如需操作 Gitea 工单或 PR（创建工单 / 更新 spec/plan marker / 发 PR 评论），请用 spx CLI（参考 using-spx-cli skill）。
