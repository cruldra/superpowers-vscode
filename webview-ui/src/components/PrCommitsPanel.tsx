/**
 * 「提交」tab（底部第四个）：浏览当前工单 PR 的提交 → 提交内文件 → 原生 diff。
 *
 * - 上半区：提交列表（sha 前 7 位 + 消息首行 + 作者 + 时间），单选高亮。
 * - 下半区：选中提交的文件清单，渲染成目录树（合并单子目录链），文件行状态徽标
 *   （A/M/D/R 着色）+ 文件名，点击触发 `vscode.diff` 比较该文件在 parentSha → sha
 *   之间的改动；`tests/` 目录下的文件不展示。
 *
 * 自带 usePrCommits hook，直接经 lib/vscode 收发消息，不依赖上层回调。
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Issue } from '../types'
import { Check, ChevronDown, ChevronRight, Folder } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePrCommits } from '../hooks/usePrCommits'

interface PrCommitsPanelProps {
  issue: Issue | null
}

/** 提交时间格式化，与 ManagedSessionsPanel 风格一致；无效值回空串。 */
function formatDate(iso: string): string {
  if (!iso)
    return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime()))
    return ''
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 状态首字母徽标（大写），未知状态取首字母兜底。 */
function statusBadge(status: string): string {
  const s = status.toLowerCase()
  if (s.startsWith('add'))
    return 'A'
  if (s.startsWith('modif'))
    return 'M'
  if (s.startsWith('delet') || s.startsWith('remov'))
    return 'D'
  if (s.startsWith('renam'))
    return 'R'
  if (s.startsWith('cop'))
    return 'C'
  return (status[0] ?? '?').toUpperCase()
}

/** 徽标颜色用 VS Code git 装饰主题变量，与编辑器源码管理视图一致。 */
function statusColorVar(status: string): string {
  const s = status.toLowerCase()
  if (s.startsWith('add') || s.startsWith('cop'))
    return 'var(--vscode-gitDecoration-addedResourceForeground)'
  if (s.startsWith('delet') || s.startsWith('remov'))
    return 'var(--vscode-gitDecoration-deletedResourceForeground)'
  if (s.startsWith('renam'))
    return 'var(--vscode-gitDecoration-renamedResourceForeground, var(--vscode-gitDecoration-modifiedResourceForeground))'
  return 'var(--vscode-gitDecoration-modifiedResourceForeground)'
}

/** PR diff 里跳过测试代码：路径任一段为 `tests` 即视为忽略（匹配 `tests/…` 或 `…/tests/…`）。 */
function isIgnoredPath(path: string): boolean {
  return path.split('/').some(seg => seg === 'tests')
}

/**
 * 拍平后的可渲染行：
 * - 目录行带层级、（合并单子目录链后的）显示名、完整路径（折叠状态的唯一 key）、
 *   当前是否折叠，以及其子树下所有可见文件的完整路径（用于目录级「已确认」级联）；
 * - 文件行额外带完整路径与状态。
 */
type TreeRow
  = | { kind: 'dir', name: string, depth: number, path: string, collapsed: boolean, descendantFiles: string[] }
    | { kind: 'file', name: string, depth: number, path: string, status: string }

interface FileLeaf { name: string, path: string, status: string }

/** 构树用的中间目录节点：子目录按名索引，文件平铺。 */
interface DirNode {
  dirs: Map<string, DirNode>
  files: FileLeaf[]
}

function newDirNode(): DirNode {
  return { dirs: new Map(), files: [] }
}

/**
 * 把 `{ path, status }[]` 构建成嵌套目录树（只构树，不拍平、不合并）。
 *
 * 路径按 `/` 切分，最后一段是文件、其余是目录层级；折叠的拍平交给 `flattenTree`。
 */
function buildDirTree(files: ReadonlyArray<{ path: string, status: string }>): DirNode {
  const root = newDirNode()
  for (const f of files) {
    const segs = f.path.split('/')
    const fileName = segs[segs.length - 1]
    let node = root
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]
      let child = node.dirs.get(seg)
      if (!child) {
        child = newDirNode()
        node.dirs.set(seg, child)
      }
      node = child
    }
    node.files.push({ name: fileName, path: f.path, status: f.status })
  }
  return root
}

/**
 * DFS 拍平目录树成可渲染行列表，并感知折叠状态。
 *
 * - 合并单子目录链（VS Code "compact folders" 风格）：目录只有 1 个子目录且无文件时，
 *   两级目录名用 `/` 连接成一行，递归直到分叉或遇到文件；同时累计该目录行的完整路径
 *   （从根拼起、含所有被合并的段），作为折叠状态的唯一 key。
 * - 每层先目录后文件，各自按 `localeCompare` 升序，DFS 顺序输出，`depth` 从 0 起。
 * - 目录被折叠（`collapsed` 含其完整路径）时，只 push 目录行本身，不再递归其子节点。
 */
/** 收集一个目录子树下所有文件的完整路径（含各级子目录），用于目录级确认级联。 */
function collectDescendantFiles(node: DirNode): string[] {
  const out: string[] = []
  const walk = (n: DirNode) => {
    for (const f of n.files)
      out.push(f.path)
    for (const child of n.dirs.values())
      walk(child)
  }
  walk(node)
  return out
}

function flattenTree(root: DirNode, collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  // prefix 是父目录的完整路径（含尾部 `/`），用于拼出当前目录行的折叠 key。
  const emit = (node: DirNode, depth: number, prefix: string) => {
    const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))
    for (const name of dirNames) {
      // 合并单子目录链：沿途只要恰好 1 个子目录且本级无文件，就把目录名拼起来；
      // path 同步累计每个被合并的段，作为折叠状态的唯一标识。
      let label = name
      let path = prefix + name
      let cur = node.dirs.get(name)!
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        const [childName, childNode] = [...cur.dirs.entries()][0]
        label += `/${childName}`
        path += `/${childName}`
        cur = childNode
      }
      const isCollapsed = collapsed.has(path)
      rows.push({
        kind: 'dir',
        name: label,
        depth,
        path,
        collapsed: isCollapsed,
        descendantFiles: collectDescendantFiles(cur),
      })
      // 折叠则隐藏其下所有内容，不再递归。
      if (!isCollapsed)
        emit(cur, depth + 1, `${path}/`)
    }
    const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name))
    for (const f of sortedFiles)
      rows.push({ kind: 'file', name: f.name, depth, path: f.path, status: f.status })
  }
  emit(root, 0, '')
  return rows
}

export function PrCommitsPanel({ issue }: PrCommitsPanelProps) {
  const issueNumber = issue?.number
  const {
    commits,
    commitsError,
    loadingCommits,
    filesBySha,
    parentShaBySha,
    filesErrorBySha,
    confirmedBySha,
    confirmedCommits,
    getFiles,
    openDiff,
    setConfirmed,
    markCommitsConfirmed,
  } = usePrCommits(issueNumber)

  const [selectedSha, setSelectedSha] = useState<string | undefined>(undefined)
  // 已折叠目录的完整路径集合；不在集合内即展开（默认全展开）。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // JS 驱动的悬停态：Tailwind v4 把 group-hover 包进 @media(hover:hover)，
  // Wayland 下的 VS Code webview 不满足该条件，故改用鼠标事件控制按钮显隐。
  const [hoveredPath, setHoveredPath] = useState<string | null>(null)
  // 提交行的悬停态（与文件行的 hoveredPath 分开），同样 JS 驱动确认按钮显隐。
  const [hoveredCommit, setHoveredCommit] = useState<string | null>(null)
  // 提交列表 <ul>，用于方向键切换后把选中项滚进可视区。
  const commitListRef = useRef<HTMLUListElement | null>(null)

  // 切工单时清掉选中态（hook 已清缓存，这里只管 UI 选中）。
  useEffect(() => {
    setSelectedSha(undefined)
  }, [issueNumber])

  // 切提交后文件树默认全展开，避免沿用上一提交的折叠状态。
  useEffect(() => {
    setCollapsed(new Set())
  }, [selectedSha])

  // 选中提交且尚无文件缓存 → 拉一次文件清单。
  useEffect(() => {
    if (selectedSha && !(selectedSha in filesBySha))
      getFiles(selectedSha)
  }, [selectedSha, filesBySha, getFiles])

  // 方向键切换选中后，把选中的提交行滚进可视区（按 dataset 匹配，避免 sha 进选择器）。
  useEffect(() => {
    if (!selectedSha)
      return
    const ul = commitListRef.current
    if (!ul)
      return
    for (const li of ul.children) {
      if ((li as HTMLElement).dataset.sha === selectedSha) {
        (li as HTMLElement).scrollIntoView({ block: 'nearest' })
        break
      }
    }
  }, [selectedSha])

  if (!issue) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-xs text-[var(--vscode-descriptionForeground)]">
        未选中工单
      </div>
    )
  }

  if (!issue.pr) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-xs text-[var(--vscode-descriptionForeground)]">
        该工单还没有 PR
      </div>
    )
  }

  const selectedFiles = selectedSha ? filesBySha[selectedSha] : undefined
  const selectedFilesError = selectedSha ? filesErrorBySha[selectedSha] : undefined
  const selectedParentSha = selectedSha ? parentShaBySha[selectedSha] : undefined

  // 过滤掉 tests/ 后构嵌套树；selectedFiles 还没加载（undefined）时给空列表。
  // 构树只依赖文件本身，折叠状态变化不必重构树，只重新拍平。
  const dirTree = useMemo(
    () => buildDirTree((selectedFiles ?? []).filter(f => !isIgnoredPath(f.path))),
    [selectedFiles],
  )
  const fileTreeRows = useMemo(() => flattenTree(dirTree, collapsed), [dirTree, collapsed])

  // 当前提交已确认的文件路径集合（目录确认靠「其下文件全在此集合」推导）。
  const confirmed = useMemo(
    () => new Set(confirmedBySha[selectedSha ?? ''] ?? []),
    [confirmedBySha, selectedSha],
  )

  // 当前工单已确认的提交 sha 集合（提交行勾标记 + 行淡化用）。
  const confirmedCommitSet = useMemo(() => new Set(confirmedCommits), [confirmedCommits])

  // 提交列表方向键切换：未选中时 ArrowDown 选首、ArrowUp 选末；已选中则按下标夹取边界移动。
  const onCommitListKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    if (commits.length === 0)
      return
    const cur = selectedSha ? commits.findIndex(c => c.sha === selectedSha) : -1
    let next: number | undefined
    if (e.key === 'ArrowDown')
      next = cur < 0 ? 0 : Math.min(cur + 1, commits.length - 1)
    else if (e.key === 'ArrowUp')
      next = cur < 0 ? commits.length - 1 : Math.max(cur - 1, 0)
    else if (e.key === 'Home')
      next = 0
    else if (e.key === 'End')
      next = commits.length - 1
    if (next === undefined)
      return
    e.preventDefault()
    setSelectedSha(commits[next].sha)
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--vscode-editor-background)] text-[var(--vscode-foreground)]">
      {/* 上半区：提交列表 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-b border-[var(--vscode-panel-border)]">
        <div className="shrink-0 px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">
          {`提交 #${issue.pr}`}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {commitsError
            ? (
                <div className="p-3 text-xs text-[var(--vscode-errorForeground)]">
                  {commitsError}
                </div>
              )
            : loadingCommits
              ? (
                  <div className="flex h-full w-full items-center justify-center p-4 text-xs text-[var(--vscode-descriptionForeground)]">
                    加载中…
                  </div>
                )
              : commits.length === 0
                ? (
                    <div className="flex h-full w-full items-center justify-center p-4 text-xs text-[var(--vscode-descriptionForeground)]">
                      该 PR 暂无提交
                    </div>
                  )
                : (
                    <ul
                      ref={commitListRef}
                      tabIndex={0}
                      role="listbox"
                      aria-label="PR 提交列表"
                      onKeyDown={onCommitListKeyDown}
                      className="flex flex-col outline-none"
                    >
                      {commits.map((c) => {
                        const isConfirmed = confirmedCommitSet.has(c.sha)
                        return (
                          <li
                            key={c.sha}
                            data-sha={c.sha}
                            role="option"
                            aria-selected={selectedSha === c.sha}
                            onMouseEnter={() => setHoveredCommit(c.sha)}
                            onMouseLeave={() => setHoveredCommit(p => (p === c.sha ? null : p))}
                            onClick={() => {
                              setSelectedSha(c.sha)
                              // 选中后把焦点给列表，方向键即时可用（不被看板抢走）。
                              commitListRef.current?.focus()
                            }}
                            className={`flex cursor-pointer flex-col gap-0.5 border-b border-[var(--vscode-panel-border)] px-2 py-1.5 ${
                              selectedSha === c.sha
                                ? 'bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]'
                                : 'hover:bg-[var(--vscode-list-hoverBackground)]'
                            } ${isConfirmed ? 'opacity-60' : ''}`}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="shrink-0 font-mono text-[10px] text-[var(--vscode-descriptionForeground)]">
                                {c.sha.slice(0, 7)}
                              </span>
                              <span className="min-w-0 truncate text-xs" title={c.message}>
                                {c.message}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  const next = isConfirmed
                                    ? confirmedCommits.filter(s => s !== c.sha)
                                    : [...confirmedCommits, c.sha]
                                  markCommitsConfirmed(next)
                                }}
                                title={isConfirmed ? '已确认，点击取消' : '标记为已确认'}
                                className="shrink-0 transition-opacity"
                                style={{
                                  opacity: isConfirmed || hoveredCommit === c.sha ? 1 : 0,
                                  color: isConfirmed
                                    ? 'var(--vscode-gitDecoration-addedResourceForeground)'
                                    : 'var(--vscode-descriptionForeground)',
                                }}
                              >
                                <Check className="size-3.5" />
                              </button>
                            </div>
                            <div className="truncate text-[10px] text-[var(--vscode-descriptionForeground)]">
                              {[c.authorName, formatDate(c.date)].filter(Boolean).join(' · ')}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
        </div>
      </div>

      {/* 下半区：选中提交的文件清单 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0 px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">
          文件
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {!selectedSha
            ? (
                <div className="flex h-full w-full items-center justify-center p-4 text-xs text-[var(--vscode-descriptionForeground)]">
                  选择一个提交查看文件
                </div>
              )
            : selectedFilesError
              ? (
                  <div className="p-3 text-xs text-[var(--vscode-errorForeground)]">
                    {selectedFilesError}
                  </div>
                )
              : selectedFiles === undefined
                ? (
                    <div className="flex h-full w-full items-center justify-center p-4 text-xs text-[var(--vscode-descriptionForeground)]">
                      加载中…
                    </div>
                  )
                : selectedFiles.length === 0
                  ? (
                      <div className="flex h-full w-full items-center justify-center p-4 text-xs text-[var(--vscode-descriptionForeground)]">
                        该提交无文件改动
                      </div>
                    )
                  // selectedFiles 非空但全被 tests/ 过滤掉，行列表才会为空。
                  : fileTreeRows.length === 0
                    ? (
                        <div className="flex h-full w-full items-center justify-center p-4 text-xs text-[var(--vscode-descriptionForeground)]">
                          该提交改动均在 tests/ 目录（已忽略）
                        </div>
                      )
                    : (
                        <ul className="flex flex-col py-0.5">
                          {fileTreeRows.map((row) => {
                            const indentStyle = { paddingLeft: row.depth * 12 + 8 }
                            if (row.kind === 'dir') {
                              // 目录确认 = 其下所有可见文件都已确认（无可见文件则视为未确认）。
                              const isConfirmed
                                = row.descendantFiles.length > 0
                                  && row.descendantFiles.every(p => confirmed.has(p))
                              return (
                                // 目录行：点击切换折叠态；左侧箭头随折叠态翻转，path 作为唯一 key。
                                <li
                                  key={row.path}
                                  onMouseEnter={() => setHoveredPath(row.path)}
                                  onMouseLeave={() => setHoveredPath(p => (p === row.path ? null : p))}
                                  onClick={() => setCollapsed((prev) => {
                                    const n = new Set(prev)
                                    n.has(row.path) ? n.delete(row.path) : n.add(row.path)
                                    return n
                                  })}
                                  className={`group flex cursor-pointer items-center gap-1.5 py-0.5 pr-2 text-xs text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-list-hoverBackground)] ${
                                    isConfirmed ? 'opacity-60' : ''
                                  }`}
                                  style={indentStyle}
                                >
                                  {row.collapsed
                                    ? <ChevronRight className="size-3.5 shrink-0" />
                                    : <ChevronDown className="size-3.5 shrink-0" />}
                                  <Folder
                                    className="size-3.5 shrink-0"
                                    style={{ color: 'var(--vscode-descriptionForeground)' }}
                                  />
                                  <span className="min-w-0 truncate">{row.name}</span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      const next = isConfirmed
                                        ? [...confirmed].filter(p => !row.descendantFiles.includes(p))
                                        : [...new Set([...confirmed, ...row.descendantFiles])]
                                      setConfirmed(selectedSha, next)
                                    }}
                                    title={isConfirmed ? '已确认，点击取消' : '标记为已确认'}
                                    className="shrink-0 transition-opacity"
                                    style={{
                                      opacity: isConfirmed || hoveredPath === row.path ? 1 : 0,
                                      color: isConfirmed
                                        ? 'var(--vscode-gitDecoration-addedResourceForeground)'
                                        : 'var(--vscode-descriptionForeground)',
                                    }}
                                  >
                                    <Check className="size-3.5" />
                                  </button>
                                </li>
                              )
                            }
                            const isConfirmed = confirmed.has(row.path)
                            return (
                              // 文件行：点击触发 diff，title 用完整路径。
                              <li
                                key={row.path}
                                onMouseEnter={() => setHoveredPath(row.path)}
                                onMouseLeave={() => setHoveredPath(p => (p === row.path ? null : p))}
                                onClick={() => openDiff(selectedSha, selectedParentSha, row.path, row.status)}
                                title={`${row.status} · ${row.path}`}
                                className={`group flex cursor-pointer items-center gap-2 py-0.5 pr-2 hover:bg-[var(--vscode-list-hoverBackground)] ${
                                  isConfirmed ? 'opacity-60' : ''
                                }`}
                                style={indentStyle}
                              >
                                <span
                                  className="w-4 shrink-0 text-center font-mono text-xs font-semibold"
                                  style={{ color: statusColorVar(row.status) }}
                                >
                                  {statusBadge(row.status)}
                                </span>
                                <span className="min-w-0 truncate text-xs">{row.name}</span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const next = isConfirmed
                                      ? [...confirmed].filter(p => p !== row.path)
                                      : [...confirmed, row.path]
                                    setConfirmed(selectedSha, next)
                                  }}
                                  title={isConfirmed ? '已确认，点击取消' : '标记为已确认'}
                                  className="shrink-0 transition-opacity"
                                  style={{
                                    opacity: isConfirmed || hoveredPath === row.path ? 1 : 0,
                                    color: isConfirmed
                                      ? 'var(--vscode-gitDecoration-addedResourceForeground)'
                                      : 'var(--vscode-descriptionForeground)',
                                  }}
                                >
                                  <Check className="size-3.5" />
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      )}
        </div>
      </div>
    </div>
  )
}
