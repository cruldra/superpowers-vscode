/**
 * Shared helper for merging extra fields into an issue's "state JSON" comment.
 *
 * Convention: the most recent state-JSON comment on a gitea issue holds a
 * JSON blob with orchestration state (column, branch, pr, implementStatus,
 * etc.). We locate it by scanning comments from the tail and picking the first
 * one that parses as an object carrying a known state field — so an ordinary
 * text/JSON comment posted afterwards (cc chatter, review notes, Gitea's PR
 * auto-link) can't shadow it. This helper reads that blob, merges `extra` on
 * top, and posts a new comment with the resulting JSON body. With no prior
 * state comment it starts fresh from `{}`.
 */

import type { GiteaComment } from './api'
import { listIssueComments, postIssueComment } from './api'

/**
 * 已知 state 字段集合，用于把 state JSON comment 与普通 JSON 内容评论区分开。
 * 普通文本评论、审查评论、Gitea 自动关联评论都不含这些字段，因此从尾往前
 * 扫描时会被跳过，避免它们插队后下一次 merge 从空状态开始丢历史。
 */
const KNOWN_STATE_FIELDS = ['column', 'sessionId', 'implementSessionId', 'reviewSessionId', 'testSessionId', 'profilePath', 'testProfilePath', 'specFile', 'planFile', 'prDiffFile', 'pr', 'prMerged', 'branch', 'worktreePath', 'implementStatus', 'color', 'autoReview'] as const

/**
 * body 能 parse 成 object 且含至少一个已知 state 字段 → 认为是 state JSON。
 * 返回解析后的对象，否则返回 null。
 */
function parseStateComment(body: string | undefined | null): Record<string, unknown> | null {
  const trimmed = (body ?? '').trim()
  if (!trimmed)
    return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  }
  catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null
  const obj = parsed as Record<string, unknown>
  const hasKnownField = KNOWN_STATE_FIELDS.some(field => field in obj)
  return hasKnownField ? obj : null
}

/**
 * 从尾往前找最近一条 state JSON comment，返回解析结果；找不到返回 null。
 * 跳过中途插入的普通文本/JSON 内容评论，从而不丢失历史状态。
 */
function findLatestState(comments: GiteaComment[]): Record<string, unknown> | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const parsed = parseStateComment(comments[i].body)
    if (parsed)
      return parsed
  }
  return null
}

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
  const currentState = await readStateJsonComment({
    host: opts.host,
    owner: opts.owner,
    repo: opts.repo,
    token: opts.token,
    issueNumber: opts.issueNumber,
  })
  await postMergedStateJsonComment(opts, currentState, opts.extra)
}

export interface MergeStateJsonCommentGuardedOpts extends MergeStateJsonCommentOpts {
  protectDoneColumn?: boolean
}

/**
 * Merge `extra` while protecting terminal `done` cards from stale automatic
 * column updates. When protection removes the only incoming field, no comment
 * is posted.
 */
export async function mergeStateJsonCommentGuarded(
  opts: MergeStateJsonCommentGuardedOpts,
): Promise<{ posted: boolean, protectedDoneColumn: boolean }> {
  const currentState = await readStateJsonComment({
    host: opts.host,
    owner: opts.owner,
    repo: opts.repo,
    token: opts.token,
    issueNumber: opts.issueNumber,
  })
  const extra = { ...opts.extra }
  let protectedDoneColumn = false

  if (
    opts.protectDoneColumn
    && currentState.column === 'done'
    && typeof extra.column === 'string'
    && extra.column !== 'done'
  ) {
    delete extra.column
    protectedDoneColumn = true
  }

  if (Object.keys(extra).length === 0)
    return { posted: false, protectedDoneColumn }

  await postMergedStateJsonComment(opts, currentState, extra)
  return { posted: true, protectedDoneColumn }
}

async function postMergedStateJsonComment(
  opts: MergeStateJsonCommentOpts,
  currentState: Record<string, unknown>,
  extra: Record<string, unknown>,
): Promise<void> {
  const merged: Record<string, unknown> = {
    ...currentState,
    ...extra,
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
 * object. Scans comments from the tail and returns the first one that parses
 * as an object carrying a known state field, so ordinary comments inserted
 * afterwards don't shadow the real state. Returns an empty object when no such
 * comment exists. Throws on network/API failure.
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
  return findLatestState(comments) ?? {}
}
