import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { forgetRefused, send, type Upload } from '../../domain/commands'
import { formatDay, inZone } from '../../domain/format'
import { removeBackground } from '../../domain/cutout'
import { downloadAsPng, encodeImage, resizeImage, toCanvas } from '../../domain/image'
import { messageFor, messages } from '../../domain/messages'
import {
  DOCUMENT_TYPES, documentLabel, isMinor, noteNew, photoBucket, scanBucket, signScan, type Eligibility, type Photo, type RegistrationForm, type SquadPlayer, type StaffMember,
} from '../../domain/registration'
import { serverNow } from '../../domain/clock'
import { STAFF_ROLES } from '../../domain/tournaments'
import { DestructiveButton, PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { StatusPill } from '../../ui/StatusPill'
import { blocked, useForm } from '../auth/form'
import { Problem } from '../auth/Screen'

/** Sends one Squad command for the Team (after its file, if any); returns the refusal in words (dropped from the queue), else null. */
type Run = (name: string, args: Record<string, unknown>, versionOf?: string, upload?: Upload) => Promise<string | null>
const roleLabel = (k: string) => STAFF_ROLES.find(([r]) => r === k)?.[1] ?? k
const today = () => inZone(serverNow()).date
const SHIRT = /^\d{1,2}$/
const checkName = (v: string) => (v.length > 80 ? messages.name_long : null)
const checkDob = (v: string) => (v < '1940-01-01' || v > today() ? messages.dob_invalid : null)
const consentLine = (p: SquadPlayer) => (p.consent ? `photo consent: ${p.givenBy ?? ''}` : 'no photo consent')
/** Anything a family can ask the Organiser to delete (Story 2.10). */
const hasPersonal = ({ dateOfBirth, photo, givenBy, eligibility: e }: SquadPlayer) =>
  !!(dateOfBirth || photo || givenBy || e?.documentNumber || e?.scanName)
/** "EMIS number added" once type, number and scan are all given; else what is still needed. */
const documentLine = ({ eligibility: e }: SquadPlayer) =>
  (e?.documentType && e.documentNumber && e.scanName ? `${documentLabel(e.documentType)} added` : 'document still needed')
// Control characters a file name may carry are dropped; the server takes at most 120 characters.
// eslint-disable-next-line no-control-regex
const fileName = (f: File) => Array.from(f.name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim()).slice(0, 120).join('') || 'document'

/**
 * Players, Staff and "Send this Team for review" on the open Registration link form (Story 2.3). Each change is a
 * command through the outbox (scope: the Team); the server checks the Line-up rules and says why in words.
 */
export function Squad({ form, reload }: { form: RegistrationForm; reload: () => Promise<void> }) {
  const teamId = form.team.id
  const run: Run = async (name, args, versionOf, upload) => {
    const r = await send(name, { team_id: teamId, ...args }, { scope: teamId, ...(versionOf ? { versionOf } : {}), ...(upload ? { upload } : {}) })
    void reload()
    // A conflict waits in the hand-back sheet (Keep theirs / Send mine); any other refusal is said here and dropped.
    if (r.ok || r.code === 'queued' || r.code === 'version_conflict') return null
    if (r.commandId) void forgetRefused(r.commandId)
    if (r.uploadFailed) return upload?.bucket === photoBucket ? messages.photo_upload_failed : messages.scan_upload_failed
    return r.code === 'lineup_violation' && r.message ? r.message : messageFor(r.code)
  }
  const { starters, maxBench } = form.rules
  return (
    <>
      <section className="card squad">
        <h2 className="body-strong">Players · {form.players.length}</h2>
        {starters !== null && maxBench !== null && (
          <p className="meta">From {starters} to {starters + maxBench} Players: {starters} starters and up to {maxBench} on the bench.</p>
        )}
        {form.players.map((p) => <PlayerCard key={p.id} player={p} form={form} run={run} />)}
        <AddPlayer form={form} run={run} />
      </section>
      <section className="card squad">
        <h2 className="body-strong">Staff · {form.staff.length}</h2>
        {form.staff.map((s) => <StaffCard key={s.id} staff={s} form={form} run={run} />)}
        <AddStaff form={form} run={run} />
      </section>
      <Submit form={form} run={run} />
    </>
  )
}

/** The photo-consent statement and its tick box. */
function ConsentBox({ form, checked, onChange }: { form: RegistrationForm; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <fieldset className="choices">
      <legend className="body-strong">Photo consent</legend>
      {form.rules.consentStatement && <p className="body">{form.rules.consentStatement}</p>}
      <label className="choice body">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        Photo consent given
      </label>
    </fieldset>
  )
}

/** Who gives consent: a parent or guardian for a minor (under 18 today), else the person giving it. */
const givenByField = (minor: boolean) => minor
  ? { label: "Parent or guardian's name", requiredMessage: messages.guardian_required }
  : { label: 'Name of the person giving consent', requiredMessage: messages.consent_name_required }

const shirtCheck = (players: SquadPlayer[], self?: string) => (v: string) => {
  if (!SHIRT.test(v) || Number(v) < 1) return messages.shirt_invalid
  const other = players.find((p) => p.id !== self && p.shirtNumber === Number(v))
  return other ? `Shirt number ${v} is already used by ${other.name}. Choose another number.` : null
}

function AddPlayer({ form, run }: { form: RegistrationForm; run: Run }) {
  const { ref, showErrors, values } = useForm()
  const [key, setKey] = useState(0)
  const [dob, setDob] = useState('')
  const [consent, setConsent] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const who = givenByField(isMinor(dob))

  async function add() {
    const v = values()
    if (!v || busy) return
    setBusy(true)
    setProblem(null)
    const id = crypto.randomUUID()
    await noteNew(id)
    const name = v['player-name']!
    const p = await run('add_player', { player_id: id, name, shirt_number: Number(v['shirt-number']), date_of_birth: v['date-of-birth'],
      consent, ...(consent ? { given_by: v['given-by'] } : {}) })
    setBusy(false)
    if (p) return setProblem(p)
    setNotice(`${name} added.`)
    setDob('')
    setConsent(false)
    setKey((n) => n + 1)
  }

  return (
    <form key={key} ref={ref} noValidate className="squad-add" onSubmit={(e) => (e.preventDefault(), void add())}>
      <h3 className="body-strong">Add player</h3>
      <p role="status" className="body">{notice}</p>
      <Field label="Player's name" name="player-name" value="" onSave={() => {}} required requiredMessage={messages.player_name_required}
        validate={checkName} showErrors={showErrors} autoComplete="off" />
      <Field label="Shirt number" name="shirt-number" value="" onSave={() => {}} required requiredMessage={messages.shirt_required}
        validate={shirtCheck(form.players)} showErrors={showErrors} inputMode="numeric" autoComplete="off" />
      <Field label="Date of birth" name="date-of-birth" type="date" value={dob} onSave={setDob} required requiredMessage={messages.dob_required}
        validate={checkDob} showErrors={showErrors} min="1940-01-01" max={today()} hint={formatDay} />
      <ConsentBox form={form} checked={consent} onChange={setConsent} />
      {consent && <Field label={who.label} name="given-by" value="" onSave={() => {}} required requiredMessage={who.requiredMessage}
        validate={checkName} showErrors={showErrors} autoComplete="off" />}
      <Problem text={problem} />
      <PrimaryButton label="Add this Player" onClick={() => void add()} {...blocked(busy && 'Adding the Player…')} />
    </form>
  )
}

/** One Player: a summary line that opens the card; each field saves on leaving it. */
function PlayerCard({ player: p, form, run }: { player: SquadPlayer; form: RegistrationForm; run: Run }) {
  const [problem, setProblem] = useState<string | null>(null)
  const [consent, setConsent] = useState(p.consent)
  const [prop, setProp] = useState(p.consent)
  const [missing, setMissing] = useState(false)
  // A new date of birth that makes a consenting adult a minor waits for the guardian's name; both go in one change.
  const [heldDob, setHeldDob] = useState<string | null>(null)
  // A new read replaces the tick, unless the person ticked it and still owes the name.
  if (p.consent !== prop) {
    setProp(p.consent)
    if (!missing) setConsent(p.consent)
  }
  const who = givenByField(isMinor(heldDob ?? p.dateOfBirth))

  function saveDob(date_of_birth: string) {
    if (p.consent && isMinor(date_of_birth) && !isMinor(p.dateOfBirth)) return (setHeldDob(date_of_birth), setMissing(true))
    setHeldDob(null)
    void save({ date_of_birth })
  }
  const save = async (args: Record<string, unknown>) => setProblem(await run('edit_player', { player_id: p.id, ...args }, p.id))

  function tick(v: boolean) {
    setConsent(v)
    setProblem(null)
    if (!v) return (setMissing(false), setHeldDob(null), p.consent && void save({ consent: false, ...(heldDob ? { date_of_birth: heldDob } : {}) }))
    if (p.givenBy) return void save({ consent: true, given_by: p.givenBy })
    setMissing(true) // the name field asks for it; leaving it filled in saves both
  }

  return (
    <details className="squad-card">
      <summary>
        <span className="body-strong">{p.name} · #{p.shirtNumber}</span>
        <span className="meta"> {consentLine(p)} · {documentLine(p)}</span>
      </summary>
      <Field label="Player's name" value={p.name} onSave={(name) => void save({ name })} required requiredMessage={messages.player_name_required}
        validate={checkName} autoComplete="off" />
      <Field label="Shirt number" value={String(p.shirtNumber)} onSave={(v) => void save({ shirt_number: Number(v) })} required
        requiredMessage={messages.shirt_required} validate={shirtCheck(form.players, p.id)} inputMode="numeric" autoComplete="off" />
      <Field label="Date of birth" type="date" value={p.dateOfBirth} onSave={saveDob} required
        requiredMessage={messages.dob_required} validate={checkDob} min="1940-01-01" max={today()} hint={formatDay} />
      <ConsentBox form={form} checked={consent} onChange={tick} />
      {consent && <Field key={heldDob ? 'guardian' : 'giver'} label={who.label} value={p.consent && !heldDob ? p.givenBy ?? '' : ''} required
        requiredMessage={who.requiredMessage} validate={checkName} showErrors={missing} autoComplete="off"
        onSave={(given_by) => (setMissing(false), setHeldDob(null),
          void save({ consent: true, given_by, ...(heldDob ? { date_of_birth: heldDob } : {}) }))} />}
      <Problem text={problem} />
      <PhotoSection id={p.id} name={p.name} photo={p.photo} form={form} run={run} />
      <EligibilityProof player={p} form={form} run={run} />
      <DestructiveButton label="Remove from the Squad" accessibleLabel={`Remove ${p.name} from the Squad`} sheetTitle={`Remove ${p.name}?`}
        before={`${p.name} in the Squad`} after="Removed, with their details" actionLabel={`Remove ${p.name}`}
        onConfirm={() => void run('remove_player', { player_id: p.id }, p.id).then(setProblem)} />
      {form.organiser && hasPersonal(p) && (
        <DestructiveButton label="Delete personal details" accessibleLabel={`Delete personal details of ${p.name}`}
          sheetTitle={`Delete ${p.name}'s personal details?`}
          before={`${p.name}'s photo, date of birth, guardian's name and document`}
          after="Deleted; name, Team and matches kept. Backups keep it for up to 30 days." actionLabel="Delete personal details"
          onConfirm={() => void run('erase_player_personal_data', { player_id: p.id }, p.id).then(setProblem)} />
      )}
    </details>
  )
}

/**
 * The Player's Eligibility proof (Story 2.4): document type, number and a scan from the camera or gallery. Each saves on
 * its own through the outbox; the scan is resized on the phone and uploaded before its command. Once uploaded only its
 * file name shows: the Team manager can't open it again (only the organiser can).
 */
function EligibilityProof({ player: p, form, run }: { player: SquadPlayer; form: RegistrationForm; run: Run }) {
  const e = p.eligibility
  // The record this card created, so changes made before the next read edit it instead of adding a second one.
  const created = useRef<string | null>(null)
  // Saves run one after another, so a change made while the first add is still being stored never overtakes it.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const [problem, setProblem] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileId = useId()
  const typeId = useId()

  function save(fields: Record<string, unknown>, upload?: Upload) {
    const next = queue.current.then(() => store(fields, upload))
    queue.current = next.catch(() => {})
    return next
  }
  async function store(fields: Record<string, unknown>, upload?: Upload) {
    setProblem(null)
    const id = e?.id ?? created.current
    if (id) return setProblem(await run('edit_eligibility', { player_id: p.id, ...fields }, id, upload))
    const recordId = crypto.randomUUID()
    created.current = recordId
    await noteNew(recordId)
    const refused = await run('add_eligibility', { player_id: p.id, record_id: recordId, ...fields }, undefined, upload)
    if (refused) created.current = null
    setProblem(refused)
  }

  async function pick(file: File | undefined) {
    if (!file || uploading) return
    setProblem(null)
    setUploading(true)
    try {
      let blob: Blob
      try {
        blob = await resizeImage(file, 1600)
      } catch (err) {
        return setProblem(err instanceof RangeError ? messages.image_too_large : messages.scan_unreadable)
      }
      const path = `${form.team.tournamentId}/${form.team.id}/${p.id}/${crypto.randomUUID()}.webp`
      await save({ scan_path: path, scan_name: fileName(file) },
        { bucket: scanBucket, path, blob, contentType: blob.type || 'image/webp', upsert: false })
    } finally {
      setUploading(false)
    }
  }

  if (e?.verified && form.organiser) {
    return (
      <section className="eligibility" aria-label={`Eligibility for ${p.name}`}>
        <h3 className="body-strong">Eligibility <StatusPill state="done" label="Verified" /></h3>
        <p className="body eligibility-verified">Verified. Scan deleted; {numberWord(e.documentType)} kept.</p>
        <p className="body">{[documentLabel(e.documentType), e.documentNumber].filter(Boolean).join(' · ')}</p>
      </section>
    )
  }
  if (e?.verified) {
    return (
      <section className="eligibility">
        <h3 className="body-strong">Eligibility</h3>
        <p className="body">{[documentLabel(e.documentType), e.documentNumber].filter(Boolean).join(' · ')}</p>
        <p className="meta">Verified by the organiser.</p>
      </section>
    )
  }
  return (
    <section className="eligibility" aria-label={`Eligibility for ${p.name}`}>
      <h3 className="body-strong">Eligibility</h3>
      <div className="ui-field">
        <label htmlFor={typeId} className="body-strong">Document type</label>
        <select id={typeId} className="ui-input" value={e?.documentType ?? ''}
          onChange={(ev) => ev.target.value && void save({ document_type: ev.target.value })}>
          {!e?.documentType && <option value="">Choose a document type</option>}
          {DOCUMENT_TYPES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </div>
      <Field label="Document number" value={e?.documentNumber ?? ''} onSave={(document_number) => void save({ document_number })}
        required requiredMessage={messages.document_number_required} validate={(v) => (v.length > 40 ? messages.number_long : null)}
        autoComplete="off" />
      <div className="ui-field">
        <span className="body-strong">Document scan</span>
        {e?.scanName && (
          <p className="body eligibility-file"><span>{e.scanName}</span><span className="meta"> · Uploaded · only the organiser sees it</span></p>
        )}
        {/* Camera or gallery; the visible label is the button, the input keeps the focus (outline via CSS). */}
        <input id={fileId} className="ui-visually-hidden file-input" type="file" accept="image/*" disabled={uploading}
          onChange={(ev) => (void pick(ev.target.files?.[0]), (ev.target.value = ''))} />
        <label htmlFor={fileId} className="ui-button ui-secondary file-button" aria-disabled={uploading || undefined}>
          {uploading ? 'Uploading the document scan…' : e?.scanName ? 'Replace the document scan' : 'Upload the document scan'}
        </label>
      </div>
      <Problem text={problem} />
      {form.organiser && e?.documentType && <ScanViewer player={p} record={e} run={run} />}
    </section>
  )
}

/** "EMIS number", "Birth certificate number": what verification keeps. */
const numberWord = (t: string | null) => (t === 'emis' ? 'EMIS number' : `${documentLabel(t) || 'document'} number`)

/**
 * The Organiser's scan viewer inside the Player card (Story 2.7): "View document" signs a five-minute URL and shows the scan
 * at about 144px with its file name; tapping it shows full resolution in the card, scrollable and pinch-zoomable there.
 * "Mark verified" sends verify_eligibility (versioned); a paper-sheet record without a scan can be verified too.
 */
function ScanViewer({ player: p, record: e, run }: { player: SquadPlayer; record: Eligibility; run: Run }) {
  const [url, setUrl] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alt = `${documentLabel(e.documentType)} for ${p.name}${e.uploadedAt ? `, uploaded ${formatDay(inZone(e.uploadedAt).date)}` : ''}`

  async function view() {
    if (!e.scanPath || busy) return
    setProblem(null)
    setBusy(true)
    const signed = await signScan(e.scanPath)
    setBusy(false)
    if (!signed) return setProblem(messages.scan_view_failed)
    setUrl(signed)
  }
  async function verify() {
    if (busy) return
    setProblem(null)
    setBusy(true)
    const refused = await run('verify_eligibility', { player_id: p.id }, e.id)
    setBusy(false)
    setProblem(refused)
  }

  return (
    <div className="scan-viewer">
      {e.scanPath && !url && <SecondaryButton label="View document" onClick={() => void view()} />}
      {url && (
        <figure className="scan-figure">
          <ZoomBox full={full}>
            <button type="button" className="scan-image" aria-expanded={full} onClick={() => setFull((f) => !f)}
              aria-label={full ? 'Show the document smaller' : 'Show the document at full resolution'}>
              <img src={url} alt={alt} onError={() => (setUrl(null), setProblem(messages.scan_view_failed))} />
            </button>
          </ZoomBox>
          <figcaption className="meta">{e.scanName}</figcaption>
        </figure>
      )}
      {(url || !e.scanPath) && e.documentNumber && (
        <>
          <p className="body">Document number: <span className="body-strong">{e.documentNumber}</span></p>
          <PrimaryButton label="Mark verified" onClick={() => void verify()} {...blocked(busy && 'Saving…')} />
        </>
      )}
      <Problem text={problem} />
    </div>
  )
}

/** Full resolution scrolls inside the card; two fingers zoom it there (the page itself doesn't zoom). */
function ZoomBox({ full, children }: { full: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const el = box.current
    if (!el || !full) return setScale(1)
    let start = 0
    let base = 1
    const gap = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY)
    const down = (ev: TouchEvent) => {
      if (ev.touches.length !== 2) return
      start = gap(ev.touches)
      setScale((s) => (base = s))
    }
    const move = (ev: TouchEvent) => {
      if (ev.touches.length !== 2 || !start) return
      ev.preventDefault()
      setScale(Math.min(4, Math.max(1, base * (gap(ev.touches) / start))))
    }
    const up = () => { start = 0 }
    el.addEventListener('touchstart', down, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', up)
    return () => (el.removeEventListener('touchstart', down), el.removeEventListener('touchmove', move), el.removeEventListener('touchend', up))
  }, [full])
  return (
    <div ref={box} className={full ? 'scan-zoom scan-full' : 'scan-zoom'} style={full ? { ['--scan-scale' as string]: scale } : undefined}>
      {children}
    </div>
  )
}

// Photos: at most 1024px on the longest side and 2 MiB (the bucket's limit; PNG where the browser can't encode WebP).
const PHOTO_MAX = 1024
const PHOTO_LIMIT = 2097152

/**
 * A Player's or Staff member's photo (Story 2.5): any image from the camera or gallery, shown at once with "Removing
 * background…" while MediaPipe cuts the person out on the phone; the transparent WebP is uploaded by the outbox before
 * set_photo. If removal fails: Try again, or keep the photo with its background (stored is_cutout = false).
 */
function PhotoSection({ id, name, photo, form, run }: { id: string; name: string; photo: Photo | null; form: RegistrationForm; run: Run }) {
  const [phase, setPhase] = useState<'idle' | 'removing' | 'failed'>('idle')
  const [preview, setPreview] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const picked = useRef<HTMLCanvasElement | null>(null)
  const inputId = useId()
  const show = (blob: Blob | null) => setPreview((old) => {
    if (old) URL.revokeObjectURL(old)
    return blob && URL.createObjectURL(blob)
  })

  async function pick(file: File | undefined) {
    if (!file || phase === 'removing') return
    setProblem(null)
    try {
      picked.current = await toCanvas(file, PHOTO_MAX)
    } catch {
      return setProblem(messages.photo_unreadable)
    }
    picked.current.toBlob(show)
    await cut()
  }
  async function cut() {
    const canvas = picked.current
    if (!canvas) return
    setProblem(null)
    setPhase('removing')
    let blob: Blob
    try {
      blob = await removeBackground(canvas, PHOTO_LIMIT)
    } catch (err) {
      if (!(err instanceof RangeError)) return setPhase('failed')
      setPhase('idle')
      return setProblem(messages.image_too_large)
    }
    await store(blob, true)
  }
  async function keep() {
    const canvas = picked.current
    if (!canvas) return
    let blob: Blob
    try {
      blob = await encodeImage(canvas, PHOTO_LIMIT)
    } catch {
      return setProblem(messages.image_too_large)
    }
    await store(blob, false)
  }
  async function store(blob: Blob, cutout: boolean) {
    setPhase('idle')
    show(blob)
    const path = `${form.team.tournamentId}/${form.team.id}/${id}/${crypto.randomUUID()}.webp`
    const refused = await run('set_photo', { person_id: id, photo_path: path, is_cutout: cutout }, id,
      { bucket: photoBucket, path, blob, contentType: blob.type || 'image/webp', upsert: false })
    // Refused (upload or command): the stored photo, if any, shows again.
    if (refused) show(null)
    picked.current = null
    setProblem(refused)
  }
  async function download() {
    setProblem(null)
    try {
      await downloadAsPng(photo!.url!, name)
    } catch {
      setProblem(messages.photo_download_failed)
    }
  }

  const src = preview ?? photo?.url
  return (
    <section className="photo" aria-label={`Photo of ${name}`}>
      <h3 className="body-strong">Photo</h3>
      {src && <img className="photo-image" src={src} alt={`Photo of ${name}`} />}
      {phase === 'idle' && photo && <p className="meta">{photo.cutout ? 'Background removed' : 'Kept with its background'}</p>}
      <p role="status" className="body">{phase === 'removing' ? 'Removing background…' : ''}</p>
      {phase === 'failed' && (
        <div className="photo-failed">
          <p role="alert" className="body-strong">{messages.cutout_failed}</p>
          <PrimaryButton label="Try removing the background again" onClick={() => void cut()} />
          <SecondaryButton label="Keep the photo with its background" onClick={() => void keep()} />
        </div>
      )}
      <input id={inputId} className="ui-visually-hidden file-input" type="file" accept="image/*" disabled={phase === 'removing'}
        onChange={(ev) => (void pick(ev.target.files?.[0]), (ev.target.value = ''))} />
      <label htmlFor={inputId} className="ui-button ui-secondary file-button" aria-disabled={phase === 'removing' || undefined}>
        {photo || preview ? 'Change photo' : 'Add photo'}
      </label>
      {photo?.url && phase === 'idle' && <SecondaryButton label="Download the photo as PNG" onClick={() => void download()} />}
      <Problem text={problem} />
    </section>
  )
}

function RoleSelect({ roles, value, onChange }: { roles: string[]; value: string; onChange: (v: string) => void }) {
  const id = useId()
  return (
    <div className="ui-field">
      <label htmlFor={id} className="body-strong">Role</label>
      <select id={id} name="staff-role" className="ui-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
      </select>
    </div>
  )
}

function AddStaff({ form, run }: { form: RegistrationForm; run: Run }) {
  const { ref, showErrors, values } = useForm()
  const roles = form.rules.staffRoles
  const [key, setKey] = useState(0)
  const [role, setRole] = useState(roles[0] ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  if (!roles.length) return <p className="body">The Line-up rules allow no Staff for this Season.</p>
  const picked = roles.includes(role) ? role : roles[0]!

  async function add() {
    const v = values()
    if (!v || busy) return
    setBusy(true)
    setProblem(null)
    const id = crypto.randomUUID()
    await noteNew(id)
    const p = await run('add_staff', { staff_id: id, name: v['staff-name'], role: picked })
    setBusy(false)
    if (p) return setProblem(p)
    setNotice(`${v['staff-name']} added as ${roleLabel(picked)}.`)
    setKey((n) => n + 1)
  }

  return (
    <form key={key} ref={ref} noValidate className="squad-add" onSubmit={(e) => (e.preventDefault(), void add())}>
      <h3 className="body-strong">Add staff</h3>
      <p role="status" className="body">{notice}</p>
      <Field label="Staff member's name" name="staff-name" value="" onSave={() => {}} required requiredMessage={messages.staff_name_required}
        validate={checkName} showErrors={showErrors} autoComplete="off" />
      <RoleSelect roles={roles} value={picked} onChange={setRole} />
      <Problem text={problem} />
      <PrimaryButton label="Add this Staff member" onClick={() => void add()} {...blocked(busy && 'Adding the Staff member…')} />
    </form>
  )
}

function StaffCard({ staff: s, form, run }: { staff: StaffMember; form: RegistrationForm; run: Run }) {
  const [problem, setProblem] = useState<string | null>(null)
  const save = async (args: Record<string, unknown>) => setProblem(await run('edit_staff', { staff_id: s.id, ...args }, s.id))
  // A role the rules no longer allow still shows, so the person sees what to change.
  const roles = form.rules.staffRoles.includes(s.role) ? form.rules.staffRoles : [s.role, ...form.rules.staffRoles]
  return (
    <details className="squad-card">
      <summary>
        <span className="body-strong">{s.name}</span>
        <span className="meta"> {roleLabel(s.role)}</span>
      </summary>
      <Field label="Staff member's name" value={s.name} onSave={(name) => void save({ name })} required
        requiredMessage={messages.staff_name_required} validate={checkName} autoComplete="off" />
      <RoleSelect roles={roles} value={s.role} onChange={(role) => void save({ role })} />
      <Problem text={problem} />
      <PhotoSection id={s.id} name={s.name} photo={s.photo} form={form} run={run} />
      <DestructiveButton label="Remove from the Staff" accessibleLabel={`Remove ${s.name} from the Staff`} sheetTitle={`Remove ${s.name}?`}
        before={`${s.name}, ${roleLabel(s.role)}`} after="Removed from the Staff" actionLabel={`Remove ${s.name}`}
        onConfirm={() => void run('remove_staff', { staff_id: s.id }, s.id).then(setProblem)} />
    </details>
  )
}

function Submit({ form, run }: { form: RegistrationForm; run: Run }) {
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const status = form.team.status
  const { starters } = form.rules
  async function submit() {
    // The one rule this phone can check offline; the server checks them all.
    if (starters !== null && form.players.length < starters) {
      return setProblem(`Squad needs at least ${starters} Player${starters === 1 ? '' : 's'}. You have ${form.players.length}.`)
    }
    setBusy(true)
    setProblem(await run('submit_team', {}))
    setBusy(false)
  }
  return (
    <section className="card">
      <h2 className="body-strong">Review</h2>
      {status === 'submitted' || status === 'approved' ? (
        <>
          <StatusPill state={status === 'approved' ? 'done' : 'pending'} label={status === 'approved' ? 'Approved' : 'Submitted'} />
          <p className="body">{status === 'approved' ? 'The organiser approved this Team.'
            : 'Sent for review. You can still change the Squad until the deadline.'}</p>
        </>
      ) : (
        <>
          <p className="body">When the Squad and Staff are complete, send them to the organiser.</p>
          <PrimaryButton label="Send this Team for review" onClick={() => void submit()} {...blocked(busy && 'Sending the Team…')} />
        </>
      )}
      <Problem text={problem} />
    </section>
  )
}

/** The Squad as text, once the form is closed: no date of birth or document number; the consent's name only. */
export function ClosedSquad({ form }: { form: RegistrationForm }) {
  return (
    <>
      <section className="card">
        <h2 className="body-strong">Players · {form.players.length}</h2>
        <ul className="squad-list">
          {form.players.map((p) => <li key={p.id} className="body">
            {p.name} · #{p.shirtNumber} · {documentLabel(p.eligibility?.documentType ?? null) || 'no document'} · {consentLine(p)}
          </li>)}
        </ul>
      </section>
      <section className="card">
        <h2 className="body-strong">Staff · {form.staff.length}</h2>
        <ul className="squad-list">
          {form.staff.map((s) => <li key={s.id} className="body">{s.name} · {roleLabel(s.role)}</li>)}
        </ul>
      </section>
    </>
  )
}
