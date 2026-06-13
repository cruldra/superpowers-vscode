/**
 * 「提交」tab 的订阅 hook：按工单号拉取 PR 提交、按需拉提交内文件，并触发原生
 * diff。数据全程实时从扩展侧（Gitea API）取，本 hook 只做缓存与订阅。
 *
 * - issueNumber 变化（含首次）时 postMessage `pr-commits/get`，并清空上一工单的
 *   文件缓存与 parentSha 映射，避免串台。
 * - 订阅 `pr-commits/show` / `pr-commit-files/show`，只认 issueNumber 匹配的消息
 *   （扩展侧可能并发多工单的回包）。
 * - filesBySha 缓存：同一提交点开第二次不再发请求。
 */

import type { PrCommit, PrCommitFile } from '../lib/messages'
import { useCallback, useEffect, useRef, useState } from 'react'
import { onMessage, postMessage } from '../lib/vscode'

export interface UsePrCommitsResult {
  commits: PrCommit[]
  commitsError: string | undefined
  loadingCommits: boolean
  filesBySha: Record<string, PrCommitFile[]>
  parentShaBySha: Record<string, string | undefined>
  filesErrorBySha: Record<string, string | undefined>
  confirmedBySha: Record<string, string[]>
  getFiles: (sha: string) => void
  openDiff: (sha: string, parentSha: string | undefined, path: string, status: string) => void
  setConfirmed: (sha: string, paths: string[]) => void
}

export function usePrCommits(issueNumber: number | undefined): UsePrCommitsResult {
  const [commits, setCommits] = useState<PrCommit[]>([])
  const [commitsError, setCommitsError] = useState<string | undefined>(undefined)
  const [loadingCommits, setLoadingCommits] = useState(false)
  const [filesBySha, setFilesBySha] = useState<Record<string, PrCommitFile[]>>({})
  const [parentShaBySha, setParentShaBySha] = useState<Record<string, string | undefined>>({})
  const [filesErrorBySha, setFilesErrorBySha] = useState<Record<string, string | undefined>>({})
  const [confirmedBySha, setConfirmedBySha] = useState<Record<string, string[]>>({})

  // issueNumber 装进 ref，让订阅闭包始终读到当前值（订阅只在 mount 挂一次）。
  const issueRef = useRef<number | undefined>(issueNumber)
  issueRef.current = issueNumber

  // 已发出 files 请求的 sha 集合：防同一提交并发重复请求（缓存到达前的窗口）。
  const requestedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const cleanup = onMessage((msg) => {
      if (msg.type === 'pr-commits/show') {
        if (msg.issueNumber !== issueRef.current)
          return
        setCommits(msg.commits)
        setCommitsError(msg.error)
        setLoadingCommits(false)
        return
      }
      if (msg.type === 'pr-commit-files/show') {
        if (msg.issueNumber !== issueRef.current)
          return
        setFilesBySha(prev => ({ ...prev, [msg.sha]: msg.files }))
        setParentShaBySha(prev => ({ ...prev, [msg.sha]: msg.parentSha }))
        setFilesErrorBySha(prev => ({ ...prev, [msg.sha]: msg.error }))
        setConfirmedBySha(prev => ({ ...prev, [msg.sha]: msg.confirmed ?? [] }))
      }
    })
    return cleanup
  }, [])

  // 切工单：清空缓存与已请求集合，重新拉提交列表。无工单时只清空。
  useEffect(() => {
    setCommits([])
    setCommitsError(undefined)
    setFilesBySha({})
    setParentShaBySha({})
    setFilesErrorBySha({})
    setConfirmedBySha({})
    requestedRef.current = new Set()
    if (issueNumber === undefined) {
      setLoadingCommits(false)
      return
    }
    setLoadingCommits(true)
    postMessage({ type: 'pr-commits/get', issueNumber })
  }, [issueNumber])

  const getFiles = useCallback((sha: string): void => {
    const num = issueRef.current
    if (num === undefined)
      return
    if (requestedRef.current.has(sha))
      return
    requestedRef.current.add(sha)
    postMessage({ type: 'pr-commit-files/get', issueNumber: num, sha })
  }, [])

  const openDiff = useCallback(
    (sha: string, parentSha: string | undefined, path: string, status: string): void => {
      const num = issueRef.current
      if (num === undefined)
        return
      postMessage({ type: 'pr-commit-diff/open', issueNumber: num, sha, parentSha, path, status })
    },
    [],
  )

  // 乐观更新本地确认态并落盘到扩展侧；下次拉文件回包会以持久化值校正。
  const setConfirmed = useCallback((sha: string, paths: string[]): void => {
    const num = issueRef.current
    if (num === undefined)
      return
    setConfirmedBySha(prev => ({ ...prev, [sha]: paths }))
    postMessage({ type: 'pr-review/set', issueNumber: num, sha, confirmed: paths })
  }, [])

  return {
    commits,
    commitsError,
    loadingCommits,
    filesBySha,
    parentShaBySha,
    filesErrorBySha,
    confirmedBySha,
    getFiles,
    openDiff,
    setConfirmed,
  }
}
