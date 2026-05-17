import { useState } from 'react'

interface SubmitValues {
  host: string
  token: string
  webhookPort: number
  webhookHost: string
  createIssuePrompt: string
  implementPlanPrompt: string
}

interface SetupFormProps {
  host: string
  errorMessage?: string
  canCancel?: boolean
  initialWebhookPort: number
  initialWebhookHost: string
  initialCreateIssuePrompt: string
  initialImplementPlanPrompt: string
  onSubmit: (values: SubmitValues) => void
  /** When provided, a 取消 button is rendered next to 保存. Use this only when
   * the user got here intentionally (e.g. clicked the gear) — for first-time
   * setup or after a token rejection there is no meaningful state to return to. */
  onCancel?: () => void
}

const inputClass = 'w-full rounded border border-[var(--vscode-input-border,transparent)] bg-[var(--vscode-input-background)] px-2 py-1 text-xs text-[var(--vscode-input-foreground)] outline-none focus:border-[var(--vscode-focusBorder)]'

interface FieldProps {
  label: string
  hint?: React.ReactNode
  error?: string
  children: React.ReactNode
}

function Field({ label, hint, error, children }: FieldProps) {
  return (
    <label className="mb-3 block text-xs">
      <span className="mb-1 block opacity-80">{label}</span>
      {children}
      {hint && (
        <span className="mt-1 block text-[10px] opacity-60">{hint}</span>
      )}
      {error && (
        <span className="mt-1 block text-[10px] text-state-red">{error}</span>
      )}
    </label>
  )
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="mb-2 mt-4 border-b border-[var(--vscode-panel-border)] pb-1 text-sm font-medium opacity-90">
      {title}
    </h3>
  )
}

export function SetupForm({
  host: initialHost,
  errorMessage,
  canCancel,
  initialWebhookPort,
  initialWebhookHost,
  initialCreateIssuePrompt,
  initialImplementPlanPrompt,
  onSubmit,
  onCancel,
}: SetupFormProps) {
  const [host, setHost] = useState(initialHost)
  const [token, setToken] = useState('')
  const [webhookPort, setWebhookPort] = useState<string>(String(initialWebhookPort))
  const [webhookHost, setWebhookHost] = useState(initialWebhookHost)
  const [createIssuePrompt, setCreateIssuePrompt] = useState(initialCreateIssuePrompt)
  const [implementPlanPrompt, setImplementPlanPrompt] = useState(initialImplementPlanPrompt)
  const [errors, setErrors] = useState<Partial<Record<'host' | 'token' | 'webhookPort', string>>>({})

  const trimmedHost = host.trim()
  const tokenPageUrl = trimmedHost
    ? `https://${trimmedHost}/user/settings/applications`
    : ''

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault()
    const nextErrors: Partial<Record<'host' | 'token' | 'webhookPort', string>> = {}
    const trimmedToken = token.trim()
    if (!trimmedHost)
      nextErrors.host = 'Host 不能为空'
    if (!trimmedToken)
      nextErrors.token = 'Token 不能为空'
    const portNum = Number.parseInt(webhookPort, 10)
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)
      nextErrors.webhookPort = '端口必须是 1–65535 的整数'

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      return
    }
    setErrors({})
    onSubmit({
      host: trimmedHost,
      token: trimmedToken,
      webhookPort: portNum,
      webhookHost: webhookHost.trim(),
      createIssuePrompt,
      implementPlanPrompt,
    })
  }

  return (
    <div className="flex h-full w-full justify-center overflow-y-auto p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-xl rounded-md border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-6 shadow-sm"
      >
        <h2 className="mb-2 text-base font-medium">Superpowers 设置</h2>

        {errorMessage && (
          <div className="mb-4 rounded border border-state-red/60 bg-state-red/10 px-3 py-2 text-xs text-state-red">
            {errorMessage}
          </div>
        )}

        <SectionHeader title="认证" />

        <Field label="Gitea Host" error={errors.host}>
          <input
            type="text"
            value={host}
            onChange={e => setHost(e.target.value)}
            placeholder="gitea.example.com"
            className={inputClass}
          />
        </Field>

        <Field
          label="Personal Access Token"
          error={errors.token}
          hint={(
            <>
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
            </>
          )}
        >
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="例如 1a2b3c4d…"
            className={inputClass}
          />
        </Field>

        <SectionHeader title="网络" />

        <Field label="Webhook 端口" error={errors.webhookPort}>
          <input
            type="number"
            min={1}
            max={65535}
            value={webhookPort}
            onChange={e => setWebhookPort(e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Webhook 主机 IP">
          <input
            type="text"
            value={webhookHost}
            onChange={e => setWebhookHost(e.target.value)}
            placeholder="留空自动检测"
            className={inputClass}
          />
        </Field>

        <SectionHeader title="提示词" />

        <Field
          label="建工单提示词"
          hint={<>可用占位符：<code>{'{userRequest}'}</code></>}
        >
          <textarea
            rows={4}
            value={createIssuePrompt}
            onChange={e => setCreateIssuePrompt(e.target.value)}
            className={`${inputClass} resize-y font-mono`}
          />
        </Field>

        <Field
          label="实施提示词"
          hint={<>可用占位符：<code>{'{planFile}'}</code></>}
        >
          <textarea
            rows={4}
            value={implementPlanPrompt}
            onChange={e => setImplementPlanPrompt(e.target.value)}
            className={`${inputClass} resize-y font-mono`}
          />
        </Field>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="submit"
            className="rounded bg-[var(--vscode-button-background)] px-3 py-1.5 text-xs text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
          >
            保存
          </button>
          {canCancel && onCancel && (
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
