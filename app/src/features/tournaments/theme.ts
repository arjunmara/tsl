// Per-device theme override. index.html applies the stored choice before first paint.
export type Theme = 'device' | 'light' | 'dark'

export function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme
  return t === 'light' || t === 'dark' ? t : 'device'
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'device') delete root.dataset.theme
  else root.dataset.theme = theme
  try {
    if (theme === 'device') localStorage.removeItem('theme')
    else localStorage.setItem('theme', theme)
  } catch {
    // Storage blocked: the choice still holds until the page is closed.
  }
}
