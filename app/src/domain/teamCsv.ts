// Import Teams and Players from a CSV file (pure: no Supabase, so `npm run check:team-import` tests it in Node).

export const CSV_COLUMNS = ['team_name', 'team_code', 'kit_colour', 'player_name', 'shirt_number', 'date_of_birth'] as const
/** The template: the header row only. */
export const CSV_TEMPLATE = `${CSV_COLUMNS.join(',')}\r\n`

/**
 * Parses CSV text: UTF-8 BOM dropped, comma separator, double-quoted fields with "" escapes (a quoted field may hold commas
 * and line breaks), CRLF or LF, blank lines skipped. Returns the rows with their 1-based line number in the file.
 */
export function parseCsv(text: string): { line: number; cells: string[]; open?: true }[] {
  const src = text.replace(/^\uFEFF/, '')
  const rows: { line: number; cells: string[]; open?: true }[] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let start = 1
  const endRow = () => {
    cells.push(cell)
    if (cells.some((c) => c.trim() !== '') || cells.length > 1) rows.push({ line: start, cells, ...(quoted ? { open: true as const } : {}) })
    cells = []
    cell = ''
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else {
        cell += c
        if (c === '\n') line++
      }
    } else if (c === '"' && cell === '') quoted = true
    else if (c === ',') {
      cells.push(cell)
      cell = ''
    }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      endRow()
      line++
      start = line
    } else cell += c
  }
  if (cell !== '' || cells.length) endRow()
  // A row of only empty cells (",,,") is as blank as an empty line.
  return rows.filter((r) => r.cells.some((x) => x.trim() !== ''))
}

/** A Team (or Player) as the Season has it now, with the versions their edits are based on. */
export type ExistingPlayer = { id: string; name: string; shirtNumber: number; dateOfBirth: string; version: number }
export type ExistingTeam = { id: string; name: string; code: string; kitColour: string | null; version: number; withdrawn?: boolean; players: ExistingPlayer[] }

export type PlanPlayer = { row: number; name: string; shirt: number; dob: string; id: string | null; shirtChanged: boolean; dobChanged: boolean }
export type PlanTeam = { code: string; name: string; kit: string | null; id: string | null; nameChanged: boolean; kitChanged: boolean; players: PlanPlayer[] }
export type Plan = {
  errors: string[]; teams: PlanTeam[]
  newTeams: number; changedTeams: number; newPlayers: number; changedPlayers: number
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const CODE = /^[A-Z0-9]{2,5}$/
const KIT = /^#[0-9a-fA-F]{6}$/
const key = (name: string) => name.trim().toLowerCase()
const badName = (v: string) => v.length < 1 || Array.from(v).length > 80 || CONTROL.test(v)
const realDate = (v: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!))
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/**
 * Checks the file against the server's own rules and works out what to send. Every problem is listed by row (the header is
 * row 1); any problem blocks the import. today: YYYY-MM-DD in Asia/Kathmandu. limit: the Season's starters + bench, or null.
 */
export function planImport(text: string, existing: ExistingTeam[], today: string, limit: number | null): Plan {
  const plan: Plan = { errors: [], teams: [], newTeams: 0, changedTeams: 0, newPlayers: 0, changedPlayers: 0 }
  const err = (row: number, why: string) => plan.errors.push(`Row ${row}: ${why}`)
  const rows = parseCsv(text)
  if (!rows.length) return { ...plan, errors: ['The file is empty. Add the header row and one row per Player.'] }
  const unclosed = rows.find((r) => r.open)
  if (unclosed) return { ...plan, errors: [`Row ${unclosed.line}: a quote is never closed.`] }
  const head = rows[0]!.cells.map((c) => c.trim().toLowerCase())
  const missing = CSV_COLUMNS.filter((c) => !head.includes(c))
  if (missing.length) {
    return { ...plan, errors: [`The header row is missing ${missing.length === 1 ? 'the column' : 'the columns'} ${missing.join(', ')}.`] }
  }
  const col = Object.fromEntries(CSV_COLUMNS.map((c) => [c, head.indexOf(c)])) as Record<(typeof CSV_COLUMNS)[number], number>
  const first = new Map<string, { row: number; name: string; kit: string }>()
  for (const { line, cells } of rows.slice(1)) {
    const at = (c: (typeof CSV_COLUMNS)[number]) => (cells[col[c]] ?? '').trim()
    const [name, code, kit, pname, shirtText, dob] = [at('team_name'), at('team_code').toUpperCase(), at('kit_colour'), at('player_name'), at('shirt_number'), at('date_of_birth')]
    const before = plan.errors.length
    if (badName(name)) err(line, 'team name must be 1 to 80 characters with no control characters.')
    if (!CODE.test(code)) err(line, `team code "${code}" must be 2 to 5 letters or digits.`)
    if (kit && !KIT.test(kit)) err(line, `kit colour "${kit}" must be a hash and six hex digits, or be blank.`)
    if (badName(pname)) err(line, 'player name must be 1 to 80 characters with no control characters.')
    if (!/^\d{1,2}$/.test(shirtText) || +shirtText < 1) err(line, `shirt number "${shirtText}" must be a whole number from 1 to 99.`)
    if (!realDate(dob) || dob < '1940-01-01' || dob > today) err(line, `date of birth "${dob}" must be a date as YYYY-MM-DD from 1940-01-01 up to today.`)
    if (plan.errors.length > before || !CODE.test(code)) continue
    const f = first.get(code)
    if (!f) {
      first.set(code, { row: line, name, kit })
      const old = existing.find((t) => t.code === code)
      if (old?.withdrawn) err(line, `Team ${old.name} is withdrawn.`)
      plan.teams.push({ code, name, kit: kit ? kit.toLowerCase() : null, id: old?.id ?? null, players: [],
        nameChanged: !!old && old.name !== name, kitChanged: !!old && !!kit && (old.kitColour ?? '').toLowerCase() !== kit.toLowerCase() })
    } else {
      if (f.name !== name) err(line, `team code ${code} has the name "${name}" here but "${f.name}" in row ${f.row}.`)
      if (f.kit.toLowerCase() !== kit.toLowerCase()) err(line, `team code ${code} has the kit colour "${kit || 'blank'}" here but "${f.kit || 'blank'}" in row ${f.row}.`)
    }
    const t = plan.teams.find((x) => x.code === code)!
    const dup = t.players.find((p) => key(p.name) === key(pname))
    if (dup) {
      err(line, `${pname} is already in ${t.name} in row ${dup.row}.`)
      continue
    }
    const old = existing.find((x) => x.code === code)?.players.find((p) => key(p.name) === key(pname))
    t.players.push({ row: line, name: pname, shirt: +shirtText, dob, id: old?.id ?? null,
      shirtChanged: !!old && old.shirtNumber !== +shirtText, dobChanged: !!old && old.dateOfBirth !== '' && old.dateOfBirth !== dob }) // '' = erased on request: never restored
  }
  // Shirts must be unique in each Team after the import: Players the file doesn't mention keep their numbers.
  for (const t of plan.teams) {
    const old = existing.find((x) => x.code === t.code)
    const used = new Map<number, string>()
    for (const p of old?.players ?? []) if (!t.players.some((q) => key(q.name) === key(p.name))) used.set(p.shirtNumber, p.name)
    for (const p of t.players) {
      const other = used.get(p.shirt)
      if (other !== undefined) err(p.row, `shirt number ${p.shirt} is already used by ${other}.`)
      else used.set(p.shirt, p.name)
    }
    const size = (old?.players.length ?? 0) + t.players.filter((p) => !p.id).length
    if (limit !== null && size > limit) err(t.players[0]!.row, `${t.name} would have ${plural(size, 'Player')}; the Season allows at most ${limit}.`)
  }
  plan.errors.sort((a, b) => Number(/^Row (\d+)/.exec(a)?.[1] ?? 0) - Number(/^Row (\d+)/.exec(b)?.[1] ?? 0))
  for (const t of plan.teams) {
    plan.newTeams += t.id ? 0 : 1
    plan.changedTeams += t.id && (t.nameChanged || t.kitChanged) ? 1 : 0
    plan.newPlayers += t.players.filter((p) => !p.id).length
    plan.changedPlayers += t.players.filter((p) => p.id && (p.shirtChanged || p.dobChanged)).length
  }
  return plan
}

/** "Adds 8 Teams and 80 Players. Updates 2 Players." or "Nothing to change." */
export function summary(p: Plan): string {
  const adds = [p.newTeams && plural(p.newTeams, 'Team'), p.newPlayers && plural(p.newPlayers, 'Player')].filter(Boolean).join(' and ')
  const updates = [p.changedTeams && plural(p.changedTeams, 'Team'), p.changedPlayers && plural(p.changedPlayers, 'Player')].filter(Boolean).join(' and ')
  return [adds && `Adds ${adds}.`, updates && `Updates ${updates}.`].filter(Boolean).join(' ') || 'Nothing to change.'
}

/** One line per Team for the preview. */
export function teamLine(t: PlanTeam): string {
  const add = t.players.filter((p) => !p.id).length
  const upd = t.players.filter((p) => p.id && (p.shirtChanged || p.dobChanged)).length
  const what = [!t.id && 'new Team', t.id && (t.nameChanged || t.kitChanged) && 'updates the Team', add && `adds ${plural(add, 'Player')}`, upd && `updates ${plural(upd, 'Player')}`]
    .filter(Boolean).join(', ')
  return `${t.name} (${t.code}): ${what || 'no change'}`
}
