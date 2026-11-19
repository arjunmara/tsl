import { useId, useRef, useState } from 'react'
import { forgetRefused, queuedFor, send } from '../../domain/commands'
import { serverNow } from '../../domain/clock'
import { inZone } from '../../domain/format'
import { messageFor, messages } from '../../domain/messages'
import { importBase, noteNew, squadLimit } from '../../domain/registration'
import { CSV_TEMPLATE, planImport, summary, teamLine, type Plan } from '../../domain/teamCsv'
import { newLink } from '../../domain/teamCode'
import { rememberLink } from '../../domain/teams'
import { PrimaryButton } from '../../ui/Button'
import { blocked } from '../auth/form'
import { Problem } from '../auth/Screen'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
/** "Import 8 teams and 80 players": what the file changes, as a button label. */
const importLabel = (p: Plan) => {
  const teams = p.newTeams + p.changedTeams
  const players = p.newPlayers + p.changedPlayers
  return `Import ${[teams && plural(teams, 'team'), players && plural(players, 'player')].filter(Boolean).join(' and ')}`
}

/**
 * "Import teams from a CSV file" on the Teams tab: reads the file on this phone, shows what it would add and change, and
 * sends the usual Team and Squad commands through the outbox in file order (so it works offline). Nothing is removed.
 */
export function TeamImport({ tournamentId, seasonId, seasonStatus, onSeasonChange, onSent }: { tournamentId: string; seasonId: string; seasonStatus: string; onSeasonChange: () => void; onSent: (notice: string) => void }) {
  const inputId = useId()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const sending = useRef(false)

  async function pick(file: File | undefined) {
    if (!file) return
    setPlan(null)
    setProblem(null)
    setLoading(true)
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      const base = await importBase(seasonId, await queuedFor(tournamentId))
      const lim = await squadLimit(seasonId)
      const fail = (code: string) => setProblem(code === 'offline' ? messages.offline : messages.team_import_unknown)
      if ('code' in base) return fail(base.code)
      if ('code' in lim) return fail(lim.code)
      setPlan(planImport(text, base.teams, inZone(serverNow()).date, lim.limit))
    } catch {
      setProblem(messages.team_import_unreadable)
    } finally {
      setLoading(false)
    }
  }

  /** Sends one command in the Tournament's scope; returns the refusal in words (dropped from the queue), else null. */
  async function run(name: string, args: Record<string, unknown>, versionOf?: string) {
    const r = await send(name, args, { scope: tournamentId, ...(versionOf ? { versionOf } : {}) })
    if (r.ok || r.code === 'queued') return { queued: r.code === 'queued', problem: null }
    if (r.commandId) void forgetRefused(r.commandId)
    return { queued: false, problem: r.code === 'lineup_violation' && r.message ? r.message : messageFor(r.code) }
  }

  async function sendAll() {
    if (!plan || plan.errors.length || sending.current) return
    sending.current = true
    setBusy(true)
    setProblem(null)
    let queued = false
    const go = async (name: string, args: Record<string, unknown>, versionOf?: string) => {
      const r = await run(name, args, versionOf)
      queued ||= r.queued
      if (r.problem) throw new Error(r.problem)
    }
    try {
      // As "Add this Team" does: the first Team of a Season in setup opens registration (not while an open is already waiting).
      if (seasonStatus === 'setup' && plan.newTeams && !(await queuedFor(tournamentId)).some((e) => e.name === 'open_registration')) {
        await go('open_registration', { season_id: seasonId })
        onSeasonChange()
      }
      for (const t of plan.teams) {
        let teamId = t.id
        if (!teamId) {
          teamId = crypto.randomUUID()
          const linkId = crypto.randomUUID()
          const { token, hash } = await newLink()
          rememberLink(linkId, token)
          await noteNew(teamId)
          try {
            await go('add_team', { season_id: seasonId, team_id: teamId, name: t.name, code: t.code, link_id: linkId, token_hash: hash })
          } catch (e) {
            rememberLink(linkId, null)
            throw e
          }
          if (t.kit) await go('edit_team', { team_id: teamId, kit_colour: t.kit }, teamId)
        } else if (t.nameChanged || t.kitChanged) {
          await go('edit_team', { team_id: teamId, ...(t.nameChanged ? { name: t.name } : {}), ...(t.kitChanged && t.kit ? { kit_colour: t.kit } : {}) }, teamId)
        }
        for (const p of t.players) {
          if (!p.id) {
            const id = crypto.randomUUID()
            await noteNew(id)
            await go('add_player', { team_id: teamId, player_id: id, name: p.name, shirt_number: p.shirt, date_of_birth: p.dob, consent: false })
          } else if (p.shirtChanged || p.dobChanged) {
            await go('edit_player', { team_id: teamId, player_id: p.id, ...(p.shirtChanged ? { shirt_number: p.shirt } : {}), ...(p.dobChanged ? { date_of_birth: p.dob } : {}) }, p.id)
          }
        }
      }
    } catch (e) {
      // Whatever was sent before the refusal stays sent; choosing the file again shows what is left to do.
      setPlan(null)
      setProblem(`${e instanceof Error ? e.message : messages.team_import_failed} The import stopped there. Choose the file again to see what is left.`)
      onSent('')
      return
    } finally {
      sending.current = false
      setBusy(false)
    }
    setPlan(null)
    onSent(queued ? `${messages.offline} The import will be sent when the signal is back.` : `Imported: ${summary(plan)}`)
  }

  const changes = plan ? plan.newTeams + plan.changedTeams + plan.newPlayers + plan.changedPlayers : 0
  return (
    <section className="teams-import" aria-label="Import from a CSV file">
      <input id={inputId} className="ui-visually-hidden file-input" type="file" accept=".csv,text/csv" disabled={busy || loading}
        onChange={(ev) => (void pick(ev.target.files?.[0]), (ev.target.value = ''))} />
      <label htmlFor={inputId} className="ui-button ui-secondary file-button" aria-disabled={busy || loading || undefined}>
        {plan ? 'Choose another file' : loading ? 'Reading the file…' : 'Import teams from a CSV file'}
      </label>
      {!plan && <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(CSV_TEMPLATE)}`} download="teams-template.csv">Download the CSV template</a>}
      <Problem text={problem} />
      {plan && (
        <div className="card" role="status">
          {plan.errors.length ? (
            <>
              <p className="body-strong">Fix these in the file, then choose it again.</p>
              <ul>{plan.errors.map((e) => <li key={e}>{e}</li>)}</ul>
            </>
          ) : (
            <>
              <p className="body-strong">{summary(plan)}</p>
              <ul>{plan.teams.map((t) => <li key={t.code}>{teamLine(t)}</li>)}</ul>
            </>
          )}
        </div>
      )}
      {plan && !plan.errors.length && changes > 0 && (
        <PrimaryButton label={importLabel(plan)} onClick={() => void sendAll()} {...blocked(busy && 'Sending the import…')} />
      )}
      {plan && plan.errors.length > 0 && <PrimaryButton label="Import teams and players" disabled disabledReason="Fix the rows listed above first." />}
    </section>
  )
}
