import { useId, useRef, useState } from 'react'
import { playerHistory, type HistoryRow } from '../../domain/registration'
import { AWARDS, type AwardKey } from '../../domain/seasonAwards'
import { SecondaryButton } from '../../ui/Button'

const award = (k: string) => AWARDS[k as AwardKey] ?? k
const sum = (rows: HistoryRow[], f: (r: HistoryRow) => number) => rows.reduce((n, r) => n + f(r), 0)

/** "Show {name}'s history": one row per Season for the whole person and a Career row. Read when opened; nothing is stored. */
export function PlayerHistory({ playerId, name }: { playerId: string; name: string }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<HistoryRow[] | null | undefined>(undefined) // undefined: loading, null: failed

  const id = useId()
  const latest = useRef(0)

  async function load() {
    const mine = ++latest.current
    setRows(undefined)
    const r = await playerHistory(playerId)
    if (mine === latest.current) setRows(r)
  }
  function toggle() {
    if (!open) void load()
    else latest.current++
    setOpen(!open)
  }

  const careerAwards = rows ? rows.flatMap((r) => r.awards.map(award)) : []
  return (
    <div className="player-history">
      <SecondaryButton label={open ? `Hide ${name}'s history` : `Show ${name}'s history`} onClick={toggle} aria-expanded={open} aria-controls={id} />
      <div id={id}>
        {open && rows === undefined && <p className="meta" role="status">Loading the history.</p>}
        {open && rows === null && (
          <div role="alert">
            <p className="meta">Can't load the history. Try loading it again</p>
            <SecondaryButton label="Load the history again" onClick={() => void load()} />
          </div>
        )}
        {open && rows && rows.length === 0 && <p className="meta">No history found.</p>}
        {open && rows && rows.length > 0 && (
          <div className="history-scroll" tabIndex={0} role="region" aria-label={`${name}'s history`}>
            <table>
              <thead><tr><th scope="col">Season</th><th scope="col">Team</th><th scope="col"><abbr title="Goals">G</abbr></th><th scope="col"><abbr title="Assists">A</abbr></th><th scope="col"><abbr title="Yellow cards">YC</abbr></th>
                <th scope="col"><abbr title="Red cards">RC</abbr></th><th scope="col"><abbr title="Man of the Match">MoM</abbr></th><th scope="col"><abbr title="Fair Player">FP</abbr></th><th scope="col">Awards</th></tr></thead>
              <tbody>
                {rows.map((r) => <tr key={r.season}><th scope="row">{r.season}</th><td>{r.teamCode ?? '-'}</td><td>{r.goals}</td><td>{r.assists}</td><td>{r.yellow}</td>
                  <td>{r.red}</td><td>{r.mom}</td><td>{r.fair}</td><td>{r.awards.map(award).join(', ') || '-'}</td></tr>)}
              </tbody>
              <tfoot><tr><th scope="row" colSpan={2}>Career</th><td>{sum(rows, (r) => r.goals)}</td><td>{sum(rows, (r) => r.assists)}</td><td>{sum(rows, (r) => r.yellow)}</td>
                <td>{sum(rows, (r) => r.red)}</td><td>{sum(rows, (r) => r.mom)}</td><td>{sum(rows, (r) => r.fair)}</td><td>{careerAwards.join(', ') || '-'}</td></tr></tfoot>
            </table>
            <p className="meta">G goals · A assists · YC yellow cards · RC red cards · MoM Man of the Match · FP Fair Player</p>
          </div>
        )}
      </div>
    </div>
  )
}
