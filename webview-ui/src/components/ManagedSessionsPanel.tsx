/**
 * 项目 Claude 会话管理器（底部第三个 tab）。
 *
 * - 上方表单：选 profile（下拉，复用 useIssues 的 ClaudeProfile 列表）+ 首个提示词
 *   （可选，多行）+「创建」按钮 → 主进程开一个 cc 终端 tab 并捕获会话。
 * - 下方列表：每行显示名字（双击行内改名，Enter 提交、Esc 取消）、profile 文件名、
 *   创建时间；点击行（非编辑区）→ 主进程新终端 resume；行尾删除按钮（仅移除记录）。
 */

import type { ClaudeProfile } from '../hooks/useIssues'
import type { ManagedSession, ManagedSessionsData } from '../types'
import { Plus, Terminal, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

interface ManagedSessionsPanelProps {
  data: ManagedSessionsData
  profiles: ClaudeProfile[]
  onCreate: (profilePath: string, name?: string, prompt?: string) => void
  onRename: (id: string, name: string) => void
  onResume: (id: string) => void
  onDelete: (id: string) => void
}

function basename(p?: string): string {
  if (!p)
    return ''
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(idx + 1) : p
}

function formatTime(ts: number): string {
  if (!ts)
    return ''
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
  catch {
    return ''
  }
}

export function ManagedSessionsPanel({ data, profiles, onCreate, onRename, onResume, onDelete }: ManagedSessionsPanelProps) {
  const [selectedProfile, setSelectedProfile] = useState<string>('')
  const [name, setName] = useState<string>('')
  const [prompt, setPrompt] = useState<string>('')

  // 默认选中第一个 profile（profiles 异步到达后）。
  useEffect(() => {
    if (!selectedProfile && profiles.length > 0)
      setSelectedProfile(profiles[0].path)
  }, [profiles, selectedProfile])

  const sessions = useMemo(
    () => [...data.sessions].sort((a, b) => b.createdAt - a.createdAt),
    [data.sessions],
  )

  const canCreate = selectedProfile.trim() !== ''

  const handleCreate = useCallback((): void => {
    if (!canCreate)
      return
    const trimmedName = name.trim()
    const trimmedPrompt = prompt.trim()
    onCreate(selectedProfile, trimmedName || undefined, trimmedPrompt || undefined)
    setName('')
    setPrompt('')
  }, [canCreate, name, prompt, selectedProfile, onCreate])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--vscode-editor-background)] text-[var(--vscode-foreground)]">
      {/* 上方表单 */}
      <div className="shrink-0 border-b border-[var(--vscode-panel-border)] p-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-[var(--vscode-descriptionForeground)]">Profile</span>
            <select
              value={selectedProfile}
              onChange={e => setSelectedProfile(e.target.value)}
              className="min-w-0 flex-1 rounded border border-[var(--vscode-input-border,var(--vscode-panel-border))] bg-[var(--vscode-input-background)] px-2 py-1 text-xs text-[var(--vscode-input-foreground)] outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--vscode-focusBorder)]"
            >
              {profiles.length === 0 && (
                <option value="">（无可用 profile）</option>
              )}
              {profiles.map(p => (
                <option key={p.path} value={p.path}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-[var(--vscode-descriptionForeground)]">名字</span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="会话名字（可选）"
              className="min-w-0 flex-1 rounded border border-[var(--vscode-input-border,var(--vscode-panel-border))] bg-[var(--vscode-input-background)] px-2 py-1 text-xs text-[var(--vscode-input-foreground)] outline-none placeholder:text-[var(--vscode-input-placeholderForeground)] focus:ring-1 focus:ring-inset focus:ring-[var(--vscode-focusBorder)]"
            />
          </div>
          <div className="flex items-start gap-2">
            <span className="w-12 shrink-0 pt-1 text-xs text-[var(--vscode-descriptionForeground)]">提示词</span>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="首个提示词（可选）"
              rows={2}
              className="min-w-0 flex-1 resize-y rounded border border-[var(--vscode-input-border,var(--vscode-panel-border))] bg-[var(--vscode-input-background)] px-2 py-1 text-xs text-[var(--vscode-input-foreground)] outline-none placeholder:text-[var(--vscode-input-placeholderForeground)] focus:ring-1 focus:ring-inset focus:ring-[var(--vscode-focusBorder)]"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleCreate}
              disabled={!canCreate}
              className="flex items-center gap-1 rounded bg-[var(--vscode-button-background)] px-3 py-1 text-xs text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="size-3.5" />
              <span>创建</span>
            </button>
          </div>
        </div>
      </div>

      {/* 下方会话列表 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {sessions.length === 0
          ? (
              <div className="flex h-full w-full items-center justify-center p-4 text-xs text-[var(--vscode-descriptionForeground)]">
                还没有会话，先在上方创建一个
              </div>
            )
          : (
              <ul className="flex flex-col">
                {sessions.map(s => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    onRename={onRename}
                    onResume={onResume}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            )}
      </div>
    </div>
  )
}

interface SessionRowProps {
  session: ManagedSession
  onRename: (id: string, name: string) => void
  onResume: (id: string) => void
  onDelete: (id: string) => void
}

function SessionRow({ session, onRename, onResume, onDelete }: SessionRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.name)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useLayoutEffect(() => {
    if (!editing)
      return
    const el = inputRef.current
    if (!el)
      return
    el.focus()
    el.select()
  }, [editing])

  const beginEdit = useCallback((): void => {
    setDraft(session.name)
    setEditing(true)
  }, [session.name])

  const commit = useCallback((): void => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== session.name)
      onRename(session.id, trimmed)
    setEditing(false)
  }, [draft, session.id, session.name, onRename])

  const cancel = useCallback((): void => {
    setEditing(false)
    setDraft(session.name)
  }, [session.name])

  const profileName = basename(session.profilePath)
  const created = formatTime(session.createdAt)

  return (
    <li
      className="group flex items-center gap-2 border-b border-[var(--vscode-panel-border)] px-2 py-1.5 hover:bg-[var(--vscode-list-hoverBackground)]"
    >
      <button
        type="button"
        onClick={() => onResume(session.id)}
        title="点击恢复会话（新终端 resume）"
        className="grid size-6 shrink-0 place-items-center rounded text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))] hover:text-[var(--vscode-foreground)]"
        aria-label="恢复会话"
      >
        <Terminal className="size-3.5" />
      </button>

      <div
        className="min-w-0 flex-1 cursor-pointer"
        onClick={() => {
          if (!editing)
            onResume(session.id)
        }}
      >
        {editing
          ? (
              <input
                ref={inputRef}
                type="text"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onClick={e => e.stopPropagation()}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commit()
                  }
                  else if (e.key === 'Escape') {
                    e.preventDefault()
                    cancel()
                  }
                }}
                className="w-full bg-transparent px-0 py-0 text-xs text-[var(--vscode-input-foreground)] outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--vscode-focusBorder)]"
              />
            )
          : (
              <div className="flex min-w-0 flex-col">
                <span
                  className="truncate text-xs"
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    beginEdit()
                  }}
                  title="双击改名"
                >
                  {session.name || <span className="opacity-40">(未命名)</span>}
                </span>
                <span className="truncate text-[10px] text-[var(--vscode-descriptionForeground)]">
                  {[profileName, created].filter(Boolean).join(' · ')}
                </span>
              </div>
            )}
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(session.id)
        }}
        title="从列表移除（不删 jsonl）"
        aria-label="从列表移除"
        className="grid size-6 shrink-0 place-items-center rounded text-[var(--vscode-descriptionForeground)] opacity-0 transition-opacity hover:bg-[var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))] hover:text-state-red group-hover:opacity-70"
      >
        <Trash2 className="size-3.5" />
      </button>
    </li>
  )
}
