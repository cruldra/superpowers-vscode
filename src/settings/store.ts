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

export const DEFAULT_BRAINSTORM_PROMPT = `/goal 我现在有这样一个需求 {userRequest}，你用 tea 命令创建 gitea 工单，工单 body 末尾必须严格包含这一行：<!-- spx:nonce={nonce} -->
具体需求细节稍后再讨论。

**重要持续约定（本会话有效）**：今后每当你创建或修改：
- spec 文件（路径形如 docs/superpowers/specs/*.md）→ 立即用 tea 命令把工单 body 末尾的 <!-- spx:spec=路径 --> 注释更新成最新路径（没有就追加，已有就替换那一行）
- plan 文件（路径形如 docs/superpowers/plans/*.md）→ 同样规则更新 <!-- spx:plan=路径 -->

修改 body 时必须保留所有 <!-- spx:* --> 注释（包括 nonce）；只增加或替换自己负责的那一行。`

export const DEFAULT_IMPLEMENT_PLAN_PROMPT
  = '/goal 使用子代理全程绿灯实施 @{planFile}，发起 PR 时务必在 PR body 中包含 "Closes #{issueNumber}"'

export const DEFAULT_REVIEW_PROMPT = '先切换到当前目录，然后用 tea 拿到这个仓库的 #{prNumber} PR，再对其进行审查'

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
}

export const SETTINGS_KEY = 'superpowers.settings'

function defaults(): Settings {
  return {
    webhookPort: DEFAULT_WEBHOOK_PORT,
    brainstormPrompt: DEFAULT_BRAINSTORM_PROMPT,
    implementPlanPrompt: DEFAULT_IMPLEMENT_PLAN_PROMPT,
    autoReview: true,
    reviewPrompt: DEFAULT_REVIEW_PROMPT,
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

  return {
    webhookPort,
    brainstormPrompt,
    implementPlanPrompt,
    autoReview,
    reviewPrompt,
  }
}

export async function saveSettings(ctx: ExtensionContext, next: Partial<Settings>): Promise<void> {
  const current = ctx.globalState.get<Partial<Settings>>(SETTINGS_KEY) ?? {}
  const merged: Partial<Settings> = { ...current, ...next }
  await ctx.globalState.update(SETTINGS_KEY, merged)
}
