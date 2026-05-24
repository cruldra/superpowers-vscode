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

type GroupKey = 'auth' | 'network' | 'prompts' | 'hooks'

interface SubmitValues {
  host: string
  token: string
  webhookPort: number
  brainstormPrompt: string
  implementPlanPrompt: string
  autoReview: boolean
  reviewPrompt: string
  devBranch: string
  autoBuildBranch: string
  worktreePostCreateScript: string
  worktreePreRemoveScript: string
  implTabPreCreateScript: string
  implTabPostCloseScript: string
}

export interface SettingsModalProps {
  open: boolean
  host: string
  errorMessage?: string
  canCancel?: boolean
  initialTokenSaved: boolean
  initialWebhookPort: number
  initialBrainstormPrompt: string
  initialImplementPlanPrompt: string
  initialAutoReview: boolean
  initialReviewPrompt: string
  initialDevBranch: string
  initialAutoBuildBranch: string
  initialWorktreePostCreateScript: string
  initialWorktreePreRemoveScript: string
  initialImplTabPreCreateScript: string
  initialImplTabPostCloseScript: string
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
  { key: 'hooks', label: '钩子' },
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
  initialTokenSaved,
  initialWebhookPort,
  initialBrainstormPrompt,
  initialImplementPlanPrompt,
  initialAutoReview,
  initialReviewPrompt,
  initialDevBranch,
  initialAutoBuildBranch,
  initialWorktreePostCreateScript,
  initialWorktreePreRemoveScript,
  initialImplTabPreCreateScript,
  initialImplTabPostCloseScript,
  onSubmit,
  onCancel,
}: SettingsModalProps): ReactElement | null {
  const [activeGroup, setActiveGroup] = useState<GroupKey>('auth')
  const [host, setHost] = useState(initialHost)
  const [token, setToken] = useState('')
  const [webhookPort, setWebhookPort] = useState<string>(String(initialWebhookPort))
  const [brainstormPrompt, setBrainstormPrompt] = useState(initialBrainstormPrompt)
  const [implementPlanPrompt, setImplementPlanPrompt] = useState(initialImplementPlanPrompt)
  const [autoReview, setAutoReview] = useState(initialAutoReview)
  const [reviewPrompt, setReviewPrompt] = useState(initialReviewPrompt)
  const [devBranch, setDevBranch] = useState(initialDevBranch)
  const [autoBuildBranch, setAutoBuildBranch] = useState(initialAutoBuildBranch)
  const [worktreePostCreateScript, setWorktreePostCreateScript] = useState(initialWorktreePostCreateScript)
  const [worktreePreRemoveScript, setWorktreePreRemoveScript] = useState(initialWorktreePreRemoveScript)
  const [implTabPreCreateScript, setImplTabPreCreateScript] = useState(initialImplTabPreCreateScript)
  const [implTabPostCloseScript, setImplTabPostCloseScript] = useState(initialImplTabPostCloseScript)
  const [errors, setErrors] = useState<Partial<Record<ErrorKey, string>>>({})

  // Reset local state whenever the modal opens with fresh server values.
  // We intentionally don't depend on initialBrainstormPrompt/initialImplementPlanPrompt
  // to mid-edit; this effect just primes form state on each (re)open.
  useEffect(() => {
    if (!open)
      return
    setActiveGroup('auth')
    setHost(initialHost)
    setToken('')
    setWebhookPort(String(initialWebhookPort))
    setBrainstormPrompt(initialBrainstormPrompt)
    setImplementPlanPrompt(initialImplementPlanPrompt)
    setAutoReview(initialAutoReview)
    setReviewPrompt(initialReviewPrompt)
    setDevBranch(initialDevBranch)
    setAutoBuildBranch(initialAutoBuildBranch)
    setWorktreePostCreateScript(initialWorktreePostCreateScript)
    setWorktreePreRemoveScript(initialWorktreePreRemoveScript)
    setImplTabPreCreateScript(initialImplTabPreCreateScript)
    setImplTabPostCloseScript(initialImplTabPostCloseScript)
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
    // When a token is already saved server-side, leaving the field blank
    // means "keep the existing token" — don't flag it as an error. Only
    // require a new token when nothing is saved yet.
    if (!trimmedToken && !initialTokenSaved)
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
      // Pass raw token (may be empty string when keeping existing). The
      // extension side detects empty + existing-saved as "preserve".
      token: trimmedToken,
      webhookPort: portNum,
      brainstormPrompt,
      implementPlanPrompt,
      autoReview,
      reviewPrompt,
      devBranch: devBranch.trim(),
      autoBuildBranch: autoBuildBranch.trim(),
      // 钩子路径保持原样 trim（前后空格无意义；空串 = 用默认 .spx/*.sh）
      worktreePostCreateScript: worktreePostCreateScript.trim(),
      worktreePreRemoveScript: worktreePreRemoveScript.trim(),
      implTabPreCreateScript: implTabPreCreateScript.trim(),
      implTabPostCloseScript: implTabPostCloseScript.trim(),
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
                      {initialTokenSaved && (
                        <>
                          <br />
                          已保存，留空则保留
                        </>
                      )}
                    </>
                  )}
                >
                  <input
                    type="password"
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    placeholder={initialTokenSaved ? '••••••••' : '例如 1a2b3c4d…'}
                    className={inputClass}
                  />
                </Field>

                <Field
                  label="开发分支"
                  hint={(
                    <>
                      日常推送的分支，留空默认
                      {' '}
                      <code>main</code>
                      。同步按钮把这条分支的最新提交快进到下面的构建分支。
                    </>
                  )}
                >
                  <input
                    type="text"
                    value={devBranch}
                    onChange={e => setDevBranch(e.target.value)}
                    placeholder="main"
                    className={inputClass}
                  />
                </Field>

                <Field
                  label="自动化构建分支"
                  hint={(
                    <>
                      gitea webhook → Jenkins 监听的分支。留空表示与开发分支相同，同步按钮会一直禁用。
                    </>
                  )}
                >
                  <input
                    type="text"
                    value={autoBuildBranch}
                    onChange={e => setAutoBuildBranch(e.target.value)}
                    placeholder="留空 = 与开发分支相同"
                    className={inputClass}
                  />
                </Field>
              </>
            )}

            {activeGroup === 'network' && (
              <>
                <Field
                  label="本地端口"
                  error={errors.webhookPort}
                  hint={(
                    <>
                      扩展 HTTP server 绑定的端口。在 gitea 仓库 Webhooks 配置里把目标 URL 指向
                      {' '}
                      <code>{'http://<你的本机/公网域名>:<此端口>/webhook'}</code>
                      ，事件需勾选：<b>工单</b>（issue opened/edited）、<b>合并请求</b>（PR opened/synchronize/closed）、<b>工单评论</b>（codex 审查回流）。
                    </>
                  )}
                >
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={webhookPort}
                    onChange={e => setWebhookPort(e.target.value)}
                    className={inputClass}
                  />
                </Field>

                <Field
                  label="开启自动审查"
                  hint="PR 创建后自动用 codex exec review 跑审查并把结果灌到实施会话终端"
                >
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={autoReview}
                      onChange={e => setAutoReview(e.target.checked)}
                    />
                    <span className="opacity-80">启用</span>
                  </label>
                </Field>
              </>
            )}

            {activeGroup === 'prompts' && (
              <>
                <Field
                  label="头脑风暴提示词"
                  hint={(
                    <>
                      可用占位符：
                      <code>{'{userRequest}'}</code>
                      、
                      <code>{'{nonce}'}</code>
                      。同时承担：建工单初始指令 + 会话内 spec/plan 路径写回 issue body 的持续约定。
                    </>
                  )}
                >
                  <textarea
                    rows={12}
                    value={brainstormPrompt}
                    onChange={e => setBrainstormPrompt(e.target.value)}
                    className={`${inputClass} resize-y font-mono`}
                    placeholder="头脑风暴 + 建工单 + 持续约定提示词"
                  />
                </Field>

                <Field
                  label="实施提示词"
                  hint={(
                    <>
                      可用占位符：
                      <code>{'{planFile}'}</code>
                      、
                      <code>{'{issueNumber}'}</code>
                    </>
                  )}
                >
                  <textarea
                    rows={8}
                    value={implementPlanPrompt}
                    onChange={e => setImplementPlanPrompt(e.target.value)}
                    className={`${inputClass} resize-y font-mono`}
                  />
                </Field>

                <Field
                  label="审查提示词"
                  hint={<>可用占位符：<code>{'{prNumber}'}</code></>}
                >
                  <textarea
                    rows={4}
                    value={reviewPrompt}
                    onChange={e => setReviewPrompt(e.target.value)}
                    className={`${inputClass} resize-y font-mono`}
                  />
                </Field>
              </>
            )}

            {activeGroup === 'hooks' && (
              <>
                <Field
                  label="worktree 创建后脚本"
                  hint={(
                    <>
                      工单进入"实施"后，
                      <code>git worktree add</code>
                      {' '}
                      成功立刻执行。留空 = 默认
                      {' '}
                      <code>.spx/worktree-post-create.sh</code>
                      ；文件不存在 = 静默跳过，不报错。
                      <br />
                      环境变量：
                      <code>WORKTREE_PATH</code>
                      、
                      <code>WORKSPACE_ROOT</code>
                      、
                      <code>BRANCH</code>
                      、
                      <code>ISSUE_NUMBER</code>
                      、
                      <code>MAIN_BRANCH</code>
                      。超时 30s。
                    </>
                  )}
                >
                  <input
                    type="text"
                    value={worktreePostCreateScript}
                    onChange={e => setWorktreePostCreateScript(e.target.value)}
                    placeholder=".spx/worktree-post-create.sh"
                    className={inputClass}
                  />
                </Field>

                <Field
                  label="worktree 删除前脚本"
                  hint={(
                    <>
                      工单关闭 / 手动删 worktree 时，
                      <code>git worktree remove</code>
                      {' '}
                      之前执行，便于关闭 IDE / 归档日志。留空 = 默认
                      {' '}
                      <code>.spx/worktree-pre-remove.sh</code>
                      。失败不阻塞删除。
                    </>
                  )}
                >
                  <input
                    type="text"
                    value={worktreePreRemoveScript}
                    onChange={e => setWorktreePreRemoveScript(e.target.value)}
                    placeholder=".spx/worktree-pre-remove.sh"
                    className={inputClass}
                  />
                </Field>

                <Field
                  label="实施 tab 创建前脚本"
                  hint={(
                    <>
                      实施 cc tab 创建之前执行；常用于启动 IDE（pycharm 等）。
                      留空 = 默认
                      {' '}
                      <code>.spx/impl-tab-pre-create.sh</code>
                      。tab 复用 fast path 不触发。
                    </>
                  )}
                >
                  <input
                    type="text"
                    value={implTabPreCreateScript}
                    onChange={e => setImplTabPreCreateScript(e.target.value)}
                    placeholder=".spx/impl-tab-pre-create.sh"
                    className={inputClass}
                  />
                </Field>

                <Field
                  label="实施 tab 关闭后脚本"
                  hint={(
                    <>
                      实施 cc tab 被关闭后执行；常用于关闭 pre-create 启动的 IDE 进程。
                      留空 = 默认
                      {' '}
                      <code>.spx/impl-tab-post-close.sh</code>
                      。
                    </>
                  )}
                >
                  <input
                    type="text"
                    value={implTabPostCloseScript}
                    onChange={e => setImplTabPostCloseScript(e.target.value)}
                    placeholder=".spx/impl-tab-post-close.sh"
                    className={inputClass}
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
