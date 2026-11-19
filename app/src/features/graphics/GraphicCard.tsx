import { domToBlob } from 'modern-screenshot'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { caption, graphicFile, resultData, type ResultData } from '../../domain/graphics'
import type { Match } from '../../domain/matches'
import { messages } from '../../domain/messages'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { Classic } from './Classic'

const W = 1080
const H = 1350

/** The PNG of the Graphic, exactly 1080x1350: after the fonts are ready, rendered twice because iOS Safari paints late-loaded fonts only on the second pass. */
async function makePng(node: HTMLElement): Promise<Blob> {
  if ((window as { tslGraphicFail?: boolean }).tslGraphicFail) throw new Error('graphic test failure')
  await document.fonts.ready
  const opts = { width: W, height: H, scale: 1, type: 'image/png' as const, style: { transform: 'none' } }
  await domToBlob(node, opts)
  const png = await domToBlob(node, opts)
  if (!png) throw new Error('no image')
  return png
}

/**
 * The Result Graphic card of a finished Match (Story 5.1): a 4:5 thumbnail of the Classic Template, "Share this Graphic" and "Download this Graphic".
 * The PNG is made on this phone as soon as the data is in, so a tap can share at once; nothing is uploaded or stored.
 */
export function GraphicCard({ tournamentId, seasonId, match }: { tournamentId: string; seasonId: string; match: Match }) {
  const [data, setData] = useState<ResultData | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [png, setPng] = useState<Blob | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState('')
  const [words, setWords] = useState('')
  const shown = useRef('')
  const stage = useRef<HTMLDivElement>(null)
  const node = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.3)

  useEffect(() => {
    let live = true
    void resultData(tournamentId, seasonId, match).then((r) => {
      if (!live) return
      if ('code' in r) return setProblem(r.code === 'offline' ? messages.offline : messages.graphic_failed)
      setProblem(null)
      // Only new content needs a new PNG; the same content keeps the one made (its effect would not run again).
      const k = JSON.stringify(r)
      if (k === shown.current) return
      shown.current = k
      setPng(null)
      setData(r)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again when the Match changes, not on every new object
  }, [tournamentId, seasonId, match.id, match.version, match.hg, match.ag, match.homePens, match.awayPens, match.kickOff, attempt])

  // The PNG, once the data is on screen.
  const key = data ? JSON.stringify(data) : ''
  useEffect(() => {
    if (!data || !node.current) return
    let live = true
    makePng(node.current).then((b) => live && setPng(b), () => live && setProblem(messages.graphic_failed))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- data is read through its JSON key
  }, [key, attempt])

  useLayoutEffect(() => {
    const el = thumb.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / W)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const text = data ? caption(data) : ''
  const file = () => new File([png!], data ? graphicFile(data) : 'graphic.png', { type: 'image/png' })

  function save() {
    const url = URL.createObjectURL(png!)
    const a = Object.assign(document.createElement('a'), { href: url, download: graphicFile(data!) })
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  async function saveAndCopy() {
    save()
    try {
      await navigator.clipboard.writeText(text)
      setNotice(messages.image_saved)
      setWords('')
    } catch {
      setNotice(messages.image_saved_no_copy)
      setWords(text)
    }
  }

  async function share() {
    setNotice('')
    setWords('')
    const f = file()
    let can = false
    try {
      can = !!navigator.canShare?.({ files: [f] })
    } catch {
      // canShare can throw for files: treat it as no share sheet.
    }
    if (can) {
      try {
        await navigator.share({ files: [f], text })
      } catch (e) {
        // Cancelling the share sheet is not a problem.
        if (!(e instanceof DOMException && e.name === 'AbortError')) await saveAndCopy()
      }
      return
    }
    await saveAndCopy()
  }

  const wait = 'Making the Graphic…'
  return (
    <section className="card graphic-card" aria-labelledby="graphic-head">
      <h2 id="graphic-head" className="body-strong">Result Graphic</h2>
      <div ref={thumb} className="graphic-thumb" role="img" aria-label={text || 'Result Graphic'} aria-busy={!png && !problem}>
        {data && (
          <div ref={stage} className="graphic-stage" style={{ transform: `scale(${scale})` }}>
            <Classic ref={node} data={data} />
          </div>
        )}
        {!png && !problem && <div className="graphic-placeholder skeleton-card"><p className="meta">{wait}</p></div>}
      </div>
      <Problem text={problem} />
      {problem && <SecondaryButton label="Try making the graphic again" onClick={() => (setProblem(null), (shown.current = ''), setData(null), setAttempt((n) => n + 1))} />}
      {png && (
        <div className="ui-sheet-actions">
          <PrimaryButton label="Share this Graphic" onClick={() => void share()} />
          <SecondaryButton label="Download this Graphic" onClick={() => void saveAndCopy()} />
        </div>
      )}
      <p role="status" aria-live="polite" className="body-strong">{notice}</p>
      {words && <p className="body graphic-caption">{words}</p>}
    </section>
  )
}
