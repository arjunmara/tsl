import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { runCommand } from '../../domain/commands'
import { messageFor, messages } from '../../domain/messages'
import { PrimaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { blocked, noop, useForm } from '../auth/form'
import { Problem, Screen } from '../auth/Screen'

const newIds = () => ({ command: crypto.randomUUID(), tournament: crypto.randomUUID(), season: crypto.randomUUID() })
// Code points, as the server's char_length counts them.
const checkName = (v: string) => ([...v.trim()].length <= 80 ? null : messages.name_long)
// The command may have run: retry with the same ids. Any other code is a definite refusal.
const maybeRan = ['offline', 'unknown', 'in_progress']

export function NewTournament() {
  const navigate = useNavigate()
  const { ref, showErrors, values } = useForm()
  // Kept across retries that may have reached the server, so a create is never made twice.
  const ids = useRef(newIds())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const v = values()
    if (!v || busy) return
    setBusy(true)
    setError(null)
    const { command, tournament, season } = ids.current
    const r = await runCommand('create_tournament', { tournament_id: tournament, season_id: season, name: v.name }, command)
    setBusy(false)
    if (r.ok) return navigate('/', { replace: true })
    if (!maybeRan.includes(r.code ?? '')) ids.current = newIds()
    setError(messageFor(r.code))
  }

  return (
    <Screen title="Create a new tournament">
      <form ref={ref} noValidate onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Field label="Tournament name" name="name" autoComplete="off" value="" onSave={noop} required validate={checkName} showErrors={showErrors} />
        <Problem text={error} />
        <PrimaryButton label="Create tournament" onClick={() => void submit()} {...blocked(busy && 'Creating the tournament…')} />
      </form>
      <p className="body"><Link to="/">Back to My tournaments</Link></p>
    </Screen>
  )
}
