import type {
  Terminal,
  TerminalEditorLocationOptions,
} from 'vscode'
import type { Issue } from '../../gitea/types'
import type { KanbanWebviewPanel } from '../KanbanPanel'
import { ViewColumn, window } from 'vscode'
import { logger } from '../../logging/logger'

export function resolveTerminalLocation(panel: KanbanWebviewPanel, preserveFocus: boolean): TerminalEditorLocationOptions {
  void panel
  // Pin all plugin-managed terminals to editor group 2 (right side of the
  // kanban panel in column 1). VS Code creates the group on demand if it
  // doesn't exist yet, and stacks new terminals as tabs in that group when
  // it does — exactly what we want, no manual scan of existing tabs needed.
  return { viewColumn: ViewColumn.Two, preserveFocus }
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
export function injectIntoImplTerminal(panel: KanbanWebviewPanel, issueNumber: number, text: string, isFirstReview: boolean): boolean {
  // `isFirstReview` 参数保留只为兼容签名（调用方仍按 first/再审 区分），
  // 方法体本身不再消费它——合并改由用户拖工单到"完成"列时插件 API 触发，
  // cc 不允许自行合并。
  void isFirstReview
  let terminal = panel.implTerminals.get(issueNumber)
  if (!terminal) {
    // Match by prefix — shell OSC title escapes can append a git branch
    // suffix to terminal.name (e.g. "issue-48-实施 5f56026c").
    const wantedPrefix = `issue-${issueNumber}-实施`
    for (const t of window.terminals) {
      if (t.name.startsWith(wantedPrefix)) {
        terminal = t
        panel.implTerminals.set(issueNumber, t)
        trackSessionTerminal(panel, t, issueNumber, 'implement')
        break
      }
    }
  }
  if (!terminal)
    return false
  // cc 的 TUI 在 raw 模式下，LF (\n) 只算输入框内的换行，CR (\r)
  // 才会被识别为 Enter（提交消息）。实测把多行内容 + 末尾 \r 在同一次
  // sendText 里发出去时，cc 进入多行输入模式后并不会把紧跟的 \r 当成
  // 提交键，结果就是反馈只粘贴到输入框、没提交。
  // 拆两次发：先把内容完整推进输入框，250ms 后再独立发一个 \r 作为 Enter。
  const body = `\n[审查反馈]\n${text}`
  terminal.sendText(body, false)
  setTimeout(() => {
    terminal!.sendText('\r', false)
  }, 250)
  return true
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
export function findExistingTerminal(panel: KanbanWebviewPanel, expectedName: string): Terminal | undefined {
  void panel
  return window.terminals.find(
    t =>
      t.exitStatus === undefined
      && (t.name === expectedName || t.name.startsWith(`${expectedName} `)),
  )
}

/**
 * Focus an already-open terminal for `sessionId` without stealing focus
 * from the kanban. Called when the webview's selection changes via arrow
 * keys / clicks — if there's no terminal for this session yet, this is a
 * no-op (user has to press Enter to spawn one).
 */
export function handleSessionFocus(panel: KanbanWebviewPanel, issueNumber: number): void {
  // 如果这次 session/focus 是 onDidChangeActiveTerminal 反选触发的回路
  // （而不是用户主动点卡片切换工单），跳过优先级跳转，否则会把用户刚刚
  // 点的"审查 tab"弹回到优先级更高的"实施 tab"。
  const REVERSE_LOOP_WINDOW_MS = 200
  if (
    panel.lastReverseSelectIssueNumber === issueNumber
    && Date.now() - panel.lastReverseSelectAt < REVERSE_LOOP_WINDOW_MS
  ) {
    return
  }
  // Priority 0: new-issue flow terminal whose name is `issue-new-{nonce}-规划`,
  // not `issue-${N}-规划`. The webhook coordinator stitches issueNumber →
  // terminal into `newIssueTerminals` via `linkPendingTerminalToIssue`.
  // We can't rename the terminal tab (VS Code API limitation), so this
  // side-map is the only way to find it by issueNumber.
  const newIssueTerm = panel.newIssueTerminals.get(issueNumber)
  if (newIssueTerm && newIssueTerm.exitStatus === undefined) {
    newIssueTerm.show(true)
    return
  }
  // Priority 1-4: 实施 > 规划 > 审查 > 测试. Match by terminal.name since we know
  // the convention (issue-${N}-实施 / issue-${N}-规划 / issue-${N}-审查 / issue-${N}-测试).
  const namePriority = [
    `issue-${issueNumber}-实施`,
    `issue-${issueNumber}-规划`,
    `issue-${issueNumber}-审查`,
    `issue-${issueNumber}-测试`,
  ]
  for (const name of namePriority) {
    const term = findExistingTerminal(panel, name)
    if (term) {
      term.show(true)
      return
    }
  }
  // 找不到不报错，静默 return（用户没开过终端，正常）。
}

/**
 * 反向选中：用户在 column 2 切换 terminal tab 时，从 terminal.name 解析
 * issueNumber 并通知 webview 选中对应工单。
 *
 * 终端名按 `issue-${N}-(规划|实施|审查)` 命名；`issue-new-${nonce}-...`
 * 是新建工单流程的占位 tab，没有 issue number，跳过。
 */
export function handleActiveTerminalChanged(panel: KanbanWebviewPanel, terminal: Terminal): void {
  // Dedupe by reference: OSC title rewrites / shell prompt updates fire
  // onDidChangeTabs repeatedly for the same terminal. Skip if it's the
  // same reference we just handled.
  if (terminal === panel.lastActiveTerminalRef)
    return
  panel.lastActiveTerminalRef = terminal
  // Primary: `issue-${N}-(规划|实施|审查|测试)` — the steady-state naming.
  const m = terminal.name.match(/^issue-(\d+)-(规划|实施|审查|测试)/)
  if (m) {
    const issueNumber = Number.parseInt(m[1], 10)
    if (Number.isFinite(issueNumber)) {
      panel.lastReverseSelectAt = Date.now()
      panel.lastReverseSelectIssueNumber = issueNumber
      panel.postMessage({ type: 'issue/select-by-number', issueNumber })
    }
    return
  }
  // Fallback: `issue-new-${shortNonce}-规划` — created via the new-issue flow
  // before we knew the issueNumber. Reverse-scan `newIssueTerminals` (which
  // was populated by the webhook coordinator via `linkPendingTerminalToIssue`).
  if (terminal.name.startsWith('issue-new-')) {
    for (const [num, term] of panel.newIssueTerminals) {
      if (term === terminal) {
        panel.lastReverseSelectAt = Date.now()
        panel.lastReverseSelectIssueNumber = num
        panel.postMessage({ type: 'issue/select-by-number', issueNumber: num })
        return
      }
    }
  }
}

/**
 * 将当前 VS Code 里仍存活的会话终端同步回 issue 列表。
 *
 * `issues/update` 会用 Gitea 里持久化的 state JSON 整体替换 webview
 * 状态；tabOpen 是本地运行态，不在 state JSON 中，因此发送列表前要按
 * live terminal 重新补齐，同时登记 terminalOrigin，确保详情面板的关闭
 * 按钮能找到对应 terminal。
 */
export function withLiveTerminalTabState(panel: KanbanWebviewPanel, issues: Issue[]): Issue[] {
  const liveByIssue = new Map<number, Partial<Pick<Issue, 'brainstormTabOpen' | 'implementTabOpen' | 'reviewTabOpen' | 'testTabOpen'>>>()
  const mark = (issueNumber: number, kind: 'brainstorm' | 'implement' | 'review' | 'test'): void => {
    const patch = liveByIssue.get(issueNumber) ?? {}
    if (kind === 'brainstorm')
      patch.brainstormTabOpen = true
    else if (kind === 'implement')
      patch.implementTabOpen = true
    else if (kind === 'review')
      patch.reviewTabOpen = true
    else
      patch.testTabOpen = true
    liveByIssue.set(issueNumber, patch)
  }

  for (const [terminal, origin] of panel.terminalOrigin) {
    if (terminal.exitStatus === undefined)
      mark(origin.issueNumber, origin.kind)
  }

  for (const terminal of window.terminals) {
    if (terminal.exitStatus !== undefined)
      continue
    const match = terminal.name.match(/^issue-(\d+)-(规划|实施|审查|测试)(?:\s|$)/)
    if (!match)
      continue
    const issueNumber = Number.parseInt(match[1], 10)
    if (!Number.isFinite(issueNumber))
      continue
    const kind = match[2] === '规划'
      ? 'brainstorm'
      : match[2] === '实施'
        ? 'implement'
        : match[2] === '审查'
          ? 'review'
          : 'test'
    panel.terminalOrigin.set(terminal, { issueNumber, kind })
    mark(issueNumber, kind)
  }

  if (liveByIssue.size === 0)
    return issues

  return issues.map((issue) => {
    const patch = liveByIssue.get(issue.number)
    return patch ? { ...issue, ...patch } : issue
  })
}

/**
 * 登记一个新创建/复用的会话终端，并主动推一条 issue/patch 把对应 tab 打开
 * 标志置 true。详情面板侧据此在三行会话 id 右侧渲染关闭按钮。
 *
 * 复用场景（map 命中、existingByName 命中）也会再调一次，是幂等的：
 * 重复设置 terminalOrigin 不影响，重复推 true 在 webview 端的
 * `mergeIssuePatch` 也是 no-op。
 */
export function trackSessionTerminal(
  panel: KanbanWebviewPanel,
  terminal: Terminal,
  issueNumber: number,
  kind: 'brainstorm' | 'implement' | 'review' | 'test',
): void {
  panel.terminalOrigin.set(terminal, { issueNumber, kind })
  panel.postMessage({
    type: 'issue/patch',
    issueNumber,
    patch:
      kind === 'brainstorm'
        ? { brainstormTabOpen: true }
        : kind === 'implement'
          ? { implementTabOpen: true }
          : kind === 'review'
            ? { reviewTabOpen: true }
            : { testTabOpen: true },
  })
}

/**
 * onDidCloseTerminal 触发后调用：反查 `terminalOrigin` 找到该 terminal
 * 对应的工单 + 会话类型，并推 false 让详情面板隐藏关闭按钮。
 *
 * 同时从 `terminalOrigin` 删除条目；四个 issue-aware Map 的清理仍由
 * 现有 onDidCloseTerminal 循环负责，本方法只关心 webview 通知。
 */
export function untrackClosedTerminal(panel: KanbanWebviewPanel, closed: Terminal): void {
  const origin = panel.terminalOrigin.get(closed)
  if (!origin)
    return
  panel.terminalOrigin.delete(closed)
  panel.postMessage({
    type: 'issue/patch',
    issueNumber: origin.issueNumber,
    patch:
      origin.kind === 'brainstorm'
        ? { brainstormTabOpen: false }
        : origin.kind === 'implement'
          ? { implementTabOpen: false }
          : origin.kind === 'review'
            ? { reviewTabOpen: false }
            : { testTabOpen: false },
  })
}

/**
 * webview 端"关闭 tab"按钮入口：直接扫 `terminalOrigin` 找匹配
 * (issueNumber, kind) 的 terminal 并 `dispose()`。VS Code 随后会发
 * onDidCloseTerminal，由统一回调清理四个 issue-aware Map 和推 flag=false
 * ——本方法不直接改任何 Map，避免双重清理。
 *
 * 用 terminalOrigin 而不是分别查四个 Map：审查 tab 在
 * `triggerAutoReviewTab` 路径里不会进 `reviewTerminals`（那个 Map 按
 * thread_id 索引，此路径还没 thread_id），但会被登记到 terminalOrigin，
 * 所以用它做单一真相源最稳。
 */
export function handleCloseSessionTab(panel: KanbanWebviewPanel, issueNumber: number, kind: 'brainstorm' | 'implement' | 'review' | 'test'): void {
  let terminal: Terminal | undefined
  for (const [t, origin] of panel.terminalOrigin) {
    if (origin.issueNumber === issueNumber && origin.kind === kind) {
      terminal = t
      break
    }
  }
  if (!terminal) {
    logger.add({
      level: 'warn',
      source: 'panel',
      message: `关闭 ${kind} tab 失败 #${issueNumber}：未找到对应终端`,
    })
    return
  }
  terminal.dispose()
}

/**
 * Removes and returns the {@link pendingIssueCreations} entry for the
 * given nonce, if any. Called by the webhook coordinator when a matching
 * `issues opened` payload arrives. Returning `undefined` (and leaving the
 * map untouched) signals "no match — treat as external issue creation".
 */
export function takePendingIssueCreation(panel: KanbanWebviewPanel, nonce: string): {
  sessionId?: string
  profilePath?: string
  color: string
  workspaceRoot: string
  inboxDir: string
  terminalName: string
  terminal: Terminal
  createdAt: number
} | undefined {
  const entry = panel.pendingIssueCreations.get(nonce)
  if (entry)
    panel.pendingIssueCreations.delete(nonce)
  return entry
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
export function linkPendingTerminalToIssue(panel: KanbanWebviewPanel, nonce: string, issueNumber: number): void {
  const pending = panel.pendingIssueCreations.get(nonce)
  if (!pending)
    return
  panel.newIssueTerminals.set(issueNumber, pending.terminal)
  if (pending.sessionId && pending.sessionId.length > 0)
    panel.terminals.set(pending.sessionId, pending.terminal)
  trackSessionTerminal(panel, pending.terminal, issueNumber, 'brainstorm')
}
