/**
 * Workspace 级 profile 表的订阅 hook。
 *
 * - mount 时 postMessage `profiles/get` 拉取一次
 * - 监听 `profiles/show` 同步主进程状态
 * - `saveProfiles(next)` 立即 optimistic 更新本地 state，并 postMessage `profiles/save`
 * - `openProfileValue(value)` 把单元格值委托给主进程做智能 open
 */

import type { ProfilesData } from '../lib/messages'
import { useCallback, useEffect, useState } from 'react'
import { onMessage, postMessage } from '../lib/vscode'

const DEFAULT_PROFILES: ProfilesData = {
  profiles: ['dev', 'prod'],
  rows: [],
}

export interface UseProfilesResult {
  profiles: ProfilesData
  saveProfiles: (next: ProfilesData) => void
  openProfileValue: (value: string) => void
}

export function useProfiles(): UseProfilesResult {
  const [profiles, setProfiles] = useState<ProfilesData>(DEFAULT_PROFILES)

  useEffect(() => {
    const cleanup = onMessage((msg) => {
      if (msg.type === 'profiles/show')
        setProfiles(msg.data)
    })
    postMessage({ type: 'profiles/get' })
    return cleanup
  }, [])

  const saveProfiles = useCallback((next: ProfilesData): void => {
    setProfiles(next)
    postMessage({ type: 'profiles/save', data: next })
  }, [])

  const openProfileValue = useCallback((value: string): void => {
    postMessage({ type: 'profiles/open', value })
  }, [])

  return { profiles, saveProfiles, openProfileValue }
}
