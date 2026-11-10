import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { send, type OutboxEntry, type Upload } from '../../domain/commands'
import { messages } from '../../domain/messages'
import { assetBucket, logoUrl, noteNewSponsor, type Sponsor } from '../../domain/tournaments'
import { DestructiveButton, PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { useForm } from '../auth/form'
import { Problem } from '../auth/Screen'
import { resizeLogo } from './brand'
import { Frame, useLeave } from './Frame'

type Ids = { tournamentId: string; seasonId: string }
type Blobs = Record<string, Blob>
const MAX_ADS = 5
const MAX_SPONSORS = 30

// One line of plain text, as app.sponsor allows: no line break, tab or other control character; 120 code points.
// eslint-disable-next-line no-control-regex
const checkCaption = (v: string) => (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v) ? messages.caption_one_line
  : [...v].length > 120 ? messages.caption_long : null)

/**
 * The Season's Sponsors as this device should show them: the server's list with this user's pending Sponsor commands
 * laid over in order, and the queued pictures by path, so they show before they are uploaded.
 */
export function overlaySponsors(base: Sponsor[], queued: OutboxEntry[], seasonId: string): { sponsors: Sponsor[]; blobs: Blobs } {
  let list = base
  const blobs: Blobs = {}
  for (const e of queued) {
    const a = e.args
    if (a.season_id !== seasonId) continue
    if (e.upload) blobs[e.upload.path] = e.upload.blob
    if (e.name === 'add_sponsor' && !list.some((s) => s.id === a.sponsor_id)) {
      list = [...list, { id: String(a.sponsor_id), caption: String(a.caption ?? ''), logo_path: String(a.logo_path ?? ''),
        ad_paths: Array.isArray(a.ad_paths) ? (a.ad_paths as string[]) : [] }]
    }
    if (e.name === 'edit_sponsor') {
      list = list.map((s) => (s.id !== a.sponsor_id ? s : {
        ...s, ...(a.caption != null && { caption: String(a.caption) }), ...(a.logo_path != null && { logo_path: String(a.logo_path) }),
        ...(Array.isArray(a.ad_paths) && { ad_paths: a.ad_paths as string[] }),
      }))
    }
    if (e.name === 'delete_sponsor') list = list.filter((s) => s.id !== a.sponsor_id)
    if (e.name === 'reorder_sponsors' && Array.isArray(a.sponsor_ids)) {
      // As the server does: listed ones first in that order, the rest after in theirs (sort is stable).
      const ids = a.sponsor_ids as string[]
      const rank = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length)
      list = [...list].sort((x, y) => rank(x.id) - rank(y.id))
    }
  }
  return { sponsors: list, blobs }
}

/** A picture's address: the queued blob while it waits to upload, else the public file. */
function usePictures(blobs: Blobs) {
  // ponytail: object URLs of queued pictures are not revoked; a handful per visit.
  const urls = useMemo(() => Object.fromEntries(Object.entries(blobs).map(([p, b]) => [p, URL.createObjectURL(b)])), [blobs])
  return (path: string) => urls[path] ?? logoUrl(path)
}

/**
 * Step 7, Sponsors (also the Settings section). The list with Edit, Move up / Move down and Delete (Confirm sheet), each
 * saved at once through the outbox; "Add a Sponsor" and Edit open the editor in place of the list. "Skip for now" (no
 * Sponsors) or "Finish setup" ends the wizard on the Teams tab.
 */
export function StepSeven({ tournamentId, seasonId, initial, blobs: queuedBlobs }: Ids & { initial: Sponsor[]; blobs: Blobs }) {
  const navigate = useNavigate()
  const leave = useLeave(tournamentId, 7)
  const [list, setList] = useState(initial)
  const [blobs, setBlobs] = useState(queuedBlobs)
  const [editing, setEditing] = useState<Sponsor | 'new' | null>(null)
  const [announce, setAnnounce] = useState('')
  const picture = usePictures(blobs)
  const hint = useId()
  // After a move, a delete or the editor closing: what to focus (React moves or drops the focused node).
  const focus = useRef<{ id?: string; acts: string[] } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const f = focus.current
    if (!f || !box.current) return
    focus.current = null
    for (const act of f.acts) {
      const el = box.current.querySelector<HTMLButtonElement>(f.id ? `[data-id="${f.id}"] [data-act="${act}"]` : `[data-act="${act}"]`)
      if (el && !el.disabled) return el.focus()
    }
  })

  function move(i: number, d: -1 | 1) {
    const next = [...list]
    const s = next[i]!
    ;[next[i], next[i + d]] = [next[i + d]!, s]
    focus.current = { id: s.id, acts: d < 0 ? ['up', 'down', 'edit'] : ['down', 'up', 'edit'] }
    setList(next)
    setAnnounce(`${s.caption} moved to number ${i + d + 1} of ${next.length}.`)
    void send('reorder_sponsors', { season_id: seasonId, sponsor_ids: next.map((x) => x.id) }, { scope: tournamentId })
  }
  function remove(s: Sponsor) {
    focus.current = { acts: ['add'] }
    setList((l) => l.filter((x) => x.id !== s.id))
    setAnnounce(`${s.caption} deleted.`)
    void send('delete_sponsor', { sponsor_id: s.id, season_id: seasonId }, { scope: tournamentId, versionOf: s.id })
  }
  function finish() {
    void send('set_setup_step', { season_id: seasonId, step: 7 }, { scope: tournamentId })
    navigate(`/t/${tournamentId}`, { replace: true, state: { tab: 'teams' } })
  }
  function closeEditor(saved: Sponsor | null, picked: Blobs) {
    setBlobs((b) => ({ ...b, ...picked }))
    if (saved) setList((l) => (l.some((x) => x.id === saved.id) ? l.map((x) => (x.id === saved.id ? saved : x)) : [...l, saved]))
    focus.current = saved ? { id: saved.id, acts: ['edit'] } : { acts: ['add'] }
    setEditing(null)
  }

  if (editing) {
    return <SponsorEditor tournamentId={tournamentId} seasonId={seasonId} sponsor={editing === 'new' ? null : editing} blobs={blobs} onClose={closeEditor} />
  }
  return (
    <Frame step={7} onBack={leave} onNext={finish} nextLabel={list.length ? 'Finish setup' : 'Skip for now'}>
      <div ref={box} className="wizard-fields wizard-single">
        <p id={hint} className="body">Sponsors show on your Graphics and the stream, in this order. Add them now or later in Settings.</p>
        {list.length ? (
          <ol className="tiebreaks" aria-describedby={hint}>
            {list.map((s, i) => (
              <li key={s.id} data-id={s.id} className="tiebreak">
                <span className="sponsor-row">
                  <img className="sponsor-logo" src={picture(s.logo_path)} alt="" />
                  <span>
                    <span className="body-strong">{i + 1}. {s.caption}</span>
                    <span className="meta sponsor-ads-count">
                      {s.ad_paths.length ? `${s.ad_paths.length} ad image${s.ad_paths.length === 1 ? '' : 's'}` : 'No ad images'}
                    </span>
                  </span>
                </span>
                <span className="tiebreak-actions">
                  <button type="button" className="ui-button ui-secondary" data-act="edit" aria-label={`Edit Sponsor ${s.caption}`}
                    onClick={() => setEditing(s)}>Edit Sponsor</button>
                  <button type="button" className="ui-button ui-secondary" data-act="up" aria-label={`Move up ${s.caption}`}
                    disabled={i === 0} onClick={() => move(i, -1)}>Move up</button>
                  <button type="button" className="ui-button ui-secondary" data-act="down" aria-label={`Move down ${s.caption}`}
                    disabled={i === list.length - 1} onClick={() => move(i, 1)}>Move down</button>
                  <DestructiveButton label="Delete Sponsor" accessibleLabel={`Delete Sponsor ${s.caption}`} sheetTitle={`Delete ‘${s.caption}’?`}
                    before={`Sponsor ‘${s.caption}’`} after="Not shown on your Graphics or the stream" actionLabel="Delete this Sponsor"
                    onConfirm={() => remove(s)} />
                </span>
              </li>
            ))}
          </ol>
        ) : <p className="body-strong">No Sponsors yet.</p>}
        {list.length < MAX_SPONSORS ? (
          <span>
            <button type="button" className="ui-button ui-secondary" data-act="add" onClick={() => setEditing('new')}>Add a Sponsor</button>
          </span>
        ) : <p className="meta">{messages.sponsors_full}</p>}
        <p className="ui-visually-hidden" aria-live="polite">{announce}</p>
      </div>
    </Frame>
  )
}

/**
 * One Sponsor's caption, logo and ad images. A new Sponsor is sent with "Add this Sponsor" (add_sponsor with the logo,
 * then one edit per ad image, each carrying its one upload); an existing one saves each change at once.
 */
function SponsorEditor({ tournamentId, seasonId, sponsor, blobs, onClose }: Ids & {
  sponsor: Sponsor | null; blobs: Blobs; onClose: (saved: Sponsor | null, picked: Blobs) => void
}) {
  const isNew = !sponsor
  const [v, setV] = useState<Sponsor>(() => sponsor ?? { id: crypto.randomUUID(), caption: '', logo_path: '', ad_paths: [] })
  const cur = useRef(v)
  const [picked, setPicked] = useState<Blobs>({})
  const picture = usePictures(useMemo(() => ({ ...blobs, ...picked }), [blobs, picked]))
  // A new Sponsor's uploads wait for "Add this Sponsor", by path.
  const uploads = useRef<Record<string, Upload>>({})
  const { ref, showErrors, values } = useForm()
  const [logoError, setLogoError] = useState<string | null>(null)
  const [adError, setAdError] = useState<string | null>(null)
  const logoPick = useRef(0)
  const logoId = useId()
  const adId = useId()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  function apply(fields: Partial<Sponsor>) {
    cur.current = { ...cur.current, ...fields }
    setV(cur.current)
  }
  function edit(fields: Partial<Sponsor>, upload?: Upload) {
    apply(fields)
    if (isNew) return
    void send('edit_sponsor', { sponsor_id: cur.current.id, season_id: seasonId, ...fields },
      { scope: tournamentId, versionOf: cur.current.id, ...(upload ? { upload } : {}) })
  }
  /** Resizes a picked picture and names it in the Tournament's folder; null (with the problem shown) when unreadable. */
  async function prepare(file: File, kind: 'logo' | 'ad', show: (t: string | null) => void): Promise<Upload | null> {
    show(null)
    try {
      const blob = await resizeLogo(file, kind === 'logo' ? 512 : 1280)
      const path = `${tournamentId}/sponsor-${cur.current.id}-${kind}-${crypto.randomUUID()}.webp`
      return { bucket: assetBucket, path, blob, contentType: blob.type || 'image/webp' }
    } catch (e) {
      show(e instanceof RangeError ? messages.image_too_large : messages.logo_unreadable)
      return null
    }
  }
  // Pictures still being resized: "Add this Sponsor" waits for them, so none is dropped.
  const resizing = useRef(new Set<Promise<unknown>>())
  function track<T>(p: Promise<T>) {
    resizing.current.add(p)
    void p.finally(() => resizing.current.delete(p))
    return p
  }
  const adding = useRef(false)
  async function pickLogo(file: File | undefined) {
    if (!file) return
    const pick = ++logoPick.current
    const u = await track(prepare(file, 'logo', setLogoError))
    if (!u || pick !== logoPick.current || !alive.current) return
    setPicked((p) => ({ ...p, [u.path]: u.blob }))
    if (isNew) uploads.current[u.path] = u
    edit({ logo_path: u.path }, u)
  }
  async function pickAd(file: File | undefined) {
    if (!file) return
    const u = await track(prepare(file, 'ad', setAdError))
    if (!u || !alive.current) return
    if (cur.current.ad_paths.length >= MAX_ADS) return setAdError(`Use at most ${MAX_ADS} ad images.`)
    setPicked((p) => ({ ...p, [u.path]: u.blob }))
    if (isNew) uploads.current[u.path] = u
    edit({ ad_paths: [...cur.current.ad_paths, u.path] }, u)
  }
  function removeAd(path: string) {
    delete uploads.current[path]
    edit({ ad_paths: cur.current.ad_paths.filter((p) => p !== path) })
  }

  async function add() {
    // A double tap or Enter plus tap sends one add.
    if (adding.current) return
    adding.current = true
    await Promise.all([...resizing.current])
    const form = values()
    const noLogo = !cur.current.logo_path
    setLogoError(noLogo ? messages.sponsor_logo_required : null)
    if (!form || noLogo) adding.current = false
    if (!form) return
    if (noLogo) return void document.getElementById(logoId)?.focus()
    const s = { ...cur.current, caption: form.caption ?? '' }
    await noteNewSponsor(s.id)
    void send('add_sponsor', { sponsor_id: s.id, season_id: seasonId, caption: s.caption, logo_path: s.logo_path },
      { scope: tournamentId, upload: uploads.current[s.logo_path] })
    // One upload per command: each ad image follows as its own edit.
    let ads: string[] = []
    for (const p of s.ad_paths) {
      ads = [...ads, p]
      void send('edit_sponsor', { sponsor_id: s.id, season_id: seasonId, ad_paths: ads },
        { scope: tournamentId, versionOf: s.id, upload: uploads.current[p] })
    }
    onClose(s, picked)
  }

  return (
    <Frame step={7} onBack={() => onClose(isNew ? null : cur.current, picked)} backLabel="Back to Sponsors">
      <form ref={ref} noValidate className="wizard-fields wizard-single" onSubmit={(e) => (e.preventDefault(), isNew && void add())}>
        <h2 className="body-strong">{isNew ? 'New Sponsor' : `Sponsor ‘${v.caption}’`}</h2>
        {isNew && <p className="meta">Nothing is saved until you add this Sponsor.</p>}
        <Field label="Caption" name="caption" autoComplete="off" value={v.caption} required requiredMessage={messages.caption_required}
          validate={checkCaption} showErrors={showErrors} onSave={(caption) => edit({ caption })} />
        <div className="ui-field">
          <span className="body-strong">Logo</span>
          {v.logo_path && <img className="logo-preview" src={picture(v.logo_path)} alt="Sponsor logo preview" />}
          <input id={logoId} className="ui-visually-hidden file-input" type="file" accept="image/*"
            onChange={(e) => (void pickLogo(e.target.files?.[0]), (e.target.value = ''))} />
          <label htmlFor={logoId} className="ui-button ui-secondary file-button">{v.logo_path ? 'Change the logo' : 'Choose a logo'}</label>
          <Problem text={logoError} />
        </div>
        <div className="ui-field">
          <span className="body-strong">Ad images</span>
          <p className="meta">Optional, up to {MAX_ADS}. They show on the stream.</p>
          {v.ad_paths.length > 0 && (
            <ul className="sponsor-ads">
              {v.ad_paths.map((p, i) => (
                <li key={p} className="sponsor-row">
                  <img className="logo-preview" src={picture(p)} alt={`Ad image ${i + 1}`} />
                  {isNew ? <SecondaryButton label={`Remove ad image ${i + 1}`} onClick={() => removeAd(p)} />
                    : <DestructiveButton label={`Remove ad image ${i + 1}`} sheetTitle={`Remove ad image ${i + 1}?`}
                      before={`${v.ad_paths.length} ad image${v.ad_paths.length === 1 ? '' : 's'}`}
                      after={`${v.ad_paths.length - 1} ad image${v.ad_paths.length === 2 ? '' : 's'}`} actionLabel="Remove this ad image"
                      onConfirm={() => removeAd(p)} />}
                </li>
              ))}
            </ul>
          )}
          {v.ad_paths.length < MAX_ADS && (
            <>
              <input id={adId} className="ui-visually-hidden file-input" type="file" accept="image/*"
                onChange={(e) => (void pickAd(e.target.files?.[0]), (e.target.value = ''))} />
              <label htmlFor={adId} className="ui-button ui-secondary file-button">Add an ad image</label>
            </>
          )}
          <Problem text={adError} />
        </div>
        {isNew && <PrimaryButton label="Add this Sponsor" onClick={() => void add()} />}
      </form>
    </Frame>
  )
}
