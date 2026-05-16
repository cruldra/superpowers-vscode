import { useEffect, useRef, useState } from 'react'

interface Props {
  open: boolean
  onCancel: () => void
  onSubmit: (userRequest: string) => void
}

export function NewIssueModal({ open, onCancel, onSubmit }: Props) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) {
      setValue('')
      return
    }
    const t = setTimeout(() => textareaRef.current?.focus(), 0)
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape')
        onCancel()
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, onCancel])

  if (!open)
    return null

  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0

  function handleSubmit(): void {
    if (!canSubmit)
      return
    onSubmit(trimmed)
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
        className="w-full max-w-xl rounded-md border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-4 shadow-xl"
      >
        <h2 className="mb-3 text-base font-medium">新建工单</h2>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="用 Markdown 描述你的需求…"
          className="mb-3 h-72 w-full resize-none rounded border border-[var(--vscode-input-border,transparent)] bg-[var(--vscode-input-background)] p-2 font-mono text-xs text-[var(--vscode-input-foreground)] outline-none focus:border-[var(--vscode-focusBorder)]"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-[var(--vscode-button-border,transparent)] bg-[var(--vscode-button-secondaryBackground)] px-3 py-1.5 text-xs text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="rounded bg-[var(--vscode-button-background)] px-3 py-1.5 text-xs text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  )
}
