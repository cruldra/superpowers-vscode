import type {
  ExtensionContext,
  Terminal,
  TerminalEditorLocationOptions,
  WebviewPanel,
} from 'vscode'
import type { Issue } from '../gitea/types'
import type { ExtensionToWebview, WebviewToExtension } from './messages'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { env, TabInputTerminal, ThemeColor, Uri, ViewColumn, window, workspace } from 'vscode'
import { deleteToken, getToken } from '../auth/secrets'
import { detectRepo } from '../git/remote'
import type { HookContext } from '../git/worktreeHooks'
import {
  GiteaApiError,
  postIssueComment,
} from '../gitea/api'
import { loadIssues } from '../gitea/issueLoader'
import type { IssueRef } from '../issues/stateRouter'
import { closeIssueByRef, mergeIssueState, readIssueState } from '../issues/stateRouter'
import { logger } from '../logging/logger'
import { getSettings } from '../settings/store'
import { webhookCoordinator } from '../webhook/coordinator'
import { loadYouTrackIssues } from '../youtrack/issueLoader'
import * as issues from './handlers/issues'
import * as managedSessions from './handlers/managedSessions'
import * as prCommits from './handlers/prCommits'
import * as sessions from './handlers/sessions'
import * as settings from './handlers/settings'
import * as terminals from './handlers/terminals'
import * as toolbar from './handlers/toolbar'
import * as worktree from './handlers/worktree'
import * as youtrackIssues from './handlers/youtrackIssues'
import { PALETTE, resolveIssueColor, themeColorIdToIconUri } from './issueColor'

export const DEFAULT_PROFILE_PATH = '/home/cruldra/Sources/cruldra-profile/claude-config/profiles/offical.json'

/** PR 变更摘要等后台内容生成任务用的 profile：DeepSeek（自带 token + base_url，
 * headless 稳定，不依赖订阅 OAuth，避免 403 Request not allowed）。 */
export const PR_DIFF_SUMMARY_PROFILE_PATH = '/home/cruldra/Sources/cruldra-profile/claude-config/profiles/deepseek.json'

export class KanbanWebviewPanel {
  static readonly viewType = 'superpowers.kanbanPanel'

  private static current: KanbanWebviewPanel | undefined

  private readonly panel: WebviewPanel
  private readonly disposables: { dispose: () => void }[] = []
  /**
   * `issue.number` → its source identity, rebuilt on every `loadAndPush`.
   * Lets the workflow handlers (which only receive a number from the webview)
   * route state persistence to the right tracker. YouTrack numbers are
   * synthetic and collision-free (see `youtrack/issueLoader`), so the number
   * alone is an unambiguous key.
   */
  private issueRefs = new Map<number, { source: 'gitea' | 'youtrack', externalId?: string }>()
  /**
   * sessionId → its dedicated terminal in the editor area. Populated when the
   * user presses Enter on a card; entry is removed when the terminal is
   * closed (so a re-resume spawns a fresh tab). Letting selection changes
   * `terminal.show(true)` an existing entry is what gives the user "switch
   * card → switch terminal tab" behaviour.
   */
  // internal: handler 模块访问
  readonly terminals = new Map<string, Terminal>()
  /**
   * issueNumber → its implementation cc terminal (the one spawned by
   * `handleImplement`). Used by the auto-review flow to `sendText` review
   * feedback back into the running implementation conversation. Kept
   * separate from `terminals` because at spawn time we don't yet have a
   * sessionId, and even later the impl session id lives in a different
   * field of the state JSON.
   */
  // internal: handler 模块访问
  readonly implTerminals = new Map<number, Terminal>()

  /**
   * codex review terminals keyed by review session id (codex thread_id).
   * Lets `handleResumeReviewSession` reuse an existing tab instead of
   * spawning a fresh one on every click.
   */
  // internal: handler 模块访问
  readonly reviewTerminals = new Map<string, Terminal>()

  /**
   * 会话管理 tab 里 resume / create 出来的 cc 终端，keyed by managed sessionId。
   * 让列表行知道某会话的 tab 是否正开着（tabOpen），并支持「关闭 tab」与删除时
   * dispose 终端。onDidCloseTerminal 命中后按值反查删除条目。
   */
  // internal: handler 模块访问
  readonly managedTerminals = new Map<string, Terminal>()

  /**
   * Tracks in-flight "create issue" runs keyed by the nonce embedded in the
   * cc prompt. Populated synchronously in `handleIssueCreate` before the
   * terminal is shown; the session watcher fills in `sessionId` once cc
   * starts writing its jsonl. The webhook coordinator drains entries via
   * `takePendingIssueCreation` when the corresponding `issues opened`
   * payload arrives, then merges the column / sessionId / profilePath /
   * color into the state-JSON comment and cleans up the inbox tmpdir.
   */
  // internal: handler 模块访问
  readonly pendingIssueCreations = new Map<string, {
    sessionId?: string
    profilePath?: string
    /** Palette id (e.g. `terminal.ansiBlue`) — same shape stored in state JSON. */
    color: string
    workspaceRoot: string
    inboxDir: string
    terminalName: string
    /** The brainstorm terminal created synchronously in `handleIssueCreate`.
     * Stored here so `linkPendingTerminalToIssue` can promote it into
     * `newIssueTerminals` once the webhook tells us the issueNumber. */
    terminal: Terminal
    createdAt: number
  }>()

  /**
   * issueNumber → the brainstorm terminal originally created via the new-issue
   * flow (its name is `issue-new-{shortNonce}-规划`, NOT `issue-${N}-规划`).
   * Populated by `linkPendingTerminalToIssue` after the webhook coordinator
   * matches the nonce in `issue.body` to an entry in `pendingIssueCreations`.
   *
   * VS Code's Terminal API has no rename method, so we can't fix the tab name
   * after the fact. Instead we keep this side-map so `handleSessionFocus`
   * (card → terminal) and `handleActiveTerminalChanged` (terminal → card) can
   * still find the tab and round-trip selection.
   */
  // internal: handler 模块访问
  readonly newIssueTerminals = new Map<number, Terminal>()

  /**
   * Terminal → 它属于哪个 issue 的哪类会话 tab。
   *
   * 仅用于详情面板"会话 id 行右侧的关闭按钮"特性：在四个 issue-aware Map
   * (`terminals` / `implTerminals` / `reviewTerminals` / `newIssueTerminals`)
   * 任意一项 set 时同步登记，`onDidCloseTerminal` 命中后反查这里再推
   * `issue/patch { brainstorm|implement|reviewTabOpen: false }` 给 webview。
   *
   * 用普通 Map 而不是 WeakMap：onDidCloseTerminal 需要把 closed Terminal
   * 作为 key 查；WeakMap 不暴露 has/get 之外的迭代 API 但其实 get 就够用，
   * 不过 VS Code 文档里 Terminal 实例生命周期与 Map 中的引用不冲突，普通
   * Map 更易于 inspect / debug。条目数顶天就是当前活跃 tab 数，无压力。
   */
  // internal: handler 模块访问
  readonly terminalOrigin = new Map<Terminal, { issueNumber: number, kind: 'brainstorm' | 'implement' | 'review' | 'test' }>()

  /**
   * 防 handleResumeSession/handleResumeReviewSession 在 await 钩子/终端创建期间被重入触发，
   * 导致同一 sessionId 开多个 tab。key 形如 `${issueNumber}:brainstorm|implement|review`。
   *
   * 触发场景：impl-tab-pre-create 钩子里 `pgrep -f` 等 pycharm 真 PID 最多 15s，
   * 这段时间用户再点同一会话 id（前端 800ms 节流早已过期），第二次进来时
   * `findExistingTerminal` 还查不到（前一次 createTerminal 尚未发生），两次都
   * 走到 createTerminal → 重复 tab。审查会话同理（codex resume 启动有几秒延迟）。
   *
   * 锁的释放时机 = 方法返回（包括 throw 时也释放，try/finally 保证）；不持久化，
   * 重启自动清空。
   */
  // internal: handler 模块访问
  readonly resumeInFlight = new Set<string>()

  /**
   * Concurrency lock for the "提交当前代码" button. The webview already
   * disables the button while `commit/state running=true` is in flight, but
   * we keep a server-side lock as defense against duplicate messages.
   */
  // internal: handler 模块访问
  commitRunning = false

  /**
   * Whether the workspace git working tree currently has any uncommitted
   * changes (working tree, index, or untracked). Populated by
   * `setupGitWatcher()` via the built-in `vscode.git` extension and pushed to
   * the webview as `commit/has-changes`. The webview only renders the
   * "提交代码" toolbar button while this is true (or while a commit run is
   * in flight, so users can still see the spinner). Defaults to `false` so
   * the button stays hidden until we've actually observed the repo state.
   */
  // internal: handler 模块访问
  hasGitChanges = false

  /**
   * Disposable returned by `repository.state.onDidChange` while we're
   * watching the workspace repo. Stored so we can detach the listener when
   * the panel is disposed (otherwise the git extension would keep a strong
   * reference to our callback closure for the lifetime of the editor).
   */
  // internal: handler 模块访问
  gitStateDisposable: { dispose: () => void } | undefined

  /**
   * 最近一次 onDidChangeActiveTerminal 触发反选 webview 的时间戳（ms epoch）。
   * `handleSessionFocus` 收到 webview 回发的 session/focus 时检查这个，
   * 距离 <200ms 且工单号相同 → 跳过优先级跳转，避免点审查 tab 自动弹回实施 tab。
   */
  // internal: handler 模块访问
  lastReverseSelectAt = 0
  // internal: handler 模块访问
  lastReverseSelectIssueNumber = -1

  /**
   * 上一次被 `handleActiveTerminalChanged` 处理的 terminal 引用。同一 terminal
   * 短时间内重复触发（OSC title 改写、shell prompt 重绘等导致的 onDidChangeTabs
   * 误触）直接 noop，避免 webview 反复 setPendingSelectId 造成 UI 闪烁。
   * `onDidCloseTerminal` 中清掉该 ref。
   */
  // internal: handler 模块访问
  lastActiveTerminalRef: Terminal | undefined

  // internal: context 供 handler 模块访问
  private constructor(public readonly context: ExtensionContext, panel: WebviewPanel) {
    this.panel = panel

    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui'),
      ],
    }

    this.panel.webview.html = this.buildHtml()

    // Let the always-on webhook coordinator know who to refresh + toast for.
    webhookCoordinator.setActivePanel(this)

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((msg: WebviewToExtension) => this.handleMessage(msg)),
      // Forward every new log entry to the webview so the log modal stays
      // live without polling.
      logger.onEntry(entry => this.postMessage({ type: 'logs/append', entry })),
      // Drop tracked terminals when the user closes them, so the next Enter
      // on that card spawns a fresh tab instead of trying to .show() a dead
      // handle.
      window.onDidCloseTerminal((closed) => {
        for (const [sid, t] of this.terminals) {
          if (t === closed) {
            this.terminals.delete(sid)
            break
          }
        }
        for (const [n, t] of this.implTerminals) {
          if (t === closed) {
            this.implTerminals.delete(n)
            break
          }
        }
        for (const [sid, t] of this.reviewTerminals) {
          if (t === closed) {
            this.reviewTerminals.delete(sid)
            break
          }
        }
        for (const [n, t] of this.newIssueTerminals) {
          if (t === closed) {
            this.newIssueTerminals.delete(n)
            break
          }
        }
        // 会话管理 tab 的终端：按值反查删条目，再重推列表让 tabOpen 变 false。
        for (const [sid, t] of this.managedTerminals) {
          if (t === closed) {
            this.managedTerminals.delete(sid)
            void managedSessions.pushManagedSessions(this)
            break
          }
        }
        // 先抓 origin 再 untrack（untrackClosedTerminal 会从 map 里删 entry）。
        // 仅对 implement tab 触发 post-close 钩子，fire-and-forget 不阻塞 listener。
        const origin = this.terminalOrigin.get(closed)
        // 反查 terminalOrigin 给详情面板推 *TabOpen: false，让关闭按钮消失。
        this.untrackClosedTerminal(closed)
        if (closed === this.lastActiveTerminalRef)
          this.lastActiveTerminalRef = undefined
        if (origin?.kind === 'implement')
          void this.dispatchImplTabPostCloseAsync(origin.issueNumber)
      }),
      // 用户在 column 2 切换终端 tab 时，反向选中看板上对应的工单卡片。
      window.onDidChangeActiveTerminal((terminal) => {
        if (!terminal)
          return
        this.handleActiveTerminalChanged(terminal)
      }),
      // 补充监听 tab 切换事件：当 column 2 只有一个 terminal tab 时，
      // 它始终是 active terminal，`onDidChangeActiveTerminal` 不会触发；
      // 但用户点击该 tab 仍会让它成为 active tab，`onDidChangeTabs` 会以
      // `changed` + `isActive=true` 的形式投递事件。两者并存时
      // `handleActiveTerminalChanged` 内的 `lastReverseSelectAt` 时间窗
      // 已能去重，不会回环放大。
      window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of e.changed) {
          if (!tab.isActive)
            continue
          if (!(tab.input instanceof TabInputTerminal))
            continue
          // TabInputTerminal 只有构造器、无任何字段，只能用 tab.label
          // 反查 `window.terminals` 里的实例。终端 name 常被 shell 的
          // OSC title 序列改写（追加 git branch 等后缀），所以双向 startsWith
          // 兜底，参考 `injectIntoImplTerminal` 里的命名匹配策略。
          const label = tab.label
          const term = window.terminals.find(
            t => label.startsWith(t.name) || t.name.startsWith(label),
          )
          if (term)
            this.handleActiveTerminalChanged(term)
        }
      }),
    )

    // Start observing the workspace repo so we can hide the "提交代码"
    // toolbar button whenever the working tree is clean. Fire-and-forget —
    // `setupGitWatcher` handles its own activation + retry logic.
    toolbar.setupGitWatcher(this)
  }

  static createOrShow(context: ExtensionContext): void {
    if (KanbanWebviewPanel.current) {
      KanbanWebviewPanel.current.panel.reveal(ViewColumn.Active)
      return
    }
    const panel = window.createWebviewPanel(
      KanbanWebviewPanel.viewType,
      'Superpowers Kanban',
      ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          Uri.joinPath(context.extensionUri, 'dist', 'webview-ui'),
        ],
      },
    )
    KanbanWebviewPanel.current = new KanbanWebviewPanel(context, panel)
  }

  /** Triggers a fresh load on the currently open panel, if any. */
  static refresh(): void {
    KanbanWebviewPanel.current?.loadAndPush().catch(() => {})
  }

  private handleMessage(msg: WebviewToExtension): void {
    if (msg.type === 'issues/refresh') {
      void this.loadAndPush()
      return
    }
    if (msg.type === 'settings/save') {
      void settings.handleSettingsSave(this, msg)
      return
    }
    if (msg.type === 'settings/edit-request') {
      void settings.handleEditSettingsRequest(this)
      return
    }
    if (msg.type === 'issue/create') {
      void issues.handleIssueCreate(this, msg.userRequest, msg.images, msg.profilePath)
      return
    }
    if (msg.type === 'profiles/list') {
      void settings.handleProfilesList(this)
      return
    }
    if (msg.type === 'toast/open-url') {
      void env.openExternal(Uri.parse(msg.url))
      return
    }
    if (msg.type === 'session/resume') {
      void sessions.handleResumeSession(this, msg.sessionId, msg.profilePath, msg.cwd, msg.issueNumber)
      return
    }
    if (msg.type === 'session/focus') {
      terminals.handleSessionFocus(this, msg.issueNumber)
      return
    }
    if (msg.type === 'session/resume-review') {
      void sessions.handleResumeReviewSession(this, msg.sessionId, msg.issueNumber, msg.cwd)
      return
    }
    if (msg.type === 'session/start-test') {
      void sessions.handleStartTestSession(this, msg.issueNumber)
      return
    }
    if (msg.type === 'session/resume-test') {
      void sessions.handleResumeTestSession(this, msg.sessionId, msg.issueNumber, msg.cwd)
      return
    }
    if (msg.type === 'editor/open-file') {
      void issues.handleOpenFile(this, msg.path)
      return
    }
    if (msg.type === 'issue/implement') {
      void this.handleImplement(msg.issueNumber, msg.planFile, msg.profilePath, msg.sessionId)
      return
    }
    if (msg.type === 'pr/open') {
      void issues.handleOpenPr(this, msg.pr)
      return
    }
    if (msg.type === 'issue/generate-pr-diff-summary') {
      void issues.handleGeneratePrDiffSummary(this, msg.issueNumber)
      return
    }
    if (msg.type === 'worktree/open') {
      void worktree.handleOpenWorktree(this, msg.path)
      return
    }
    if (msg.type === 'worktree/delete') {
      void worktree.handleDeleteWorktree(this, msg.issueNumber, msg.path)
      return
    }
    if (msg.type === 'column/change') {
      if (msg.source === 'youtrack' && msg.externalId)
        void youtrackIssues.handleYouTrackColumnChange(this, msg.externalId, msg.toColumn)
      else
        void issues.handleColumnChange(this, msg.issueNumber, msg.toColumn)
      return
    }
    if (msg.type === 'youtrack/list-projects') {
      void youtrackIssues.handleListProjects(this, msg.baseUrl, msg.token)
      return
    }
    if (msg.type === 'dependency/set') {
      void issues.handleSetDependency(this, msg.issueNumber, msg.prerequisiteNumber)
      return
    }
    if (msg.type === 'dependency/clear') {
      void issues.handleClearDependency(this, msg.issueNumber, msg.prerequisiteNumber)
      return
    }
    if (msg.type === 'issue/update-auto-review') {
      void issues.handleUpdateAutoReview(this, msg.issueNumber, msg.value)
      return
    }
    if (msg.type === 'issue/update-profile-path') {
      void issues.handleUpdateProfilePath(this, msg.issueNumber, msg.profilePath)
      return
    }
    if (msg.type === 'issue/update-test-profile-path') {
      void issues.handleUpdateTestProfilePath(this, msg.issueNumber, msg.testProfilePath)
      return
    }
    if (msg.type === 'logs/fetch') {
      this.postMessage({ type: 'logs/snapshot', entries: logger.snapshot() })
      return
    }
    if (msg.type === 'logs/clear') {
      logger.clear()
      this.postMessage({ type: 'logs/cleared' })
      return
    }
    if (msg.type === 'commit/run') {
      void toolbar.handleCommitRun(this)
      return
    }
    if (msg.type === 'session/close-tab') {
      terminals.handleCloseSessionTab(this, msg.issueNumber, msg.kind)
      return
    }
    if (msg.type === 'branch-sync/check') {
      void this.handleBranchSyncCheck()
      return
    }
    if (msg.type === 'branch-sync/run') {
      void toolbar.handleBranchSyncRun(this)
      return
    }
    if (msg.type === 'env-lock/check') {
      void this.handleEnvLockCheck()
      return
    }
    if (msg.type === 'env-lock/toggle') {
      void toolbar.handleEnvLockToggle(this)
      return
    }
    if (msg.type === 'issue/delete') {
      void issues.handleDeleteIssue(this, msg.issueNumber)
      return
    }
    if (msg.type === 'issue/close') {
      void issues.handleCloseIssue(this, msg.issueNumber)
      return
    }
    if (msg.type === 'brainstorm/start') {
      void sessions.handleStartBrainstormSession(this, msg.issueNumber)
      return
    }
    if (msg.type === 'profiles/get') {
      void settings.handleProfilesGet(this)
      return
    }
    if (msg.type === 'profiles/save') {
      void settings.handleProfilesSave(this, msg.data)
      return
    }
    if (msg.type === 'profiles/open') {
      void settings.handleProfilesOpen(this, msg.value)
      return
    }
    if (msg.type === 'managed-sessions/get') {
      void managedSessions.handleManagedSessionsGet(this)
      return
    }
    if (msg.type === 'managed-sessions/create') {
      void managedSessions.handleManagedSessionsCreate(this, msg.profilePath, msg.name, msg.prompt)
      return
    }
    if (msg.type === 'managed-sessions/rename') {
      void managedSessions.handleManagedSessionsRename(this, msg.sessionId, msg.name)
      return
    }
    if (msg.type === 'managed-sessions/resume') {
      void managedSessions.handleManagedSessionsResume(this, msg.sessionId)
      return
    }
    if (msg.type === 'managed-sessions/delete') {
      void managedSessions.handleManagedSessionsDelete(this, msg.sessionId)
      return
    }
    if (msg.type === 'managed-sessions/close-tab') {
      managedSessions.handleManagedSessionsCloseTab(this, msg.sessionId)
      return
    }
    if (msg.type === 'pr-commits/get') {
      void prCommits.handleGetPrCommits(this, msg.issueNumber)
      return
    }
    if (msg.type === 'pr-commit-files/get') {
      void prCommits.handleGetPrCommitFiles(this, msg.issueNumber, msg.sha)
      return
    }
    if (msg.type === 'pr-commit-diff/open') {
      void prCommits.handleOpenPrCommitDiff(this, {
        issueNumber: msg.issueNumber,
        sha: msg.sha,
        parentSha: msg.parentSha,
        path: msg.path,
        status: msg.status,
      })
      return
    }
    if (msg.type === 'pr-review/set') {
      void prCommits.handleSetPrReviewConfirmed(this, msg)
      return
    }
    if (msg.type === 'pr-review/set-commits') {
      void prCommits.handleSetPrReviewConfirmedCommits(this, msg)
      return
    }
  }

  // internal: handler 模块访问
  resolveTerminalLocation(preserveFocus: boolean): TerminalEditorLocationOptions {
    return terminals.resolveTerminalLocation(this, preserveFocus)
  }

  /**
   * Resolve the ThemeColor to use for an issue's terminal/tab. Reads the
   * stored color from the issue's state JSON; if absent or invalid, picks a
   * random palette entry and asynchronously persists it back so future
   * sessions reuse the same tone.
   *
   * Always returns a ThemeColor (never undefined) — caller is expected to
   * only call this once it has a usable workspace + Gitea remote + token.
   * Persistence failures are logged and swallowed.
   */
  // internal: handler 模块访问
  async resolveIssueIcon(issueNumber: number): Promise<{ themeColor: ThemeColor, iconUri: Uri }> {
    // Helper: produce both representations from a palette id.
    const pack = (id: string) => ({
      themeColor: new ThemeColor(id),
      iconUri: themeColorIdToIconUri(id),
    })
    // Deterministic fallback when we can't talk to gitea (no workspace, no
    // remote, no token). Matches what `issueTerminalColor(issueNumber)` would
    // pick so the icon is still stable across sessions.
    const fallbackId = PALETTE[((issueNumber % PALETTE.length) + PALETTE.length) % PALETTE.length]

    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot)
      return pack(fallbackId)
    const remote = await detectRepo(workspaceRoot)
    if (!remote)
      return pack(fallbackId)
    const token = await getToken(this.context, remote.host)
    if (!token)
      return pack(fallbackId)

    let stored: string | undefined
    try {
      const state = await this.readIssueState(issueNumber)
      if (typeof state.color === 'string' && state.color.length > 0)
        stored = state.color
    }
    catch (err) {
      console.warn('[superpowers] failed to read state JSON for color:', err)
    }

    const { id, isNew } = resolveIssueColor(stored)
    if (isNew) {
      // Fire-and-forget: don't block terminal creation on the network round
      // trip. Failures are non-fatal — the next session just picks again.
      void this.mergeIssueState(issueNumber, { color: id })
        .then(() => {
          this.postMessage({
            type: 'issue/patch',
            issueNumber,
            patch: { color: id },
          })
        })
        .catch((err) => {
          console.warn('[superpowers] failed to persist issue color:', err)
        })
    }
    return pack(id)
  }

  /**
   * Inject review feedback into the implementation terminal for `issueNumber`.
   * Called from the webhook coordinator's auto-review path. Returns `true`
   * when a terminal was found and `sendText` was called; `false` otherwise
   * (so the caller can log a warning).
   *
   * Falls back to looking up by terminal name when the in-memory map miss
   * happens — e.g. after a window reload, the impl terminal might still be
   * present in `window.terminals` but absent from `this.implTerminals`.
   */
  // internal: handler 模块访问
  injectIntoImplTerminal(issueNumber: number, text: string, isFirstReview: boolean): boolean {
    return terminals.injectIntoImplTerminal(this, issueNumber, text, isFirstReview)
  }

  /**
   * Scan `vscode.window.terminals` for an existing terminal whose name
   * matches `expectedName`. Matches exact, or `startsWith(expectedName + ' ')`
   * so a shell that appended a git branch suffix (e.g. "issue-48-实施
   * 5f56026c") still counts. Skips terminals whose process already exited
   * (`exitStatus !== undefined`) — those are zombie tabs and shouldn't block
   * a fresh spawn.
   *
   * Why this exists: every session entry (`handleResumeSession`,
   * `handleResumeReviewSession`, `handleImplement`) used to dedupe via its
   * own in-memory Map (sessionId → Terminal). Panel reload / webview rebuild
   * wipes those Maps, but the terminal stays alive in `window.terminals`,
   * so re-clicking the link spawned a duplicate tab. Scanning the live
   * terminal list survives reloads and prevents cross-map blind spots.
   */
  // internal: handler 模块访问
  findExistingTerminal(expectedName: string): Terminal | undefined {
    return terminals.findExistingTerminal(this, expectedName)
  }

  /**
   * Open (or re-use) the review terminal tab for an issue and send the codex
   * review command. Used by the webhook auto-review flow so the user can watch
   * codex work in real time instead of it running headless in the background.
   *
   * Re-use semantics: if a tab named `issue-${N}-审查` already exists (live, not
   * exited), codex TUI is already running inside; we just `show` the tab and
   * send a short follow-up message ("PR 更新了，再审一下") as the next user
   * input so codex handles it as a new round, reusing the existing session
   * context. We deliberately do NOT re-run the full
   * `codex --dangerously-bypass-... '/review\n<prompt>'` startup command on
   * reuse (it would be received as a long redundant user message, wasting
   * tokens) and we do NOT restart the codex session watcher (reuse doesn't
   * write a new rollout-*.jsonl, so the watcher would just idle until
   * timeout). We do NOT track the terminal in `reviewTerminals` (that map is
   * keyed by codex thread_id, which we don't have on this path).
   *
   * Returns true if the command was successfully dispatched, false if a
   * pre-condition failed (single-quote in prompt — only checked on the
   * new-terminal path since reuse sends a fixed string).
   */
  public async triggerAutoReviewTab(opts: {
    issueNumber: number
    prNumber: string
    prompt: string
    /** workspace-relative or absolute path; if missing/invalid we fall back to workspaceRoot. */
    worktreePath: string
    workspaceRoot: string
  }): Promise<boolean> {
    return sessions.triggerAutoReviewTab(this, opts)
  }

  /**
   * 反向选中：用户在 column 2 切换 terminal tab 时，从 terminal.name 解析
   * issueNumber 并通知 webview 选中对应工单。
   *
   * 终端名按 `issue-${N}-(规划|实施|审查)` 命名；`issue-new-${nonce}-...`
   * 是新建工单流程的占位 tab，没有 issue number，跳过。
   */
  // internal: handler 模块访问
  handleActiveTerminalChanged(terminal: Terminal): void {
    terminals.handleActiveTerminalChanged(this, terminal)
  }

  /**
   * Resolve a workspace-relative path against the current workspace root and
   * open it in VS Code. Markdown files (`.md`) are opened in the rendered
   * preview via `markdown.showPreview`; other file types fall back to
   * `vscode.open`. Surfaces failures as an error toast (e.g. file deleted on
   * disk after we recorded its path).
   */
  /**
   * Kick off the end-to-end "implement this plan" flow:
   *   1. Detect repo + token, compute a stable feature_name from the plan path.
   *   2. Move the issue to in-progress and stamp branch/worktreePath/status
   *      into the state-JSON comment.
   *   3. Confirm the always-on webhook coordinator is bound to the current
   *      port, then register a gitea webhook scoped to the feature branch
   *      and hand the bookkeeping to the coordinator.
   *   4. Spawn `claude` in an editor-tab terminal with a /goal prompt that
   *      tells cc to create the worktree, implement the plan, and emit
   *      `<request_review>$pr_no</request_review>` when done.
   *
   * The webhook coordinator (see src/webhook/coordinator.ts) receives the
   * resulting PR event, writes back the PR number, and deletes the gitea
   * hook — even if this panel has since been closed.
   */
  // internal: handler 模块访问
  async handleImplement(
    issueNumber: number,
    planFile: string,
    profilePath?: string,
    _sessionId?: string,
  ): Promise<void> {
    return sessions.handleImplement(this, issueNumber, planFile, profilePath, _sessionId)
  }

  // internal: handler 模块访问
  dispatchWorktreeHook(
    phase: 'post-create' | 'pre-remove' | 'impl-tab-pre-create' | 'impl-tab-post-close',
    ctx: HookContext,
  ): Promise<void> {
    return worktree.dispatchWorktreeHook(this, phase, ctx)
  }

  // internal: onDidCloseTerminal fire-and-forget 调用，保留薄委派
  private dispatchImplTabPostCloseAsync(issueNumber: number): Promise<void> {
    return worktree.dispatchImplTabPostCloseAsync(this, issueNumber)
  }


  /**
   * Server-side lock check for prerequisite gating. Fetches a fresh issues
   * snapshot (we don't trust webview state) and reports whether
   * `issueNumber` is blocked by an unfinished prerequisite. Mirrors the
   * webview-side `isIssueLocked` predicate: locked iff the issue has a
   * prerequisite that exists in the current snapshot and is not yet in the
   * `done` column.
   *
   * Fail-open: any error fetching issues is logged and we return
   * `{ locked: false }` so a transient Gitea hiccup can't lock the user out
   * of starting a session.
   */
  // internal: handler 模块访问
  async resolveLockedReason(
    issueNumber: number,
  ): Promise<{ locked: boolean, prerequisiteNumber?: number, prerequisiteColumn?: string }> {
    return issues.resolveLockedReason(this, issueNumber)
  }

  /**
   * 将当前 VS Code 里仍存活的会话终端同步回 issue 列表。
   *
   * `issues/update` 会用 Gitea 里持久化的 state JSON 整体替换 webview
   * 状态；tabOpen 是本地运行态，不在 state JSON 中，因此发送列表前要按
   * live terminal 重新补齐，同时登记 terminalOrigin，确保详情面板的关闭
   * 按钮能找到对应 terminal。
   */
  // internal: handler 模块访问
  withLiveTerminalTabState(issues: Issue[]): Issue[] {
    return terminals.withLiveTerminalTabState(this, issues)
  }

  /**
   * Reloads issues from gitea and pushes to the webview. Public so the
   * always-on webhook coordinator can refresh us when a PR event arrives.
   */
  async loadAndPush(): Promise<void> {
    this.postMessage({ type: 'issues/loading' })

    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    // eslint-disable-next-line no-console
    console.log('[superpowers/panel] loadAndPush workspaceRoot=', workspaceRoot)
    if (!workspaceRoot) {
      this.postMessage({
        type: 'issues/error',
        message: '请先打开一个工作区文件夹',
      })
      return
    }

    const remote = await detectRepo(workspaceRoot)
    if (!remote) {
      this.postMessage({
        type: 'issues/error',
        message: '当前工作区没有 Gitea 远程仓库',
      })
      return
    }

    const { host, owner, repo } = remote
    const token = await getToken(this.context, host)
    if (!token) {
      const s = getSettings(this.context)
      this.postMessage({
        type: 'settings/show',
        host,
        tokenSaved: false,
        webhookPort: s.webhookPort,
        brainstormPrompt: s.brainstormPrompt,
        implementPlanPrompt: s.implementPlanPrompt,
        autoReview: s.autoReview,
        reviewPrompt: s.reviewPrompt,
        devBranch: s.devBranch,
        autoBuildBranch: s.autoBuildBranch,
        worktreePostCreateScript: s.worktreePostCreateScript,
        worktreePreRemoveScript: s.worktreePreRemoveScript,
        implTabPreCreateScript: s.implTabPreCreateScript,
        implTabPostCloseScript: s.implTabPostCloseScript,
      })
      return
    }

    try {
      const giteaIssues = await loadIssues({ host, token, owner, repo, workspaceRoot })
      // YouTrack is a best-effort second source: a failure here must never
      // break the gitea board, so swallow it into a toast + log.
      let youtrackList: Issue[] = []
      try {
        youtrackList = await loadYouTrackIssues(this.context)
      }
      catch (ytErr) {
        const message = ytErr instanceof Error ? ytErr.message : String(ytErr)
        logger.add({ level: 'error', source: 'youtrack', message: '加载 YouTrack 问题失败', details: message })
        this.postMessage({
          type: 'toast/show',
          id: makeNonce(),
          level: 'error',
          message: `YouTrack 同步失败：${message}`,
          dismissOnTimer: 6000,
        })
      }
      const issues = this.withLiveTerminalTabState([...giteaIssues, ...youtrackList])
      this.issueRefs = new Map(
        issues.map(i => [i.number, { source: i.source ?? 'gitea', externalId: i.externalId }] as const),
      )
      this.postMessage({
        type: 'issues/update',
        issues,
        globalAutoReview: getSettings(this.context).autoReview,
      })
      // Re-publish the cached git state so a slow webview boot (or a
      // refresh after git events already fired) still picks up the latest
      // value. Cheap — the webview discards if equal.
      this.postMessage({ type: 'commit/has-changes', value: this.hasGitChanges })
    }
    catch (err) {
      if (err instanceof GiteaApiError && err.status === 401) {
        await deleteToken(this.context, host)
        const s = getSettings(this.context)
        this.postMessage({
          type: 'settings/show',
          host,
          errorMessage: 'Token 无效或已过期，请重新填写',
          tokenSaved: false,
          webhookPort: s.webhookPort,
          brainstormPrompt: s.brainstormPrompt,
          implementPlanPrompt: s.implementPlanPrompt,
          autoReview: s.autoReview,
          reviewPrompt: s.reviewPrompt,
          devBranch: s.devBranch,
          autoBuildBranch: s.autoBuildBranch,
          worktreePostCreateScript: s.worktreePostCreateScript,
          worktreePreRemoveScript: s.worktreePreRemoveScript,
          implTabPreCreateScript: s.implTabPreCreateScript,
          implTabPostCloseScript: s.implTabPostCloseScript,
        })
        return
      }
      const baseMessage = err instanceof Error ? err.message : String(err)
      const message = `${baseMessage}\n\n[debug] host=${host} owner=${owner} repo=${repo}`
      this.postMessage({ type: 'issues/error', message })
    }
  }

  /**
   * Pick the profile.json that the *implement-class* cc sessions
   * (handleImplement / handleResumeSession when sessionKind === 'implement' /
   * startConflictResolution) should launch with. Priority:
   *   1. The per-issue `profilePath` recorded in state JSON (preserves the
   *      brainstorm-time choice, overridable from the issue detail panel).
   *   2. The hard-coded `DEFAULT_PROFILE_PATH` fallback.
   *
   * Brainstorm sessions deliberately don't go through this helper — they
   * keep the legacy `profilePath || DEFAULT_PROFILE_PATH` so creators can
   * still pick a profile per issue at brainstorm time.
   */
  /**
   * Resolve an issue number to its source identity, for routing state
   * persistence. Unknown numbers default to gitea (back-compat / pre-load).
   */
  // internal: handler 模块访问
  refFor(issueNumber: number): IssueRef {
    const entry = this.issueRefs.get(issueNumber)
    return { source: entry?.source ?? 'gitea', number: issueNumber, externalId: entry?.externalId }
  }

  /** True when the board number belongs to a YouTrack-sourced card. */
  // internal: handler 模块访问
  isYouTrackIssue(issueNumber: number): boolean {
    return this.issueRefs.get(issueNumber)?.source === 'youtrack'
  }

  /** Read workflow state from the issue's tracker (gitea or youtrack). */
  // internal: handler 模块访问
  readIssueState(issueNumber: number): Promise<Record<string, unknown>> {
    return readIssueState(this.context, this.refFor(issueNumber))
  }

  /** Merge workflow state into the issue's tracker (gitea or youtrack). */
  // internal: handler 模块访问
  mergeIssueState(issueNumber: number, extra: Record<string, unknown>): Promise<void> {
    return mergeIssueState(this.context, this.refFor(issueNumber), extra)
  }

  /** Resolve/close the issue in its tracker. Returns false when a youtrack
   * close command can't be determined. */
  // internal: handler 模块访问
  closeIssueByNumber(issueNumber: number): Promise<boolean> {
    return closeIssueByRef(this.context, this.refFor(issueNumber))
  }

  // internal: handler 模块访问
  resolveImplementProfilePath(issueLevelProfilePath: string | undefined): string {
    return sessions.resolveImplementProfilePath(this, issueLevelProfilePath)
  }

  /**
   * Compute how far the remote auto-build branch is behind the remote dev
   * branch, then push a `branch-sync/status` to the webview. Called on
   * webview init, after `settings/save`, and after a successful sync.
   *
   * Empty `autoBuildBranch` setting means "use devBranch" — collapsing to
   * the equal-branch case in `checkBranchSync`, which marks it unavailable.
   */
  // internal: handler 模块访问
  handleBranchSyncCheck(): Promise<void> {
    return toolbar.handleBranchSyncCheck(this)
  }

  /**
   * Push the current env-lock state to the webview. State persists in
   * `workspaceState` under `'envLocked'`. First call (key not yet set)
   * defaults to locked AND eagerly chmods all `.env*` files to 0o444 so
   * UI and filesystem agree; subsequent calls trust the stored value.
   * The file count is recomputed via a fresh scan each time so the toolbar
   * reflects what the next toggle will actually act on.
   */
  private handleEnvLockCheck(): Promise<void> {
    return toolbar.handleEnvLockCheck(this)
  }

  /** Forces the open panel (if any) into the setup-auth state. */
  static requestEditAuth(): void {
    if (KanbanWebviewPanel.current)
      settings.requestEditAuth(KanbanWebviewPanel.current)
  }

  postMessage(msg: ExtensionToWebview): void {
    void this.panel.webview.postMessage(msg)
  }

  /**
   * 登记一个新创建/复用的会话终端，并主动推一条 issue/patch 把对应 tab 打开
   * 标志置 true。详情面板侧据此在三行会话 id 右侧渲染关闭按钮。
   *
   * 复用场景（map 命中、existingByName 命中）也会再调一次，是幂等的：
   * 重复设置 terminalOrigin 不影响，重复推 true 在 webview 端的
   * `mergeIssuePatch` 也是 no-op。
   */
  // internal: handler 模块访问
  trackSessionTerminal(
    terminal: Terminal,
    issueNumber: number,
    kind: 'brainstorm' | 'implement' | 'review' | 'test',
  ): void {
    terminals.trackSessionTerminal(this, terminal, issueNumber, kind)
  }

  /**
   * onDidCloseTerminal 触发后调用：反查 `terminalOrigin` 找到该 terminal
   * 对应的工单 + 会话类型，并推 false 让详情面板隐藏关闭按钮。
   *
   * 同时从 `terminalOrigin` 删除条目；四个 issue-aware Map 的清理仍由
   * 现有 onDidCloseTerminal 循环负责，本方法只关心 webview 通知。
   */
  // internal: handler 模块访问
  untrackClosedTerminal(closed: Terminal): void {
    terminals.untrackClosedTerminal(this, closed)
  }

  /**
   * Removes and returns the {@link pendingIssueCreations} entry for the
   * given nonce, if any. Called by the webhook coordinator when a matching
   * `issues opened` payload arrives. Returning `undefined` (and leaving the
   * map untouched) signals "no match — treat as external issue creation".
   */
  // internal: handler 模块访问
  takePendingIssueCreation(nonce: string): {
    sessionId?: string
    profilePath?: string
    color: string
    workspaceRoot: string
    inboxDir: string
    terminalName: string
    terminal: Terminal
    createdAt: number
  } | undefined {
    return terminals.takePendingIssueCreation(this, nonce)
  }

  /**
   * Called by the webhook coordinator after it parses a `spx:nonce=...` token
   * out of `issue.body` and matches it to an entry in `pendingIssueCreations`.
   * Promotes the in-flight brainstorm terminal into the issueNumber-keyed
   * `newIssueTerminals` map so subsequent `handleSessionFocus(issueNumber)`
   * and `handleActiveTerminalChanged` calls can find it.
   *
   * Also drops the terminal into `terminals` keyed by sessionId (when known)
   * so `handleResumeSession` reuses the same tab instead of spawning a new
   * one. Does NOT remove the pending entry — `takePendingIssueCreation` is
   * still responsible for cleanup on its own path.
   */
  // internal: handler 模块访问
  public linkPendingTerminalToIssue(nonce: string, issueNumber: number): void {
    terminals.linkPendingTerminalToIssue(this, nonce, issueNumber)
  }

  private dispose(): void {
    KanbanWebviewPanel.current = undefined
    webhookCoordinator.setActivePanel(undefined)
    this.gitStateDisposable?.dispose()
    this.gitStateDisposable = undefined
    while (this.disposables.length) {
      const d = this.disposables.pop()
      d?.dispose()
    }
    this.panel.dispose()
  }

  private buildHtml(): string {
    const distRoot = Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui')
    const indexPath = path.join(distRoot.fsPath, 'index.html')
    let html = fs.readFileSync(indexPath, 'utf-8')

    const nonce = makeNonce()
    const cspSource = this.panel.webview.cspSource

    // 重写 src 和 href 的相对路径为 webview URI。vite 产物是固定名（无 hash），
    // webview 按 URL 缓存资源——必须按文件 mtime 加 ?v= 版本号，否则 reload 后
    // 仍会跑缓存里的旧 index.js / index.css。
    html = html.replace(/(src|href)="(\/[^"]+|\.\/[^"]+|[^"/][^"]*)"/g, (_m, attr, p) => {
      const cleaned = p.replace(/^\.?\//, '')
      const fileUri = Uri.joinPath(distRoot, cleaned)
      let version = ''
      try {
        version = `?v=${fs.statSync(fileUri.fsPath).mtimeMs}`
      }
      catch {
        // 资源文件不存在则不加版本号
      }
      const uri = this.panel.webview.asWebviewUri(fileUri)
      return `${attr}="${uri}${version}"`
    })

    // 给所有 <script> 标签注入 nonce
    html = html.replace(/<script(\s[^>]*)?>/g, (_m, attrs) => {
      const a = attrs ?? ''
      return `<script nonce="${nonce}"${a}>`
    })

    // 注入 CSP
    const csp = `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};`
    html = html.replace(
      /<head>/,
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
    )

    return html
  }
}

// internal: handler 模块访问
export function makeNonce(): string {
  return randomBytes(16).toString('base64').replace(/[+/=]/g, '')
}
