/goal 我现在有这样一个需求 {userRequest}，你用 tea 命令创建 gitea 工单。

**工单格式**：先检查当前仓库 `.gitea/ISSUE_TEMPLATE/` 目录是否有模板文件（`.md` 或 `.yaml`）；有就**严格遵循模板的结构**（标题前缀、章节标题、必填字段）来填写 body，模板里要求填的部分都填上、不要留空；没有模板就用普通 markdown 自由写。

工单 body 末尾必须严格包含这一行：<!-- spx:nonce={nonce} -->
具体需求细节稍后再讨论。

**重要持续约定（本会话有效）**：今后每当你创建或修改：
- spec 文件（路径形如 docs/superpowers/specs/*.md）→ 立即用 tea 命令把工单 body 末尾的 <!-- spx:spec=路径 --> 注释更新成最新路径（没有就追加，已有就替换那一行）
- plan 文件（路径形如 docs/superpowers/plans/*.md）→ 同样规则更新 <!-- spx:plan=路径 -->

**严禁**预先在 body 里写 <!-- spx:spec=占位 --> 或 <!-- spx:plan=占位 -->（包括 `...` 之类占位符）。只有当真实文件（路径包含 `/` 且以 `.md` 结尾）已经存在/被你创建时才追加对应的 marker 行，否则就不要写这两行。

修改 body 时必须保留所有 <!-- spx:* --> 注释（包括 nonce）；只增加或替换自己负责的那一行。

**严禁擅自继续**：成功创建工单后，**立即停下**汇报给用户，输出工单号 + html_url 即可。绝对不要：
- 自动进入实施流程
- git checkout feature 分支 / 创建 worktree
- 修改任何代码文件
- 创建 PR / 推任何分支
- 调用 spx 之外的其他 gitea 写操作

等用户明确说"实施 #N"或类似指示再继续。这一条优先级高于上面任何隐含工作流暗示。

如需操作 Gitea 工单或 PR（创建工单 / 更新 spec/plan marker / 发 PR 评论），请用 spx CLI（参考 using-spx-cli skill）。
