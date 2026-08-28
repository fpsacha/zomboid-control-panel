import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import './i18n'
import { isDemoMode, installDemoFetchShim } from './lib/demo'
import { BuildCompatibilityGate } from './components/BuildCompatibilityGate'

const Router = isDemoMode() ? HashRouter : BrowserRouter

if (isDemoMode()) {
  installDemoFetchShim()
  if (!window.location.hash) {
    window.location.hash = '#/'
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Router>
      <BuildCompatibilityGate>
        <App />
      </BuildCompatibilityGate>
    </Router>
  </React.StrictMode>,
)
