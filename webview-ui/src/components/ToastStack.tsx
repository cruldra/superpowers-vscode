import { useEffect } from 'react'
import { CheckCircle2, Loader2, X, XCircle } from 'lucide-react'

export interface ToastItem {
  id: string
  level: 'info' | 'success' | 'error'
  message: string
  spinner?: boolean
  link?: { label: string, url: string }
  dismissOnTimer?: number
}

interface Props {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
  onOpenUrl: (url: string) => void
}

function levelClasses(level: ToastItem['level']): string {
  switch (level) {
    case 'success':
      return 'border-state-green/60 bg-state-green/10'
    case 'error':
      return 'border-state-red/60 bg-state-red/10'
    default:
      return 'border-state-blue/60 bg-state-blue/10'
  }
}

function LevelIcon({ toast }: { toast: ToastItem }) {
  if (toast.spinner)
    return <Loader2 className="size-3.5 shrink-0 animate-spin" />
  if (toast.level === 'success')
    return <CheckCircle2 className="size-3.5 shrink-0 text-state-green" />
  if (toast.level === 'error')
    return <XCircle className="size-3.5 shrink-0 text-state-red" />
  return null
}

function ToastRow({
  toast,
  onDismiss,
  onOpenUrl,
}: {
  toast: ToastItem
  onDismiss: (id: string) => void
  onOpenUrl: (url: string) => void
}) {
  useEffect(() => {
    if (!toast.dismissOnTimer)
      return
    const t = setTimeout(() => onDismiss(toast.id), toast.dismissOnTimer)
    return () => clearTimeout(t)
  }, [toast.id, toast.dismissOnTimer, onDismiss])

  return (
    <div
      className={`flex min-w-[260px] max-w-sm items-start gap-2 rounded border px-3 py-2 text-xs shadow-md ${levelClasses(toast.level)}`}
    >
      <LevelIcon toast={toast} />
      <div className="flex-1 break-words text-[var(--vscode-foreground)] opacity-90">
        {toast.message}
        {toast.link && (
          <>
            {' '}
            <button
              type="button"
              onClick={() => onOpenUrl(toast.link!.url)}
              className="text-[var(--vscode-textLink-foreground)] underline"
            >
              {toast.link.label}
            </button>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 opacity-60 hover:opacity-100"
        aria-label="关闭"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

export function ToastStack({ toasts, onDismiss, onOpenUrl }: Props) {
  if (toasts.length === 0)
    return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(t => (
        <div key={t.id} className="pointer-events-auto">
          <ToastRow toast={t} onDismiss={onDismiss} onOpenUrl={onOpenUrl} />
        </div>
      ))}
    </div>
  )
}
