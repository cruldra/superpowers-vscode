import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './index.css'

// ponytail: 无此 boundary 时，任意渲染异常都会让整个 React 树卸载成空白面板
// （用户报告"用着用着突然啥都没了"）。捕获后显示错误+重载按钮，免得只能整窗重载。
interface BoundaryState { error: Error | null }
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[superpowers webview] render crash:', error, info.componentStack)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error)
      return this.props.children
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center text-[var(--vscode-foreground)]">
        <div className="text-sm font-semibold text-[var(--vscode-errorForeground)]">面板渲染出错</div>
        <pre className="max-h-60 max-w-full overflow-auto whitespace-pre-wrap text-left text-xs text-[var(--vscode-descriptionForeground)]">
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded bg-[var(--vscode-button-background)] px-3 py-1 text-xs text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
        >
          重新加载
        </button>
      </div>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
