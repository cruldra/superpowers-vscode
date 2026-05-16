import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

export interface PastedImage {
  mediaType: string
  /** raw base64 (no `data:...;base64,` prefix) — what we send to claude */
  base64: string
  /** `data:...;base64,...` form for `<img src>` */
  previewDataUrl: string
}

interface PastedImageWithId extends PastedImage {
  id: string
}

interface Props {
  open: boolean
  onCancel: () => void
  onSubmit: (userRequest: string, images: PastedImage[]) => void
}

function readClipboardImage(file: File): Promise<PastedImage | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        resolve(null)
        return
      }
      // result shape: "data:image/png;base64,iVBORw0K..."
      const commaIdx = result.indexOf(',')
      const header = commaIdx > 0 ? result.slice(0, commaIdx) : ''
      const base64 = commaIdx > 0 ? result.slice(commaIdx + 1) : ''
      const mediaMatch = header.match(/^data:([^;]+);base64$/)
      const mediaType = mediaMatch ? mediaMatch[1] : file.type || 'image/png'
      resolve({ mediaType, base64, previewDataUrl: result })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

export function NewIssueModal({ open, onCancel, onSubmit }: Props) {
  const [value, setValue] = useState('')
  const [images, setImages] = useState<PastedImageWithId[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) {
      setValue('')
      setImages([])
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

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items)
      return
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f)
          files.push(f)
      }
    }
    if (files.length === 0)
      return
    // Intercept so the file binary doesn't end up pasted as garbled text.
    e.preventDefault()
    const parsed = await Promise.all(files.map(readClipboardImage))
    const ok = parsed.filter((p): p is PastedImage => p !== null)
    if (ok.length === 0)
      return
    setImages(prev => [
      ...prev,
      ...ok.map(img => ({ ...img, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })),
    ])
  }, [])

  function removeImage(id: string): void {
    setImages(prev => prev.filter(i => i.id !== id))
  }

  if (!open)
    return null

  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0 || images.length > 0

  function handleSubmit(): void {
    if (!canSubmit)
      return
    onSubmit(trimmed, images.map(({ mediaType, base64, previewDataUrl }) => ({ mediaType, base64, previewDataUrl })))
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
          onPaste={handlePaste}
          placeholder="用 Markdown 描述你的需求…（可 Ctrl+V 粘贴截图）"
          className="mb-2 h-72 w-full resize-none rounded border border-[var(--vscode-input-border,transparent)] bg-[var(--vscode-input-background)] p-2 font-mono text-xs text-[var(--vscode-input-foreground)] outline-none focus:border-[var(--vscode-focusBorder)]"
        />

        {images.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {images.map(img => (
              <div
                key={img.id}
                className="group relative h-16 w-16 overflow-hidden rounded border border-[var(--vscode-panel-border)]"
              >
                <img
                  src={img.previewDataUrl}
                  alt="pasted"
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  aria-label="移除"
                  className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="size-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}

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
