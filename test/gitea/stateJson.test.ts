import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFile = vi.fn()
const spawn = vi.fn()

function mockClaudeSpawnSuccess(stdout: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', 0)
    })
    return child
  })
  return child
}

function mockClaudeSpawnFailure(code: number, stdout: string, stderr = '') {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      if (stdout)
        child.stdout.emit('data', Buffer.from(stdout))
      if (stderr)
        child.stderr.emit('data', Buffer.from(stderr))
      child.emit('close', code)
    })
    return child
  })
  return child
}

vi.mock('node:child_process', () => ({
  execFile,
  spawn,
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

describe('spawnClaude', () => {
  beforeEach(() => {
    execFile.mockReset()
    spawn.mockReset()
  })

  it('runs text prompts with stdin ignored so claude -p does not wait for piped input', async () => {
    execFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(null, '{"session_id":"legacy","result":"wrong"}', '')
    })
    mockClaudeSpawnSuccess('{"session_id":"session-1","result":"ok"}')

    const { spawnClaude } = await import('../../src/cc/spawnClaude.js')

    const result = await spawnClaude({
      prompt: 'hi',
      cwd: '/repo',
      timeoutMs: 1_000,
    })

    expect(result).toEqual({
      sessionId: 'session-1',
      resultText: 'ok',
      rawJson: '{"session_id":"session-1","result":"ok"}',
    })
    expect(execFile).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0][0]).toBe('claude')
    expect(spawn.mock.calls[0][2]).toMatchObject({
      cwd: '/repo',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })

  it('reports JSON stdout diagnostics when claude exits non-zero without stderr', async () => {
    mockClaudeSpawnFailure(1, '{"error":"quota exceeded","session_id":"session-2"}')

    const { spawnClaude } = await import('../../src/cc/spawnClaude.js')

    await expect(spawnClaude({
      prompt: 'hi',
      cwd: '/repo',
      timeoutMs: 1_000,
    })).rejects.toThrow('Claude 退出码非零 (1): quota exceeded')
  })

  it('reports text stdout diagnostics when claude exits non-zero without stderr', async () => {
    mockClaudeSpawnFailure(1, 'plain failure from stdout')

    const { spawnClaude } = await import('../../src/cc/spawnClaude.js')

    await expect(spawnClaude({
      prompt: 'hi',
      cwd: '/repo',
      timeoutMs: 1_000,
    })).rejects.toThrow('Claude 退出码非零 (1): plain failure from stdout')
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
