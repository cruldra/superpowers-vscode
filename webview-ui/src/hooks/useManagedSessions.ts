/**
 * 项目 Claude 会话管理器的订阅 hook。
 *
 * - mount 时 postMessage `managed-sessions/get` 拉取一次
 * - 监听 `managed-sessions/show` 同步主进程状态（全量列表）
 * - `createManagedSession(profilePath, prompt?)` 让主进程开 cc 终端并捕获会话
 * - `renameManagedSession(id, name)` / `resumeManagedSession(id)` / `deleteManagedSession(id)`
 *   都把动作委托给主进程，列表由后续 `managed-sessions/show` 更新
 */

import type { ManagedSessionsData } from '../types'
import { useCallback, useEffect, useState } from 'react'
import { onMessage, postMessage } from '../lib/vscode'

export interface UseManagedSessionsResult {
  managedSessions: ManagedSessionsData
  createManagedSession: (profilePath: string, name?: string, prompt?: string) => void
  renameManagedSession: (id: string, name: string) => void
  resumeManagedSession: (id: string) => void
  deleteManagedSession: (id: string) => void
}

export function useManagedSessions(): UseManagedSessionsResult {
  const [managedSessions, setManagedSessions] = useState<ManagedSessionsData>({ sessions: [] })

  useEffect(() => {
    const cleanup = onMessage((msg) => {
      if (msg.type === 'managed-sessions/show')
        setManagedSessions(msg.data)
    })
    postMessage({ type: 'managed-sessions/get' })
    return cleanup
  }, [])

  const createManagedSession = useCallback((profilePath: string, name?: string, prompt?: string): void => {
    postMessage({ type: 'managed-sessions/create', profilePath, name, prompt })
  }, [])

  const renameManagedSession = useCallback((id: string, name: string): void => {
    postMessage({ type: 'managed-sessions/rename', sessionId: id, name })
  }, [])

  const resumeManagedSession = useCallback((id: string): void => {
    postMessage({ type: 'managed-sessions/resume', sessionId: id })
  }, [])

  const deleteManagedSession = useCallback((id: string): void => {
    postMessage({ type: 'managed-sessions/delete', sessionId: id })
  }, [])

  return {
    managedSessions,
    createManagedSession,
    renameManagedSession,
    resumeManagedSession,
    deleteManagedSession,
  }
}
