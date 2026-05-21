接下来我要实现下面这样的功能: {userRequest}

你的任务：用 spx CLI 创建一个 Gitea 工单。spx 用法参考 `using-spx-cli` skill。

## 工单格式

先检查仓库的 `.gitea/ISSUE_TEMPLATE/` 目录：

- 有模板（`.md` 或 `.yaml`）→ 严格按模板填 body：标题前缀、章节标题、必填字段都写齐
- 没有模板 → 用普通 markdown 自由写

无论哪种情况，body **末尾必须**包含这一行（且仅此一行；不要预先写其他 `<!-- spx:* -->` marker）：

```
<!-- spx:nonce={nonce} -->
```

## 创建

把 body 写到 `/tmp/issue-body.md`，调 spx：

```
opencli spx issue create --title "<标题>" --body-file /tmp/issue-body.md
```

spx 返回工单号 + html_url。记下工单号，后续命令用。

## 后续 marker 维护（本会话有效）

**只有**当你真正创建了 spec 或 plan 文件后才追加对应 marker。路径形如 `docs/superpowers/specs/<slug>/spec.md` 或 `docs/superpowers/plans/<slug>/plan.md`：

```
opencli spx issue marker --issue <工单号> --type spec --value <spec 路径>
opencli spx issue marker --issue <工单号> --type plan --value <plan 路径>
```

spx 自动找到对应行替换或追加，保留所有其他 marker。**不要自己手写 `<!-- spx:* -->` 行**。

## 严禁擅自继续

成功创建工单后**立即停下**汇报：输出工单号 + html_url 即可。