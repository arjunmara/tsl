import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { queuedFor } from '../../domain/commands'
import { messages } from '../../domain/messages'
import { logoUrl, tournamentSetup, type SeasonAnswers, type SeasonSummary } from '../../domain/tournaments'
import { backIcon, IconButton, PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { SaveStatusBar } from '../save-status/SaveStatusBar'
import { overlay, Unavailable, UUID } from '../setup/Setup'
import { statusLabel } from '../tournaments/MyTournaments'
import { TeamPage } from './TeamPage'
import { Teams } from './Teams'

export type Head = { name: string; logoPath: string | null; logoBlob: Blob | null; season: SeasonSummary & { answers: SeasonAnswers } }

// The last server read per Tournament, so the home opens offline after one visit in this page load.
const lastHead = new Map<string, Head>()

/** The Tournament's name and logo (with this device's pending changes laid over) and its latest Season. */
export async function readHead(id: string): Promise<Head | 'missing' | 'offline' | 'unknown'> {
  const r = await tournamentSetup(id)
  let head: Head | undefined
  if ('code' in r) head = r.code === 'offline' ? lastHead.get(id) : undefined
  else if (r.tournament?.season) {
    const t = r.tournament
    head = { name: t.name, logoPath: t.logoPath, logoBlob: null, season: t.season! }
    lastHead.set(id, head)
  } else return 'missing'
  if (!head) return 'code' in r ? r.code : 'unknown'
  const queued = await queuedFor(id)
  const v = overlay({ name: head.name, primary: '', secondary: '', logoPath: head.logoPath, logoBlob: head.logoBlob }, queued)
  // A finished step still waiting to send counts, as in the wizard.
  const step = Math.max(head.season.setupStep, ...queued.filter((e) => e.name === 'set_setup_step').map((e) => Number(e.args.step) || 0))
  // Season answers still waiting to send count too (the Teams tab needs the consent statement and dates).
  const answers = { ...head.season.answers }
  for (const e of queued) {
    if (e.args.season_id !== head.season.id || (e.name !== 'set_season_rules' && e.name !== 'set_season_dates')) continue
    for (const k of Object.keys(answers) as (keyof SeasonAnswers)[]) {
      const x = e.args[k]
      if (typeof x === 'string') answers[k] = x
    }
  }
  return { ...head, name: v.name, logoPath: v.logoPath, logoBlob: v.logoBlob, season: { ...head.season, setupStep: step, answers } }
}

// The Matches tab once setup is finished, until the Draw and fixtures arrive (Epic 3).
const matchesText: Record<SeasonSummary['status'], string> = {
  setup: 'Setup is finished. Add your Teams on the Teams tab to open registration.',
  registration: 'Record the draw once registration closes.',
  started: 'Matches come in a later update.',
  finished: 'This Season is finished.',
}

const TABS = [['matches', 'Matches'], ['teams', 'Teams'], ['graphics', 'Graphics']] as const
type Tab = (typeof TABS)[number][0]
const tabKey = (id: string) => `tsl-tab:${id}`
function storedTab(id: string): Tab {
  try {
    const v = localStorage.getItem(tabKey(id))
    return TABS.find(([k]) => k === v)?.[0] ?? 'matches'
  } catch {
    return 'matches'
  }
}

const gearIcon = (
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
  </>
)

/** /t/:tournamentId: the Tournament home. App bar (logo, name, Season switcher, Settings) and the three tabs. */
export function Home() {
  const { tournamentId = '' } = useParams()
  if (!UUID.test(tournamentId)) return <><SaveStatusBar /><Unavailable /></>
  return <LoadHome key={tournamentId} tournamentId={tournamentId} />
}

function LoadHome({ tournamentId }: { tournamentId: string }) {
  const navigate = useNavigate()
  // An open Team (/t/:id/teams/:teamId) shows inside the Teams tab.
  const { teamId } = useParams()
  const [head, setHead] = useState<Head | 'missing' | 'offline' | 'unknown' | null>(null)
  const [attempt, setAttempt] = useState(0)
  // The wizard's end opens Teams (state.tab), and that becomes the remembered tab.
  const location = useLocation()
  const wanted = (location.state as { tab?: string } | null)?.tab
  const asked = TABS.find(([k]) => k === wanted)?.[0]
  const [chosen, setTab] = useState<Tab>(() => asked ?? storedTab(tournamentId))
  const tab = teamId ? 'teams' : chosen
  useEffect(() => {
    if (!asked) return
    try {
      localStorage.setItem(tabKey(tournamentId), asked)
    } catch {
      // Only remembering the tab is lost.
    }
    // Used once: a reload keeps history.state, and must not override the tab picked since.
    navigate(location.pathname, { replace: true, state: null })
  }, [asked, tournamentId, navigate, location.pathname])
  const ids = useId()
  useEffect(() => {
    let live = true
    void readHead(tournamentId).then((h) => live && setHead(h))
    return () => {
      live = false
    }
  }, [tournamentId, attempt])
  const h = head && typeof head === 'object' ? head : null
  // ponytail: one object URL per pending logo shown, not revoked.
  const blob = h?.logoBlob ?? null
  const blobUrl = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob])

  if (head === 'missing') return <><SaveStatusBar /><Unavailable /></>

  function choose(k: Tab, focus = false) {
    setTab(k)
    if (teamId && k !== 'teams') navigate(`/t/${tournamentId}`)
    try {
      localStorage.setItem(tabKey(tournamentId), k)
    } catch {
      // Only remembering the tab is lost.
    }
    if (focus) document.getElementById(`${ids}-tab-${k}`)?.focus()
  }
  function keys(e: KeyboardEvent) {
    const i = TABS.findIndex(([k]) => k === tab)
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1 + TABS.length, Home: 0, End: TABS.length - 1 }[e.key]
    if (to === undefined || e.altKey || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    choose(TABS[to % TABS.length]![0], true)
  }

  const logo = blobUrl ?? (h?.logoPath ? logoUrl(h.logoPath) : null)
  return (
    <main className="home">
      <header className="home-bar">
        <IconButton label="Back to My tournaments" onClick={() => navigate('/')}>{backIcon}</IconButton>
        {h ? (
          <div className="home-title">
            {logo ? <img className="home-logo" src={logo} alt="" />
              : <span className="home-logo home-initial" aria-hidden="true">{[...h.name][0]?.toUpperCase()}</span>}
            <div>
              <h1 className="body-strong">{h.name}</h1>
              <details className="season-switch">
                <summary className="meta">Season {h.season.number} · {statusLabel[h.season.status]} <span aria-hidden="true">▾</span></summary>
                <div className="account-panel">
                  <p className="body">Season {h.season.number} is this Tournament's current Season.</p>
                  <p className="meta">Past Seasons and new Seasons come in a later update.</p>
                </div>
              </details>
            </div>
          </div>
        ) : <div className="home-title" />}
        <IconButton label="Open settings" onClick={() => navigate(`/t/${tournamentId}/settings`)}>{gearIcon}</IconButton>
        <SaveStatusBar />
      </header>
      {!h ? (
        head ? (
          <>
            <Problem text={head === 'offline' ? messages.offline : messages.tournament_unknown} />
            <SecondaryButton label="Try loading again" onClick={() => (setHead(null), setAttempt((n) => n + 1))} />
          </>
        ) : (
          <div aria-busy="true">
            <p className="ui-visually-hidden">Loading</p>
            <div className="skeleton-card" />
          </div>
        )
      ) : (
        <>
          <div role="tablist" aria-label="Tournament" className="tab-bar" onKeyDown={keys}>
            {TABS.map(([k, label]) => (
              <button key={k} type="button" role="tab" id={`${ids}-tab-${k}`} aria-selected={tab === k} aria-controls={`${ids}-panel`}
                tabIndex={tab === k ? 0 : -1} className="tab body-strong" onClick={() => choose(k)}>{label}</button>
            ))}
          </div>
          <section role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${tab}`} tabIndex={0} className="home-panel">
            {tab === 'matches' && (h.season.status === 'setup' && h.season.setupStep < 7 ? (
              <>
                <p className="body">Setup of Season {h.season.number} is at step {h.season.setupStep + 1} of 7.</p>
                <PrimaryButton label="Continue setup" onClick={() => navigate(`/t/${tournamentId}/setup/${h.season.setupStep + 1}`)} />
              </>
            ) : <p className="body">{matchesText[h.season.status]}</p>)}
            {tab === 'teams' && (teamId ? (
              // Side by side on a laptop; on a phone only the open Team.
              <div className="teams-split">
                <div className="teams-side">
                  <Teams tournamentId={tournamentId} head={h} openId={teamId} onSeasonChange={() => setAttempt((n) => n + 1)} />
                </div>
                <TeamPage tournamentId={tournamentId} teamId={teamId} h={h} />
              </div>
            ) : <Teams tournamentId={tournamentId} head={h} onSeasonChange={() => setAttempt((n) => n + 1)} />)}
            {tab === 'graphics' && (
              <>
                <p className="body">Each Graphic says what it needs before it can be made.</p>
                <p className="meta">Graphics come in a later update.</p>
              </>
            )}
          </section>
        </>
      )}
    </main>
  )
}
