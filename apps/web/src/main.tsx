import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import App from './App.tsx'
import hrIcon from '../../../data/icons8-home-run-96.png'

function setFavicon(iconUrl: string) {
  const head = document.head
  let link = head.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    head.appendChild(link)
  }
  link.type = 'image/png'
  link.href = iconUrl
}

// Set tab icon + title early so it applies immediately on load.
setFavicon(hrIcon)
document.title = 'analytichustle'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
