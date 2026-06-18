/**
 * Loads YouTrack-sourced issues into the panel's `Issue` shape — the YouTrack
 * counterpart of `src/gitea/issueLoader.ts`.
 *
 * Returns `[]` (not an error) when YouTrack isn't configured, so the panel can
 * always call this alongside the Gitea loader and just merge the results.
 */

import type { ExtensionContext } from 'vscode'
import type { Issue, IssueColumn } from '../gitea/types'
import { getYouTrackToken } from '../auth/secrets'
import { getSettings } from '../settings/store'
import type { YouTrackIssue } from './api'
import { issueHtmlUrl, listIssues } from './api'
import { findLatestState } from './stateComment'

const VALID_COLUMNS = new Set<IssueColumn>(['todo', 'in-progress', 'review', 'done'])

/** Host part of the configured base URL — the SecretStorage token key. */
export function youtrackHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  }
  catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Offset added to a YouTrack issue's numeric id so its board `number` never
 * collides with a gitea issue number (which is the routing key for
 * webview↔extension messages and the `number → IssueRef` map).
 * ponytail: assumes gitea numbers < 1,000,000 and a single mirrored project
 * (readable ids are unique within one project). Widen / hash if either breaks.
 */
const YOUTRACK_NUMBER_OFFSET = 1_000_000

/** `LXF-12` → `1_000_012`; falls back to the offset when there's no numeric tail. */
function syntheticNumber(idReadable: string): number {
  const m = idReadable.match(/-(\d+)$/)
  return YOUTRACK_NUMBER_OFFSET + (m ? Number(m[1]) : 0)
}

function pickColumn(rawColumn: unknown, resolved: number | null): IssueColumn {
  if (typeof rawColumn === 'string' && VALID_COLUMNS.has(rawColumn as IssueColumn))
    return rawColumn as IssueColumn
  return resolved != null ? 'done' : 'todo'
}

function toIssue(baseUrl: string, it: YouTrackIssue): Issue {
  const state = findLatestState(it.comments) ?? {}
  return {
    id: `youtrack:${it.idReadable}`,
    externalId: it.idReadable,
    source: 'youtrack',
    number: syntheticNumber(it.idReadable),
    title: it.summary,
    column: pickColumn(state.column, it.resolved),
    htmlUrl: issueHtmlUrl(baseUrl, it.idReadable),
    attachments: it.attachments,
    sessionId: str(state.sessionId),
    implementSessionId: str(state.implementSessionId),
    reviewSessionId: str(state.reviewSessionId),
    testSessionId: str(state.testSessionId),
    profilePath: str(state.profilePath),
    testProfilePath: str(state.testProfilePath),
    specFile: str(state.specFile),
    planFile: str(state.planFile),
    prDiffFile: str(state.prDiffFile),
    pr: str(state.pr),
    branch: str(state.branch),
    worktreePath: str(state.worktreePath),
    color: str(state.color),
    implementStatus: state.implementStatus === 'running' || state.implementStatus === 'done' || state.implementStatus === 'failed'
      ? state.implementStatus
      : undefined,
    autoReview: typeof state.autoReview === 'boolean' ? state.autoReview : undefined,
  }
}

export async function loadYouTrackIssues(ctx: ExtensionContext): Promise<Issue[]> {
  const settings = getSettings(ctx)
  const baseUrl = settings.youtrackBaseUrl.trim()
  const project = settings.youtrackProjectShortName.trim()
  if (!baseUrl || !project)
    return []
  const token = await getYouTrackToken(ctx, youtrackHost(baseUrl))
  if (!token)
    return []
  const raw = await listIssues({ baseUrl, token }, project)
  return raw.map(it => toIssue(baseUrl, it))
}
