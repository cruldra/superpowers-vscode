/**
 * Detects the workspace's Gitea repo coordinates from `git remote get-url origin`.
 *
 * Supports both HTTPS forms (`https://gitea.x.cn/owner/repo.git`) and SSH
 * forms (`git@gitea.x.cn:owner/repo.git`, with or without a leading
 * `ssh://`). The pure URL parser is exported separately so it's unit-testable
 * without spawning a child process.
 */

import { execFile } from 'node:child_process'

export interface Remote {
  host: string
  owner: string
  repo: string
}

const HTTPS_RE = /^https?:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/
const SSH_RE = /^(?:ssh:\/\/)?(?:[^@]+@)?([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/

export function parseRemoteUrl(url: string): Remote | undefined {
  const trimmed = url.trim()
  if (!trimmed)
    return undefined

  const https = trimmed.match(HTTPS_RE)
  if (https)
    return { host: https[1], owner: https[2], repo: https[3] }

  const ssh = trimmed.match(SSH_RE)
  if (ssh)
    return { host: ssh[1], owner: ssh[2], repo: ssh[3] }

  return undefined
}

/**
 * Resolves `{host, owner, repo}` for the origin remote of the given workspace
 * root, or `undefined` if git fails or the URL is unparseable.
 */
export function detectRepo(workspaceRoot: string): Promise<Remote | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', workspaceRoot, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          resolve(undefined)
          return
        }
        resolve(parseRemoteUrl(stdout))
      },
    )
  })
}
