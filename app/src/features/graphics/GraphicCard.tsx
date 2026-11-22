import { domToBlob } from 'modern-screenshot'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { caption, graphicFile, type PlayerData, type ResultData } from '../../domain/graphics'
import type { ListData } from '../../domain/listGraphics'
import { messages } from '../../domain/messages'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { List } from './List'
import { Player } from './Player'
import { Result } from './templates'

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

/** Whether the share sheet takes these files (canShare is missing on some browsers and can throw for files). */
export function canShareFiles(files: File[]): boolean {
  try {
    return !!navigator.canShare?.({ files })
  } catch {
    return false
  }
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

/** What a card tells the pack: its PNG, 'failed', or null while it has none (Story 5.4). */
export type CardState = Blob | 'failed' | null
/** Pack cards render one at a time in pack order: canRender holds a card back until the ones before it have a PNG or a failure. */
export type PackProps = { canRender?: boolean; onState?: (s: CardState) => void }

type ViewProps<D> = PackProps & {
  heading: string; data: D | null; problem: string | null; text: string; file: string; retryLabel: string; shareLabel: string; downloadLabel: string
  onRetry: () => void; children: (ref: Ref<HTMLDivElement>, data: D) => ReactNode
}

/**
 * A Graphic card (Stories 5.1, 5.3): a 4:5 thumbnail of the Template, Share (Primary) and Download (Secondary). The PNG is made on this phone as soon as
 * the data is in, so a tap can share at once; nothing is uploaded or stored.
 */
function GraphicView<D>({ heading, data, problem: dataProblem, text, file: fileName, retryLabel, shareLabel, downloadLabel, onRetry, children, canRender = true, onState }: ViewProps<D>) {
  const [made, setMade] = useState<{ k: string; text: string } | null>(null)
  const [done, setDone] = useState<{ k: string; b: Blob } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState('')
  const [words, setWords] = useState('')
  const id = useId()
  const node = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.3)

  // The PNG, once the data is on screen; new content needs a new one.
  const key = data ? JSON.stringify(data) : ''
  const png = done?.k === key ? done.b : null
  // A render failure belongs to the content it failed on.
  const problem = dataProblem ?? (made?.k === key ? made.text : null)
  useEffect(() => {
    if (!data || !node.current || !canRender) return
    let live = true
    makePng(node.current).then((b) => live && setDone({ k: key, b }), () => live && setMade({ k: key, text: messages.graphic_failed }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- data is read through its JSON key
  }, [key, attempt, canRender])

  const state: CardState = png ?? (problem ? 'failed' : null)
  useEffect(() => onState?.(state), [state]) // eslint-disable-line react-hooks/exhaustive-deps -- tell the pack when the state changes, not when its callback does

  useLayoutEffect(() => {
    const el = thumb.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / W)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const file = () => new File([png!], fileName, { type: 'image/png' })

  const save = () => saveBlob(png!, fileName)

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
    if (canShareFiles([f])) {
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

  return (
    <section className="card graphic-card" aria-labelledby={id}>
      <h2 id={id} className="body-strong">{heading}</h2>
      <div ref={thumb} className="graphic-thumb" role="img" aria-label={text || heading} aria-busy={!png && !problem}>
        {data && (
          <div className="graphic-stage" style={{ transform: `scale(${scale})` }}>
            {children(node, data)}
          </div>
        )}
        {!png && !problem && <div className="graphic-placeholder skeleton-card"><p className="meta">Making the Graphic…</p></div>}
      </div>
      <Problem text={problem} />
      {problem && <SecondaryButton label={retryLabel} onClick={() => (setMade(null), setAttempt((n) => n + 1), onRetry())} />}
      {png && (
        <div className="ui-sheet-actions">
          <PrimaryButton label={shareLabel} onClick={() => void share()} />
          <SecondaryButton label={downloadLabel} onClick={() => void saveAndCopy()} />
        </div>
      )}
      <p role="status" aria-live="polite" className="body-strong">{notice}</p>
      {words && <p className="body graphic-caption">{words}</p>}
    </section>
  )
}

/** The Result Graphic card of a finished Match (Story 5.1), first in the pack. */
export function ResultCard({ data, onRetry, ...pack }: { data: ResultData; onRetry: () => void } & PackProps) {
  return (
    <GraphicView {...pack} heading="Result Graphic" data={data} problem={null} text={caption(data)} file={graphicFile(data)}
      retryLabel="Try making the graphic again" shareLabel="Share this Graphic" downloadLabel="Download this Graphic" onRetry={onRetry}>
      {(ref, d) => <Result ref={ref} data={d} />}
    </GraphicView>
  )
}

/** One Player Graphic card (a goal, card, missed penalty, Man of the Match or Fair Player). */
export function PlayerCard({ data, onRetry, ...pack }: { data: PlayerData; onRetry: () => void } & PackProps) {
  return (
    <GraphicView {...pack} heading={data.title.replace(/^./, (c) => c.toUpperCase())} data={data} problem={null} text={data.caption} file={data.file}
      retryLabel={`Try making the ${data.title} again`} shareLabel={`Share the ${data.title}`} downloadLabel={`Download the ${data.title}`} onRetry={onRetry}>
      {(ref, d) => <Player ref={ref} data={d} />}
    </GraphicView>
  )
}

/** One list Graphic card (Official Draw, Fixtures, Results or a table), made from current data. */
export function ListCard({ data, onRetry, ...pack }: { data: ListData; onRetry: () => void } & PackProps) {
  return (
    <GraphicView {...pack} heading={data.label} data={data} problem={null} text={data.caption} file={data.file}
      retryLabel={`Try making the ${data.label} again`} shareLabel={`Share the ${data.label}`} downloadLabel={`Download the ${data.label}`} onRetry={onRetry}>
      {(ref, d) => <List ref={ref} data={d} />}
    </GraphicView>
  )
}
