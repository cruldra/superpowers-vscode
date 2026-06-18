/**
 * YouTrack equivalent of `src/gitea/stateJson.ts`.
 *
 * Workflow state (column, sessionId, specFile, …) for a YouTrack-sourced issue
 * is persisted as a comment on the issue. The comment body is a marker line
 * followed by the JSON blob:
 *
 *   <!--spx-state-->
 *   {"column":"in-progress","sessionId":"..."}
 *
 * The marker makes the internal blob identifiable in the customer-facing
 * tracker (the user accepted that this state lives in comments). We scan
 * comments from the tail and pick the latest one carrying the marker, so
 * ordinary customer replies posted afterwards never shadow the real state.
 */

import type { YouTrackAuth, YouTrackComment } from './api'
import { addComment, listComments } from './api'

export const STATE_MARKER = '<!--spx-state-->'

/** Same field set as the Gitea state blob — kept independent to avoid coupling. */
const KNOWN_STATE_FIELDS = ['column', 'sessionId', 'implementSessionId', 'reviewSessionId', 'testSessionId', 'profilePath', 'testProfilePath', 'specFile', 'planFile', 'prDiffFile', 'pr', 'prMerged', 'branch', 'worktreePath', 'implementStatus', 'color', 'autoReview'] as const

/**
 * Parse a comment body into a state object, or null if it isn't a state
 * comment. Accepts either a marker-prefixed body or a bare JSON object that
 * carries a known state field (tolerant of older blobs written without the
 * marker).
 */
export function parseStateComment(body: string | undefined | null): Record<string, unknown> | null {
  let text = (body ?? '').trim()
  if (!text)
    return null
  if (text.startsWith(STATE_MARKER))
    text = text.slice(STATE_MARKER.length).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null
  const obj = parsed as Record<string, unknown>
  return KNOWN_STATE_FIELDS.some(f => f in obj) ? obj : null
}

/** Latest state blob across a comment list (tail-first), or null. */
export function findLatestState(comments: YouTrackComment[]): Record<string, unknown> | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const parsed = parseStateComment(comments[i].text)
    if (parsed)
      return parsed
  }
  return null
}

function serialize(state: Record<string, unknown>): string {
  return `${STATE_MARKER}\n${JSON.stringify(state)}`
}

/** Read the issue's latest state blob, or `{}` when none exists. */
export async function readStateComment(
  auth: YouTrackAuth,
  issueId: string,
): Promise<Record<string, unknown>> {
  const comments = await listComments(auth, issueId)
  return findLatestState(comments) ?? {}
}

/**
 * Merge `extra` into the issue's latest state blob and post a new state
 * comment. Re-reads comments first so we never merge onto a stale blob.
 */
export async function mergeStateComment(
  auth: YouTrackAuth,
  issueId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const comments = await listComments(auth, issueId)
  const current = findLatestState(comments) ?? {}
  await addComment(auth, issueId, serialize({ ...current, ...extra }))
}
