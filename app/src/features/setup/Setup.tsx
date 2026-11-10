import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { forgetRefused, queuedFor, send, type OutboxEntry, type Upload } from '../../domain/commands'
import { messageFor, messages } from '../../domain/messages'
import {
  assetBucket, formatPresets, logoUrl, NEW_LINEUP, NEW_STRUCTURE, noteNewSeason, seasonSponsors, SETTINGS, tournamentSetup, type FormatPreset,
  type LineupRules, type MatchSettings, type SeasonAnswers, type Sponsor, type Structure,
} from '../../domain/tournaments'
import { SecondaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { useForm } from '../auth/form'
import { Problem } from '../auth/Screen'
import { brandDefaults, readable, resizeLogo, textColours } from './brand'
import { StepFour } from './Format'
import { Frame, SettingsMode, useLeave } from './Frame'
import { StepFive, StepSix } from './LineupStructure'
import { overlaySponsors, StepSeven } from './Sponsors'
import { StepThree, StepTwo } from './RulesDates'

export type Values = { name: string; primary: string; secondary: string; logoPath: string | null; logoBlob: Blob | null }
type Branding = { name?: string; brand_primary?: string; brand_secondary?: string; logo_path?: string }

// Code points, as the server's char_length counts them.
const checkName = (v: string) => ([...v].length <= 80 ? null : messages.name_long)

/** Applies this user's pending create and branding entries for the Tournament over the server's values, in order. */
export function overlay(base: Values, queued: OutboxEntry[]): Values {
  const v = { ...base }
  for (const e of queued) {
    const a = e.args as Branding
    if (e.name === 'create_tournament' && typeof a.name === 'string') v.name = a.name
    if (e.name !== 'set_tournament_branding') continue
    if (a.name != null) v.name = a.name
    if (a.brand_primary != null) v.primary = a.brand_primary
    if (a.brand_secondary != null) v.secondary = a.brand_secondary
    if (a.logo_path != null) {
      v.logoPath = a.logo_path || null
      v.logoBlob = e.upload?.path === a.logo_path ? e.upload.blob : null
    }
  }
  return v
}

const NEW_KEY = 'tsl-new-tournament'
type Ids = { tournamentId: string; seasonId: string }
function storedIds(): Ids | null {
  try {
    const ids = JSON.parse(sessionStorage.getItem(NEW_KEY) ?? 'null') as Ids | null
    return ids?.tournamentId && ids.seasonId ? ids : null
  } catch {
    return null
  }
}

/**
 * /new: step 1 before the Tournament exists. Its ids are made here once and kept in history.state and
 * sessionStorage, so a reload or a retry creates the same Tournament.
 */
export function NewTournament() {
  const navigate = useNavigate()
  const location = useLocation()
  const fromState = (location.state as { ids?: Ids } | null)?.ids
  const [ids] = useState<Ids>(() => fromState ?? storedIds() ?? { tournamentId: crypto.randomUUID(), seasonId: crypto.randomUUID() })
  useEffect(() => {
    try {
      sessionStorage.setItem(NEW_KEY, JSON.stringify(ids))
    } catch {
      // history.state still holds them.
    }
    if (!fromState) navigate('/new', { replace: true, state: { ids } })
  }, [ids, fromState, navigate])
  const [initial] = useState<Values>(() => {
    const d = brandDefaults()
    return { name: '', primary: d.primary, secondary: d.secondary, logoPath: null, logoBlob: null }
  })
  return <StepOne {...ids} initial={initial} isNew />
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Settings sections (/t/:id/settings/:section) and the wizard step each shows.
// Each: [section key, wizard step, its button label (verb + object)].
export const SECTIONS: [string, number, string][] = [['name', 1, 'Change name and logo'], ['rules', 2, 'Change description and rules'],
  ['dates', 3, 'Change dates'], ['format', 4, 'Change Format'], ['lineup', 5, 'Change Line-up rules'], ['structure', 6, 'Change Structure'],
  ['sponsors', 7, 'Change Sponsors']]

/** /t/:tournamentId/settings/:section: the wizard step in the settings frame, open whatever the setup progress. */
export function SettingsSection() {
  const { tournamentId = '', section } = useParams()
  const step = SECTIONS.find(([k]) => k === section)?.[1]
  if (!UUID.test(tournamentId)) return <Unavailable />
  if (!step) return <Navigate to={`/t/${tournamentId}/settings`} replace />
  return (
    <SettingsMode.Provider value>
      <LoadStep key={tournamentId} tournamentId={tournamentId} step={step} />
    </SettingsMode.Provider>
  )
}

/** /t/:tournamentId/setup/:step: steps 1–7. */
export function SetupStep() {
  const { tournamentId = '', step: raw } = useParams()
  const step = Number(raw)
  if (!UUID.test(tournamentId)) return <Unavailable />
  if (!Number.isInteger(step) || step < 1 || step > 7) return <Navigate to={`/t/${tournamentId}/setup/1`} replace />
  return <LoadStep key={tournamentId} tournamentId={tournamentId} step={step} />
}

export function Unavailable() {
  const navigate = useNavigate()
  return (
    <main className="screen">
      <Problem text={messages.tournament_missing} />
      <SecondaryButton label="Back to My tournaments" onClick={() => navigate('/', { replace: true })} />
    </main>
  )
}

type Base = {
  seasonId: string; values: Values; answers: SeasonAnswers; settings: MatchSettings; lineup: LineupRules; structure: Structure; setupStep: number
}
type Loaded = {
  step: number; seasonId: string; initial: Values; answers: SeasonAnswers; settings: MatchSettings; lineup: LineupRules; structure: Structure
  presets: FormatPreset[]; setupStep: number; sponsors: Sponsor[]; blobs: Record<string, Blob>
}

const noAnswers: SeasonAnswers = { description: '', rules: '', photo_consent: '', starts_on: '', ends_on: '', registration_deadline: '' }
const SEASON_EDITS = ['set_season_rules', 'set_season_dates']
const noSettings = Object.fromEntries(SETTINGS.map((k) => [k, null])) as MatchSettings

/** Applies this user's pending Match settings edits in order: a preset replaces every setting, then single values. */
function overlaySettings(base: MatchSettings, queued: OutboxEntry[], presets: FormatPreset[]): MatchSettings {
  let v = { ...base }
  for (const e of queued) {
    if (e.name !== 'set_match_settings') continue
    const p = presets.find((x) => x.key === e.args.format_preset)
    if (p) v = { ...p.settings }
    for (const k of SETTINGS) if (k !== 'format_preset' && e.args[k] != null) v = { ...v, [k]: e.args[k] }
  }
  return v
}

/** Applies this user's pending edits of one command over base, in order: each argument base has replaces its value. */
function overlayCommand<T extends object>(base: T, queued: OutboxEntry[], command: string): T {
  let v = base
  for (const e of queued) {
    if (e.name !== command) continue
    for (const k of Object.keys(base)) if (e.args[k] != null) v = { ...v, [k]: e.args[k] }
  }
  return v
}

/** Applies this user's pending Season edits over the Season's answers, in order. */
function overlayAnswers(base: SeasonAnswers, queued: OutboxEntry[]): SeasonAnswers {
  const v = { ...base }
  for (const e of queued) {
    if (!SEASON_EDITS.includes(e.name)) continue
    for (const k of Object.keys(v) as (keyof SeasonAnswers)[]) if (typeof e.args[k] === 'string') v[k] = e.args[k]
  }
  return v
}

/**
 * Reads the Tournament on every step, then lays this device's pending changes over it; a pending create needs no
 * server, and offline the last read stands in. A step beyond the furthest finished one + 1 (counting pending
 * set_setup_step) goes back to step 1.
 */
// The last server read per Tournament: offline, the next step shows it (each step remounts on navigation).
// ponytail: kept for this page load only; a reload offline shows "Can't reach the server".
const lastRead = new Map<string, Base>()

function LoadStep({ tournamentId, step }: { tournamentId: string; step: number }) {
  const settings = useContext(SettingsMode)
  const [loaded, setLoaded] = useState<Loaded | 'missing' | null>(null)
  const [problem, setProblem] = useState<{ step: number; text: string } | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    const queuedStep = (q: OutboxEntry[]) =>
      Math.max(0, ...q.filter((e) => e.name === 'set_setup_step').map((e) => Number(e.args.step) || 0))
    // Steps 4 and 5 need the presets (from the device when offline); other steps only refresh the device's copy.
    const presetsRead = formatPresets()
    let presets: FormatPreset[] = []
    // Step 7 also lays the pending Sponsor commands over the Season's Sponsors (none for a Season not on the server).
    const show = (b: Base, queued: OutboxEntry[], sponsors: Sponsor[] = []) => live && setLoaded({
      ...overlaySponsors(sponsors, queued, b.seasonId), step, seasonId: b.seasonId, initial: overlay(b.values, queued), answers: overlayAnswers(b.answers, queued),
      settings: overlaySettings(b.settings, queued, presets), lineup: overlayCommand(b.lineup, queued, 'set_lineup_rules'),
      structure: overlayCommand(b.structure, queued, 'set_structure'), presets, setupStep: Math.max(b.setupStep, queuedStep(queued)),
    })
    void (async () => {
      if (step === 4 || step === 5) {
        const p = await presetsRead
        if (!live) return
        // Step 5 only takes its default numbers from them, so it opens without.
        if (!p && step === 4) return setProblem({ step, text: navigator.onLine ? messages.tournament_unknown : messages.offline })
        presets = p ?? []
      }
      const d = brandDefaults()
      const defaults: Values = { name: '', primary: d.primary, secondary: d.secondary, logoPath: null, logoBlob: null }
      const pending = await queuedFor(tournamentId)
      const create = pending.find((e) => e.name === 'create_tournament')
      if (create) {
        // Not on the server yet (or on its way): no need to wait for a read that may not answer offline.
        // Its Season starts at version 1, even if the page closed before the create's first answer.
        const seasonId = String(create.args.season_id)
        await noteNewSeason(seasonId)
        return show({ seasonId, values: defaults, answers: noAnswers, settings: noSettings, lineup: NEW_LINEUP, structure: NEW_STRUCTURE, setupStep: 0 }, pending)
      }
      const r = await tournamentSetup(tournamentId)
      if (!live) return
      if ('code' in r) {
        const last = lastRead.get(tournamentId)
        if (r.code === 'offline' && last) {
          const sp = step === 7 ? await seasonSponsors(last.seasonId) : { sponsors: [] }
          if (!live) return
          if ('code' in sp) return setProblem({ step, text: messages.offline })
          return show(last, await queuedFor(tournamentId), sp.sponsors)
        }
        return setProblem({ step, text: r.code === 'offline' ? messages.offline : messages.tournament_unknown })
      }
      const t = r.tournament
      if (!t || !t.season) return setLoaded('missing')
      let sponsors: Sponsor[] = []
      if (step === 7) {
        const sp = await seasonSponsors(t.season.id)
        if (!live) return
        if ('code' in sp) return setProblem({ step, text: sp.code === 'offline' ? messages.offline : messages.sponsors_unknown })
        sponsors = sp.sponsors
      }
      const base: Base = {
        seasonId: t.season.id, answers: t.season.answers, settings: t.season.settings, lineup: t.season.lineup, structure: t.season.structure,
        setupStep: t.season.setupStep,
        values: { name: t.name, primary: t.brandPrimary ?? d.primary, secondary: t.brandSecondary ?? d.secondary, logoPath: t.logoPath, logoBlob: null },
      }
      // Entries pending before the read and gone after it may have been applied after the read answered: count
      // both lists, so neither a value nor a finished step is lost in that gap.
      const after = await queuedFor(tournamentId)
      lastRead.set(tournamentId, base)
      show(base, [...new Map([...pending, ...after].map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq), sponsors)
    })()
    return () => {
      live = false
    }
  }, [tournamentId, step, attempt])

  const back = useLeave(tournamentId, step)
  if (loaded === 'missing') return step === 1 || settings ? <Unavailable /> : <Navigate to={`/t/${tournamentId}/setup/1`} replace />
  const ready = loaded?.step === step ? loaded : null
  const failed = problem?.step === step && !ready ? problem.text : null
  if (ready && !settings && step > ready.setupStep + 1) return <Navigate to={`/t/${tournamentId}/setup/1`} replace />
  const props = ready && { tournamentId, seasonId: ready.seasonId, initial: ready.answers }
  if (ready && step === 1) return <StepOne tournamentId={tournamentId} seasonId={ready.seasonId} initial={ready.initial} />
  if (props && step === 2) return <StepTwo {...props} />
  if (props && step === 3) return <StepThree {...props} />
  if (ready && step === 4) return <StepFour tournamentId={tournamentId} seasonId={ready.seasonId} initial={ready.settings} presets={ready.presets} />
  if (ready && step === 5) {
    return <StepFive tournamentId={tournamentId} seasonId={ready.seasonId} initial={ready.lineup}
      defaults={ready.presets.find((p) => p.key === ready.settings.format_preset)?.lineup} />
  }
  if (ready && step === 6) return <StepSix tournamentId={tournamentId} seasonId={ready.seasonId} initial={ready.structure} />
  if (ready && step === 7) return <StepSeven tournamentId={tournamentId} seasonId={ready.seasonId} initial={ready.sponsors} blobs={ready.blobs} />
  return (
    <Frame step={step} onBack={back}>
      {failed ? (
        <>
          <Problem text={failed} />
          <SecondaryButton label="Try loading again" onClick={() => (setProblem(null), setAttempt((n) => n + 1))} />
        </>
      ) : (
        <div aria-busy="true">
          <p className="ui-visually-hidden">Loading</p>
          <div className="skeleton-card" />
        </div>
      )}
    </Frame>
  )
}

/**
 * Step 1, Name & logo. Each answer saves when the field is left, through the outbox; the outbox fills in
 * expected_version when it sends. isNew (on /new): the first name sends create_tournament, and colours or a logo
 * chosen before that wait and follow it.
 */
function StepOne({ tournamentId, seasonId, initial, isNew = false }: { tournamentId: string; seasonId: string; initial: Values; isNew?: boolean }) {
  const navigate = useNavigate()
  const leave = useLeave(tournamentId, 1)
  const { ref, showErrors, values } = useForm()
  const [v, setV] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [logoError, setLogoError] = useState<string | null>(null)
  const saved = useRef(initial)
  // On /new: 'no' until the first name, 'pending' while create_tournament is on its first try.
  const created = useRef<'no' | 'pending' | 'yes'>(isNew ? 'no' : 'yes')
  // Only the latest logo pick counts, even if an older, slower resize finishes after it.
  const logoPick = useRef(0)
  const creating = useRef<Promise<void>>(Promise.resolve())
  const draft = useRef<{ fields: Branding; upload?: Upload }>({ fields: {} })
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const [t] = useState(textColours)
  const look = readable(v.primary, t)
  const chip = readable(v.secondary, t)
  // ponytail: object URLs of picked logos are not revoked; a handful per visit.
  const blobUrl = useMemo(() => (v.logoBlob ? URL.createObjectURL(v.logoBlob) : null), [v.logoBlob])
  const logoSrc = blobUrl ?? (v.logoPath ? logoUrl(v.logoPath) : null)

  function save(fields: Branding, upload?: Upload) {
    if (created.current !== 'yes') {
      if (created.current === 'no' && fields.name !== undefined) return void create(fields.name)
      Object.assign(draft.current.fields, fields)
      if (fields.logo_path !== undefined) draft.current.upload = upload
      return
    }
    void send('set_tournament_branding', { tournament_id: tournamentId, ...fields },
      { scope: tournamentId, versionOf: tournamentId, ...(upload ? { upload } : {}) })
  }

  function create(name: string) {
    created.current = 'pending'
    setError(null)
    // Queued now: a later "Create new tournament" must not reuse these ids (history.state still holds them here).
    try {
      sessionStorage.removeItem(NEW_KEY)
    } catch {
      // Nothing stored.
    }
    creating.current = (async () => {
      const r = await send('create_tournament', { tournament_id: tournamentId, season_id: seasonId, name }, { scope: tournamentId })
      if (!r.ok && r.code !== 'queued') {
        // A definite refusal: shown here, so it needn't wait in the queue. The same ids are used next time; a
        // rename typed while it was on its way was part of that refused name, so it goes too.
        created.current = 'no'
        delete draft.current.fields.name
        if (r.commandId) void forgetRefused(r.commandId)
        saved.current = { ...saved.current, name: '' }
        if (alive.current) setError(messageFor(r.code))
        return
      }
      created.current = 'yes'
      // The new Season's edits replay from version 1 even if this create is still queued.
      await noteNewSeason(seasonId)
      const { fields, upload } = draft.current
      draft.current = { fields: {} }
      // A logo picked and removed before the create needs nothing on the server.
      if (fields.logo_path === '') delete fields.logo_path
      if (Object.keys(fields).length) save(fields, upload)
      if (alive.current) navigate(`/t/${tournamentId}/setup/1`, { replace: true })
    })()
  }

  function saveName(name: string) {
    if (name === saved.current.name) return
    saved.current = { ...saved.current, name }
    setV((x) => ({ ...x, name }))
    save({ name })
  }

  function saveColour(key: 'primary' | 'secondary', value: string) {
    if (value === saved.current[key]) return
    saved.current = { ...saved.current, [key]: value }
    save(key === 'primary' ? { brand_primary: value } : { brand_secondary: value })
  }

  async function pickLogo(file: File | undefined) {
    if (!file) return
    const pick = ++logoPick.current
    setLogoError(null)
    let blob: Blob
    try {
      blob = await resizeLogo(file)
    } catch (e) {
      if (pick === logoPick.current) setLogoError(e instanceof RangeError ? messages.image_too_large : messages.logo_unreadable)
      return
    }
    if (pick !== logoPick.current) return
    const path = `${tournamentId}/logo-${crypto.randomUUID()}.webp`
    setV((x) => ({ ...x, logoPath: path, logoBlob: blob }))
    save({ logo_path: path }, { bucket: assetBucket, path, blob, contentType: blob.type || 'image/webp' })
  }

  function removeLogo() {
    logoPick.current++
    setV((x) => ({ ...x, logoPath: null, logoBlob: null }))
    save({ logo_path: '' })
  }

  async function goNext() {
    const form = values()
    if (!form) return
    saveName(form.name ?? '')
    await creating.current
    if (created.current !== 'yes') return
    void send('set_setup_step', { season_id: seasonId, step: 1 }, { scope: tournamentId })
    navigate(`/t/${tournamentId}/setup/2`, { replace: true })
  }

  const fileId = useId()
  return (
    <Frame step={1} onBack={leave} onNext={() => void goNext()}>
      <div className="wizard-body">
        <form ref={ref} noValidate className="wizard-fields" onSubmit={(e) => (e.preventDefault(), void goNext())}>
          <Field label="Tournament name" name="name" autoComplete="off" value={v.name} onSave={saveName} required
            requiredMessage={messages.name_required} validate={checkName} showErrors={showErrors} />
          <Problem text={error} />
          <div className="ui-field">
            <span className="body-strong">Logo</span>
            {logoSrc && <img className="logo-preview" src={logoSrc} alt="Logo preview" />}
            {/* Camera or gallery; the visible label is the button, the input keeps the focus (outline via CSS). */}
            <input id={fileId} className="ui-visually-hidden file-input" type="file" accept="image/*"
              onChange={(e) => (void pickLogo(e.target.files?.[0]), (e.target.value = ''))} />
            <label htmlFor={fileId} className="ui-button ui-secondary file-button">Choose a logo</label>
            {logoSrc && <SecondaryButton label="Remove logo" onClick={removeLogo} />}
            <Problem text={logoError} />
          </div>
          <ColourField label="Main colour" value={v.primary} onInput={(primary) => setV((x) => ({ ...x, primary }))}
            onSave={(c) => saveColour('primary', c)} />
          {look.adjusted && <Swatches chosen={v.primary} panel={look.panel} />}
          <ColourField label="Second colour" value={v.secondary} onInput={(secondary) => setV((x) => ({ ...x, secondary }))}
            onSave={(c) => saveColour('secondary', c)} />
          {chip.adjusted && <Swatches chosen={v.secondary} panel={chip.panel} />}
        </form>
        <figure className="sample" style={{ background: v.primary }}>
          <figcaption className="meta sample-caption">Sample Graphic</figcaption>
          <div className="sample-panel" style={{ background: look.panel, color: look.text }}>
            {logoSrc ? <img className="sample-logo" src={logoSrc} alt="" />
              : <span className="sample-logo sample-initial" aria-hidden="true">{[...v.name.trim()][0]?.toUpperCase() ?? ''}</span>}
            <p className="sample-name">{v.name.trim() || 'Your tournament'}</p>
            <p className="sample-result">
              Team A <span className="sample-score" style={{ background: chip.panel, color: chip.text }}>3 – 1</span> Team B
            </p>
          </div>
        </figure>
      </div>
    </Frame>
  )
}

/** The chosen colour beside the darker one used behind text, and why. */
function Swatches({ chosen, panel }: { chosen: string; panel: string }) {
  return (
    <div className="swatches">
      <span className="meta swatch-row"><span className="swatch" style={{ background: chosen }} />Your colour</span>
      <span className="meta swatch-row"><span className="swatch" style={{ background: panel }} />Behind text</span>
      <p className="meta">Darkened behind text so it stays readable.</p>
    </div>
  )
}

/** A native colour picker; the sample follows every move, the choice saves on change or blur. */
export function ColourField({ label, value, onInput, onSave }: { label: string; value: string; onInput: (v: string) => void; onSave: (v: string) => void }) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const save = useRef(onSave)
  useEffect(() => {
    save.current = onSave
  })
  // React's onChange follows every input event; the native change fires once the picker closes.
  useEffect(() => {
    const el = input.current!
    const h = () => save.current(el.value)
    el.addEventListener('change', h)
    return () => el.removeEventListener('change', h)
  }, [])
  return (
    <div className="ui-field">
      <label htmlFor={id} className="body-strong">{label}</label>
      <input ref={input} id={id} type="color" className="colour-input" value={value}
        onChange={(e) => onInput(e.target.value)} onBlur={(e) => onSave(e.target.value)} />
    </div>
  )
}
