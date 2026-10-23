import { startWebviewKeyboardFallback } from '../services/webviewKeyboardFallback'
import React from 'react'
import ReactDOM from 'react-dom/client'
import StagingWindow from './StagingWindow'
import '../index.css'

void startWebviewKeyboardFallback()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StagingWindow />
  </React.StrictMode>
)