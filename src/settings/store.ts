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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ExtensionContext } from 'vscode'

/**
 * Fallback prompt strings used when the on-disk markdown can't be read.
 * The full editable versions live in `prompts/*.md` at the extension root;
 * users can tweak them without rebuilding. These short fallbacks just keep
 * the extension usable if the file is missing/corrupt.
 */
const FALLBACK_BRAINSTORM_PROMPT = `/goal 我现在有这样一个需求 {userRequest}，你用 spx 命令创建 gitea 工单。工单 body 末尾必须包含 <!-- spx:nonce={nonce} -->。创建完工单立即停下汇报，不要擅自实施。`

const FALLBACK_BRAINSTORM_CONTINUE_PROMPT = `/superpowers:brainstorming 讨论下 {issueNumber} 号工单。注意：不要 git checkout / 不要写代码 / 不要建 PR，只讨论需求与 spec/plan，用 spx issue marker 更新 marker。`

const FALLBACK_IMPLEMENT_PLAN_PROMPT = `/goal 使用子代理全程绿灯实施 @{planFile}，发起 PR 时在 body 中包含 "Closes #{issueNumber}"。严禁合并 PR。`

const FALLBACK_REVIEW_PROMPT = `/review 用 tea 拿到 #{prNumber} PR 审查。审查意见用 spx pr review-comment 发评论，body 第一行写 <!-- spx:review=1 -->。`

type PromptName = 'brainstorm' | 'brainstorm-continue' | 'implement-plan' | 'review'

/**
 * Read a default prompt template from `${extensionPath}/prompts/${name}.md`.
 *
 * This is called every time `getSettings` runs, so edits to the markdown
 * file take effect on the next cc/codex tab launch without reloading the
 * window. If the file is missing or unreadable we fall back to a short
 * inline string so the extension stays functional.
 */
export function readDefaultPrompt(extensionPath: string, name: PromptName): string {
  const filePath = path.join(extensionPath, 'prompts', `${name}.md`)
  try {
    return readFileSync(filePath, 'utf-8')
  }
  catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[spx] 读 ${filePath} 失败，使用内联 fallback:`, err)
    switch (name) {
      case 'brainstorm': return FALLBACK_BRAINSTORM_PROMPT
      case 'brainstorm-continue': return FALLBACK_BRAINSTORM_CONTINUE_PROMPT
      case 'implement-plan': return FALLBACK_IMPLEMENT_PLAN_PROMPT
      case 'review': return FALLBACK_REVIEW_PROMPT
    }
  }
}

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
  /**
   * Prompt template for continuing brainstorm on an already-existing issue
   * (when the user later wants to discuss / write spec/plan in the panel).
   * `{issueNumber}` placeholder.
   */
  brainstormContinuePrompt: string
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
  /**
   * Path to a user-provided shell script that runs *after* the extension
   * creates a worktree via `git worktree add`. Empty string means use the
   * default `<workspaceRoot>/.spx/worktree-post-create.sh`. Absent file
   * (default path or user-specified) is treated as a no-op, not an error.
   *
   * Hook receives env: `WORKTREE_PATH`, `WORKSPACE_ROOT`, `BRANCH`,
   * `ISSUE_NUMBER`, `MAIN_BRANCH`.
   */
  worktreePostCreateScript: string
  /**
   * Path to a user-provided shell script that runs *before* the extension
   * removes a worktree via `git worktree remove`. Empty string means use
   * the default `<workspaceRoot>/.spx/worktree-pre-remove.sh`. Absent file
   * is treated as a no-op.
   *
   * Same env vars as the post-create hook.
   */
  worktreePreRemoveScript: string
}

export const SETTINGS_KEY = 'superpowers.settings'

function defaults(ctx: ExtensionContext): Settings {
  return {
    webhookPort: DEFAULT_WEBHOOK_PORT,
    brainstormPrompt: readDefaultPrompt(ctx.extensionPath, 'brainstorm'),
    brainstormContinuePrompt: readDefaultPrompt(ctx.extensionPath, 'brainstorm-continue'),
    implementPlanPrompt: readDefaultPrompt(ctx.extensionPath, 'implement-plan'),
    autoReview: true,
    reviewPrompt: readDefaultPrompt(ctx.extensionPath, 'review'),
    devBranch: 'main',
    autoBuildBranch: '',
    worktreePostCreateScript: '',
    worktreePreRemoveScript: '',
  }
}

export function getSettings(ctx: ExtensionContext): Settings {
  const stored = ctx.globalState.get<Partial<Settings>>(SETTINGS_KEY) ?? {}
  const base = defaults(ctx)

  const webhookPort = typeof stored.webhookPort === 'number' && Number.isInteger(stored.webhookPort)
    && stored.webhookPort >= 1 && stored.webhookPort <= 65535
    ? stored.webhookPort
    : base.webhookPort

  const brainstormPrompt = typeof stored.brainstormPrompt === 'string' && stored.brainstormPrompt.length > 0
    ? stored.brainstormPrompt
    : base.brainstormPrompt
  const brainstormContinuePrompt = typeof stored.brainstormContinuePrompt === 'string' && stored.brainstormContinuePrompt.length > 0
    ? stored.brainstormContinuePrompt
    : base.brainstormContinuePrompt
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
  // worktree hook script paths: '' is meaningful (= "use default
  // .spx/worktree-*.sh"), so don't coerce. Non-string legacy values fall
  // back to ''. The hook runner resolves '' to the default at execution
  // time and silently skips when the file doesn't exist.
  const worktreePostCreateScript = typeof stored.worktreePostCreateScript === 'string'
    ? stored.worktreePostCreateScript
    : base.worktreePostCreateScript
  const worktreePreRemoveScript = typeof stored.worktreePreRemoveScript === 'string'
    ? stored.worktreePreRemoveScript
    : base.worktreePreRemoveScript

  return {
    webhookPort,
    brainstormPrompt,
    brainstormContinuePrompt,
    implementPlanPrompt,
    autoReview,
    reviewPrompt,
    devBranch,
    autoBuildBranch,
    worktreePostCreateScript,
    worktreePreRemoveScript,
  }
}

export async function saveSettings(ctx: ExtensionContext, next: Partial<Settings>): Promise<void> {
  const current = ctx.globalState.get<Partial<Settings>>(SETTINGS_KEY) ?? {}
  const merged: Partial<Settings> = { ...current, ...next }
  await ctx.globalState.update(SETTINGS_KEY, merged)
}
