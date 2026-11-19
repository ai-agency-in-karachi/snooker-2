/**
 * The sync engine: keeps this device's queue of actions (ops.ts) and uploads
 * it, in order, whenever the server can be reached.
 *
 * Nothing is lost: an action is written to the device's database before
 * anything else happens, and it leaves the queue only when the server has
 * accepted it (or a person sets it aside). Nothing is doubled: each action
 * keeps the id it was made with, and the server applies an id once however
 * often it arrives (sync_operation). Nothing is overwritten: the server checks
 * each action against what is there now and refuses one that no longer fits
 * (another device used the table first, say); the action is then kept as
 * "failed" with the reason, for a person to retry or set aside — never
 * dropped on its own.
 *
 * Storage, network and timers are passed in, so the same engine runs in the
 * app and in unit tests.
 */
import { createdId, forServer, referencedIds, resolveIds, type Op, type OpKind } from './ops'

export interface EngineStorage {
  load(): Promise<{ ops: Op[]; ids: Record<string, string> }>
  /** Saves an action (and, when the server named what it created, that id) in one transaction. */
  saveOp(op: Op, mapId?: [local: string, server: string]): Promise<void>
  deleteOps(ids: string[], unmap?: string[]): Promise<void>
}

export type TokenResult = { ok: true; token: string } | { ok: false; reason: 'network' | 'signed-out' }
export type UploadResult =
  | { ok: true; result: unknown }
  | { ok: false; reason: 'network' | 'auth' | 'rejected'; message: string; code?: string | null }

export interface EngineTransport {
  /** An access token for the account (refreshed when `fresh`). */
  token(account: string, opts: { fresh: boolean }): Promise<TokenResult>
  upload(op: Op, args: Record<string, unknown>, token: string): Promise<UploadResult>
  /** Can the server be reached? */
  probe(): Promise<boolean>
}

export interface SyncSnapshot {
  /** Every action on this device, in the order made (pending, failed, recently done, set aside). */
  ops: Op[]
  /** Ids made on this device → the server's ids. */
  ids: Record<string, string>
  online: boolean
  syncing: boolean
  /** Accounts whose actions wait for that account to sign in again on this device. */
  waiting: string[]
  lastSync: number | null
  loaded: boolean
  /**
   * Actions someone is waiting on right now, online (perform): screens show
   * them once the server has answered, as they always did, so nobody sees a
   * state the server has not accepted. Offline, an action shows at once.
   */
  awaiting: string[]
}

export interface EngineOptions {
  storage: EngineStorage
  transport: EngineTransport
  now?: () => number
  newId?: () => string
  /** Runs the upload pass only if no other tab is running one; resolves false if another is. */
  exclusive?: (fn: () => Promise<void>) => Promise<boolean>
  /** Tells other tabs the queue changed, and hears them. */
  broadcast?: { post(): void; listen(fn: () => void): () => void }
  onSynced?: (ops: Op[]) => void
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  /** How long a finished action is kept (so screens show it until they refresh). */
  keepDoneMs?: number
  keepDiscardedMs?: number
}

export class SyncRejected extends Error {
  constructor(
    message: string,
    readonly code: string | null | undefined
  ) {
    super(message)
  }
}

export interface NewOp {
  kind: OpKind
  args: Record<string, unknown>
  account: string
  accountName: string
  summary: string
  at: string
  creates?: string | null
}

const bySeq = (a: Op, b: Op) => a.seq - b.seq

export function createSyncEngine(o: EngineOptions) {
  const now = o.now ?? (() => Date.now())
  const newId = o.newId ?? (() => crypto.randomUUID())
  const schedule = o.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = o.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const keepDone = o.keepDoneMs ?? 24 * 3600_000
  const keepDiscarded = o.keepDiscardedMs ?? 30 * 24 * 3600_000

  let state: SyncSnapshot = { ops: [], ids: {}, online: true, syncing: false, waiting: [], lastSync: null, loaded: false, awaiting: [] }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<SyncSnapshot>) => {
    state = { ...state, ...patch }
    listeners.forEach((l) => l())
  }
  const putLocal = (op: Op) => set({ ops: [...state.ops.filter((x) => x.id !== op.id), op].sort(bySeq) })

  let running: Promise<void> | null = null
  let again = false
  let retry: unknown = null
  let failures = 0
  let lastSeq = 0
  let stopped = false

  async function reload() {
    const { ops, ids } = await o.storage.load()
    const sorted = [...ops].sort(bySeq)
    lastSeq = Math.max(lastSeq, sorted.at(-1)?.seq ?? 0)
    set({ ops: sorted, ids, loaded: true })
  }

  /** Why an action cannot go yet: it refers to something made on this device that is not on the server. */
  function blocker(op: Op): Op | null {
    for (const ref of referencedIds(op)) {
      if (state.ids[ref]) continue
      const maker = state.ops.find((x) => x.creates === ref)
      if (maker && maker.status !== 'done') return maker
    }
    return null
  }

  function scheduleRetry() {
    if (retry) return
    failures = Math.min(failures + 1, 6)
    const delay = Math.min(60_000, 2_000 * 2 ** (failures - 1))
    retry = schedule(() => {
      retry = null
      void (async () => {
        if (await o.transport.probe()) markOnline()
        else scheduleRetry()
      })()
    }, delay)
  }

  function markOnline() {
    failures = 0
    if (retry) {
      cancel(retry)
      retry = null
    }
    const was = state.online
    if (!was) set({ online: true })
    if (!was) void run()
  }

  function markOffline() {
    if (state.online) set({ online: false })
    scheduleRetry()
  }

  async function pass() {
    await reload()
    const pending = state.ops.filter((x) => x.status === 'pending')
    if (!pending.length) {
      if (state.waiting.length) set({ waiting: [] })
      await cleanup()
      return
    }
    set({ syncing: true })
    const waiting = new Set<string>()
    const synced: Op[] = []
    let offline = false
    try {
      for (const op of pending) {
        if (stopped) break
        if (waiting.has(op.account) || blocker(op)) continue
        const args = forServer(resolveIds(op.args, state.ids))
        let tok = await o.transport.token(op.account, { fresh: false })
        if (!tok.ok && tok.reason === 'network') {
          offline = true
          break
        }
        if (!tok.ok) {
          waiting.add(op.account)
          continue
        }
        let res = await o.transport.upload(op, args, tok.token)
        if (!res.ok && res.reason === 'auth') {
          tok = await o.transport.token(op.account, { fresh: true })
          if (!tok.ok && tok.reason === 'network') {
            offline = true
            break
          }
          if (!tok.ok) {
            waiting.add(op.account)
            continue
          }
          res = await o.transport.upload(op, args, tok.token)
          if (!res.ok && res.reason === 'auth') {
            waiting.add(op.account)
            continue
          }
        }
        if (!res.ok && res.reason === 'network') {
          offline = true
          break
        }
        if (!res.ok) {
          const failed: Op = { ...op, status: 'failed', attempts: op.attempts + 1, error: { message: res.message, code: res.code ?? null } }
          await o.storage.saveOp(failed)
          putLocal(failed)
          continue
        }
        const server = op.creates ? createdId(op.kind, res.result) : null
        const done: Op = { ...op, status: 'done', attempts: op.attempts + 1, error: null, result: res.result, synced: now() }
        await o.storage.saveOp(done, server && op.creates ? [op.creates, server] : undefined)
        if (server && op.creates) set({ ids: { ...state.ids, [op.creates]: server } })
        putLocal(done)
        synced.push(done)
      }
    } finally {
      set({ syncing: false, waiting: [...waiting], lastSync: synced.length ? now() : state.lastSync })
    }
    if (offline) markOffline()
    else markOnline()
    if (synced.length || pending.some((p) => state.ops.find((x) => x.id === p.id)?.status !== 'pending')) o.broadcast?.post()
    if (synced.length) o.onSynced?.(synced)
    await cleanup()
  }

  /** Forgets finished actions after a day (set-aside ones after 30), and ids no remaining action needs. */
  async function cleanup() {
    const t = now()
    const old = state.ops.filter(
      (x) => (x.status === 'done' && (x.synced ?? 0) < t - keepDone) || (x.status === 'discarded' && (x.discarded ?? 0) < t - keepDiscarded)
    )
    const gone = new Set(old.map((x) => x.id))
    const rest = state.ops.filter((x) => !gone.has(x.id))
    const needed = new Set([...rest.flatMap(referencedIds), ...rest.map((r) => r.creates).filter((c): c is string => Boolean(c))])
    const unmap = Object.keys(state.ids).filter((local) => !needed.has(local))
    if (!old.length && !unmap.length) return
    await o.storage.deleteOps([...gone], unmap)
    const ids = { ...state.ids }
    for (const u of unmap) delete ids[u]
    set({ ops: rest, ids })
  }

  /** Runs an upload pass (one at a time; a request during a pass runs another after it). */
  function run(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        try {
          if (o.exclusive) await o.exclusive(pass)
          else await pass()
        } catch {
          // A storage or programming error: try again later rather than stop syncing for good.
          scheduleRetry()
        }
      } while (again)
    })().finally(() => {
      running = null
    })
    return running
  }

  /** Saves an action on this device (before anything else), then starts uploading. */
  async function enqueue(input: NewOp, awaited = false): Promise<Op> {
    lastSeq = Math.max(lastSeq + 1e-3, now())
    const op: Op = {
      id: newId(),
      seq: lastSeq,
      kind: input.kind,
      args: input.args,
      at: input.at,
      created: now(),
      account: input.account,
      accountName: input.accountName,
      status: 'pending',
      attempts: 0,
      error: null,
      summary: input.summary,
      creates: input.creates ?? null
    }
    await o.storage.saveOp(op)
    if (awaited) set({ awaiting: [...state.awaiting, op.id] })
    putLocal(op)
    o.broadcast?.post()
    void run()
    return op
  }

  /** Resolves when the action is no longer pending, the device goes offline, its account must sign in, or `ms` pass. */
  function settle(id: string, ms: number): Promise<Op | null> {
    return new Promise((resolve) => {
      let timer: unknown = null
      const check = () => {
        const op = state.ops.find((x) => x.id === id)
        if (!op || op.status !== 'pending' || !state.online || state.waiting.includes(op.account)) {
          stop()
          resolve(op && op.status !== 'pending' ? op : null)
        }
      }
      const stop = () => {
        listeners.delete(check)
        if (timer) cancel(timer)
      }
      listeners.add(check)
      timer = schedule(() => {
        stop()
        resolve(null)
      }, ms)
      check()
    })
  }

  /**
   * Saves an action and, when online, waits briefly for the server's answer:
   * "done" with the server's result, or "queued" (offline or slow) — it then
   * uploads later. Refused while the person is still looking at it, it throws
   * the reason (as before offline mode) and is not kept.
   */
  async function perform(input: NewOp, waitMs = 8_000): Promise<{ op: Op; status: 'done' | 'queued'; result?: unknown }> {
    const op = await enqueue(input, state.online)
    if (!state.online) return { op, status: 'queued' }
    const settled = await settle(op.id, waitMs).finally(() => set({ awaiting: state.awaiting.filter((x) => x !== op.id) }))
    if (settled?.status === 'done') return { op: settled, status: 'done', result: settled.result }
    if (settled?.status === 'failed') {
      await remove([op.id])
      throw new SyncRejected(settled.error?.message ?? 'The server refused this action.', settled.error?.code)
    }
    return { op: state.ops.find((x) => x.id === op.id) ?? op, status: 'queued' }
  }

  async function remove(ids: string[]) {
    const gone = new Set(ids)
    const unmap = state.ops.filter((x) => gone.has(x.id) && x.creates).map((x) => x.creates!)
    await o.storage.deleteOps(ids, unmap)
    const map = { ...state.ids }
    for (const u of unmap) delete map[u]
    set({ ops: state.ops.filter((x) => !gone.has(x.id)), ids: map })
    o.broadcast?.post()
  }

  /** Sends refused actions again (after the cause was fixed, e.g. the table is free now). */
  async function retryOps(ids: string[]) {
    for (const id of ids) {
      const op = state.ops.find((x) => x.id === id)
      if (!op || op.status !== 'failed') continue
      const again: Op = { ...op, status: 'pending', error: null }
      await o.storage.saveOp(again)
      putLocal(again)
    }
    o.broadcast?.post()
    await run()
  }

  /** Sets actions aside (a person decided they should not be uploaded); kept 30 days for the record. */
  async function discard(ids: string[]) {
    for (const id of ids) {
      const op = state.ops.find((x) => x.id === id)
      if (!op || op.status === 'done') continue
      const aside: Op = { ...op, status: 'discarded', discarded: now() }
      await o.storage.saveOp(aside)
      putLocal(aside)
    }
    o.broadcast?.post()
  }

  /** The actions that must go (or be set aside) together with this one: everything made from what it creates. */
  function dependents(id: string): Op[] {
    const out: Op[] = []
    const made = new Set<string>()
    const first = state.ops.find((x) => x.id === id)
    if (first?.creates) made.add(first.creates)
    for (const op of state.ops) {
      if (op.id === id || op.status === 'done' || op.status === 'discarded') continue
      if (referencedIds(op).some((r) => made.has(r))) {
        out.push(op)
        if (op.creates) made.add(op.creates)
      }
    }
    return out
  }

  let stopListening: (() => void) | null = null
  return {
    async start() {
      await reload()
      stopListening = o.broadcast?.listen(() => void reload()) ?? null
      void run()
    },
    stop() {
      stopped = true
      stopListening?.()
      if (retry) cancel(retry)
      retry = null
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => state,
    enqueue,
    perform,
    run,
    retry: retryOps,
    discard,
    remove,
    dependents,
    blocker,
    markOnline,
    markOffline,
    /** A request elsewhere in the app could not reach the server. */
    reportNetworkError: markOffline,
    reload
  }
}

export type SyncEngine = ReturnType<typeof createSyncEngine>
