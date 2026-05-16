/**
 * Tiny typed bridge over the `acquireVsCodeApi()` postMessage channel.
 *
 * The webview gets exactly one chance to call `acquireVsCodeApi()` per
 * lifetime, so we cache the handle module-side. When running outside the
 * VS Code host (e.g. `vite dev`) we fall back to no-op stubs.
 */

import type { ExtensionToWebview, WebviewToExtension } from './messages'

interface VsCodeApi {
  postMessage: (msg: WebviewToExtension) => void
  getState: <T = unknown>() => T | undefined
  setState: <T = unknown>(state: T) => void
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi
  }
}

const api: VsCodeApi = window.acquireVsCodeApi?.() ?? {
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
}

export function postMessage(msg: WebviewToExtension): void {
  api.postMessage(msg)
}

export function onMessage(handler: (msg: ExtensionToWebview) => void): () => void {
  const listener = (ev: MessageEvent): void => {
    handler(ev.data as ExtensionToWebview)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
