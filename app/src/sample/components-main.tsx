import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../ui/tokens.css'
import './sample.css'
import { ComponentSample } from './ComponentSample'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ComponentSample />
  </StrictMode>,
)
