import { ThemeColor } from 'vscode'

// 12 saturated ansi colors, chosen for tab-icon contrast.
export const PALETTE = [
  'terminal.ansiRed',
  'terminal.ansiGreen',
  'terminal.ansiYellow',
  'terminal.ansiBlue',
  'terminal.ansiMagenta',
  'terminal.ansiCyan',
  'terminal.ansiBrightRed',
  'terminal.ansiBrightGreen',
  'terminal.ansiBrightYellow',
  'terminal.ansiBrightBlue',
  'terminal.ansiBrightMagenta',
  'terminal.ansiBrightCyan',
] as const

/** Pick a deterministic ThemeColor for an issue number. */
export function issueTerminalColor(issueNumber: number): ThemeColor {
  // Non-negative modulus.
  const idx = ((issueNumber % PALETTE.length) + PALETTE.length) % PALETTE.length
  return new ThemeColor(PALETTE[idx])
}

/** Pick a random palette entry id (string, not ThemeColor). */
export function pickRandomIssueColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)]
}

/**
 * Resolve which color to use for an issue based on the previously stored
 * value (if any). Returns the chosen palette id plus an `isNew` flag — when
 * `isNew` is true the caller is expected to persist the picked color back to
 * the issue's state JSON so subsequent sessions reuse it.
 */
export function resolveIssueColor(stored: string | undefined): { id: string; isNew: boolean } {
  if (stored && (PALETTE as readonly string[]).includes(stored))
    return { id: stored, isNew: false }
  return { id: pickRandomIssueColor(), isNew: true }
}
