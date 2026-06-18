/**
 * Source-aware workflow-state persistence.
 *
 * Gitea and YouTrack cards share the same board and the same session/worktree
 * machinery, but their workflow state (column, sessionId, worktreePath, …)
 * lives in different places: a gitea issue comment vs a YouTrack issue comment.
 * Handlers call these helpers with an `IssueRef` instead of hard-coding the
 * gitea backend, so the same handler body serves both sources.
 *
 * The gitea branch reproduces exactly what the handlers did inline before, so
 * gitea behavior is unchanged.
 */

import type { ExtensionContext } from 'vscode'
import { workspace } from 'vscode'
import { getToken, getYouTrackToken } from '../auth/secrets'
import { detectRepo } from '../git/remote'
import { closeIssue as giteaCloseIssue } from '../gitea/api'
import { mergeStateJsonComment, readStateJsonComment } from '../gitea/stateJson'
import { getSettings } from '../settings/store'
import { applyCommand, resolvedStateCommand } from '../youtrack/api'
import { youtrackHost } from '../youtrack/issueLoader'
import { mergeStateComment, readStateComment } from '../youtrack/stateComment'

export interface IssueRef {
  /** Absent = gitea (back-compat). */
  source?: 'gitea' | 'youtrack'
  /** The board's (possibly synthetic) issue number — the routing key. */
  number: number
  /** YouTrack readable id (`LXF-12`); required when source is youtrack. */
  externalId?: string
}

function isYouTrack(ref: IssueRef): ref is IssueRef & { externalId: string } {
  return ref.source === 'youtrack' && typeof ref.externalId === 'string' && ref.externalId.length > 0
}

async function giteaDeps(ctx: ExtensionContext): Promise<{ host: string, owner: string, repo: string, token: string }> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot)
    throw new Error('未打开工作区文件夹')
  const remote = await detectRepo(workspaceRoot)
  if (!remote)
    throw new Error('当前工作区没有 Gitea 远程仓库')
  const token = await getToken(ctx, remote.host)
  if (!token)
    throw new Error('请先完成 Gitea 配置')
  return { host: remote.host, owner: remote.owner, repo: remote.repo, token }
}

async function youtrackAuth(ctx: ExtensionContext): Promise<{ baseUrl: string, token: string }> {
  const baseUrl = getSettings(ctx).youtrackBaseUrl.trim()
  if (!baseUrl)
    throw new Error('未配置 YouTrack Base URL')
  const token = await getYouTrackToken(ctx, youtrackHost(baseUrl))
  if (!token)
    throw new Error('未配置 YouTrack Token')
  return { baseUrl, token }
}

/** Read the workflow-state blob for an issue from its tracker. */
export async function readIssueState(ctx: ExtensionContext, ref: IssueRef): Promise<Record<string, unknown>> {
  if (isYouTrack(ref)) {
    const auth = await youtrackAuth(ctx)
    return readStateComment(auth, ref.externalId)
  }
  const d = await giteaDeps(ctx)
  return readStateJsonComment({ ...d, issueNumber: ref.number })
}

/** Merge `extra` into the issue's workflow-state blob in its tracker. */
export async function mergeIssueState(ctx: ExtensionContext, ref: IssueRef, extra: Record<string, unknown>): Promise<void> {
  if (isYouTrack(ref)) {
    const auth = await youtrackAuth(ctx)
    await mergeStateComment(auth, ref.externalId, extra)
    return
  }
  const d = await giteaDeps(ctx)
  await mergeStateJsonComment({ ...d, issueNumber: ref.number, extra })
}

/**
 * Resolve/close an issue in its tracker. Gitea: PATCH state=closed. YouTrack:
 * apply the configured close command, else auto-detect the project's first
 * `isResolved` state value. Returns false (with no throw) when a YouTrack close
 * command can't be determined, so callers can surface a hint.
 */
export async function closeIssueByRef(ctx: ExtensionContext, ref: IssueRef): Promise<boolean> {
  if (isYouTrack(ref)) {
    const auth = await youtrackAuth(ctx)
    const configured = getSettings(ctx).youtrackCloseCommand.trim()
    const command = configured || (await resolvedStateCommand(auth, ref.externalId))
    if (!command)
      return false
    await applyCommand(auth, ref.externalId, command)
    return true
  }
  const d = await giteaDeps(ctx)
  await giteaCloseIssue({ ...d, issueNumber: ref.number })
  return true
}
