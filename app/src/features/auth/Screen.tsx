import type { ReactNode } from 'react'

export function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="screen">
      <h1 className="title">{title}</h1>
      {children}
    </main>
  )
}

/** A failure in words, announced when it appears. */
export function Problem({ text }: { text: string | null }) {
  return text ? <p role="alert" className="body-strong ui-error">{text}</p> : null
}
