/**
 * Overlay modal for editing Superpowers settings. Sits on top of the kanban
 * without unmounting it — matches the LogModal / NewIssueModal pattern:
 *  - Backdrop click is a no-op (only ESC closes, and only when `canCancel`).
 *  - Two-column layout: vertical group rail on the left, fields on the right.
 *
 * Replaces the old full-screen `SetupForm.tsx`.
 */

import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

type GroupKey = 'auth' | 'network' | 'prompts'

interface SubmitValues {
  host: string
  token: string
  webhookPort: number
  webhookHost: string
  createIssuePrompt: string
  implementPlanPrompt: string
}

export interface SettingsModalProps {
  open: boolean
  host: string
  errorMessage?: string
  canCancel?: boolean
  initialWebhookPort: number
  initialWebhookHost: string
  initialCreateIssuePrompt: string
  initialImplementPlanPrompt: string
  onSubmit: (values: SubmitValues) => void
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

const GROUPS: Array<{ key: GroupKey, label: string }> = [
  { key: 'auth', label: '认证' },
  { key: 'network', label: '网络' },
  { key: 'prompts', label: '提示词' },
]

type ErrorKey = 'host' | 'token' | 'webhookPort'

/** Map a field name to the group it lives in, so we can auto-switch to the
 * first invalid field's group on save. */
const FIELD_TO_GROUP: Record<ErrorKey, GroupKey> = {
  host: 'auth',
  token: 'auth',
  webhookPort: 'network',
}

export function SettingsModal({
  open,
  host: initialHost,
  errorMessage,
  canCancel,
  initialWebhookPort,
  initialWebhookHost,
  initialCreateIssuePrompt,
  initialImplementPlanPrompt,
  onSubmit,
  onCancel,
}: SettingsModalProps): ReactElement | null {
  const [activeGroup, setActiveGroup] = useState<GroupKey>('auth')
  const [host, setHost] = useState(initialHost)
  const [token, setToken] = useState('')
  const [webhookPort, setWebhookPort] = useState<string>(String(initialWebhookPort))
  const [webhookHost, setWebhookHost] = useState(initialWebhookHost)
  const [createIssuePrompt, setCreateIssuePrompt] = useState(initialCreateIssuePrompt)
  const [implementPlanPrompt, setImplementPlanPrompt] = useState(initialImplementPlanPrompt)
  const [errors, setErrors] = useState<Partial<Record<ErrorKey, string>>>({})

  // Reset local state whenever the modal opens with fresh server values.
  // We intentionally don't depend on initialCreateIssuePrompt/initialImplementPlanPrompt
  // to mid-edit; this effect just primes form state on each (re)open.
  useEffect(() => {
    if (!open)
      return
    setActiveGroup('auth')
    setHost(initialHost)
    setToken('')
    setWebhookPort(String(initialWebhookPort))
    setWebhookHost(initialWebhookHost)
    setCreateIssuePrompt(initialCreateIssuePrompt)
    setImplementPlanPrompt(initialImplementPlanPrompt)
    setErrors({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ESC closes when allowed.
  useEffect(() => {
    if (!open)
      return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && canCancel && onCancel) {
        e.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, canCancel, onCancel])

  if (!open)
    return null

  const trimmedHost = host.trim()
  const tokenPageUrl = trimmedHost
    ? `https://${trimmedHost}/user/settings/applications`
    : ''

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault()
    const nextErrors: Partial<Record<ErrorKey, string>> = {}
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
      // Auto-jump to the group containing the first invalid field, so the
      // inline error is visible without the user hunting for it.
      const order: ErrorKey[] = ['host', 'token', 'webhookPort']
      for (const key of order) {
        if (nextErrors[key]) {
          setActiveGroup(FIELD_TO_GROUP[key])
          break
        }
      }
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        className="relative flex h-[min(600px,80vh)] w-[min(900px,90vw)] flex-col rounded-md border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-[var(--vscode-panel-border)] px-4 py-2">
          <h2 className="text-sm font-medium">设置</h2>
          {canCancel && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="关闭"
              className="ml-auto grid size-6 place-items-center rounded opacity-60 hover:opacity-100"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-row">
          {/* Left rail */}
          <div className="flex w-40 shrink-0 flex-col border-r border-[var(--vscode-panel-border)] py-2">
            {GROUPS.map((g) => {
              const active = g.key === activeGroup
              return (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => setActiveGroup(g.key)}
                  className={[
                    'px-3 py-1.5 text-left text-xs',
                    active
                      ? 'bg-white/10 text-[var(--vscode-foreground)]'
                      : 'opacity-80 hover:bg-white/5',
                  ].join(' ')}
                >
                  {g.label}
                </button>
              )
            })}
          </div>

          {/* Right pane */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {errorMessage && (
              <div className="mb-4 rounded border border-state-red/60 bg-state-red/10 px-3 py-2 text-xs text-state-red">
                {errorMessage}
              </div>
            )}

            {activeGroup === 'auth' && (
              <>
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
              </>
            )}

            {activeGroup === 'network' && (
              <>
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
              </>
            )}

            {activeGroup === 'prompts' && (
              <>
                <Field
                  label="建工单提示词"
                  hint={<>可用占位符：<code>{'{userRequest}'}</code></>}
                >
                  <textarea
                    rows={8}
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
                    rows={8}
                    value={implementPlanPrompt}
                    onChange={e => setImplementPlanPrompt(e.target.value)}
                    className={`${inputClass} resize-y font-mono`}
                  />
                </Field>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--vscode-panel-border)] p-3">
          {canCancel && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-[var(--vscode-button-border,transparent)] bg-[var(--vscode-button-secondaryBackground)] px-3 py-1.5 text-xs text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            >
              取消
            </button>
          )}
          <button
            type="submit"
            className="rounded bg-[var(--vscode-button-background)] px-3 py-1.5 text-xs text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
          >
            保存
          </button>
        </div>
      </form>
    </div>
  )
}
