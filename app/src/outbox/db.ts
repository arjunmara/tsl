import { Dexie, type EntityTable } from 'dexie'

/** A version_conflict refusal: the row as it is now on the server, and who changed it last. */
export type Conflict = { current_version: number; current: Record<string, unknown>; changed_by: string; changed_at: string }

/** One queued command. Stored before any network call; deleted only once the server says ok. */
export type Entry = {
  seq: number
  commandId: string
  name: string
  args: Record<string, unknown>
  /** Tournament or Season id, or 'global'. A failed or conflict entry stops later entries in its scope. */
  scope: string
  /** User id at enqueue; only that user's session replays it. */
  actor: string
  appVersion: string
  /** ISO, server-corrected. */
  enteredAt: string
  confirmed?: true
  /** failed and conflict wait for the user's choice in the hand-back sheet. */
  state: 'pending' | 'failed' | 'conflict'
  code?: string
  conflict?: Conflict
  attempts: number
}

export const db = new Dexie('tsl-outbox') as Dexie & { entries: EntityTable<Entry, 'seq'> }
db.version(1).stores({ entries: '++seq' })
