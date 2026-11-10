import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { forgetRefused, send } from '../../domain/commands'
import { messageFor, messages } from '../../domain/messages'
import { newLink } from '../../domain/teamCode'
import { linkToken, registrationUrl, rememberLink, type Team } from '../../domain/teams'
import { backIcon, DestructiveButton, IconButton, PrimaryButton, SecondaryButton } from '../../ui/Button'
import { KitDot } from '../../ui/KitDot'
import { StatusPill } from '../../ui/StatusPill'
import { Problem } from '../auth/Screen'
import { Unavailable, UUID } from '../setup/Setup'
import { readHead, type Head } from './Home'
import { shareLink, teamStatusLabel, useTeams } from './Teams'

/** /t/:tournamentId/teams/:teamId: one Team, its Registration link (share, reissue, revoke). */
export function TeamPage() {
  const { tournamentId = '', teamId = '' } = useParams()
  const navigate = useNavigate()
  const [head, setHead] = useState<Head | 'missing' | 'offline' | 'unknown' | null>(null)
  useEffect(() => {
    let live = true
    void readHead(tournamentId).then((h) => live && setHead(h))
    return () => {
      live = false
    }
  }, [tournamentId])
  if (!UUID.test(tournamentId) || !UUID.test(teamId) || head === 'missing') return <Unavailable />
  if (head && typeof head === 'object') return <OneTeam key={teamId} tournamentId={tournamentId} teamId={teamId} h={head} />
  return (
    <main className="home">
      <IconButton label="Back to Teams" onClick={() => navigate(`/t/${tournamentId}`, { state: { tab: 'teams' } })}>{backIcon}</IconButton>
      {head ? <Problem text={head === 'offline' ? messages.offline : messages.tournament_unknown} />
        : <p className="body" aria-busy="true">Loading the Team…</p>}
    </main>
  )
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

  if (Array.isArray(teams) && !team) return <Unavailable />

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
    <main className="home">
      <header className="home-bar">
        <IconButton label="Back to Teams" onClick={back}>{backIcon}</IconButton>
        <h1 className="title home-title">{team?.name ?? 'Team'}</h1>
      </header>
      <div className="home-panel team-page">
        <p role="status" className="body">{notice}</p>
        <Problem text={problem} />
        {!Array.isArray(teams) ? (
          teams ? (
            <>
              <Problem text={teams === 'offline' ? messages.offline : messages.teams_unknown} />
              <SecondaryButton label="Try loading again" onClick={retry} />
            </>
          ) : <p className="body" aria-busy="true">Loading the Team…</p>
        ) : team && (
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
          </>
        )}
      </div>
    </main>
  )
}
