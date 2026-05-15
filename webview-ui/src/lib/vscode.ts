import type { ExtensionToWebview, WebviewToExtension } from '../types'

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

const api = window.acquireVsCodeApi?.() ?? {
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
