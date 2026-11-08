import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { forgetRefused, send } from '../../domain/commands'
import { messageFor, messages } from '../../domain/messages'
import { PrimaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { blocked, noop, useForm } from '../auth/form'
import { Problem, Screen } from '../auth/Screen'

// Code points, as the server's char_length counts them.
const checkName = (v: string) => ([...v.trim()].length <= 80 ? null : messages.name_long)

export function NewTournament() {
  const navigate = useNavigate()
  const { ref, showErrors, values } = useForm()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const v = values()
    if (!v || busy) return
    setBusy(true)
    setError(null)
    // send() retries with the same ids, so each submit is a new tournament.
    const tournament = crypto.randomUUID()
    const r = await send('create_tournament', { tournament_id: tournament, season_id: crypto.randomUUID(), name: v.name }, { scope: tournament })
    setBusy(false)
    // Queued: it sends when the signal is back; My tournaments shows it as waiting.
    if (r.ok || r.code === 'queued') return navigate('/', { replace: true })
    // A definite refusal: shown here, so it needn't wait in the queue as failed.
    if (r.commandId) void forgetRefused(r.commandId)
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
