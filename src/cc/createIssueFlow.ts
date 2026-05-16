/**
 * Orchestrates a "new issue via Claude" run. Drives the spawnClaude wrapper,
 * extracts the issue number from the model's result text, and writes the
 * stateful JSON comment back to Gitea so future kanban refreshes know the
 * column + sessionId.
 *
 * Caller passes an `onProgress` channel so the panel can drive toasts.
 */

import { randomUUID } from 'node:crypto'
import type { ExtensionContext } from 'vscode'
import { GiteaApiError, postIssueComment } from '../gitea/api'
import type { ClaudeImage } from './spawnClaude'
import { ClaudeError, ClaudeTimeoutError, spawnClaude } from './spawnClaude'

export type ProgressEvent =
  | { kind: 'started', toastId: string }
  | { kind: 'success', toastId: string, issueNumber: number, issueUrl: string }
  | { kind: 'failed', toastId: string, message: string }

function buildPrompt(userRequest: string): string {
  return `/goal 我现在有这样一个需求 ${userRequest}, 你用tea命令先帮我建好gitea工单, 具体细节等下再讨论, 以 <gitea_issue_no>编号</gitea_issue_no> 形式输出创建好的工单编号`
}

function extractIssueNumber(resultText: string): number | null {
  const m = resultText.match(/<gitea_issue_no>(\d+)<\/gitea_issue_no>/)
  if (!m)
    return null
  const n = Number.parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

export async function createIssueViaClaude(opts: {
  ctx: ExtensionContext
  workspaceRoot: string
  host: string
  owner: string
  repo: string
  token: string
  userRequest: string
  images?: ClaudeImage[]
  onProgress: (event: ProgressEvent) => void
}): Promise<void> {
  const toastId = randomUUID()
  opts.onProgress({ kind: 'started', toastId })

  const prompt = buildPrompt(opts.userRequest)

  let sessionId: string
  let resultText: string
  let rawJson: string
  try {
    const out = await spawnClaude({
      prompt,
      cwd: opts.workspaceRoot,
      images: opts.images,
    })
    sessionId = out.sessionId
    resultText = out.resultText
    rawJson = out.rawJson
  }
  catch (err) {
    let message: string
    if (err instanceof ClaudeTimeoutError) {
      message = `创建失败：${err.message}`
    }
    else if (err instanceof ClaudeError) {
      message = `创建失败：${err.message}`
      // eslint-disable-next-line no-console
      console.error('[superpowers/createIssue] claude error', err.message, '\nstderr:', err.stderr)
    }
    else {
      message = `创建失败：${err instanceof Error ? err.message : String(err)}`
    }
    opts.onProgress({ kind: 'failed', toastId, message })
    return
  }

  const issueNumber = extractIssueNumber(resultText)
  if (issueNumber == null) {
    // eslint-disable-next-line no-console
    console.error(
      '[superpowers/createIssue] no issue number in claude output. result:\n',
      resultText,
      '\nrawJson:\n',
      rawJson,
    )
    opts.onProgress({
      kind: 'failed',
      toastId,
      message: '创建失败：未在 Claude 输出中找到工单编号',
    })
    return
  }

  try {
    await postIssueComment({
      host: opts.host,
      token: opts.token,
      owner: opts.owner,
      repo: opts.repo,
      index: issueNumber,
      body: JSON.stringify({ column: 'todo', sessionId }),
    })
  }
  catch (err) {
    const base = err instanceof GiteaApiError
      ? `${err.status} ${err.message}`
      : err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.error(`[superpowers/createIssue] failed to post state comment for #${issueNumber}:`, base)
    opts.onProgress({
      kind: 'failed',
      toastId,
      message: `#${issueNumber} 已建但状态标记失败：${base}（下次刷新会自动补齐）`,
    })
    return
  }

  const issueUrl = `https://${opts.host}/${opts.owner}/${opts.repo}/issues/${issueNumber}`
  opts.onProgress({ kind: 'success', toastId, issueNumber, issueUrl })
}
