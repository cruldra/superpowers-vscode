/**
 * Typed wrapper around the `claude` CLI in `-p` (one-shot) mode with
 * `--output-format json`. We rely on `claude` being available on PATH;
 * callers should surface the install-hint error message to the user when
 * ENOENT is raised.
 *
 * Two execution paths share the same output-parsing logic:
 *
 * - **Text-only** (no images): plain `claude -p "<prompt>" --output-format json`
 *   via `execFile`. Simple and identical to v1 behaviour.
 *
 * - **With images**: switch to `claude -p --input-format stream-json
 *   --output-format json` via `spawn`, then feed a single NDJSON line on
 *   stdin containing the user message with text + image content blocks
 *   (Anthropic Messages API shape). The official docs state single-message
 *   input does NOT support image attachments — stream-json is the only
 *   supported path. See:
 *   https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
 */

import { execFile, spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_BUFFER_BYTES = 10 * 1024 * 1024

export interface ClaudeImage {
  /** e.g. "image/png", "image/jpeg", "image/webp", "image/gif" */
  mediaType: string
  /** Raw base64 (no `data:...;base64,` prefix) */
  base64: string
}

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

function buildStreamJsonLine(prompt: string, images: ClaudeImage[]): string {
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: prompt },
  ]
  for (const img of images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.base64,
      },
    })
  }
  const message = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  }
  return `${JSON.stringify(message)}\n`
}

export async function spawnClaude(opts: {
  prompt: string
  cwd: string
  timeoutMs?: number
  images?: ClaudeImage[]
}): Promise<ClaudeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const hasImages = !!opts.images && opts.images.length > 0

  if (!hasImages) {
    return spawnClaudeText(opts.prompt, opts.cwd, timeoutMs)
  }
  return spawnClaudeStreamed(opts.prompt, opts.cwd, timeoutMs, opts.images!)
}

function spawnClaudeText(
  prompt: string,
  cwd: string,
  timeoutMs: number,
): Promise<ClaudeResult> {
  const args = [
    '--dangerously-skip-permissions',
    '-p',
    prompt,
    '--output-format',
    'json',
  ]

  return new Promise<ClaudeResult>((resolve, reject) => {
    const child = execFile(
      'claude',
      args,
      {
        cwd,
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
    void child
  })
}

function spawnClaudeStreamed(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  images: ClaudeImage[],
): Promise<ClaudeResult> {
  // Local Claude Code v2.1.143 enforces that --input-format=stream-json must
  // be paired with --output-format=stream-json (the friendlier `--output-format
  // json` is rejected). The output is NDJSON; extractClaudePayload walks lines
  // from the end to find the final result-shaped object.
  const args = [
    '--dangerously-skip-permissions',
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ]
  const ndjson = buildStreamJsonLine(prompt, images)

  return new Promise<ClaudeResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let settled = false

    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      if (settled)
        return
      settled = true
      child.kill('SIGKILL')
      reject(new ClaudeTimeoutError(
        `Claude 调用超时（${Math.round(timeoutMs / 1000)}s）`,
        stderr,
      ))
    }, timeoutMs)

    child.on('error', (err) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      const errCode = (err as NodeJS.ErrnoException).code
      if (errCode === 'ENOENT') {
        reject(new ClaudeError(
          '未检测到 claude CLI，请确认已安装并在 PATH 中',
          stderr,
        ))
        return
      }
      reject(new ClaudeError(
        `Claude 调用失败: ${err.message}`,
        stderr,
      ))
    })

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_BUFFER_BYTES) {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        child.kill('SIGKILL')
        reject(new ClaudeError(
          `Claude 输出超过 ${MAX_BUFFER_BYTES} bytes`,
          stderr,
        ))
        return
      }
      stdout += chunk.toString('utf8')
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('close', (code) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new ClaudeError(
          `Claude 退出码非零 (${code}): ${stderr.trim() || '(无 stderr)'}`,
          stderr,
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
    })

    // Send the single NDJSON line and close stdin so claude knows the user
    // turn is complete. If the child has already exited (e.g. arg validation
    // failed), stdin will EPIPE — swallow it; the 'close' handler will surface
    // the real error from stderr + exit code.
    child.stdin.on('error', () => { /* ignore EPIPE / ECONNRESET */ })
    try {
      child.stdin.write(ndjson)
      child.stdin.end()
    }
    catch {
      // child already gone; close handler will run with the error code.
    }
  })
}
