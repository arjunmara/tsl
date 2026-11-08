import { Link } from 'react-router'
import { Screen } from '../auth/Screen'

// Placeholder: Story 1.6 creates the Tournament here.
export function NewTournament() {
  return (
    <Screen title="Create a new tournament">
      <p className="body">Creating a tournament arrives in the next update.</p>
      <p className="body"><Link to="/">Back to My tournaments</Link></p>
    </Screen>
  )
}
