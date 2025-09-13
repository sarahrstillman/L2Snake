import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'

;(window as any).POOL = import.meta.env.VITE_POOL_ADDRESS

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

