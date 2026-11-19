/**
 * An action on the floor, saved on this device before anything else and
 * uploaded with sync_operation() (migration 2000). Its id is made here and
 * never changes, so however many times it is uploaded the server applies it
 * once; `at` is when it happened (server-aligned), so it is recorded at that
 * time even if it reaches the server an hour later.
 */
export type OpKind =
  | 'session.start'
  | 'session.pause'
  | 'session.resume'
  | 'session.end'
  | 'session.reopen'
  | 'session.acknowledge'
  | 'session.continue'
  | 'session.extend'
  | 'session.cancel'
  | 'tab.add'
  | 'tab.set'
  | 'checkout'
  | 'counter.open'
  | 'expense.add'
  | 'expense.void'
  | 'session.split'
  | 'tab.assign'
  | 'share.settle'
  | 'share.undo'
  | 'checkout.split'

/**
 * pending   — saved on this device, not yet accepted by the server
 * done      — accepted (kept a day, so screens can show it until they refresh)
 * failed    — refused by the server (e.g. another device used the table); never dropped on its own
 * discarded — set aside by a person (kept 30 days, and can be exported)
 */
export type OpStatus = 'pending' | 'done' | 'failed' | 'discarded'

export interface Op {
  id: string
  /** Order on this device (actions upload in the order they were made). */
  seq: number
  kind: OpKind
  args: Record<string, unknown>
  /** When it happened (ISO, server-aligned). */
  at: string
  /** When it was saved (this device's clock, ms). */
  created: number
  /** The account that did it (it is uploaded with that account's session). */
  account: string
  accountName: string
  status: OpStatus
  attempts: number
  error?: { message: string; code?: string | null } | null
  result?: unknown
  /** When the server accepted it (this device's clock, ms). */
  synced?: number | null
  discarded?: number | null
  /** The id this action makes on the device (a session, tab line, sale, expense or counter). */
  creates?: string | null
  /** One line for the sync panel ("Started Snooker 2 · 60 min"). */
  summary: string
}

/** Fields that hold the id of something on the floor (made here or on the server). */
export const ID_FIELDS = ['session_id', 'item_id', 'expense_id'] as const

/** The id the server gave to what an action created. */
export function createdId(kind: OpKind, result: unknown): string | null {
  const r = (result ?? {}) as Record<string, unknown>
  const id = kind === 'checkout' || kind === 'checkout.split' ? r.sale_id : r.id
  return typeof id === 'string' ? id : null
}

/** Ids (made on this device) an action refers to. */
export function referencedIds(op: Op): string[] {
  return ID_FIELDS.map((f) => op.args[f]).filter((v): v is string => typeof v === 'string')
}

/** The action's arguments with ids made on this device replaced by the server's. */
export function resolveIds(args: Record<string, unknown>, ids: Record<string, string>): Record<string, unknown> {
  const out = { ...args }
  for (const f of ID_FIELDS) {
    const v = out[f]
    if (typeof v === 'string' && ids[v]) out[f] = ids[v]
  }
  return out
}

/** Floor actions only: an action whose display fields (names, prices) are kept for the screen, not sent. */
export function forServer(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) if (!k.startsWith('_')) out[k] = v
  return out
}
