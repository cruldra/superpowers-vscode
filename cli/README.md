# spx

superpowers-vscode 工作流 CLI 工具，给 cc/codex agent 用的 Gitea 操作薄包装。

## 安装

```
make install
# 把 $HOME/.local/bin 加进 PATH
```

## 前置

需要先用 [`tea`](https://gitea.com/gitea/tea) 登录过（`~/.config/tea/config.yml` 有默认 login）。

如果 tea 用 keyring 存 token（v0.10+ 默认行为），可以另外设环境变量 `GITEA_TOKEN` 作为回退：

```
export GITEA_TOKEN=...
```

## 用法

```
spx issue create --title "新功能 X" --spec docs/specs/x.md --plan docs/plans/x.md
spx issue marker --issue 79 --type plan --value docs/plans/issue-79/plan.md
spx pr review-comment --pr 73 --body "审查意见: ..."
```

全局 flag：

- `--repo OWNER/REPO` 默认从当前 git origin 推断
- `--host URL` 默认从 tea config 默认 login 取
- `--json` JSON 输出
- `--cwd PATH` repo 探测的工作目录，默认 `.`

## Marker 约定

issue/PR body 里用 HTML 注释行携带 spx 元数据：

```
<!-- spx:spec=docs/specs/foo.md -->
<!-- spx:plan=docs/plans/foo.md -->
<!-- spx:review=1 -->
```

`spx issue marker` 会做增量更新（已存在则替换那一行，不存在则追加），其他类型的 marker 不会被动到。
