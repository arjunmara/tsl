import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { runCommand } from '../../domain/commands'
import { serverNow } from '../../domain/clock'
import { messageFor, messages } from '../../domain/messages'
import { numberChoices, rightNumber, scorerData, scorerUrl, type Device, type ScorerData } from '../../domain/scorer'
import { linkToken, rememberLink } from '../../domain/teams'
import { newLink } from '../../domain/teamCode'
import { backIcon, DestructiveButton, IconButton, PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { Unavailable, UUID } from '../setup/Setup'
import { readHead } from './Home'

const POLL_MS = 3000
// The Scorer link's token is kept per Season on the phone that made it, as Registration link tokens are.
const keyFor = (seasonId: string) => `scorer:${seasonId}`

/** /t/:tournamentId/settings/scorers: the Season's Scorer link, phones asking for approval and approved phones. */
export function Scorers() {
  const { tournamentId = '' } = useParams()
  if (!UUID.test(tournamentId)) return <Unavailable />
  return <Manage key={tournamentId} tournamentId={tournamentId} />
}

function Manage({ tournamentId }: { tournamentId: string }) {
  const navigate = useNavigate()
  const [season, setSeason] = useState<string | 'missing' | null>(null)
  const [data, setData] = useState<ScorerData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  // The numbers offered for each request are made once, so they don't reshuffle on every read.
  const [choices, setChoices] = useState<Record<string, number[]>>({})
  const asked = useRef(new Set<string>())

  useEffect(() => {
    let live = true
    void readHead(tournamentId).then((h) => live && setSeason(typeof h === 'object' && h.season ? h.season.id : h === 'missing' ? 'missing' : null))
    return () => {
      live = false
    }
  }, [tournamentId])
  const seasonId = season && season !== 'missing' ? season : null

  useEffect(() => {
    if (!seasonId) return
    let live = true
    const read = () => void scorerData(seasonId).then(async (r) => {
      if (!live) return
      if ('code' in r) return setLoadError(r.code === 'offline' ? messages.offline : messages.scorers_unknown)
      for (const d of r.devices) {
        if (d.status === 'pending' && !asked.current.has(d.id)) {
          asked.current.add(d.id)
          void rightNumber(d).then((n) => n !== null && setChoices((c) => ({ ...c, [d.id]: numberChoices(n) })))
        }
      }
      if (!live) return
      setLoadError(null)
      setData(r)
    })
    read()
    // Polls every 3 s while open: a new request shows up on its own.
    const t = setInterval(read, POLL_MS)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [seasonId, attempt])

  /** Sends a command and says its refusal here. Returns the answer when it went through. */
  async function run(name: string, args: Record<string, unknown>) {
    if (!seasonId || busy) return null
    setBusy(true)
    setProblem(null)
    setNotice('')
    const r = await runCommand(name, { season_id: seasonId, ...args })
    setBusy(false)
    setAttempt((n) => n + 1)
    if (!r.ok) {
      setProblem(r.code === 'offline' ? `${messages.offline} This needs a signal.` : messageFor(r.code))
      return null
    }
    return r
  }

  async function share(link: string) {
    const text = 'Help me score our matches. Open this link, name your phone and show me the number on your screen.'
    try {
      if (navigator.share) return void (await navigator.share({ title: 'Score matches with TSL', text, url: link }))
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
    }
    try {
      await navigator.clipboard.writeText(link)
      setNotice('Scorer link copied. Paste it in a message to the Scorer.')
    } catch {
      setNotice('Copy the Scorer link above and send it to the Scorer.')
    }
  }

  async function create() {
    if (!seasonId) return
    const { token, hash } = await newLink()
    const r = await run('create_scorer_link', { token_hash: hash })
    if (!r) return
    rememberLink(keyFor(seasonId), token)
    rememberLink(`${keyFor(seasonId)}:hash`, hash)
    setNotice('Scorer link made. Any older link no longer works for new requests.')
  }

  async function revokeLink() {
    if (!seasonId || !(await run('revoke_scorer_link', {}))) return
    rememberLink(keyFor(seasonId), null)
    rememberLink(`${keyFor(seasonId)}:hash`, null)
    setNotice('The Scorer link no longer works. Phones already approved keep working until you revoke them.')
  }

  async function pick(d: Device, number: number) {
    const r = await run('approve_scorer_device', { device_id: d.id, number })
    if (r) setNotice(`${d.label} is approved to score.`)
  }

  async function revoke(d: Device) {
    if (await run('revoke_scorer_device', { device_id: d.id })) setNotice(`${d.label} can no longer score.`)
  }

  if (season === 'missing') return <Unavailable />
  const now = serverNow().getTime()
  const pending = data?.devices.filter((d) => d.status === 'pending' && Date.parse(d.expiresAt) > now) ?? []
  const phones = data?.devices.filter((d) => d.status === 'approved' || d.status === 'revoked') ?? []
  const own = seasonId ? linkToken(keyFor(seasonId)) : null
  // The link made on this phone, only while it is still the live one (another Organiser may have revoked or replaced it).
  const link = data?.hash && own && linkToken(`${keyFor(seasonId!)}:hash`) === data.hash ? scorerUrl(own) : null

  return (
    <main className="home">
      <header className="home-bar">
        <IconButton label="Back to settings" onClick={() => navigate(`/t/${tournamentId}/settings`)}>{backIcon}</IconButton>
        <h1 className="title home-title">Scorers</h1>
      </header>
      <div className="home-panel scorers">
        <p role="status" className="body">{notice}</p>
        <Problem text={problem} />
        {loadError ? (
          <>
            <Problem text={loadError} />
            <SecondaryButton label="Try loading the Scorers again" onClick={() => (setLoadError(null), setAttempt((n) => n + 1))} />
          </>
        ) : !data ? (
          <p className="body" aria-busy="true">Loading the Scorers…</p>
        ) : (
          <>
            <section className="card">
              <h2 className="body-strong">Scorer link</h2>
              <p className="body">
                A Scorer opens the link on their phone, names it and shows you a number. You tap the same number here to let that phone score.
              </p>
              {link && (
                <>
                  <label className="body-strong" htmlFor="scorer-link">Scorer link</label>
                  <input id="scorer-link" className="ui-input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
                  <SecondaryButton label="Share Scorer link" onClick={() => void share(link)} />
                </>
              )}
              {data.hash && !link && <p className="body">A Scorer link works. To share it from this phone, create a new one.</p>}
              {!data.hash && <p className="body">No Scorer link works yet.</p>}
              {data.hash ? <SecondaryButton label="Create Scorer link" onClick={() => void create()} />
                : <PrimaryButton label="Create Scorer link" onClick={() => void create()} />}
              {data.hash && (
                <DestructiveButton label="Revoke Scorer link" sheetTitle="Revoke the Scorer link?" before="Anyone with the link can ask to score"
                  after="The link stops working. Phones already approved keep scoring" actionLabel="Revoke Scorer link" onConfirm={() => void revokeLink()} />
              )}
            </section>
            <section>
              <h2 className="body-strong">Waiting for approval</h2>
              {pending.length ? (
                <ul className="cards">
                  {pending.map((d) => (
                    <li key={d.id} className="card">
                      <p className="body-strong">{d.label}</p>
                      <p className="body">Tap the number shown on {d.label}.</p>
                      <div className="scorer-numbers">
                        {choices[d.id]?.map((n) => (
                          <button key={n} type="button" className="ui-button ui-secondary display-lg scorer-number" aria-label={`Approve ${n}`}
                            onClick={() => void pick(d, n)}>{n}</button>
                        )) ?? <p className="body" aria-busy="true">Getting the numbers…</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p className="body">No phone is waiting.</p>}
            </section>
            <section>
              <h2 className="body-strong">Scorer phones</h2>
              {phones.length ? (
                <ul className="cards">
                  {phones.map((d) => (
                    <li key={d.id} className="card">
                      <p className="body">{d.label}{d.status === 'revoked' && ' · revoked'}</p>
                      {d.status === 'approved' && (
                        <DestructiveButton label={`Revoke ${d.label}`} sheetTitle={`Revoke ${d.label}?`} before={`${d.label} can score`}
                          after={`${d.label} can't score or read anything`} note="This is logged." actionLabel={`Revoke ${d.label}`} onConfirm={() => void revoke(d)} />
                      )}
                    </li>
                  ))}
                </ul>
              ) : <p className="body">No phone can score yet.</p>}
            </section>
          </>
        )}
      </div>
    </main>
  )
}
