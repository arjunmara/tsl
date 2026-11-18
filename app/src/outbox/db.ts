import { Dexie, type EntityTable } from 'dexie'

/** A version_conflict refusal: the row as it is now on the server, and who changed it last. */
export type Conflict = { current_version: number; current: Record<string, unknown>; changed_by: string; changed_at: string
  /** Args to replace on "Send my version" when one expected_version is not enough (swap_fixtures: version_a, version_b). */
  resend?: Record<string, unknown> }

/**
 * A file to upload before the command runs (upsert, so a repeat is harmless). Removed from the entry once uploaded.
 * upsert false: for a bucket the uploader may add to but not read (eligibility-scans); a repeat finding the file there is done.
 */
export type Upload = { bucket: string; path: string; blob: Blob; contentType: string; upsert?: false }

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

/** The last console of one Match on this device, per user (key `user:match`): what the screen showed, with the command ids of the queued changes already in it (Story 4.7). */
export type KeptConsole = { key: string; console: unknown; applied: string[] }

export const db = new Dexie('tsl-outbox') as Dexie & { entries: EntityTable<Entry, 'seq'>; versions: EntityTable<BaseVersion, 'id'>}
db.version(1).stores({ entries: '++seq' })
db.version(2).stores({ entries: '++seq', versions: 'id' })

// Its own database, so a write of the console never queues behind the outbox's transactions.
export const kept = new Dexie('tsl-console') as Dexie & { consoles: EntityTable<KeptConsole, 'key'> }
kept.version(1).stores({ consoles: 'key' })
