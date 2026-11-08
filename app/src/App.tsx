import { databaseRef } from './domain/env'

export function App() {
  const ref = databaseRef()
  return (
    <main style={{ padding: 'var(--spacing-gutter)' }}>
      <h1 className="title">Tamghas Super League</h1>
      <p className="body">{ref ? `Database: ${ref}` : 'No database configured'}</p>
    </main>
  )
}
