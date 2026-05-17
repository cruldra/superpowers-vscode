import { ThemeColor } from 'vscode'

// 12 saturated ansi colors, chosen for tab-icon contrast.
const PALETTE = [
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
