/**
 * In-memory ring buffer for diagnostic log entries.
 *
 * Both the extension host and the webview share access to these entries
 * via the panel's message bridge; the webview surfaces them in a modal
 * opened from the IssueDetailPanel. Entries are also mirrored to the
 * Extension Host console so they remain visible during local debugging.
 *
 * No filesystem persistence — buffer is capped at the last 500 entries
 * and lost on extension reload.
 */

import type { Event } from 'vscode'
import { EventEmitter } from 'vscode'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  /** Milliseconds since epoch. */
  ts: number
  level: LogLevel
  /** Short tag identifying the subsystem (e.g. 'webhook', 'gitea'). */
  source: string
  message: string
  /** Optional extra blob, newline-safe (stack trace, JSON snippet, etc.). */
  details?: string
}

class Logger {
  private buf: LogEntry[] = []
  private readonly cap = 500
  private readonly emitter = new EventEmitter<LogEntry>()

  readonly onEntry: Event<LogEntry> = this.emitter.event

  /**
   * Record a new entry. Stamps with the current time, trims the buffer to
   * the last `cap` entries, fires the change event, and mirrors to the
   * Extension Host console.
   */
  add(entry: Omit<LogEntry, 'ts'>): void {
    const full: LogEntry = { ...entry, ts: Date.now() }
    this.buf.push(full)
    if (this.buf.length > this.cap)
      this.buf.splice(0, this.buf.length - this.cap)

    const line = `[${full.source}] ${full.message}`
    // Mirror to Extension Host console for parity with existing console.warn/error.
    // eslint-disable-next-line no-console
    if (full.level === 'error')
      console.error(line, full.details ?? '')
    // eslint-disable-next-line no-console
    else if (full.level === 'warn')
      console.warn(line, full.details ?? '')
    // eslint-disable-next-line no-console
    else
      console.log(line, full.details ?? '')

    this.emitter.fire(full)
  }

  /** Returns a copy of the current buffer (newest entry last). */
  snapshot(): LogEntry[] {
    return this.buf.slice()
  }

  /** Clears the buffer in place. Webview clearing broadcasts a separate event. */
  clear(): void {
    this.buf = []
  }
}

export const logger = new Logger()
