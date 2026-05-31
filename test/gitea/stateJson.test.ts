import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFile = vi.fn()

vi.mock('node:child_process', () => ({
  execFile,
}))

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

describe('deleteLocalBranch', () => {
  beforeEach(() => {
    execFile.mockReset()
  })

  it('treats a missing local branch as already deleted', async () => {
    execFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(new Error('missing'), '', '')
    })
    const { deleteLocalBranch } = await import('../../src/git/branchSync.js')

    const result = await deleteLocalBranch('/repo', 'feature/test')

    expect(result).toEqual({ ok: true, stdout: '', stderr: '' })
    expect(execFile).toHaveBeenCalledOnce()
    expect(execFile.mock.calls[0][1]).toEqual([
      '-C',
      '/repo',
      'show-ref',
      '--verify',
      '--quiet',
      'refs/heads/feature/test',
    ])
  })

  it('deletes an existing local branch with git args instead of shell interpolation', async () => {
    execFile
      .mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(null, '', '')
      })
      .mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(null, 'deleted', '')
      })
    const { deleteLocalBranch } = await import('../../src/git/branchSync.js')

    const result = await deleteLocalBranch('/repo', 'feature/weird name;rm -rf')

    expect(result).toEqual({ ok: true, stdout: 'deleted', stderr: '' })
    expect(execFile).toHaveBeenCalledTimes(2)
    expect(execFile.mock.calls[1][1]).toEqual([
      '-C',
      '/repo',
      'branch',
      '-D',
      'feature/weird name;rm -rf',
    ])
  })
})
