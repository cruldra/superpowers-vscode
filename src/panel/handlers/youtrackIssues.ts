/**
 * Panel handlers for YouTrack-sourced cards.
 *
 * Kept separate from the gitea `issues.ts` handlers: these route workflow-state
 * writes to the issue's YouTrack comment (see `youtrack/stateComment.ts`) and
 * resolve the issue in YouTrack when its card lands in the 完成 column — the
 * only write-back the user asked for.
 */

import type { IssueColumn } from '../../gitea/types'
import type { KanbanWebviewPanel } from '../KanbanPanel'
import type { YouTrackAuth } from '../../youtrack/api'
import { getYouTrackToken } from '../../auth/secrets'
import { logger } from '../../logging/logger'
import { getSettings } from '../../settings/store'
import { applyCommand, listProjects, resolvedStateCommand } from '../../youtrack/api'
import { youtrackHost } from '../../youtrack/issueLoader'
import { mergeStateComment } from '../../youtrack/stateComment'
import { makeNonce } from '../KanbanPanel'

function toast(panel: KanbanWebviewPanel, level: 'info' | 'success' | 'error', message: string): void {
  panel.postMessage({ type: 'toast/show', id: makeNonce(), level, message, dismissOnTimer: 6000 })
}

/** Resolve {baseUrl, token} from settings + SecretStorage, or null if YouTrack
 * isn't fully configured. */
async function resolveAuth(panel: KanbanWebviewPanel): Promise<YouTrackAuth | null> {
  const baseUrl = getSettings(panel.context).youtrackBaseUrl.trim()
  if (!baseUrl)
    return null
  const token = await getYouTrackToken(panel.context, youtrackHost(baseUrl))
  if (!token)
    return null
  return { baseUrl, token }
}

/**
 * Persist a column move for a YouTrack card, and resolve the issue in YouTrack
 * when it moves to 完成. Re-pulls the board afterwards rather than threading a
 * source-aware optimistic patch — correctness over precision for v1.
 */
export async function handleYouTrackColumnChange(panel: KanbanWebviewPanel, externalId: string, toColumn: IssueColumn): Promise<void> {
  const auth = await resolveAuth(panel)
  if (!auth) {
    toast(panel, 'error', '请先在设置里配置 YouTrack（Base URL + Token）')
    await panel.loadAndPush()
    return
  }
  try {
    await mergeStateComment(auth, externalId, { column: toColumn })
    if (toColumn === 'done')
      await closeYouTrackIssue(panel, auth, externalId)
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.add({ level: 'error', source: 'youtrack', message: `${externalId} 列变更失败`, details: message })
    toast(panel, 'error', `YouTrack 更新失败：${message}`)
  }
  await panel.loadAndPush()
}

/** Resolve the issue in YouTrack. Uses the configured close command, else
 * auto-detects the project's `isResolved` state value. */
async function closeYouTrackIssue(panel: KanbanWebviewPanel, auth: YouTrackAuth, externalId: string): Promise<void> {
  const configured = getSettings(panel.context).youtrackCloseCommand.trim()
  const command = configured || (await resolvedStateCommand(auth, externalId))
  if (!command) {
    logger.add({ level: 'warn', source: 'youtrack', message: `${externalId} 无法确定关闭命令（未配置 youtrackCloseCommand 且未找到已解决状态值）` })
    toast(panel, 'info', `${externalId} 已移到完成，但未能自动关闭 YouTrack（请在设置里填「关闭命令」）`)
    return
  }
  await applyCommand(auth, externalId, command)
}

/** Populate the settings project dropdown from the in-form base URL + token
 * (lets the user pick a project before saving). */
export async function handleListProjects(panel: KanbanWebviewPanel, baseUrl: string, token: string): Promise<void> {
  const trimmedBase = baseUrl.trim()
  const trimmedToken = token.trim()
  if (!trimmedBase || !trimmedToken) {
    panel.postMessage({ type: 'youtrack/projects', projects: [], error: '请先填写 Base URL 和 Token' })
    return
  }
  try {
    const projects = await listProjects({ baseUrl: trimmedBase, token: trimmedToken })
    panel.postMessage({ type: 'youtrack/projects', projects })
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    panel.postMessage({ type: 'youtrack/projects', projects: [], error: message })
  }
}
