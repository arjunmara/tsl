import { databaseRef } from './domain/env'

export function App() {
  const ref = databaseRef()
  return (
    <main>
      <h1>Tamghas Super League</h1>
      <p>{ref ? `Database: ${ref}` : 'No database configured'}</p>
    </main>
  )
}
