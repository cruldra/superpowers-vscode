/**
 * 工作区 profile 表（KV grid）。
 *
 * 行 = key，列 = profile（dev / prod / 自定义…）。
 * - 单元格双击进入 input 编辑（key 和每个 value 都支持），失焦或回车提交，Esc 取消
 * - 列头双击改名；右键弹自定义菜单"删除 profile"（至少保留 1 个）
 * - 右键 key 单元格弹"删除 key"
 * - 右边显示 `+` 按钮追加新 profile，末尾一行有 `+ 添加 key` 按钮
 * - 单元格值识别 URL / path-like，显示对应图标，点击 onOpen(value) 由主进程做实际打开
 */

import type { ProfileRow, ProfilesData } from '../lib/messages'
import { ExternalLink, Folder, Plus } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

interface ProfileGridProps {
  data: ProfilesData
  onSave: (next: ProfilesData) => void
  onOpen: (value: string) => void
}

interface MenuState {
  x: number
  y: number
  items: Array<{ label: string, onClick: () => void, danger?: boolean }>
}

type EditTarget
  = | { kind: 'header', col: number }
    | { kind: 'key', row: number }
    | { kind: 'cell', row: number, profile: string }

const URL_RE = /^(?:https?:\/\/|git@)/i
const WIN_PATH_RE = /^[A-Z]:[\\/]/i

function classifyValue(value: string): 'url' | 'path' | null {
  const v = value.trim()
  if (!v)
    return null
  if (URL_RE.test(v))
    return 'url'
  if (v.startsWith('/') || v.startsWith('~') || WIN_PATH_RE.test(v))
    return 'path'
  // 含斜杠且不像 URL → 视作相对路径
  if (v.includes('/'))
    return 'path'
  return null
}

export function ProfileGrid({ data, onSave, onOpen }: ProfileGridProps) {
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [draft, setDraft] = useState<string>('')
  const [menu, setMenu] = useState<MenuState | null>(null)
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

  // 外部点击关闭右键菜单
  useEffect(() => {
    if (!menu)
      return
    function onDocClick(): void {
      setMenu(null)
    }
    function onEsc(e: KeyboardEvent): void {
      if (e.key === 'Escape')
        setMenu(null)
    }
    window.addEventListener('mousedown', onDocClick)
    window.addEventListener('keydown', onEsc)
    return () => {
      window.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('keydown', onEsc)
    }
  }, [menu])

  const profiles = data.profiles
  const rows = data.rows

  const commitEdit = useCallback((target: EditTarget, newValue: string): void => {
    if (target.kind === 'header') {
      const trimmed = newValue.trim()
      if (!trimmed)
        return
      const old = profiles[target.col]
      if (trimmed === old)
        return
      // 同名去重：如果新名已存在，丢弃这次改名
      if (profiles.some((p, i) => i !== target.col && p === trimmed))
        return
      const nextProfiles = [...profiles]
      nextProfiles[target.col] = trimmed
      const nextRows: ProfileRow[] = rows.map((r) => {
        if (!(old in r.values))
          return r
        const v = r.values[old]
        const nv = { ...r.values }
        delete nv[old]
        nv[trimmed] = v
        return { ...r, values: nv }
      })
      onSave({ profiles: nextProfiles, rows: nextRows })
      return
    }
    if (target.kind === 'key') {
      const trimmed = newValue.trim()
      if (!trimmed)
        return
      if (rows[target.row].key === trimmed)
        return
      const nextRows = rows.map((r, i) => i === target.row ? { ...r, key: trimmed } : r)
      onSave({ profiles, rows: nextRows })
      return
    }
    // cell
    const currentVal = rows[target.row].values[target.profile] ?? ''
    if (currentVal === newValue)
      return
    const nextRows = rows.map((r, i) => {
      if (i !== target.row)
        return r
      const nv = { ...r.values, [target.profile]: newValue }
      return { ...r, values: nv }
    })
    onSave({ profiles, rows: nextRows })
  }, [profiles, rows, onSave])

  const beginEdit = useCallback((target: EditTarget): void => {
    let initial = ''
    if (target.kind === 'header')
      initial = profiles[target.col] ?? ''
    else if (target.kind === 'key')
      initial = rows[target.row]?.key ?? ''
    else
      initial = rows[target.row]?.values[target.profile] ?? ''
    setDraft(initial)
    setEditing(target)
  }, [profiles, rows])

  const cancelEdit = useCallback((): void => {
    setEditing(null)
    setDraft('')
  }, [])

  const finishEdit = useCallback((): void => {
    if (!editing)
      return
    commitEdit(editing, draft)
    setEditing(null)
    setDraft('')
  }, [editing, draft, commitEdit])

  const addProfile = useCallback((): void => {
    let n = profiles.length + 1
    let name = `profile${n}`
    while (profiles.includes(name)) {
      n += 1
      name = `profile${n}`
    }
    onSave({ profiles: [...profiles, name], rows })
  }, [profiles, rows, onSave])

  const deleteProfile = useCallback((col: number): void => {
    if (profiles.length <= 1)
      return
    const name = profiles[col]
    const nextProfiles = profiles.filter((_, i) => i !== col)
    const nextRows = rows.map((r) => {
      if (!(name in r.values))
        return r
      const nv = { ...r.values }
      delete nv[name]
      return { ...r, values: nv }
    })
    onSave({ profiles: nextProfiles, rows: nextRows })
  }, [profiles, rows, onSave])

  const addKey = useCallback((): void => {
    let n = rows.length + 1
    let key = `key${n}`
    while (rows.some(r => r.key === key)) {
      n += 1
      key = `key${n}`
    }
    onSave({ profiles, rows: [...rows, { key, values: {} }] })
  }, [profiles, rows, onSave])

  const deleteKey = useCallback((row: number): void => {
    onSave({ profiles, rows: rows.filter((_, i) => i !== row) })
  }, [profiles, rows, onSave])

  // CSS grid 列模板：第一列 key，后面是 profile 列，末列 add-profile
  const gridTemplate = useMemo(() => {
    const cols = ['minmax(160px, 200px)']
    for (let i = 0; i < profiles.length; i++)
      cols.push('minmax(200px, 1fr)')
    cols.push('40px')
    return cols.join(' ')
  }, [profiles.length])

  function openHeaderMenu(e: React.MouseEvent, col: number): void {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: '删除 profile',
          danger: true,
          onClick: () => {
            if (profiles.length <= 1)
              return
            deleteProfile(col)
          },
        },
      ],
    })
  }

  function openKeyMenu(e: React.MouseEvent, row: number): void {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: '删除 key',
          danger: true,
          onClick: () => deleteKey(row),
        },
      ],
    })
  }

  const cellBase
    = 'min-h-[28px] border-r border-b border-[var(--vscode-panel-border)] text-xs flex items-center'
  const editableHover
    = 'hover:bg-[var(--vscode-list-hoverBackground)] cursor-text'
  const headerBase
    = 'min-h-[28px] border-r border-b border-[var(--vscode-panel-border)] text-xs font-medium flex items-center bg-[var(--vscode-editorWidget-background)]'

  return (
    <div className="relative flex h-full w-full flex-col overflow-auto bg-[var(--vscode-editor-background)] text-[var(--vscode-foreground)]">
      <div className="min-w-full" style={{ display: 'grid', gridTemplateColumns: gridTemplate }}>
        {/* Header row */}
        <div
          className={`${headerBase} border-l border-t px-2 text-[var(--vscode-descriptionForeground)]`}
        >
          key
        </div>
        {profiles.map((name, col) => (
          <div
            key={`h-${col}`}
            className={`${headerBase} border-t px-2`}
            onDoubleClick={() => beginEdit({ kind: 'header', col })}
            onContextMenu={e => openHeaderMenu(e, col)}
            title="双击改名，右键删除"
          >
            {editing && editing.kind === 'header' && editing.col === col
              ? (
                  <input
                    ref={inputRef}
                    type="text"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={finishEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        finishEdit()
                      }
                      else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelEdit()
                      }
                    }}
                    className="w-full bg-transparent px-0 py-0 text-xs text-[var(--vscode-input-foreground)] outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--vscode-focusBorder)]"
                  />
                )
              : (
                  <span className="truncate">{name}</span>
                )}
          </div>
        ))}
        <div className={`${headerBase} border-t flex items-center justify-center`}>
          <button
            type="button"
            onClick={addProfile}
            title="新增 profile 列"
            aria-label="新增 profile 列"
            className="grid size-5 place-items-center rounded opacity-60 hover:bg-[var(--vscode-list-hoverBackground)] hover:opacity-100"
          >
            <Plus className="size-3.5" />
          </button>
        </div>

        {/* Data rows */}
        {rows.map((row, rIdx) => (
          <RowFragment
            key={`row-${rIdx}`}
            row={row}
            rIdx={rIdx}
            profiles={profiles}
            editing={editing}
            draft={draft}
            inputRef={inputRef}
            cellBase={cellBase}
            editableHover={editableHover}
            beginEdit={beginEdit}
            cancelEdit={cancelEdit}
            finishEdit={finishEdit}
            setDraft={setDraft}
            openKeyMenu={openKeyMenu}
            onOpen={onOpen}
          />
        ))}

        {/* Add-key footer row spans all columns */}
        <div
          className={`${cellBase} border-l col-span-full justify-start px-2`}
          style={{ gridColumn: `1 / span ${profiles.length + 2}` }}
        >
          <button
            type="button"
            onClick={addKey}
            title="新增 key 行"
            className="flex items-center gap-1 rounded px-1 py-0.5 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-list-hoverBackground)] hover:text-[var(--vscode-foreground)]"
          >
            <Plus className="size-3.5" />
            <span>添加 key</span>
          </button>
        </div>
      </div>

      {/* 自定义右键菜单 */}
      {menu && (
        <div
          className="fixed z-50 min-w-[140px] rounded border border-[var(--vscode-menu-border,var(--vscode-panel-border))] bg-[var(--vscode-menu-background,var(--vscode-editorWidget-background))] py-1 text-xs shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          {menu.items.map((it, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                it.onClick()
                setMenu(null)
              }}
              className={`block w-full px-3 py-1 text-left hover:bg-[var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground))] ${
                it.danger ? 'text-state-red' : 'text-[var(--vscode-menu-foreground,var(--vscode-foreground))]'
              }`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface RowFragmentProps {
  row: ProfileRow
  rIdx: number
  profiles: string[]
  editing: EditTarget | null
  draft: string
  inputRef: React.MutableRefObject<HTMLInputElement | null>
  cellBase: string
  editableHover: string
  beginEdit: (target: EditTarget) => void
  cancelEdit: () => void
  finishEdit: () => void
  setDraft: (v: string) => void
  openKeyMenu: (e: React.MouseEvent, row: number) => void
  onOpen: (value: string) => void
}

function RowFragment({
  row,
  rIdx,
  profiles,
  editing,
  draft,
  inputRef,
  cellBase,
  editableHover,
  beginEdit,
  cancelEdit,
  finishEdit,
  setDraft,
  openKeyMenu,
  onOpen,
}: RowFragmentProps) {
  return (
    <>
      <div
        className={`${cellBase} ${editableHover} border-l px-2 font-medium`}
        onDoubleClick={() => beginEdit({ kind: 'key', row: rIdx })}
        onContextMenu={e => openKeyMenu(e, rIdx)}
        title="双击编辑 key，右键删除"
      >
        {editing && editing.kind === 'key' && editing.row === rIdx
          ? (
              <input
                ref={inputRef}
                type="text"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={finishEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    finishEdit()
                  }
                  else if (e.key === 'Escape') {
                    e.preventDefault()
                    cancelEdit()
                  }
                }}
                className="w-full bg-transparent px-0 py-0 text-xs text-[var(--vscode-input-foreground)] outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--vscode-focusBorder)]"
              />
            )
          : (
              <span className="truncate">{row.key || <span className="opacity-40">(空)</span>}</span>
            )}
      </div>
      {profiles.map((profile, col) => {
        const value = row.values[profile] ?? ''
        const isEditing = editing && editing.kind === 'cell' && editing.row === rIdx && editing.profile === profile
        const kind = classifyValue(value)
        return (
          <div
            key={`r${rIdx}-c${col}`}
            className={`${cellBase} ${editableHover} group px-2`}
            onDoubleClick={() => beginEdit({ kind: 'cell', row: rIdx, profile })}
            title="双击编辑"
          >
            {isEditing
              ? (
                  <input
                    ref={inputRef}
                    type="text"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={finishEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        finishEdit()
                      }
                      else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelEdit()
                      }
                    }}
                    className="w-full bg-transparent px-0 py-0 text-xs text-[var(--vscode-input-foreground)] outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--vscode-focusBorder)]"
                  />
                )
              : (
                  <div className="flex w-full min-w-0 items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate">
                      {value || <span className="opacity-40">(空)</span>}
                    </span>
                    {kind && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpen(value)
                        }}
                        title={kind === 'url' ? '在浏览器打开' : '在系统中打开'}
                        aria-label={kind === 'url' ? '在浏览器打开' : '在系统中打开'}
                        className="grid size-5 shrink-0 place-items-center rounded opacity-0 transition-opacity hover:bg-[var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))] hover:opacity-100 group-hover:opacity-70"
                      >
                        {kind === 'url' ? <ExternalLink className="size-3.5" /> : <Folder className="size-3.5" />}
                      </button>
                    )}
                  </div>
                )}
          </div>
        )
      })}
      <div className={`${cellBase}`} />
    </>
  )
}
