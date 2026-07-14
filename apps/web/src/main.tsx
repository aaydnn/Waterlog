import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './app'
import './ui/tokens.css'

registerSW({ immediate: true })

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
