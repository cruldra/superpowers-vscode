/**
 * Non-secret extension settings persisted in `globalState`.
 *
 * Token stays in `context.secrets` (see `src/auth/secrets.ts`); everything
 * else (webhook port, prompt templates) lives here under a single JSON blob
 * keyed by `SETTINGS_KEY`.
 *
 * Empty-string values for prompts are treated as "use the default" so the
 * form can save user input verbatim and still fall back when the user clears
 * a field.
 */

import type { ExtensionContext } from 'vscode'

export const DEFAULT_BRAINSTORM_PROMPT = `请用 using-gitea-issue skill 帮我创建一个 Gitea 工单。

用户的初始想法：
{userRequest}

**重要**：创建工单时必须把以下 nonce 标记加进 body，否则插件无法把这个 cc 会话关联到新工单：

<!-- spx:nonce={nonce} -->

工作流细节（spec/plan 路径规则、CLI 用法、严禁项）参考 skill。`

export const DEFAULT_IMPLEMENT_PLAN_PROMPT
  = `请用 using-gitea-issue skill 实施工单 #{issueNumber}。

计划文件：{planFile}

注意：当前 cwd 应该已经在为这个工单专属的 git worktree 中。先 \`pwd\` 确认；如果不是 worktree 路径，停下来告诉用户，不要继续。

工作流细节（按 plan 分阶段 commit、创建 PR、严禁合并 PR、严禁 push main/dev）参考 skill。`

export const DEFAULT_REVIEW_PROMPT = `/review 先切换到当前目录，然后用 tea 拿到这个仓库的 #{prNumber} PR，再对其进行审查。

审查完毕后必须用 spx CLI 把审查意见 post 成 PR 评论（spx 会自动在 body 前面加 <!-- spx:review=1 --> 标识，**不要**自己手写这一行）：

把审查正文（markdown 格式）写到 /tmp/review-{prNumber}.md，然后执行：

\`\`\`
spx pr review-comment --pr {prNumber} --body-file /tmp/review-{prNumber}.md
\`\`\`

**注意**：审查意见里不要建议"合并 PR"或"merge"，也不要自己执行任何合并 / push 到 main 的操作。合并的决定权完全在用户手上（用户会拖工单到"完成"列触发合并）。`

export const DEFAULT_WEBHOOK_PORT = 17421

export interface Settings {
  /** Local HTTP port for receiving gitea webhook callbacks. */
  webhookPort: number
  /**
   * Prompt template for the brainstorming flow (issue creation + ongoing
   * session conventions for spec/plan body annotations). `{userRequest}`
   * and `{nonce}` placeholders.
   */
  brainstormPrompt: string
  /** Prompt template for the implement-plan flow. `{planFile}` placeholder. */
  implementPlanPrompt: string
  /** Whether to automatically run `codex exec review` when a PR opens. */
  autoReview: boolean
  /** Prompt template for the auto-review flow. `{prNumber}` placeholder. */
  reviewPrompt: string
  /** Day-to-day development branch (e.g. `main`). Jenkins doesn't watch it. */
  devBranch: string
  /**
   * Branch the Gitea webhook → Jenkins job listens on. Empty string means
   * "same as `devBranch`", in which case the branch-sync button stays
   * disabled because there's nothing to fast-forward.
   */
  autoBuildBranch: string
}

export const SETTINGS_KEY = 'superpowers.settings'

function defaults(): Settings {
  return {
    webhookPort: DEFAULT_WEBHOOK_PORT,
    brainstormPrompt: DEFAULT_BRAINSTORM_PROMPT,
    implementPlanPrompt: DEFAULT_IMPLEMENT_PLAN_PROMPT,
    autoReview: true,
    reviewPrompt: DEFAULT_REVIEW_PROMPT,
    devBranch: 'main',
    autoBuildBranch: '',
  }
}

export function getSettings(ctx: ExtensionContext): Settings {
  const stored = ctx.globalState.get<Partial<Settings>>(SETTINGS_KEY) ?? {}
  const base = defaults()

  const webhookPort = typeof stored.webhookPort === 'number' && Number.isInteger(stored.webhookPort)
    && stored.webhookPort >= 1 && stored.webhookPort <= 65535
    ? stored.webhookPort
    : base.webhookPort

  const brainstormPrompt = typeof stored.brainstormPrompt === 'string' && stored.brainstormPrompt.length > 0
    ? stored.brainstormPrompt
    : base.brainstormPrompt
  const implementPlanPrompt = typeof stored.implementPlanPrompt === 'string' && stored.implementPlanPrompt.length > 0
    ? stored.implementPlanPrompt
    : base.implementPlanPrompt
  const autoReview = typeof stored.autoReview === 'boolean' ? stored.autoReview : base.autoReview
  const reviewPrompt = typeof stored.reviewPrompt === 'string' && stored.reviewPrompt.length > 0
    ? stored.reviewPrompt
    : base.reviewPrompt
  // devBranch always has a usable value — fall back to 'main' if missing/blank
  // so we never end up trying to fetch the empty string.
  const devBranch = typeof stored.devBranch === 'string' && stored.devBranch.length > 0
    ? stored.devBranch
    : base.devBranch
  // autoBuildBranch is kept as-is — '' is meaningful ("follow devBranch, sync
  // disabled"), so we don't coerce to a default here. Anything non-string
  // (legacy installs that never wrote it) collapses to ''.
  const autoBuildBranch = typeof stored.autoBuildBranch === 'string'
    ? stored.autoBuildBranch
    : base.autoBuildBranch

  return {
    webhookPort,
    brainstormPrompt,
    implementPlanPrompt,
    autoReview,
    reviewPrompt,
    devBranch,
    autoBuildBranch,
  }
}

export async function saveSettings(ctx: ExtensionContext, next: Partial<Settings>): Promise<void> {
  const current = ctx.globalState.get<Partial<Settings>>(SETTINGS_KEY) ?? {}
  const merged: Partial<Settings> = { ...current, ...next }
  await ctx.globalState.update(SETTINGS_KEY, merged)
}
