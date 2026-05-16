import { useState } from 'react'

interface Props {
  host: string
  errorMessage?: string
  onSubmit: (host: string, token: string) => void
  /** When provided, a 取消 button is rendered next to 保存. Use this only when
   * the user got here intentionally (e.g. clicked the gear) — for first-time
   * setup or after a token rejection there is no meaningful state to return to. */
  onCancel?: () => void
}

export function SetupForm({ host: initialHost, errorMessage, onSubmit, onCancel }: Props) {
  const [host, setHost] = useState(initialHost)
  const [token, setToken] = useState('')

  const trimmedHost = host.trim()
  const trimmedToken = token.trim()
  const canSubmit = trimmedHost.length > 0 && trimmedToken.length > 0
  const tokenPageUrl = trimmedHost
    ? `https://${trimmedHost}/user/settings/applications`
    : ''

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault()
    if (!canSubmit)
      return
    onSubmit(trimmedHost, trimmedToken)
  }

  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-md border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-6 shadow-sm"
      >
        <h2 className="mb-4 text-base font-medium">连接到 Gitea</h2>

        {errorMessage && (
          <div className="mb-4 rounded border border-state-red/60 bg-state-red/10 px-3 py-2 text-xs text-state-red">
            {errorMessage}
          </div>
        )}

        <label className="mb-3 block text-xs">
          <span className="mb-1 block opacity-80">Gitea Host</span>
          <input
            type="text"
            value={host}
            onChange={e => setHost(e.target.value)}
            placeholder="gitea.example.com"
            className="w-full rounded border border-[var(--vscode-input-border,transparent)] bg-[var(--vscode-input-background)] px-2 py-1 text-xs text-[var(--vscode-input-foreground)] outline-none focus:border-[var(--vscode-focusBorder)]"
          />
        </label>

        <label className="mb-3 block text-xs">
          <span className="mb-1 block opacity-80">Personal Access Token</span>
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="例如 1a2b3c4d…"
            className="w-full rounded border border-[var(--vscode-input-border,transparent)] bg-[var(--vscode-input-background)] px-2 py-1 text-xs text-[var(--vscode-input-foreground)] outline-none focus:border-[var(--vscode-focusBorder)]"
          />
        </label>

        <p className="mb-4 text-xs opacity-70">
          在
          {' '}
          {tokenPageUrl
            ? (
                <a
                  href={tokenPageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--vscode-textLink-foreground)] underline"
                >
                  {tokenPageUrl}
                </a>
              )
            : <span className="opacity-60">填写 Host 后这里会显示生成 token 的链接</span>}
          {' '}
          生成一个 token
        </p>

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded bg-[var(--vscode-button-background)] px-3 py-1.5 text-xs text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            保存并加载
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-[var(--vscode-button-border,transparent)] bg-[var(--vscode-button-secondaryBackground)] px-3 py-1.5 text-xs text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            >
              取消
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
