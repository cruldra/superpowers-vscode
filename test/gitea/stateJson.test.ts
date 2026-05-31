import { beforeEach, describe, expect, it, vi } from 'vitest'

const listIssueComments = vi.fn()
const postIssueComment = vi.fn()

vi.mock('../../src/gitea/api', () => ({
  listIssueComments,
  postIssueComment,
}))

describe('mergeStateJsonCommentGuarded', () => {
  beforeEach(() => {
    listIssueComments.mockReset()
    postIssueComment.mockReset()
  })

  it('keeps done column when an automatic flow tries to merge review while preserving other fields', async () => {
    const { mergeStateJsonCommentGuarded } = await import('../../src/gitea/stateJson.js')
    listIssueComments.mockResolvedValue([
      { body: JSON.stringify({ column: 'done', implementStatus: 'done', prMerged: true }) },
    ])

    await mergeStateJsonCommentGuarded({
      host: 'https://gitea.example',
      owner: 'owner',
      repo: 'repo',
      token: 'token',
      issueNumber: 123,
      protectDoneColumn: true,
      extra: { column: 'review', reviewSessionId: 'review-1' },
    })

    expect(postIssueComment).toHaveBeenCalledOnce()
    expect(JSON.parse(postIssueComment.mock.calls[0][0].body)).toEqual({
      column: 'done',
      implementStatus: 'done',
      prMerged: true,
      reviewSessionId: 'review-1',
    })
  })

  it('skips posting when protected done would only merge a stale column', async () => {
    const { mergeStateJsonCommentGuarded } = await import('../../src/gitea/stateJson.js')
    listIssueComments.mockResolvedValue([
      { body: JSON.stringify({ column: 'done', implementStatus: 'done' }) },
    ])

    await mergeStateJsonCommentGuarded({
      host: 'https://gitea.example',
      owner: 'owner',
      repo: 'repo',
      token: 'token',
      issueNumber: 123,
      protectDoneColumn: true,
      extra: { column: 'review' },
    })

    expect(postIssueComment).not.toHaveBeenCalled()
  })
})
