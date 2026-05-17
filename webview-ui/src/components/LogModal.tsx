/**
 * In-webview modal for browsing extension logs (forwarded from the host
 * Logger over the panel message bridge).
 *
 * Behaviour:
 *  - Backdrop click is intentionally a no-op (matches the new-issue modal).
 *  - ESC key closes the modal.
 *  - Entries render newest-at-bottom. Auto-scrolls only when the user is
 *    already pinned near the bottom — preserves position when they have
 *    scrolled up to inspect.
 *  - "复制全部" dumps a plain-text rendering to the clipboard.
 */

import type { ReactElement } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Copy, Trash2, X } from 'lucide-react'
import type { LogEntry } from '../lib/messages'

export interface LogModalProps {
  open: boolean
  entries: LogEntry[]
  onClose: () => void
  onClear: () => void
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function levelClass(level: LogEntry['level']): string {
  if (level === 'error')
    return 'text-[var(--vscode-errorForeground,#f48771)]'
  if (level === 'warn')
    return 'text-yellow-400'
  return 'opacity-80'
}

function formatPlain(entries: LogEntry[]): string {
  return entries
    .map((e) => {
      const head = `${formatTime(e.ts)} [${e.level.toUpperCase()}] [${e.source}] ${e.message}`
      return e.details ? `${head}\n    ${e.details}` : head
    })
    .join('\n')
}

export function LogModal({ open, entries, onClose, onClear }: LogModalProps): ReactElement | null {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const [copied, setCopied] = useState(false)

  // ESC to close.
  useEffect(() => {
    if (!open)
      return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Track whether the user is currently pinned to the bottom (within ~50px).
  useEffect(() => {
    const el = scrollRef.current
    if (!el)
      return
    function onScroll(): void {
      if (!el)
        return
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      pinnedRef.current = distance < 50
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [open])

  // Auto-scroll only when the user is already near the bottom.
  useLayoutEffect(() => {
    if (!open)
      return
    const el = scrollRef.current
    if (!el)
      return
    if (pinnedRef.current)
      el.scrollTop = el.scrollHeight
  }, [entries.length, open])

  // Reset the "copied" flag whenever the modal opens.
  useEffect(() => {
    if (open)
      setCopied(false)
  }, [open])

  if (!open)
    return null

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(formatPlain(entries))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
    catch {
      // Clipboard might be unavailable in some VS Code webview contexts —
      // swallow silently, the user can still read logs on screen.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        className="relative flex h-[min(600px,80vh)] w-[min(900px,90vw)] flex-col rounded-md border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-[var(--vscode-panel-border)] px-4 py-2">
          <h2 className="text-sm font-medium">日志</h2>
          <span className="text-xs opacity-60">
            {entries.length}
            {' 条'}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="ml-auto grid size-6 place-items-center rounded opacity-60 hover:opacity-100"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs"
        >
          {entries.length === 0
            ? (
                <div className="flex h-full items-center justify-center text-xs opacity-50">
                  暂无日志
                </div>
              )
            : (
                entries.map((e, idx) => (
                  // ts is monotonic enough at ms resolution for our cap of 500
                  // entries; fall back to idx if two collide.
                  <div key={`${e.ts}-${idx}`} className="whitespace-pre-wrap py-0.5 leading-snug">
                    <div>
                      <span className="opacity-60">{formatTime(e.ts)}</span>
                      {' '}
                      <span className={levelClass(e.level)}>
                        [
                        {e.level.toUpperCase()}
                        ]
                      </span>
                      {' '}
                      <span className="opacity-70">
                        [
                        {e.source}
                        ]
                      </span>
                      {' '}
                      <span>{e.message}</span>
                    </div>
                    {e.details && (
                      <div className="pl-6 opacity-60">{e.details}</div>
                    )}
                  </div>
                ))
              )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-[var(--vscode-panel-border)] px-4 py-2">
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1.5 rounded border border-[var(--vscode-panel-border)] px-2 py-1 text-xs hover:border-[var(--vscode-focusBorder)]"
          >
            <Trash2 className="size-4" />
            清空
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded border border-[var(--vscode-panel-border)] px-2 py-1 text-xs hover:border-[var(--vscode-focusBorder)]"
          >
            <Copy className="size-4" />
            复制全部
          </button>
          {copied && (
            <span className="text-xs opacity-70">已复制</span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex items-center gap-1.5 rounded bg-[var(--vscode-button-background)] px-3 py-1 text-xs text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
