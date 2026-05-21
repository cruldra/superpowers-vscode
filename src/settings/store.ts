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

export const DEFAULT_BRAINSTORM_PROMPT = `/goal 我现在有这样一个需求 {userRequest}，你用 tea 命令创建 gitea 工单。

**工单格式**：先检查当前仓库 \`.gitea/ISSUE_TEMPLATE/\` 目录是否有模板文件（\`.md\` 或 \`.yaml\`）；有就**严格遵循模板的结构**（标题前缀、章节标题、必填字段）来填写 body，模板里要求填的部分都填上、不要留空；没有模板就用普通 markdown 自由写。

工单 body 末尾必须严格包含这一行：<!-- spx:nonce={nonce} -->
具体需求细节稍后再讨论。

**重要持续约定（本会话有效）**：今后每当你创建或修改：
- spec 文件（路径形如 docs/superpowers/specs/*.md）→ 立即用 tea 命令把工单 body 末尾的 <!-- spx:spec=路径 --> 注释更新成最新路径（没有就追加，已有就替换那一行）
- plan 文件（路径形如 docs/superpowers/plans/*.md）→ 同样规则更新 <!-- spx:plan=路径 -->

**严禁**预先在 body 里写 <!-- spx:spec=占位 --> 或 <!-- spx:plan=占位 -->（包括 \`...\` 之类占位符）。只有当真实文件（路径包含 \`/\` 且以 \`.md\` 结尾）已经存在/被你创建时才追加对应的 marker 行，否则就不要写这两行。

修改 body 时必须保留所有 <!-- spx:* --> 注释（包括 nonce）；只增加或替换自己负责的那一行。

如需操作 Gitea 工单或 PR（创建工单 / 更新 spec/plan marker / 发 PR 评论），请用 spx CLI（参考 using-spx-cli skill）。`

export const DEFAULT_IMPLEMENT_PLAN_PROMPT
  = `/goal 使用子代理全程绿灯实施 @{planFile}，发起 PR 时务必在 PR body 中包含 "Closes #{issueNumber}"。

**严禁合并 PR**：你的职责只到发起 PR 为止，后续审查反馈到了请继续修复并 push，永远不要执行 \`tea pulls merge\` 或任何合并操作。合并由用户在看板上拖工单到"完成"列时由插件代为执行。

如需操作 Gitea 工单或 PR（创建工单 / 更新 spec/plan marker / 发 PR 评论），请用 spx CLI（参考 using-spx-cli skill）。`

export const DEFAULT_REVIEW_PROMPT = `/review 先切换到当前目录，然后用 tea 拿到这个仓库的 #{prNumber} PR，再对其进行审查

审查完毕后必须用 tea 命令把审查意见 post 成 PR 评论（不是 reply，是 issue comment）。评论 body 严格使用以下格式：

<!-- spx:review=1 -->
<审查意见正文，markdown 格式>

第一行的 \`<!-- spx:review=1 -->\` 标识不能省略也不能改，否则后续流程识别不到这条评论。

**注意**：审查意见里不要建议"合并 PR"或"merge"，也不要执行 \`tea pulls merge\`。合并的决定权完全在用户手上（用户会拖工单到"完成"列触发合并），你只需指出问题或确认通过即可。

如需操作 Gitea 工单或 PR（创建工单 / 更新 spec/plan marker / 发 PR 评论），请用 spx CLI（参考 using-spx-cli skill）。`

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
