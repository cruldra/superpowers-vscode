/**
 * Shared helper for merging extra fields into an issue's "state JSON" comment.
 *
 * Convention: the last comment on a gitea issue is treated as a JSON blob
 * holding orchestration state (column, branch, pr, implementStatus, etc.).
 * This helper reads that blob, merges `extra` on top, and posts a new comment
 * with the resulting JSON body. If the last comment isn't valid JSON it
 * starts fresh from `{}`.
 */

import { listIssueComments, postIssueComment } from './api'

export interface MergeStateJsonCommentOpts {
  host: string
  owner: string
  repo: string
  token: string
  issueNumber: number
  extra: Record<string, unknown>
}

/**
 * Merge `extra` into the latest state-JSON comment of the issue and post a
 * new comment with the merged JSON. Throws on network/API failure — callers
 * are responsible for surfacing errors.
 */
export async function mergeStateJsonComment(opts: MergeStateJsonCommentOpts): Promise<void> {
  const comments = await listIssueComments({
    host: opts.host,
    token: opts.token,
    owner: opts.owner,
    repo: opts.repo,
    index: opts.issueNumber,
  })
  let currentState: Record<string, unknown> = {}
  if (comments.length > 0) {
    const lastBody = (comments[comments.length - 1].body ?? '').trim()
    if (lastBody) {
      try {
        const parsed = JSON.parse(lastBody) as unknown
        if (parsed && typeof parsed === 'object')
          currentState = parsed as Record<string, unknown>
      }
      catch {
        // Last comment wasn't JSON; start fresh.
      }
    }
  }
  const merged: Record<string, unknown> = {
    ...currentState,
    ...opts.extra,
  }
  await postIssueComment({
    host: opts.host,
    token: opts.token,
    owner: opts.owner,
    repo: opts.repo,
    index: opts.issueNumber,
    body: JSON.stringify(merged),
  })
}

export interface ReadStateJsonCommentOpts {
  host: string
  owner: string
  repo: string
  token: string
  issueNumber: number
}

/**
 * Read the latest state-JSON comment of the issue and return it as a parsed
 * object. Returns an empty object if there are no comments, the last comment
 * is empty, or it doesn't parse as JSON. Throws on network/API failure.
 */
export async function readStateJsonComment(
  opts: ReadStateJsonCommentOpts,
): Promise<Record<string, unknown>> {
  const comments = await listIssueComments({
    host: opts.host,
    token: opts.token,
    owner: opts.owner,
    repo: opts.repo,
    index: opts.issueNumber,
  })
  if (comments.length === 0)
    return {}
  const lastBody = (comments[comments.length - 1].body ?? '').trim()
  if (!lastBody)
    return {}
  try {
    const parsed = JSON.parse(lastBody) as unknown
    if (parsed && typeof parsed === 'object')
      return parsed as Record<string, unknown>
  }
  catch {
    // Last comment wasn't JSON; treat as empty state.
  }
  return {}
}
