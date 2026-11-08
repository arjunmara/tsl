import { Dexie, type EntityTable } from 'dexie'

/** One queued command. Stored before any network call; deleted only once the server says ok. */
export type Entry = {
  seq: number
  commandId: string
  name: string
  args: Record<string, unknown>
  /** Tournament or Season id, or 'global'. A failed entry stops later entries in its scope. */
  scope: string
  /** User id at enqueue; only that user's session replays it. */
  actor: string
  appVersion: string
  /** ISO, server-corrected. */
  enteredAt: string
  confirmed?: true
  state: 'pending' | 'failed'
  code?: string
  attempts: number
}

export const db = new Dexie('tsl-outbox') as Dexie & { entries: EntityTable<Entry, 'seq'> }
db.version(1).stores({ entries: '++seq' })
