/**
 * 「提交」tab（底部第四个）：浏览当前工单 PR 的提交 → 提交内文件 → 原生 diff。
 *
 * - 上半区：提交列表（sha 前 7 位 + 消息首行 + 作者 + 时间），单选高亮。
 * - 下半区：选中提交的文件清单，每行状态徽标（A/M/D/R 着色）+ 路径，点击触发
 *   `vscode.diff` 比较该文件在 parentSha → sha 之间的改动。
 *
 * 自带 usePrCommits hook，直接经 lib/vscode 收发消息，不依赖上层回调。
 */

import type { Issue } from '../types'
import { useEffect, useState } from 'react'
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
                  : (
                      <ul className="flex flex-col">
                        {selectedFiles.map(f => (
                          <li
                            key={f.path}
                            onClick={() => openDiff(selectedSha, selectedParentSha, f.path, f.status)}
                            title={`${f.status} · ${f.path}`}
                            className="flex cursor-pointer items-center gap-2 border-b border-[var(--vscode-panel-border)] px-2 py-1 hover:bg-[var(--vscode-list-hoverBackground)]"
                          >
                            <span
                              className="w-4 shrink-0 text-center font-mono text-xs font-semibold"
                              style={{ color: statusColorVar(f.status) }}
                            >
                              {statusBadge(f.status)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-xs">{f.path}</span>
                          </li>
                        ))}
                      </ul>
                    )}
        </div>
      </div>
    </div>
  )
}
