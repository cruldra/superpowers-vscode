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

import type { Issue } from '../types'
import { Folder } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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

/** 拍平后的可渲染行：目录行只带层级与（合并后的）目录名；文件行额外带完整路径与状态。 */
type TreeRow
  = | { kind: 'dir', name: string, depth: number }
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
 * 把 `{ path, status }[]` 构建成目录树并 DFS 拍平成行列表。
 *
 * - 路径按 `/` 切分，最后一段是文件、其余是目录层级。
 * - 合并单子目录链（VS Code "compact folders" 风格）：目录只有 1 个子目录且无文件时，
 *   两级目录名用 `/` 连接成一行，递归直到分叉或遇到文件。
 * - 每层先目录后文件，各自按 `localeCompare` 升序，DFS 顺序输出，`depth` 从 0 起。
 */
function buildFileTreeRows(files: ReadonlyArray<{ path: string, status: string }>): TreeRow[] {
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

  const rows: TreeRow[] = []
  const emit = (node: DirNode, depth: number) => {
    const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))
    for (const name of dirNames) {
      // 合并单子目录链：沿途只要恰好 1 个子目录且本级无文件，就把目录名拼起来。
      let label = name
      let cur = node.dirs.get(name)!
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        const [childName, childNode] = [...cur.dirs.entries()][0]
        label += `/${childName}`
        cur = childNode
      }
      rows.push({ kind: 'dir', name: label, depth })
      emit(cur, depth + 1)
    }
    const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name))
    for (const f of sortedFiles)
      rows.push({ kind: 'file', name: f.name, depth, path: f.path, status: f.status })
  }
  emit(root, 0)
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
    getFiles,
    openDiff,
  } = usePrCommits(issueNumber)

  const [selectedSha, setSelectedSha] = useState<string | undefined>(undefined)

  // 切工单时清掉选中态（hook 已清缓存，这里只管 UI 选中）。
  useEffect(() => {
    setSelectedSha(undefined)
  }, [issueNumber])

  // 选中提交且尚无文件缓存 → 拉一次文件清单。
  useEffect(() => {
    if (selectedSha && !(selectedSha in filesBySha))
      getFiles(selectedSha)
  }, [selectedSha, filesBySha, getFiles])

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

  // 过滤掉 tests/ 后构树拍平；selectedFiles 还没加载（undefined）时给空列表。
  const fileTreeRows = useMemo(
    () => buildFileTreeRows((selectedFiles ?? []).filter(f => !isIgnoredPath(f.path))),
    [selectedFiles],
  )

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
                    <ul className="flex flex-col">
                      {commits.map(c => (
                        <li
                          key={c.sha}
                          onClick={() => setSelectedSha(c.sha)}
                          className={`flex cursor-pointer flex-col gap-0.5 border-b border-[var(--vscode-panel-border)] px-2 py-1.5 ${
                            selectedSha === c.sha
                              ? 'bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]'
                              : 'hover:bg-[var(--vscode-list-hoverBackground)]'
                          }`}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="shrink-0 font-mono text-[10px] text-[var(--vscode-descriptionForeground)]">
                              {c.sha.slice(0, 7)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-xs" title={c.message}>
                              {c.message}
                            </span>
                          </div>
                          <div className="truncate text-[10px] text-[var(--vscode-descriptionForeground)]">
                            {[c.authorName, formatDate(c.date)].filter(Boolean).join(' · ')}
                          </div>
                        </li>
                      ))}
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
                              return (
                                // 目录行：仅展示层级，不可点击。
                                <li
                                  key={`d:${row.depth}:${row.name}`}
                                  className="flex items-center gap-1.5 py-0.5 pr-2 text-xs text-[var(--vscode-descriptionForeground)]"
                                  style={indentStyle}
                                >
                                  <Folder
                                    className="size-3.5 shrink-0"
                                    style={{ color: 'var(--vscode-descriptionForeground)' }}
                                  />
                                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                                </li>
                              )
                            }
                            return (
                              // 文件行：点击触发 diff，title 用完整路径。
                              <li
                                key={row.path}
                                onClick={() => openDiff(selectedSha, selectedParentSha, row.path, row.status)}
                                title={`${row.status} · ${row.path}`}
                                className="flex cursor-pointer items-center gap-2 py-0.5 pr-2 hover:bg-[var(--vscode-list-hoverBackground)]"
                                style={indentStyle}
                              >
                                <span
                                  className="w-4 shrink-0 text-center font-mono text-xs font-semibold"
                                  style={{ color: statusColorVar(row.status) }}
                                >
                                  {statusBadge(row.status)}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-xs">{row.name}</span>
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
