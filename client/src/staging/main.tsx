import { startWebviewKeyboardFallback } from '../services/webviewKeyboardFallback'
import React from 'react'
import ReactDOM from 'react-dom/client'
import StagingWindow from './StagingWindow'
import '../index.css'

// 透明/撑满窗口的 shell 样式（原内联于 staging.html，迁移至此规避 vite html-proxy 的 junction 路径问题）
const style = document.createElement('style')
style.textContent = 'html, body, #root { margin: 0; padding: 0; height: 100%; overflow: hidden; }'
document.head.appendChild(style)

void startWebviewKeyboardFallback()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StagingWindow />
  </React.StrictMode>
)