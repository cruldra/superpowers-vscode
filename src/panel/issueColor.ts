import { ThemeColor, Uri } from 'vscode'

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

/**
 * VS Code's default terminal-tab icon does NOT honor the `color` option on
 * `createTerminal`, and `ThemeIcon`'s color param is "currently only used in
 * TreeItem" (per the API docs). See https://github.com/microsoft/vscode/issues/171082.
 *
 * Workaround: build an inline SVG data URI with the fill color hardcoded, and
 * pass it as `iconPath`. This bypasses the entire ThemeColor pipeline.
 *
 * Mapping uses VS Code's built-in default terminal ANSI palette so the icon
 * matches what the user sees inside the terminal.
 */
const ANSI_HEX: Record<string, string> = {
  'terminal.ansiRed': '#cd3131',
  'terminal.ansiGreen': '#0dbc79',
  'terminal.ansiYellow': '#e5e510',
  'terminal.ansiBlue': '#2472c8',
  'terminal.ansiMagenta': '#bc3fbc',
  'terminal.ansiCyan': '#11a8cd',
  'terminal.ansiBrightRed': '#f14c4c',
  'terminal.ansiBrightGreen': '#23d18b',
  'terminal.ansiBrightYellow': '#f5f543',
  'terminal.ansiBrightBlue': '#3b8eea',
  'terminal.ansiBrightMagenta': '#d670d6',
  'terminal.ansiBrightCyan': '#29b8db',
}

/** Build an SVG data URI for a solid filled circle of the given hex color. */
function filledCircleUri(hex: string): Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${hex}"/></svg>`
  return Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`)
}

/**
 * Resolve a `terminal.ansi*` palette id to an SVG data URI suitable as
 * `createTerminal({ iconPath })`. Unknown ids fall back to a neutral grey
 * dot so we still render something visible.
 */
export function themeColorIdToIconUri(id: string): Uri {
  const hex = ANSI_HEX[id] ?? '#888888'
  return filledCircleUri(hex)
}
