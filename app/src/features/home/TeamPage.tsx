import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { forgetRefused, queuedFor, send } from '../../domain/commands'
import { overlayForm, teamForm, type RegistrationForm } from '../../domain/registration'
import { messageFor, messages } from '../../domain/messages'
import { newLink } from '../../domain/teamCode'
import { linkToken, registrationUrl, rememberLink, type Team } from '../../domain/teams'
import { backIcon, DestructiveButton, IconButton, PrimaryButton, SecondaryButton } from '../../ui/Button'
import { KitDot } from '../../ui/KitDot'
import { StatusPill } from '../../ui/StatusPill'
import { Problem } from '../auth/Screen'
import { ClosedTeam, TeamEditor } from '../register/Register'
import { UUID } from '../setup/Setup'
import type { Head } from './Home'
import { shareLink, teamStatusLabel, useTeams } from './Teams'

/**
 * /t/:tournamentId/teams/:teamId, inside the Tournament home's Teams tab: one Team, its Registration link (share,
 * reissue, revoke) and the Team manager's form sections, which an Organiser fills from a paper sheet (Story 2.6).
 */
export function TeamPage({ tournamentId, teamId, h }: { tournamentId: string; teamId: string; h: Head }) {
  if (!UUID.test(teamId)) return <Problem text={messages.team_missing} />
  return <OneTeam key={teamId} tournamentId={tournamentId} teamId={teamId} h={h} />
}

function OneTeam({ tournamentId, teamId, h }: { tournamentId: string; teamId: string; h: Head }) {
  const navigate = useNavigate()
  const { teams, reload, retry } = useTeams(tournamentId, h.season.id)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const team = Array.isArray(teams) ? teams.find((t) => t.id === teamId) : undefined
  const canReissue = h.season.status === 'setup' || h.season.status === 'registration'
  const back = () => navigate(`/t/${tournamentId}`, { state: { tab: 'teams' } })


  async function run(name: string, args: Record<string, unknown>, onRefused?: () => void) {
    setProblem(null)
    setNotice('')
    setBusy(true)
    const r = await send(name, { season_id: h.season.id, ...args }, { scope: tournamentId })
    setBusy(false)
    if (!r.ok && r.code !== 'queued') {
      if (r.commandId) void forgetRefused(r.commandId)
      onRefused?.()
      setProblem(messageFor(r.code))
      return null
    }
    reload()
    return r
  }

  async function reissue(t: Team) {
    if (busy) return
    const linkId = crypto.randomUUID()
    const { token, hash } = await newLink()
    rememberLink(linkId, token)
    const r = await run('reissue_registration_link', { team_id: t.id, link_id: linkId, token_hash: hash }, () => rememberLink(linkId, null))
    if (!r) return
    setNotice(r.code === 'queued' ? `${messages.offline} The new link works once it's sent; share it now or later.`
      : t.linkId ? 'New link made. The old link no longer works.' : 'New link made. Share it with the Team manager.')
  }

  async function revoke(t: Team) {
    if (!t.linkId || busy) return
    const r = await run('revoke_registration_link', { link_id: t.linkId })
    if (!r) return
    // Forgotten only once the server has it: a queued revoke refused later leaves the link working and shareable here.
    if (r.ok) rememberLink(t.linkId, null)
    setNotice(r.code === 'queued' ? `${messages.offline} The link stops working once this is sent.` : `The link for ${t.name} no longer works.`)
  }

  const token = team ? linkToken(team.linkId) : null
  return (
    <div className="team-pane">
      <header className="team-bar">
        <IconButton label="Back to Teams" onClick={back}>{backIcon}</IconButton>
        <h2 className="title">{team?.name ?? 'Team'}</h2>
      </header>
      <div className="team-page">
        <p role="status" className="body">{notice}</p>
        <Problem text={problem} />
        {!Array.isArray(teams) ? (
          teams ? (
            <>
              <Problem text={teams === 'offline' ? messages.offline : messages.teams_unknown} />
              <SecondaryButton label="Try loading again" onClick={retry} />
            </>
          ) : <p className="body" aria-busy="true">Loading the Team…</p>
        ) : !team ? <Problem text={messages.team_missing} /> : (
          <>
            <p className="team-name">
              <KitDot colour={team.kitColour} />
              <span className="body">Team code {team.code}</span>
              <StatusPill state={team.status === 'approved' ? 'done' : 'pending'} label={teamStatusLabel[team.status]} />
            </p>
            <section className="card">
              <h2 className="body-strong">Registration link</h2>
              {token ? (
                <>
                  <label className="meta" htmlFor="team-link">Registration link for {team.name}</label>
                  <input id="team-link" className="ui-input" readOnly value={registrationUrl(token)} onFocus={(e) => e.currentTarget.select()} />
                  <SecondaryButton label="Share link" onClick={() => void shareLink(team, token, h).then(setNotice)} />
                </>
              ) : team.linkId ? (
                <p className="body">This phone doesn't have this Team's link. It stays on the phone that made it. Make a new link to share it from here; the old link then stops working.</p>
              ) : <p className="body">This Team has no working link.</p>}
              {canReissue && (team.linkId ? (
                <DestructiveButton label={token ? 'Reissue link' : 'Make a new link'} sheetTitle={`Make a new link for ${team.name}?`}
                  before="The current link lets the Team manager register" after="The current link stops working and the new link replaces it"
                  actionLabel="Make a new link" onConfirm={() => void reissue(team)} />
              ) : <PrimaryButton label="Make a new link" onClick={() => void reissue(team)} />)}
              {team.linkId && (
                <DestructiveButton label="Revoke link" sheetTitle={`Revoke the link for ${team.name}?`} before="The link lets the Team manager register"
                  after="The link stops working. You can make a new link later" actionLabel="Revoke link" onConfirm={() => void revoke(team)} />
              )}
              {!canReissue && <p className="meta">New links can't be made once the Season has started.</p>}
            </section>
            <TeamSheet seasonId={h.season.id} teamId={team.id} />
          </>
        )}
      </div>
    </div>
  )
}

/** The Team's form as its manager sees it, read through the Organiser's membership; as text once the Season has started. */
function TeamSheet({ seasonId, teamId }: { seasonId: string; teamId: string }) {
  const [form, setForm] = useState<RegistrationForm | 'missing' | 'offline' | 'unknown' | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    void load(seasonId, teamId).then((f) => live && setForm(f))
    return () => {
      live = false
    }
  }, [seasonId, teamId, attempt])
  if (form === null) return <p className="body" aria-busy="true">Loading the Players and Staff…</p>
  if (typeof form === 'string') {
    return (
      <>
        <Problem text={form === 'offline' ? messages.offline : form === 'missing' ? messages.team_missing : messages.team_form_unknown} />
        <SecondaryButton label="Try loading the Team again" onClick={() => (setForm(null), setAttempt((n) => n + 1))} />
      </>
    )
  }
  return form.seasonStatus === 'setup' || form.seasonStatus === 'registration'
    ? <Editor key={attempt} initial={form} load={async () => { const f = await load(seasonId, teamId); return typeof f === 'string' ? null : f }} />
    : <ClosedTeam form={form} />
}

async function load(seasonId: string, teamId: string) {
  const r = await teamForm(seasonId, teamId)
  return 'form' in r ? overlayForm(r.form, await queuedFor(teamId)) : r.code
}

function Editor({ initial, load }: { initial: RegistrationForm; load: () => Promise<RegistrationForm | null> }) {
  const [form, setForm] = useState(initial)
  return <TeamEditor form={form} setForm={setForm} load={load} />
}
