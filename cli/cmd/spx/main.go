// Command spx is a small Gitea wrapper for the superpowers-vscode workflow.
//
// It targets agent (cc/codex) usage: deterministic flags, JSON output mode,
// and tea-config-based credential discovery.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/cruldra/superpowers-vscode/cli/internal/gitea"
	"github.com/cruldra/superpowers-vscode/cli/internal/marker"
	"github.com/cruldra/superpowers-vscode/cli/internal/repo"
	"github.com/cruldra/superpowers-vscode/cli/internal/state"
	"github.com/cruldra/superpowers-vscode/cli/internal/tea"
)

// runtimeContext is the bag of resolved configuration we hand to subcommands
// via cobra's context. Filled in by the root PersistentPreRunE.
type runtimeContext struct {
	Client *gitea.Client
	Owner  string
	Repo   string
	Host   string
	JSON   bool
}

type ctxKey struct{}

// global flag values (bound by Cobra).
var (
	flagRepo string
	flagHost string
	flagJSON bool
	flagCwd  string
)

// issue create flags.
var (
	icTitle     string
	icBody      string
	icBodyFile  string
	icSpec      string
	icPlan      string
	icStateJSON string
	icStateFile string
)

// issue marker flags.
var (
	imIssue int
	imType  string
	imValue string
)

// issue state get flags.
var (
	isgIssue int
)

// issue state merge flags.
var (
	ismIssue     int
	ismStateJSON string
	ismStateFile string
)

// pr review-comment flags.
var (
	prcPR       int
	prcBody     string
	prcBodyFile string
)

func main() {
	root := buildRootCmd()
	if err := root.Execute(); err != nil {
		// cobra already printed the error to stderr; ensure non-zero exit.
		os.Exit(1)
	}
}

func buildRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "spx",
		Short:         "superpowers-vscode 工作流 CLI（Gitea 薄包装）",
		Long:          "spx 为 cc/codex agent 在 superpowers-vscode 工作流里提供确定性的 Gitea 操作。\n复用 ~/.config/tea/config.yml 拿 host + token。",
		SilenceUsage:  true,
		SilenceErrors: false,
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			rc, err := resolveRuntime()
			if err != nil {
				return err
			}
			cmd.SetContext(context.WithValue(cmd.Context(), ctxKey{}, rc))
			return nil
		},
	}
	root.PersistentFlags().StringVar(&flagRepo, "repo", "", "OWNER/REPO，缺省从当前 git origin 推断")
	root.PersistentFlags().StringVar(&flagHost, "host", "", "Gitea host URL，缺省从 tea config 默认 login 取")
	root.PersistentFlags().BoolVar(&flagJSON, "json", false, "JSON 输出（默认人类可读）")
	root.PersistentFlags().StringVar(&flagCwd, "cwd", ".", "repo 探测的工作目录")

	root.AddCommand(buildIssueCmd())
	root.AddCommand(buildPRCmd())
	return root
}

func buildIssueCmd() *cobra.Command {
	issue := &cobra.Command{
		Use:   "issue",
		Short: "Gitea issue 操作",
	}

	create := &cobra.Command{
		Use:   "create",
		Short: "创建一个新工单并可选附加 spec/plan marker 与 state JSON",
		RunE: func(cmd *cobra.Command, args []string) error {
			if strings.TrimSpace(icTitle) == "" {
				return fmt.Errorf("--title 不能为空")
			}
			body, err := resolveBody(icBody, icBodyFile)
			if err != nil {
				return err
			}
			if icSpec != "" {
				body = marker.UpsertMarker(body, "spec", icSpec)
			}
			if icPlan != "" {
				body = marker.UpsertMarker(body, "plan", icPlan)
			}
			// Validate state JSON BEFORE hitting the API — better to fail
			// loudly here than leave a half-initialised issue behind.
			stateBytes, err := resolveStatePayload(icStateJSON, icStateFile)
			if err != nil {
				return err
			}
			if stateBytes != nil {
				if err := state.Validate(stateBytes); err != nil {
					return err
				}
			}
			rc := fromCtx(cmd)
			issue, err := rc.Client.CreateIssue(rc.Owner, rc.Repo, icTitle, body)
			if err != nil {
				return err
			}
			var statePayload any
			if stateBytes != nil {
				if _, postErr := rc.Client.CreateIssueComment(rc.Owner, rc.Repo, issue.Number, string(stateBytes)); postErr != nil {
					return fmt.Errorf("工单已建 (#%d)，但写入 state JSON comment 失败: %w", issue.Number, postErr)
				}
				_ = json.Unmarshal(stateBytes, &statePayload)
			}
			if rc.JSON {
				return emitJSON(map[string]any{
					"number":   issue.Number,
					"html_url": issue.HTMLURL,
					"state":    statePayload,
				})
			}
			fmt.Fprintf(cmd.OutOrStdout(), "#%d\n", issue.Number)
			return nil
		},
	}
	create.Flags().StringVar(&icTitle, "title", "", "工单标题（必填）")
	create.Flags().StringVar(&icBody, "body", "", "工单正文（与 --body-file 二选一）")
	create.Flags().StringVar(&icBodyFile, "body-file", "", "从文件读取工单正文")
	create.Flags().StringVar(&icSpec, "spec", "", "在 body 末尾追加 spx:spec marker")
	create.Flags().StringVar(&icPlan, "plan", "", "在 body 末尾追加 spx:plan marker")
	create.Flags().StringVar(&icStateJSON, "state-json", "", "state JSON 字符串（建工单后写入最后一条 comment；与 --state-file 二选一）")
	create.Flags().StringVar(&icStateFile, "state-file", "", "从文件读取 state JSON")
	_ = create.MarkFlagRequired("title")

	markerCmd := &cobra.Command{
		Use:   "marker",
		Short: "增量更新现有工单的 spec/plan marker",
		RunE: func(cmd *cobra.Command, args []string) error {
			if imIssue <= 0 {
				return fmt.Errorf("--issue 必须是正整数")
			}
			if imType != "spec" && imType != "plan" {
				return fmt.Errorf("--type 必须是 spec 或 plan，得到 %q", imType)
			}
			rc := fromCtx(cmd)
			cur, err := rc.Client.GetIssue(rc.Owner, rc.Repo, imIssue)
			if err != nil {
				return err
			}
			newBody := marker.UpsertMarker(cur.Body, imType, imValue)
			if newBody != cur.Body {
				if err := rc.Client.UpdateIssueBody(rc.Owner, rc.Repo, imIssue, newBody); err != nil {
					return err
				}
			}
			if rc.JSON {
				return emitJSON(map[string]any{
					"number": imIssue,
					"type":   imType,
					"value":  imValue,
				})
			}
			fmt.Fprintf(cmd.OutOrStdout(), "已更新 #%d 的 %s marker → %s\n", imIssue, imType, imValue)
			return nil
		},
	}
	markerCmd.Flags().IntVar(&imIssue, "issue", 0, "工单编号（必填）")
	markerCmd.Flags().StringVar(&imType, "type", "", "marker 类型：spec 或 plan（必填）")
	markerCmd.Flags().StringVar(&imValue, "value", "", "marker 值（路径，必填）")
	_ = markerCmd.MarkFlagRequired("issue")
	_ = markerCmd.MarkFlagRequired("type")
	_ = markerCmd.MarkFlagRequired("value")

	issue.AddCommand(create, markerCmd, buildIssueStateCmd())
	return issue
}

// buildIssueStateCmd assembles the `spx issue state` subtree (get + merge).
//
// The state JSON convention: the LAST comment on an issue holds a single JSON
// blob (see schemas/state-json.schema.json). `get` reads it, `merge` does a
// shallow-merge write of new keys on top of the existing blob.
func buildIssueStateCmd() *cobra.Command {
	stateCmd := &cobra.Command{
		Use:   "state",
		Short: "读取/合并工单的 state JSON（持久化在最后一条 comment）",
	}

	get := &cobra.Command{
		Use:   "get",
		Short: "读取工单最后一条 comment 里的 state JSON",
		RunE: func(cmd *cobra.Command, args []string) error {
			if isgIssue <= 0 {
				return fmt.Errorf("--issue 必须是正整数")
			}
			rc := fromCtx(cmd)
			cur, err := lastStateMap(rc.Client, rc.Owner, rc.Repo, isgIssue)
			if err != nil {
				return err
			}
			// `cur` may be an empty map; print `{}` in that case.
			out := os.Stdout
			enc := json.NewEncoder(out)
			enc.SetEscapeHTML(false)
			if rc.JSON {
				enc.SetIndent("", "  ")
			}
			return enc.Encode(cur)
		},
	}
	get.Flags().IntVar(&isgIssue, "issue", 0, "工单编号（必填）")
	_ = get.MarkFlagRequired("issue")

	merge := &cobra.Command{
		Use:   "merge",
		Short: "浅合并新 state JSON 到现有 state（最后一条 comment）",
		RunE: func(cmd *cobra.Command, args []string) error {
			if ismIssue <= 0 {
				return fmt.Errorf("--issue 必须是正整数")
			}
			incomingBytes, err := resolveStatePayload(ismStateJSON, ismStateFile)
			if err != nil {
				return err
			}
			if incomingBytes == nil {
				return fmt.Errorf("必须提供 --state-json 或 --state-file 之一")
			}
			// Validate the incoming payload BEFORE any network call so a
			// malformed input fails fast (e.g. wrong enum) without surfacing
			// confusing "issue not found" errors from Gitea first.
			if err := state.Validate(incomingBytes); err != nil {
				return err
			}
			var incoming map[string]any
			if err := json.Unmarshal(incomingBytes, &incoming); err != nil {
				return fmt.Errorf("解析 --state-json/--state-file 内容失败: %w", err)
			}
			rc := fromCtx(cmd)
			cur, err := lastStateMap(rc.Client, rc.Owner, rc.Repo, ismIssue)
			if err != nil {
				return err
			}
			// Shallow merge: new keys overwrite old. Mirrors mergeStateJsonComment.
			for k, v := range incoming {
				cur[k] = v
			}
			// Re-validate the merged blob before persisting so we never
			// poison the issue's comment trail with malformed state.
			if err := state.ValidateValue(cur); err != nil {
				return err
			}
			mergedBytes, err := json.Marshal(cur)
			if err != nil {
				return fmt.Errorf("序列化合并后的 state 失败: %w", err)
			}
			if _, err := rc.Client.CreateIssueComment(rc.Owner, rc.Repo, ismIssue, string(mergedBytes)); err != nil {
				return err
			}
			enc := json.NewEncoder(os.Stdout)
			enc.SetEscapeHTML(false)
			if rc.JSON {
				enc.SetIndent("", "  ")
			}
			return enc.Encode(cur)
		},
	}
	merge.Flags().IntVar(&ismIssue, "issue", 0, "工单编号（必填）")
	merge.Flags().StringVar(&ismStateJSON, "state-json", "", "state JSON 字符串（与 --state-file 二选一）")
	merge.Flags().StringVar(&ismStateFile, "state-file", "", "从文件读取 state JSON")
	_ = merge.MarkFlagRequired("issue")

	stateCmd.AddCommand(get, merge)
	return stateCmd
}

// lastStateMap fetches all comments on an issue, parses the LAST one as JSON
// and returns it as a map. Empty issue, empty comment, or non-JSON last
// comment all yield an empty (non-nil) map — never an error.
func lastStateMap(c *gitea.Client, owner, repo string, number int) (map[string]any, error) {
	comments, err := c.ListIssueComments(owner, repo, number)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if len(comments) == 0 {
		return out, nil
	}
	last := strings.TrimSpace(comments[len(comments)-1].Body)
	if last == "" {
		return out, nil
	}
	if err := json.Unmarshal([]byte(last), &out); err != nil {
		// Not JSON — treat as empty so callers can still merge cleanly.
		return map[string]any{}, nil
	}
	return out, nil
}

// resolveStatePayload picks the state JSON bytes from --state-json /
// --state-file. Returns (nil, nil) when neither is supplied so callers can
// branch on "no state requested". Both set is an error.
func resolveStatePayload(inline, file string) ([]byte, error) {
	if inline != "" && file != "" {
		return nil, fmt.Errorf("--state-json 和 --state-file 不能同时指定")
	}
	if inline != "" {
		return []byte(inline), nil
	}
	if file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("读取 state 文件 %s 失败: %w", file, err)
		}
		return data, nil
	}
	return nil, nil
}

func buildPRCmd() *cobra.Command {
	pr := &cobra.Command{
		Use:   "pr",
		Short: "Gitea PR 操作",
	}
	rc := &cobra.Command{
		Use:   "review-comment",
		Short: "给 PR 发一条带 review marker 的评论",
		RunE: func(cmd *cobra.Command, args []string) error {
			if prcPR <= 0 {
				return fmt.Errorf("--pr 必须是正整数")
			}
			body, err := resolveBody(prcBody, prcBodyFile)
			if err != nil {
				return err
			}
			body = marker.PrependReviewMarker(body)
			rt := fromCtx(cmd)
			cm, err := rt.Client.CreateIssueComment(rt.Owner, rt.Repo, prcPR, body)
			if err != nil {
				return err
			}
			if rt.JSON {
				return emitJSON(map[string]any{
					"id":       cm.ID,
					"html_url": cm.HTMLURL,
				})
			}
			fmt.Fprintf(cmd.OutOrStdout(), "已发评论到 PR #%d\n", prcPR)
			return nil
		},
	}
	rc.Flags().IntVar(&prcPR, "pr", 0, "PR 编号（必填）")
	rc.Flags().StringVar(&prcBody, "body", "", "评论正文（与 --body-file 二选一）")
	rc.Flags().StringVar(&prcBodyFile, "body-file", "", "从文件读取评论正文")
	_ = rc.MarkFlagRequired("pr")

	pr.AddCommand(rc)
	return pr
}

// resolveBody picks the body text from --body / --body-file. Both empty is OK
// (callers may then prepend markers); both set is an error.
func resolveBody(body, file string) (string, error) {
	if body != "" && file != "" {
		return "", fmt.Errorf("--body 和 --body-file 不能同时指定")
	}
	if file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			return "", fmt.Errorf("读取 body 文件 %s 失败: %w", file, err)
		}
		return string(data), nil
	}
	return body, nil
}

// resolveRuntime turns the global flags + tea config + git remote into a
// ready-to-use Client and owner/repo pair.
func resolveRuntime() (*runtimeContext, error) {
	host := flagHost
	var token string
	if host == "" {
		h, t, err := tea.LoadDefault()
		if err != nil {
			return nil, err
		}
		host, token = h, t
	} else {
		t, err := tea.LoadByHost(host)
		if err != nil {
			return nil, err
		}
		token = t
	}
	// Fallback: token can come from env when tea stores it in a keyring
	// (newer tea releases) rather than in config.yml.
	if token == "" {
		if env := os.Getenv("GITEA_TOKEN"); env != "" {
			token = env
		}
	}
	if token == "" {
		return nil, fmt.Errorf("没有可用的 Gitea token：tea config 里 token 字段为空，且 GITEA_TOKEN 环境变量也没设置")
	}

	owner, repoName := "", ""
	if flagRepo != "" {
		parts := strings.SplitN(flagRepo, "/", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return nil, fmt.Errorf("--repo 必须是 OWNER/REPO 形式，得到 %q", flagRepo)
		}
		owner, repoName = parts[0], parts[1]
	} else {
		o, r, err := repo.DetectOwnerRepo(flagCwd)
		if err != nil {
			return nil, fmt.Errorf("自动推断 owner/repo 失败，请用 --repo 显式指定: %w", err)
		}
		owner, repoName = o, r
	}

	return &runtimeContext{
		Client: gitea.New(host, token),
		Owner:  owner,
		Repo:   repoName,
		Host:   host,
		JSON:   flagJSON,
	}, nil
}

// fromCtx extracts the runtimeContext set up by PersistentPreRunE.
func fromCtx(cmd *cobra.Command) *runtimeContext {
	v := cmd.Context().Value(ctxKey{})
	if v == nil {
		// Should be unreachable: PersistentPreRunE always populates it.
		panic("runtimeContext missing from cobra context")
	}
	return v.(*runtimeContext)
}

// emitJSON writes v as a single-line JSON object to stdout.
func emitJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}
