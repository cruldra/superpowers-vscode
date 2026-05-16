/**
 * Typed wrapper around the `claude` CLI in `-p` (one-shot) mode with
 * `--output-format json`. We rely on `claude` being available on PATH;
 * callers should surface the install-hint error message to the user when
 * ENOENT is raised.
 */

import { execFile } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_BUFFER_BYTES = 10 * 1024 * 1024

export interface ClaudeResult {
  sessionId: string
  resultText: string
  rawJson: string
}

export class ClaudeError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message)
    this.name = 'ClaudeError'
  }
}

export class ClaudeTimeoutError extends ClaudeError {
  constructor(message: string, stderr: string) {
    super(message, stderr)
    this.name = 'ClaudeTimeoutError'
  }
}

interface ParsedClaudeJson {
  session_id: string
  result: string
}

function tryParseClaudeJson(text: string): ParsedClaudeJson | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return null
  }
  if (
    parsed
    && typeof parsed === 'object'
    && 'result' in parsed
    && 'session_id' in parsed
  ) {
    const obj = parsed as Record<string, unknown>
    if (typeof obj.result === 'string' && typeof obj.session_id === 'string') {
      return { session_id: obj.session_id, result: obj.result }
    }
  }
  return null
}

function extractClaudePayload(stdout: string): ParsedClaudeJson | null {
  const trimmed = stdout.trim()
  if (!trimmed)
    return null
  const direct = tryParseClaudeJson(trimmed)
  if (direct)
    return direct

  // Fallback: streaming JSON (one object per line). Walk from the end to
  // find the last line that parses with the right shape.
  const lines = trimmed.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line)
      continue
    const candidate = tryParseClaudeJson(line)
    if (candidate)
      return candidate
  }
  return null
}

export async function spawnClaude(opts: {
  prompt: string
  cwd: string
  timeoutMs?: number
}): Promise<ClaudeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const args = [
    '--dangerously-skip-permissions',
    '-p',
    opts.prompt,
    '--output-format',
    'json',
  ]

  return new Promise<ClaudeResult>((resolve, reject) => {
    const child = execFile(
      'claude',
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env },
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          const errCode = (error as NodeJS.ErrnoException).code
          if (errCode === 'ENOENT') {
            reject(new ClaudeError(
              '未检测到 claude CLI，请确认已安装并在 PATH 中',
              stderr ?? '',
            ))
            return
          }
          // execFile sets `killed` when timeout fires; `signal` is also set.
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed
          if (killed || errCode === 'ETIMEDOUT') {
            reject(new ClaudeTimeoutError(
              `Claude 调用超时（${Math.round(timeoutMs / 1000)}s）`,
              stderr ?? '',
            ))
            return
          }
          reject(new ClaudeError(
            `Claude 调用失败: ${error.message}`,
            stderr ?? '',
          ))
          return
        }

        const payload = extractClaudePayload(stdout)
        if (!payload) {
          reject(new ClaudeError(
            'Claude 返回异常: 无法解析 JSON 输出',
            stdout,
          ))
          return
        }
        resolve({
          sessionId: payload.session_id,
          resultText: payload.result,
          rawJson: stdout,
        })
      },
    )
    // The execFile callback handles all completion paths; nothing else to do
    // with `child` here (timeout is honored by execFile itself).
    void child
  })
}
