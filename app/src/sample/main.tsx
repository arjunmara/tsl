import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../ui/tokens.css'
import './sample.css'
import { TokenSample } from './TokenSample'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenSample />
  </StrictMode>,
)
