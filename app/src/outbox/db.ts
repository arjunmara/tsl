import { Dexie, type EntityTable } from 'dexie'

/** A version_conflict refusal: the row as it is now on the server, and who changed it last. */
export type Conflict = { current_version: number; current: Record<string, unknown>; changed_by: string; changed_at: string }

/** A file to upload before the command runs (upsert, so a repeat is harmless). Removed from the entry once uploaded. */
export type Upload = { bucket: string; path: string; blob: Blob; contentType: string }

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
  /** The server's words for a refusal that carries its own reasons (lineup_violation). */
  message?: string
  conflict?: Conflict
  attempts: number
  upload?: Upload
  /**
   * Set on edits of a versioned row (the row's id): replay sends expected_version from that row's base version
   * (below), so the version is never guessed when the change is made.
   */
  versionOf?: string
}

/** The last version this device knows for a row: from reads with nothing pending for it, and from every ok result. */
export type BaseVersion = { id: string; version: number }

export const db = new Dexie('tsl-outbox') as Dexie & { entries: EntityTable<Entry, 'seq'>; versions: EntityTable<BaseVersion, 'id'> }
db.version(1).stores({ entries: '++seq' })
db.version(2).stores({ entries: '++seq', versions: 'id' })
